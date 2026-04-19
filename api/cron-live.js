// api/cron-live.js — versão rápida, max 10s
module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET || process.env.ADMIN_SECRET;
  const querySecret = req.query.secret;
  if (!querySecret || querySecret !== CRON_SECRET)
    return res.status(401).json({ error: 'Não autorizado' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const SPORTS_KEY = process.env.SPORTSDB_API_KEY;

  const dbH = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  try {
    // Busca livescores da v2 — rápido, 1 chamada só
    const liveRes = await fetch('https://www.thesportsdb.com/api/v2/json/livescore/soccer', {
      headers: { 'X-API-KEY': SPORTS_KEY }
    });
    const liveData = await liveRes.json();
    const events = liveData.livescore || liveData.events || [];

    let updated = 0;

    // Atualiza só os jogos que estão no banco — sem buscas extras
    await Promise.all(events.slice(0, 15).map(async (e) => {
      const g1 = parseInt(e.intHomeScore ?? -1);
      const g2 = parseInt(e.intAwayScore ?? -1);
      if (g1 < 0 || g2 < 0) return;

      // Busca por ID
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`, { headers: dbH });
      const jogos = await r.json();
      if (!jogos?.length) return;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogos[0].id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'ao_vivo' })
      });
      updated++;
    }));

    return res.status(200).json({ ok: true, live: events.length, updated, ts: Date.now() });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
