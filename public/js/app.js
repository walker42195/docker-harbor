// Docker Harbor Client Application Script

let containersData = [];
let serversData = [];
let activeServerId = localStorage.getItem('docker_harbor_active_server') || 'local';
let pendingUnlockServerId = null;
let lastRenderedServerId = null;
let activeFilter = 'all';
let searchKeyword = '';
let currentToken = localStorage.getItem('docker_harbor_jwt') || '';
let autoRefreshTimer = null;
let activeWs = null;
let pendingDeleteId = null;
let pendingDeleteServerId = null;
let lastContainersSignature = null;

// DOM Elements
const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginForm = document.getElementById('loginForm');
const containerList = document.getElementById('containerList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const serverTabs = document.getElementById('serverTabs');

// Helpers for the currently selected server
function getServer(id) {
  return serversData.find(s => s.id === id) || null;
}

function activeServer() {
  return getServer(activeServerId);
}

// A server accepts write actions only when it is reachable, unlocked on the hub
// side, and the agent itself is not in read-only mode.
function serverCanWrite(srv) {
  if (!srv) return false;
  if (srv.status === 'offline') return false;
  if (srv.requireUnlock && !srv.unlocked) return false;
  return !!(srv.caps && srv.caps.allowActions);
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
  setupEventListeners();
});

// Setup Events
function setupEventListeners() {
  // Login Form
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const loginBtn = document.getElementById('loginBtn');

    loginBtn.disabled = true;
    loginBtn.innerHTML = `<span class="spinner">↻</span> Loggar in...`;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (data.success) {
        currentToken = data.token;
        localStorage.setItem('docker_harbor_jwt', data.token);
        showToast('Inloggning lyckades!', 'success');
        showDashboard();
      } else {
        showToast(data.error || 'Inloggning misslyckades.', 'error');
      }
    } catch (err) {
      showToast('Nätverksfel vid inloggning.', 'error');
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = `Logga In`;
    }
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    localStorage.removeItem('docker_harbor_jwt');
    currentToken = '';
    showLogin();
    showToast('Du har loggats ut.', 'info');
  });

  // Refresh Button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    fetchDashboardData(true);
  });

  // Prune Button (scoped to the active server)
  document.getElementById('pruneBtn').addEventListener('click', async () => {
    const srv = activeServer();
    if (!srv) return;
    if (!confirm(`Vill du rensa bort alla stoppade containers och oanvända Docker-bilder på "${srv.name}"?`)) return;
    showToast(`Rensar Docker-systemet på ${srv.name}...`, 'info');
    try {
      const res = await apiFetch(`/api/servers/${srv.id}/system/prune`, { method: 'POST' });
      if (res.success) {
        showToast(`Systemrensning klar! ${res.containersDeleted.length} containers rensades.`, 'success');
        fetchDashboardData();
      } else {
        showToast(res.error, 'error');
      }
    } catch (err) {
      showToast('Kunde inte utföra prune.', 'error');
    }
  });

  // Search Input
  searchInput.addEventListener('input', (e) => {
    searchKeyword = e.target.value.toLowerCase().trim();
    renderContainers();
  });

  // Filter Pills
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderContainers();
    });
  });

  // Description Form Submit
  const descForm = document.getElementById('descForm');
  if (descForm) {
    descForm.addEventListener('submit', handleSaveDescription);
  }

  // Add Server
  document.getElementById('addServerBtn').addEventListener('click', openAddServerModal);
  document.getElementById('addServerForm').addEventListener('submit', handleAddServer);

  // Unlock write access on the active server
  document.getElementById('unlockBtn').addEventListener('click', () => {
    const srv = activeServer();
    if (!srv) return;
    if (srv.unlocked) lockServer(srv.id);
    else openUnlockModal(srv.id);
  });
  document.getElementById('unlockForm').addEventListener('submit', handleUnlock);

  // Remove the active server from the registry
  document.getElementById('removeServerBtn').addEventListener('click', handleRemoveServer);

  // Confirm Delete
  document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const force = document.getElementById('chkForce').checked;
    const volumes = document.getElementById('chkVolumes').checked;

    closeDeleteModal();
    showToast('Tar bort container...', 'info');

    try {
      const res = await apiFetch(
        `/api/servers/${pendingDeleteServerId}/containers/${pendingDeleteId}?force=${force}&v=${volumes}`,
        { method: 'DELETE' }
      );
      if (res.success) {
        showToast(res.message, 'success');
        fetchDashboardData();
      } else {
        showToast(res.error, 'error');
      }
    } catch (err) {
      showToast('Kunde inte ta bort container.', 'error');
    }
  });
}

