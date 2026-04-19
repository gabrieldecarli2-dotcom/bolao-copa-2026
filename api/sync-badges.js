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

  // Mapa de league_id -> nome para a API
  const leagueNames = {
    '4351': 'Brazilian Serie A',
    '4328': 'English Premier League',
    '4335': 'Spanish La Liga',
    '4332': 'Serie A',
    '4331': 'Bundesliga',
    '4334': 'Ligue 1',
    '4480': 'UEFA Champions League',
    '4415': 'Copa Libertadores',
  };

  const leagueName = leagueNames[lid] || 'Brazilian Serie A';

  try {
    // Endpoint correto: search_all_teams com nome da liga
    const r = await fetch(`${BASE}/search_all_teams.php?l=${encodeURIComponent(leagueName)}`);
    const text = await r.text();

    let data;
    try { data = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Resposta inválida da API: ' + text.substring(0,200) }); }

    const teams = data.teams || [];
    if (!teams.length)
      return res.status(200).json({ ok: false, msg: `Nenhum time encontrado para "${leagueName}"` });

    // Monta mapa nome -> badge URL
    const badgeMap = {};
    for (const t of teams) {
      if (t.strTeamBadge) {
        const badge = t.strTeamBadge + '/tiny';
        badgeMap[t.strTeam.toLowerCase()] = badge;
        if (t.strTeamShort) badgeMap[t.strTeamShort.toLowerCase()] = badge;
        if (t.strTeamAlternate) badgeMap[t.strTeamAlternate.toLowerCase()] = badge;
      }
    }

    // Busca jogos importados via API
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,time1,time2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];

    let updated = 0;
    for (const jogo of jogos) {
      const badge1 = findBadge(jogo.time1, badgeMap);
      const badge2 = findBadge(jogo.time2, badgeMap);
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
      msg: `${updated} jogos com escudos atualizados (${teams.length} times encontrados)`,
      teams: teams.length,
      updated,
      teamsSample: teams.slice(0,5).map(t => t.strTeam)
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}

function findBadge(teamName, badgeMap) {
  if (!teamName) return null;
  const n = teamName.toLowerCase();
  // Busca exata
  if (badgeMap[n]) return badgeMap[n];
  // Busca parcial
  for (const [key, val] of Object.entries(badgeMap)) {
    if (n.includes(key) || key.includes(n)) return val;
  }
  return null;
}
