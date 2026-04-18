// api/webhook-mp.js
// Recebe notificações automáticas do Mercado Pago
// Quando o PIX é pago, confirma automaticamente no sistema

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Mercado Pago envia GET para validar e POST com dados
  if (req.method === 'GET') return res.status(200).send('OK');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

  try {
    const { type, data } = req.body || {};

    // Só processa notificações de pagamento
    if (type !== 'payment' || !data?.id) {
      return res.status(200).json({ ok: true, message: 'Ignorado' });
    }

    const paymentId = data.id;

    // Consulta o pagamento no Mercado Pago para confirmar
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const pagamento = await mpRes.json();

    if (pagamento.status !== 'approved') {
      return res.status(200).json({ ok: true, message: `Status: ${pagamento.status}` });
    }

    // Busca o usuário pelo payment_id
    const { data: usuario } = await db
      .from('usuarios')
      .select('id, pago')
      .eq('payment_id', String(paymentId))
      .single();

    if (!usuario) {
      // Tenta pelo metadata
      const usuarioId = pagamento.metadata?.usuario_id;
      if (usuarioId) {
        await db.from('usuarios').update({
          pago: true,
          status_pagamento: 'aprovado',
          payment_id: String(paymentId)
        }).eq('id', usuarioId);
      }
      return res.status(200).json({ ok: true });
    }

    if (!usuario.pago) {
      await db.from('usuarios').update({
        pago: true,
        status_pagamento: 'aprovado'
      }).eq('id', usuario.id);
    }

    return res.status(200).json({ ok: true, confirmed: true });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