// Auth API Check
async function checkAuthStatus() {
  try {
    const res = await apiFetch('/api/auth/me');
    if (res && res.success) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
}

function showLogin() {
  loginSection.style.display = 'flex';
  dashboardSection.style.display = 'none';
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
}

function showDashboard() {
  loginSection.style.display = 'none';
  dashboardSection.style.display = 'block';
  fetchDashboardData();

  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    fetchDashboardData(false);
  }, 5000);
}

// Fetch System Info & Container List
async function fetchDashboardData(manual = false) {
  const refreshSpinner = document.getElementById('refreshSpinner');
  if (manual) refreshSpinner.classList.add('spinner');

  try {
    const [serversRes, containersRes] = await Promise.all([
      apiFetch('/api/servers'),
      apiFetch('/api/containers')
    ]);

    if (serversRes && serversRes.success) {
      serversData = serversRes.servers || [];
      // Fall back to the local server if the selected one has been removed.
      if (!getServer(activeServerId) && serversData.length) {
        activeServerId = serversData[0].id;
      }
      renderServerTabs();
      updateServerActionBar();
      const srv = activeServer();
      updateSystemInfoUI(srv);
      updateHostMetricsUI(srv ? srv.hostMetrics : null, srv);
    }

    if (containersRes && containersRes.success) {
      containersData = containersRes.containers || [];
      renderContainers();
    }
  } catch (err) {
    console.error('Fetch dashboard error:', err);
  } finally {
    if (manual) setTimeout(() => refreshSpinner.classList.remove('spinner'), 400);
  }
}

// The four stat cards show the ACTIVE server's host metrics.
function updateHostMetricsUI(metrics, srv) {
  const m = metrics || {};
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '--';
  };
  set('statHostCpu', m.cpuPercent);
  set('statHostGpu', m.gpuPercent);
  set('statHostRam', m.ram);
  set('statHostVram', m.vram);

  // Servers without a GPU do not get empty GPU/VRAM cards.
  const hasGpu = !!m.gpuPercent && m.gpuPercent !== '--';
  ['statHostGpu', 'statHostVram'].forEach(id => {
    const card = document.getElementById(id) && document.getElementById(id).closest('.stat-card');
    if (card) card.classList.toggle('hidden-stat', !hasGpu);
  });
}

// Update Top Info & Stat Cards for the active server
function updateSystemInfoUI(srv) {
  const data = srv && srv.info ? srv.info : null;
  const online = serversData.filter(s => s.status !== 'offline').length;

  document.getElementById('dockerVersion').textContent = data
    ? `v${data.serverVersion} (${data.os})`
    : 'Docker Engine --';

  const serverSummary = serversData.length > 1
    ? `${online}/${serversData.length} servrar · `
    : '';
  document.getElementById('hostSystemInfo').textContent = data
    ? `${serverSummary}${data.ncpu} CPUs | ${(data.memTotal / (1024 * 1024 * 1024)).toFixed(1)} GB RAM`
    : `${serverSummary}Väntar på data...`;

  const total = data ? data.containersTotal : 0;
  const running = data ? data.containersRunning : 0;
  const stopped = data ? data.containersStopped : 0;

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('statTotal', total);
  set('statRunning', running);
  set('statStopped', stopped);
  set('countAll', total);
  set('countRunning', running);
  set('countStopped', stopped);
}

// ======================= SERVER TABS =======================

const STATUS_LABEL = {
  online: 'Ansluten',
  connecting: 'Ansluter...',
  stale: 'Föråldrad data',
  offline: 'Frånkopplad'
};

