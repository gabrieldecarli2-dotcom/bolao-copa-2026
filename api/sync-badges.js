// api/sync-badges.js
// Os eventos já contêm strHomeTeamBadge e strAwayTeamBadge — usa direto!
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
    // Busca todos os jogos com api_jogo_id
    const jogosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/jogos?api_jogo_id=not.is.null&select=id,api_jogo_id,time1,time2`,
      { headers: dbH }
    );
    const jogos = await jogosRes.json() || [];
    if (!jogos.length)
      return res.status(200).json({ ok: false, msg: 'Nenhum jogo com api_jogo_id no banco' });

    // Busca eventos em lotes de 10 (rate limit 30 req/min)
    let updated = 0;
    const batches = [];
    for (let i = 0; i < jogos.length; i += 10) batches.push(jogos.slice(i, i + 10));

    for (const batch of batches) {
      await Promise.all(batch.map(async (jogo) => {
        try {
          const r = await fetch(`${BASE}/lookupevent.php?id=${jogo.api_jogo_id}`);
          const d = await r.json();
          const e = d.events?.[0];
          if (!e) return;

          const b1 = e.strHomeTeamBadge ? e.strHomeTeamBadge + '/small' : null;
          const b2 = e.strAwayTeamBadge ? e.strAwayTeamBadge + '/small' : null;
          if (!b1 && !b2) return;

          await fetch(`${SUPABASE_URL}/rest/v1/jogos?id=eq.${jogo.id}`, {
            method: 'PATCH', headers: dbH,
            body: JSON.stringify({ ...(b1 && { flag1: b1 }), ...(b2 && { flag2: b2 }) })
          });
          updated++;
        } catch(e) {}
      }));

      // Pausa entre lotes para respeitar rate limit
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return res.status(200).json({
      ok: true,
      msg: `${updated} jogos atualizados com escudos`,
      updated,
      total: jogos.length
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
