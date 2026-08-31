'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSpec } = require('../../shared/protocol');

function createMiddleware({ hub, unlock, jwtSecret }) {
  const requireAuth = (req, res, next) => {
    const token = req.cookies.docker_harbor_token ||
      (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Ej behörig. Vänligen logga in.' });
    }
    try {
      req.user = jwt.verify(token, jwtSecret);
      // Unlock grants are tied to the specific session token, not the username.
      req.sessionKey = crypto.createHash('sha256').update(token).digest('hex');
      next();
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Ogiltig eller utgången session.' });
    }
  };

  // Resolves :serverId (defaulting to 'local' on the legacy unscoped routes)
  // into req.transport. Every route body then works the same way whether the
  // Docker daemon is local or on the far end of an agent connection.
  const resolveServer = (req, res, next) => {
    const id = req.params.serverId || 'local';
    const entry = hub.registry.get(id);
    if (!entry) {
      return res.status(404).json({ success: false, error: `Okänd server: ${id}` });
    }
    req.serverId = id;
    req.serverEntry = entry;
    // A registered server that has never connected has no transport yet.
    // Routes that need one go through requireOnline.
    req.transport = hub.getTransport(id);
    next();
  };

  // Requires the server to actually be reachable. Read routes that can be
  // served from the snapshot cache do not use this.
  const requireOnline = (req, res, next) => {
    if (!req.transport || req.transport.status === 'offline') {
      return res.status(503).json({
        success: false,
        error: `Servern "${req.serverEntry.name}" är inte ansluten.`
      });
    }
    next();
  };

  // Hub-side write protection. Independent of the agent's own read-only mode.
  const requireUnlocked = (req, res, next) => {
    const entry = req.serverEntry;
    if (!entry || entry.requireUnlock !== true) return next();
    if (unlock.isUnlocked(req.sessionKey, req.serverId)) return next();
    return res.status(423).json({
      success: false,
      error: 'Servern är låst. Lås upp för att göra ändringar.',
      locked: true
    });
  };

  return { requireAuth, resolveServer, requireOnline, requireUnlocked };
}

// Turn an OpError (or any error) into an HTTP response, keeping the Swedish
// user-facing message the original routes produced.
function sendError(res, err, prefix) {
  const status = err.httpStatus || 500;
  const message = err.userMessage || err.message;
  res.status(status).json({
    success: false,
    error: prefix && status >= 500 ? `${prefix}${message}` : message
  });
}

function mutates(op) {
  try {
    return getSpec(op).mutates === true;
  } catch (err) {
    return false;
  }
}

module.exports = { createMiddleware, sendError, mutates };
