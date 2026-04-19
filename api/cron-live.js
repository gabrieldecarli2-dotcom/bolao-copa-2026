// api/cron-live.js — atualiza placares ao vivo + detecta jogos encerrados
// CORRIGIDO: match inteligente de times (resolve diferença de nomes pt-BR vs inglês)

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

  const results = { live_found: 0, matched: 0, updated: 0, finished: 0, not_matched: [] };

  try {
    // 1. Busca livescores v2
    const liveRes = await fetch('https://www.thesportsdb.com/api/v2/json/livescore/soccer', {
      headers: { 'X-API-KEY': SPORTS_KEY }
    });
    const liveData = await liveRes.json();
    const liveEvents = liveData.livescore || liveData.events || [];
    results.live_found = liveEvents.length;

    if (!liveEvents.length) {
      return res.status(200).json({ ok: true, msg: 'Nenhum jogo ao vivo agora', ...results });
    }

    // 2. Busca TODOS os jogos abertos/ao_vivo do banco de uma vez
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?status=in.(aberto,ao_vivo)&select=id,time1,time2,api_jogo_id,status,gol_time1,gol_time2`,
      { headers: dbH }
    );
    const jogosBanco = await dbRes.json() || [];

    if (!jogosBanco.length) {
      return res.status(200).json({ ok: true, msg: 'Nenhum jogo aberto/ao_vivo no banco', ...results });
    }

    // 3. Para cada jogo ao vivo na API, tenta dar match com o banco
    for (const e of liveEvents) {
      const g1 = parseInt(e.intHomeScore ?? -1);
      const g2 = parseInt(e.intAwayScore ?? -1);
      if (g1 < 0 || g2 < 0) continue;

      const apiId = String(e.idEvent);
      const jogoBanco = encontrarJogo(jogosBanco, e, apiId);

      if (!jogoBanco) {
        if (results.not_matched.length < 8) {
          results.not_matched.push(`${e.strHomeTeam} x ${e.strAwayTeam}`);
        }
        continue;
      }

      results.matched++;

      // Só faz PATCH se mudou algo
      if (
        jogoBanco.gol_time1 === g1 &&
        jogoBanco.gol_time2 === g2 &&
        jogoBanco.status === 'ao_vivo' &&
        jogoBanco.api_jogo_id === apiId
      ) continue;

      const patch = { gol_time1: g1, gol_time2: g2, status: 'ao_vivo' };
      if (!jogoBanco.api_jogo_id) patch.api_jogo_id = apiId;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogoBanco.id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify(patch)
      });
      results.updated++;
    }

    // 4. Detecta jogos ao_vivo que sumiram da API (terminaram)
    const idsAoVivoAPI = new Set(liveEvents.map(e => String(e.idEvent)));

    const aoVivoRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?status=eq.ao_vivo&select=id,api_jogo_id,gol_time1,gol_time2`,
      { headers: dbH }
    );
    const jogosAoVivo = await aoVivoRes.json() || [];

    for (const jogo of jogosAoVivo) {
      if (jogo.api_jogo_id && !idsAoVivoAPI.has(jogo.api_jogo_id)) {
        await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
          method: 'PATCH', headers: dbH,
          body: JSON.stringify({ status: 'encerrado' })
        });
        results.finished++;

        if (jogo.gol_time1 !== null && jogo.gol_time2 !== null) {
          await calcularPontos(jogo.id, jogo.gol_time1, jogo.gol_time2, SUPABASE_URL, dbH);
        }
      }
    }

    return res.status(200).json({ ok: true, ...results });

  } catch (err) {
    console.error('[cron-live] erro:', err.message);
    return res.status(500).json({ error: err.message, ...results });
  }
};

// ─── Match inteligente entre evento da API e jogo do banco ────────────────
function encontrarJogo(jogosBanco, eventoAPI, apiId) {
  const homeAPI = normalizar(eventoAPI.strHomeTeam);
  const awayAPI = normalizar(eventoAPI.strAwayTeam);

  // 1. api_jogo_id exato (melhor caso — após primeiro match manual)
  const porId = jogosBanco.find(j => j.api_jogo_id === apiId);
  if (porId) return porId;

  // 2. Nome normalizado exato
  const porNome = jogosBanco.find(j =>
    normalizar(j.time1) === homeAPI && normalizar(j.time2) === awayAPI
  );
  if (porNome) return porNome;

  // 3. Match por tokens — resolve "Atletico Mineiro" vs "Atlético-MG"
  const homeTokens = tokens(homeAPI);
  const awayTokens = tokens(awayAPI);

  const porToken = jogosBanco.find(j => {
    const t1 = tokens(normalizar(j.time1));
    const t2 = tokens(normalizar(j.time2));
    return (
      homeTokens.some(t => t1.some(x => x.startsWith(t) || t.startsWith(x))) &&
      awayTokens.some(t => t2.some(x => x.startsWith(t) || t.startsWith(x)))
    );
  });
  if (porToken) return porToken;

  // 4. Match reverso (API às vezes inverte home/away)
  const porTokenRev = jogosBanco.find(j => {
    const t1 = tokens(normalizar(j.time1));
    const t2 = tokens(normalizar(j.time2));
    return (
      awayTokens.some(t => t1.some(x => x.startsWith(t) || t.startsWith(x))) &&
      homeTokens.some(t => t2.some(x => x.startsWith(t) || t.startsWith(x)))
    );
  });
  return porTokenRev || null;
}

function normalizar(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tira acentos
    .replace(/[^a-z0-9 ]/g, ' ')     // tira especiais e hífens
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the','de','do','da','fc','sc','ac','cf','rc','se','ec','cr','sr',
  'esporte','clube','sport','club','united','city','real','atletico','atletica'
]);

function tokens(str) {
  return str.split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// ─── Calcula pontos dos palpites ──────────────────────────────────────────
async function calcularPontos(jogoId, g1, g2, SUPABASE_URL, dbH) {
  try {
    const palRes = await fetch(
      `${SUPABASE_URL}/rest/v1/palpites?jogo_id=eq.${jogoId}&calculado=eq.false&select=id,usuario_id,palpite_time1,palpite_time2`,
      { headers: dbH }
    );
    const palpites = await palRes.json() || [];
    if (!palpites.length) return;

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
        const uRes = await fetch(
          `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}&select=pontos,palpites_exatos,palpites_certos`,
          { headers: dbH }
        );
        const u = (await uRes.json())?.[0];
        if (u) {
          await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${p.usuario_id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({
              pontos: (u.pontos || 0) + pts,
              palpites_exatos: (u.palpites_exatos || 0) + (pts === 3 ? 1 : 0),
              palpites_certos: (u.palpites_certos || 0) + (pts >= 1 ? 1 : 0)
            })
          });
        }
      }
    }
  } catch (e) {
    console.error('[calcularPontos] erro:', e.message);
  }
}
