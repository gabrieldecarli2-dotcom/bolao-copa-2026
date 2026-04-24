// api/criar-pix.js
// Reaproveita um PIX pendente e dentro da validade para evitar múltiplos pagamentos em aberto.

const PIX_VALIDITY_MINUTES = 30;
const REUSABLE_STATUSES = new Set(['pending', 'in_process', 'authorized']);

function buildHeaders(token, extra = {}) {
  return {
    'Authorization': `Bearer ${token}`,
    ...extra,
  };
}

async function getUser(SUPABASE_URL, SUPABASE_KEY, usuarioId) {
  const userRes = await fetch(
    `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioId}&select=pago,payment_id,status_pagamento`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const users = await userRes.json();
  return users?.[0] || null;
}

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

async function getMercadoPagoPayment(MP_TOKEN, paymentId) {
  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: buildHeaders(MP_TOKEN),
  });
  const data = await mpRes.json();
  return { ok: mpRes.ok, data };
}

function getExpirationInfo(payment) {
  const expiration = payment?.date_of_expiration || null;
  const expiresAtMs = expiration ? new Date(expiration).getTime() : null;
  const now = Date.now();
  const isExpired = expiresAtMs ? expiresAtMs <= now : false;
  const secondsRemaining = expiresAtMs ? Math.max(0, Math.floor((expiresAtMs - now) / 1000)) : null;
  return { expiration, isExpired, secondsRemaining };
}

function buildPixPayload(payment, taxa, reused = false) {
  const { expiration, secondsRemaining } = getExpirationInfo(payment);
  return {
    ok: true,
    reused,
    payment_id: String(payment.id),
    pix_copia_cola: payment.point_of_interaction?.transaction_data?.qr_code || '',
    pix_qr_base64: payment.point_of_interaction?.transaction_data?.qr_code_base64 || '',
    valor: taxa,
    status: payment.status,
    date_of_expiration: expiration,
    seconds_remaining: secondsRemaining,
  };
}

async function cancelMercadoPagoPayment(MP_TOKEN, paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: 'PUT',
    headers: buildHeaders(MP_TOKEN, {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `cancel-${paymentId}`,
    }),
    body: JSON.stringify({ status: 'cancelled' }),
  });
  return res.ok;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { usuario_id, email, nome, somente_existente } = req.body || {};
  if (!usuario_id || !email) return res.status(400).json({ error: 'Dados incompletos' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!MP_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado' });

  try {
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/configuracoes?chave=eq.taxa_participacao`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const cfgData = await cfgRes.json();
    const taxa = parseFloat(cfgData?.[0]?.valor || 20);

    const usuario = await getUser(SUPABASE_URL, SUPABASE_KEY, usuario_id);
    if (usuario?.pago) return res.status(400).json({ error: 'Pagamento já confirmado' });

    if (usuario?.payment_id) {
      const { ok, data: pagamentoAtual } = await getMercadoPagoPayment(MP_TOKEN, usuario.payment_id);

      if (ok) {
        if (pagamentoAtual.status === 'approved') {
          await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
            pago: true,
            status_pagamento: 'aprovado',
            payment_id: String(pagamentoAtual.id),
          });
          return res.status(200).json({ ok: true, pago: true, payment_id: String(pagamentoAtual.id) });
        }

        const { isExpired } = getExpirationInfo(pagamentoAtual);
        if (REUSABLE_STATUSES.has(pagamentoAtual.status) && !isExpired) {
          return res.status(200).json(buildPixPayload(pagamentoAtual, taxa, true));
        }

        if (REUSABLE_STATUSES.has(pagamentoAtual.status)) {
          await cancelMercadoPagoPayment(MP_TOKEN, usuario.payment_id);
        }
      }

      await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
        payment_id: null,
        status_pagamento: 'expirado',
      });
    }

    if (somente_existente) {
      return res.status(200).json({ ok: true, tem_pix_pendente: false });
    }

    const expirationDate = new Date(Date.now() + PIX_VALIDITY_MINUTES * 60 * 1000).toISOString();
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: buildHeaders(MP_TOKEN, {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `bolao-${usuario_id}-${Date.now()}`,
      }),
      body: JSON.stringify({
        transaction_amount: taxa,
        description: 'Bolão Copa 2026 - Taxa de participação',
        payment_method_id: 'pix',
        date_of_expiration: expirationDate,
        payer: {
          email,
          first_name: (nome || 'Participante').split(' ')[0],
          last_name: (nome || 'Bolão').split(' ').slice(1).join(' ') || 'Bolao',
        },
        notification_url: 'https://copa-bolao.vercel.app/api/webhook-mp',
        metadata: { usuario_id },
      }),
    });

    const text = await mpResponse.text();
    let mpData;
    try {
      mpData = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Resposta inválida do MP: ' + text.substring(0, 200) });
    }

    if (!mpResponse.ok) {
      return res.status(500).json({ error: mpData.message || 'Erro no Mercado Pago', detail: mpData });
    }

    const paymentId = String(mpData.id);
    await patchUser(SUPABASE_URL, SUPABASE_KEY, usuario_id, {
      payment_id: paymentId,
      status_pagamento: 'pendente',
    });

    return res.status(200).json(buildPixPayload(mpData, taxa, false));
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
};
