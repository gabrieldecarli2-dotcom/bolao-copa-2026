// api/sync-badges.js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, league_id } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const SPORTS_KEY = process.env.SPORTSDB_API_KEY || '123';
  const BASE = `https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}`;

  if (!secret || secret.trim() !== ADMIN_SECRET?.trim())
    return res.status(401).json({ error: 'Não autorizado' });

  const dbH = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const lid = league_id || '4351';

  try {
    // 1. Busca times do banco
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2&limit=5`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];

    if (!jogos.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum jogo com api_jogo_id no banco', jogos: [] });

    // 2. Usa o primeiro api_jogo_id para buscar o evento e pegar os IDs dos times
    const firstEvent = jogos[0];
    const evRes = await fetch(`${BASE}/lookupevent.php?id=${firstEvent.api_jogo_id}`);
    const evData = await evRes.json();
    const ev = evData.events?.[0];

    if (!ev)
      return res.status(200).json({ ok: false, msg: 'Evento não encontrado', api_jogo_id: firstEvent.api_jogo_id });

    // 3. Agora busca TODOS os jogos para montar mapa de times
    const allJogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2`,
      { headers: dbH }
    );
    const allJogos = await allJogosRes.json() || [];

    // 4. Para cada jogo, busca os IDs dos times via lookupevent
    // Pega eventos únicos (máx 20 para não exceder rate limit)
    const sampleJogos = allJogos.slice(0, 20);
    const teamBadges = {}; // nome -> badge url

    for (const jogo of sampleJogos) {
      const r = await fetch(`${BASE}/lookupevent.php?id=${jogo.api_jogo_id}`);
      const d = await r.json();
      const e = d.events?.[0];
      if (!e) continue;

      // Busca badge do time da casa
      if (e.idHomeTeam && !teamBadges[e.strHomeTeam]) {
        const tr = await fetch(`${BASE}/lookupteam.php?id=${e.idHomeTeam}`);
        const td = await tr.json();
        const badge = td.teams?.[0]?.strTeamBadge;
        if (badge) teamBadges[e.strHomeTeam] = badge + '/small';
      }
      // Busca badge do time visitante
      if (e.idAwayTeam && !teamBadges[e.strAwayTeam]) {
        const tr = await fetch(`${BASE}/lookupteam.php?id=${e.idAwayTeam}`);
        const td = await tr.json();
        const badge = td.teams?.[0]?.strTeamBadge;
        if (badge) teamBadges[e.strAwayTeam] = badge + '/small';
      }
    }

    // 5. Atualiza TODOS os jogos no banco
    let updated = 0;
    for (const jogo of allJogos) {
      const badge1 = teamBadges[jogo.time1];
      const badge2 = teamBadges[jogo.time2];
      if (!badge1 && !badge2) continue;

      const update = {};
      if (badge1) update.flag1 = badge1;
      if (badge2) update.flag2 = badge2;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify(update)
      });
      updated++;
    }

    return res.status(200).json({
      ok: true,
      msg: `${updated} jogos atualizados com escudos`,
      updated,
      teams_with_badge: Object.keys(teamBadges).length,
      sample: Object.entries(teamBadges).slice(0, 5).map(([k,v]) => `${k}: ${v}`),
      first_event_sample: { home: ev.strHomeTeam, away: ev.strAwayTeam, idHome: ev.idHomeTeam }
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
