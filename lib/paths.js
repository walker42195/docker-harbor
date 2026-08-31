'use strict';

const fs = require('fs');
const path = require('path');

// All muterbar data samlas i EN katalog, så den kan monteras som en enda
// persistent volym. Enskilda bind-monterade filer undviks medvetet: finns
// filen inte på värden skapar Docker en katalog med samma namn, och då kan
// inget någonsin sparas.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REPO_ROOT = path.join(__dirname, '..');

let ensured = false;

function ensureDataDir() {
  if (ensured) return DATA_DIR;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    ensured = true;
  } catch (err) {
    console.error(`Kunde inte skapa datakatalogen ${DATA_DIR}:`, err.message);
  }
  return DATA_DIR;
}

// Returnerar sökvägen till en datafil, och flyttar in en eventuell gammal
// kopia från repots rot första gången. Migreringen är icke-destruktiv:
// originalet lämnas kvar orört så en rollback fortfarande fungerar.
function dataFile(filename) {
  ensureDataDir();
  const target = path.join(DATA_DIR, filename);
  if (fs.existsSync(target)) return target;

  const legacy = path.join(REPO_ROOT, filename);
  try {
    if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) {
      fs.copyFileSync(legacy, target);
      console.log(`Migrerade ${filename} till ${DATA_DIR}/ (originalet lämnades kvar).`);
    }
  } catch (err) {
    console.error(`Kunde inte migrera ${filename}:`, err.message);
  }
  return target;
}

module.exports = { DATA_DIR, ensureDataDir, dataFile };
