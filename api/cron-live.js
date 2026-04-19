// api/cron-live.js — atualiza placares ao vivo + detecta jogos que começaram
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

  const results = { live_found: 0, updated: 0, started: 0, finished: 0 };

  try {
    const agora = new Date();

    // 1. Busca livescores da v2
    const liveRes = await fetch('https://www.thesportsdb.com/api/v2/json/livescore/soccer', {
      headers: { 'X-API-KEY': SPORTS_KEY }
    });
    const liveData = await liveRes.json();
    const liveEvents = liveData.livescore || liveData.events || [];
    results.live_found = liveEvents.length;

    // 2. Para cada jogo ao vivo na API, atualiza no banco
    await Promise.all(liveEvents.slice(0, 20).map(async (e) => {
      const g1 = parseInt(e.intHomeScore ?? -1);
      const g2 = parseInt(e.intAwayScore ?? -1);
      if (g1 < 0 || g2 < 0) return;

      // Busca por api_jogo_id
      let r = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id,status`, { headers: dbH });
      let jogos = await r.json();

      // Fallback: busca por nome dos times
      if (!jogos?.length) {
        r = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?time1=ilike.*${encodeURIComponent(e.strHomeTeam)}*&time2=ilike.*${encodeURIComponent(e.strAwayTeam)}*&select=id,status`,
          { headers: dbH }
        );
        jogos = await r.json();
        if (jogos?.length) {
          await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogos[0].id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({ api_jogo_id: String(e.idEvent) })
          });
        }
      }

      if (!jogos?.length) return;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogos[0].id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'ao_vivo' })
      });
      results.updated++;
    }));

    // 3. Detecta jogos que deveriam ter iniciado (aberto + horário passou)
    const agoraISO = agora.toISOString();
    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?status=eq.aberto&data_hora=lt.${agoraISO}&select=id,api_jogo_id,time1,time2`,
      { headers: dbH }
    );
    const jogosDeveriamIniciar = await r2.json() || [];

    for (const jogo of jogosDeveriamIniciar) {
      // Verifica se está na lista de ao vivo da API
      const naAPI = liveEvents.find(e =>
        e.idEvent === jogo.api_jogo_id ||
        (e.strHomeTeam?.toLowerCase().includes(jogo.time1?.toLowerCase()) &&
         e.strAwayTeam?.toLowerCase().includes(jogo.time2?.toLowerCase()))
      );

      if (naAPI) {
        const g1 = parseInt(naAPI.intHomeScore ?? 0);
        const g2 = parseInt(naAPI.intAwayScore ?? 0);
        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'ao_vivo', api_jogo_id: String(naAPI.idEvent) })
        });
        results.started++;
      }
    }

    // 4. Detecta jogos ao_vivo que terminaram (2h+ após horário início e não está mais na API)
    const doisHAtras = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const r3 = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?status=eq.ao_vivo&data_hora=lt.${doisHAtras}&select=id,api_jogo_id,time1,time2,gol_time1,gol_time2`,
      { headers: dbH }
    );
    const jogosAoVivoAntigos = await r3.json() || [];

    for (const jogo of jogosAoVivoAntigos) {
      // Se não está mais na lista de ao vivo, encerra
      const aindaAoVivo = liveEvents.find(e => e.idEvent === jogo.api_jogo_id);
      if (!aindaAoVivo) {
        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ status: 'encerrado' })
        });
        results.finished++;

        // Calcula pontos
        const g1 = jogo.gol_time1, g2 = jogo.gol_time2;
        if (g1 !== null && g2 !== null) {
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
          }
        }
      }
    }

    return res.status(200).json({ ok: true, ...results, ts: new Date().toISOString() });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