function renderServerTabs() {
  const counts = {};
  containersData.forEach(c => { counts[c.serverId] = (counts[c.serverId] || 0) + 1; });

  const html = serversData.map(s => {
    const status = s.enabled ? s.status : 'disabled';
    const label = s.enabled ? (STATUS_LABEL[s.status] || s.status) : 'Avstängd';
    const seen = s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString('sv-SE') : 'aldrig';
    const locked = s.requireUnlock && !s.unlocked;
    const title = `${label}${s.type === 'agent' ? ` · Senast sedd: ${seen}` : ''}`;

    return `<button class="server-tab${s.id === activeServerId ? ' active' : ''}${s.status === 'offline' ? ' offline' : ''}"
      style="--server-color: ${escapeHtml(s.color || '#3b82f6')}"
      data-server-id="${escapeHtml(s.id)}" title="${escapeHtml(title)}">
      <span class="server-dot ${status}"></span>
      <span>${escapeHtml(s.name)}</span>
      <span class="server-tab-count">${counts[s.id] || 0}</span>
      ${locked ? '<span class="server-tab-lock" title="Skrivskyddad">🔒</span>' : ''}
    </button>`;
  }).join('');

  // String-compare so the tab row is not rebuilt on every 5s poll.
  if (serverTabs.dataset.html !== html) {
    serverTabs.dataset.html = html;
    serverTabs.innerHTML = html;
    serverTabs.querySelectorAll('.server-tab').forEach(btn => {
      btn.addEventListener('click', () => selectServer(btn.dataset.serverId));
    });
  }
}

function selectServer(id) {
  if (id === activeServerId) return;
  activeServerId = id;
  localStorage.setItem('docker_harbor_active_server', id);
  // Switching tabs is a deliberate view change, so a full rebuild is correct.
  renderServerTabs();
  updateServerActionBar();
  const srv = activeServer();
  updateSystemInfoUI(srv);
  updateHostMetricsUI(srv ? srv.hostMetrics : null, srv);
  renderContainers();
}

function updateServerActionBar() {
  const bar = document.getElementById('serverActionBar');
  const srv = activeServer();
  if (!srv) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  const status = srv.enabled ? srv.status : 'disabled';
  document.getElementById('serverActionDot').className = `server-dot ${status}`;
  document.getElementById('serverActionName').textContent = srv.name;

  const bits = [STATUS_LABEL[srv.status] || srv.status];
  if (srv.hostname) bits.push(srv.hostname);
  if (srv.agentVersion) bits.push(`agent ${srv.agentVersion}`);
  if (srv.caps && !srv.caps.allowActions) bits.push('agenten är skrivskyddad');
  document.getElementById('serverActionMeta').textContent = bits.join(' · ');

  // Lock / unlock button
  const unlockBtn = document.getElementById('unlockBtn');
  if (srv.requireUnlock) {
    unlockBtn.style.display = '';
    if (srv.unlocked) {
      const mins = Math.max(0, Math.round((srv.unlockExpires - Date.now()) / 60000));
      unlockBtn.textContent = `🔓 Lås (${mins} min kvar)`;
      unlockBtn.title = 'Lås servern igen omedelbart';
    } else {
      unlockBtn.textContent = '🔒 Lås upp skrivning';
      unlockBtn.title = 'Ange lösenord för att tillåta ändringar på denna server';
    }
  } else {
    unlockBtn.style.display = 'none';
  }

  document.getElementById('pruneBtn').disabled = !serverCanWrite(srv);
  const removeBtn = document.getElementById('removeServerBtn');
  removeBtn.style.display = srv.type === 'agent' ? '' : 'none';
}

