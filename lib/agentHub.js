'use strict';

const { WebSocketServer } = require('ws');
const { LocalTransport } = require('./localTransport');
const { AgentTransport } = require('./agentTransport');
const { Registry, LOCAL_ID } = require('./registry');
const { PROTOCOL_VERSION, FRAME, CLOSE } = require('../shared/protocol');

const HELLO_GRACE_MS = 10000;
const PING_INTERVAL_MS = 20000;
const DEAD_TIMEOUT_MS = 45000;
const MAX_PAYLOAD = 8 * 1024 * 1024;

// Brute-force damping on the agent endpoint.
const FAIL_WINDOW_MS = 60000;
const FAIL_MAX = 5;
const BLOCK_MS = 10 * 60 * 1000;

class AgentHub {
  constructor({ registry, snapshotIntervalMs, hubVersion } = {}) {
    this.registry = registry || new Registry();
    this.snapshotIntervalMs = snapshotIntervalMs || 5000;
    this.hubVersion = hubVersion || '1.0.0';
    this.transports = new Map(); // serverId -> Transport
    this.failures = new Map();   // ip -> { hits: number[], blockedUntil: number }

    const localServer = this.registry.get(LOCAL_ID);
    const local = new LocalTransport(localServer, { snapshotIntervalMs: this.snapshotIntervalMs });
    local.startPolling();
    this.transports.set(LOCAL_ID, local);
  }

  getTransport(id) {
    return this.transports.get(id || LOCAL_ID) || null;
  }

  // Registry entries plus live status, for GET /api/servers.
  listServers() {
    return this.registry.list().map(entry => {
      const t = this.transports.get(entry.id);
      const snap = t ? t.getSnapshot() : null;
      return {
        ...this.registry.publicView(entry),
        status: t ? t.status : 'offline',
        caps: t ? t.caps : { allowActions: false, allowFileRead: false, allowFileWrite: false },
        info: snap ? snap.info : null,
        hostMetrics: snap ? snap.hostMetrics : null,
        snapshotAt: snap ? snap.receivedAt : 0,
        stale: snap ? snap.stale : true
      };
    });
  }

  removeServer(id) {
    const t = this.transports.get(id);
    if (t) {
      t.dispose();
      this.transports.delete(id);
    }
    return this.registry.remove(id);
  }

  // ---------- brute-force damping ----------

  isBlocked(ip) {
    const rec = this.failures.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
    if (rec.blockedUntil && Date.now() >= rec.blockedUntil) this.failures.delete(ip);
    return false;
  }

  noteFailure(ip) {
    const now = Date.now();
    const rec = this.failures.get(ip) || { hits: [], blockedUntil: 0 };
    rec.hits = rec.hits.filter(t => now - t < FAIL_WINDOW_MS);
    rec.hits.push(now);
    if (rec.hits.length >= FAIL_MAX) {
      rec.blockedUntil = now + BLOCK_MS;
      rec.hits = [];
      console.warn(`[agent-hub] blockerar ${ip} i 10 minuter efter ${FAIL_MAX} misslyckade försök`);
    }
    this.failures.set(ip, rec);
  }

  // ---------- websocket endpoint ----------

  attach(httpServer, upgradePath) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.wss = wss;
    this.upgradePath = upgradePath || '/ws/agent';

    wss.on('connection', (ws, req) => this._onConnection(ws, req));

