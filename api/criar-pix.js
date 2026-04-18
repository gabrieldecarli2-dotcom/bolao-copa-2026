// api/criar-pix.js
// Sem dependências externas — usa fetch nativo do Node 18+

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { usuario_id, email, nome } = req.body || {};
  if (!usuario_id || !email) return res.status(400).json({ error: 'Dados incompletos' });

  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!MP_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado' });

  try {
    // Busca taxa via Supabase REST API (sem SDK)
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/configuracoes?chave=eq.taxa_participacao`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const cfgData = await cfgRes.json();
    const taxa = parseFloat(cfgData?.[0]?.valor || 20);

    // Verifica se já pagou
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario_id}&select=pago,payment_id`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const userData = await userRes.json();
    if (userData?.[0]?.pago) return res.status(400).json({ error: 'Pagamento já confirmado' });

    // Cria PIX no Mercado Pago
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
          last_name: (nome || 'Bolão').split(' ').slice(1).join(' ') || 'Bolao',
        },
        notification_url: 'https://copa-bolao.vercel.app/api/webhook-mp',
        metadata: { usuario_id },
      }),
    });

    const text = await mpResponse.text();
    let mpData;
    try { mpData = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Resposta inválida do MP: ' + text.substring(0, 200) }); }

    if (!mpResponse.ok) {
      return res.status(500).json({ error: mpData.message || 'Erro no Mercado Pago', detail: mpData });
    }

    // Salva payment_id via Supabase REST API
    const paymentId = String(mpData.id);
    await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_id: paymentId })
    });

    return res.status(200).json({
      ok: true,
      payment_id: paymentId,
      pix_copia_cola: mpData.point_of_interaction?.transaction_data?.qr_code,
      pix_qr_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64,
      valor: taxa,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
