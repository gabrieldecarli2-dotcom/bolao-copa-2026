// api/verificar-pagamento.js
// Consulta o status do pagamento no Mercado Pago e confirma no banco
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { usuario_id } = req.body || {};
  if (!usuario_id) return res.status(400).json({ error: 'usuario_id obrigatório' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  try {
    // Busca payment_id do usuário
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario_id}&select=pago,payment_id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const users = await userRes.json();
    const usuario = users?.[0];

    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Se já está pago no banco, retorna direto
    if (usuario.pago) return res.status(200).json({ ok: true, pago: true });

    // Se não tem payment_id ainda, não conseguimos verificar
    if (!usuario.payment_id) {
      return res.status(200).json({ ok: true, pago: false, msg: 'Pagamento ainda não identificado' });
    }

    // Consulta o Mercado Pago
    const mpRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${usuario.payment_id}`,
      { headers: { 'Authorization': `Bearer ${MP_TOKEN}` } }
    );
    const pagamento = await mpRes.json();

    if (pagamento.status === 'approved') {
      // Confirma no banco
      await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario_id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pago: true, status_pagamento: 'aprovado' })
      });
      return res.status(200).json({ ok: true, pago: true });
    }

    return res.status(200).json({ ok: true, pago: false, status: pagamento.status });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
