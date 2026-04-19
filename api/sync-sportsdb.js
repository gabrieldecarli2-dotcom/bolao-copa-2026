// api/sync-sportsdb.js
// Sincroniza jogos e resultados usando TheSportsDB (gratuito, chave 123)
// Endpoint manual — chame pelo admin para atualizar

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, league_id, action } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!secret || secret.trim() !== ADMIN_SECRET?.trim())
    return res.status(401).json({ error: 'Não autorizado' });

  const BASE = 'https://www.thesportsdb.com/api/v1/json/123';

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // Ação: buscar próximos jogos de uma liga
    if (action === 'next' || !action) {
      const lid = league_id || '4328'; // Premier League padrão
      const r = await fetch(`${BASE}/eventsnextleague.php?id=${lid}`);
      const data = await r.json();
      const events = data.events || [];

      if (!events.length) return res.status(200).json({ ok: true, msg: 'Nenhum jogo encontrado', events: [] });

      let inserted = 0;
      for (const e of events.slice(0, 20)) {
        // Verifica se já existe pelo api_jogo_id
        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`,
          { headers }
        );
        const existing = await check.json();
        if (existing?.[0]) continue; // já existe

        const dataHora = new Date(`${e.dateEvent}T${e.strTime || '00:00:00'}Z`).toISOString();
        await fetch(`${SUPABASE_URL}/rest/v1/jogos`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            api_jogo_id: e.idEvent,
            grupo: e.strLeague || 'Liga',
            fase: 'grupo',
            time1: e.strHomeTeam,
            flag1: '🏳️',
            time2: e.strAwayTeam,
            flag2: '🏳️',
            data_hora: dataHora,
            status: 'aberto',
          })
        });
        inserted++;
      }

      return res.status(200).json({ ok: true, msg: `${inserted} jogos inseridos de ${events.length} encontrados`, events: events.slice(0,5).map(e => `${e.strHomeTeam} x ${e.strAwayTeam} - ${e.dateEvent}`) });
    }

    // Ação: atualizar resultados de jogos ao vivo / recentes
    if (action === 'results') {
      const lid = league_id || '4328';
      const r = await fetch(`${BASE}/eventspastleague.php?id=${lid}`);
      const data = await r.json();
      const events = (data.events || []).slice(0, 15); // últimos 15 jogos

      let updated = 0, calculated = 0;
      for (const e of events) {
        if (e.intHomeScore === null || e.intAwayScore === null) continue;

        const g1 = parseInt(e.intHomeScore);
        const g2 = parseInt(e.intAwayScore);

        // Busca jogo pelo api_jogo_id
        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id,status`,
          { headers }
        );
        const jogos = await check.json();
        const jogo = jogos?.[0];
        if (!jogo || jogo.status === 'encerrado') continue;

        // Atualiza o jogo
        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'encerrado' })
        });
        updated++;

        // Calcula pontos dos palpites
        const palRes = await fetch(
          `${SUPABASE_URL}/rest/v1/palpites?jogo_id=eq.${jogo.id}&calculado=eq.false`,
          { headers }
        );
        const palpites = await palRes.json();

        const resReal = g1 > g2 ? 'H' : g1 < g2 ? 'A' : 'E';
        for (const p of (palpites || [])) {
          const resPal = p.palpite_time1 > p.palpite_time2 ? 'H' : p.palpite_time1 < p.palpite_time2 ? 'A' : 'E';
          let pts = 0;
          if (p.palpite_time1 === g1 && p.palpite_time2 === g2) pts = 3;
          else if (resPal === resReal) pts = 1;

          await fetch(`${SUPABASE_URL}/rest/v1/palpites?id=eq.${p.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ pontos_ganhos: pts, calculado: true })
          });

          if (pts > 0) {
            const uRes = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}&select=pontos,palpites_exatos,palpites_certos`, { headers });
            const u = (await uRes.json())?.[0];
            if (u) {
              await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}`, {
                method: 'PATCH', headers,
                body: JSON.stringify({
                  pontos: (u.pontos||0) + pts,
                  palpites_exatos: (u.palpites_exatos||0) + (pts===3?1:0),
                  palpites_certos: (u.palpites_certos||0) + (pts>=1?1:0)
                })
              });
            }
          }
          calculated++;
        }
      }

      return res.status(200).json({ ok: true, msg: `${updated} jogos atualizados, ${calculated} palpites calculados` });
    }

    return res.status(400).json({ error: 'Action inválida. Use: next ou results' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
