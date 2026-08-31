'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const { OpError, validateOp, getSpec } = require('./protocol');
const {
  calculateContainerMetrics,
  getHostCpuPercent,
  getHostRamMetrics,
  getHostGpuMetrics
} = require('./metrics');

// ======================= COMPOSE FILE HELPERS =======================

function updateComposeFileDescription(filePath, serviceName, newDesc) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;

    const yamlText = fs.readFileSync(filePath, 'utf8');
    const doc = YAML.parseDocument(yamlText);
    const services = doc.get('services');
    if (!services) return false;

    // Try target serviceName, or fallback to first service in compose file if only 1 service
    let service = doc.getIn(['services', serviceName]);
    if (!service && services.items && services.items.length > 0) {
      // Find service where container_name matches or default to first
      for (const item of services.items) {
        if (item.value && item.value.get && item.value.get('container_name') === serviceName) {
          service = item.value;
          break;
        }
      }
      if (!service) service = services.items[0].value;
    }

    if (!service) return false;

    let labels = service.get('labels');
    if (!labels) {
      if (newDesc) {
        service.set('labels', { description: newDesc });
      }
    } else if (YAML.isSeq(labels)) {
      let found = false;
      for (let i = 0; i < labels.items.length; i++) {
        const item = String(labels.items[i]);
        if (item.startsWith('description=') || item.startsWith('harbor.description=')) {
          if (newDesc) {
            labels.items[i] = new YAML.Scalar(`description=${newDesc}`);
          } else {
            labels.items.splice(i, 1);
          }
          found = true;
          break;
        }
      }
      if (!found && newDesc) {
        labels.items.push(new YAML.Scalar(`description=${newDesc}`));
      }
    } else {
      if (newDesc) {
        service.setIn(['labels', 'description'], newDesc);
      } else {
        service.deleteIn(['labels', 'description']);
      }
    }

    fs.writeFileSync(filePath, doc.toString(), 'utf8');
    return true;
  } catch (err) {
    console.error(`Error updating compose file ${filePath}:`, err.message);
    return false;
  }
}

// Resolve the on-disk compose / Dockerfile path for a container purely from its
// own labels. Callers never supply a path -- that is the whole point.
// Labeln kan innehålla flera filer, kommaseparerade, när compose körts med
// en override-fil. Ta den första som faktiskt finns -- det är basfilen.
function primaryConfigFile(labels) {
  const raw = labels['com.docker.compose.project.config_files'];
  if (!raw) return null;
  const paths = String(raw).split(',').map(p => p.trim()).filter(Boolean);
  return paths.find(p => fs.existsSync(p)) || paths[0] || null;
}

function resolveContainerFile(labels, workingDirFallback, fileType) {
  const configFile = primaryConfigFile(labels);
  const workingDir = labels['com.docker.compose.project.working_dir'] || workingDirFallback || null;

  if (fileType === 'compose') {
    if (configFile && fs.existsSync(configFile)) return configFile;
    if (workingDir) {
      const altCompose = path.join(workingDir, 'docker-compose.yml');
      const altComposeYaml = path.join(workingDir, 'docker-compose.yaml');
      if (fs.existsSync(altCompose)) return altCompose;
      if (fs.existsSync(altComposeYaml)) return altComposeYaml;
    }
    return null;
  }

  if (fileType === 'dockerfile') {
    if (workingDir) {
      const df = path.join(workingDir, 'Dockerfile');
      if (fs.existsSync(df)) return df;
    }
    if (configFile) {
      const df = path.join(path.dirname(configFile), 'Dockerfile');
      if (fs.existsSync(df)) return df;
    }
  }
  return null;
}

// The label-derived description. The custom descriptions.json overlay lives on
// the hub, so agents never need that file.
function labelDescriptionOf(labels) {
  return (labels && (
    labels['description'] ||
    labels['harbor.description'] ||
    labels['com.docker.harbor.description'] ||
    labels['org.opencontainers.image.description'] ||
    labels['info']
  )) || null;
}

// ======================= CONTAINER LISTING =======================

