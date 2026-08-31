'use strict';

const { Transport } = require('./transport');
const {
  FRAME, OpError, validateOp, OP_TIMEOUT, DEFAULT_OP_TIMEOUT
} = require('../shared/protocol');

const MAX_PENDING = 32;
const MAX_STREAMS = 8;
const RATE_WINDOW_MS = 10000;
const RATE_MAX_OPS = 30;

// One connected agent, seen through the same interface as LocalTransport.
class AgentTransport extends Transport {
  constructor(server, ws, { caps, snapshotIntervalMs, agentVersion, hostname }) {
    super(server);
    this.ws = ws;
    this.agentCaps = caps || {};
    this.snapshotIntervalMs = snapshotIntervalMs || 5000;
    this.agentVersion = agentVersion || null;
    this.hostname = hostname || null;
    this.connectedAt = Date.now();

    this.seq = 0;
    this.pending = new Map();   // reqId -> { resolve, reject, timer }
    this.streams = new Map();   // reqId -> handlers
    this.rateHits = [];
    this.closed = false;
  }

  get status() {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return 'offline';
    if (!this._snapshot) return 'connecting';
    return this.isStale() ? 'stale' : 'online';
  }

  // Effective caps = agent's declared caps AND the hub's own policy.
  // Either side saying no wins.
  get caps() {
    const hubAllows = this.server.allowRemoteWrite !== false;
    return {
      allowActions: hubAllows && this.agentCaps.allowActions === true,
      allowFileRead: this.agentCaps.allowFileRead === true,
      allowFileWrite: hubAllows && this.agentCaps.allowFileWrite === true
    };
  }

  _checkRate() {
    const now = Date.now();
    this.rateHits = this.rateHits.filter(t => now - t < RATE_WINDOW_MS);
    if (this.rateHits.length >= RATE_MAX_OPS) {
      throw new OpError('BUSY', 'För många anrop mot denna server. Försök igen om en stund.');
    }
    this.rateHits.push(now);
  }

  _send(frame) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  call(op, args = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) {
        return reject(new OpError('OFFLINE', 'Servern är inte ansluten.'));
      }
      let cleanArgs;
      try {
        // Hub-side validation. The agent validates again before executing.
        cleanArgs = validateOp(op, args, this.caps);
        this._checkRate();
      } catch (err) {
        return reject(err);
      }
      if (this.pending.size >= MAX_PENDING) {
        return reject(new OpError('BUSY', 'Servern har för många pågående anrop.'));
      }

      const reqId = ++this.seq;
      const timeoutMs = opts.timeoutMs || OP_TIMEOUT[op] || DEFAULT_OP_TIMEOUT;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this._send({ t: FRAME.CANCEL, reqId });
        reject(new OpError('TIMEOUT', 'Servern svarade inte i tid.'));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      this.pending.set(reqId, { resolve, reject, timer });
      if (!this._send({ t: FRAME.REQ, reqId, op, args: cleanArgs })) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new OpError('OFFLINE', 'Servern är inte ansluten.'));
      }
    });
  }

  requestSnapshotNow() {
    this.call('snapshot', {}, { timeoutMs: 20000 })
      .then(data => this.setSnapshot(data))
      .catch(() => {});
  }

  openLogStream(args, handlers) {
    let cleanArgs;
    try {
      cleanArgs = validateOp('logs.follow', args, this.caps);
    } catch (err) {
      handlers.onError(err);
      return { close() {} };
    }
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      handlers.onError(new OpError('OFFLINE', 'Servern är inte ansluten.'));
      return { close() {} };
    }
    if (this.streams.size >= MAX_STREAMS) {
      handlers.onError(new OpError('BUSY', 'För många loggströmmar mot denna server.'));
      return { close() {} };
    }

    const reqId = ++this.seq;
    this.streams.set(reqId, handlers);
    this._send({ t: FRAME.REQ, reqId, op: 'logs.follow', args: cleanArgs });

    const self = this;
    return {
      close() {
        if (self.streams.delete(reqId)) {
          self._send({ t: FRAME.CANCEL, reqId });
        }
      }
    };
  }

  // ---------- inbound frames ----------

  handleFrame(msg) {
    switch (msg.t) {
      case FRAME.RES: {
        const entry = this.pending.get(msg.reqId);
        if (!entry) return;
        this.pending.delete(msg.reqId);
        clearTimeout(entry.timer);
        if (msg.ok) {
          entry.resolve(msg.data);
        } else {
          const e = msg.error || {};
          // Hubben kan operationen men agenten känner inte igen den: agenten
          // är äldre än hubben. Säg det rakt ut i stället för att skicka
          // vidare "Okänd operation", som inte går att göra något åt.
          if (e.code === 'UNKNOWN_OP') {
            return entry.reject(new OpError(
              'AGENT_OUTDATED',
              `Servern "${this.server.name}" kör en äldre agent` +
              `${this.agentVersion ? ` (${this.agentVersion})` : ''} som saknar den här funktionen. ` +
              'Kör om installationskommandot på servern för att uppdatera den.'
            ));
          }
          entry.reject(new OpError(e.code || 'ERR', e.message || 'Okänt fel från servern.'));
        }
        return;
      }
      case FRAME.SNAPSHOT: {
        if (msg.data) this.setSnapshot(msg.data);
        return;
      }
      case FRAME.STREAM: {
        const h = this.streams.get(msg.reqId);
        if (h) h.onChunk(msg.chunk);
        return;
      }
      case FRAME.STREAM_END: {
        const h = this.streams.get(msg.reqId);
        if (h) {
          this.streams.delete(msg.reqId);
          h.onEnd(msg.reason || 'Loggström avslutades.');
        }
        return;
      }
      default:
        // Unknown frame types are ignored, not fatal.
    }
  }

  // Called when the socket drops. Keeps the last snapshot (marked stale by
  // isStale()) so the UI can dim the tab instead of losing every container.
  handleDisconnect(reason) {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new OpError('OFFLINE', 'Servern kopplades ifrån.'));
    }
    this.pending.clear();
    for (const [, h] of this.streams) {
      try { h.onEnd(reason || 'Servern kopplades ifrån.'); } catch (e) {}
    }
    this.streams.clear();
  }

  dispose() {
    this.handleDisconnect('Anslutningen stängdes.');
    try { if (this.ws) this.ws.close(); } catch (e) {}
  }
}

module.exports = { AgentTransport };
