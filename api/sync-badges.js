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

  const lid = league_id || '4351';
  const leagueNames = {
    '4351': 'Brazilian Serie A',
    '4328': 'English Premier League',
    '4335': 'Spanish La Liga',
    '4332': 'Serie A',
    '4331': 'Bundesliga',
    '4334': 'Ligue 1',
    '4480': 'UEFA Champions League',
  };
  const leagueName = leagueNames[lid] || 'Brazilian Serie A';

  // Normaliza string: remove acentos, lowercase, remove palavras comuns
  function normalize(str) {
    return str
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/\b(fc|sc|ac|cf|club|de|da|do|das|dos|sport|club|esporte)\b/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  try {
    const r = await fetch(`${BASE}/search_all_teams.php?l=${encodeURIComponent(leagueName)}`);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Resposta inválida: ' + text.substring(0,200) }); }

    const teams = data.teams || [];
    if (!teams.length)
      return res.status(200).json({ ok: false, msg: `Nenhum time encontrado para "${leagueName}"`, raw: text.substring(0,300) });

    // Monta mapa normalizado -> badge URL
    const badgeMap = {};
    for (const t of teams) {
      if (t.strTeamBadge) {
        const badge = t.strTeamBadge + '/small';
        badgeMap[normalize(t.strTeam)] = { badge, original: t.strTeam };
        if (t.strTeamShort) badgeMap[normalize(t.strTeamShort)] = { badge, original: t.strTeam };
        if (t.strTeamAlternate) badgeMap[normalize(t.strTeamAlternate)] = { badge, original: t.strTeam };
      }
    }

    // Busca jogos do banco
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,time1,time2,flag1,flag2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];

    let updated = 0;
    const matches = [], noMatch = [];

    for (const jogo of jogos) {
      const match1 = findBadge(jogo.time1, badgeMap);
      const match2 = findBadge(jogo.time2, badgeMap);

      if (match1) matches.push(`${jogo.time1} → ${match1.original}`);
      else noMatch.push(jogo.time1);
      if (match2) matches.push(`${jogo.time2} → ${match2.original}`);
      else noMatch.push(jogo.time2);

      if (!match1 && !match2) continue;

      const update = {};
      if (match1) update.flag1 = match1.badge;
      if (match2) update.flag2 = match2.badge;

      await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
        method: 'PATCH', headers: dbH,
        body: JSON.stringify(update)
      });
      updated++;
    }

    const uniqueNoMatch = [...new Set(noMatch)].slice(0, 10);
    const uniqueMatches = [...new Set(matches)].slice(0, 10);

    return res.status(200).json({
      ok: true,
      msg: `${updated} jogos atualizados`,
      updated,
      teams_found: teams.length,
      matches: uniqueMatches,
      no_match: uniqueNoMatch
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}

function findBadge(teamName, badgeMap) {
  if (!teamName) return null;

  function normalize(str) {
    return str.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(fc|sc|ac|cf|club|de|da|do|das|dos|sport|club|esporte)\b/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  const n = normalize(teamName);

  // Busca exata
  if (badgeMap[n]) return badgeMap[n];

  // Busca parcial — verifica se um contém o outro
  for (const [key, val] of Object.entries(badgeMap)) {
    if (n.includes(key) || key.includes(n)) return val;
    // Verifica palavras em comum
    const nWords = n.split(' ').filter(w => w.length > 3);
    const kWords = key.split(' ').filter(w => w.length > 3);
    if (nWords.some(w => kWords.includes(w))) return val;
  }

  return null;
}
