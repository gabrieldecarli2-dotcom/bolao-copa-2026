// api/sync-sportsdb.js
// Sincroniza jogos usando TheSportsDB Premium
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

  const dbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const lid = league_id || '4351'; // Brasileirão padrão

  try {
    // ── IMPORTAR PRÓXIMOS JOGOS ──
    if (action === 'next') {
      // Premium: retorna todos os próximos jogos da liga
      const r = await fetch(`${BASE}/eventsnextleague.php?id=${lid}`);
      const data = await r.json();
      const events = data.events || [];

      if (!events.length)
        return res.status(200).json({ ok: true, msg: 'Nenhum jogo futuro encontrado', imported: 0 });

      let imported = 0;
      for (const e of events) {
        // Verifica se já existe
        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`,
          { headers: dbHeaders }
        );
        const existing = await check.json();
        if (existing?.[0]) continue;

        const dataHora = new Date(`${e.dateEvent}T${e.strTime || '12:00:00'}Z`).toISOString();

        await fetch(`${SUPABASE_URL}/rest/v1/jogos`, {
          method: 'POST',
          headers: dbHeaders,
          body: JSON.stringify({
            api_jogo_id: String(e.idEvent),
            grupo: e.strLeague || 'Liga',
            fase: 'grupo',
            time1: e.strHomeTeam,
            flag1: teamFlag(e.strHomeTeam),
            time2: e.strAwayTeam,
            flag2: teamFlag(e.strAwayTeam),
            data_hora: dataHora,
            status: 'aberto',
          })
        });
        imported++;
      }

      return res.status(200).json({
        ok: true,
        msg: `${imported} jogos importados de ${events.length} encontrados`,
        imported,
        sample: events.slice(0,3).map(e => `${e.strHomeTeam} x ${e.strAwayTeam} (${e.dateEvent})`)
      });
    }

    // ── TEMPORADA COMPLETA ──
    if (action === 'season') {
      const season = new Date().getFullYear();
      const r = await fetch(`${BASE}/eventsseason.php?id=${lid}&s=${season}`);
      const data = await r.json();
      const events = data.events || [];

      if (!events.length)
        return res.status(200).json({ ok: true, msg: 'Nenhum jogo encontrado na temporada', imported: 0 });

      let imported = 0;
      for (const e of events) {
        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id`,
          { headers: dbHeaders }
        );
        const existing = await check.json();
        if (existing?.[0]) continue;

        const dataHora = new Date(`${e.dateEvent}T${e.strTime || '12:00:00'}Z`).toISOString();
        const hasResult = e.intHomeScore !== null && e.intHomeScore !== '';
        const status = hasResult ? 'encerrado' : 'aberto';

        await fetch(`${SUPABASE_URL}/rest/v1/jogos`, {
          method: 'POST',
          headers: dbHeaders,
          body: JSON.stringify({
            api_jogo_id: String(e.idEvent),
            grupo: e.strRound ? `Rodada ${e.intRound}` : (e.strLeague || 'Liga'),
            fase: 'grupo',
            time1: e.strHomeTeam,
            flag1: teamFlag(e.strHomeTeam),
            time2: e.strAwayTeam,
            flag2: teamFlag(e.strAwayTeam),
            data_hora: dataHora,
            status,
            gol_time1: hasResult ? parseInt(e.intHomeScore) : null,
            gol_time2: hasResult ? parseInt(e.intAwayScore) : null,
          })
        });
        imported++;
      }

      return res.status(200).json({
        ok: true,
        msg: `${imported} jogos importados de ${events.length} na temporada`,
        imported
      });
    }

    // ── ATUALIZAR RESULTADOS RECENTES ──
    if (action === 'results') {
      const r = await fetch(`${BASE}/eventspastleague.php?id=${lid}`);
      const data = await r.json();
      const events = (data.events || []).slice(0, 20);

      let updated = 0, calculated = 0;
      for (const e of events) {
        if (!e.intHomeScore && e.intHomeScore !== 0) continue;
        const g1 = parseInt(e.intHomeScore);
        const g2 = parseInt(e.intAwayScore);

        const check = await fetch(
          `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=eq.${e.idEvent}&select=id,status`,
          { headers: dbHeaders }
        );
        const jogos = await check.json();
        const jogo = jogos?.[0];
        if (!jogo || jogo.status === 'encerrado') continue;

        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbHeaders,
          body: JSON.stringify({ gol_time1: g1, gol_time2: g2, status: 'encerrado' })
        });
        updated++;

        // Calcula pontos
        const palRes = await fetch(
          `${SUPABASE_URL}/rest/v1/palpites?jogo_id=eq.${jogo.id}&calculado=eq.false`,
          { headers: dbHeaders }
        );
        const palpites = await palRes.json() || [];
        const resReal = g1 > g2 ? 'H' : g1 < g2 ? 'A' : 'E';

        for (const p of palpites) {
          const resPal = p.palpite_time1 > p.palpite_time2 ? 'H' : p.palpite_time1 < p.palpite_time2 ? 'A' : 'E';
          let pts = 0;
          if (p.palpite_time1 === g1 && p.palpite_time2 === g2) pts = 3;
          else if (resPal === resReal) pts = 1;

          await fetch(`${SUPABASE_URL}/rest/v1/palpites?id=eq.${p.id}`, {
            method: 'PATCH', headers: dbHeaders,
            body: JSON.stringify({ pontos_ganhos: pts, calculado: true })
          });

          if (pts > 0) {
            const uRes = await fetch(
              `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}&select=pontos,palpites_exatos,palpites_certos`,
              { headers: dbHeaders }
            );
            const u = (await uRes.json())?.[0];
            if (u) {
              await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}`, {
                method: 'PATCH', headers: dbHeaders,
                body: JSON.stringify({
                  pontos: (u.pontos||0) + pts,
                  palpites_exatos: (u.palpites_exatos||0) + (pts===3?1:0),
                  palpites_certos: (u.palpites_certos||0) + (pts>=1?1:0)
                })
              });
            }
          }
          calculated++;
        }
      }

      return res.status(200).json({
        ok: true,
        msg: `${updated} jogos encerrados, ${calculated} palpites calculados`,
        updated, calculated
      });
    }

    return res.status(400).json({ error: 'Action inválida. Use: next, season ou results' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Tenta mapear nomes de times brasileiros/internacionais para bandeiras
function teamFlag(name) {
  if (!name) return '🏳️';
  const n = name.toLowerCase();
  const flags = {
    'brazil': '🇧🇷', 'brasil': '🇧🇷', 'argentina': '🇦🇷', 'france': '🇫🇷', 'franca': '🇫🇷',
    'germany': '🇩🇪', 'alemanha': '🇩🇪', 'spain': '🇪🇸', 'espanha': '🇪🇸',
    'england': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'portugal': '🇵🇹', 'netherlands': '🇳🇱', 'holanda': '🇳🇱',
    'italy': '🇮🇹', 'italia': '🇮🇹', 'belgium': '🇧🇪', 'belgica': '🇧🇪',
    'uruguay': '🇺🇾', 'colombia': '🇨🇴', 'chile': '🇨🇱', 'mexico': '🇲🇽',
    'usa': '🇺🇸', 'united states': '🇺🇸', 'canada': '🇨🇦', 'japan': '🇯🇵',
    'south korea': '🇰🇷', 'morocco': '🇲🇦', 'senegal': '🇸🇳', 'nigeria': '🇳🇬',
    'croatia': '🇭🇷', 'croacia': '🇭🇷', 'switzerland': '🇨🇭', 'suica': '🇨🇭',
    'flamengo': '🔴', 'palmeiras': '💚', 'corinthians': '⚫', 'sao paulo': '🔴',
    'santos': '⚪', 'gremio': '🔵', 'internacional': '🔴', 'atletico': '⚫',
    'cruzeiro': '🔵', 'vasco': '⚫', 'botafogo': '⚫', 'fluminense': '🟤',
    'arsenal': '🔴', 'chelsea': '🔵', 'liverpool': '🔴', 'manchester city': '🔵',
    'manchester united': '🔴', 'tottenham': '⚪', 'real madrid': '⚪',
    'barcelona': '🔵', 'atletico madrid': '🔴', 'juventus': '⚫',
    'inter milan': '🔵', 'ac milan': '🔴', 'bayern munich': '🔴', 'dortmund': '🟡',
    'psg': '🔵', 'paris saint-germain': '🔵', 'ajax': '🔴', 'porto': '🔵',
    'benfica': '🔴', 'celtic': '🟢', 'rangers': '🔵',
  };
  for (const [key, flag] of Object.entries(flags)) {
    if (n.includes(key)) return flag;
  }
  return '🏳️';
}