// Render Containers
function renderContainers() {
  const srv = activeServer();
  const canWrite = serverCanWrite(srv);
  const isOffline = !!srv && srv.status === 'offline';

  // Only the active server's containers are shown -- one tab at a time.
  let filtered = containersData.filter(c => {
    if (c.serverId !== activeServerId) return false;

    // Filter by State
    if (activeFilter === 'running' && c.state !== 'running') return false;
    if (activeFilter === 'stopped' && c.state === 'running') return false;

    // Filter by Search Keyword
    if (searchKeyword) {
      const matchName = c.names.some(n => n.toLowerCase().includes(searchKeyword));
      const matchImage = c.image.toLowerCase().includes(searchKeyword);
      const matchId = c.shortId.toLowerCase().includes(searchKeyword);
      const matchPort = c.ports.some(p => p.PublicPort && p.PublicPort.toString().includes(searchKeyword));
      const matchPath = (c.configFile || c.workingDir || '').toLowerCase().includes(searchKeyword);
      const matchDesc = (c.description || '').toLowerCase().includes(searchKeyword);
      return matchName || matchImage || matchId || matchPort || matchPath || matchDesc;
    }
    return true;
  });

  emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
  containerList.classList.toggle('server-offline', isOffline);

  // A tab switch is a deliberate view change, so drop the old server's nodes
  // rather than trying to reconcile across servers.
  if (lastRenderedServerId !== activeServerId) {
    containerList.innerHTML = '';
    lastRenderedServerId = activeServerId;
  }

  // Deduplicate ports: Docker lists a separate binding per IP family
  // (0.0.0.0 and ::) for the same host port, which would otherwise render twice.
  function dedupePorts(ports) {
    const seen = new Set();
    return ports.filter(p => {
      const key = `${p.PublicPort}:${p.PrivatePort}/${p.Type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function cardInnerHtml(c) {
    const isRunning = c.state === 'running';
    const isPaused = c.state === 'paused';

    const stateClass = isRunning ? 'running' : (isPaused ? 'paused' : 'exited');
    const badgeClass = isRunning ? 'badge-success' : (isPaused ? 'badge-warning' : 'badge-danger');
    const stateText = isRunning ? 'Körs' : (isPaused ? 'Pausad' : 'Stoppad');

    // Format ports
    const portsHtml = dedupePorts(c.ports).map(p => {
      if (p.PublicPort) {
        const host = c.serverPublicHost || (c.serverId === 'local' ? window.location.hostname : null);
        if (!host) {
          return `<span class="badge port-badge" title="Ingen publik adress konfigurerad för denna server">${p.PublicPort}:${p.PrivatePort}</span>`;
        }
        const href = host.includes('://')
          ? `${host.replace(/\/$/, '')}:${p.PublicPort}`
          : `http://${host}:${p.PublicPort}`;
        return `<a href="${escapeHtml(href)}" target="_blank" class="badge port-badge">🔗 ${p.PublicPort}:${p.PrivatePort}</a>`;
      }
      return `<span class="badge" style="background: rgba(255,255,255,0.05); color: #9ca3af;">${p.PrivatePort}/${p.Type}</span>`;
    }).join(' ');

    // Compose config file or working dir path
    const displayPath = c.configFile || c.workingDir || null;
    const pathHtml = displayPath
      ? `<div class="config-path-box" onclick="copyToClipboard('${escapeHtml(displayPath)}', 'Kopierade sökväg!')" title="Klicka för att kopiera sökväg">
           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
           </svg>
           <span class="config-path-text">${escapeHtml(displayPath)}</span>
         </div>`
      : `<div class="config-path-box" style="cursor: default; opacity: 0.5;" title="Ej startad via Docker Compose">
           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
           </svg>
           <span class="config-path-text">Fristående container (Ingen compose-sökväg)</span>
         </div>`;

    // Container description box (with edit trigger)
    const descHtml = c.description
      ? `<div class="container-description-box" onclick="openDescModal('${c.serverId}', '${c.id}')" title="Klicka för att redigera infotext">
           <div class="desc-content">
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
             </svg>
             <span>${escapeHtml(c.description)}</span>
           </div>
           <svg class="edit-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
           </svg>
         </div>`
      : `<div class="container-description-box empty-desc" onclick="openDescModal('${c.serverId}', '${c.id}')" title="Klicka för att lägga till infotext">
           <div class="desc-content">
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
             </svg>
             <span>+ Lägg till infotext</span>
           </div>
         </div>`;

    // Restart Policy dropdown
    const currentPolicy = c.restartPolicy || 'no';

    const metrics = c.metrics || { cpuPercent: '--', memory: '--', netIo: '--' };

    const metricsHtml = `
      <div class="metrics-bar">
        <div class="metric-badge" title="CPU-belastning">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span>CPU: <strong>${metrics.cpuPercent}</strong></span>
        </div>
        <div class="metric-badge" title="Minnesanvändning (RAM)">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>
          <span>Mem: <strong>${metrics.memory}</strong></span>
        </div>
        <div class="metric-badge" title="Nätverk I/O (Mottaget / Skickat)">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <span>Net: <strong>${metrics.netIo}</strong></span>
        </div>
      </div>
    `;

    return `
        <div>
          <div class="card-header-top">
            <div class="container-name-box">
              <span class="status-dot ${stateClass}"></span>
              <span class="container-title" title="${c.names[0]}">${c.names[0]}</span>
            </div>
            <span class="container-id" onclick="copyToClipboard('${c.id}', 'Kopierade container-ID!')" title="Klicka för att kopiera ID">${c.shortId}</span>
          </div>

          ${metricsHtml}

          ${descHtml}
          ${pathHtml}

          <div class="details-row">
            <span class="badge ${badgeClass}">${stateText}</span>
            <span class="badge" style="background: rgba(255,255,255,0.04); color: var(--text-muted);">${escapeHtml(c.status)}</span>
            ${canWrite ? '' : '<span class="readonly-badge">🔒 Skrivskyddad</span>'}
            ${portsHtml}
          </div>

          <div class="restart-policy-box">
            <label>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Restart:
            </label>
            <select class="restart-select" ${canWrite ? '' : 'disabled'} onchange="updateRestartPolicy('${c.serverId}', '${c.id}', this.value)">
              <option value="always" ${currentPolicy === 'always' ? 'selected' : ''}>always (alltid)</option>
              <option value="unless-stopped" ${currentPolicy === 'unless-stopped' ? 'selected' : ''}>unless-stopped</option>
              <option value="on-failure" ${currentPolicy === 'on-failure' ? 'selected' : ''}>on-failure (vid fel)</option>
              <option value="no" ${currentPolicy === 'no' ? 'selected' : ''}>no (nej)</option>
            </select>
          </div>
        </div>

        <div class="card-actions">
          <button class="action-btn start" ${isRunning || !canWrite ? 'disabled' : ''} onclick="startContainer('${c.serverId}', '${c.id}')" title="Starta Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /></svg>
            Starta
          </button>

          <button class="action-btn stop" ${!isRunning || !canWrite ? 'disabled' : ''} onclick="stopContainer('${c.serverId}', '${c.id}')" title="Stoppa Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" /></svg>
            Stoppa
          </button>

          <button class="action-btn restart" ${canWrite ? '' : 'disabled'} onclick="restartContainer('${c.serverId}', '${c.id}')" title="Starta Om Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Omstart
          </button>

          <button class="action-btn rebuild" ${canWrite ? '' : 'disabled'} onclick="rebuildContainer('${c.serverId}', '${c.id}')" title="Bygg Om / Re-create Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L5.6 15.12a2 2 0 00-1.18.118l-.5.25a2 2 0 00-.92 2.21l.5 2a2 2 0 001.94 1.51h13.12a2 2 0 001.94-1.51l.5-2a2 2 0 00-.92-2.21l-.5-.25z" /></svg>
            Bygg Om
          </button>

          <button class="action-btn logs" onclick="openLogsModal('${c.serverId}', '${c.id}')" title="Visa Live Loggar">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            Loggar
          </button>

          <button class="action-btn file-compose" ${!c.hasCompose ? 'disabled' : ''} onclick="openCodeFileModal('${c.serverId}', '${c.id}', 'compose')" title="Öppna docker-compose.yml">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Compose
          </button>

          <button class="action-btn file-dockerfile" ${!c.hasDockerfile ? 'disabled' : ''} onclick="openCodeFileModal('${c.serverId}', '${c.id}', 'dockerfile')" title="Öppna Dockerfile">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
            Dockerfile
          </button>

          <button class="action-btn logs" onclick="inspectContainer('${c.serverId}', '${c.id}')" title="Inspektera Container Configuration">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Info
          </button>

          <button class="action-btn delete" ${canWrite ? '' : 'disabled'} onclick="openDeleteModal('${c.serverId}', '${c.id}')" title="Ta Bort Container" style="grid-column: span 2;">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Ta Bort
          </button>
        </div>
    `;
  }

  // Reconcile: reuse existing card DOM nodes and update innerHTML ONLY if changed
  const existingCards = new Map();
  containerList.querySelectorAll('.container-card').forEach(el => existingCards.set(el.dataset.key, el));

  const usedIds = new Set();
  filtered.forEach(c => {
    // Container IDs are unique per daemon but not across servers.
    const key = `${c.serverId}:${c.id}`;
    usedIds.add(key);
    const innerHtml = cardInnerHtml(c);
    let el = existingCards.get(key);

    if (!el) {
      el = document.createElement('div');
      el.className = 'container-card glass-panel fade-in';
      el.dataset.key = key;
      el.dataset.id = c.id;
      el.dataset.innerHtml = innerHtml;
      el.innerHTML = innerHtml;
      containerList.appendChild(el);
      setTimeout(() => el.classList.remove('fade-in'), 400);
    } else {
      if (el.dataset.innerHtml !== innerHtml) {
        el.dataset.innerHtml = innerHtml;
        el.innerHTML = innerHtml;
      }
      containerList.appendChild(el);
    }
  });

  existingCards.forEach((el, key) => {
    if (!usedIds.has(key)) el.remove();
  });
}

