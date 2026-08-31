'use strict';

// Generates the shell script served at GET /install/:code.
// The script carries only a short-lived, single-use enrollment code -- never
// the permanent token. The agent trades the code for a token on first connect
// and persists that token in its own volume.

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildInstallScript({ hubWsUrl, hubHttpUrl, serverId, enrollCode, agentImage, expires }) {
  const expiresAt = new Date(expires).toISOString();
  return `#!/bin/sh
# ============================================================================
#  Docker Harbor - agentinstallation
#  Server-ID : ${serverId}
#  Hub       : ${hubWsUrl}
#  Koden i detta skript ar engangs och gar ut ${expiresAt}
# ============================================================================
set -eu

INSTALL_DIR="\${HARBOR_INSTALL_DIR:-/opt/harbor-agent}"

# Installationen skriver till /opt och pratar med Docker. Kolla det direkt i
# stallet for att falla pa "Permission denied" halvvags igenom.
if [ -d "$INSTALL_DIR" ]; then NEED_W="$INSTALL_DIR"; else NEED_W="$(dirname "$INSTALL_DIR")"; fi
if [ ! -w "$NEED_W" ]; then
  echo "FEL: kan inte skriva till $NEED_W." >&2
  echo "     Kor kommandot med sudo:" >&2
  echo "     curl -fsSL ${hubHttpUrl}/install/${enrollCode} | sudo sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "FEL: docker hittades inte pa denna server." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "FEL: varken 'docker compose' eller 'docker-compose' hittades." >&2
  exit 1
fi

echo "==> Installerar Docker Harbor-agent i \$INSTALL_DIR"
mkdir -p "\$INSTALL_DIR"
cd "\$INSTALL_DIR"

# ---- Projektkataloger ------------------------------------------------------
# Docker-motorn talar om VAR compose-filen ligger, men det finns inget API for
# att LASA en fil fran vardens filsystem. Darfor maste katalogerna monteras in
# har, pa exakt samma sokvag, sa att sokvagen i labeln stammer inuti containern.
# Vi harleder dem ur labels pa de containers som redan finns pa den har servern.
PROJECT_MOUNTS=""

detect_project_roots() {
  ids=$(docker ps -aq 2>/dev/null) || return 0
  [ -n "$ids" ] || return 0
  docker inspect $ids \
      --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
      2>/dev/null </dev/null \
    | tr ',' '\n' \
    | while read -r f; do
        [ -n "$f" ] || continue
        d=$(dirname "$f")
        case "$d" in
          "$HOME"/*) printf '%s/%s\n' "$HOME" "$(printf '%s' "\${d#"$HOME"/}" | cut -d/ -f1)" ;;
          /*)        printf '/%s\n' "$(printf '%s' "\${d#/}" | cut -d/ -f1)" ;;
        esac
      done \
    | sort -u
}

if [ "\${HARBOR_ALLOW_FILE_READ:-true}" = "false" ]; then
  echo "==> Fillasning avstangd, hoppar over projektkataloger"
else
  for d in $(detect_project_roots); do
    case "$d" in
      /|/home|/root|/usr|/etc|/var) continue ;;
    esac
    [ -d "$d" ] || continue
    echo "==> Monterar projektkatalog: $d"
    PROJECT_MOUNTS="\${PROJECT_MOUNTS}
      - \${d}:\${d}"
  done
  if [ -z "$PROJECT_MOUNTS" ]; then
    echo "==> Inga compose-kataloger hittades, compose-visning blir otillganglig"
  fi
fi

# ---- Agent-imagen ----------------------------------------------------------
# Imagen finns inte pa Docker Hub. Hubben serverar den sjalv, sa fjarrservern
# behover varken register, SSH eller att bygga den for hand.
if docker image inspect ${agentImage} >/dev/null 2>&1; then
  echo "==> Agent-imagen finns redan lokalt"
else
  echo "==> Hamtar agent-imagen fran hubben..."
  if curl -fsSL "${hubHttpUrl}/install/${enrollCode}/image" | docker load; then
    echo "==> Agent-imagen inlast"
  else
    echo "FEL: kunde inte hamta agent-imagen fran hubben." >&2
    echo "     Bygg den pa hubben med:" >&2
    echo "       docker build -f agent/Dockerfile -t ${agentImage} ." >&2
    echo "     eller bygg den har:" >&2
    echo "       git clone https://github.com/walker42195/docker-harbor.git" >&2
    echo "       cd docker-harbor && docker build -f agent/Dockerfile -t ${agentImage} ." >&2
    exit 1
  fi
fi

# ---- NVIDIA-detektering ----------------------------------------------------
# Kravet ar tva saker: ett fungerande grafikkort PLUS nvidia-container-toolkit,
# som skickar in kortet i containern. Toolkit:en injicerar sjalv nvidia-smi och
# drivrutinsbiblioteken -- de ska INTE bind-monteras for hand, eftersom
# sokvagarna skiljer sig mellan distributioner och manuella mount:ar skuggar
# de riktiga.
GPU_BLOCK=""

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  echo "==> NVIDIA GPU upptackt: \${GPU_NAME:-okand}"

  if command -v nvidia-ctk >/dev/null 2>&1 \
     || command -v nvidia-container-runtime >/dev/null 2>&1 \
     || docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null | grep -q nvidia; then
    echo "==> Verifierar att GPU:n kan skickas in i en container..."
    if timeout 120 docker run --rm --gpus all \
         -e NVIDIA_DRIVER_CAPABILITIES=utility \
         ${agentImage} nvidia-smi -L >/dev/null 2>&1; then
      echo "==> GPU fungerar i containers, GPU- och VRAM-matning aktiveras"
      GPU_BLOCK="    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, utility]"
    else
      echo "==> VARNING: GPU:n kunde inte skickas in i en container."
      echo "    Kontrollera nvidia-container-toolkit. GPU-matning hoppas over."
    fi
  else
    echo "==> VARNING: nvidia-container-toolkit saknas, GPU-matning hoppas over."
  fi
else
  echo "==> Ingen NVIDIA GPU hittades, GPU-korten doljs for denna server"
fi

cat > .env <<ENVEOF
HARBOR_HUB_URL=${hubWsUrl}
HARBOR_SERVER_ID=${serverId}
HARBOR_ENROLL_CODE=${enrollCode}
HARBOR_SNAPSHOT_INTERVAL_MS=5000
# Skrivskyddat som standard. Satt till false for att tillata start/stopp/
# omstart/rebuild/radering fran hubben.
HARBOR_READ_ONLY=true
HARBOR_ALLOW_FILE_READ=true
HARBOR_ALLOW_FILE_WRITE=false
ENVEOF
chmod 600 .env

cat > docker-compose.yml <<COMPOSEEOF
services:
  harbor-agent:
    image: ${agentImage}
    # Imagen laddas in lokalt av installationsskriptet -- pulla aldrig.
    pull_policy: never
    container_name: harbor-agent
    restart: unless-stopped
    # Inga ports: agenten ansluter utat och lyssnar aldrig sjalv.
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # Persistent volym for den permanenta token.
      - harbor-agent-data:/data\${PROJECT_MOUNTS}
    env_file:
      - .env
\${GPU_BLOCK}
    labels:
      description: "Harbor-agent som rapporterar containers till centrala Docker Harbor."

volumes:
  harbor-agent-data:
COMPOSEEOF

echo "==> Startar agenten"
\$COMPOSE up -d

echo ""
echo "Klart. Servern '${serverId}' bor dyka upp i Docker Harbor inom nagra sekunder."
echo "Folj loggen med:  cd \$INSTALL_DIR && \$COMPOSE logs -f harbor-agent"
echo ""
echo "Agenten ar skrivskyddad. For att tillata atgarder: satt HARBOR_READ_ONLY=false"
echo "i \$INSTALL_DIR/.env och kor '\$COMPOSE up -d'."
`;
}

// Derive the wss:// URL an agent should dial, from the request that created it.
function deriveHubWsUrl(req, override) {
  if (override) return override;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
                (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const scheme = proto === 'https' ? 'wss' : 'ws';
  return `${scheme}://${host}/ws/agent`;
}

module.exports = { buildInstallScript, deriveHubWsUrl, shQuote };
