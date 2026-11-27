// Lê as planilhas de rastreamento de cada vendedor(a).
// Modo 1 (recomendado): conta de serviço Google + ID da pasta do Drive -> descobre as planilhas sozinho.
// Modo 2 (sem Google Cloud): PUBLIC_SHEETS="Nome=ID;Nome=ID" com as planilhas compartilhadas por link.
import { GoogleAuth } from 'google-auth-library';
import { db, tx } from './db.js';
import { slugify, titleCase, emailKey, phoneKey, digits, parseDate, nowIso } from './util.js';

export const syncState = { lastSync: null, lastError: null, mode: null, sheets: 0, contacts: 0 };

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(txt);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds;
}

let authClient = null;
async function getClient() {
  if (authClient) return authClient;
  const credentials = loadCredentials();
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  authClient = await auth.getClient();
  return authClient;
}

export function serviceAccountEmail() {
  try {
    return loadCredentials()?.client_email || null;
  } catch {
    return null;
  }
}

/** "Rastreamento de vendas TMB | COMERCIAL JÉSSICA" -> "Jéssica" */
export function sellerNameFromTitle(title) {
  const m = String(title).match(/comercial\s*[-:|]?\s*(.+)$/i);
  return titleCase((m ? m[1] : title).replace(/[|_-]+/g, ' ').trim());
}

/** Lê uma linha sem depender da ordem das colunas (algumas linhas vêm sem e-mail e as colunas "andam"). */
export function parseRow(cells) {
  const c = cells.map((x) => (x ?? '').toString().trim()).filter((x) => x !== '');
  if (!c.length) return null;
  let name = null, email = null, phone = null, platform = null, date = null;
  for (const v of c) {
    if (!email && v.includes('@')) { email = emailKey(v); continue; }
    if (!platform && /^(hubla|tmb)$/i.test(v)) { platform = v.toLowerCase(); continue; }
    if (!date && /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(v)) { date = v; continue; }
    if (/^(sim|n[aã]o|ok)$/i.test(v)) continue;
    const d = digits(v);
    if (!phone && d.length >= 8 && d.length <= 14 && !/[a-z]/i.test(v)) { phone = phoneKey(v); continue; }
    if (!name && /\p{L}/u.test(v)) name = v;
  }
  if (!email && !phone) return null;
  if (name && /^nome$/i.test(name)) return null;
  let iso = null;
  if (date) {
    const full = /\/\d{2,4}$/.test(date.replace(/^\d{1,2}\/\d{1,2}/, '')) ? date : `${date}/${new Date().getFullYear()}`;
    iso = parseDate(full);
  }
  return { name, email, phone8: phone, platform, date: iso };
}

async function listFromDrive() {
  const client = await getClient();
  const folder = process.env.DRIVE_FOLDER_ID;
  const q = `'${folder}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const res = await client.request({
    url: 'https://www.googleapis.com/drive/v3/files',
    params: { q, fields: 'files(id,name)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true },
  });
  const out = [];
  for (const f of res.data.files || []) {
    const v = await client.request({
      url: `https://sheets.googleapis.com/v4/spreadsheets/${f.id}/values/${encodeURIComponent('A1:Z5000')}`,
    });
    out.push({ name: sellerNameFromTitle(f.name), sheetId: f.id, rows: v.data.values || [] });
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function listFromPublic() {
  const out = [], failed = [];
  for (const part of process.env.PUBLIC_SHEETS.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [name, id] = part.split('=').map((s) => s.trim());
    try {
      const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) throw new Error(`HTTP ${r.status}`);
      out.push({ name: titleCase(name), sheetId: id, rows: parseCsv(text) });
    } catch (e) {
      failed.push(`${titleCase(name)} (${e.message})`);
    }
  }
  syncState.failed = failed;
  if (failed.length) console.error(`[sheets] não abriram (não estão como "qualquer pessoa com o link"): ${failed.join(', ')}`);
  if (!out.length) throw new Error(`Nenhuma planilha abriu sem login: ${failed.join(', ')}`);
  return out;
}

// Modo 3 (sem Google Cloud): Web App do Apps Script na conta de quem tem acesso à pasta
async function listFromScript() {
  const url = new URL(process.env.SHEETS_SCRIPT_URL);
  if (process.env.SHEETS_SCRIPT_KEY) url.searchParams.set('key', process.env.SHEETS_SCRIPT_KEY);
  const r = await fetch(url, { redirect: 'follow' });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`O Apps Script não devolveu JSON (HTTP ${r.status}). Confira se foi implantado como app da Web com acesso "Qualquer pessoa".`);
  }
  if (data.error) throw new Error(`Apps Script: ${data.error}`);
  return (data.sheets || []).map((sh) => ({ name: sellerNameFromTitle(sh.name), sheetId: sh.id, rows: sh.rows || [] }));
}

export function sheetsConfigured() {
  if (process.env.SHEETS_SCRIPT_URL) return 'script';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.DRIVE_FOLDER_ID) return 'drive';
  if (process.env.PUBLIC_SHEETS) return 'public';
  return null;
}

/** Busca as planilhas, atualiza vendedores e contatos. */
export async function syncSheets() {
  const mode = sheetsConfigured();
  syncState.mode = mode;
  if (!mode) return { ok: false, error: 'Planilhas não configuradas' };
  try {
    const sheets = mode === 'script' ? await listFromScript() : mode === 'drive' ? await listFromDrive() : await listFromPublic();
    let contacts = 0;
    tx(() => {
      db.exec('DELETE FROM contacts');
      const upSeller = db.prepare(`INSERT INTO sellers(slug, name, sheet_id, origin) VALUES(?, ?, ?, 'planilha')
        ON CONFLICT(slug) DO UPDATE SET sheet_id = excluded.sheet_id, origin = 'planilha'`);
      const insC = db.prepare('INSERT INTO contacts(seller_slug, name, email, phone8, platform, date) VALUES(?, ?, ?, ?, ?, ?)');
      for (const sh of sheets) {
        const slug = slugify(sh.name);
        upSeller.run(slug, sh.name, sh.sheetId);
        for (const r of sh.rows) {
          const p = parseRow(r);
          if (!p) continue;
          insC.run(slug, p.name, p.email, p.phone8, p.platform, p.date);
          contacts++;
        }
      }
    });
    Object.assign(syncState, { lastSync: nowIso(), lastError: null, sheets: sheets.length, contacts });
    if (syncState.contacts !== syncState._lastLogged) { console.log(`[sheets] ${sheets.length} planilhas lidas, ${contacts} contatos`); syncState._lastLogged = contacts; }
    return { ok: true, sheets: sheets.length, contacts };
  } catch (e) {
    authClient = null;
    const msg = e?.response?.data?.error?.message || e.message;
    syncState.lastError = msg;
    console.error('[sheets] erro:', msg);
    return { ok: false, error: msg };
  }
}
