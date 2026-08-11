const express = require('express');
const http = require('http');
const path = require('path');
const Docker = require('dockerode');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/logs' });

const PORT = process.env.PORT || 6969;
const JWT_SECRET = process.env.JWT_SECRET || 'docker-harbor-super-secret-key-2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Default password is 'admin123' if not specified in .env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Initialize Docker client
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.docker_harbor_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Ej behörig. Vänligen logga in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Ogiltig eller utgången session.' });
  }
};

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

// ======================= DOCKER ROUTES =======================

// Host System Info & Stats
app.get('/api/system/info', requireAuth, async (req, res) => {
  try {
    const info = await docker.info();
    const version = await docker.version();
    const containers = await docker.listContainers({ all: true });

    const running = containers.filter(c => c.State === 'running').length;
    const stopped = containers.filter(c => c.State === 'exited' || c.State === 'created').length;
    const paused = containers.filter(c => c.State === 'paused').length;

    res.json({
      success: true,
      data: {
        serverVersion: version.Version,
        os: info.OperatingSystem,
        architecture: info.Architecture,
        ncpu: info.NCPU,
        memTotal: info.MemTotal,
        containersTotal: containers.length,
        containersRunning: running,
        containersStopped: stopped,
        containersPaused: paused,
        imagesTotal: info.Images
      }
    });
  } catch (err) {
    console.error('Docker system info error:', err);
    res.status(500).json({ success: false, error: 'Kunde inte hämta systeminformation från Docker: ' + err.message });
  }
});

// List Containers
app.get('/api/containers', requireAuth, async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });

    // Fetch inspect details in parallel for restart policies
    const inspects = await Promise.all(
      containers.map(c => docker.getContainer(c.Id).inspect().catch(() => null))
    );

    // Format container objects nicely for UI
    const formatted = containers.map((c, idx) => {
      const inspectData = inspects[idx];
      const restartPolicy = (inspectData && inspectData.HostConfig && inspectData.HostConfig.RestartPolicy && inspectData.HostConfig.RestartPolicy.Name) || 'no';
      const configFile = (c.Labels && c.Labels['com.docker.compose.project.config_files']) || null;
      const workingDir = (c.Labels && c.Labels['com.docker.compose.project.working_dir']) || null;
      const composeProject = (c.Labels && c.Labels['com.docker.compose.project']) || null;
      const composeService = (c.Labels && c.Labels['com.docker.compose.service']) || null;

      return {
        id: c.Id,
        shortId: c.Id.substring(0, 12),
        names: c.Names.map(n => n.replace(/^\//, '')),
        image: c.Image,
        imageId: c.ImageID,
        command: c.Command,
        created: c.Created,
        state: c.State,
        status: c.Status,
        ports: c.Ports.map(p => ({
          IP: p.IP,
          PrivatePort: p.PrivatePort,
          PublicPort: p.PublicPort,
          Type: p.Type
        })),
        labels: c.Labels,
        mounts: c.Mounts,
        restartPolicy,
        configFile,
        workingDir,
        composeProject,
        composeService
      };
    });

    res.json({ success: true, containers: formatted });
  } catch (err) {
    console.error('List containers error:', err);
    res.status(500).json({ success: false, error: 'Kunde inte lista containers: ' + err.message });
  }
});

// Update Container Restart Policy
app.post('/api/containers/:id/restart-policy', requireAuth, async (req, res) => {
  const { restartPolicy } = req.body;
  const validPolicies = ['always', 'unless-stopped', 'no', 'on-failure'];

  if (!restartPolicy || !validPolicies.includes(restartPolicy)) {
    return res.status(400).json({ success: false, error: 'Ogiltig restart policy angiven.' });
  }

  try {
    const container = docker.getContainer(req.params.id);
    await container.update({
      RestartPolicy: {
        Name: restartPolicy,
        MaximumRetryCount: restartPolicy === 'on-failure' ? 5 : 0
      }
    });
    res.json({ success: true, message: `Restart policy ändrades till '${restartPolicy}'.` });
  } catch (err) {
    console.error('Update restart policy error:', err);
    res.status(500).json({ success: false, error: 'Kunde inte uppdatera restart policy: ' + err.message });
  }
});

// Inspect Container
app.get('/api/containers/:id', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const data = await container.inspect();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte inspektera container: ' + err.message });
  }
});

// Start Container
app.post('/api/containers/:id/start', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.start();
    res.json({ success: true, message: 'Container startades.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte starta container: ' + err.message });
  }
});

// Stop Container
app.post('/api/containers/:id/stop', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.stop({ t: 10 }); // 10s graceful timeout
    res.json({ success: true, message: 'Container stoppades.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte stoppa container: ' + err.message });
  }
});

// Restart Container
app.post('/api/containers/:id/restart', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.restart({ t: 10 });
    res.json({ success: true, message: 'Container omstartades.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte starta om container: ' + err.message });
  }
});

