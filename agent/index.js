#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Docker = require('dockerode');

const { execOp, openLogStream } = require('../shared/dockerOps');
const { PROTOCOL_VERSION, FRAME } = require('../shared/protocol');

const VERSION = require('./package.json').version;

const CFG = {
  hubUrl: process.env.HARBOR_HUB_URL,
  serverId: process.env.HARBOR_SERVER_ID,
  token: process.env.HARBOR_TOKEN || null,
  enrollCode: process.env.HARBOR_ENROLL_CODE || null,
  tokenFile: process.env.HARBOR_TOKEN_FILE || '/data/agent-token',
  sockPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  snapshotMs: parseInt(process.env.HARBOR_SNAPSHOT_INTERVAL_MS, 10) || 5000,
  readOnly: process.env.HARBOR_READ_ONLY !== 'false',      // skrivskyddat som standard
  allowFileRead: process.env.HARBOR_ALLOW_FILE_READ !== 'false',
  allowFileWrite: process.env.HARBOR_ALLOW_FILE_WRITE === 'true',
  tlsInsecure: process.env.HARBOR_TLS_INSECURE === 'true'
};

// Capabilities this agent is willing to offer. The hub ANDs these with its own
// policy, so either side can say no and no always wins.
const caps = {
  allowActions: !CFG.readOnly,
  allowFileRead: CFG.allowFileRead,
  allowFileWrite: CFG.allowFileWrite && !CFG.readOnly
};

const docker = new Docker({ socketPath: CFG.sockPath });

let ws = null;
let snapTimer = null;
let hbTimer = null;
let lastPong = 0;
// Satts nar hubben nekat vart sparade token. Da maste vi falla tillbaka pa
// enrollment-koden -- annars sitter agenten fast for alltid med ett token som
// hubben inte langre kanner igen (t.ex. efter att servern registrerats om).
let forceEnroll = false;
let backoff = 1000;
let seq = 0;
const streams = new Map(); // reqId -> stream handle

// ---------- token persistence ----------

function loadStoredToken() {
  try {
    if (fs.existsSync(CFG.tokenFile)) {
      const t = fs.readFileSync(CFG.tokenFile, 'utf8').trim();
      if (t) return t;
    }
  } catch (err) {
    console.warn('[agent] kunde inte läsa sparad token:', err.message);
  }
  return null;
}

function storeToken(token) {
  try {
    fs.mkdirSync(path.dirname(CFG.tokenFile), { recursive: true });
    fs.writeFileSync(CFG.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
    console.log('[agent] permanent token sparad, enrollment-koden behövs inte längre.');
  } catch (err) {
    console.error('[agent] KUNDE INTE spara token:', err.message);
    console.error('[agent] agenten kommer behöva enrollas om vid nästa omstart.');
  }
}

// ---------- connection ----------

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
    return true;
  }
  return false;
}

function connect() {
  const token = forceEnroll ? null : (CFG.token || loadStoredToken());
  if (!token && !CFG.enrollCode) {
    console.error('[agent] varken token eller enrollment-kod tillgänglig. Avbryter.');
    process.exit(1);
  }

  ws = new WebSocket(CFG.hubUrl, [PROTOCOL_VERSION], {
    rejectUnauthorized: !CFG.tlsInsecure,
    handshakeTimeout: 10000,
    maxPayload: 8 * 1024 * 1024
  });

  ws.on('open', () => {
    // The token travels in the frame body, never in the URL, so it stays out of
    // access logs and proxy logs.
    send({
      t: FRAME.HELLO,
      serverId: CFG.serverId,
      token: token || null,
      enrollCode: token ? null : CFG.enrollCode,
      agentVersion: VERSION,
      hostname: os.hostname(),
      caps,
      snapshotIntervalMs: CFG.snapshotMs
    });
  });

  ws.on('pong', () => { lastPong = Date.now(); });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }

    if (msg.t === FRAME.WELCOME) {
      backoff = 1000;
      if (msg.token) storeToken(msg.token);
      forceEnroll = false;
      console.log(`[agent] ansluten till hubben (hub ${msg.hubVersion}), rapporterar var ${msg.snapshotIntervalMs || CFG.snapshotMs} ms`);
      startSnapshotLoop(msg.snapshotIntervalMs || CFG.snapshotMs);
      startHeartbeat();
      return;
    }

    if (msg.t === FRAME.CANCEL) {
      const s = streams.get(msg.reqId);
      if (s) {
        s.close();
        streams.delete(msg.reqId);
      }
      return;
    }

    if (msg.t !== FRAME.REQ) return;

    if (msg.op === 'logs.follow') return followLogs(msg);

    try {
      // execOp validates and gates again on this side. A compromised hub still
      // cannot make the agent run anything outside the allowlist.
      const data = await execOp(docker, msg.op, msg.args || {}, caps);
      send({ t: FRAME.RES, reqId: msg.reqId, ok: true, data });
    } catch (err) {
      send({
        t: FRAME.RES,
        reqId: msg.reqId,
        ok: false,
        error: { code: err.code || 'ERR', message: err.userMessage || err.message }
      });
    }
  });

  ws.on('close', (code, reason) => {
    teardown();
    const text = reason ? reason.toString() : '';
    if (code === 4403) {
      if (!forceEnroll && CFG.enrollCode && token) {
        // Sparad token underkand men vi har en enrollment-kod: kasta token och
        // enrolla om vid nasta forsok.
        console.warn('[agent] hubben nekade det sparade token. Provar enrollment-koden igen.');
        forceEnroll = true;
        try { fs.unlinkSync(CFG.tokenFile); } catch (err) {}
      } else {
        console.error(`[agent] hubben nekade åtkomst (${code} ${text}). Kontrollera server-ID och att servern finns i hubben.`);
      }
    }
    const wait = Math.min(backoff, 30000) + Math.floor(Math.random() * 1000);
    console.warn(`[agent] frånkopplad (${code}), återansluter om ${wait} ms`);
    setTimeout(connect, wait);
    backoff = Math.min(backoff * 2, 30000);
  });

  ws.on('error', (err) => {
    // 'close' always follows, so reconnection is handled there.
    console.error('[agent] ws-fel:', err.message);
  });
}

