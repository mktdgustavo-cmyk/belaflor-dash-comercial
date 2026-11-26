import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, getSettings, saveSettings } from './db.js';
import { normalizeHubla, normalizeTmb } from './normalize.js';
import { attribute, buildIndex, reattributeAll } from './attribution.js';
import { syncSheets, syncState, sheetsConfigured, serviceAccountEmail } from './sheets.js';
import { norm, slugify, dayKey, dayStartIso, addDays, nowIso, parseDate } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || 'dash';
const SYNC_SECONDS = Math.max(30, Number(process.env.SYNC_INTERVAL_SECONDS || 120));

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* --------------------------------- auth --------------------------------- */
const tokenFor = (role, pwd) => crypto.createHash('sha256').update(`${SECRET}|${role}|${pwd}`).digest('hex');
const cookies = (req) =>
  Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

function roleOf(req) {
  const t = cookies(req).dash_auth;
  if (ADMIN_PASSWORD && t === tokenFor('admin', ADMIN_PASSWORD)) return 'admin';
  if (VIEW_PASSWORD && t === tokenFor('viewer', VIEW_PASSWORD)) return 'viewer';
  if (!VIEW_PASSWORD) return 'viewer';
  return null;
}
const needView = (req, res, next) => (roleOf(req) ? next() : res.status(401).json({ error: 'login' }));
const needAdmin = (req, res, next) => (roleOf(req) === 'admin' ? next() : res.status(403).json({ error: 'admin' }));

