'use strict';

const crypto = require('crypto');

const UNLOCK_TTL_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_MAX = 5;
const SCRYPT_KEYLEN = 32;

// Second layer of write protection, independent of the agent's own read-only
// mode. This one guards against a hijacked browser session; the agent-side
// HARBOR_READ_ONLY guards against a hijacked hub. Both must say yes.
class UnlockManager {
  constructor(password) {
    this.salt = crypto.randomBytes(16);
    let secret = password;
    if (!secret) {
      secret = crypto.randomBytes(18).toString('base64url');
      console.log('====================================================');
      console.log(' WRITE_UNLOCK_PASSWORD saknas i miljön.');
      console.log(` Genererat lösenord för denna körning: ${secret}`);
      console.log(' Sätt WRITE_UNLOCK_PASSWORD i .env för ett bestående lösenord.');
      console.log('====================================================');
    }
    this.hash = crypto.scryptSync(secret, this.salt, SCRYPT_KEYLEN);
    this.sessions = new Map();  // sessionKey -> Map<serverId, expiresAt>
    this.attempts = new Map();  // ip -> number[]
  }

  verifyPassword(presented) {
    try {
      const got = crypto.scryptSync(String(presented || ''), this.salt, SCRYPT_KEYLEN);
      return crypto.timingSafeEqual(this.hash, got);
    } catch (err) {
      return false;
    }
  }

  rateLimited(ip) {
    const now = Date.now();
    const hits = (this.attempts.get(ip) || []).filter(t => now - t < ATTEMPT_WINDOW_MS);
    this.attempts.set(ip, hits);
    return hits.length >= ATTEMPT_MAX;
  }

  noteAttempt(ip) {
    const hits = this.attempts.get(ip) || [];
    hits.push(Date.now());
    this.attempts.set(ip, hits);
  }

  unlock(sessionKey, serverId) {
    let byServer = this.sessions.get(sessionKey);
    if (!byServer) {
      byServer = new Map();
      this.sessions.set(sessionKey, byServer);
    }
    const expires = Date.now() + UNLOCK_TTL_MS;
    byServer.set(serverId, expires);
    this.attempts.delete(sessionKey);
    return expires;
  }

  lock(sessionKey, serverId) {
    const byServer = this.sessions.get(sessionKey);
    if (byServer) byServer.delete(serverId);
  }

  isUnlocked(sessionKey, serverId) {
    const byServer = this.sessions.get(sessionKey);
    if (!byServer) return false;
    const expires = byServer.get(serverId);
    if (!expires) return false;
    if (Date.now() > expires) {
      byServer.delete(serverId);
      return false;
    }
    return true;
  }

  expiresAt(sessionKey, serverId) {
    const byServer = this.sessions.get(sessionKey);
    if (!byServer) return 0;
    const expires = byServer.get(serverId) || 0;
    return Date.now() > expires ? 0 : expires;
  }
}

module.exports = { UnlockManager, UNLOCK_TTL_MS };
