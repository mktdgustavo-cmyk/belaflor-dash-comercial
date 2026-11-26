export const TZ = 'America/Sao_Paulo';

export const norm = (s) =>
  (s ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

export const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const digits = (s) => (s ?? '').toString().replace(/\D/g, '');

// Compara telefones pelos últimos 8 dígitos (ignora DDI, DDD e o 9 extra)
export const phoneKey = (s) => {
  const d = digits(s);
  return d.length >= 8 ? d.slice(-8) : null;
};

export const emailKey = (s) => {
  const e = norm(s).replace(/\s/g, '');
  return /^[^@]+@[^@]+\.[^@]+$/.test(e) ? e : null;
};

export const titleCase = (s) =>
  (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase());

/** Converte vários formatos de data em ISO UTC. Sem fuso => assume horário de Brasília. */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString();
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m;
    const zone = tz ? (tz === 'Z' ? 'Z' : tz.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '-03:00';
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`);
    return isNaN(dt) ? null : dt.toISOString();
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    let [, d, mo, y, h = '00', mi = '00', se = '00'] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se}-03:00`);
    return isNaN(dt) ? null : dt.toISOString();
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt.toISOString();
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD no horário de Brasília */
export const dayKey = (iso) => dayFmt.format(iso ? new Date(iso) : new Date());

/** Início do dia (Brasília) em ISO UTC */
export const dayStartIso = (ymd) => new Date(`${ymd}T00:00:00-03:00`).toISOString();

export const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d.toISOString());
};

export const nowIso = () => new Date().toISOString();
