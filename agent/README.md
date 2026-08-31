# Docker Harbor-agent

En liten tjänst som körs på en Docker-server och rapporterar dess containers
till en central Docker Harbor-hubb.

Agenten **ansluter utåt** till hubben över WebSocket. Den lyssnar aldrig på
någon port, så ingen brandväggsregel behöver öppnas och Docker-daemonen
exponeras aldrig mot nätet. Det fungerar även bakom NAT.

## Installation

Enklaste vägen går via gränssnittet:

1. I Docker Harbor: klicka **Lägg till server**, fyll i ID och namn.
2. Kopiera kommandot du får och kör det på den server som ska anslutas:

   ```sh
   curl -fsSL https://harbor.example.com/install/<kod> | sh
   ```

3. Servern dyker upp som en ny flik i Docker Harbor inom några sekunder.

Skriptet lägger allt i `/opt/harbor-agent` och startar agenten med
`docker compose up -d`.

Installationskoden gäller i **30 minuter** och kan bara användas **en gång**.
Den är inte den permanenta nyckeln: agenten byter den mot en riktig token vid
första anslutningen och sparar den i sin egen volym. Ett stulet
installationsskript är alltså värdelöst så snart agenten anslutit en gång.

Behöver du en ny kod (ominstallation, nyckelrotation) skapar du en från
serverfliken i gränssnittet.

## Konfiguration

| Variabel | Standard | Betydelse |
|---|---|---|
| `HARBOR_HUB_URL` | — | `wss://din-hubb/ws/agent`. Krävs. |
| `HARBOR_SERVER_ID` | — | Serverns ID i hubbens register. Krävs. |
| `HARBOR_ENROLL_CODE` | — | Engångskod vid första start. |
| `HARBOR_TOKEN` | — | Permanent token, om du sätter den manuellt. |
| `HARBOR_TOKEN_FILE` | `/data/agent-token` | Var den permanenta token sparas. |
| `HARBOR_SNAPSHOT_INTERVAL_MS` | `5000` | Hur ofta containers och host-metrics rapporteras. |
| `HARBOR_READ_ONLY` | `true` | `true` = agenten vägrar alla ändringar. |
| `HARBOR_ALLOW_FILE_READ` | `true` | Tillåt läsning av compose-fil och Dockerfile. |
| `HARBOR_ALLOW_FILE_WRITE` | `false` | Tillåt att infotexter skrivs till `docker-compose.yml`. |
| `HARBOR_TLS_INSECURE` | `false` | Hoppa över certifikatvalidering. **Endast labb.** |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Sökväg till Docker-sockeln. |

### Ge agenten fulla rättigheter

Agenten installeras skrivskyddad. För att tillåta start, stopp, omstart,
ombyggnad och radering:

```sh
cd /opt/harbor-agent
sed -i 's/HARBOR_READ_ONLY=true/HARBOR_READ_ONLY=false/' .env
docker compose up -d
```

Det räcker inte i sig — servern måste **också** låsas upp med lösenord i
Docker Harbor-gränssnittet. De två lagren är avsiktligt oberoende:

- `HARBOR_READ_ONLY` här skyddar mot en **kapad hubb**. Ändras bara av någon
  med SSH-åtkomst till just den här servern.
- Upplåsningen i UI:t skyddar mot en **kapad webbsession**. Gäller 15 minuter.

Båda måste säga ja. Ett nej vinner alltid.

## Säkerhet

**Agenten har full kontroll över värdens Docker-daemon.** Det motsvarar
root-åtkomst till servern. Token är det enda som står mellan hubben och den
makten.

- Använd `wss://` med ett giltigt certifikat. Exponera aldrig hubben utan TLS.
- Token skickas i WebSocket-meddelandets body, aldrig i URL:en, så den hamnar
  inte i access- eller proxyloggar.
- `.env` skapas med `chmod 600`. Håll den så.
- Hubben kan bara begära operationer ur en fast lista. Den kan inte skicka
  godtyckliga kommandon, och inga sökvägar accepteras som argument —
  compose- och Dockerfile-sökvägar slås upp här, ur containerns egna labels.
- Kör med `HARBOR_READ_ONLY=true` på servrar du bara vill övervaka.

## Felsökning

```sh
cd /opt/harbor-agent && docker compose logs -f harbor-agent
```

| Loggrad | Betydelse |
|---|---|
| `ansluten till hubben` | Allt fungerar. |
| `hubben nekade åtkomst (4403 ...)` | Fel server-ID eller token. Skapa en ny installationskod. |
| `frånkopplad (...), återansluter om ...` | Normalt vid nätverksavbrott; agenten backar av upp till 30 s. |
| `KUNDE INTE spara token` | `/data`-volymen saknas eller är skrivskyddad. |

## Bygga imagen

Build-contexten måste vara **repots rot**, eftersom agenten delar kod med
hubben i `shared/`:

```sh
docker build -f agent/Dockerfile -t docker-harbor-agent:latest .
```