// Rebuild / Recreate Container
app.post('/api/containers/:id/rebuild', requireAuth, async (req, res) => {
  const containerId = req.params.id;
  try {
    const container = docker.getContainer(containerId);
    const inspectData = await container.inspect();

    const imageName = inspectData.Config.Image;
    const name = inspectData.Name.replace(/^\//, '');

    // Attempt to pull latest image if image tag is present and not local build only
    try {
      if (imageName && !imageName.startsWith('sha256:')) {
        console.log(`Pulling latest image for ${imageName}...`);
        await new Promise((resolve, reject) => {
          docker.pull(imageName, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err, output) => {
              if (err) return reject(err);
              resolve(output);
            });
          });
        });
      }
    } catch (pullErr) {
      console.warn(`Image pull warning (continuing with local image): ${pullErr.message}`);
    }

    // Stop container if running
    if (inspectData.State.Running) {
      console.log(`Stopping container ${name}...`);
      await container.stop({ t: 10 }).catch(() => {});
    }

    // Prepare creation options from original inspect configuration
    const createOptions = {
      name: name,
      Image: inspectData.Config.Image,
      Env: inspectData.Config.Env,
      Cmd: inspectData.Config.Cmd,
      Entrypoint: inspectData.Config.Entrypoint,
      WorkingDir: inspectData.Config.WorkingDir,
      Labels: inspectData.Config.Labels,
      ExposedPorts: inspectData.Config.ExposedPorts,
      HostConfig: inspectData.HostConfig
    };

    // Remove existing container
    console.log(`Removing container ${name}...`);
    await container.remove({ v: false, force: true });

    // Create new container
    console.log(`Creating new container ${name}...`);
    const newContainer = await docker.createContainer(createOptions);

    // Start new container
    console.log(`Starting container ${name}...`);
    await newContainer.start();

    res.json({
      success: true,
      message: `Container ${name} har byggts om och startats på nytt.`,
      newId: newContainer.id
    });
  } catch (err) {
    console.error('Rebuild container error:', err);
    res.status(500).json({ success: false, error: 'Kunde inte bygga om container: ' + err.message });
  }
});

// Delete Container
app.delete('/api/containers/:id', requireAuth, async (req, res) => {
  const force = req.query.force === 'true';
  const removeVolumes = req.query.v === 'true';

  try {
    const container = docker.getContainer(req.params.id);
    await container.remove({ force, v: removeVolumes });
    res.json({ success: true, message: 'Container har tagits bort.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte ta bort container: ' + err.message });
  }
});

// Logs Endpoint (HTTP JSON backupt/tail)
app.get('/api/containers/:id/logs', requireAuth, async (req, res) => {
  const tail = parseInt(req.query.tail) || 200;
  try {
    const container = docker.getContainer(req.params.id);
    const logsBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail,
      timestamps: true
    });

    // Clean docker stream headers (docker raw stream appends 8-byte header per frame)
    let cleanedLogs = '';
    if (Buffer.isBuffer(logsBuffer)) {
      let offset = 0;
      while (offset < logsBuffer.length) {
        if (offset + 8 > logsBuffer.length) {
          cleanedLogs += logsBuffer.toString('utf8', offset);
          break;
        }
        const payloadSize = logsBuffer.readUInt32BE(offset + 4);
        const chunk = logsBuffer.toString('utf8', offset + 8, offset + 8 + payloadSize);
        cleanedLogs += chunk;
        offset += 8 + payloadSize;
      }
    } else {
      cleanedLogs = logsBuffer.toString();
    }

    res.json({ success: true, logs: cleanedLogs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kunde inte hämta loggar: ' + err.message });
  }
});

// System Prune Endpoint
app.post('/api/system/prune', requireAuth, async (req, res) => {
  try {
    const prunedContainers = await docker.pruneContainers();
    const prunedImages = await docker.pruneImages();
    res.json({
      success: true,
      message: 'Systemet har rensats från oanvända resurser.',
      containersDeleted: prunedContainers.ContainersDeleted || [],
      spaceReclaimed: (prunedContainers.SpaceReclaimed || 0) + (prunedImages.SpaceReclaimed || 0)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Prune misslyckades: ' + err.message });
  }
});

// ======================= WEBSOCKET FOR LOG STREAMING =======================

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/ws/logs?', ''));
  const containerId = urlParams.get('containerId');
  const token = urlParams.get('token');

  // Verify Auth
  try {
    if (!token) throw new Error('Ingen token angiven.');
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: 'Obehörig WebSocket-anslutning.' }));
    ws.close();
    return;
  }

  if (!containerId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Saknar containerId.' }));
    ws.close();
    return;
  }

  const container = docker.getContainer(containerId);
  let logStream = null;

  container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 150,
    timestamps: true
  }, (err, stream) => {
    if (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Kunde inte ansluta till loggström: ' + err.message }));
      ws.close();
      return;
    }

    logStream = stream;

    stream.on('data', (chunk) => {
      // Clean header frames
      let text = '';
      if (chunk.length >= 8) {
        text = chunk.slice(8).toString('utf8');
      } else {
        text = chunk.toString('utf8');
      }
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'log', data: text }));
      }
    });

    stream.on('end', () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'end', message: 'Loggström avslutades.' }));
      }
    });
  });

  ws.on('close', () => {
    if (logStream && typeof logStream.destroy === 'function') {
      logStream.destroy();
    }
  });
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
  console.log(`====================================================`);
});
