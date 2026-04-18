// api/sync-jogos.js
// Busca jogos e placares da Copa do Mundo na API-Football
// e atualiza o Supabase automaticamente
// Pode ser chamado pelo admin ou por um cron job

import { createClient } from '@supabase/supabase-js';

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ID da Copa do Mundo 2026 na API-Football
// 2026 FIFA World Cup = league id 1 (confirmar quando abrir temporada)
const WORLD_CUP_LEAGUE = 1;
const WORLD_CUP_SEASON = 2026;

export default async function handler(req, res) {
  // Aceita GET (cron) ou POST (chamada manual do admin)
  if (req.method === 'POST') {
    const { secret } = req.body || {};
    if (!secret || secret.trim() !== ADMIN_SECRET?.trim()) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
  }

  if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // Busca jogos ao vivo primeiro
    const liveRes = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': API_KEY }
    });
    const liveData = await liveRes.json();
    const liveFixtures = liveData.response || [];

    // Filtra só Copa do Mundo
    const liveWC = liveFixtures.filter(f => f.league.id === WORLD_CUP_LEAGUE);

    let updated = 0;
    let calculated = 0;

    // Atualiza placares ao vivo
    for (const fixture of liveWC) {
      const { data: jogo } = await db
        .from('jogos')
        .select('id, status')
        .eq('api_jogo_id', String(fixture.fixture.id))
        .single();

      if (jogo) {
        await db.from('jogos').update({
          gol_time1: fixture.goals.home,
          gol_time2: fixture.goals.away,
          status: 'ao_vivo'
        }).eq('id', jogo.id);
        updated++;
      }
    }

    // Busca jogos de hoje e ontem para pegar resultados finais
    const hoje = new Date().toISOString().split('T')[0];
    const ontem = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    for (const date of [hoje, ontem]) {
      const dayRes = await fetch(
        `https://v3.football.api-sports.io/fixtures?league=${WORLD_CUP_LEAGUE}&season=${WORLD_CUP_SEASON}&date=${date}`,
        { headers: { 'x-apisports-key': API_KEY } }
      );
      const dayData = await dayRes.json();
      const fixtures = dayData.response || [];

      for (const fixture of fixtures) {
        const statusApi = fixture.fixture.status.short;
        const isFinished = ['FT', 'AET', 'PEN'].includes(statusApi);
        const isLive = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT'].includes(statusApi);
        const isScheduled = ['NS', 'TBD'].includes(statusApi);

        let novoStatus = isFinished ? 'encerrado' : isLive ? 'ao_vivo' : isScheduled ? 'aberto' : 'aberto';

        // Verifica se já existe no banco pelo api_jogo_id
        const { data: jogoExistente } = await db
          .from('jogos')
          .select('id, status')
          .eq('api_jogo_id', String(fixture.fixture.id))
          .single();

        if (jogoExistente) {
          // Só atualiza se o status mudou ou tem placar novo
          if (jogoExistente.status !== 'encerrado') {
            const updateData = {
              gol_time1: fixture.goals.home ?? jogoExistente.gol_time1,
              gol_time2: fixture.goals.away ?? jogoExistente.gol_time2,
              status: novoStatus
            };
            await db.from('jogos').update(updateData).eq('id', jogoExistente.id);
            updated++;

            // Se acabou de encerrar, calcula pontos
            if (novoStatus === 'encerrado' && fixture.goals.home !== null && fixture.goals.away !== null) {
              await calcularPontos(db, jogoExistente.id, fixture.goals.home, fixture.goals.away);
              calculated++;
            }
          }
        } else {
          // Jogo novo — insere no banco
          const homeTeam = fixture.teams.home;
          const awayTeam = fixture.teams.away;

          await db.from('jogos').insert({
            api_jogo_id: String(fixture.fixture.id),
            grupo: fixture.league.round || 'Grupo',
            time1: homeTeam.name,
            flag1: getFlagEmoji(fixture.teams.home.id),
            time2: awayTeam.name,
            flag2: getFlagEmoji(fixture.teams.away.id),
            data_hora: new Date(fixture.fixture.date).toISOString(),
            status: novoStatus,
            gol_time1: fixture.goals.home,
            gol_time2: fixture.goals.away
          });
          updated++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      message: `✅ Sincronizado: ${updated} jogos atualizados, ${calculated} com pontos calculados`,
      liveGames: liveWC.length,
      updated,
      calculated
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Calcula pontos de todos os palpites de um jogo encerrado
async function calcularPontos(db, jogoId, gol1, gol2) {
  const { data: palpites } = await db
    .from('palpites')
    .select('*')
    .eq('jogo_id', jogoId)
    .eq('calculado', false);

  if (!palpites?.length) return;

  const resReal = gol1 > gol2 ? 'H' : gol1 < gol2 ? 'A' : 'E';

  for (const p of palpites) {
    const resPalpite = p.palpite_time1 > p.palpite_time2 ? 'H'
      : p.palpite_time1 < p.palpite_time2 ? 'A' : 'E';

    let pts = 0;
    if (p.palpite_time1 === gol1 && p.palpite_time2 === gol2) pts = 3;
    else if (resPalpite === resReal) pts = 1;

    await db.from('palpites').update({ pontos_ganhos: pts, calculado: true }).eq('id', p.id);

    if (pts > 0) {
      const { data: usr } = await db.from('usuarios')
        .select('pontos,palpites_exatos,palpites_certos')
        .eq('id', p.usuario_id).single();
      if (usr) {
        await db.from('usuarios').update({
          pontos: (usr.pontos || 0) + pts,
          palpites_exatos: (usr.palpites_exatos || 0) + (pts === 3 ? 1 : 0),
          palpites_certos: (usr.palpites_certos || 0) + (pts >= 1 ? 1 : 0)
        }).eq('id', p.usuario_id);
      }
    }
  }
}

// Mapa de IDs de seleções → emojis de bandeira
function getFlagEmoji(teamId) {
  const flags = {
    // Top seleções Copa 2026
    6: '🇧🇷',    // Brazil
    7: '🇫🇷',    // France
    8: '🇩🇪',    // Germany
    9: '🇪🇸',    // Spain
    10: '🇮🇹',   // Italy
    13: '🇦🇷',   // Argentina
    15: '🇵🇹',   // Portugal
    17: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', // England
    21: '🇺🇸',   // USA
    22: '🇲🇽',   // Mexico
    24: '🇨🇦',   // Canada
    25: '🇯🇵',   // Japan
    26: '🇰🇷',   // South Korea
    27: '🇨🇷',   // Costa Rica
    29: '🇳🇱',   // Netherlands
    31: '🇨🇱',   // Chile
    36: '🇺🇾',   // Uruguay
    46: '🇸🇦',   // Saudi Arabia
    56: '🇭🇷',   // Croatia
    65: '🇧🇪',   // Belgium
    71: '🇵🇪',   // Peru
    88: '🇵🇱',   // Poland
    94: '🇨🇴',   // Colombia
    95: '🇪🇨',   // Ecuador
    101: '🇸🇳',  // Senegal
    102: '🇩🇰',  // Denmark
    119: '🇦🇺',  // Australia
    157: '🇨🇭',  // Switzerland
    164: '🇲🇦',  // Morocco
    168: '🇳🇬',  // Nigeria
    174: '🇮🇷',  // Iran
    504: '🇷🇸',  // Serbia
  };
  return flags[teamId] || '🏳️';
}
