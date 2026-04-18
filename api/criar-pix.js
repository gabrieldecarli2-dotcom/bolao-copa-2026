// api/criar-pix.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { usuario_id, email, nome } = req.body || {};
  if (!usuario_id || !email) return res.status(400).json({ error: 'Dados incompletos' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!MP_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado na Vercel' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase não configurado' });

  const db = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Busca taxa configurada
  const { data: configs } = await db.from('configuracoes').select('*');
  const taxa = parseFloat(configs?.find(c => c.chave === 'taxa_participacao')?.valor || 20);

  // Verifica se já pagou
  const { data: usuario } = await db.from('usuarios').select('pago, payment_id').eq('id', usuario_id).single();
  if (usuario?.pago) return res.status(400).json({ error: 'Pagamento já confirmado para este usuário' });

  try {
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_TOKEN}`,
        'X-Idempotency-Key': `bolao-${usuario_id}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: taxa,
        description: 'Bolão Copa 2026 - Taxa de participação',
        payment_method_id: 'pix',
        payer: {
          email: email,
          first_name: (nome || 'Participante').split(' ')[0],
          last_name: (nome || 'Bolão').split(' ').slice(1).join(' ') || 'Bolão',
        },
        notification_url: 'https://copa-bolao.vercel.app/api/webhook-mp',
        metadata: { usuario_id },
      }),
    });

    const text = await mpResponse.text();
    let mpData;
    try { mpData = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Resposta inválida do MP: ' + text.substring(0, 300) }); }

    if (!mpResponse.ok) {
      return res.status(500).json({ error: mpData.message || mpData.error || 'Erro no Mercado Pago', detail: mpData });
    }

    const pixCopiaECola = mpData.point_of_interaction?.transaction_data?.qr_code;
    const pixQrCodeBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64;
    const paymentId = mpData.id;

    await db.from('usuarios').update({ payment_id: String(paymentId) }).eq('id', usuario_id);

    return res.status(200).json({
      ok: true,
      payment_id: paymentId,
      pix_copia_cola: pixCopiaECola,
      pix_qr_base64: pixQrCodeBase64,
      valor: taxa,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
