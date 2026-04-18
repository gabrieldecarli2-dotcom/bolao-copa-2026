// api/get-config.js
// Retorna as credenciais do Supabase de forma segura
// As variáveis ficam nos servidores da Vercel, nunca no navegador

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  // Só entrega as credenciais se a chave admin estiver correta
  if (!secret || secret !== ADMIN_SECRET) {
    return setTimeout(() => {
      res.status(401).json({ error: 'Não autorizado' });
    }, 1000);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Variáveis SUPABASE_URL e SUPABASE_ANON_KEY não configuradas na Vercel' });
  }

  return res.status(200).json({ url: SUPABASE_URL, key: SUPABASE_KEY });
}
