// Transforma o payload de cada plataforma num formato único de venda.
// Retorna { action: 'upsert', sale } ou { action: 'ignore', reason }.
import { parseDate, nowIso } from './util.js';

/** Procura UTMs em qualquer lugar do payload (campos utm_*, objeto utm, src/sck e URLs com ?utm_). */
export function collectUtms(obj, out = {}, parentIsUtm = false, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    const isUtmKey = lk.includes('utm');
    if (v && typeof v === 'object') {
      collectUtms(v, out, isUtmKey || parentIsUtm, depth + 1);
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    const val = String(v).trim();
    if (isUtmKey && !val.includes('utm_')) {
      const key = lk.replace(/^utm[_-]?/, 'utm_').replace(/utm_$/, 'utm');
      if (!out[key]) out[key] = val;
    } else if (parentIsUtm) {
      if (!out['utm_' + lk]) out['utm_' + lk] = val;
    } else if (lk === 'src' || lk === 'sck') {
      if (!out[lk]) out[lk] = val;
    }
    if (typeof v === 'string' && v.includes('utm_')) {
      const q = v.includes('?') ? v.slice(v.indexOf('?') + 1) : v;
      try {
        for (const [pk, pv] of new URLSearchParams(q)) {
          const key = pk.toLowerCase();
          if ((key.startsWith('utm_') || key === 'src' || key === 'sck') && pv && !out[key]) out[key] = pv;
        }
      } catch {}
    }
  }
  return out;
}

const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || u?.name || null;

/* ---------------------------------- HUBLA ---------------------------------- */
// Docs: https://hubla.gitbook.io/docs/webhooks/eventos/fatura
export function normalizeHubla(body) {
  const type = body?.type || body?.event_type || 'desconhecido';
  const ev = body?.event || body?.data || {};

  // ---- v2 (faturas) ----
  if (type.startsWith('invoice.')) {
    const inv = ev.invoice || {};
    const user = ev.user || inv.payer || {};
    let status = null;
    if (type === 'invoice.payment_succeeded') status = 'aprovada';
    else if (type === 'invoice.refunded') status = 'reembolsada';
    else if (type === 'invoice.status_updated') {
      const st = String(inv.status || '').toLowerCase();
      if (st === 'paid') status = 'aprovada';
      else if (st === 'refunded') status = 'reembolsada';
      else if (st.includes('chargeback') || st === 'canceled' || st === 'cancelled') status = 'cancelada';
    }
    if (!status) return { action: 'ignore', reason: `evento ${type} (status ${inv.status || '-'}) não conta como venda` };

    // Parcelamento inteligente: só a 1ª parcela conta como venda nova
    const si = inv.smartInstallment;
    if (si && Number(si.installment) > 1 && status === 'aprovada') {
      return { action: 'ignore', reason: `parcela ${si.installment}/${si.installments} do parcelamento inteligente` };
    }

    const amt = inv.amount || {};
    let amount = amt.totalCents != null ? amt.totalCents / 100 : Number(amt.total) || 0;
    if (si && Number(si.installments) > 1) amount = amount * Number(si.installments);

    const externalId = (si && si.sourceInvoiceId) || inv.id || inv.orderId;
    if (!externalId) return { action: 'ignore', reason: 'fatura sem id' };

    const paidAt = (inv.statusAt || []).find((x) => String(x.status).toLowerCase() === 'paid')?.when;
    return {
      action: 'upsert',
      sale: {
        platform: 'hubla',
        external_id: String(externalId),
        status,
        customer_name: fullName(user),
        email: user.email || null,
        phone: user.phone || null,
        product: ev.product?.name || ev.products?.[0]?.name || null,
        amount,
        sold_at: parseDate(paidAt) || parseDate(inv.saleDate) || parseDate(inv.createdAt) || nowIso(),
        utms: collectUtms(inv.paymentSession || {}, collectUtms(body)),
        vendor_hint: null,
      },
    };
  }

  // ---- v1 (Nova venda / Venda cancelada) ----
  const v1map = { NewSale: 'aprovada', CanceledSale: 'cancelada', RefundedSale: 'reembolsada' };
  if (v1map[type]) {
    const externalId = ev.transactionId || ev.saleId || ev.id || ev.invoiceId;
    if (!externalId) return { action: 'ignore', reason: 'venda v1 sem id' };
    return {
      action: 'upsert',
      sale: {
        platform: 'hubla',
        external_id: String(externalId),
        status: v1map[type],
        customer_name: ev.userName || fullName(ev.user),
        email: ev.userEmail || ev.user?.email || null,
        phone: ev.userPhone || ev.user?.phone || null,
        product: ev.groupName || ev.productName || null,
        amount: Number(ev.totalAmount ?? ev.amount ?? ev.price) || 0,
        sold_at: parseDate(ev.paidAt || ev.createdAt) || nowIso(),
        utms: collectUtms(body),
        vendor_hint: null,
      },
    };
  }

  return { action: 'ignore', reason: `evento ${type} não conta como venda` };
}

/* ----------------------------------- TMB ----------------------------------- */
// Docs: https://info.tmbeducacao.com.br/portal-do-produtor/central-de-ajuda/produto/integracoes/vendas
export function normalizeTmb(body) {
  const b = body?.data && typeof body.data === 'object' && !body.pedido ? body.data : body || {};
  const st = String(b.status_pedido || b.status || '').toLowerCase();
  let status = null;
  if (st.startsWith('efetivad') || st === 'aprovado' || st === 'pago') status = 'aprovada';
  else if (st.startsWith('cancel')) status = 'cancelada';
  else if (st.startsWith('reembols') || st.startsWith('estorn')) status = 'reembolsada';
  if (!status) return { action: 'ignore', reason: `status_pedido "${b.status_pedido || b.status || '-'}" não conta como venda` };

  const externalId = b.pedido ?? b.pedido_id ?? b.id_pedido ?? b.id;
  if (externalId === undefined || externalId === null) return { action: 'ignore', reason: 'pedido sem número' };

  return {
    action: 'upsert',
    sale: {
      platform: 'tmb',
      external_id: String(externalId),
      status,
      customer_name: b.cliente || b.nome || null,
      email: b.email || null,
      phone: b.telefone_ativo || b.telefone || b.telefones || null,
      product: b.lancamento || b.titulo || b.produto || null,
      amount: Number(b.valor_principal ?? b.valor_total ?? b.valor) || 0,
      sold_at: parseDate(b.data_efetivado) || parseDate(b.criado_em) || nowIso(),
      utms: collectUtms(b),
      vendor_hint: b.vendedor || null,
    },
  };
}