app.post('/api/login', (req, res) => {
  const pwd = String(req.body?.password || '');
  let role = null;
  if (ADMIN_PASSWORD && pwd === ADMIN_PASSWORD) role = 'admin';
  else if (VIEW_PASSWORD && pwd === VIEW_PASSWORD) role = 'viewer';
  if (!role) return res.status(401).json({ error: 'Senha incorreta' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `dash_auth=${tokenFor(role, pwd)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure}`);
  res.json({ role });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'dash_auth=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ role: roleOf(req), adminEnabled: !!ADMIN_PASSWORD, titulo: getSettings().titulo }));

/* ------------------------------ tempo real (SSE) ------------------------------ */
const clients = new Set();
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
app.get('/api/stream', needView, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

/* -------------------------------- webhooks -------------------------------- */
function tokenOk(req, expected) {
  if (!expected) return true;
  const h = req.headers;
  const candidates = [
    h['x-hubla-token'], h['x-tmb-key'], h['x-webhook-token'], h['x-api-key'], h['token'], h['x-token'],
    String(h['authorization'] || '').replace(/^Bearer\s+/i, ''), req.query.token,
  ];
  return candidates.some((c) => c && String(c) === expected);
}

const insertSale = db.prepare(`INSERT INTO sales
  (platform, external_id, status, customer_name, email, phone, product, amount, sold_at, utms, vendor_hint, seller_slug, seller_source, seller_note, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function upsertSale(sale, opts = {}) {
  const ex = db.prepare('SELECT * FROM sales WHERE platform = ? AND external_id = ?').get(sale.platform, sale.external_id);
  const now = nowIso();
  if (!ex) {
    const a = attribute({ ...sale, utms: sale.utms }, opts.idx || buildIndex());
    const r = insertSale.run(
      sale.platform, sale.external_id, sale.status, sale.customer_name, sale.email, sale.phone, sale.product,
      sale.amount, sale.sold_at, JSON.stringify(sale.utms || {}), sale.vendor_hint, a.slug, a.source, a.note, now, now,
    );
    if (opts.silent) return { created: true, seller: a.slug, source: a.source };
    const seller = a.slug ? db.prepare('SELECT name FROM sellers WHERE slug = ?').get(a.slug)?.name : null;
    broadcast('sale', { id: Number(r.lastInsertRowid), status: sale.status, platform: sale.platform, customer: sale.customer_name, amount: sale.amount, seller });
    return { created: true, seller: a.slug, source: a.source };
  }
  // Na importação, um arquivo antigo não pode reativar venda que já foi cancelada/reembolsada
  if (ex.status !== sale.status && !(opts.noRevive && sale.status === 'aprovada')) {
    db.prepare('UPDATE sales SET status = ?, updated_at = ? WHERE id = ?').run(sale.status, now, ex.id);
    if (opts.silent) return { updated: true, status: sale.status };
    broadcast('sale', { id: ex.id, status: sale.status, platform: sale.platform, customer: ex.customer_name, amount: ex.amount });
    return { updated: true, status: sale.status };
  }
  return { duplicate: true };
}

function logEvent(platform, type, result, payload) {
  db.prepare('INSERT INTO events(platform, type, received_at, result, payload) VALUES(?, ?, ?, ?, ?)').run(
    platform, String(type || '-'), nowIso(), JSON.stringify(result), JSON.stringify(payload).slice(0, 100000),
  );
}

function webhook(platform, normalizer, expected) {
  return (req, res) => {
    if (!tokenOk(req, expected)) {
      logEvent(platform, 'token inválido', { error: 'token inválido' }, { headers: Object.keys(req.headers) });
      return res.status(401).json({ error: 'token inválido' });
    }
    const body = req.body || {};
    const type = platform === 'hubla' ? body.type : body.status_pedido || body.status;
    let result;
    try {
      const n = normalizer(body);
      result = n.action === 'upsert' ? upsertSale(n.sale) : { ignored: n.reason };
    } catch (e) {
      console.error(`[${platform}]`, e);
      result = { error: e.message };
    }
    logEvent(platform, type, result, body);
    res.json({ ok: true, ...result });
  };
}
app.post('/webhook/hubla', webhook('hubla', normalizeHubla, process.env.HUBLA_TOKEN || process.env.WEBHOOK_TOKEN));
app.post('/webhook/tmb', webhook('tmb', normalizeTmb, process.env.TMB_TOKEN || process.env.WEBHOOK_TOKEN));

/* ------------------------------ dados do dash ------------------------------ */
function period(q, st) {
  const today = dayKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : st.inicio || '2000-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : st.fim || today;
  return { from, to, today, fromIso: dayStartIso(from), toIso: dayStartIso(addDays(to, 1)) };
}
const keywords = (st) => String(st.produtos || '').split(',').map(norm).filter(Boolean);
const counts = (s, kw) => s.status === 'aprovada' && !s.ignored && (!kw.length || kw.some((k) => norm(s.product).includes(k)));
const loadSales = (p) => db.prepare('SELECT * FROM sales WHERE sold_at >= ? AND sold_at < ? ORDER BY sold_at DESC').all(p.fromIso, p.toIso);
const sellersMap = () => Object.fromEntries(db.prepare('SELECT * FROM sellers').all().map((s) => [s.slug, s]));

function tierOf(count, st) {
  if (count >= st.faixa_extra) return 'extraordinario';
  if (count >= st.faixa_otimo) return 'otimo';
  if (count >= st.faixa_minimo) return 'minimo';
  return 'abaixo';
}

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = String(e).split('@');
  return `${u.slice(0, 3)}***@${d || ''}`;
}
function maskPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  return d.length > 4 ? `•••• ${d.slice(-4)}` : p;
}

function presentSale(s, sellers, kw, admin) {
  let utms = {};
  try { utms = JSON.parse(s.utms || '{}'); } catch {}
  return {
    id: s.id,
    platform: s.platform,
    external_id: s.external_id,
    status: s.status,
    counted: counts(s, kw),
    ignored: !!s.ignored,
    customer: s.customer_name,
    email: admin ? s.email : maskEmail(s.email),
    phone: admin ? s.phone : maskPhone(s.phone),
    product: s.product,
    amount: s.amount,
    sold_at: s.sold_at,
    seller_slug: s.seller_slug,
    seller: s.seller_slug ? sellers[s.seller_slug]?.name || s.seller_slug : null,
    seller_source: s.seller_source,
    seller_note: s.seller_note,
    utms: admin ? utms : undefined,
  };
}

app.get('/api/summary', needView, (req, res) => {
  const st = getSettings();
  const p = period(req.query, st);
  const kw = keywords(st);
  const sellers = sellersMap();
  const sales = loadSales(p).filter((s) => counts(s, kw));
  const valueOf = (arr) => (st.unidade === 'faturamento' ? arr.reduce((a, s) => a + (s.amount || 0), 0) : arr.length);
  const agg = (arr) => ({ count: arr.length, revenue: arr.reduce((a, s) => a + (s.amount || 0), 0), value: valueOf(arr) });
  const com = sales.filter((s) => s.seller_slug);
  const isToday = (s) => dayKey(s.sold_at) === p.today;

  const ranking = Object.values(sellers)
    .filter((s) => s.active)
    .map((s) => {
      const mine = com.filter((x) => x.seller_slug === s.slug);
      return { slug: s.slug, name: s.name, ...agg(mine), today: mine.filter(isToday).length, tier: tierOf(mine.length, st) };
    })
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue);

  res.json({
    period: p,
    settings: { titulo: st.titulo, meta_geral: st.meta_geral, meta_comercial: st.meta_comercial, unidade: st.unidade, faixas: { minimo: st.faixa_minimo, otimo: st.faixa_otimo, extra: st.faixa_extra } },
    geral: { ...agg(sales), today: sales.filter(isToday).length },
    comercial: { ...agg(com), today: com.filter(isToday).length },
    semVendedor: sales.length - com.length,
    plataformas: { hubla: agg(sales.filter((s) => s.platform === 'hubla')), tmb: agg(sales.filter((s) => s.platform === 'tmb')) },
    ranking,
    sync: { ...syncState, configured: sheetsConfigured() },
    updatedAt: nowIso(),
  });
});

app.get('/api/sales', needView, (req, res) => {
  const st = getSettings();
  const p = period(req.query, st);
  const kw = keywords(st);
  const admin = roleOf(req) === 'admin';
  const sellers = sellersMap();
  const q = norm(req.query.q || '');
  let rows = loadSales(p);
  if (req.query.platform && req.query.platform !== 'todas') rows = rows.filter((s) => s.platform === req.query.platform);
  if (req.query.seller === 'comercial') rows = rows.filter((s) => s.seller_slug);
  else if (req.query.seller === 'sem') rows = rows.filter((s) => !s.seller_slug);
  else if (req.query.seller) rows = rows.filter((s) => s.seller_slug === req.query.seller);
  if (req.query.status !== 'todas') rows = rows.filter((s) => counts(s, kw));
  if (q) rows = rows.filter((s) => [s.customer_name, s.email, s.phone, s.product, s.external_id].some((v) => norm(v).includes(q)));
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  res.json({ total: rows.length, sales: rows.slice(0, limit).map((s) => presentSale(s, sellers, kw, admin)) });
});

app.get('/api/sellers', needView, (req, res) => {
  res.json(db.prepare('SELECT slug, name FROM sellers WHERE active = 1 ORDER BY name').all());
});

app.get('/api/seller/:slug', needView, (req, res) => {
  const st = getSettings();
  const p = period(req.query, st);
  const kw = keywords(st);
  const sellers = sellersMap();
  const seller = sellers[req.params.slug];
  if (!seller) return res.status(404).json({ error: 'Vendedor(a) não encontrado(a)' });
  const admin = roleOf(req) === 'admin';
  const mine = loadSales(p).filter((s) => s.seller_slug === seller.slug && counts(s, kw));

  // vendas por dia (no máximo 45 dias, terminando no fim do período)
  const firstDay = mine.length ? dayKey(mine[mine.length - 1].sold_at) : p.to;
  const minStart = addDays(p.to > p.today ? p.today : p.to, -44);
  let start = p.from;
  if (start < minStart) start = firstDay > minStart ? firstDay : minStart;
  const end = p.to > p.today ? p.today : p.to;
  const byDay = [];
  for (let d = start; d <= end; d = addDays(d, 1)) byDay.push({ day: d, count: 0 });
  for (const s of mine) {
    const k = dayKey(s.sold_at);
    const row = byDay.find((x) => x.day === k);
    if (row) row.count++;
  }
  const daysActive = byDay.length || 1;
  res.json({
    seller: { slug: seller.slug, name: seller.name },
    period: p,
    faixas: { minimo: st.faixa_minimo, otimo: st.faixa_otimo, extra: st.faixa_extra },
    count: mine.length,
    revenue: mine.reduce((a, s) => a + (s.amount || 0), 0),
    today: mine.filter((s) => dayKey(s.sold_at) === p.today).length,
    mediaDia: mine.length / daysActive,
    tier: tierOf(mine.length, st),
    porPlataforma: { hubla: mine.filter((s) => s.platform === 'hubla').length, tmb: mine.filter((s) => s.platform === 'tmb').length },
    byDay,
    sales: mine.map((s) => presentSale(s, sellers, kw, admin)),
  });
});

/* --------------------------------- admin --------------------------------- */
app.get('/api/admin/config', needAdmin, (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    settings: getSettings(),
    sellers: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM contacts c WHERE c.seller_slug = s.slug) AS contatos FROM sellers s ORDER BY name`).all(),
    sync: { ...syncState, configured: sheetsConfigured(), serviceAccount: serviceAccountEmail(), interval: SYNC_SECONDS },
    webhooks: {
      hubla: `${base}/webhook/hubla`,
      tmb: `${base}/webhook/tmb`,
      hublaToken: !!(process.env.HUBLA_TOKEN || process.env.WEBHOOK_TOKEN),
      tmbToken: !!(process.env.TMB_TOKEN || process.env.WEBHOOK_TOKEN),
    },
  });
});

