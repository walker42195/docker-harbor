'use strict';

const Docker = require('dockerode');
const { Transport } = require('./transport');
const { execOp, openLogStream } = require('../shared/dockerOps');

// The Docker socket this hub itself runs on, wrapped in the same interface as a
// remote agent so routes have exactly one code path.
class LocalTransport extends Transport {
  constructor(server, { socketPath, snapshotIntervalMs } = {}) {
    super(server);
    this.docker = new Docker({ socketPath: socketPath || '/var/run/docker.sock' });
    this.snapshotIntervalMs = snapshotIntervalMs || 5000;
    this.lastError = null;
    this._inFlight = false;
    this._timer = null;
  }

  get status() {
    if (!this._snapshot) return this.lastError ? 'offline' : 'connecting';
    return this.isStale() ? 'stale' : 'online';
  }

  get caps() {
    const allow = this.server.allowRemoteWrite !== false;
    return { allowActions: allow, allowFileRead: true, allowFileWrite: allow };
  }

  async call(op, args = {}) {
    return execOp(this.docker, op, args, this.caps);
  }

  openLogStream(args, handlers) {
    return openLogStream(this.docker, args, handlers);
  }

  startPolling() {
    if (this._timer) return;
    const tick = async () => {
      if (this._inFlight) return; // never let a slow tick stack
      this._inFlight = true;
      try {
        this.setSnapshot(await execOp(this.docker, 'snapshot', {}, this.caps));
        this.lastError = null;
      } catch (err) {
        this.lastError = err.message;
        console.error('[local] snapshot-fel:', err.message);
      } finally {
        this._inFlight = false;
      }
    };
    tick();
    this._timer = setInterval(tick, this.snapshotIntervalMs);
    if (this._timer.unref) this._timer.unref();
    this._tick = tick;
  }

  requestSnapshotNow() {
    if (this._tick) this._tick();
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { LocalTransport };
