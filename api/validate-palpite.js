// api/validate-palpite.js
// Valida se o palpite ainda pode ser salvo (30 min antes do jogo)
// Roda no servidor — não pode ser burlado pelo usuário

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { jogo_id, usuario_id, palpite_time1, palpite_time2 } = req.body || {};

  if (!jogo_id || !usuario_id || palpite_time1 === undefined || palpite_time2 === undefined) {
    return res.status(400).json({ ok: false, error: 'Dados incompletos' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Busca o jogo
  const { data: jogo, error } = await db.from('jogos').select('data_hora, status').eq('id', jogo_id).single();
  if (error || !jogo) return res.status(404).json({ ok: false, error: 'Jogo não encontrado' });

  // Verifica status
  if (jogo.status !== 'aberto') {
    return res.status(403).json({ ok: false, error: 'Este jogo não está mais aceitando palpites' });
  }

  // Verifica prazo de 30 minutos
  const agora = new Date();
  const inicioJogo = new Date(jogo.data_hora);
  const minutosRestantes = (inicioJogo - agora) / 60000;

  if (minutosRestantes <= 30) {
    return res.status(403).json({
      ok: false,
      error: `Prazo encerrado. Palpites são bloqueados 30 minutos antes do jogo.`
    });
  }

  // Tudo ok — salva o palpite
  const { data: existing } = await db.from('palpites')
    .select('id').eq('usuario_id', usuario_id).eq('jogo_id', jogo_id).single();

  let saveError;
  if (existing) {
    const { error: e } = await db.from('palpites')
      .update({ palpite_time1, palpite_time2, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    saveError = e;
  } else {
    const { error: e } = await db.from('palpites')
      .insert({ usuario_id, jogo_id, palpite_time1, palpite_time2 });
    saveError = e;
  }

  if (saveError) return res.status(500).json({ ok: false, error: saveError.message });

  return res.status(200).json({ ok: true });
}
