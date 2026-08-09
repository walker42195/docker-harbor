# Docker Harbor ⚓️ 🐳

Ett modernt, snabbt och stilrent webbgränssnitt för att hantera och övervaka Docker-containers på värddatorn i realtid.

## Funktioner

- 🔐 **Säker inloggning**: JWT-baserad autentisering.
- 📊 **Realtidsöversikt**: Se alla containers (köra, stoppade, pausade), systemresurser och Docker Engine-status.
- ⚡️ **Full Container Control**:
  - **Starta**: Starta stoppade containers.
  - **Stoppa**: Stoppa aktiva containers med graceful shutdown.
  - **Starta Om**: Snabb omstart.
  - **Bygg Om (Rebuild)**: Hämtar nyaste imagen och skapar om containern med bevarad konfiguration.
  - **Ta Bort**: Ta bort containers med tillval för `--force` och volymrensning (`-v`).
- 📜 **Live Loggar (WebSocket)**: Realtidsströmning av container-loggar direkt i webbläsaren.
- 🔍 **Inspektera**: Se fullständig JSON-konfiguration (miljövariabler, nätverk, mount-sökvägar).
- 🧹 **System Prune**: Enklicksrensning av oanvända containers och images.
- 🌐 **Port**: Förkonfigurerad för port `6969`, kan publiceras via t.ex. Cloudflare Tunnel eller reverse proxy.

## Bygg & Kör med Docker Compose

```bash
docker compose up -d --build
```

Webbsidan nås på `http://localhost:6969` (eller din publicerade domän, om du satt upp en).

Standardinloggning:
- **Användarnamn**: `admin`
- **Lösenord**: `admin` (eller inställt i `.env`)
