'use strict';

// Generates the shell script served at GET /install/:code.
// The script carries only a short-lived, single-use enrollment code -- never
// the permanent token. The agent trades the code for a token on first connect
// and persists that token in its own volume.

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildInstallScript({ hubWsUrl, serverId, enrollCode, agentImage, expires }) {
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

# nvidia-smi monteras bara om varden faktiskt har den
NVIDIA_MOUNT=""
if [ -x /usr/bin/nvidia-smi ]; then
  echo "==> NVIDIA GPU upptackt, monterar nvidia-smi"
  NVIDIA_MOUNT="      - /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro"
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
    container_name: harbor-agent
    restart: unless-stopped
    # Inga ports: agenten ansluter utat och lyssnar aldrig sjalv.
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - harbor-agent-data:/data
\${NVIDIA_MOUNT}
    env_file:
      - .env
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
