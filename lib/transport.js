'use strict';

const { OpError } = require('../shared/protocol');

// Common interface implemented by LocalTransport and AgentTransport.
// Routes only ever talk to this -- they never branch on local vs remote.
class Transport {
  constructor(server) {
    this.server = server;
    this._snapshot = null;
    this._receivedAt = 0;
    this.snapshotIntervalMs = 5000;
  }

  get id() { return this.server.id; }

  get status() { return 'offline'; }

  get caps() {
    return { allowActions: false, allowFileRead: false, allowFileWrite: false };
  }

  // Request/response. Rejects with OpError.
  async call(op, args = {}, opts = {}) { // eslint-disable-line no-unused-vars
    throw new OpError('OFFLINE', 'Transporten stödjer inga anrop.');
  }

  // Latest cached snapshot, or null before the first one arrives.
  getSnapshot() {
    if (!this._snapshot) return null;
    return {
      ...this._snapshot,
      stale: this.isStale(),
      receivedAt: this._receivedAt
    };
  }

  setSnapshot(snapshot) {
    this._snapshot = snapshot;
    this._receivedAt = Date.now();
  }

  isStale() {
    if (!this._receivedAt) return true;
    return Date.now() - this._receivedAt > 3 * this.snapshotIntervalMs;
  }

  // Ask for a fresh snapshot right away (after a mutating op).
  requestSnapshotNow() {}

  // Streaming logs. Returns a handle with .close().
  openLogStream(args, handlers) { // eslint-disable-line no-unused-vars
    handlers.onError(new OpError('OFFLINE', 'Servern är inte ansluten.'));
    return { close() {} };
  }

  dispose() {}
}

module.exports = { Transport };
