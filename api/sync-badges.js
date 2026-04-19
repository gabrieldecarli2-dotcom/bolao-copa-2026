// api/sync-badges.js
// Busca badges usando lookupevent para pegar team IDs,
// depois lookupteam para pegar o badge de cada time único
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

  try {
    // 1. Pega todos os api_jogo_ids do banco
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];
    if (!jogos.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum jogo com api_jogo_id no banco' });

    // 2. Busca eventos em lotes de 10 para extrair team IDs únicos
    // Limita a 10 eventos para não exceder rate limit
    const sample = jogos.slice(0, 10);
    const teamIdMap = {}; // teamName -> teamId

    for (const jogo of sample) {
      try {
        const r = await fetch(`${BASE}/lookupevent.php?id=${jogo.api_jogo_id}`);
        const d = await r.json();
        const e = d.events?.[0];
        if (!e) continue;
        if (e.idHomeTeam && e.strHomeTeam) teamIdMap[e.strHomeTeam] = e.idHomeTeam;
        if (e.idAwayTeam && e.strAwayTeam) teamIdMap[e.strAwayTeam] = e.idAwayTeam;
      } catch(e) { continue; }
    }

    if (!Object.keys(teamIdMap).length)
      return res.status(200).json({ ok: false, msg: 'Não foi possível extrair IDs dos times', sample_jogo: sample[0] });

    // 3. Busca badge de cada time único (máx 20 times)
    const badgeMap = {}; // teamName -> badgeUrl
    const uniqueTeams = Object.entries(teamIdMap).slice(0, 20);

    for (const [name, tid] of uniqueTeams) {
      try {
        const r = await fetch(`${BASE}/lookupteam.php?id=${tid}`);
        const d = await r.json();
        const badge = d.teams?.[0]?.strTeamBadge;
        if (badge) badgeMap[name] = badge + '/small';
      } catch(e) { continue; }
    }

    // 4. Atualiza todos os jogos no banco
    let updated = 0;
    const noMatch = new Set();

    for (const jogo of jogos) {
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
      ok: updated > 0,
      msg: `${updated} jogos atualizados com escudos`,
      updated,
      badges_found: Object.keys(badgeMap).length,
      team_names_api: Object.keys(badgeMap),
      no_match: [...noMatch].slice(0, 10)
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