app.put('/api/admin/settings', needAdmin, (req, res) => {
  const s = saveSettings(req.body || {});
  broadcast('refresh');
  res.json(s);
});

app.post('/api/admin/sellers', needAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome' });
  const slug = slugify(name);
  db.prepare(`INSERT INTO sellers(slug, name, aliases, origin) VALUES(?, ?, ?, 'manual') ON CONFLICT(slug) DO UPDATE SET active = 1`).run(slug, name, String(req.body?.aliases || ''));
  const changed = reattributeAll();
  broadcast('refresh');
  res.json({ slug, changed });
});

app.put('/api/admin/sellers/:slug', needAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM sellers WHERE slug = ?').get(req.params.slug);
  if (!s) return res.status(404).json({ error: 'não encontrado' });
  const b = req.body || {};
  db.prepare('UPDATE sellers SET name = ?, aliases = ?, active = ? WHERE slug = ?').run(
    b.name ?? s.name, b.aliases ?? s.aliases, b.active === undefined ? s.active : b.active ? 1 : 0, s.slug,
  );
  const changed = reattributeAll();
  broadcast('refresh');
  res.json({ ok: true, changed });
});

app.post('/api/admin/sync', needAdmin, async (req, res) => {
  const r = await syncSheets();
  const changed = r.ok ? reattributeAll() : 0;
  broadcast('refresh');
  res.json({ ...r, changed });
});

