'use strict';

const os = require('os');
const { execFile } = require('child_process');

// ======================= FORMATTERS =======================

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatMibGib(bytes) {
  if (!bytes || bytes <= 0) return '0 MiB';
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) {
    return (mib / 1024).toFixed(2) + ' GiB';
  }
  return mib.toFixed(1) + ' MiB';
}

// ======================= CONTAINER METRICS =======================

function calculateContainerMetrics(stats) {
  if (!stats || !stats.cpu_stats) {
    return { cpuPercent: '--', memory: '--', netIo: '--' };
  }

  let cpuPercent = 0.0;
  const cpuDelta = (stats.cpu_stats.cpu_usage ? stats.cpu_stats.cpu_usage.total_usage : 0) -
                   (stats.precpu_stats && stats.precpu_stats.cpu_usage ? stats.precpu_stats.cpu_usage.total_usage : 0);
  const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) -
                      (stats.precpu_stats ? stats.precpu_stats.system_cpu_usage || 0 : 0);
  const numCpus = (stats.cpu_stats.online_cpus) ||
                  (stats.cpu_stats.cpu_usage && stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);

  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemDelta) * numCpus * 100.0;
  }

  const usage = stats.memory_stats ? (stats.memory_stats.usage - (stats.memory_stats.stats ? (stats.memory_stats.stats.cache || stats.memory_stats.stats.inactive_file || 0) : 0)) : 0;
  const limit = stats.memory_stats ? stats.memory_stats.limit : 0;

  const usageStr = formatMibGib(usage);
  let memFormatted = usageStr;
  if (limit && limit > 0 && limit < 1e15) {
    memFormatted = `${usageStr} / ${formatMibGib(limit)}`;
  }

  let rx = 0;
  let tx = 0;
  if (stats.networks) {
    Object.values(stats.networks).forEach(n => {
      rx += n.rx_bytes || 0;
      tx += n.tx_bytes || 0;
    });
  }
  const netFormatted = `↓ ${formatBytes(rx)} / ↑ ${formatBytes(tx)}`;

  return {
    cpuPercent: cpuPercent.toFixed(1) + '%',
    memory: memFormatted,
    netIo: netFormatted
  };
}

// ======================= HOST METRICS =======================

let prevHostCpuTimes = null;

function getHostCpuPercent() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  cpus.forEach(cpu => {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  });

  const total = user + nice + sys + idle + irq;
  if (!prevHostCpuTimes) {
    prevHostCpuTimes = { total, idle };
    return '0.0%';
  }

  const totalDelta = total - prevHostCpuTimes.total;
  const idleDelta = idle - prevHostCpuTimes.idle;
  prevHostCpuTimes = { total, idle };

  if (totalDelta <= 0) return '0.0%';
  const usagePercent = ((1 - idleDelta / totalDelta) * 100).toFixed(1);
  return usagePercent + '%';
}

function getHostRamMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const totalGb = (total / (1024 * 1024 * 1024)).toFixed(1);
  const usedGb = (used / (1024 * 1024 * 1024)).toFixed(1);
  const percent = ((used / total) * 100).toFixed(1);
  return `${usedGb} GiB / ${totalGb} GiB (${percent}%)`;
}

const NVIDIA_QUERY = ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
const NO_GPU = { gpuPercent: '--', vram: '--' };

// Parse the csv line nvidia-smi emits: "31, 8192, 24576"
function parseNvidiaOutput(output) {
  const clean = String(output).replace(/[^\x20-\x7E]/g, '').trim();
  if (!clean || !clean.includes(',')) return null;
  const parts = clean.split(',').map(s => s.trim());
  if (parts.length < 3) return null;

  const gpuUtil = parseInt(parts[0], 10) || 0;
  const memUsed = parseFloat(parts[1]) || 0;
  const memTotal = parseFloat(parts[2]) || 0;

  const usedGb = (memUsed / 1024).toFixed(1);
  const totalGb = (memTotal / 1024).toFixed(1);
  const vramPercent = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : '0';

  return {
    gpuPercent: `${gpuUtil}%`,
    vram: `${usedGb} GiB / ${totalGb} GiB (${vramPercent}%)`
  };
}

// nvidia-smi bind-mounted into our own container: cheapest path, no exec dance.
let localNvidiaSmiWorks = null;

function tryLocalNvidiaSmi() {
  if (localNvidiaSmiWorks === false) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('nvidia-smi', NVIDIA_QUERY, { timeout: 1500 }, (err, stdout) => {
      if (err) {
        localNvidiaSmiWorks = false;
        return resolve(null);
      }
      const parsed = parseNvidiaOutput(stdout);
      localNvidiaSmiWorks = !!parsed;
      resolve(parsed);
    });
  });
}

// Remember which container answered last time so the loop normally costs one exec.
let lastGpuContainerId = null;

async function execNvidiaSmiIn(docker, containerId) {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ['nvidia-smi', ...NVIDIA_QUERY],
    AttachStdout: true,
    AttachStderr: true
  });
  const stream = await exec.start();
  const output = await new Promise((resolve) => {
    let buf = '';
    stream.on('data', chunk => buf += chunk.toString());
    stream.on('end', () => resolve(buf));
    setTimeout(() => resolve(''), 1500);
  });
  return parseNvidiaOutput(output);
}

async function getHostGpuMetrics(docker, runningContainers) {
  const local = await tryLocalNvidiaSmi();
  if (local) return local;

  const ids = (runningContainers || []).map(c => c.Id);
  if (lastGpuContainerId && ids.includes(lastGpuContainerId)) {
    ids.splice(ids.indexOf(lastGpuContainerId), 1);
    ids.unshift(lastGpuContainerId);
  }

  for (const id of ids) {
    try {
      const parsed = await execNvidiaSmiIn(docker, id);
      if (parsed) {
        lastGpuContainerId = id;
        return parsed;
      }
    } catch (e) {}
  }
  lastGpuContainerId = null;
  return { ...NO_GPU };
}

module.exports = {
  formatBytes,
  formatMibGib,
  calculateContainerMetrics,
  getHostCpuPercent,
  getHostRamMetrics,
  getHostGpuMetrics
};
