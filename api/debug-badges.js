// api/debug-badges.js — remova após resolver
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

  const dbH = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
  const lid = league_id || '4351';

  const leagueNames = {
    '4351': 'Brazilian Serie A',
    '4328': 'English Premier League',
  };
  const leagueName = leagueNames[lid] || 'Brazilian Serie A';

  // Times da API
  const r = await fetch(`${BASE}/search_all_teams.php?l=${encodeURIComponent(leagueName)}`);
  const data = await r.json();
  const apiTeams = (data.teams || []).map(t => t.strTeam);

  // Times no banco
  const jogosRes = await fetch(
    `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=time1,time2&limit=20`,
    { headers: dbH }
  );
  const jogos = await jogosRes.json() || [];
  const dbTeams = [...new Set(jogos.flatMap(j => [j.time1, j.time2]))];

  return res.status(200).json({
    api_teams: apiTeams,
    db_teams: dbTeams,
    total_api: apiTeams.length,
    total_db: dbTeams.length
  });
}
