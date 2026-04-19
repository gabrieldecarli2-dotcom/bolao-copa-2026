// api/sync-badges.js
// Estratégia simplificada: busca 1 evento, pega os IDs dos times,
// depois usa search_all_teams para pegar todos os badges de uma vez
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
    // 1. Busca 1 jogo do banco para pegar um api_jogo_id válido
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2&limit=1`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json();
    if (!jogos?.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum jogo com api_jogo_id no banco' });

    // 2. Lookup do evento para pegar idHomeTeam
    const evRes = await fetch(`${BASE}/lookupevent.php?id=${jogos[0].api_jogo_id}`);
    const evData = await evRes.json();
    const ev = evData.events?.[0];
    if (!ev)
      return res.status(200).json({ ok: false, msg: 'Evento não encontrado na API', api_jogo_id: jogos[0].api_jogo_id });

    // 3. Lookup do time para pegar idLeague e buscar todos os times da liga
    const teamRes = await fetch(`${BASE}/lookupteam.php?id=${ev.idHomeTeam}`);
    const teamData = await teamRes.json();
    const team = teamData.teams?.[0];
    if (!team)
      return res.status(200).json({ ok: false, msg: 'Time não encontrado', idHomeTeam: ev.idHomeTeam });

    // 4. Busca todos os times da liga pelo ID correto
    const allTeamsRes = await fetch(`${BASE}/lookup_all_teams.php?id=${team.idLeague || lid}`);
    const allTeamsData = await allTeamsRes.json();
    const allTeams = allTeamsData.teams || [];

    // Se não funcionou, tenta pelo nome da liga
    let teamsList = allTeams;
    if (!teamsList.length) {
      const byNameRes = await fetch(`${BASE}/search_all_teams.php?l=${encodeURIComponent(ev.strLeague || 'Brazilian Serie A')}`);
      const byNameData = await byNameRes.json();
      teamsList = byNameData.teams || [];
    }

    if (!teamsList.length)
      return res.status(200).json({
        ok: false,
        msg: 'Nenhum time encontrado',
        tried_league_id: team.idLeague,
        league_name: ev.strLeague,
        team_sample: team
      });

    // 5. Monta mapa nome -> badge
    const badgeMap = {};
    for (const t of teamsList) {
      if (t.strTeamBadge) {
        badgeMap[t.strTeam] = t.strTeamBadge + '/small';
      }
    }

    // 6. Busca todos os jogos do banco e atualiza
    const allJogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,time1,time2`,
      { headers: dbH }
    );
    const allJogos = await allJogosRes.json() || [];

    let updated = 0;
    const noMatch = new Set();

    for (const jogo of allJogos) {
      const b1 = badgeMap[jogo.time1];
      const b2 = badgeMap[jogo.time2];
      if (!b1) noMatch.add(jogo.time1);
      if (!b2) noMatch.add(jogo.time2);
      if (!b1 && !b2) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify({ ...(b1 && { flag1: b1 }), ...(b2 && { flag2: b2 }) })
      });
      updated++;
    }

    return res.status(200).json({
      ok: true,
      msg: `${updated} jogos atualizados com escudos`,
      updated,
      teams_in_api: teamsList.length,
      teams_with_badge: Object.keys(badgeMap).length,
      api_team_names: Object.keys(badgeMap).slice(0, 10),
      no_match: [...noMatch].slice(0, 10)
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
