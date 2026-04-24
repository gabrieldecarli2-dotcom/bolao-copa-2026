// api/verificar-pagamento.js
// Consulta o pagamento no Mercado Pago e também devolve dados do PIX pendente ainda válido.

const REUSABLE_STATUSES = new Set(['pending', 'in_process', 'authorized']);

async function patchUser(SUPABASE_URL, SUPABASE_KEY, usuarioId, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function getExpirationInfo(payment) {
  const expiration = payment?.date_of_expiration || null;
  const expiresAtMs = expiration ? new Date(expiration).getTime() : null;
  const now = Date.now();
  const isExpired = expiresAtMs ? expiresAtMs <= now : false;
  const secondsRemaining = expiresAtMs ? Math.max(0, Math.floor((expiresAtMs - now) / 1000)) : null;
  return { expiration, isExpired, secondsRemaining };
}

async function cancelMercadoPagoPayment(MP_TOKEN, paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `cancel-${paymentId}`,
    },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  return res.ok;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { usuario_id } = req.body || {};
  if (!usuario_id) return res.status(400).json({ error: 'usuario_id obrigatório' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  try {
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario_id}&select=pago,payment_id,status_pagamento`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const users = await userRes.json();
    const usuario = users?.[0];

    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (usuario.pago) return res.status(200).json({ ok: true, pago: true });
    if (!usuario.payment_id) {
      return res.status(200).json({ ok: true, pago: false, tem_pix_pendente: false, msg: 'Pagamento ainda não identificado' });
    }

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${usuario.payment_id}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    const pagamento = await mpRes.json();

    if (!mpRes.ok) {
      return res.status(200).json({ ok: true, pago: false, tem_pix_pendente: false, status: 'indisponivel' });
    }

    if (pagamento.status === 'approved') {
      await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
        pago: true,
        status_pagamento: 'aprovado',
        payment_id: String(pagamento.id),
      });
      return res.status(200).json({ ok: true, pago: true });
    }

    const { expiration, isExpired, secondsRemaining } = getExpirationInfo(pagamento);
    if (REUSABLE_STATUSES.has(pagamento.status) && isExpired) {
      await cancelMercadoPagoPayment(MP_TOKEN, usuario.payment_id);
      await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
        payment_id: null,
        status_pagamento: 'expirado',
      });
      return res.status(200).json({
        ok: true,
        pago: false,
        tem_pix_pendente: false,
        pix_expirado: true,
        status: 'expired',
      });
    }

    if (REUSABLE_STATUSES.has(pagamento.status)) {
      return res.status(200).json({
        ok: true,
        pago: false,
        tem_pix_pendente: true,
        status: pagamento.status,
        payment_id: String(pagamento.id),
        pix_copia_cola: pagamento.point_of_interaction?.transaction_data?.qr_code || '',
        pix_qr_base64: pagamento.point_of_interaction?.transaction_data?.qr_code_base64 || '',
        valor: pagamento.transaction_amount || null,
        date_of_expiration: expiration,
        seconds_remaining: secondsRemaining,
      });
    }

    await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
      payment_id: null,
      status_pagamento: pagamento.status || 'cancelado',
    });

    return res.status(200).json({
      ok: true,
      pago: false,
      tem_pix_pendente: false,
      status: pagamento.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
