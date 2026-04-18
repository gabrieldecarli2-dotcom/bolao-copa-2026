// api/validate-palpite.js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { jogo_id, usuario_id, palpite_time1, palpite_time2 } = req.body || {};
  if (!jogo_id || !usuario_id || palpite_time1 === undefined || palpite_time2 === undefined)
    return res.status(400).json({ ok: false, error: 'Dados incompletos' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  try {
    // Busca jogo via REST
    const jogoRes = await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo_id}&select=data_hora,status`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const jogos = await jogoRes.json();
    const jogo = jogos?.[0];
    if (!jogo) return res.status(404).json({ ok: false, error: 'Jogo não encontrado' });

    if (jogo.status !== 'aberto')
      return res.status(403).json({ ok: false, error: 'Este jogo não está mais aceitando palpites' });

    const agora = new Date();
    const inicioJogo = new Date(jogo.data_hora);
    const minutosRestantes = (inicioJogo - agora) / 60000;
    if (minutosRestantes <= 5)
      return res.status(403).json({ ok: false, error: 'Prazo encerrado. Palpites bloqueados 5 minutos antes do jogo.' });

    // Verifica palpite existente
    const palRes = await fetch(`${SUPABASE_URL}/rest/v1/palpites?usuario_id=eq.${usuario_id}&jogo_id=eq.${jogo_id}&select=id`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const palpites = await palRes.json();
    const existing = palpites?.[0];

    if (existing) {
      await fetch(`${SUPABASE_URL}/rest/v1/palpites?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ palpite_time1, palpite_time2, updated_at: new Date().toISOString() })
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/palpites`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario_id, jogo_id, palpite_time1, palpite_time2 })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
