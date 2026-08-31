'use strict';

const express = require('express');
const descriptions = require('../descriptions');
const { sendError } = require('./middleware');

// One router, mounted twice: at /api/servers/:serverId/containers and at the
// legacy /api/containers (where resolveServer defaults to 'local').
function createContainersRouter({ mw }) {
  const router = express.Router({ mergeParams: true });
  const { requireAuth, resolveServer, requireOnline, requireUnlocked } = mw;

  const read = [requireAuth, resolveServer, requireOnline];
  const write = [requireAuth, resolveServer, requireOnline, requireUnlocked];

  // A mutating action collapses to a single line each.
  const action = (op, argsFrom, okMessage, errPrefix) => async (req, res) => {
    try {
      const data = await req.transport.call(op, argsFrom(req));
      req.transport.requestSnapshotNow();
      res.json({ success: true, message: okMessage(data, req), ...data });
    } catch (err) {
      sendError(res, err, errPrefix);
    }
  };

  router.get('/', requireAuth, resolveServer, async (req, res) => {
    // Served straight from the snapshot cache -- no Docker round-trip.
    const snap = req.transport ? req.transport.getSnapshot() : null;
    if (!snap) {
      return res.status(503).json({
        success: false,
        error: `Väntar på data från "${req.serverEntry.name}".`
      });
    }
    const db = descriptions.load();
    const entry = req.serverEntry;
    const containers = descriptions.applyTo(db, req.serverId, snap.containers).map(c => ({
      ...c,
      serverId: entry.id,
      serverName: entry.name,
      serverColor: entry.color,
      serverPublicHost: entry.publicHost
    }));
    res.json({
      success: true,
      containers,
      hostMetrics: snap.hostMetrics,
      stale: snap.stale,
      snapshotAt: snap.receivedAt
    });
  });

  router.get('/:id/file', ...read, async (req, res) => {
    try {
      const data = await req.transport.call('containers.readFile', {
        id: req.params.id,
        fileType: req.query.type
      });
      res.json({ success: true, ...data });
    } catch (err) {
      sendError(res, err, 'Kunde inte läsa filen: ');
    }
  });

  router.get('/:id/logs', ...read, async (req, res) => {
    try {
      const data = await req.transport.call('containers.logsTail', {
        id: req.params.id,
        tail: req.query.tail
      });
      res.json({ success: true, logs: data.logs });
    } catch (err) {
      sendError(res, err, 'Kunde inte hämta loggar: ');
    }
  });

  router.get('/:id', ...read, async (req, res) => {
    try {
      const data = await req.transport.call('containers.inspect', { id: req.params.id });
      res.json({ success: true, data });
    } catch (err) {
      sendError(res, err, 'Kunde inte inspektera container: ');
    }
  });

  router.post('/:id/description', ...read, async (req, res) => {
    const containerId = req.params.id;
    const cleanDesc = (req.body.description || '').trim();
    try {
      const inspectData = await req.transport.call('containers.inspect', { id: containerId });
      const containerName = inspectData && inspectData.Name
        ? inspectData.Name.replace(/^\//, '')
        : containerId;

      const db = descriptions.load();
      const saved = descriptions.set(db, req.serverId, containerName, containerId, cleanDesc);
      descriptions.save(db);

      // Also write the label back into the real docker-compose.yml, which for
      // an agent server lives on that remote host.
      let composeUpdated = false;
      let fileWriteBlocked = false;
      try {
        const result = await req.transport.call('containers.writeComposeDescription', {
          id: containerId,
          description: cleanDesc
        });
        composeUpdated = result.composeUpdated;
      } catch (err) {
        if (err.code === 'FORBIDDEN') fileWriteBlocked = true;
        else console.warn('Compose-uppdatering misslyckades:', err.message);
      }

      let message;
      if (composeUpdated) {
        message = 'Infotexten sparades i både docker-compose.yml och systemet.';
      } else if (fileWriteBlocked) {
        message = 'Infotexten sparades i systemet (compose-filen kunde inte uppdateras på fjärrservern).';
      } else {
        message = 'Infotexten sparades i systemet.';
      }

      req.transport.requestSnapshotNow();
      res.json({ success: true, message, description: saved, composeUpdated });
    } catch (err) {
      sendError(res, err, 'Kunde inte spara infotext: ');
    }
  });

  router.post('/:id/restart-policy', ...write, action(
    'containers.restartPolicy',
    req => ({ id: req.params.id, policy: req.body.restartPolicy }),
    (_d, req) => `Restart policy ändrades till '${req.body.restartPolicy}'.`,
    'Kunde inte uppdatera restart policy: '
  ));

  router.post('/:id/start', ...write, action(
    'containers.start', req => ({ id: req.params.id }),
    () => 'Container startades.', 'Kunde inte starta container: '
  ));

  router.post('/:id/stop', ...write, action(
    'containers.stop', req => ({ id: req.params.id, t: 10 }),
    () => 'Container stoppades.', 'Kunde inte stoppa container: '
  ));

  router.post('/:id/restart', ...write, action(
    'containers.restart', req => ({ id: req.params.id, t: 10 }),
    () => 'Container omstartades.', 'Kunde inte starta om container: '
  ));

  router.post('/:id/rebuild', ...write, action(
    'containers.rebuild', req => ({ id: req.params.id }),
    (d) => `Container ${d.name} har byggts om och startats på nytt.`,
    'Kunde inte bygga om container: '
  ));

  router.delete('/:id', ...write, action(
    'containers.remove',
    req => ({ id: req.params.id, force: req.query.force === 'true', v: req.query.v === 'true' }),
    () => 'Container har tagits bort.', 'Kunde inte ta bort container: '
  ));

  return router;
}

module.exports = { createContainersRouter };