    this._pingTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
      }
    }, PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();

    return wss;
  }

  handleUpgrade(req, socket, head) {
    const ip = remoteIp(req);
    if (this.isBlocked(ip)) {
      socket.destroy();
      return;
    }
    const protocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',').map(s => s.trim());
    if (!protocols.includes(PROTOCOL_VERSION)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      this.wss.emit('connection', ws, req);
    });
  }

  _onConnection(ws, req) {
    const ip = remoteIp(req);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let authed = false;
    let serverId = null;

    // Nothing but a hello frame is accepted until authentication succeeds.
    const graceTimer = setTimeout(() => {
      if (!authed) {
        try { ws.close(CLOSE.UNAUTHENTICATED, 'Ingen hello i tid.'); } catch (e) {}
      }
    }, HELLO_GRACE_MS);
    if (graceTimer.unref) graceTimer.unref();

    const deadTimer = setInterval(() => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) {}
      }
    }, DEAD_TIMEOUT_MS);
    if (deadTimer.unref) deadTimer.unref();

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }

      if (!authed) {
        if (msg.t !== FRAME.HELLO) {
          try { ws.close(CLOSE.UNAUTHENTICATED, 'Autentisering krävs.'); } catch (e) {}
          return;
        }
        const result = await this._authenticate(msg, ip);
        if (!result.ok) {
          this.noteFailure(ip);
          console.warn(`[agent-hub] avvisade agent från ${ip}: ${result.reason}`);
          // Constant delay so a wrong token is not distinguishable by timing.
          await sleep(1000);
          try { ws.close(CLOSE.FORBIDDEN, 'Åtkomst nekad.'); } catch (e) {}
          return;
        }

        authed = true;
        serverId = result.entry.id;
        clearTimeout(graceTimer);

        // A reconnecting agent must not be locked out by its own zombie socket.
        const existing = this.transports.get(serverId);
        if (existing && existing.ws && existing.ws !== ws) {
          try { existing.ws.close(CLOSE.DUPLICATE, 'Ersatt av ny anslutning.'); } catch (e) {}
          existing.handleDisconnect('Ersatt av ny anslutning.');
        }

        const transport = new AgentTransport(result.entry, ws, {
          caps: msg.caps,
          snapshotIntervalMs: msg.snapshotIntervalMs || this.snapshotIntervalMs,
          agentVersion: msg.agentVersion,
          hostname: msg.hostname
        });
        this.transports.set(serverId, transport);
        ws._transport = transport;

        this.registry.touch(serverId, {
          agentVersion: msg.agentVersion || null,
          hostname: msg.hostname || null
        });

        const welcome = {
          t: FRAME.WELCOME,
          hubVersion: this.hubVersion,
          snapshotIntervalMs: this.snapshotIntervalMs,
          serverTime: Date.now()
        };
        // Only sent on the very first connect, right after an enrollment code
        // was redeemed. The agent persists it and never needs it again.
        if (result.issuedToken) welcome.token = result.issuedToken;
        ws.send(JSON.stringify(welcome));

        console.log(`[agent-hub] agent ansluten: ${serverId} (${msg.hostname || 'okänd värd'}) från ${ip}`);
        return;
      }

      if (ws._transport) {
        if (msg.t === FRAME.SNAPSHOT) this.registry.touch(serverId);
        ws._transport.handleFrame(msg);
      }
    });

    ws.on('close', () => {
      clearTimeout(graceTimer);
      clearInterval(deadTimer);
      if (ws._transport) {
        ws._transport.handleDisconnect('Servern kopplades ifrån.');
        console.log(`[agent-hub] agent frånkopplad: ${serverId}`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[agent-hub] ws-fel (${serverId || ip}):`, err.message);
    });
  }

  async _authenticate(msg, ip) {
    const id = typeof msg.serverId === 'string' ? msg.serverId : null;
    if (!id) return { ok: false, reason: 'saknar serverId' };

    const entry = this.registry.get(id);
    if (!entry) {
      this.registry.verifyToken(id, msg.token); // burn equivalent CPU
      return { ok: false, reason: `okänd server "${id}"` };
    }
    if (entry.type !== 'agent') return { ok: false, reason: 'servern är inte av agent-typ' };
    if (!entry.enabled) return { ok: false, reason: 'servern är avstängd' };

    // First connect: redeem the single-use enrollment code for a real token.
    if (msg.enrollCode) {
      const token = this.registry.redeemEnrollCode(id, msg.enrollCode);
      if (!token) return { ok: false, reason: 'ogiltig eller förbrukad enrollment-kod' };
      console.log(`[agent-hub] server "${id}" enrollad från ${ip}`);
      return { ok: true, entry, issuedToken: token };
    }

    if (!this.registry.verifyToken(id, msg.token)) {
      return { ok: false, reason: 'felaktig token' };
    }
    return { ok: true, entry };
  }

  dispose() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    for (const t of this.transports.values()) t.dispose();
    this.transports.clear();
  }
}

function remoteIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || 'okänd';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { AgentHub };