async function listContainers(docker, withStats) {
  const containers = await docker.listContainers({ all: true });

  const inspectsAndStats = await Promise.all(
    containers.map(async c => {
      const inspect = await docker.getContainer(c.Id).inspect().catch(() => null);
      let stats = null;
      if (withStats && c.State === 'running') {
        stats = await docker.getContainer(c.Id).stats({ stream: false }).catch(() => null);
      }
      return { inspect, stats };
    })
  );

  return containers.map((c, idx) => {
    const { inspect: inspectData, stats } = inspectsAndStats[idx];
    const metrics = (c.State === 'running' && stats)
      ? calculateContainerMetrics(stats)
      : { cpuPercent: '--', memory: '--', netIo: '--' };

    const restartPolicy = (inspectData && inspectData.HostConfig && inspectData.HostConfig.RestartPolicy && inspectData.HostConfig.RestartPolicy.Name) || 'no';
    const labels = c.Labels || {};
    const configFile = primaryConfigFile(labels);
    const workingDir = labels['com.docker.compose.project.working_dir'] || null;
    const composeProject = labels['com.docker.compose.project'] || null;
    const composeService = labels['com.docker.compose.service'] || null;

    const dockerfileFile = resolveContainerFile(labels, null, 'dockerfile');
    const hasCompose = !!(configFile && fs.existsSync(configFile));
    const hasDockerfile = !!dockerfileFile;

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
      composeService,
      labelDescription: labelDescriptionOf(labels),
      hasCompose,
      hasDockerfile,
      metrics
    };
  });
}

async function systemInfo(docker) {
  const info = await docker.info();
  const version = await docker.version();
  const containers = await docker.listContainers({ all: true });

  const running = containers.filter(c => c.State === 'running').length;
  const stopped = containers.filter(c => c.State === 'exited' || c.State === 'created').length;
  const paused = containers.filter(c => c.State === 'paused').length;

  return {
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
  };
}

async function hostMetrics(docker) {
  const running = await docker.listContainers({ filters: { status: ['running'] } }).catch(() => []);
  const gpu = await getHostGpuMetrics(docker, running);
  return {
    cpuPercent: getHostCpuPercent(),
    ram: getHostRamMetrics(),
    gpuPercent: gpu.gpuPercent,
    vram: gpu.vram
  };
}

// Strip the 8-byte header Docker prepends to each multiplexed stream frame.
function stripLogHeaders(logsBuffer) {
  if (!Buffer.isBuffer(logsBuffer)) return logsBuffer.toString();
  let cleaned = '';
  let offset = 0;
  while (offset < logsBuffer.length) {
    if (offset + 8 > logsBuffer.length) {
      cleaned += logsBuffer.toString('utf8', offset);
      break;
    }
    const payloadSize = logsBuffer.readUInt32BE(offset + 4);
    cleaned += logsBuffer.toString('utf8', offset + 8, offset + 8 + payloadSize);
    offset += 8 + payloadSize;
  }
  return cleaned;
}

async function rebuildContainer(docker, id) {
  const container = docker.getContainer(id);
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
          docker.modem.followProgress(stream, (err2, output) => {
            if (err2) return reject(err2);
            resolve(output);
          });
        });
      });
    }
  } catch (pullErr) {
    console.warn(`Image pull warning (continuing with local image): ${pullErr.message}`);
  }

  if (inspectData.State.Running) {
    console.log(`Stopping container ${name}...`);
    await container.stop({ t: 10 }).catch(() => {});
  }

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

  console.log(`Removing container ${name}...`);
  await container.remove({ v: false, force: true });

  console.log(`Creating new container ${name}...`);
  const newContainer = await docker.createContainer(createOptions);

  console.log(`Starting container ${name}...`);
  await newContainer.start();

  return { name, newId: newContainer.id };
}

async function readContainerFile(docker, id, fileType) {
  const inspectData = await docker.getContainer(id).inspect().catch(() => null);
  if (!inspectData) {
    throw new OpError('NOT_FOUND', 'Container hittades inte.');
  }

  const labels = inspectData.Config.Labels || {};
  const targetPath = resolveContainerFile(labels, inspectData.Config.WorkingDir, fileType);

  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new OpError('NOT_FOUND',
      `Ingen ${fileType === 'compose' ? 'docker-compose.yml' : 'Dockerfile'} hittades för denna container.`);
  }

  return {
    fileType,
    fileName: path.basename(targetPath),
    filePath: targetPath,
    content: fs.readFileSync(targetPath, 'utf8')
  };
}

