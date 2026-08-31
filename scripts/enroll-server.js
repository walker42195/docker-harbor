#!/usr/bin/env node
'use strict';

// CLI-alternativ till "Lägg till server" i gränssnittet.
//
//   node scripts/enroll-server.js <id> "<Visningsnamn>" [--host <adress>]
//   node scripts/enroll-server.js <id> --rotate
//   node scripts/enroll-server.js --list

const { Registry } = require('../lib/registry');

const args = process.argv.slice(2);
const registry = new Registry();

function usage() {
  console.log(`
Användning:
  node scripts/enroll-server.js <id> "<Visningsnamn>" [--host <adress>]
      Registrerar en ny server och skriver ut en installationskod.

  node scripts/enroll-server.js <id> --enroll
      Skapar en ny installationskod för en befintlig server.

  node scripts/enroll-server.js <id> --rotate
      Skapar en ny permanent token (skriv in den i agentens .env).

  node scripts/enroll-server.js --list
      Listar registrerade servrar.
`);
}

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

if (args[0] === '--list') {
  for (const s of registry.list()) {
    const state = s.type === 'local' ? 'lokal'
      : (s.tokenHash ? 'enrollad' : 'väntar på enrollment');
    console.log(`${s.id.padEnd(20)} ${String(s.name).padEnd(28)} ${state}`);
  }
  process.exit(0);
}

const id = args[0];
if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
  console.error('Ogiltigt server-ID. Använd 2-32 tecken: a-z, 0-9, bindestreck eller understreck.');
  process.exit(1);
}

const rotate = args.includes('--rotate');
const enrollOnly = args.includes('--enroll');
const hostIdx = args.indexOf('--host');
const publicHost = hostIdx !== -1 ? args[hostIdx + 1] : null;
const name = args[1] && !args[1].startsWith('--') ? args[1] : id;

if (rotate) {
  if (!registry.get(id)) {
    console.error(`Okänd server: ${id}`);
    process.exit(1);
  }
  const token = registry.rotateToken(id);
  console.log(`\nNy permanent token för "${id}" (visas bara en gång):\n`);
  console.log(`  HARBOR_TOKEN=${token}\n`);
  console.log('Skriv in den i /opt/harbor-agent/.env på servern och kör "docker compose up -d".\n');
  process.exit(0);
}

if (!registry.get(id)) {
  if (enrollOnly) {
    console.error(`Okänd server: ${id}`);
    process.exit(1);
  }
  registry.add({ id, name, publicHost });
  console.log(`Servern "${name}" (${id}) lades till.`);
}

const { code, expires } = registry.issueEnrollCode(id);
const base = process.env.HARBOR_PUBLIC_URL || 'https://DIN-HUBB-ADRESS';

console.log(`\nKör detta på servern som ska anslutas (gäller till ${new Date(expires).toLocaleString('sv-SE')}):\n`);
console.log(`  curl -fsSL ${base}/install/${code} | sh\n`);
console.log('Koden kan bara användas en gång. Sätt HARBOR_PUBLIC_URL för rätt adress i utskriften.\n');