app.patch('/api/admin/sales/:id', needAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'não encontrada' });
  const b = req.body || {};
  if (b.ignored !== undefined) db.prepare('UPDATE sales SET ignored = ? WHERE id = ?').run(b.ignored ? 1 : 0, s.id);
  if (b.seller !== undefined) {
    if (b.seller === 'auto') {
      const a = attribute({ ...s, seller_source: null }, buildIndex());
      db.prepare('UPDATE sales SET seller_slug = ?, seller_source = ?, seller_note = ? WHERE id = ?').run(a.slug, a.source, a.note, s.id);
    } else {
      const slug = b.seller === '-' ? null : String(b.seller);
      db.prepare("UPDATE sales SET seller_slug = ?, seller_source = 'manual', seller_note = 'definido manualmente' WHERE id = ?").run(slug, s.id);
    }
  }
  broadcast('refresh');
  res.json({ ok: true });
});

// Importação de vendas antigas (linhas já mapeadas no navegador a partir do CSV exportado)
app.post('/api/admin/import', needAdmin, (req, res) => {
  const platform = String(req.body?.platform || '');
  if (!['hubla', 'tmb'].includes(platform)) return res.status(400).json({ error: 'Escolha Hubla ou TMB' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nenhuma linha para importar' });
  const idx = buildIndex();
  const out = { created: 0, updated: 0, duplicate: 0, skipped: 0, errors: [] };
  tx(() => {
    rows.forEach((r, i) => {
      try {
        if (!['aprovada', 'cancelada', 'reembolsada'].includes(r.status)) { out.skipped++; return; }
        const externalId = String(r.external_id || '').trim();
        if (!externalId) { out.skipped++; return; }
        const amount = Number(r.amount);
        const sale = {
          platform,
          external_id: externalId,
          status: r.status,
          customer_name: r.customer_name ? String(r.customer_name).slice(0, 200) : null,
          email: r.email ? String(r.email).trim().slice(0, 200) : null,
          phone: r.phone ? String(r.phone).slice(0, 40) : null,
          product: r.product ? String(r.product).slice(0, 200) : null,
          amount: Number.isFinite(amount) ? amount : 0,
          sold_at: parseDate(r.sold_at) || nowIso(),
          utms: r.utms && typeof r.utms === 'object' ? r.utms : {},
          vendor_hint: r.vendor_hint ? String(r.vendor_hint).slice(0, 100) : null,
        };
        const result = upsertSale(sale, { idx, silent: true, noRevive: true });
        if (result.created) out.created++;
        else if (result.updated) out.updated++;
        else out.duplicate++;
      } catch (e) {
        if (out.errors.length < 10) out.errors.push(`linha ${i + 2}: ${e.message}`);
      }
    });
  });
  logEvent(platform, 'importação CSV', out, { linhas: rows.length });
  broadcast('refresh');
  res.json(out);
});

app.get('/api/admin/events', needAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 50, 300));
  res.json(rows.map((r) => ({ ...r, result: JSON.parse(r.result || '{}'), payload: JSON.parse(r.payload || '{}') })));
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* --------------------------- sincronização periódica --------------------------- */
async function runSync() {
  if (!sheetsConfigured()) return;
  const r = await syncSheets();
  if (r.ok) {
    const changed = reattributeAll();
    if (changed) broadcast('refresh');
  }
}
setInterval(runSync, SYNC_SECONDS * 1000);
setInterval(() => db.prepare('DELETE FROM events WHERE received_at < ?').run(new Date(Date.now() - 30 * 864e5).toISOString()), 6 * 3600e3);

app.listen(PORT, () => {
  console.log(`Dash comercial rodando na porta ${PORT}`);
  runSync();
});