async function writeComposeDescription(docker, id, description) {
  const inspectData = await docker.getContainer(id).inspect().catch(() => null);
  const containerName = inspectData && inspectData.Name ? inspectData.Name.replace(/^\//, '') : id;

  const labels = (inspectData && inspectData.Config && inspectData.Config.Labels) || {};
  const configFile = primaryConfigFile(labels);
  const composeService = labels['com.docker.compose.service'] || containerName;

  let composeUpdated = false;
  if (configFile) {
    composeUpdated = updateComposeFileDescription(configFile, composeService, description);
  }
  return { containerName, composeUpdated };
}

// ======================= PRUNE =======================

const PREDEFINED_NETWORKS = ['bridge', 'host', 'none'];

// Vad en rensning skulle ta bort, utan att ta bort något. Docker har ingen
// dry-run for prune, sa vi listar sjalva vad som matchar samma kriterier.
async function pruneInfo(docker) {
  const [stopped, dangling, df, networks] = await Promise.all([
    docker.listContainers({ all: true, filters: { status: ['exited', 'created', 'dead'] } }).catch(() => []),
    docker.listImages({ filters: { dangling: ['true'] } }).catch(() => []),
    docker.df().catch(() => ({})),
    docker.listNetworks().catch(() => [])
  ]);

  const dfImages = df.Images || [];
  const unusedImages = dfImages.filter(i => (i.Containers || 0) === 0);
  const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) || 0), 0);

  const danglingIds = new Set(dangling.map(i => i.Id));
  const danglingUnused = unusedImages.filter(i => danglingIds.has(i.Id));
  // Otaggade lager som inte langre ingar i nagon image
  const danglingSize = danglingUnused.length
    ? sum(danglingUnused, i => i.Size)
    : sum(dangling, i => i.Size);

  const volumes = (df.Volumes || []).filter(v => !v.UsageData || v.UsageData.RefCount === 0);
  const buildCache = (df.BuildCache || []).filter(c => !c.InUse);
  const unusedNetworks = networks.filter(n =>
    !PREDEFINED_NETWORKS.includes(n.Name) &&
    (!n.Containers || Object.keys(n.Containers).length === 0)
  );

  return {
    containers: stopped.map(c => ({
      id: c.Id,
      name: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
      image: c.Image,
      status: c.Status,
      size: c.SizeRw || 0
    })),
    danglingImages: { count: danglingUnused.length || dangling.length, size: danglingSize },
    unusedImages: { count: unusedImages.length, size: sum(unusedImages, i => i.Size) },
    volumes: volumes.map(v => ({
      name: v.Name,
      size: (v.UsageData && v.UsageData.Size > 0) ? v.UsageData.Size : 0
    })),
    networks: unusedNetworks.map(n => ({ name: n.Name })),
    buildCache: { count: buildCache.length, size: sum(buildCache, c => c.Size) }
  };
}

// Rensning med explicit omfattning. Standard motsvarar det knappen alltid
// gjort: stoppade containers + otaggade image-lager. Allt annat ar opt-in.
async function pruneSystem(docker, opts) {
  const removed = { containers: [], images: 0, volumes: [], networks: [], buildCache: 0 };
  let reclaimed = 0;

  if (opts.containers !== false) {
    const r = await docker.pruneContainers();
    removed.containers = r.ContainersDeleted || [];
    reclaimed += r.SpaceReclaimed || 0;
  }

  if (opts.images === 'all') {
    // dangling=false betyder "aven taggade images som ingen container anvander"
    const r = await docker.pruneImages({ filters: JSON.stringify({ dangling: ['false'] }) });
    removed.images = (r.ImagesDeleted || []).length;
    reclaimed += r.SpaceReclaimed || 0;
  } else if (opts.images !== 'none') {
    const r = await docker.pruneImages();
    removed.images = (r.ImagesDeleted || []).length;
    reclaimed += r.SpaceReclaimed || 0;
  }

  if (opts.networks) {
    const r = await docker.pruneNetworks();
    removed.networks = r.NetworksDeleted || [];
  }

  if (opts.buildCache) {
    const r = await docker.pruneBuilder();
    removed.buildCache = (r.CachesDeleted || []).length;
    reclaimed += r.SpaceReclaimed || 0;
  }

  // Volymer sist och bara pa uttrycklig begaran -- det ar den enda delen som
  // kan forstora data som inte gar att bygga om.
  if (opts.volumes) {
    const r = await docker.pruneVolumes();
    removed.volumes = r.VolumesDeleted || [];
    reclaimed += r.SpaceReclaimed || 0;
  }

  return {
    containersDeleted: removed.containers,
    imagesDeleted: removed.images,
    volumesDeleted: removed.volumes,
    networksDeleted: removed.networks,
    buildCacheDeleted: removed.buildCache,
    spaceReclaimed: reclaimed
  };
}

