'use strict';

const fs = require('fs');
const path = require('path');

const DESCRIPTIONS_FILE = path.join(__dirname, '..', 'descriptions.json');
const LOCAL_ID = 'local';

// Opt-in: let a container on a new server inherit the text of a local container
// with the same name. Off by default to avoid surprising mislabels.
const CROSS_SERVER_FALLBACK = process.env.DESCRIPTIONS_CROSS_SERVER_FALLBACK === 'true';

// v1 was a flat { "<container-name>": "<text>" } map covering the single local
// daemon. v2 namespaces by serverId. Migration is lazy: the file on disk is
// only rewritten in v2 form on the first save, so a rollback stays possible.
function load(file) {
  const target = file || DESCRIPTIONS_FILE;
  let raw = {};
  try {
    if (fs.existsSync(target)) {
      raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading descriptions.json:', err.message);
    return { version: 2, servers: { [LOCAL_ID]: {} } };
  }

  if (raw && raw.version === 2 && raw.servers) return raw;
  return { version: 2, servers: { [LOCAL_ID]: raw || {} } };
}

let migrationLogged = false;

function save(db, file) {
  const target = file || DESCRIPTIONS_FILE;
  if (!migrationLogged) {
    migrationLogged = true;
    try {
      const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
      if (existing && existing.version !== 2) {
        console.log('Migrerar descriptions.json till version 2.');
      }
    } catch (err) {}
  }
  try {
    fs.writeFileSync(target, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing descriptions.json:', err.message);
  }
}

function nsOf(db, serverId) {
  if (!db.servers[serverId]) db.servers[serverId] = {};
  return db.servers[serverId];
}

// Lookup order matches the original single-server behaviour: name, then the
// full id, then the 12-char short id.
function get(db, serverId, name, id) {
  const ns = db.servers[serverId] || {};
  const shortId = id ? String(id).substring(0, 12) : null;
  for (const key of [name, id, shortId]) {
    if (key && ns[key] !== undefined) return ns[key];
  }
  if (CROSS_SERVER_FALLBACK && serverId !== LOCAL_ID) {
    const local = db.servers[LOCAL_ID] || {};
    if (name && local[name] !== undefined) return local[name];
  }
  return undefined;
}

function set(db, serverId, name, id, description) {
  const ns = nsOf(db, serverId);
  const clean = (description || '').trim();
  if (clean) {
    ns[name] = clean;
  } else {
    delete ns[name];
    if (id) {
      delete ns[id];
      delete ns[String(id).substring(0, 12)];
    }
  }
  return clean || null;
}

// Overlay the hub's custom descriptions onto containers reported by a
// transport. Agents only ever send `labelDescription`.
function applyTo(db, serverId, containers) {
  return containers.map(c => {
    const name = (c.names && c.names[0]) || '';
    const custom = get(db, serverId, name, c.id);
    return {
      ...c,
      description: (custom !== undefined && custom !== null) ? custom : (c.labelDescription || null)
    };
  });
}

module.exports = { load, save, get, set, applyTo, DESCRIPTIONS_FILE };
