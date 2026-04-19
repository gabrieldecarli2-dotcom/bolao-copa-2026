// api/validate-palpite.js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { jogo_id, usuario_id, palpite_time1, palpite_time2 } = req.body || {};
  if (!jogo_id || !usuario_id || palpite_time1 === undefined || palpite_time2 === undefined)
    return res.status(400).json({ ok: false, error: 'Dados incompletos' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

  // Headers padrão para Supabase REST
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // Busca jogo
    const jogoRes = await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo_id}&select=data_hora,status`, { headers });
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
    const palRes = await fetch(
      `${SUPABASE_URL}/rest/v1/palpites?usuario_id=eq.${usuario_id}&jogo_id=eq.${jogo_id}&select=id`,
      { headers }
    );
    const palpites = await palRes.json();
    const existing = palpites?.[0];

    let saveRes;
    if (existing) {
      saveRes = await fetch(`${SUPABASE_URL}/rest/v1/palpites?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ palpite_time1, palpite_time2, updated_at: new Date().toISOString() })
      });
    } else {
      saveRes = await fetch(`${SUPABASE_URL}/rest/v1/palpites`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ usuario_id, jogo_id, palpite_time1, palpite_time2 })
      });
    }

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      return res.status(500).json({ ok: false, error: 'Erro ao salvar: ' + errText.substring(0, 200) });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
