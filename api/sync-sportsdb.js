// api/sync-sportsdb.js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, league_id, action } = req.body || {};
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
    // ── PRÓXIMOS JOGOS ──
    if (action === 'next') {
      const r = await fetch(`${BASE}/eventsnextleague.php?id=${lid}`);
      const data = await r.json();
      const events = data.events || [];
      let imported = 0;

      for (const e of events) {
        const check = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`, { headers: dbH });
        if ((await check.json())?.[0]) continue;
        const dataHora = new Date(`${e.dateEvent}T${e.strTime||'12:00:00'}Z`).toISOString();
        await fetch(`${SUPABASE_URL}/rest/v1/jogos`, {
          method: 'POST', headers: dbH,
          body: JSON.stringify({ api_jogo_id: String(e.idEvent), grupo: e.strRound ? `Rodada ${e.intRound}` : e.strLeague, fase: 'grupo', time1: e.strHomeTeam, flag1: '🏳️', time2: e.strAwayTeam, flag2: '🏳️', data_hora: dataHora, status: 'aberto' })
        });
        imported++;
      }
      return res.status(200).json({ ok: true, msg: `${imported} jogos importados de ${events.length}`, imported });
    }

    // ── TEMPORADA COMPLETA (só futuros) ──
    if (action === 'season') {
      const year = new Date().getFullYear();
      const seasons = [`${year}`, `${year-1}-${year}`, `${year}-${year+1}`];
      let events = [];

      for (const s of seasons) {
        const r = await fetch(`${BASE}/eventsseason.php?id=${lid}&s=${s}`);
        const data = await r.json();
        if (data.events?.length) { events = data.events; break; }
      }

      if (!events.length)
        return res.status(200).json({ ok: true, msg: 'Nenhum jogo encontrado', imported: 0 });

      const agora = new Date();
      // Filtra só jogos futuros
      const futuros = events.filter(e => new Date(`${e.dateEvent}T${e.strTime||'12:00:00'}Z`) > agora);

      let imported = 0;
      for (const e of futuros) {
        const check = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`, { headers: dbH });
        if ((await check.json())?.[0]) continue;
        const dataHora = new Date(`${e.dateEvent}T${e.strTime||'12:00:00'}Z`).toISOString();
        await fetch(`${SUPABASE_URL}/rest/v1/jogos`, {
          method: 'POST', headers: dbH,
          body: JSON.stringify({ api_jogo_id: String(e.idEvent), grupo: e.strRound ? `Rodada ${e.intRound}` : e.strLeague, fase: 'grupo', time1: e.strHomeTeam, flag1: '🏳️', time2: e.strAwayTeam, flag2: '🏳️', data_hora: dataHora, status: 'aberto' })
        });
        imported++;
      }
      return res.status(200).json({ ok: true, msg: `${imported} jogos futuros importados de ${events.length} totais (${events.length - futuros.length} passados ignorados)`, imported });
    }

    // ── LIVESCORES (v2 API com header auth) ──
    if (action === 'live') {
      const BASE_V2 = 'https://www.thesportsdb.com/api/v2/json';

      // v2 livescores — endpoint correto sem .php, chave no header
      const endpoints = [
        `${BASE_V2}/livescore/soccer`,
        `${BASE_V2}/livescore/Soccer`,
      ];

      let events = [];
      let lastRaw = '';

      for (const url of endpoints) {
        const r = await fetch(url, { headers: { 'X-API-KEY': SPORTS_KEY } });
        const text = await r.text();
        lastRaw = text.substring(0, 400);
        try {
          const data = JSON.parse(text);
          const evs = data.livescore || data.events || data.livescores || data.results || [];
          if (evs.length) { events = evs; break; }
        } catch(e) {}
      }

      if (!events.length) {
        return res.status(200).json({
          ok: false,
          msg: 'Nenhum jogo ao vivo no momento',
          raw_sample: lastRaw,
        });
      }

      // Filtra só jogos de futebol da liga correta se lid informado
      const filteredEvents = lid
        ? events.filter(e => e.idLeague === lid || e.strLeague?.toLowerCase().includes('brazilian') || e.strLeague?.toLowerCase().includes('brasileir'))
        : events;

      let updated = 0;
      const notInDB = [];

      for (const e of events) {
        const g1 = parseInt(e.intHomeScore ?? -1);
        const g2 = parseInt(e.intAwayScore ?? -1);
        if (g1 < 0 || g2 < 0) continue;

        // Busca no banco pelo api_jogo_id
        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id,status`,
          { headers: dbH }
        );
        const jogo = (await check.json())?.[0];

        if (!jogo) {
          // Tenta casar pelo nome dos times
          const t1 = encodeURIComponent(e.strHomeTeam);
          const t2 = encodeURIComponent(e.strAwayTeam);
          const nameCheck = await fetch(
            `${SUPABASE_URL}/rest/v1/jogos?time1=ilike.*${e.strHomeTeam}*&time2=ilike.*${e.strAwayTeam}*&select=id,status`,
            { headers: dbH }
          );
          const jogoByName = (await nameCheck.json())?.[0];
          if (!jogoByName) {
            notInDB.push(`${e.strHomeTeam} x ${e.strAwayTeam} (${e.strLeague}) id:${e.idEvent}`);
            continue;
          }
          // Atualiza o api_jogo_id e o placar
          await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogoByName.id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({ api_jogo_id: String(e.idEvent), gol_time1: g1, gol_time2: g2, status: 'ao_vivo' })
          });
          updated++;
          continue;
        }

        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'ao_vivo' })
        });
        updated++;
      }

      return res.status(200).json({
        ok: true,
        msg: updated > 0
          ? `🔴 ${updated} jogos ao vivo atualizados!`
          : `${events.length} jogos ao vivo encontrados mas nenhum está no seu banco. Veja not_in_db.`,
        live_total: events.length,
        updated,
        leagues: [...new Set(events.map(e => `${e.strLeague} (${e.idLeague})`))],
        not_in_db: notInDB.slice(0, 5),
        sample: events.slice(0,3).map(e => `${e.strHomeTeam} ${e.intHomeScore}x${e.intAwayScore} ${e.strAwayTeam} - ${e.strLeague}`)
      });
    }

    // ── RESULTADOS RECENTES + CALCULAR PONTOS ──
    if (action === 'results') {
      const r = await fetch(`${BASE}/eventspastleague.php?id=${lid}`);
      const data = await r.json();
      const events = (data.events || []).slice(0, 20);
      let updated = 0, calculated = 0;

      for (const e of events) {
        if (e.intHomeScore === null || e.intHomeScore === '') continue;
        const g1 = parseInt(e.intHomeScore);
        const g2 = parseInt(e.intAwayScore);

        const check = await fetch(`${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id,status`, { headers: dbH });
        const jogo = (await check.json())?.[0];
        if (!jogo || jogo.status === 'encerrado') continue;

        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'encerrado' })
        });
        updated++;

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
          calculated++;
        }
      }
      return res.status(200).json({ ok: true, msg: `${updated} jogos encerrados · ${calculated} palpites calculados`, updated, calculated });
    }

    return res.status(400).json({ error: 'Action inválida: next, season, live, results' });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
