// Docker Harbor Client Application Script

let containersData = [];
let activeFilter = 'all';
let searchKeyword = '';
let currentToken = localStorage.getItem('docker_harbor_jwt') || '';
let autoRefreshTimer = null;
let activeWs = null;
let pendingDeleteId = null;
let lastContainersSignature = null;

// DOM Elements
const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginForm = document.getElementById('loginForm');
const containerList = document.getElementById('containerList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');

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

  // Prune Button
  document.getElementById('pruneBtn').addEventListener('click', async () => {
    if (!confirm('Vill du rensa bort alla stoppade containers och oanvända Docker-bilder?')) return;
    showToast('Rensar Docker-systemet...', 'info');
    try {
      const res = await apiFetch('/api/system/prune', { method: 'POST' });
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

  // Confirm Delete
  document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const force = document.getElementById('chkForce').checked;
    const volumes = document.getElementById('chkVolumes').checked;

    closeDeleteModal();
    showToast('Tar bort container...', 'info');

    try {
      const res = await apiFetch(`/api/containers/${pendingDeleteId}?force=${force}&v=${volumes}`, { method: 'DELETE' });
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
    const [sysRes, containersRes] = await Promise.all([
      apiFetch('/api/system/info'),
      apiFetch('/api/containers')
    ]);

    if (sysRes && sysRes.success) {
      updateSystemInfoUI(sysRes.data);
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

// Update Top Info & Stat Cards
function updateSystemInfoUI(data) {
  document.getElementById('dockerVersion').textContent = `v${data.serverVersion} (${data.os})`;
  document.getElementById('hostSystemInfo').textContent = `${data.ncpu} CPUs | ${(data.memTotal / (1024 * 1024 * 1024)).toFixed(1)} GB RAM`;

  document.getElementById('statTotal').textContent = data.containersTotal;
  document.getElementById('statRunning').textContent = data.containersRunning;
  document.getElementById('statStopped').textContent = data.containersStopped;
  document.getElementById('statImages').textContent = data.imagesTotal;

  document.getElementById('countAll').textContent = data.containersTotal;
  document.getElementById('countRunning').textContent = data.containersRunning;
  document.getElementById('countStopped').textContent = data.containersStopped;
}

// Render Containers
function renderContainers() {
  let filtered = containersData.filter(c => {
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

  if (filtered.length === 0) {
    containerList.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

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
        const host = window.location.hostname;
        return `<a href="http://${host}:${p.PublicPort}" target="_blank" class="badge port-badge">🔗 ${p.PublicPort}:${p.PrivatePort}</a>`;
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
      ? `<div class="container-description-box" onclick="openDescModal('${c.id}')" title="Klicka för att redigera infotext">
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
      : `<div class="container-description-box empty-desc" onclick="openDescModal('${c.id}')" title="Klicka för att lägga till infotext">
           <div class="desc-content">
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
             </svg>
             <span>+ Lägg till infotext</span>
           </div>
         </div>`;

    // Restart Policy dropdown
    const currentPolicy = c.restartPolicy || 'no';

    return `
        <div>
          <div class="card-header-top">
            <div class="container-name-box">
              <span class="status-dot ${stateClass}"></span>
              <span class="container-title" title="${c.names[0]}">${c.names[0]}</span>
            </div>
            <span class="container-id" onclick="copyToClipboard('${c.id}', 'Kopierade container-ID!')" title="Klicka för att kopiera ID">${c.shortId}</span>
          </div>

          <div class="image-tag">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            ${escapeHtml(c.image)}
          </div>

          ${descHtml}
          ${pathHtml}

          <div class="details-row">
            <span class="badge ${badgeClass}">${stateText}</span>
            <span class="badge" style="background: rgba(255,255,255,0.04); color: var(--text-muted);">${escapeHtml(c.status)}</span>
            ${portsHtml}
          </div>

          <div class="restart-policy-box">
            <label>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Restart:
            </label>
            <select class="restart-select" onchange="updateRestartPolicy('${c.id}', this.value)">
              <option value="always" ${currentPolicy === 'always' ? 'selected' : ''}>always (alltid)</option>
              <option value="unless-stopped" ${currentPolicy === 'unless-stopped' ? 'selected' : ''}>unless-stopped</option>
              <option value="on-failure" ${currentPolicy === 'on-failure' ? 'selected' : ''}>on-failure (vid fel)</option>
              <option value="no" ${currentPolicy === 'no' ? 'selected' : ''}>no (nej)</option>
            </select>
          </div>
        </div>

        <div class="card-actions">
          <button class="action-btn start" ${isRunning ? 'disabled' : ''} onclick="startContainer('${c.id}')" title="Starta Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /></svg>
            Starta
          </button>

          <button class="action-btn stop" ${!isRunning ? 'disabled' : ''} onclick="stopContainer('${c.id}')" title="Stoppa Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" /></svg>
            Stoppa
          </button>

          <button class="action-btn restart" onclick="restartContainer('${c.id}')" title="Starta Om Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Omstart
          </button>

          <button class="action-btn rebuild" onclick="rebuildContainer('${c.id}')" title="Bygg Om / Re-create Container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L5.6 15.12a2 2 0 00-1.18.118l-.5.25a2 2 0 00-.92 2.21l.5 2a2 2 0 001.94 1.51h13.12a2 2 0 001.94-1.51l.5-2a2 2 0 00-.92-2.21l-.5-.25z" /></svg>
            Bygg Om
          </button>

          <button class="action-btn logs" onclick="openLogsModal('${c.id}')" title="Visa Live Loggar">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            Loggar
          </button>

          <button class="action-btn file-compose" ${!c.hasCompose ? 'disabled' : ''} onclick="openCodeFileModal('${c.id}', 'compose')" title="Öppna docker-compose.yml">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Compose
          </button>

          <button class="action-btn file-dockerfile" ${!c.hasDockerfile ? 'disabled' : ''} onclick="openCodeFileModal('${c.id}', 'dockerfile')" title="Öppna Dockerfile">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
            Dockerfile
          </button>

          <button class="action-btn logs" onclick="inspectContainer('${c.id}')" title="Inspektera Container Configuration">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Info
          </button>

          <button class="action-btn delete" onclick="openDeleteModal('${c.id}')" title="Ta Bort Container" style="grid-column: span 2;">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Ta Bort
          </button>
        </div>
    `;
  }

  // Reconcile: reuse existing card DOM nodes and update innerHTML ONLY if changed
  const existingCards = new Map();
  containerList.querySelectorAll('.container-card').forEach(el => existingCards.set(el.dataset.id, el));

  const usedIds = new Set();
  filtered.forEach(c => {
    usedIds.add(c.id);
    const innerHtml = cardInnerHtml(c);
    let el = existingCards.get(c.id);

    if (!el) {
      el = document.createElement('div');
      el.className = 'container-card glass-panel fade-in';
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

  existingCards.forEach((el, id) => {
    if (!usedIds.has(id)) el.remove();
  });
}

// Container Operations
async function startContainer(id) {
  showToast('Startar container...', 'info');
  const res = await apiFetch(`/api/containers/${id}/start`, { method: 'POST' });
  if (res.success) {
    showToast(res.message, 'success');
    fetchDashboardData();
  } else {
    showToast(res.error, 'error');
  }
}

async function stopContainer(id) {
  showToast('Stoppar container (10s timeout)...', 'info');
  const res = await apiFetch(`/api/containers/${id}/stop`, { method: 'POST' });
  if (res.success) {
    showToast(res.message, 'success');
    fetchDashboardData();
  } else {
    showToast(res.error, 'error');
  }
}

async function restartContainer(id) {
  showToast('Startar om container...', 'info');
  const res = await apiFetch(`/api/containers/${id}/restart`, { method: 'POST' });
  if (res.success) {
    showToast(res.message, 'success');
    fetchDashboardData();
  } else {
    showToast(res.error, 'error');
  }
}

function getContainerName(id) {
  const c = containersData.find(x => x.id === id);
  return (c && c.names && c.names[0]) ? c.names[0] : id.substring(0, 12);
}

async function rebuildContainer(id) {
  const name = getContainerName(id);
  if (!confirm(`Vill du bygga om och skapa om container "${name}"? Det hämtar nyaste imagen och bevarar befintlig konfiguration.`)) return;

  showToast(`Bygger om container ${name}... Det kan ta några sekunder.`, 'info');
  const res = await apiFetch(`/api/containers/${id}/rebuild`, { method: 'POST' });
  if (res.success) {
    showToast(res.message, 'success');
    fetchDashboardData();
  } else {
    showToast(res.error, 'error');
  }
}

async function inspectContainer(id) {
  const name = getContainerName(id);
  document.getElementById('inspectContainerTitle').textContent = name;
  document.getElementById('inspectContent').textContent = 'Hämtar data...';
  document.getElementById('inspectModal').classList.add('active');

  const res = await apiFetch(`/api/containers/${id}`);
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
function openLogsModal(id) {
  const name = getContainerName(id);
  document.getElementById('logContainerTitle').textContent = name;
  const output = document.getElementById('terminalLogOutput');
  output.textContent = 'Kopplar upp live-loggström...\n';
  document.getElementById('logModal').classList.add('active');

  if (activeWs) activeWs.close();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/logs?containerId=${id}&token=${currentToken}`;

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
function openDeleteModal(id) {
  const name = getContainerName(id);
  pendingDeleteId = id;
  document.getElementById('deleteTargetName').textContent = name;
  document.getElementById('chkForce').checked = false;
  document.getElementById('chkVolumes').checked = false;
  document.getElementById('deleteModal').classList.add('active');
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.remove('active');
  pendingDeleteId = null;
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
async function updateRestartPolicy(id, policy) {
  showToast(`Uppdaterar restart policy till '${policy}'...`, 'info');
  try {
    const res = await apiFetch(`/api/containers/${id}/restart-policy`, {
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

function openDescModal(id) {
  const c = containersData.find(x => x.id === id);
  const name = getContainerName(id);
  const currentDesc = c ? (c.description || '') : '';

  pendingDescId = id;
  document.getElementById('descContainerName').textContent = name;
  document.getElementById('descInputText').value = currentDesc;
  document.getElementById('descModal').classList.add('active');
  setTimeout(() => document.getElementById('descInputText').focus(), 100);
}

function closeDescModal() {
  document.getElementById('descModal').classList.remove('active');
  pendingDescId = null;
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
    const res = await apiFetch(`/api/containers/${pendingDescId}/description`, {
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

async function openCodeFileModal(id, type) {
  const name = getContainerName(id);
  const titleText = type === 'compose' ? `docker-compose.yml för ${name}` : `Dockerfile för ${name}`;

  document.getElementById('codeFileTitle').textContent = titleText;
  document.getElementById('codeFilePath').textContent = 'Hämtar fil...';
  document.getElementById('codeFileContent').textContent = 'Läser filinnehåll...';
  document.getElementById('codeFileModal').classList.add('active');

  try {
    const res = await apiFetch(`/api/containers/${id}/file?type=${type}`);
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
