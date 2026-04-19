// api/cron-live.js
// Endpoint chamado automaticamente pelo cron-job.org a cada 5 minutos
// Não precisa de secret — usa CRON_SECRET para validar
module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET || process.env.ADMIN_SECRET;
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.secret;

  // Valida via header Bearer ou query param
  const isValid = authHeader === `Bearer ${CRON_SECRET}` || querySecret === CRON_SECRET;
  if (!isValid) return res.status(401).json({ error: 'Não autorizado' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const SPORTS_KEY = process.env.SPORTSDB_API_KEY;
  const BASE_V2 = 'https://www.thesportsdb.com/api/v2/json';

  const dbH = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const results = { live_updated: 0, results_updated: 0, points_calculated: 0 };

  try {
    // 1. Busca jogos ao vivo
    const liveRes = await fetch(`${BASE_V2}/livescore/soccer`, {
      headers: { 'X-API-KEY': SPORTS_KEY }
    });
    const liveData = await liveRes.json();
    const liveEvents = liveData.livescore || liveData.events || [];

    for (const e of liveEvents) {
      const g1 = parseInt(e.intHomeScore ?? -1);
      const g2 = parseInt(e.intAwayScore ?? -1);
      if (g1 < 0 || g2 < 0) continue;

      // Busca por api_jogo_id
      let jogosRes = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`, { headers: dbH });
      let jogos = await jogosRes.json();

      // Fallback: busca por nome dos times
      if (!jogos?.length) {
        jogosRes = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?time1=ilike.*${encodeURIComponent(e.strHomeTeam)}*&time2=ilike.*${encodeURIComponent(e.strAwayTeam)}*&select=id`,
          { headers: dbH }
        );
        jogos = await jogosRes.json();
        if (jogos?.length) {
          await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogos[0].id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({ api_jogo_id: String(e.idEvent) })
          });
        }
      }

      if (!jogos?.length) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogos[0].id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'ao_vivo' })
      });
      results.live_updated++;
    }

    // 2. Verifica jogos que deveriam ter terminado (status ao_vivo mas horário passou)
    const agora = new Date().toISOString();
    const vencidosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?status=eq.ao_vivo&data_hora=lt.${new Date(Date.now()-7200000).toISOString()}&select=id,api_jogo_id`,
      { headers: dbH }
    );
    const vencidos = await vencidosRes.json() || [];

    for (const jogo of vencidos) {
      if (!jogo.api_jogo_id) continue;
      const evRes = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}/lookupevent.php?id=${jogo.api_jogo_id}`);
      const evData = await evRes.json();
      const ev = evData.events?.[0];
      if (!ev || ev.intHomeScore === null) continue;
      const g1 = parseInt(ev.intHomeScore);
      const g2 = parseInt(ev.intAwayScore);

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'encerrado' })
      });
      results.results_updated++;

      // Calcula pontos
      const palRes = await fetch(`${SUPABASE_URL}/rest/v1/palpites?jogo_id=eq.${jogo.id}&calculado=eq.false`, { headers: dbH });
      const palpites = await palRes.json() || [];
      const resReal = g1 > g2 ? 'H' : g1 < g2 ? 'A' : 'E';

      for (const p of palpites) {
        const resPal = p.palpite_time1 > p.palpite_time2 ? 'H' : p.palpite_time1 < p.palpite_time2 ? 'A' : 'E';
        let pts = 0;
        if (p.palpite_time1 === g1 && p.palpite_time2 === g2) pts = 3;
        else if (resPal === resReal) pts = 1;
        await fetch(`${SUPABASE_URL}/rest/v1/palpites?id=eq.${p.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ pontos_ganhos: pts, calculado: true })
        });
        if (pts > 0) {
          const uRes = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}&select=pontos,palpites_exatos,palpites_certos`, { headers: dbH });
          const u = (await uRes.json())?.[0];
          if (u) await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({ pontos: (u.pontos||0)+pts, palpites_exatos: (u.palpites_exatos||0)+(pts===3?1:0), palpites_certos: (u.palpites_certos||0)+(pts>=1?1:0) })
          });
        }
        results.points_calculated++;
      }
    }

    return res.status(200).json({ ok: true, ...results, timestamp: new Date().toISOString() });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
