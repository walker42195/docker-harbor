#!/usr/bin/env bash
#
# Docker Harbor -- installationsskript.
#
# Känner av värdens förutsättningar (NVIDIA-GPU, projektkatalog), skapar .env
# med slumpade hemligheter och genererar docker-compose.override.yml med de
# maskinspecifika delarna. Kör om det när som helst -- det är idempotent och
# rör aldrig hemligheter du redan satt.
set -euo pipefail

cd "$(dirname "$0")"

OVERRIDE="docker-compose.override.yml"
ENV_FILE=".env"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '  \033[36m·\033[0m %s\n' "$*"; }

say ""
say "Docker Harbor -- installation"
say "============================="
say ""

# ---------------------------------------------------------------- 1. Docker
say "Kontrollerar förutsättningar"

if ! command -v docker >/dev/null 2>&1; then
  printf '  \033[31m✗\033[0m docker hittades inte. Installera Docker först.\n'
  exit 1
fi
ok "docker: $(docker --version | cut -d, -f1)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  printf '  \033[31m✗\033[0m Varken "docker compose" eller "docker-compose" hittades.\n'
  exit 1
fi
ok "compose: $COMPOSE"

if ! docker info >/dev/null 2>&1; then
  printf '  \033[31m✗\033[0m Kan inte prata med Docker-daemonen. Kör du som rätt användare?\n'
  exit 1
fi
ok "docker-daemonen svarar"

# ------------------------------------------------------------ 2. NVIDIA-GPU
say ""
say "Söker efter NVIDIA-GPU"

GPU=no
GPU_NAME=""

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  ok "GPU på värden: ${GPU_NAME:-okänd}"

  # Grafikkort räcker inte -- Docker måste också kunna skicka in det i
  # containern. Det kräver nvidia-container-toolkit.
  if command -v nvidia-ctk >/dev/null 2>&1 \
     || command -v nvidia-container-runtime >/dev/null 2>&1 \
     || docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null | grep -q nvidia; then
    ok "nvidia-container-toolkit finns"

    # Verifiera på riktigt i stället för att gissa. Använder en image som
    # ändå behövs för bygget, så inget extra laddas ner i onödan.
    info "provar att skicka in GPU:n i en container..."
    if timeout 120 docker run --rm --gpus all \
         -e NVIDIA_DRIVER_CAPABILITIES=utility \
         node:20-slim nvidia-smi -L >/dev/null 2>&1; then
      GPU=yes
      ok "GPU fungerar i containers -- GPU- och VRAM-mätning aktiveras"
    else
      warn "GPU:n kunde inte skickas in i en container."
      warn "Kontrollera nvidia-container-toolkit. GPU-mätning hoppas över."
    fi
  else
    warn "nvidia-container-toolkit saknas -- GPU:n kan inte nå containers."
    warn "Installera den för GPU-mätning. GPU-korten döljs i gränssnittet."
  fi
else
  info "ingen NVIDIA-GPU hittades -- GPU- och VRAM-korten döljs i gränssnittet"
fi

# ------------------------------------------------------ 3. Projektkataloger
say ""
say "Projektkataloger"
info "Gäller bara DEN HÄR värdens egna containers. Fjärrservrar sköts av"
info "sin egen agent, som monterar sina egna kataloger. Monteras på samma"
info "sökväg som på värden, eftersom Docker anger sökvägarna värd-absolut."

