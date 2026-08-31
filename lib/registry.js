'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { dataFile } = require('./paths');

// Ligger i datakatalogen så den överlever ombyggnad av imagen.
const SERVERS_FILE = dataFile('servers.json');

const LOCAL_ID = 'local';
const DEFAULT_COLOR = '#38bdf8';
const SCRYPT_KEYLEN = 32;

// A synthesised entry for the Docker socket this hub itself runs on.
// Its `type` can never be changed through config.
function localEntry(existing) {
  return {
    id: LOCAL_ID,
    name: (existing && existing.name) || 'Lokal server',
    type: 'local',
    color: (existing && existing.color) || DEFAULT_COLOR,
    enabled: true,
    allowRemoteWrite: true,
    requireUnlock: existing ? existing.requireUnlock === true : false,
    publicHost: (existing && existing.publicHost) || null
  };
}

class Registry {
  constructor(file) {
    this.file = file || SERVERS_FILE;
    this.servers = new Map();
    this.load();
  }

  load() {
    let raw = { version: 1, servers: [] };
    try {
      if (fs.existsSync(this.file)) {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      console.error('Kunde inte läsa servers.json:', err.message);
    }

    const list = Array.isArray(raw.servers) ? raw.servers : [];
    this.servers.clear();
    for (const s of list) {
      if (!s || typeof s.id !== 'string') continue;
      if (s.id === LOCAL_ID) continue; // handled below, always synthesised
      this.servers.set(s.id, {
        id: s.id,
        name: s.name || s.id,
        type: 'agent',
        color: s.color || DEFAULT_COLOR,
        enabled: s.enabled !== false,
        allowRemoteWrite: s.allowRemoteWrite !== false,
        requireUnlock: s.requireUnlock !== false, // default locked for agents
        publicHost: s.publicHost || null,
        tokenSalt: s.tokenSalt || null,
        tokenHash: s.tokenHash || null,
        enrollHash: s.enrollHash || null,
        enrollSalt: s.enrollSalt || null,
        enrollExpires: s.enrollExpires || 0,
        lastSeen: s.lastSeen || 0,
        agentVersion: s.agentVersion || null,
        hostname: s.hostname || null
      });
    }

    const existingLocal = list.find(s => s && s.id === LOCAL_ID);
    this.servers.set(LOCAL_ID, localEntry(existingLocal));
  }

  save() {
    const payload = {
      version: 1,
      servers: Array.from(this.servers.values())
    };
    try {
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('Kunde inte skriva servers.json:', err.message);
    }
  }

  list() {
    return Array.from(this.servers.values());
  }

  get(id) {
    return this.servers.get(id) || null;
  }

  has(id) {
    return this.servers.has(id);
  }

  add({ id, name, color, publicHost, requireUnlock }) {
    if (this.servers.has(id)) {
      throw new Error(`Servern "${id}" finns redan.`);
    }
    const entry = {
      id,
      name: name || id,
      type: 'agent',
      color: color || DEFAULT_COLOR,
      enabled: true,
      allowRemoteWrite: true,
      requireUnlock: requireUnlock !== false,
      publicHost: publicHost || null,
      tokenSalt: null,
      tokenHash: null,
      enrollHash: null,
      enrollSalt: null,
      enrollExpires: 0,
      lastSeen: 0,
      agentVersion: null,
      hostname: null
    };
    this.servers.set(id, entry);
    this.save();
    return entry;
  }

  remove(id) {
    if (id === LOCAL_ID) throw new Error('Den lokala servern kan inte tas bort.');
    const existed = this.servers.delete(id);
    if (existed) this.save();
    return existed;
  }

  update(id, patch) {
    const entry = this.servers.get(id);
    if (!entry) return null;
    Object.assign(entry, patch);
    this.save();
    return entry;
  }

  // ---------- credentials ----------

  // Issue a short-lived, single-use enrollment code. Only its hash is stored.
  issueEnrollCode(id, ttlMs) {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Okänd server: ${id}`);
    const code = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16);
    entry.enrollSalt = salt.toString('hex');
    entry.enrollHash = crypto.scryptSync(code, salt, SCRYPT_KEYLEN).toString('hex');
    entry.enrollExpires = Date.now() + (ttlMs || 30 * 60 * 1000);
    this.save();
    return { code, expires: entry.enrollExpires };
  }

  // Consume an enrollment code and mint the permanent token in one step.
  // Returns the plaintext token exactly once, or null if the code is invalid.
  redeemEnrollCode(id, code) {
    const entry = this.servers.get(id);
    if (!entry || !entry.enrollHash || !entry.enrollSalt) {
      dummyScrypt();
      return null;
    }
    if (!entry.enrollExpires || Date.now() > entry.enrollExpires) {
      dummyScrypt();
      return null;
    }
    if (!compareScrypt(code, entry.enrollSalt, entry.enrollHash)) return null;

    // Burn the code, then mint the permanent token.
    entry.enrollHash = null;
    entry.enrollSalt = null;
    entry.enrollExpires = 0;
    return this.rotateToken(id);
  }

  rotateToken(id) {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Okänd server: ${id}`);
    const token = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16);
    entry.tokenSalt = salt.toString('hex');
    entry.tokenHash = crypto.scryptSync(token, salt, SCRYPT_KEYLEN).toString('hex');
    this.save();
    return token;
  }

  verifyToken(id, presented) {
    const entry = this.servers.get(id);
    if (!entry || !entry.tokenHash || !entry.tokenSalt) {
      dummyScrypt(); // keep timing flat for unknown servers
      return false;
    }
    return compareScrypt(presented, entry.tokenSalt, entry.tokenHash);
  }

  touch(id, patch) {
    const entry = this.servers.get(id);
    if (!entry) return;
    entry.lastSeen = Date.now();
    if (patch) Object.assign(entry, patch);
    this.save();
  }

  // Fields safe to hand to the browser -- never the hashes or salts.
  publicView(entry) {
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      color: entry.color,
      enabled: entry.enabled,
      allowRemoteWrite: entry.allowRemoteWrite,
      requireUnlock: entry.requireUnlock,
      publicHost: entry.publicHost,
      lastSeen: entry.lastSeen || 0,
      agentVersion: entry.agentVersion || null,
      hostname: entry.hostname || null,
      enrolled: !!entry.tokenHash,
      enrollPending: !!entry.enrollHash && entry.enrollExpires > Date.now()
    };
  }
}

function compareScrypt(presented, saltHex, hashHex) {
  try {
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(String(presented || ''), Buffer.from(saltHex, 'hex'), want.length);
    return crypto.timingSafeEqual(want, got);
  } catch (err) {
    return false;
  }
}

// Burn a comparable amount of CPU so a missing/unknown server is not
// distinguishable from a wrong token by response timing.
function dummyScrypt() {
  try {
    crypto.scryptSync('dummy', Buffer.alloc(16), SCRYPT_KEYLEN);
  } catch (err) {}
}

module.exports = { Registry, LOCAL_ID, SERVERS_FILE, compareScrypt };