const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT_MS = 60000;

function startHeartbeat() {
  clearInterval(hbTimer);
  lastPong = Date.now();
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
      console.warn('[agent] hubben svarar inte, river anslutningen');
      try { ws.terminate(); } catch (err) {}
      return;
    }
    try { ws.ping(); } catch (err) {}
  }, HEARTBEAT_MS);
  if (hbTimer.unref) hbTimer.unref();
}

function teardown() {
  clearInterval(snapTimer);
  snapTimer = null;
  clearInterval(hbTimer);
  hbTimer = null;
  for (const s of streams.values()) {
    try { s.close(); } catch (err) {}
  }
  streams.clear();
}

// ---------- snapshots ----------

function startSnapshotLoop(intervalMs) {
  clearInterval(snapTimer);
  let inFlight = false;

  const tick = async () => {
    if (inFlight || !ws || ws.readyState !== WebSocket.OPEN) return;
    inFlight = true;
    try {
      const data = await execOp(docker, 'snapshot', {}, caps);
      send({ t: FRAME.SNAPSHOT, seq: ++seq, data });
    } catch (err) {
      console.error('[agent] snapshot-fel:', err.message);
    } finally {
      inFlight = false;
    }
  };

  tick();
  snapTimer = setInterval(tick, intervalMs);
}

// ---------- log streaming ----------

const MAX_STREAMS = 8;

function followLogs(msg) {
  if (streams.size >= MAX_STREAMS) {
    return send({ t: FRAME.STREAM_END, reqId: msg.reqId, reason: 'För många loggströmmar.' });
  }
  const handle = openLogStream(docker, msg.args || {}, {
    onChunk: (text) => send({ t: FRAME.STREAM, reqId: msg.reqId, chunk: text }),
    onEnd: (reason) => {
      streams.delete(msg.reqId);
      send({ t: FRAME.STREAM_END, reqId: msg.reqId, reason });
    },
    onError: (err) => {
      streams.delete(msg.reqId);
      send({ t: FRAME.STREAM_END, reqId: msg.reqId, reason: err.userMessage || err.message });
    }
  });
  streams.set(msg.reqId, handle);
}

// ---------- startup ----------

if (!CFG.hubUrl || !CFG.serverId) {
  console.error('HARBOR_HUB_URL och HARBOR_SERVER_ID krävs.');
  process.exit(1);
}
if (!CFG.token && !CFG.enrollCode && !loadStoredToken()) {
  console.error('HARBOR_TOKEN eller HARBOR_ENROLL_CODE krävs vid första start.');
  process.exit(1);
}
if (!/^wss:/i.test(CFG.hubUrl)) {
  console.warn('[agent] VARNING: hubben nås utan TLS (ws://). Använd wss:// i produktion.');
}
if (CFG.tlsInsecure) {
  console.warn('[agent] VARNING: HARBOR_TLS_INSECURE=true — certifikat verifieras INTE. Endast för labb.');
}

console.log(`[agent] Docker Harbor-agent ${VERSION} startar`);
console.log(`[agent] server-ID: ${CFG.serverId}, hub: ${CFG.hubUrl}`);
console.log(`[agent] läge: ${CFG.readOnly ? 'SKRIVSKYDDAT' : 'fulla rättigheter'}` +
            ` (filläsning: ${caps.allowFileRead ? 'på' : 'av'}, filskrivning: ${caps.allowFileWrite ? 'på' : 'av'})`);

process.on('SIGTERM', () => { teardown(); process.exit(0); });
process.on('SIGINT', () => { teardown(); process.exit(0); });

connect();
