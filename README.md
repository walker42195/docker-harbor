# Docker Harbor ⚓️ 🐳

Ett modernt, snabbt och stilrent webbgränssnitt för att hantera och övervaka Docker-containers i realtid — på den lokala värden och på valfritt antal fjärrservrar.

Varje server får en egen flik med sina containers, sina host-metrics och sitt eget skrivskydd.

---

## Innehåll

- [Funktioner](#funktioner)
- [Installation](#installation)
- [Inställningar för hubben](#inställningar-för-hubben)
- [Lägga till fler Docker-servrar](#lägga-till-fler-docker-servrar)
- [Inställningar för agenten](#inställningar-för-agenten)
- [Säkerhet](#säkerhet)
- [Drift och underhåll](#drift-och-underhåll)
- [Felsökning](#felsökning)
- [Arkitektur](#arkitektur)

---

## Funktioner

- 🔐 **Säker inloggning**: JWT-baserad autentisering.
- 🖥️ **Flera servrar**: Administrera flera Docker-servrar från samma panel, en flik per server.
- 📊 **Realtidsöversikt**: Alla containers (körs, stoppade, pausade) plus host-CPU, RAM, GPU och VRAM per server.
- ⚡️ **Full container-kontroll**: Starta, stoppa (graceful), starta om, bygg om (hämtar nyaste imagen och bevarar konfigurationen) och ta bort med `--force` och volymrensning.
- 📜 **Live-loggar (WebSocket)**: Realtidsströmning av loggar, även från fjärrservrar.
- 🔍 **Inspektera**: Fullständig JSON-konfiguration — miljövariabler, nätverk, mount-sökvägar.
- 📄 **Compose & Dockerfile**: Läs `docker-compose.yml` och `Dockerfile` direkt i gränssnittet.
- 📝 **Infotexter**: Egna beskrivningar per container, som även skrivs tillbaka som `description:`-label i serverns riktiga `docker-compose.yml`.
- 🧹 **System prune**: Rensa oanvända containers och images, per server.
- 🔒 **Skrivskydd**: Fjärrservrar är skrivskyddade som standard och låses upp med lösenord.

---

## Installation

### Förutsättningar

- Docker och Docker Compose på värden.
- Åtkomst till `/var/run/docker.sock`.

### 1. Hämta koden

```bash
git clone https://github.com/walker42195/docker-harbor.git
cd docker-harbor
```

### 2. Skapa `.env`

```bash
cp .env.example .env
```

Öppna `.env` och sätt **minst** dessa tre:

```ini
JWT_SECRET=<slumpa en lång sträng>
ADMIN_PASSWORD=<ditt lösenord>
WRITE_UNLOCK_PASSWORD=<lösenord för att låsa upp skrivning>
```

Slumpa hemligheter så här:

```bash
openssl rand -base64 32
```

### 3. Skapa `servers.json`

**Viktigt och lätt att missa.** Filen bind-monteras in i containern. Finns den
inte när containern startar skapar Docker en *katalog* med det namnet, och
serverregistret kan då aldrig sparas.

```bash
echo '{"version":1,"servers":[]}' > servers.json
```

### 4. Anpassa `docker-compose.yml`

Den medföljande compose-filen är skriven för den ursprungliga värden. Gå igenom
volymerna innan första start:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock       # krävs
  - ./descriptions.json:/app/descriptions.json      # infotexter
  - ./servers.json:/app/servers.json                # serverregister
  - /home/fredrik/Projects:/home/fredrik/Projects   # ← ändra till din projektkatalog
  - /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro      # ← ta bort om värden saknar NVIDIA-GPU
  - /usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu:ro   # ← samma
```

Projektkatalogen måste monteras på **identisk sökväg** på båda sidor. Sökvägarna
till compose-filer kommer från Dockers egna labels och är värd-absoluta — monterar
du dem någon annanstans hittas filerna inte.

Saknar värden NVIDIA-GPU: ta bort de två `nvidia`-volymerna **och** hela
`deploy:`-blocket, annars startar inte containern.

### 5. Starta

```bash
docker compose up -d --build
```

Gränssnittet nås på `http://localhost:6969` (eller din publicerade domän).

### 6. Logga in

Användarnamnet och lösenordet är de du satte i `.env` (`ADMIN_USER` /
`ADMIN_PASSWORD`). Standard är `admin` / `admin123` — **byt dessa**.

### Köra utan Docker

```bash
npm install
npm start          # eller: npm run dev  (hot-reload)
```

---

## Inställningar för hubben

Alla sätts i `.env` i repots rot.

| Variabel | Standard | Betydelse |
|---|---|---|
| `PORT` | `6969` | Porten webbgränssnittet lyssnar på. |
| `JWT_SECRET` | inbyggt värde | Nyckel som sessionstokens signeras med. **Sätt en egen.** Ändras den loggas alla ut. |
| `ADMIN_USER` | `admin` | Användarnamn för inloggning. |
| `ADMIN_PASSWORD` | `admin123` | Lösenord för inloggning. **Byt.** |
| `WRITE_UNLOCK_PASSWORD` | slumpas | Lösenord för att låsa upp skrivåtgärder mot skrivskyddade servrar. Lämnas det tomt genereras ett nytt vid *varje* omstart och skrivs till containerloggen en gång. |
| `HARBOR_AGENT_IMAGE` | `docker-harbor-agent:latest` | Image som installationsskriptet ber fjärrservrarna hämta. |
| `HARBOR_HUB_WS_URL` | härleds | `wss://…/ws/agent` som agenterna ansluter till. Lämnas tom härleds den från inkommande request, vilket fungerar bakom Cloudflare och reverse proxy. Sätt den om automatiken gissar fel. |
| `SNAPSHOT_INTERVAL_MS` | `5000` | Hur ofta varje server rapporterar containers och host-metrics. |
| `DESCRIPTIONS_CROSS_SERVER_FALLBACK` | `false` | Låt en container på en ny server ärva infotexten från en lokal container med samma namn. Av som standard för att undvika felmärkningar. |

### Filer som innehåller data

| Fil | Innehåll | I git? |
|---|---|---|
| `.env` | Lösenord och hemligheter | Nej (gitignorerad) |
| `servers.json` | Serverregister och token-**hashar** | Nej (gitignorerad) |
| `descriptions.json` | Infotexter per server och container | Ja |

Ta backup på `.env` och `servers.json`. Tappar du `servers.json` måste alla
agenter enrollas om.

---

## Lägga till fler Docker-servrar

På varje fjärrserver installeras en liten **agent** som ansluter **utåt** till
hubben över WebSocket:

- Ingen inkommande port behöver öppnas på fjärrservern.
- Docker-daemonen exponeras aldrig mot nätet.
- Fungerar bakom NAT och brandvägg.
- Agenten rapporterar även host-CPU, RAM, GPU och VRAM — sådant ett rent
  Docker-API över TLS inte kan ge.

### Steg 1: Bygg och distribuera agent-imagen

Build-contexten måste vara **repots rot**, eftersom agenten delar kod med hubben
i `shared/`:

```bash
docker build -f agent/Dockerfile -t docker-harbor-agent:latest .
```

Fjärrservern måste kunna hämta imagen. Välj ett sätt:

**A. Via ett register** (smidigast om du har ett):

```bash
docker tag docker-harbor-agent:latest ghcr.io/walker42195/docker-harbor-agent:latest
docker push ghcr.io/walker42195/docker-harbor-agent:latest
```

Sätt sedan `HARBOR_AGENT_IMAGE=ghcr.io/walker42195/docker-harbor-agent:latest`
i hubbens `.env` så pekar installationsskriptet på rätt image.

**B. Överför imagen direkt:**

```bash
docker save docker-harbor-agent:latest | ssh root@fjärrservern 'docker load'
```

**C. Bygg på fjärrservern:**

```bash
git clone https://github.com/walker42195/docker-harbor.git
cd docker-harbor
docker build -f agent/Dockerfile -t docker-harbor-agent:latest .
```

### Steg 2: Registrera servern i gränssnittet

Klicka **Lägg till server** och fyll i:

| Fält | Betydelse |
|---|---|
| **Server-ID** | Internt ID, 2–32 tecken: `a-z`, `0-9`, `-`, `_`. Går inte att ändra efteråt. |
| **Visningsnamn** | Namnet på fliken, t.ex. `Nova 2 (GPU)`. |
| **Publik adress** | Valfritt. Adressen containrarnas portlänkar ska peka på, t.ex. `192.168.1.42`. Utan den blir portbadgarna oklickbara. |
| **Färg** | Färgen på flikens kant, för att skilja servrarna åt. |

### Steg 3: Kör kommandot på servern

Du får ett kommando med hubbens adress redan inbakad:

```bash
curl -fsSL https://din-hubb/install/<kod> | sh
```

Skriptet lägger allt i `/opt/harbor-agent`, skriver en `.env` med `chmod 600`
och startar agenten med `docker compose up -d`. Servern dyker upp som en ny flik
inom några sekunder.

Koden gäller i **30 minuter** och kan bara användas **en gång**. Den är inte den
permanenta nyckeln: agenten byter den mot en riktig token vid första
anslutningen och sparar den i sin egen volym.

Behöver du en ny kod — ominstallation eller nyckelrotation — skapar du en från
serverfliken i gränssnittet.

### Alternativ: via CLI

```bash
node scripts/enroll-server.js --list                          # lista servrar
node scripts/enroll-server.js nova2 "Nova 2 (GPU)"            # ny server + kod
node scripts/enroll-server.js nova2 --enroll                  # ny kod
node scripts/enroll-server.js nova2 --rotate                  # ny permanent token
```

Sätt `HARBOR_PUBLIC_URL` för att få rätt adress i utskriften:

```bash
HARBOR_PUBLIC_URL=https://harbor.example.com node scripts/enroll-server.js nova2 "Nova 2"
```

### Ta bort en server

Öppna serverns flik och klicka **Ta bort server**. Containrarna påverkas inte,
men agenten kan inte längre ansluta. Stoppa agenten på servern själv:

```bash
cd /opt/harbor-agent && docker compose down
```

---

## Inställningar för agenten

Sätts i `/opt/harbor-agent/.env` på fjärrservern. Efter ändring:

```bash
cd /opt/harbor-agent && docker compose up -d
```

| Variabel | Standard | Betydelse |
|---|---|---|
| `HARBOR_HUB_URL` | — | `wss://din-hubb/ws/agent`. **Krävs.** |
| `HARBOR_SERVER_ID` | — | Serverns ID i hubbens register. **Krävs.** |
| `HARBOR_ENROLL_CODE` | — | Engångskod vid första start. Byts automatiskt mot en permanent token. |
| `HARBOR_TOKEN` | — | Permanent token, om du sätter den manuellt istället för att enrolla. |
| `HARBOR_TOKEN_FILE` | `/data/agent-token` | Var den permanenta token sparas. Måste ligga på en volym som överlever omstart. |
| `HARBOR_SNAPSHOT_INTERVAL_MS` | `5000` | Hur ofta containers och host-metrics rapporteras. |
| `HARBOR_READ_ONLY` | `true` | `true` = agenten vägrar alla ändringar, oavsett vad hubben ber om. |
| `HARBOR_ALLOW_FILE_READ` | `true` | Tillåt läsning av `docker-compose.yml` och `Dockerfile`. |
| `HARBOR_ALLOW_FILE_WRITE` | `false` | Tillåt att infotexter skrivs tillbaka till `docker-compose.yml`. |
| `HARBOR_TLS_INSECURE` | `false` | Hoppa över certifikatvalidering. **Endast labb.** |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Sökväg till Docker-sockeln. |

### Volymer för agenten

| Volym | Krävs | Varför |
|---|---|---|
| `/var/run/docker.sock:/var/run/docker.sock` | Ja | Åtkomst till Docker. |
| `harbor-agent-data:/data` | Ja | Sparar den permanenta token. Utan den måste agenten enrollas om vid varje omstart. |
| `<projektkatalog>:<samma sökväg>` | Nej | Krävs för att läsa och redigera compose-filer. Måste vara identisk sökväg på båda sidor. |
| `/usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro` | Nej | Ger GPU- och VRAM-siffror. Bara på värdar med NVIDIA-GPU. |

Se `agent/README.md` och `agent/docker-compose.example.yml` för mer.

---

## Säkerhet

### Skrivskydd i två lager

Fjärrservrar är **skrivskyddade som standard**. För att starta, stoppa, bygga om
eller ta bort containers på en fjärrserver krävs två oberoende ja:

**1. På servern** — `HARBOR_READ_ONLY=false` i `/opt/harbor-agent/.env`:

```bash
cd /opt/harbor-agent
sed -i 's/HARBOR_READ_ONLY=true/HARBOR_READ_ONLY=false/' .env
docker compose up -d
```

Skyddar mot en **kapad hubb**. Kan bara ändras av någon med SSH till just den
servern.

**2. I gränssnittet** — klicka 🔒 **Lås upp skrivning** i serverfliken och ange
`WRITE_UNLOCK_PASSWORD`.

Skyddar mot en **kapad webbsession**. Gäller 15 minuter och låser sedan sig
själv. Klicka 🔓 för att låsa direkt.

Ett nej från endera sidan vinner alltid. Är servern låst är alla skrivknappar
utgråade och korten visar en **Skrivskyddad**-markering — loggar och inspektion
fungerar ändå.

### Övrigt värt att veta

- Tokens lagras bara som **scrypt-hashar** i `servers.json`. Klartexten visas en
  gång och sparas aldrig.
- Token skickas i WebSocket-meddelandets body, **aldrig i URL:en**, så den hamnar
  inte i access- eller proxyloggar.
- Hubben kan bara begära operationer ur en **fast lista**. Inga godtyckliga
  kommandon, och **inga sökvägar som argument** — compose- och Dockerfile-sökvägar
  slås upp på den exekverande sidan ur containerns egna labels.
- Både hubben och agenten validerar varje anrop. Ingen sida litar på den andra.
- Fem misslyckade anslutningsförsök från samma IP blockerar den IP:n i 10 minuter.
- Fem felaktiga upplåsningslösenord rate-limitar i 15 minuter.
- **Använd `wss://` i produktion.** Publicera hubben bakom en reverse proxy med
  giltigt certifikat, t.ex. Caddy eller Cloudflare Tunnel.
- **Agenten har full kontroll över värdens Docker-daemon.** Det motsvarar
  root-åtkomst till servern. Behandla token därefter.

---

## Drift och underhåll

### Uppdatera hubben

```bash
cd docker-harbor
git pull
docker compose up -d --build
```

### Uppdatera agenterna

Bygg om imagen, distribuera den, och på varje fjärrserver:

```bash
cd /opt/harbor-agent
docker compose pull        # om du använder ett register
docker compose up -d
```

Agenten återansluter automatiskt. Ingen omstart av hubben behövs.

### Rotera en agents token

```bash
node scripts/enroll-server.js nova2 --rotate
```

Skriv in den nya token som `HARBOR_TOKEN` i serverns `.env` och kör
`docker compose up -d`. Alternativt: skapa en ny installationskod från
serverfliken och kör om installationskommandot.

### Backup

```bash
tar czf harbor-backup.tar.gz .env servers.json descriptions.json
```

---

## Felsökning

### Hubben

| Symptom | Trolig orsak |
|---|---|
| `Väntar på data från Docker` | Docker-sockeln är inte monterad, eller behörighet saknas. |
| Serverregistret nollställs vid omstart | `servers.json` finns inte som **fil** — Docker skapade en katalog. Stoppa, ta bort katalogen, skapa filen, starta om. |
| Alla loggas ut efter omstart | `JWT_SECRET` är inte satt i `.env` och slumpas därför. |
| Nytt upplåsningslösenord vid varje start | `WRITE_UNLOCK_PASSWORD` är inte satt i `.env`. |
| GPU-korten visas inte | Värden saknar NVIDIA-GPU, eller `nvidia-smi` är inte monterad. Korten döljs medvetet då. |

### Agenten

```bash
cd /opt/harbor-agent && docker compose logs -f harbor-agent
```

| Loggrad | Betydelse |
|---|---|
| `ansluten till hubben` | Allt fungerar. |
| `hubben nekade åtkomst (4403 ...)` | Fel server-ID eller token. Skapa en ny installationskod. |
| `frånkopplad (...), återansluter om ...` | Normalt vid nätverksavbrott. Agenten backar av upp till 30 sekunder. |
| `KUNDE INTE spara token` | `/data`-volymen saknas eller är skrivskyddad. |
| `Servern är i skrivskyddat läge` (i UI:t) | `HARBOR_READ_ONLY=true` på agenten. |
| `Servern är låst` (i UI:t) | Servern behöver låsas upp med lösenord i gränssnittet. |

Fliken blir röd och containrarna dimmas när en agent tappar kontakten. Senast
kända containers ligger kvar, så du ser vad som fanns — men alla knappar är
avstängda tills agenten är tillbaka.

---

## Arkitektur

```
server.js            Wiring och routes
lib/
  registry.js        servers.json, token-hashning
  transport.js       Gemensamt gränssnitt + snapshot-cache
  localTransport.js  Den lokala Docker-sockeln, med egen snapshot-poller
  agentTransport.js  En ansluten fjärragent
  agentHub.js        /ws/agent: handshake, enrollment, autentisering
  logsWs.js          /ws/logs: proxar loggströmmar till valfri server
  unlock.js          Skrivupplåsning med lösenord
  installScript.js   Genererar installationsskriptet som serveras på /install/:kod
  descriptions.js    Infotexter, namespacade per server
shared/              Delas av hubben OCH agenterna
  dockerOps.js       Enda implementationen av varje dockerode-anrop
  protocol.js        Operations-allowlist och validering
  metrics.js         CPU/RAM/GPU och formatering
agent/               Agenten som installeras på fjärrservrar
scripts/             CLI för enrollment och tokenrotation
```

Både hubben och agenten kör samma `shared/dockerOps.js`, så en lokal container
och en container på en fjärrserver behandlas av exakt samma kod. Ingen route
grenar någonsin på "lokal eller fjärr".

`/api/containers` serveras helt ur snapshot-cachen. Tidigare gjorde varje
5-sekunderspoll N blockerande `stats`-anrop plus en `nvidia-smi`-exec inuti
HTTP-requesten; nu svarar den på någon millisekund.

### Portar

| Port | Riktning | Vad |
|---|---|---|
| `6969` | in, på hubben | Webbgränssnitt och API. |
| — | ut, från agenten | Agenterna ansluter utåt. Ingen port öppnas på fjärrservrarna. |
