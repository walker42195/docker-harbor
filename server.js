const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const { Registry } = require('./lib/registry');
const { AgentHub } = require('./lib/agentHub');
const { UnlockManager } = require('./lib/unlock');
const descriptions = require('./lib/descriptions');
const { createMiddleware } = require('./lib/routes/middleware');
const { createContainersRouter } = require('./lib/routes/containers');
const { createServersRouter, createInstallRoute, createInstallImageRoute } = require('./lib/routes/servers');
const { createLogsHandler } = require('./lib/logsWs');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 6969;
const JWT_SECRET = process.env.JWT_SECRET || 'docker-harbor-super-secret-key-2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Default password is 'admin123' if not specified in .env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS, 10) || 5000;
const AGENT_IMAGE = process.env.HARBOR_AGENT_IMAGE || 'docker-harbor-agent:latest';
const HUB_WS_URL = process.env.HARBOR_HUB_WS_URL || null;

// Server registry, agent hub (owns the local Docker socket transport too) and
// the hub-side write-unlock manager.
const registry = new Registry();
const hub = new AgentHub({ registry, snapshotIntervalMs: SNAPSHOT_INTERVAL_MS });
const unlock = new UnlockManager(process.env.WRITE_UNLOCK_PASSWORD);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

const mw = createMiddleware({ hub, unlock, jwtSecret: JWT_SECRET });
const { requireAuth } = mw;

// ======================= AUTH ROUTES =======================

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Användarnamn och lösenord krävs.' });
  }

  // Simple username & password check (extendable to bcrypt/store)
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('docker_harbor_token', token, {
      httpOnly: true,
      secure: false, // Cloudflare handles SSL offloading
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return res.json({ success: true, message: 'Inloggning lyckades', token, user: { username } });
  }

  return res.status(401).json({ success: false, error: 'Felaktigt användarnamn eller lösenord.' });
});

// Check auth status
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('docker_harbor_token');
  res.json({ success: true, message: 'Utloggad.' });
});

// ======================= AGENT INSTALLATION =======================

// Unauthenticated by necessity -- the remote host is not logged in. The code in
// the URL is high-entropy, expires after 30 minutes and is single-use.
// Agent-imagen, skyddad av samma engångskod. Låter fjärrservern hämta imagen
// direkt från hubben i stället för att kräva ett register.
app.get('/install/:code/image', createInstallImageRoute({ hub, agentImage: AGENT_IMAGE }));

app.get('/install/:code', createInstallRoute({
  hub,
  agentImage: AGENT_IMAGE,
  hubWsUrlOverride: HUB_WS_URL
}));

// ======================= SERVER + CONTAINER ROUTES =======================

app.use('/api/servers', createServersRouter({
  mw, hub, unlock, agentImage: AGENT_IMAGE, hubWsUrlOverride: HUB_WS_URL
}));

const containersRouter = createContainersRouter({ mw });
app.use('/api/servers/:serverId/containers', containersRouter);

// Aggregate view across every enabled server, served entirely from the
// snapshot cache. This is what the dashboard polls.
app.get('/api/containers', requireAuth, (req, res) => {
  const only = req.query.server || null;
  const db = descriptions.load();
  const containers = [];
  const hostMetricsByServer = {};

  for (const entry of registry.list()) {
    if (!entry.enabled) continue;
    if (only && entry.id !== only) continue;

    const transport = hub.getTransport(entry.id);
    const snap = transport ? transport.getSnapshot() : null;
    if (!snap) continue;

    hostMetricsByServer[entry.id] = snap.hostMetrics;
    for (const c of descriptions.applyTo(db, entry.id, snap.containers)) {
      containers.push({
        ...c,
        serverId: entry.id,
        serverName: entry.name,
        serverColor: entry.color,
        serverPublicHost: entry.publicHost
      });
    }
  }

  const localSnap = hub.getTransport('local') ? hub.getTransport('local').getSnapshot() : null;
  res.json({
    success: true,
    containers,
    hostMetricsByServer,
    // Kept for backwards compatibility with clients that predate multi-server.
    hostMetrics: localSnap ? localSnap.hostMetrics : null
  });
});

// Legacy unscoped routes -- resolveServer defaults these to the local server.
app.use('/api/containers', containersRouter);

// Legacy: the local server's Docker engine info.
app.get('/api/system/info', requireAuth, (req, res) => {
  const snap = hub.getTransport('local').getSnapshot();
  if (!snap) {
    return res.status(503).json({ success: false, error: 'Väntar på data från Docker.' });
  }
  res.json({ success: true, data: snap.info });
});

// Legacy: prune on the local server.
app.post('/api/system/prune', requireAuth, async (req, res) => {
  try {
    const data = await hub.getTransport('local').call('system.prune', {});
    hub.getTransport('local').requestSnapshotNow();
    res.json({ success: true, message: 'Systemet har rensats från oanvända resurser.', ...data });
  } catch (err) {
    res.status(err.httpStatus || 500).json({
      success: false,
      error: 'Prune misslyckades: ' + (err.userMessage || err.message)
    });
  }
});

// ======================= WEBSOCKETS =======================

// Browser-facing log streaming, now able to proxy to any server's transport.
const logsWss = new WebSocketServer({ noServer: true });
logsWss.on('connection', createLogsHandler({ hub, jwtSecret: JWT_SECRET }));

// Agent-facing endpoint (its own maxPayload and handshake rules).
hub.attach(server, '/ws/agent');

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws/logs') {
    logsWss.handleUpgrade(req, socket, head, ws => logsWss.emit('connection', ws, req));
  } else if (pathname === '/ws/agent') {
    hub.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Catch-all route to send index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` Docker Harbor Server is running on port ${PORT}`);
  console.log(` URL: http://0.0.0.0:${PORT}`);
  console.log(` Servrar i registret: ${registry.list().map(s => s.id).join(', ')}`);
  console.log(`====================================================`);
});