// Container Operations -- every one is scoped to a server.
async function runContainerAction(serverId, id, action, pendingMessage) {
  showToast(pendingMessage, 'info');
  try {
    const res = await apiFetch(`/api/servers/${serverId}/containers/${id}/${action}`, { method: 'POST' });
    if (res.success) {
      showToast(res.message, 'success');
      fetchDashboardData();
    } else {
      showToast(res.error, 'error');
      // A 423 means the unlock expired mid-session; refresh so the UI relocks.
      if (res.locked) fetchDashboardData();
    }
  } catch (err) {
    showToast('Åtgärden misslyckades: ' + err.message, 'error');
  }
}

function startContainer(serverId, id) {
  return runContainerAction(serverId, id, 'start', 'Startar container...');
}

function stopContainer(serverId, id) {
  return runContainerAction(serverId, id, 'stop', 'Stoppar container (10s timeout)...');
}

function restartContainer(serverId, id) {
  return runContainerAction(serverId, id, 'restart', 'Startar om container...');
}

function getContainer(serverId, id) {
  return containersData.find(x => x.id === id && x.serverId === serverId) || null;
}

function getContainerName(serverId, id) {
  const c = getContainer(serverId, id);
  return (c && c.names && c.names[0]) ? c.names[0] : id.substring(0, 12);
}

