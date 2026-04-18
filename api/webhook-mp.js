// api/webhook-mp.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('OK');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

  try {
    const { type, data } = req.body || {};
    if (type !== 'payment' || !data?.id) return res.status(200).json({ ok: true });

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const pagamento = await mpRes.json();
    if (pagamento.status !== 'approved') return res.status(200).json({ ok: true });

    const usuarioId = pagamento.metadata?.usuario_id;
    if (usuarioId) {
      await db.from('usuarios').update({
        pago: true,
        status_pagamento: 'aprovado',
        payment_id: String(data.id)
      }).eq('id', usuarioId);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
