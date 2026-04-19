// api/sync-badges.js
// Busca escudos dos times da liga e salva no banco
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
    // Busca todos os times da liga
    const r = await fetch(`${BASE}/lookup_all_teams.php?id=${lid}`);
    const data = await r.json();
    const teams = data.teams || [];

    if (!teams.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum time encontrado' });

    // Monta mapa de nome -> URL do escudo
    const badgeMap = {};
    for (const t of teams) {
      if (t.strTeamBadge) {
        badgeMap[t.strTeam.toLowerCase()] = t.strTeamBadge + '/tiny';
        // Alternativas de nome
        if (t.strTeamAlternate) badgeMap[t.strTeamAlternate.toLowerCase()] = t.strTeamBadge + '/tiny';
      }
    }

    // Busca todos os jogos que têm api_jogo_id (importados pela API)
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,time1,time2,flag1,flag2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];

    let updated = 0;
    for (const jogo of jogos) {
      const badge1 = badgeMap[jogo.time1.toLowerCase()];
      const badge2 = badgeMap[jogo.time2.toLowerCase()];

      if (!badge1 && !badge2) continue;

      const update = {};
      if (badge1) update.flag1 = badge1;
      if (badge2) update.flag2 = badge2;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
        method: 'PATCH',
        headers: dbH,
        body: JSON.stringify(update)
      });
      updated++;
    }

    return res.status(200).json({
      ok: true,
      msg: `${updated} jogos com escudos atualizados`,
      teams: teams.length,
      updated,
      sample: Object.entries(badgeMap).slice(0, 5).map(([k,v]) => `${k}: ${v}`)
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
