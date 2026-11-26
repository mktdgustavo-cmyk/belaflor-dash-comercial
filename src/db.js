import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'dash.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,           -- hubla | tmb | manual
  external_id   TEXT NOT NULL,
  status        TEXT NOT NULL,           -- aprovada | cancelada | reembolsada
  customer_name TEXT,
  email         TEXT,
  phone         TEXT,
  product       TEXT,
  amount        REAL DEFAULT 0,
  sold_at       TEXT NOT NULL,
  utms          TEXT DEFAULT '{}',
  vendor_hint   TEXT,
  seller_slug   TEXT,
  seller_source TEXT,                    -- utm | plataforma | planilha | manual
  seller_note   TEXT,
  ignored       INTEGER DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT,
  UNIQUE(platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT,
  type        TEXT,
  received_at TEXT,
  result      TEXT,
  payload     TEXT
);

CREATE TABLE IF NOT EXISTS sellers (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  sheet_id TEXT,
  aliases  TEXT DEFAULT '',
  active   INTEGER DEFAULT 1,
  origin   TEXT DEFAULT 'manual'          -- planilha | manual
);

CREATE TABLE IF NOT EXISTS contacts (
  seller_slug TEXT,
  name        TEXT,
  email       TEXT,
  phone8      TEXT,
  platform    TEXT,
  date        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const DEFAULT_SETTINGS = {
  titulo: 'Dash Comercial',
  meta_geral: 0,
  meta_comercial: 0,
  unidade: 'vendas', // vendas | faturamento
  faixa_minimo: 120,
  faixa_otimo: 150,
  faixa_extra: 180,
  inicio: '', // YYYY-MM-DD (vazio = desde sempre)
  fim: '', // YYYY-MM-DD (vazio = hoje)
  produtos: '', // palavras-chave separadas por vírgula (vazio = todos)
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      s[r.key] = r.value;
    }
  }
  return s;
}

export function saveSettings(patch) {
  const st = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const num = typeof DEFAULT_SETTINGS[k] === 'number';
      st.run(k, JSON.stringify(num ? Number(v) || 0 : String(v ?? '')));
    }
  });
  return getSettings();
}
