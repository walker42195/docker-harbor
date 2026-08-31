# Docker Harbor ⚓️ 🐳

Ett modernt, snabbt och stilrent webbgränssnitt för att hantera och övervaka Docker-containers i realtid — på den lokala värden och på valfritt antal fjärrservrar.

Varje server får en egen flik med sina containers, sina host-metrics och sitt eget skrivskydd.

---

## Innehåll

- [Funktioner](#funktioner)
- [Installation](#installation)
- [Om NVIDIA-GPU](#om-nvidia-gpu)
- [Varför samma sökväg på båda sidor?](#varför-samma-sökväg-på-båda-sidor)
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

### 2. Kör installationsskriptet

```bash
./setup.sh
```

Skriptet känner av värdens förutsättningar och anpassar installationen:

| Kontroll | Vad som händer |
|---|---|
| **Docker och Compose** | Avbryter med tydligt fel om något saknas eller daemonen inte svarar. |
| **NVIDIA-GPU** | Letar efter `nvidia-smi`, kontrollerar att `nvidia-container-toolkit` finns och **provkör faktiskt** en container med GPU. Först då slås GPU- och VRAM-mätning på. |
| **Projektkataloger** | Läser compose-labels från **hubbmaskinens egna** containers och monterar precis de kataloger som behövs — ofta fler än en. Kör hubben på en dedikerad server monteras ingenting, vilket är rätt: fjärrservrarnas filer läses av deras egna agenter. Styr själv med `HARBOR_PROJECTS_DIR=/en:/annan ./setup.sh`. |
| **Hemligheter** | Skapar `.env` med slumpade `JWT_SECRET`, `ADMIN_PASSWORD` och `WRITE_UNLOCK_PASSWORD` (`chmod 600`). Det genererade inloggningslösenordet skrivs ut en gång. |
| **Data** | Skapar `data/` för lokal körning. I Docker används den namngivna volymen `harbor-data`. |
| **Agent-image** | Bygger `docker-harbor-agent:latest` så hubben kan servera den till fjärrservrar. Då räcker ett enda kommando på den servern — inget register, ingen SSH. |

Resultatet skrivs till `docker-compose.override.yml`, som Docker Compose slår
ihop med `docker-compose.yml` automatiskt. Basfilen förblir generisk och
maskinspecifika detaljer hamnar bara i overriden.

Skriptet är **idempotent** — kör om det när som helst, t.ex. efter att du
installerat en GPU eller `nvidia-container-toolkit`. En befintlig `.env` rörs
aldrig.

### 3. Starta

```bash
docker compose up -d --build
```

Gränssnittet nås på `http://localhost:6969`. Logga in med `admin` och lösenordet
`setup.sh` skrev ut (det står också i `.env`).

### Om du hellre gör det för hand

```bash
cp .env.example .env          # fyll i JWT_SECRET, ADMIN_PASSWORD, WRITE_UNLOCK_PASSWORD
docker compose up -d --build  # utan override: ingen GPU, ingen compose-filläsning
```

### Köra utan Docker

```bash
npm install
npm start          # eller: npm run dev  (hot-reload)
```

---

## Om NVIDIA-GPU

GPU- och VRAM-korten visas bara när mätningen faktiskt fungerar. Tre saker
måste stämma:

1. **En GPU på värden** — `nvidia-smi -L` ska svara.
2. **`nvidia-container-toolkit`** — utan den kan Docker inte skicka in kortet
   i en container. `setup.sh` provkör detta på riktigt i stället för att gissa.
3. **En glibc-baserad image** — imagen bygger på `node:20-slim`, inte
   `node:20-alpine`. Toolkit:en injicerar glibc-länkade binärer, så `nvidia-smi`
   kan inte köras på Alpine (musl).

Bind-montera **inte** `nvidia-smi` eller drivrutinsbiblioteken för hand.
Sökvägarna skiljer sig mellan distributioner — på Debian ligger de i
`/usr/lib/x86_64-linux-gnu`, på Arch i `/usr/lib` — och en manuell mount skuggar
dessutom de filer toolkit:en själv injicerar, vilket får `nvidia-smi` att sluta
fungera. Rätt sätt är `NVIDIA_DRIVER_CAPABILITIES=utility` plus en
device-reservation, vilket `setup.sh` genererar åt dig.

Saknas GPU fungerar allt annat precis som vanligt — korten döljs bara.

Har en **annan** container på värden CUDA installerat kan Docker Harbor ändå
läsa GPU-siffror genom den, som reserv.

---

## Varför samma sökväg på båda sidor?

Det här gäller **bara** knappen som visar `docker-compose.yml` och `Dockerfile`
i gränssnittet. Struntar du i den kan du hoppa över hela avsnittet.

### Docker talar om var filen ligger — men lämnar inte ut den

Docker-motorn sparar sökvägen till compose-filen som en label:

```bash
$ docker inspect n8n --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
/home/fredrik/Docker/n8n/docker-compose.yml
```

Så långt stämmer din tanke. Men Docker ger bara **sökvägen**, inte innehållet.
Det finns inget API för att läsa en godtycklig fil från värdens filsystem —
Docker hanterar containers, inte filer. För att visa filen måste den som läser
den nå den katalogen på riktigt.

### Därför samma sökväg

Den som läser filen kör själv i en container. Monteras katalogen någon
annanstans stämmer inte sökvägen i labeln längre:

```
Labeln säger:   /home/fredrik/Docker/n8n/docker-compose.yml
Containern har: /mnt/projekt/n8n/docker-compose.yml
Öppnar:         /home/fredrik/Docker/n8n/docker-compose.yml  →  finns inte
```

Filen finns, men på en annan adress än den Docker uppgav. Monteras den på
samma sökväg stämmer allt utan omräkning:

```
- /home/fredrik/Docker:/home/fredrik/Docker      # identisk på båda sidor
```

Därför ser raden konstig ut med samma sökväg två gånger. Det är hela poängen.

### Varje maskin sköter sina egna filer

Det viktiga: monteringen görs på **den maskin där containrarna faktiskt kör** —
inte på hubben.

| Maskin | Vad som monteras |
|---|---|
| **Hubben** | Bara katalogerna för hubbmaskinens *egna* containers. Kör hubben på en dedikerad server utan andra containers monteras **ingenting**. |
| **Varje fjärrserver** | Agenten monterar den serverns egna kataloger. Filen läses lokalt där och skickas över WebSocket till hubben. |

Hubben läser alltså aldrig en fjärrservers filsystem — den frågar agenten, som
läser lokalt. Det är också därför hubben aldrig behöver veta något om
fjärrserverns kataloger.

### Du behöver inte konfigurera det

Både `setup.sh` och agentens installationsskript gissar inte: de läser
compose-labels från de containers som redan finns på den maskin de körs på och
monterar precis de rötter som behövs. Har du filer i både `~/Projects` och
`~/Docker` monteras båda. Finns inga compose-startade containers monteras inget.

Vill du styra det själv på hubben (flera kataloger separeras med kolon):

```bash
HARBOR_PROJECTS_DIR=/srv/docker:/opt/stacks ./setup.sh
```

Startar du senare containers i en helt ny katalog: kör om `setup.sh` och
`docker compose up -d`. På en fjärrserver: kör om installationskommandot, eller
lägg till raden i `/opt/harbor-agent/docker-compose.yml` för hand.

**Containers som inte startats via Compose** har ingen sådan label alls. För dem
visas "Fristående container" och Compose-knappen är avstängd — det är väntat.

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

### Var data sparas

All muterbar data ligger i **en** katalog, `/app/data` i containern, monterad
som den namngivna volymen `harbor-data`:

| Fil i `data/` | Innehåll |
|---|---|
| `servers.json` | Serverregistret och token-**hashar** för anslutna agenter. |
| `descriptions.json` | Infotexter per server och container. |

Volymen överlever `docker compose down`, `up --build` och ombyggnad av imagen.
Första gången containern startar kopieras eventuella `servers.json` och
`descriptions.json` från repots rot in i volymen automatiskt, så en äldre
installation migreras utan handpåläggning.

Enskilda filer bind-monteras medvetet **inte**. Finns en sådan fil inte på
värden när containern startar skapar Docker en *katalog* med samma namn, och då
kan ingenting någonsin sparas.

| Fil | Innehåll | I git? |
|---|---|---|
| `.env` | Lösenord och hemligheter | Nej |
| `docker-compose.override.yml` | Maskinspecifik config från `setup.sh` | Nej |
| `data/` | Serverregister och infotexter | Nej |

Backup:

```bash
docker run --rm -v docker-harbor_harbor-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/harbor-data.tar.gz -C /data .
cp .env harbor-env.bak
```

---

## Lägga till fler Docker-servrar

På varje fjärrserver installeras en liten **agent** som ansluter **utåt** till
hubben över WebSocket:

- Ingen inkommande port behöver öppnas på fjärrservern.
- Docker-daemonen exponeras aldrig mot nätet.
- Fungerar bakom NAT och brandvägg.
- Agenten rapporterar även host-CPU, RAM, GPU och VRAM — sådant ett rent
  Docker-API över TLS inte kan ge.

### Steg 1: Registrera servern i gränssnittet

Klicka **Lägg till server** och fyll i:

| Fält | Betydelse |
|---|---|
| **Server-ID** | Internt ID, 2–32 tecken: `a-z`, `0-9`, `-`, `_`. Går inte att ändra efteråt. |
| **Visningsnamn** | Namnet på fliken, t.ex. `Nova 2 (GPU)`. |
| **Publik adress** | Valfritt. Adressen containrarnas portlänkar ska peka på, t.ex. `192.168.1.42`. Utan den blir portbadgarna oklickbara. |
| **Färg** | Färgen på flikens kant, för att skilja servrarna åt. |

### Steg 2: Kör kommandot på servern

Du får ett kommando med hubbens adress redan inbakad. Kör det **med `sudo`** —
det skriver till `/opt/harbor-agent` och pratar med Docker:

```bash
curl -fsSL https://din-hubb/install/<kod> | sudo sh
```

Skriptet installerar i `/opt/docker-harbor-agent` och **vägrar skriva över en
katalog som tillhör något annat**. Flera projekt använder namnet
`harbor-agent` — radera aldrig en sådan katalog för att "rensa" inför en
ominstallation utan att veta vad den innehåller.

Skriptet sköter allt självt:

1. Kontrollerar att du kan skriva till installationskatalogen, och säger till
   direkt om du behöver `sudo` i stället för att fela halvvägs.
2. Läser serverns compose-labels och monterar de kataloger som behövs.
3. **Hämtar agent-imagen från hubben** när den saknas eller är inaktuell —
   skriptet jämför image-id med hubbens. Imagen finns inte på Docker Hub, så
   servern behöver varken register, `docker login` eller internetåtkomst
   utanför ditt eget nät. Kör om kommandot för att uppdatera en agent.
4. Känner av NVIDIA-GPU och slår bara på GPU-mätning om kortet bevisligen kan
   skickas in i en container.
5. Skriver `.env` med `chmod 600` och startar agenten.

Servern dyker upp som en ny flik inom några sekunder.

Koden gäller i **30 minuter** och kan bara användas **en gång**. Den är inte den
permanenta nyckeln: agenten byter den mot en riktig token vid första
anslutningen och sparar den i sin egen volym.

Behöver du en ny kod — ominstallation eller nyckelrotation — skapar du en från
serverfliken i gränssnittet.

### Bygga agent-imagen för hand

`setup.sh` bygger den åt dig på hubben. Vill du göra det själv måste
build-contexten vara **repots rot** — agenten delar kod med hubben i `shared/`:

```bash
docker build -f agent/Dockerfile -t docker-harbor-agent:latest .
```

Imagen ligger medvetet inte på Docker Hub. Hubben serverar den i stället själv
på `/install/<kod>/image`, skyddad av samma engångskod. Fjärrservern behöver
därför varken register, `docker login` eller åtkomst till internet utanför ditt
eget nät — bara till hubben.

Vill du ändå använda ett eget register: tagga och pusha, och sätt
`HARBOR_AGENT_IMAGE=ghcr.io/dittnamn/docker-harbor-agent:latest` i hubbens
`.env`. Imagen behöver ändå finnas på hubben, eftersom det är därifrån
installationsskriptet hämtar den.

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
| `<projektkatalog>:<samma sökväg>` | Nej | Läggs till automatiskt av installationsskriptet, härlett ur den serverns egna compose-labels. Krävs för att läsa compose-filer och Dockerfiler därifrån — [varför samma sökväg?](#varför-samma-sökväg-på-båda-sidor) |
| GPU-konfiguration | Nej | Läggs till automatiskt av installationsskriptet när det hittar en GPU **och** verifierat att den kan skickas in i en container. Ingen manuell mount — se [Om NVIDIA-GPU](#om-nvidia-gpu). |

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
./setup.sh                 # känner av värden på nytt; rör inte din .env
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
| `hubben nekade åtkomst (4403 ...)` | Fel server-ID, eller servern finns inte i hubben. Kontrollera hubbens logg — den skriver ut orsaken för varje avvisad agent. |
| `hubben nekade det sparade token` | Servern registrerades om i hubben. Agenten kastar sitt gamla token och enrollar om automatiskt med koden i `.env`. |
| `Unexpected server response: 429` | Hubben har blockerat serverns IP i 10 minuter efter fem misslyckade försök. Vänta, eller starta om hubben för att nollställa. Åtgärda orsaken först — se hubbens logg. |
| `socket hang up` / `frånkopplad (1006)` | Ingen WebSocket-handskakning kom till stånd. Med en hubb äldre än denna version är det oftast IP-blockeringen, som då revs tyst; uppdatera hubben så svarar den 429 med förklaring i loggen. |
| `frånkopplad (...), återansluter om ...` | Normalt vid nätverksavbrott. Agenten backar av upp till 30 sekunder. |
| `KUNDE INTE spara token` | `/data`-volymen saknas eller är skrivskyddad. |
| `cannot create .env: Permission denied` | Kör installationskommandot med `sudo`. |
| `finns redan och verkar tillhora nagot annat` | Katalogen används av ett annat program. Välj en annan: `sudo HARBOR_INSTALL_DIR=/opt/min-agent sh`. Radera inte den befintliga. |
| `pull access denied for docker-harbor-agent` | Gammal agentversion, eller imagen kunde inte hämtas från hubben. Bygg den på hubben: `docker build -f agent/Dockerfile -t docker-harbor-agent:latest .` — `setup.sh` gör det åt dig. |
| `kunde inte hamta agent-imagen fran hubben` | Hubben saknar imagen. Kör `./setup.sh` på hubben, eller bygg den för hand med kommandot ovan. |
| Agenten beter sig som en äldre version | Kontrollera att imagen är uppdaterad: `docker image inspect docker-harbor-agent:latest --format "{{.Created}}"` på servern, och jämför med hubben. Kör om installationskommandot — det hämtar en ny image när id:t skiljer sig. |
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
