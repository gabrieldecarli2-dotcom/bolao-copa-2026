// api/sync-badges.js
// Busca escudos usando os jogos já importados — pega o idHomeTeam/idAwayTeam
// e busca o badge diretamente pelo ID do time
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
    // Pega jogos da temporada para extrair IDs dos times
    const year = new Date().getFullYear();
    const seasons = [`${year}`, `${year-1}-${year}`, `${year}-${year+1}`];
    let events = [];
    for (const s of seasons) {
      const r = await fetch(`${BASE}/eventsseason.php?id=${lid}&s=${s}`);
      const d = await r.json();
      if (d.events?.length) { events = d.events; break; }
    }

    if (!events.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum evento encontrado para extrair times' });

    // Monta mapa de nome do time -> badge
    // A API retorna strHomeTeam, idHomeTeam, strAwayTeam, idAwayTeam
    // Busca badge de cada time único pelo ID
    const teamIds = {};
    for (const e of events) {
      if (e.idHomeTeam && e.strHomeTeam) teamIds[e.strHomeTeam] = e.idHomeTeam;
      if (e.idAwayTeam && e.strAwayTeam) teamIds[e.strAwayTeam] = e.idAwayTeam;
    }

    // Busca badge para cada time único
    const badgeByName = {};
    const teamNames = Object.keys(teamIds);

    // Busca em lotes de 5 para não exceder rate limit
    for (let i = 0; i < teamNames.length; i += 5) {
      const batch = teamNames.slice(i, i + 5);
      await Promise.all(batch.map(async (name) => {
        const tid = teamIds[name];
        const r = await fetch(`${BASE}/lookupteam.php?id=${tid}`);
        const d = await r.json();
        const team = d.teams?.[0];
        if (team?.strTeamBadge) {
          badgeByName[name.toLowerCase()] = team.strTeamBadge + '/small';
        }
      }));
    }

    // Busca jogos no banco
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,time1,time2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];

    let updated = 0;
    const noMatch = new Set();

    for (const jogo of jogos) {
      const badge1 = badgeByName[jogo.time1.toLowerCase()];
      const badge2 = badgeByName[jogo.time2.toLowerCase()];

      if (!badge1) noMatch.add(jogo.time1);
      if (!badge2) noMatch.add(jogo.time2);
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
      teams_found: Object.keys(badgeByName).length,
      no_match: [...noMatch].slice(0, 10),
      sample_badges: Object.entries(badgeByName).slice(0, 5).map(([k,v]) => `${k}: ${v}`)
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
