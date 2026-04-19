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

  try {
    // Pega um jogo do banco
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2&limit=1`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];
    if (!jogos.length) return res.status(200).json({ ok: false, msg: 'Nenhum jogo no banco' });

    const firstJogo = jogos[0];

    // Debug: o que o lookupevent retorna?
    const evRes = await fetch(`${BASE}/lookupevent.php?id=${firstJogo.api_jogo_id}`);
    const evText = await evRes.text();
    let evData;
    try { evData = JSON.parse(evText); } catch(e) { return res.status(200).json({ ok: false, msg: 'lookupevent retornou HTML', raw: evText.substring(0, 300) }); }

    const ev = evData.events?.[0];
    if (!ev) return res.status(200).json({ ok: false, msg: 'Evento vazio', evData });

    // Mostra os campos disponíveis no evento
    const eventFields = {
      idEvent: ev.idEvent,
      strHomeTeam: ev.strHomeTeam,
      idHomeTeam: ev.idHomeTeam,
      strAwayTeam: ev.strAwayTeam,
      idAwayTeam: ev.idAwayTeam,
      strHomeTeamBadge: ev.strHomeTeamBadge,
      strAwayTeamBadge: ev.strAwayTeamBadge,
      strLeague: ev.strLeague,
    };

    // Se o evento já tem os badges direto!
    if (ev.strHomeTeamBadge || ev.strAwayTeamBadge) {
      return res.status(200).json({ ok: true, msg: 'Evento já tem badges!', eventFields });
    }

    // Se tem IDs, testa lookupteam
    if (ev.idHomeTeam) {
      const teamRes = await fetch(`${BASE}/lookupteam.php?id=${ev.idHomeTeam}`);
      const teamText = await teamRes.text();
      let teamData;
      try { teamData = JSON.parse(teamText); } catch(e) { return res.status(200).json({ ok: false, msg: 'lookupteam retornou HTML', raw: teamText.substring(0,200) }); }
      const team = teamData.teams?.[0];
      return res.status(200).json({
        ok: false,
        msg: 'Diagnóstico completo',
        eventFields,
        team_sample: {
          strTeam: team?.strTeam,
          strTeamBadge: team?.strTeamBadge,
          strTeamBadge_with_size: team?.strTeamBadge ? team.strTeamBadge + '/small' : null
        }
      });
    }

    return res.status(200).json({ ok: false, msg: 'idHomeTeam não encontrado no evento', eventFields });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
