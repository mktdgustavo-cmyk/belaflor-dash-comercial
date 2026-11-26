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