async function rebuildContainer(serverId, id) {
  const name = getContainerName(serverId, id);
  if (!confirm(`Vill du bygga om och skapa om container "${name}"? Det hämtar nyaste imagen och bevarar befintlig konfiguration.`)) return;
  return runContainerAction(serverId, id, 'rebuild', `Bygger om container ${name}... Det kan ta några sekunder.`);
}

async function inspectContainer(serverId, id) {
  const name = getContainerName(serverId, id);
  document.getElementById('inspectContainerTitle').textContent = name;
  document.getElementById('inspectContent').textContent = 'Hämtar data...';
  document.getElementById('inspectModal').classList.add('active');

  const res = await apiFetch(`/api/servers/${serverId}/containers/${id}`);
  if (res && res.success) {
    document.getElementById('inspectContent').textContent = JSON.stringify(res.data, null, 2);
  } else {
    document.getElementById('inspectContent').textContent = 'Fel vid hämtning av container-data: ' + (res.error || '');
  }
}

function closeInspectModal() {
  document.getElementById('inspectModal').classList.remove('active');
}

// Log Stream Modal (WebSocket)
function openLogsModal(serverId, id) {
  const name = getContainerName(serverId, id);
  const srv = getServer(serverId);
  document.getElementById('logContainerTitle').textContent =
    srv && srv.type === 'agent' ? `${name} @ ${srv.name}` : name;
  const output = document.getElementById('terminalLogOutput');
  output.textContent = 'Kopplar upp live-loggström...\n';
  document.getElementById('logModal').classList.add('active');

  if (activeWs) activeWs.close();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/logs` +
    `?serverId=${encodeURIComponent(serverId)}&containerId=${encodeURIComponent(id)}&token=${currentToken}`;

  activeWs = new WebSocket(wsUrl);

  activeWs.onopen = () => {
    output.textContent += ' Ansluten till loggström.\n---\n';
  };

  activeWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'log') {
        output.textContent += msg.data;
        output.scrollTop = output.scrollHeight;
      } else if (msg.type === 'error') {
        output.textContent += `\n[FEL]: ${msg.message}\n`;
      } else if (msg.type === 'end') {
        output.textContent += `\n[INFO]: ${msg.message}\n`;
      }
    } catch (e) {
      output.textContent += event.data;
    }
  };

  activeWs.onerror = (err) => {
    output.textContent += '\n[FEL]: WebSocket-anslutningsfel.\n';
  };

  activeWs.onclose = () => {
    output.textContent += '\n--- Loggström avslutad ---\n';
  };
}

function closeLogModal() {
  document.getElementById('logModal').classList.remove('active');
  if (activeWs) {
    activeWs.close();
    activeWs = null;
  }
}

// Delete Modal
function openDeleteModal(serverId, id) {
  const name = getContainerName(serverId, id);
  pendingDeleteId = id;
  pendingDeleteServerId = serverId;
  document.getElementById('deleteTargetName').textContent = name;
  document.getElementById('chkForce').checked = false;
  document.getElementById('chkVolumes').checked = false;
  document.getElementById('deleteModal').classList.add('active');
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active');
  pendingDeleteId = null;
  pendingDeleteServerId = null;
}

// Helper: API Fetch wrapper
async function apiFetch(url, options = {}) {
  const headers = options.headers || {};
  if (currentToken) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }
  options.headers = headers;

  const response = await fetch(url, options);

  if (response.status === 401) {
    localStorage.removeItem('docker_harbor_jwt');
    currentToken = '';
    showLogin();
    throw new Error('Sessionen har gått ut.');
  }

  return response.json();
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Update Container Restart Policy
async function updateRestartPolicy(serverId, id, policy) {
  showToast(`Uppdaterar restart policy till '${policy}'...`, 'info');
  try {
    const res = await apiFetch(`/api/servers/${serverId}/containers/${id}/restart-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restartPolicy: policy })
    });
    if (res && res.success) {
      showToast(res.message, 'success');
      fetchDashboardData(false);
    } else {
      showToast((res && res.error) || 'Kunde inte uppdatera restart policy.', 'error');
      fetchDashboardData(false);
    }
  } catch (err) {
    showToast('Fel vid uppdatering av restart policy: ' + err.message, 'error');
    fetchDashboardData(false);
  }
}

