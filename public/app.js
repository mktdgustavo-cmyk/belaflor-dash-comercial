/* Dash Comercial — front-end sem build (vanilla JS) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const int = (n) => (Number(n) || 0).toLocaleString('pt-BR');
const dt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dShort = (ymd) => ymd.slice(8, 10) + '/' + ymd.slice(5, 7);
const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const TIER = { abaixo: 'Abaixo do mínimo', minimo: 'Mínimo', otimo: 'Ótimo', extraordinario: 'Extraordinário' };
const SRC = { utm: 'via UTM', planilha: 'via planilha', plataforma: 'via plataforma', manual: 'manual' };

const state = {
  role: null,
  period: localStorage.getItem('period') || 'campanha',
  from: localStorage.getItem('from') || '',
  to: localStorage.getItem('to') || '',
  f: { platform: 'todas', seller: '', q: '', status: '' },
  limit: 50,
  sellers: [],
  newIds: new Set(),
  summary: null,
};

/* ------------------------------- API ------------------------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { openLogin(false); throw new Error('login'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}
function periodQs() {
  if (state.period === 'hoje') { const t = todayYmd(); return `from=${t}&to=${t}`; }
  if (state.period === 'custom' && state.from && state.to) return `from=${state.from}&to=${state.to}`;
  return '';
}

/* ------------------------------- login ------------------------------- */
const dlg = $('#login');
function openLogin(asAdmin) {
  if (dlg.open) return;
  $('#login-msg').textContent = asAdmin ? 'Senha de administrador (metas, vendedores, atribuição).' : 'Digite a senha de acesso ao dash.';
  $('#login-cancel').hidden = !asAdmin;
  $('#login-err').textContent = '';
  $('#pwd').value = '';
  dlg.showModal();
}
$('#login-cancel').onclick = () => dlg.close();
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pwd').value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    dlg.close();
    await boot();
  } catch (err) { $('#login-err').textContent = err.message || 'Senha incorreta'; }
};
$('#login-btn').onclick = async () => {
  if (state.role === 'admin') {
    if (confirm('Sair do modo admin?')) { await fetch('/api/logout', { method: 'POST' }); location.hash = '#/'; boot(); }
  } else openLogin(true);
};

/* ------------------------------- período ------------------------------- */
function syncPeriodUi() {
  $$('#period .seg button').forEach((b) => b.classList.toggle('on', b.dataset.p === state.period));
  $('#custom').hidden = state.period !== 'custom';
  $('#from').value = state.from; $('#to').value = state.to;
}
$$('#period .seg button').forEach((b) => (b.onclick = () => {
  state.period = b.dataset.p;
  if (state.period === 'custom' && !state.from) { state.to = todayYmd(); state.from = state.to.slice(0, 8) + '01'; }
  localStorage.setItem('period', state.period);
  syncPeriodUi(); refresh();
}));
['from', 'to'].forEach((id) => ($('#' + id).onchange = (e) => { state[id] = e.target.value; localStorage.setItem(id, e.target.value); refresh(); }));

/* ------------------------------- tempo real ------------------------------- */
let es, refreshTimer;
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  es.addEventListener('sale', (e) => {
    const s = JSON.parse(e.data);
    if (s.status === 'aprovada') {
      state.newIds.add(s.id);
      toast(`Nova venda${s.seller ? ' · ' + s.seller : ''}`, `${s.customer || 'Cliente'} — ${s.platform.toUpperCase()} ${s.amount ? '· ' + brl(s.amount) : ''}`);
    } else toast(`Venda ${s.status}`, `${s.customer || 'Cliente'} — ${s.platform.toUpperCase()}`, true);
    scheduleRefresh();
  });
  es.addEventListener('refresh', scheduleRefresh);
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 350); }
setInterval(() => document.visibilityState === 'visible' && refresh(), 60000);