// ======================= OP TABLE =======================

const OPS = {
  'system.info': (docker) => systemInfo(docker),

  'system.prune': (docker, a) => pruneSystem(docker, a),

  'system.pruneInfo': (docker) => pruneInfo(docker),

  'host.metrics': (docker) => hostMetrics(docker),

  'snapshot': async (docker) => ({
    ts: Date.now(),
    info: await systemInfo(docker),
    containers: await listContainers(docker, true),
    hostMetrics: await hostMetrics(docker)
  }),

  'containers.list': (docker, a) => listContainers(docker, a.withStats),

  'containers.inspect': (docker, a) => docker.getContainer(a.id).inspect(),

  'containers.start': async (docker, a) => {
    await docker.getContainer(a.id).start();
    return {};
  },

  'containers.stop': async (docker, a) => {
    await docker.getContainer(a.id).stop({ t: a.t });
    return {};
  },

  'containers.restart': async (docker, a) => {
    await docker.getContainer(a.id).restart({ t: a.t });
    return {};
  },

  'containers.rebuild': (docker, a) => rebuildContainer(docker, a.id),

  'containers.remove': async (docker, a) => {
    await docker.getContainer(a.id).remove({ force: a.force, v: a.v });
    return {};
  },

  'containers.logsTail': async (docker, a) => {
    const logsBuffer = await docker.getContainer(a.id).logs({
      stdout: true,
      stderr: true,
      tail: a.tail,
      timestamps: true
    });
    return { logs: stripLogHeaders(logsBuffer) };
  },

  'containers.restartPolicy': async (docker, a) => {
    await docker.getContainer(a.id).update({
      RestartPolicy: {
        Name: a.policy,
        MaximumRetryCount: a.policy === 'on-failure' ? 5 : 0
      }
    });
    return {};
  },

  'containers.readFile': (docker, a) => readContainerFile(docker, a.id, a.fileType),

  'containers.writeComposeDescription': (docker, a) => writeComposeDescription(docker, a.id, a.description)
};

// The single entry point for executing an op. Used identically by the hub's
// LocalTransport and by the agent.
async function execOp(docker, op, args, caps) {
  const cleanArgs = validateOp(op, args, caps);
  const spec = getSpec(op);
  if (spec.streaming) {
    throw new OpError('BAD_ARGS', `Operationen ${op} är en ström och kan inte anropas direkt.`);
  }
  return OPS[op](docker, cleanArgs);
}

// Open a following log stream. Separate from execOp because it is not
// request/response. `onChunk` receives text with the Docker header stripped.
function openLogStream(docker, args, { onChunk, onEnd, onError }) {
  let cleanArgs;
  try {
    cleanArgs = validateOp('logs.follow', args, { allowActions: false });
  } catch (err) {
    onError(err);
    return { close() {} };
  }

  let logStream = null;
  let closed = false;

  docker.getContainer(cleanArgs.id).logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: cleanArgs.tail,
    timestamps: true
  }, (err, stream) => {
    if (err) {
      return onError(new OpError('NOT_FOUND', 'Kunde inte ansluta till loggström: ' + err.message));
    }
    if (closed) {
      if (typeof stream.destroy === 'function') stream.destroy();
      return;
    }
    logStream = stream;

    stream.on('data', (chunk) => {
      const text = chunk.length >= 8 ? chunk.slice(8).toString('utf8') : chunk.toString('utf8');
      onChunk(text);
    });
    stream.on('end', () => onEnd('Loggström avslutades.'));
    stream.on('error', (e) => onEnd('Loggström avbröts: ' + e.message));
  });

  return {
    close() {
      closed = true;
      if (logStream && typeof logStream.destroy === 'function') logStream.destroy();
      logStream = null;
    }
  };
}

module.exports = {
  execOp,
  primaryConfigFile,
  pruneInfo,
  pruneSystem,
  openLogStream,
  OPS,
  listContainers,
  systemInfo,
  hostMetrics,
  labelDescriptionOf,
  resolveContainerFile,
  updateComposeFileDescription,
  stripLogHeaders,
  OpError
};
