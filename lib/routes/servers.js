'use strict';

const express = require('express');
const descriptions = require('../descriptions');
const { sendError } = require('./middleware');
const { buildInstallScript, deriveHubWsUrl } = require('../installScript');

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ENROLL_TTL_MS = 30 * 60 * 1000;

function createServersRouter({ mw, hub, unlock, agentImage, hubWsUrlOverride }) {
  const router = express.Router({ mergeParams: true });
  const { requireAuth, resolveServer, requireOnline, requireUnlocked } = mw;

  // Registry + live status + each server's cached info and host metrics.
  router.get('/', requireAuth, (req, res) => {
    const servers = hub.listServers().map(s => ({
      ...s,
      unlocked: s.requireUnlock ? unlock.isUnlocked(req.sessionKey, s.id) : true,
      unlockExpires: unlock.expiresAt(req.sessionKey, s.id)
    }));
    res.json({ success: true, servers });
  });

  // Register a server and hand back the one-liner to run on it.
  router.post('/', requireAuth, (req, res) => {
    const { id, name, color, publicHost } = req.body || {};
    if (!id || !ID_RE.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Ogiltigt server-ID. Använd 2-32 tecken: a-z, 0-9, bindestreck eller understreck.'
      });
    }
    try {
      const entry = hub.registry.add({ id, name, color, publicHost });
      const { code, expires } = hub.registry.issueEnrollCode(id, ENROLL_TTL_MS);
      const base = installBaseUrl(req);
      res.json({
        success: true,
        message: `Servern "${entry.name}" lades till.`,
        server: hub.registry.publicView(entry),
        install: {
          command: `curl -fsSL ${base}/install/${code} | sh`,
          expires
        }
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Issue a fresh enrollment code for an existing server (re-install or rotate).
  router.post('/:serverId/enroll', requireAuth, resolveServer, (req, res) => {
    if (req.serverEntry.type !== 'agent') {
      return res.status(400).json({ success: false, error: 'Den lokala servern kan inte enrollas.' });
    }
    const { code, expires } = hub.registry.issueEnrollCode(req.serverId, ENROLL_TTL_MS);
    const base = installBaseUrl(req);
    res.json({
      success: true,
      message: 'Ny installationskod skapad. Den gäller i 30 minuter och kan bara användas en gång.',
      install: { command: `curl -fsSL ${base}/install/${code} | sh`, expires }
    });
  });

  router.patch('/:serverId', requireAuth, resolveServer, (req, res) => {
    const patch = {};
    for (const key of ['name', 'color', 'publicHost', 'enabled', 'allowRemoteWrite', 'requireUnlock']) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (req.serverEntry.type === 'local') {
      delete patch.enabled;
      delete patch.allowRemoteWrite;
    }
    hub.registry.update(req.serverId, patch);
    res.json({ success: true, message: 'Servern uppdaterades.', server: hub.registry.publicView(hub.registry.get(req.serverId)) });
  });

  router.delete('/:serverId', requireAuth, resolveServer, (req, res) => {
    if (req.serverEntry.type === 'local') {
      return res.status(400).json({ success: false, error: 'Den lokala servern kan inte tas bort.' });
    }
    hub.removeServer(req.serverId);
    // Drop that server's namespace from descriptions.json too.
    const db = descriptions.load();
    if (db.servers[req.serverId]) {
      delete db.servers[req.serverId];
      descriptions.save(db);
    }
    res.json({ success: true, message: 'Servern togs bort.' });
  });

  // ---------- write unlock ----------

  router.post('/:serverId/unlock', requireAuth, resolveServer, (req, res) => {
    const ip = req.ip || 'okänd';
    if (unlock.rateLimited(ip)) {
      return res.status(429).json({
        success: false,
        error: 'För många misslyckade försök. Vänta en stund och försök igen.'
      });
    }
    if (!unlock.verifyPassword(req.body && req.body.password)) {
      unlock.noteAttempt(ip);
      return res.status(401).json({ success: false, error: 'Felaktigt lösenord.' });
    }
    const expires = unlock.unlock(req.sessionKey, req.serverId);
    res.json({ success: true, message: 'Skrivning upplåst i 15 minuter.', unlockExpires: expires });
  });

  router.post('/:serverId/lock', requireAuth, resolveServer, (req, res) => {
    unlock.lock(req.sessionKey, req.serverId);
    res.json({ success: true, message: 'Servern är låst igen.' });
  });

  // ---------- per-server system ops ----------

  router.get('/:serverId/system/info', requireAuth, resolveServer, (req, res) => {
    const snap = req.transport ? req.transport.getSnapshot() : null;
    if (!snap) {
      return res.status(503).json({ success: false, error: `Väntar på data från "${req.serverEntry.name}".` });
    }
    res.json({ success: true, data: snap.info });
  });

  router.post('/:serverId/system/prune', requireAuth, resolveServer, requireOnline, requireUnlocked, async (req, res) => {
    try {
      const data = await req.transport.call('system.prune', {});
      req.transport.requestSnapshotNow();
      res.json({
        success: true,
        message: `Systemet på "${req.serverEntry.name}" har rensats från oanvända resurser.`,
        ...data
      });
    } catch (err) {
      sendError(res, err, 'Prune misslyckades: ');
    }
  });

  return router;
}

// The hub's own https:// base URL, as seen from outside the reverse proxy.
function installBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
                (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// GET /install/:code -- unauthenticated by necessity (the remote host is not
// logged in), but the code is high-entropy, expiring and single-use.
function createInstallRoute({ hub, agentImage, hubWsUrlOverride }) {
  return (req, res) => {
    const code = req.params.code;
    const now = Date.now();
    const entry = hub.registry.list().find(s =>
      s.type === 'agent' && s.enrollHash && s.enrollExpires > now &&
      require('../registry').compareScrypt(code, s.enrollSalt, s.enrollHash)
    );

    if (!entry) {
      res.status(404).type('text/plain').send(
        '# Ogiltig eller utgangen installationskod.\n' +
        'echo "Ogiltig eller utgangen installationskod. Skapa en ny i Docker Harbor." >&2; exit 1\n'
      );
      return;
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    console.log(`[install] installationsskript hämtat för "${entry.id}" från ${ip}`);

    // The code is NOT burned here -- the script may legitimately be fetched
    // more than once. It is burned when the agent redeems it on first connect.
    const script = buildInstallScript({
      hubWsUrl: deriveHubWsUrl(req, hubWsUrlOverride),
      serverId: entry.id,
      enrollCode: code,
      agentImage,
      expires: entry.enrollExpires
    });
    res.type('text/plain').send(script);
  };
}

module.exports = { createServersRouter, createInstallRoute };