function toast(title, text, neg) {
  const el = document.createElement('div');
  el.className = 'toast' + (neg ? ' neg' : '');
  el.innerHTML = `<b>${esc(title)}</b><span class="muted">${esc(text)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

/* ------------------------------- roteamento ------------------------------- */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  return { page: page || 'geral', arg: arg ? decodeURIComponent(arg) : '' };
}
window.addEventListener('hashchange', () => render(true));

function setNav(page) {
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === page));
}

async function render(full) {
  const { page, arg } = route();
  setNav(page);
  $('#period').style.visibility = page === 'config' ? 'hidden' : 'visible';
  try {
    if (page === 'vendedor') await renderSeller(arg, full);
    else if (page === 'config') await renderConfig();
    else await renderGeral(full);
  } catch (e) {
    if (e.message !== 'login') $('#app').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
}
const refresh = () => (route().page === 'config' ? null : render(false));

/* ------------------------------- componentes ------------------------------- */
function meter(count, faixas, big) {
  const max = Math.max(faixas.extra * 1.12, count * 1.04, 1);
  const pct = (v) => Math.min(100, (v / max) * 100).toFixed(2);
  const marks = [faixas.minimo, faixas.otimo, faixas.extra].map((v) => `<span class="mark" style="left:${pct(v)}%"></span>`).join('');
  return `<div class="meter ${big ? 'big' : ''}" role="meter" aria-valuenow="${count}" aria-valuemax="${faixas.extra}"><i style="width:${pct(count)}%"></i>${marks}</div>` +
    (big ? `<div class="meter-labels">${[['Mínimo', faixas.minimo], ['Ótimo', faixas.otimo], ['Extraordinário', faixas.extra]].map(([l, v]) => `<span style="left:${pct(v)}%"><b>${v}</b>${l}</span>`).join('')}</div>` : '');
}
const tierTag = (t) => `<span class="tier ${t}">${TIER[t]}</span>`;

function salesTable(sales, opts = {}) {
  if (!sales.length) return `<div class="empty">Nenhuma venda por aqui ainda.</div>`;
  const admin = state.role === 'admin';
  const sellerOpts = (sale) => {
    const cur = sale.seller_slug;
    const forcedNone = !cur && sale.seller_source === 'manual';
    return `<option value="auto">${cur || forcedNone ? 'Automático' : '— Sem vendedor (auto) —'}</option><option value="-" ${forcedNone ? 'selected' : ''}>— Sem vendedor (fixo) —</option>` +
      state.sellers.map((s) => `<option value="${esc(s.slug)}" ${s.slug === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  };
  const rows = sales.map((s) => {
    const contact = [s.email, s.phone].filter(Boolean).join(' · ');
    const srcCls = s.seller_note && s.seller_note.startsWith('conflito') ? 'src warn' : 'src';
    const sellerCell = admin
      ? `<select data-assign="${s.id}">${sellerOpts(s)}</select><span class="${srcCls}">${s.seller ? SRC[s.seller_source] || '' : ''}${s.seller_note ? ' · ' + esc(s.seller_note) : ''}</span>`
      : s.seller ? `${esc(s.seller)}<span class="${srcCls}">${SRC[s.seller_source] || ''}${s.seller_note && s.seller_note.startsWith('conflito') ? ' · ' + esc(s.seller_note) : ''}</span>` : `<span class="none">sem vendedor</span>`;
    const statusTxt = s.status !== 'aprovada' ? ` <span class="badge">${esc(s.status)}</span>` : s.ignored ? ' <span class="badge">ignorada</span>' : '';
    return `<tr class="${state.newIds.has(s.id) ? 'new' : ''} ${s.counted ? '' : 'off'}">
      <td class="num">${dt(s.sold_at)}</td>
      <td class="cust">${esc(s.customer || '—')}${statusTxt}<small>${esc(contact)}</small></td>
      <td><span class="badge ${s.platform}">${s.platform.toUpperCase()}</span></td>
      ${opts.noProduct ? '' : `<td class="muted">${esc(s.product || '')}</td>`}
      <td class="num">${brl(s.amount)}</td>
      ${opts.noSeller ? '' : `<td>${sellerCell}</td>`}
      ${admin ? `<td><button class="ghost small" data-ignore="${s.id}" data-v="${s.ignored ? 0 : 1}">${s.ignored ? 'Contar' : 'Ignorar'}</button></td>` : ''}
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th class="num">Quando</th><th>Cliente</th><th>Plataforma</th>${opts.noProduct ? '' : '<th>Produto</th>'}<th class="num">Valor</th>${opts.noSeller ? '' : '<th>Vendedor(a)</th>'}${admin ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function bindAdminActions(root) {
  $$('[data-assign]', root).forEach((sel) => (sel.onchange = async () => {
    await api(`/api/admin/sales/${sel.dataset.assign}`, { method: 'PATCH', body: { seller: sel.value } });
  }));
  $$('[data-ignore]', root).forEach((b) => (b.onclick = async () => {
    await api(`/api/admin/sales/${b.dataset.ignore}`, { method: 'PATCH', body: { ignored: b.dataset.v === '1' } });
  }));
}

/* ------------------------------- página: geral ------------------------------- */
async function renderGeral(full) {
  const [sum, sales] = await Promise.all([
    api('/api/summary?' + periodQs()),
    api(`/api/sales?${periodQs()}&platform=${state.f.platform}&seller=${encodeURIComponent(state.f.seller)}&q=${encodeURIComponent(state.f.q)}&status=${state.f.status}&limit=${state.limit}`),
  ]);
  state.summary = sum;
  document.title = sum.settings.titulo;
  $('#title').textContent = sum.settings.titulo;
  const fat = sum.settings.unidade === 'faturamento';
  const fmtV = (v) => (fat ? brl(v) : int(v));

  if (full || !$('#kpis')) {
    $('#app').innerHTML = `
      <section class="grid4" id="kpis"></section>
      <section class="card"><div class="stats" id="stats"></div></section>
      <section class="card">
        <div class="section-head"><h2>Comercial</h2><span class="muted" id="faixas"></span></div>
        <div id="ranking"></div>
      </section>
      <section class="card">
        <div class="section-head">
          <h2>Vendas <span class="muted" id="sales-count"></span></h2>
          <div class="filters">
            <div class="seg" id="f-platform">
              <button data-v="todas">Todas</button><button data-v="hubla">Hubla</button><button data-v="tmb">TMB</button>
            </div>
            <select id="f-seller"></select>
            <input type="text" id="f-q" placeholder="Buscar cliente, e-mail…" />
            ${state.role === 'admin' ? `<label class="muted"><input type="checkbox" id="f-all" ${state.f.status === 'todas' ? 'checked' : ''}/> mostrar canceladas/ignoradas</label>` : ''}
          </div>
        </div>
        <div id="sales"></div>
      </section>`;
    $$('#f-platform button').forEach((b) => (b.onclick = () => { state.f.platform = b.dataset.v; render(false); }));
    $('#f-seller').onchange = (e) => { state.f.seller = e.target.value; render(false); };
    let qt; $('#f-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { state.f.q = e.target.value; render(false); }, 300); };
    $('#f-q').value = state.f.q;
    $('#f-all') && ($('#f-all').onchange = (e) => { state.f.status = e.target.checked ? 'todas' : ''; render(false); });
  }

  const card = (label, value, sub, pctVal) => `<div class="card kpi">
    <div class="label"><span>${label}</span>${pctVal !== undefined ? `<span class="pct">${pctVal.toFixed(0)}%</span>` : ''}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div>
    ${pctVal !== undefined ? `<div class="bar ${pctVal >= 100 ? 'done' : ''}"><i style="width:${Math.min(100, pctVal)}%"></i></div>` : ''}</div>`;
  const metaG = sum.settings.meta_geral, metaC = sum.settings.meta_comercial;
  const pct = (v, m) => (m > 0 ? (v / m) * 100 : undefined);
  const falta = (v, m) => (m > 0 ? (v >= m ? 'Meta batida 🎉' : `Faltam ${fmtV(m - v)}`) : 'Defina a meta em Config');
  $('#kpis').innerHTML =
    card('Meta geral', metaG ? fmtV(metaG) : '—', fat ? 'em faturamento' : 'em vendas') +
    card('Meta geral alcançada', fmtV(sum.geral.value), `${falta(sum.geral.value, metaG)}${fat ? '' : ' · ' + brl(sum.geral.revenue)}`, pct(sum.geral.value, metaG)) +
    card('Meta comercial', metaC ? fmtV(metaC) : '—', fat ? 'em faturamento' : 'em vendas') +
    card('Meta comercial alcançada', fmtV(sum.comercial.value), `${falta(sum.comercial.value, metaC)}${fat ? '' : ' · ' + brl(sum.comercial.revenue)}`, pct(sum.comercial.value, metaC));

  const stat = (n, t) => `<div class="stat"><div class="n">${n}</div><div class="t">${t}</div></div>`;
  $('#stats').innerHTML =
    stat(int(sum.geral.today), 'vendas hoje (geral)') +
    stat(int(sum.comercial.today), 'vendas hoje (comercial)') +
    stat(int(sum.plataformas.hubla.count), `Hubla · ${brl(sum.plataformas.hubla.revenue)}`) +
    stat(int(sum.plataformas.tmb.count), `TMB · ${brl(sum.plataformas.tmb.revenue)}`) +
    stat(int(sum.semVendedor), 'vendas sem vendedor(a)') +
    stat(sum.sync.lastSync ? new Date(sum.sync.lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—', sum.sync.configured ? 'planilhas lidas às' : 'planilhas não conectadas');

  const fx = sum.settings.faixas;
  $('#faixas').textContent = `Faixas individuais: mínimo ${fx.minimo} · ótimo ${fx.otimo} · extraordinário ${fx.extra}`;
  state.sellers = sum.ranking.map((r) => ({ slug: r.slug, name: r.name }));
  $('#ranking').innerHTML = sum.ranking.length
    ? `<div class="rank"><div class="rank-row rank-head"><span>#</span><span>Vendedor(a)</span><span class="hide-sm">Progresso</span><span class="num">Vendas</span><span class="num hide-sm">Hoje</span><span>Faixa</span></div>` +
      sum.ranking.map((r, i) => `<a class="rank-row" href="#/vendedor/${encodeURIComponent(r.slug)}">
        <span class="pos">${i + 1}</span><span class="name">${esc(r.name)}</span>
        <span class="hide-sm">${meter(r.count, fx)}</span>
        <span class="num"><b>${int(r.count)}</b></span><span class="num hide-sm">${int(r.today)}</span>${tierTag(r.tier)}</a>`).join('') + '</div>'
    : `<div class="empty">Nenhum(a) vendedor(a) ainda. Conecte as planilhas ou cadastre em Config.</div>`;

  $$('#f-platform button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.f.platform));
  $('#f-seller').innerHTML = `<option value="">Todos(as)</option><option value="comercial">Só comercial</option><option value="sem">Sem vendedor</option>` +
    state.sellers.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('');
  $('#f-seller').value = state.f.seller;
  $('#sales-count').textContent = `· ${int(sales.total)}`;
  $('#sales').innerHTML = salesTable(sales.sales) +
    (sales.total > sales.sales.length ? `<div class="row" style="justify-content:center;margin-top:14px"><button class="ghost" id="more">Mostrar mais (${int(sales.total - sales.sales.length)} restantes)</button></div>` : '');
  $('#more') && ($('#more').onclick = () => { state.limit += 100; render(false); });
  bindAdminActions($('#sales'));
}

/* ------------------------------- página: vendedor ------------------------------- */
async function renderSeller(slug, full) {
  if (!state.sellers.length) state.sellers = await api('/api/sellers');
  if (!slug && state.sellers.length) { location.replace('#/vendedor/' + encodeURIComponent(state.sellers[0].slug)); return; }
  if (!slug) { $('#app').innerHTML = `<div class="card empty">Nenhum(a) vendedor(a) cadastrado(a) ainda.</div>`; return; }
  const d = await api(`/api/seller/${encodeURIComponent(slug)}?${periodQs()}`);
  const fx = d.faixas;
  const today = d.period.today;
  const nextTier = [['Mínimo', fx.minimo], ['Ótimo', fx.otimo], ['Extraordinário', fx.extra]].find(([, v]) => d.count < v);
  let ritmo = '';
  if (nextTier && d.period.to > today) {
    const daysLeft = Math.round((new Date(d.period.to + 'T12:00:00') - new Date(today + 'T12:00:00')) / 864e5) + 1;
    ritmo = `<div class="stat"><div class="n">${Math.ceil((nextTier[1] - d.count) / daysLeft)}/dia</div><div class="t">ritmo p/ ${nextTier[0].toLowerCase()} (${daysLeft} dias)</div></div>`;
  }
  const maxDay = Math.max(1, ...d.byDay.map((x) => x.count));
  const step = Math.ceil(d.byDay.length / 15);

  $('#app').innerHTML = `
    <section class="chips">${state.sellers.map((s) => `<a class="chip ${s.slug === slug ? 'on' : ''}" href="#/vendedor/${encodeURIComponent(s.slug)}">${esc(s.name)}</a>`).join('')}</section>
    <section class="seller-hero">
      <div class="card">
        <div class="section-head"><h2>${esc(d.seller.name)}</h2>${tierTag(d.tier)}</div>
        <div class="big-num">${int(d.count)} <small>vendas</small></div>
        <div class="muted" style="margin:6px 0 22px">${nextTier ? `Faltam <b style="color:var(--text-primary)">${nextTier[1] - d.count}</b> para o ${nextTier[0].toLowerCase()} (${nextTier[1]})` : 'Bateu o extraordinário! 🚀'}</div>
        ${meter(d.count, fx, true)}
      </div>
      <div class="card">
        <div class="stats" style="display:grid;grid-template-columns:1fr 1fr;gap:22px">
          <div class="stat"><div class="n">${int(d.today)}</div><div class="t">vendas hoje</div></div>
          <div class="stat"><div class="n">${d.mediaDia.toFixed(1)}</div><div class="t">média por dia</div></div>
          <div class="stat"><div class="n">${brl(d.revenue)}</div><div class="t">faturamento puxado</div></div>
          <div class="stat"><div class="n">${int(d.porPlataforma.hubla)} / ${int(d.porPlataforma.tmb)}</div><div class="t">Hubla / TMB</div></div>
          ${ritmo}
        </div>
      </div>
    </section>
    <section class="card">
      <div class="section-head"><h2>Vendas por dia</h2><span class="muted">hoje em verde</span></div>
      <div class="days" id="days">${d.byDay.map((x) => {
        const h = ((x.count / maxDay) * 100).toFixed(1) + '%';
        return `<div class="d ${x.day === today ? 'today' : ''}" style="--h:${h}" data-tip="${dShort(x.day)}: ${x.count} venda${x.count === 1 ? '' : 's'}"><em>${x.count || ''}</em><i style="height:${h}"></i></div>`;
      }).join('')}</div>
      <div class="days-axis">${d.byDay.map((x, i) => `<span>${i % step === 0 ? dShort(x.day) : ''}</span>`).join('')}</div>
    </section>
    <section class="card">
      <div class="section-head"><h2>Vendas puxadas <span class="muted">· ${int(d.sales.length)}</span></h2></div>
      <div id="seller-sales">${salesTable(d.sales, { noSeller: state.role !== 'admin' })}</div>
    </section>`;
  bindAdminActions($('#seller-sales'));
  bindTips($('#days'));
}

function bindTips(root) {
  let tip;
  $$('[data-tip]', root).forEach((el) => {
    el.onmouseenter = () => { tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = el.dataset.tip; document.body.append(tip); };
    el.onmousemove = (e) => { if (tip) { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 32 + 'px'; } };
    el.onmouseleave = () => { tip?.remove(); tip = null; };
  });
}

/* ------------------------------- página: config ------------------------------- */
async function renderConfig() {
  if (state.role !== 'admin') { openLogin(true); $('#app').innerHTML = `<div class="card empty">Entre como admin para ver as configurações.</div>`; return; }
  const [c, events] = await Promise.all([api('/api/admin/config'), api('/api/admin/events?limit=40')]);
  const s = c.settings;
  const sync = c.sync;
  $('#app').innerHTML = `
    <section class="card">
      <div class="section-head"><h2>Metas e período</h2><button class="primary" id="save">Salvar</button></div>
      <div class="form-grid" id="settings">
        <label>Nome do dash<input name="titulo" value="${esc(s.titulo)}"></label>
        <label>Metas medidas em<select name="unidade"><option value="vendas">Nº de vendas</option><option value="faturamento">Faturamento (R$)</option></select></label>
        <label>Meta geral<input name="meta_geral" type="number" min="0" value="${s.meta_geral}"></label>
        <label>Meta comercial<input name="meta_comercial" type="number" min="0" value="${s.meta_comercial}"></label>
        <label>Início da campanha<input name="inicio" type="date" value="${esc(s.inicio)}"></label>
        <label>Fim da campanha<input name="fim" type="date" value="${esc(s.fim)}"></label>
        <label>Faixa mínimo (vendas)<input name="faixa_minimo" type="number" value="${s.faixa_minimo}"></label>
        <label>Faixa ótimo<input name="faixa_otimo" type="number" value="${s.faixa_otimo}"></label>
        <label>Faixa extraordinário<input name="faixa_extra" type="number" value="${s.faixa_extra}"></label>
        <label style="grid-column:1/-1">Só contar produtos que contenham (separe por vírgula; vazio = todos)<input name="produtos" value="${esc(s.produtos)}" placeholder="ex.: black, selune"></label>
      </div>
    </section>

    <section class="card">
      <div class="section-head"><h2>Vendedores(as)</h2>
        <div class="row"><input id="new-name" placeholder="Nome"><input id="new-alias" placeholder="Códigos UTM (opcional)"><button class="ghost" id="add-seller">Adicionar</button></div></div>
      <p class="help">A venda é atribuída nesta ordem: <b>ajuste manual</b> → <b>UTM</b> (qualquer utm_source/content/term/medium/campaign que contenha o nome ou um dos códigos) → campo vendedor da plataforma → <b>planilha</b> (e-mail, depois telefone). Use "Códigos UTM" quando a UTM do link não for o nome, ex.: <code>isla, com-isla, vend07</code>.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Nome</th><th>Códigos UTM</th><th class="num">Contatos na planilha</th><th>Origem</th><th>Ativo</th><th></th></tr></thead>
        <tbody>${c.sellers.map((v) => `<tr data-slug="${esc(v.slug)}">
          <td><input data-k="name" value="${esc(v.name)}"></td>
          <td><input data-k="aliases" value="${esc(v.aliases || '')}" placeholder="${esc(v.slug)}"></td>
          <td class="num">${v.contatos}</td>
          <td class="muted">${v.origin === 'planilha' && v.sheet_id ? `<a href="https://docs.google.com/spreadsheets/d/${esc(v.sheet_id)}" target="_blank" rel="noopener">planilha ↗</a>` : esc(v.origin)}</td>
          <td><input type="checkbox" data-k="active" ${v.active ? 'checked' : ''}></td>
          <td><button class="ghost small" data-save-seller>Salvar</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum ainda</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="grid2">
      <div class="card">
        <div class="section-head"><h2>Planilhas</h2><button class="ghost" id="sync">Sincronizar agora</button></div>
        <p class="help">
          ${sync.configured ? `Modo: <b>${sync.configured === 'drive' ? 'pasta do Drive (conta de serviço)' : 'planilhas públicas'}</b> · lê a cada ${sync.interval}s<br>` : '<b style="color:var(--warn)">Não configurado.</b> Veja o README (GOOGLE_SERVICE_ACCOUNT_JSON + DRIVE_FOLDER_ID).<br>'}
          ${sync.serviceAccount ? `Compartilhe a pasta com: <code>${esc(sync.serviceAccount)}</code><br>` : ''}
          Última leitura: ${sync.lastSync ? dt(sync.lastSync) + ` · ${sync.sheets} planilhas · ${sync.contacts} contatos` : '—'}<br>
          ${sync.lastError ? `<span class="err">Erro: ${esc(sync.lastError)}</span>` : sync.lastSync ? '<span class="ok">OK</span>' : ''}
        </p>
      </div>
      <div class="card">
        <div class="section-head"><h2>Webhooks</h2></div>
        <p class="help">Hubla → Integrações → Webhooks → evento <b>Fatura: pagamento realizado (v2)</b> e <b>Fatura reembolsada (v2)</b><br>
          <code>${esc(c.webhooks.hubla)}</code> ${c.webhooks.hublaToken ? '<span class="ok">· token ativo</span>' : '<span class="muted">· sem token</span>'}</p>
        <p class="help">TMB → Integrações → Webhook de <b>Vendas</b><br>
          <code>${esc(c.webhooks.tmb)}</code> ${c.webhooks.tmbToken ? '<span class="ok">· token ativo</span>' : '<span class="muted">· sem token</span>'}</p>
      </div>
    </section>


    <section class="card" id="import-card">
      <div class="section-head"><h2>Importar vendas antigas</h2></div>
      <p class="help">Exporte as vendas na Hubla e na TMB em <b>XLSX ou CSV</b> e suba aqui, uma plataforma por vez. Vendas que já existem (mesmo nº de pedido/fatura) não duplicam. As vendas entram com a mesma atribuição de UTM e planilha.</p>
      <div class="row">
        <div class="seg" id="imp-platform"><button data-v="hubla" class="on">Hubla</button><button data-v="tmb">TMB</button></div>
        <input type="file" id="imp-file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </div>
      <div id="imp-preview"></div>
    </section>

    <section class="card">
      <div class="section-head"><h2>Últimos webhooks recebidos</h2><button class="ghost small" id="reload-ev">Atualizar</button></div>
      ${events.length ? `<div class="table-wrap"><table><thead><tr><th>Quando</th><th>Plataforma</th><th>Evento</th><th>Resultado</th><th></th></tr></thead><tbody>
        ${events.map((e) => `<tr><td class="num">${dt(e.received_at)}</td><td><span class="badge ${e.platform}">${e.platform.toUpperCase()}</span></td><td>${esc(e.type)}</td>
        <td class="muted">${esc(e.result.created ? 'venda criada' + (e.result.seller ? ' → ' + e.result.seller : ' (sem vendedor)') : e.result.updated ? 'status → ' + e.result.status : e.result.duplicate ? 'duplicado' : e.result.ignored || e.result.error || '')}</td>
        <td><details><summary class="muted">payload</summary><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></details></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nenhum webhook recebido ainda.</div>'}
    </section>`;

  $('[name=unidade]').value = s.unidade;
  $('#save').onclick = async () => {
    const body = Object.fromEntries($$('#settings [name]').map((i) => [i.name, i.value]));
    await api('/api/admin/settings', { method: 'PUT', body });
    toast('Salvo', 'Metas atualizadas');
  };
  $('#add-seller').onclick = async () => {
    const name = $('#new-name').value.trim();
    if (!name) return;
    await api('/api/admin/sellers', { method: 'POST', body: { name, aliases: $('#new-alias').value } });
    state.sellers = []; renderConfig();
  };
  $$('[data-save-seller]').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    const body = { name: $('[data-k=name]', tr).value, aliases: $('[data-k=aliases]', tr).value, active: $('[data-k=active]', tr).checked };
    const r = await api(`/api/admin/sellers/${tr.dataset.slug}`, { method: 'PUT', body });
    state.sellers = [];
    toast('Salvo', `${r.changed} venda(s) reatribuída(s)`);
  }));
  $('#sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Lendo…';
    const r = await api('/api/admin/sync', { method: 'POST' }).catch((err) => ({ ok: false, error: err.message }));
    toast(r.ok ? 'Planilhas lidas' : 'Erro ao ler planilhas', r.ok ? `${r.sheets} planilhas · ${r.contacts} contatos · ${r.changed} vendas reatribuídas` : r.error, !r.ok);
    renderConfig();
  };
  $('#reload-ev').onclick = renderConfig;
  bindImport();
}

/* ------------------------------- importação CSV ------------------------------- */
const normH = (h) => String(h ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const IMP_FIELDS = [
  ['external_id', 'Nº do pedido / fatura', ['id da fatura', 'id fatura', 'fatura', 'pedido', 'id do pedido', 'numero do pedido', 'n do pedido', 'id da venda', 'id da transacao', 'transacao', 'invoice id', 'order id', 'codigo', 'id']],
  ['status', 'Status', ['status do pedido', 'status da fatura', 'status do pagamento', 'status pedido', 'status', 'situacao']],
  ['customer_name', 'Nome', ['nome do cliente', 'nome do comprador', 'nome completo', 'cliente', 'comprador', 'nome']],
  ['email', 'E-mail', ['email do cliente', 'email do comprador', 'e mail do cliente', 'e mail', 'email']],
  ['phone', 'Telefone', ['telefone do cliente', 'telefone do comprador', 'telefone ativo', 'celular', 'whatsapp', 'telefone', 'telefones', 'fone']],
  ['product', 'Produto', ['nome do produto', 'produto', 'oferta', 'lancamento', 'titulo']],
  ['amount', 'Valor', ['valor principal', 'valor do produto', 'valor total', 'valor pago', 'valor da venda', 'valor bruto', 'ticket do pedido', 'ticket', 'total', 'valor', 'preco']],
  ['sold_at', 'Data', ['data de pagamento', 'data do pagamento', 'data efetivado', 'data efetivacao', 'pago em', 'data da venda', 'data da compra', 'data de criacao', 'criado em', 'data']],
  ['vendor_hint', 'Vendedor / afiliado', ['vendedor', 'nome do afiliado', 'afiliado']],
];
const imp = { platform: 'hubla', headers: [], rows: [], map: {} };

function parseCsvText(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', ',', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function detectMap(headers) {
  const hs = headers.map(normH), used = new Set(), map = {};
  for (const [key, , cands] of IMP_FIELDS) {
    let found = -1;
    for (const c of cands) { found = hs.findIndex((h, i) => !used.has(i) && h === c); if (found >= 0) break; }
    if (found < 0) for (const c of cands) { found = hs.findIndex((h, i) => !used.has(i) && (' ' + h + ' ').includes(' ' + c + ' ') && !h.includes('utm')); if (found >= 0) break; }
    map[key] = found;
    if (found >= 0) used.add(found);
  }
  return map;
}

function mapStatus(v, hasCol) {
  if (!hasCol) return 'aprovada';
  const n = normH(v);
  if (!n) return null;
  if (/(nao pag|unpaid|pendent|aguard|abert|expir|falh|recus|fail|draft|vencid|gerad|waiting|pending)/.test(n)) return null;
  if (/(reembols|estorn|refund|devolv)/.test(n)) return 'reembolsada';
  if (/(cancel|chargeback|contest|disput)/.test(n)) return 'cancelada';
  if (/(pag|paid|aprov|efetiv|conclu|complet|confirm|sucesso|succe|ativ|liquid|em dia|vigente|adimplent)/.test(n)) return 'aprovada';
  return null;
}
function parseMoney(v) {
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return parseFloat(s) || 0;
}

function buildImportRows() {
  const m = imp.map, get = (r, k) => (m[k] >= 0 ? String(r[m[k]] ?? '').trim() : '');
  const utmCols = imp.headers.map((h, i) => [normH(h), i]).filter(([h]) => h.includes('utm') || h === 'src' || h === 'sck');
  const hIdx = (name) => imp.headers.findIndex((h) => normH(h) === name);
  const iParc = hIdx('parcela do parcelamento inteligente'), iTot = hIdx('total de parcelas do parcelamento inteligente');
  return imp.rows.map((r) => {
    const parc = iParc >= 0 ? Number(r[iParc]) || 0 : 0, totParc = iTot >= 0 ? Number(r[iTot]) || 0 : 0;
    const utms = {};
    for (const [h, i] of utmCols) if (String(r[i] ?? '').trim()) utms[h.replace(/ /g, '_')] = String(r[i]).trim();
    const date = get(r, 'sold_at').replace(/\s+(às|as)\s+/i, ' ');
    const email = get(r, 'email');
    let amount = parseMoney(get(r, 'amount'));
    if (parc === 1 && totParc > 1) amount = Math.round(amount * totParc * 100) / 100;
    return {
      external_id: get(r, 'external_id') || (email ? `${email}|${date}|${amount}` : ''),
      status: parc > 1 ? null : mapStatus(get(r, 'status'), m.status >= 0),
      customer_name: get(r, 'customer_name'), email, phone: get(r, 'phone'),
      product: get(r, 'product'), amount, sold_at: date, utms, vendor_hint: get(r, 'vendor_hint'),
      _rawStatus: get(r, 'status'),
    };
  });
}

function renderImportPreview() {
  const box = $('#imp-preview');
  if (!imp.headers.length) { box.innerHTML = ''; return; }
  const rows = buildImportRows();
  const ok = rows.filter((r) => r.status && r.external_id);
  const cnt = (st) => rows.filter((r) => r.status === st && r.external_id).length;
  const skipped = rows.length - ok.length;
  const opts = (sel) => `<option value="-1">— nenhuma —</option>` + imp.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
  const utmCols = imp.headers.filter((h) => { const n = normH(h); return n.includes('utm') || n === 'src' || n === 'sck'; });
  const ignoredStatus = [...new Set(rows.filter((r) => !r.status).map((r) => r._rawStatus).filter(Boolean))].slice(0, 6);
  box.innerHTML = `
    <p class="help" style="margin-top:14px">${int(rows.length)} linhas no arquivo. Confira se cada campo puxou a coluna certa:</p>
    <div class="form-grid">${IMP_FIELDS.map(([k, label]) => `<label>${label}<select data-map="${k}">${opts(imp.map[k])}</select></label>`).join('')}</div>
    <p class="help">UTMs: ${utmCols.length ? utmCols.map((h) => `<code>${esc(h)}</code>`).join(' ') : '<span style="color:var(--warn)">nenhuma coluna de UTM encontrada. A atribuição vai ser só pela planilha.</span>'}</p>
    <div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Status</th><th>Data</th><th>Cliente</th><th>E-mail</th><th class="num">Valor</th></tr></thead><tbody>
      ${rows.slice(0, 6).map((r) => `<tr class="${r.status ? '' : 'off'}"><td class="mono">${esc(r.external_id.slice(0, 24))}</td><td>${esc(r.status || 'ignorar')}${r._rawStatus ? ` <span class="muted">(${esc(r._rawStatus)})</span>` : ''}</td><td>${esc(r.sold_at)}</td><td>${esc(r.customer_name)}</td><td>${esc(r.email)}</td><td class="num">${brl(r.amount)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="help">Vai importar <b>${int(cnt('aprovada'))}</b> aprovadas, ${int(cnt('cancelada'))} canceladas e ${int(cnt('reembolsada'))} reembolsadas. ${skipped ? `${int(skipped)} linhas serão ignoradas (pendentes/expiradas ou sem nº do pedido)${ignoredStatus.length ? ': ' + ignoredStatus.map(esc).join(', ') : ''}.` : ''}</p>
    <div class="row"><button class="primary" id="imp-go" ${ok.length ? '' : 'disabled'}>Importar ${int(ok.length)} vendas da ${imp.platform === 'hubla' ? 'Hubla' : 'TMB'}</button><span class="muted" id="imp-status"></span></div>`;
  $$('[data-map]', box).forEach((sel) => (sel.onchange = () => { imp.map[sel.dataset.map] = Number(sel.value); renderImportPreview(); }));
  $('#imp-go').onclick = async (e) => {
    e.target.disabled = true;
    const send = ok.map(({ _rawStatus, ...r }) => r);
    const tot = { created: 0, updated: 0, duplicate: 0, skipped: 0, errors: [] };
    try {
      for (let i = 0; i < send.length; i += 1000) {
        $('#imp-status').textContent = `Enviando ${Math.min(i + 1000, send.length)} de ${send.length}…`;
        const r = await api('/api/admin/import', { method: 'POST', body: { platform: imp.platform, rows: send.slice(i, i + 1000) } });
        for (const k of ['created', 'updated', 'duplicate', 'skipped']) tot[k] += r[k];
        tot.errors.push(...r.errors);
      }
      $('#imp-status').innerHTML = `<span class="ok">Pronto:</span> ${tot.created} novas · ${tot.updated} status atualizados · ${tot.duplicate} já existiam${tot.errors.length ? ' · erros: ' + esc(tot.errors.join('; ')) : ''}`;
      toast('Importação concluída', `${tot.created} vendas novas da ${imp.platform.toUpperCase()}`);
    } catch (err) {
      $('#imp-status').innerHTML = `<span class="err">${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  };
}

/* Leitor de .xlsx sem biblioteca: o arquivo é um zip de XMLs.
   Descompacta com DecompressionStream e lê a 1ª aba (textos, números e datas). */
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('não é um .xlsx válido');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, local };
    p += 46 + nlen + elen + clen;
  }
  return async (name) => {
    const e = files[name];
    if (!e) return null;
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return dec.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  };
}

async function readXlsx(buf) {
  const get = await unzip(buf);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (doc, tag) => [...doc.getElementsByTagNameNS('*', tag)];

  // 1ª aba de verdade (workbook -> rels)
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await get('xl/workbook.xml'), rels = await get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = byTag(xml(wb), 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || [...first.attributes].find((a) => a.localName === 'id')?.value);
    const rel = byTag(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target'); sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''); }
  }

  const ssXml = await get('xl/sharedStrings.xml');
  const shared = ssXml ? byTag(xml(ssXml), 'si').map((si) => byTag(si, 't').map((t) => t.textContent).join('')) : [];

  // estilos de data (numFmt 14-22, 45-47 ou formato com d/m/y/h)
  const dateStyles = new Set();
  const stXml = await get('xl/styles.xml');
  if (stXml) {
    const st = xml(stXml);
    const custom = {};
    byTag(st, 'numFmt').forEach((f) => (custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode') || ''));
    const cellXfs = byTag(st, 'cellXfs')[0];
    if (cellXfs) [...cellXfs.children].forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmyh]/i.test(code)) dateStyles.add(i);
    });
  }
  const pad = (n) => String(n).padStart(2, '0');
  const serialToText = (v) => {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  const sheet = await get(sheetPath);
  if (!sheet) throw new Error('planilha vazia');
  const rows = [];
  for (const r of byTag(xml(sheet), 'row')) {
    const ri = Number(r.getAttribute('r')) - 1;
    const row = [];
    for (const c of byTag(r, 'c')) {
      const t = c.getAttribute('t'), s = Number(c.getAttribute('s') || 0);
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = v;
      // data ISO gravada direto na célula (ex.: export da TMB) = horário de parede, ignora o "Z"
      else if (t === 'd') val = v.replace('T', ' ').replace(/(\.\d+)?Z?$/, '');
      else if (v !== '' && dateStyles.has(s)) val = serialToText(Number(v));
      else val = v;
      row[c.getAttribute('r') ? colIdx(c.getAttribute('r')) : row.length] = val;
    }
    rows[Number.isFinite(ri) && ri >= 0 ? ri : rows.length] = Array.from(row, (x) => x ?? '');
  }
  return rows.filter((r) => r && r.some((c) => String(c).trim() !== ''));
}

function bindImport() {
  $$('#imp-platform button').forEach((b) => (b.onclick = () => {
    imp.platform = b.dataset.v;
    $$('#imp-platform button').forEach((x) => x.classList.toggle('on', x === b));
    renderImportPreview();
  }));
  $('#imp-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    let all;
    try {
      if (/\.xlsx$/i.test(f.name)) all = await readXlsx(await f.arrayBuffer());
      else if (/\.xls$/i.test(f.name)) { toast('Excel antigo (.xls)', 'Salve como .xlsx ou CSV e suba de novo', true); return; }
      else {
        let text = await f.text();
        if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
        all = parseCsvText(text);
      }
    } catch (err) {
      toast('N\u00E3o consegui ler o arquivo', err.message, true);
      return;
    }
    // cabe\u00E7alho = primeira linha com 2+ c\u00E9lulas preenchidas
    const h = all.findIndex((r) => r.filter((c) => String(c ?? '').trim()).length >= 2);
    imp.headers = (all[h] || []).map((c) => String(c ?? '').trim());
    imp.rows = all.slice(h + 1);
    imp.map = detectMap(imp.headers);
    renderImportPreview();
  };
}

/* ------------------------------- boot ------------------------------- */
async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  state.role = me.role;
  if (me.titulo) { $('#title').textContent = me.titulo; document.title = me.titulo; }
  $('#nav-config').hidden = me.role !== 'admin';
  $('#login-btn').title = me.role === 'admin' ? 'Sair do modo admin' : 'Entrar como admin';
  $('#login-btn').hidden = !me.adminEnabled && me.role !== 'admin';
  if (!me.role) { openLogin(false); return; }
  syncPeriodUi();
  connect();
  render(true);
}
boot();