// Copy to Clipboard
function copyToClipboard(text, label = 'Kopierade till urklipp!') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(label, 'info');
  }).catch(() => {
    showToast('Kunde inte kopiera.', 'error');
  });
}

// Description Modal Handlers
let pendingDescId = null;
let pendingDescServerId = null;

function openDescModal(serverId, id) {
  const c = getContainer(serverId, id);
  const name = getContainerName(serverId, id);
  const currentDesc = c ? (c.description || '') : '';

  pendingDescId = id;
  pendingDescServerId = serverId;
  document.getElementById('descContainerName').textContent = name;
  document.getElementById('descInputText').value = currentDesc;
  document.getElementById('descModal').classList.add('active');
  setTimeout(() => document.getElementById('descInputText').focus(), 100);
}

function closeDescModal() {
  document.getElementById('descModal').classList.remove('active');
  pendingDescId = null;
  pendingDescServerId = null;
}

function clearDescription() {
  document.getElementById('descInputText').value = '';
}

async function handleSaveDescription(e) {
  if (e) e.preventDefault();
  if (!pendingDescId) return;

  const text = document.getElementById('descInputText').value.trim();
  const saveBtn = document.getElementById('saveDescBtn');
  saveBtn.disabled = true;

  try {
    const res = await apiFetch(`/api/servers/${pendingDescServerId}/containers/${pendingDescId}/description`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: text })
    });

    if (res && res.success) {
      showToast(res.message || 'Infotext sparades!', 'success');
      closeDescModal();
      fetchDashboardData(false);
    } else {
      showToast((res && res.error) || 'Kunde inte spara infotext.', 'error');
    }
  } catch (err) {
    showToast('Fel vid sparande: ' + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

// Code / File Viewer Modal Handlers
let currentCodeFileText = '';

async function openCodeFileModal(serverId, id, type) {
  const name = getContainerName(serverId, id);
  const titleText = type === 'compose' ? `docker-compose.yml för ${name}` : `Dockerfile för ${name}`;

  document.getElementById('codeFileTitle').textContent = titleText;
  document.getElementById('codeFilePath').textContent = 'Hämtar fil...';
  document.getElementById('codeFileContent').textContent = 'Läser filinnehåll...';
  document.getElementById('codeFileModal').classList.add('active');

  try {
    const res = await apiFetch(`/api/servers/${serverId}/containers/${id}/file?type=${type}`);
    if (res && res.success) {
      currentCodeFileText = res.content || '';
      document.getElementById('codeFilePath').textContent = res.filePath || res.fileName;
      document.getElementById('codeFileContent').textContent = currentCodeFileText;
    } else {
      currentCodeFileText = '';
      document.getElementById('codeFilePath').textContent = 'Ej hittad';
      document.getElementById('codeFileContent').textContent = (res && res.error) || 'Kunde inte läsa filen.';
    }
  } catch (err) {
    currentCodeFileText = '';
    document.getElementById('codeFilePath').textContent = 'Fel vid hämtning';
    document.getElementById('codeFileContent').textContent = 'Fel: ' + err.message;
  }
}

function closeCodeFileModal() {
  document.getElementById('codeFileModal').classList.remove('active');
  currentCodeFileText = '';
}

function copyCodeFileContent() {
  if (!currentCodeFileText) return;
  navigator.clipboard.writeText(currentCodeFileText).then(() => {
    showToast('Kopierade filinnehållet till urklipp!', 'info');
  }).catch(() => {
    showToast('Kunde inte kopiera.', 'error');
  });
}

// Helper: Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

// ======================= WRITE UNLOCK =======================

function openUnlockModal(serverId) {
  const srv = getServer(serverId);
  if (!srv) return;
  pendingUnlockServerId = serverId;
  document.getElementById('unlockServerName').textContent = srv.name;
  document.getElementById('unlockPassword').value = '';
  document.getElementById('unlockModal').classList.add('active');
  setTimeout(() => document.getElementById('unlockPassword').focus(), 100);
}

function closeUnlockModal() {
  document.getElementById('unlockModal').classList.remove('active');
  pendingUnlockServerId = null;
}

async function handleUnlock(e) {
  e.preventDefault();
  if (!pendingUnlockServerId) return;

  const btn = document.getElementById('unlockSubmitBtn');
  const password = document.getElementById('unlockPassword').value;
  btn.disabled = true;

  try {
    const res = await apiFetch(`/api/servers/${pendingUnlockServerId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res && res.success) {
      showToast(res.message, 'success');
      closeUnlockModal();
      fetchDashboardData();
    } else {
      showToast((res && res.error) || 'Kunde inte låsa upp.', 'error');
    }
  } catch (err) {
    showToast('Fel vid upplåsning: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function lockServer(serverId) {
  try {
    const res = await apiFetch(`/api/servers/${serverId}/lock`, { method: 'POST' });
    if (res && res.success) showToast(res.message, 'info');
    fetchDashboardData();
  } catch (err) {
    showToast('Kunde inte låsa servern.', 'error');
  }
}

// ======================= ADD / REMOVE SERVER =======================

let currentInstallCommand = '';

function openAddServerModal() {
  document.getElementById('addServerStep1').style.display = '';
  document.getElementById('addServerStep2').style.display = 'none';
  document.getElementById('addServerSubmitBtn').style.display = '';
  document.getElementById('addServerSubmitBtn').disabled = false;
  document.getElementById('newServerId').value = '';
  document.getElementById('newServerName').value = '';
  document.getElementById('newServerHost').value = '';
  currentInstallCommand = '';
  document.getElementById('addServerModal').classList.add('active');
  setTimeout(() => document.getElementById('newServerId').focus(), 100);
}

function closeAddServerModal() {
  document.getElementById('addServerModal').classList.remove('active');
  fetchDashboardData();
}

async function handleAddServer(e) {
  e.preventDefault();
  const btn = document.getElementById('addServerSubmitBtn');
  const id = document.getElementById('newServerId').value.trim();
  const name = document.getElementById('newServerName').value.trim();
  const publicHost = document.getElementById('newServerHost').value.trim();
  const color = document.getElementById('newServerColor').value;

  btn.disabled = true;
  try {
    const res = await apiFetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: name || id, publicHost: publicHost || null, color })
    });

    if (res && res.success) {
      showToast(res.message, 'success');
      currentInstallCommand = res.install.command;
      document.getElementById('installTargetName').textContent = res.server.name;
      document.getElementById('installCommand').textContent = currentInstallCommand;
      document.getElementById('addServerStep1').style.display = 'none';
      document.getElementById('addServerStep2').style.display = '';
      btn.style.display = 'none';
      fetchDashboardData();
    } else {
      showToast((res && res.error) || 'Kunde inte lägga till servern.', 'error');
      btn.disabled = false;
    }
  } catch (err) {
    showToast('Fel: ' + err.message, 'error');
    btn.disabled = false;
  }
}

function copyInstallCommand() {
  copyToClipboard(currentInstallCommand, 'Kopierade installationskommandot!');
}

async function handleRemoveServer() {
  const srv = activeServer();
  if (!srv || srv.type !== 'agent') return;
  if (!confirm(`Vill du ta bort servern "${srv.name}" från Docker Harbor?\n\n` +
               'Containers på servern påverkas inte, men agenten kommer inte längre kunna ansluta. ' +
               'Kom ihåg att stoppa agenten på servern själv.')) return;

  try {
    const res = await apiFetch(`/api/servers/${srv.id}`, { method: 'DELETE' });
    if (res && res.success) {
      showToast(res.message, 'success');
      activeServerId = 'local';
      localStorage.setItem('docker_harbor_active_server', 'local');
      lastRenderedServerId = null;
      fetchDashboardData();
    } else {
      showToast((res && res.error) || 'Kunde inte ta bort servern.', 'error');
    }
  } catch (err) {
    showToast('Fel: ' + err.message, 'error');
  }
}
