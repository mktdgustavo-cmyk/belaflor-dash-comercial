// Decide de qual vendedor(a) é cada venda.
// Prioridade: manual > UTM > campo "vendedor" da plataforma > planilha (e-mail, depois telefone)
import { db, tx } from './db.js';
import { norm, emailKey, phoneKey } from './util.js';

const UTM_ORDER = ['utm_source', 'utm_content', 'utm_term', 'utm_medium', 'utm_campaign', 'src', 'sck'];

export function buildIndex() {
  const sellers = db.prepare('SELECT * FROM sellers WHERE active = 1').all();
  const aliasList = sellers.map((s) => ({
    slug: s.slug,
    aliases: [...new Set([s.slug, norm(s.name), ...String(s.aliases || '').split(',').map(norm)].filter(Boolean))],
  }));

  const byEmail = new Map();
  const byPhone = new Map();
  const push = (map, key, c) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (!arr.some((x) => x.slug === c.seller_slug)) arr.push({ slug: c.seller_slug, date: c.date || '' });
  };
  for (const c of db.prepare('SELECT * FROM contacts').all()) {
    push(byEmail, c.email, c);
    push(byPhone, c.phone8, c);
  }
  return { aliasList, byEmail, byPhone, sellers };
}

function matchUtm(utms, aliasList) {
  const keys = [...UTM_ORDER, ...Object.keys(utms).filter((k) => !UTM_ORDER.includes(k))];
  for (const k of keys) {
    const v = norm(utms[k]);
    if (!v) continue;
    const parts = v.split(/[^a-z0-9]+/).filter(Boolean);
    for (const s of aliasList) {
      for (const a of s.aliases) {
        const simple = /^[a-z0-9]+$/.test(a);
        if (v === a || (simple ? parts.includes(a) : v.includes(a))) return { slug: s.slug, note: `${k}=${utms[k]}` };
      }
    }
  }
  return null;
}

function pickCandidate(cands) {
  // Mesmo contato em mais de uma planilha: fica com quem cadastrou primeiro e anota o conflito
  const sorted = [...cands].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const note = cands.length > 1 ? `conflito na planilha: ${cands.map((c) => c.slug).join(', ')}` : null;
  return { slug: sorted[0].slug, note };
}

export function attribute(sale, idx) {
  if (sale.seller_source === 'manual') return { slug: sale.seller_slug, source: 'manual', note: sale.seller_note };

  let utms = {};
  try {
    utms = typeof sale.utms === 'string' ? JSON.parse(sale.utms || '{}') : sale.utms || {};
  } catch {}
  const u = matchUtm(utms, idx.aliasList);
  if (u) return { slug: u.slug, source: 'utm', note: u.note };

  if (sale.vendor_hint) {
    const h = norm(sale.vendor_hint);
    const s = idx.aliasList.find((x) => x.aliases.some((a) => h === a || h.split(/[^a-z0-9]+/).includes(a)));
    if (s) return { slug: s.slug, source: 'plataforma', note: `vendedor=${sale.vendor_hint}` };
  }

  const e = emailKey(sale.email);
  if (e && idx.byEmail.has(e)) {
    const p = pickCandidate(idx.byEmail.get(e));
    return { slug: p.slug, source: 'planilha', note: p.note || 'e-mail na planilha' };
  }
  const ph = phoneKey(sale.phone);
  if (ph && idx.byPhone.has(ph)) {
    const p = pickCandidate(idx.byPhone.get(ph));
    return { slug: p.slug, source: 'planilha', note: p.note || 'telefone na planilha' };
  }
  return { slug: null, source: null, note: null };
}

/** Recalcula a atribuição de todas as vendas não-manuais. Retorna quantas mudaram. */
export function reattributeAll() {
  const idx = buildIndex();
  const rows = db.prepare("SELECT * FROM sales WHERE seller_source IS NULL OR seller_source != 'manual'").all();
  const upd = db.prepare('UPDATE sales SET seller_slug = ?, seller_source = ?, seller_note = ? WHERE id = ?');
  let changed = 0;
  tx(() => {
    for (const s of rows) {
      const a = attribute(s, idx);
      if (a.slug !== s.seller_slug || a.source !== s.seller_source || a.note !== s.seller_note) {
        upd.run(a.slug, a.source, a.note, s.id);
        changed++;
      }
    }
  });
  return changed;
}
