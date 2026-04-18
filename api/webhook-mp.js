// api/webhook-mp.js
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('OK');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  try {
    const { type, data } = req.body || {};
    if (type !== 'payment' || !data?.id) return res.status(200).json({ ok: true });

    // Consulta pagamento no MP
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const pagamento = await mpRes.json();
    if (pagamento.status !== 'approved') return res.status(200).json({ ok: true });

    const usuarioId = pagamento.metadata?.usuario_id;
    if (!usuarioId) return res.status(200).json({ ok: true, msg: 'sem usuario_id' });

    // Confirma pagamento via Supabase REST
    await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pago: true, status_pagamento: 'aprovado', payment_id: String(data.id) })
    });

    return res.status(200).json({ ok: true, confirmed: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