# Härled katalogerna ur containrarnas faktiska compose-labels i stället för
# att gissa. Det ger exakt de rötter som verkligen behövs på just den här
# värden -- ofta fler än en.
detect_roots() {
  ids=$(docker ps -aq 2>/dev/null) || return 0
  [ -n "$ids" ] || return 0
  # Ett enda inspect-anrop för alla containers: en rad per container, och
  # inga nästlade loopar som kan sluka varandras stdin.
  # shellcheck disable=SC2086
  docker inspect $ids \
      --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
      2>/dev/null </dev/null \
    | tr ',' '\n' \
    | while read -r f; do
        [ -n "$f" ] || continue
        d=$(dirname "$f")
        # Gå upp till katalogen direkt under $HOME (eller under /).
        case "$d" in
          "$HOME"/*) printf '%s/%s\n' "$HOME" "$(printf '%s' "${d#"$HOME"/}" | cut -d/ -f1)" ;;
          /*)        printf '/%s\n' "$(printf '%s' "${d#/}" | cut -d/ -f1)" ;;
        esac
      done \
    | sort -u
}

PROJECT_ROOTS=""

if [ -n "${HARBOR_PROJECTS_DIR:-}" ]; then
  # Explicit val vinner alltid. Kan vara kolonseparerad lista.
  for d in $(printf '%s' "$HARBOR_PROJECTS_DIR" | tr ':' ' '); do
    if [ -d "$d" ]; then
      PROJECT_ROOTS="$PROJECT_ROOTS $d"
      ok "vald: $d"
    else
      warn "$d finns inte -- hoppas över"
    fi
  done
else
  for d in $(detect_roots); do
    # Montera aldrig in hela / eller /home -- för brett.
    case "$d" in
      /|/home|/root|/usr|/etc|/var|/opt) warn "hoppar över $d (för bred sökväg)"; continue ;;
    esac
    if [ -d "$d" ]; then
      PROJECT_ROOTS="$PROJECT_ROOTS $d"
      ok "hittade $d (härledd ur containrarnas compose-labels)"
    fi
  done

fi

if [ -z "$PROJECT_ROOTS" ]; then
  info "inga compose-startade containers på den här värden -- inget monteras"
  info "(kör om setup.sh senare om du startar containers här)"
fi

# --------------------------------------------------------------- 4. Data
say ""
say "Data"
mkdir -p data
ok "data/ finns (används lokalt; i Docker används volymen harbor-data)"

# ---------------------------------------------------------------- 5. .env
say ""
say "Hemligheter"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n/+=' | cut -c1-32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f "$ENV_FILE" ]; then
  ok ".env finns redan -- rörs inte"
else
  ADMIN_PW="$(gen_secret)"
  cat > "$ENV_FILE" <<ENVEOF
PORT=6969
JWT_SECRET=$(gen_secret)$(gen_secret)
ADMIN_USER=admin
ADMIN_PASSWORD=${ADMIN_PW}
WRITE_UNLOCK_PASSWORD=$(gen_secret)

HARBOR_AGENT_IMAGE=docker-harbor-agent:latest
HARBOR_HUB_WS_URL=
SNAPSHOT_INTERVAL_MS=5000
DESCRIPTIONS_CROSS_SERVER_FALLBACK=false
ENVEOF
  chmod 600 "$ENV_FILE"
  ok ".env skapad med slumpade hemligheter (chmod 600)"
  say ""
  say "  ------------------------------------------------------------"
  say "   Inloggning:  admin / ${ADMIN_PW}"
  say "   Sparat i .env. Skriv ner det nu."
  say "  ------------------------------------------------------------"
fi

# ------------------------------------------------------- 6. Compose-override
say ""
say "Genererar $OVERRIDE"

{
  echo "# GENERERAD AV ./setup.sh -- redigera inte för hand."
  echo "# Kör om setup.sh om värdens förutsättningar ändras."
  echo "services:"
  echo "  docker-harbor:"

  if [ -n "$PROJECT_ROOTS" ]; then
    echo "    volumes:"
    echo "      # Samma sökväg på båda sidor -- se README."
    for d in $PROJECT_ROOTS; do
      echo "      - ${d}:${d}"
    done
  fi

  if [ "$GPU" = yes ]; then
    echo "    environment:"
    echo "      # Toolkit:en injicerar nvidia-smi och drivrutinsbiblioteken."
    echo "      # Bind-montera dem INTE för hand -- sökvägarna skiljer sig"
    echo "      # mellan distributioner och manuella mount:ar skuggar de riktiga."
    echo "      - NVIDIA_VISIBLE_DEVICES=all"
    echo "      - NVIDIA_DRIVER_CAPABILITIES=utility"
    echo "    deploy:"
    echo "      resources:"
    echo "        reservations:"
    echo "          devices:"
    echo "            - driver: nvidia"
    echo "              count: all"
    echo "              capabilities: [gpu, utility]"
  fi

  if [ -z "$PROJECT_ROOTS" ] && [ "$GPU" != yes ]; then
    echo "    # Inget maskinspecifikt att lägga till på den här värden."
    echo "    labels:"
    echo "      harbor.setup: \"generated\""
  fi
} > "$OVERRIDE"

ok "$OVERRIDE skriven (GPU: $GPU, kataloger:${PROJECT_ROOTS:- inga})"

if ! $COMPOSE config -q 2>/dev/null; then
  printf '  \033[31m✗\033[0m Compose-konfigurationen blev ogiltig. Kontrollera %s.\n' "$OVERRIDE"
  exit 1
fi
ok "compose-konfigurationen validerar"

# ------------------------------------------------------- 7. Agent-imagen
say ""
say "Agent-image"
info "Byggs har sa hubben kan servera den till fjarrservrar. Da racker det"
info "med ett kommando pa den servern -- inget register, ingen SSH."

# || true: grep returnerar 1 nar raden saknas, och set -e skulle doda skriptet.
AGENT_IMAGE=$( { grep -E '^HARBOR_AGENT_IMAGE=' "$ENV_FILE" || true; } 2>/dev/null | cut -d= -f2- )
AGENT_IMAGE="${AGENT_IMAGE:-docker-harbor-agent:latest}"

if docker build -f agent/Dockerfile -t "$AGENT_IMAGE" . >/dev/null 2>&1; then
  ok "byggde $AGENT_IMAGE"
else
  warn "kunde inte bygga $AGENT_IMAGE."
  warn "Fjarrservrar kan da inte hamta agenten fran hubben."
  warn "Bygg den for hand: docker build -f agent/Dockerfile -t $AGENT_IMAGE ."
fi

# ---------------------------------------------------------------- 7. Klart
say ""
say "Klart. Starta med:"
say ""
say "    $COMPOSE up -d --build"
say ""
say "Gränssnittet nås sedan på http://localhost:$( { grep -E '^PORT=' "$ENV_FILE" || echo 'PORT=6969'; } | cut -d= -f2 )"
say ""
