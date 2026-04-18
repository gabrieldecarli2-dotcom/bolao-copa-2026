// api/get-config.js
// Retorna as credenciais do Supabase de forma segura
// - Com chave admin: acesso total (usado pelo admin.html)
// - Com __PUBLIC_SITE__: retorna apenas URL e anon key (usada pelo index.html)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ 
      error: 'SUPABASE_URL ou SUPABASE_ANON_KEY não configurados na Vercel' 
    });
  }

  // Acesso público do site principal — anon key é segura para expor
  if (secret === '__PUBLIC_SITE__') {
    return res.status(200).json({ ok: true, url: SUPABASE_URL, key: SUPABASE_KEY });
  }

  // Acesso admin — exige chave secreta
  if (!ADMIN_SECRET || !secret || secret.trim() !== ADMIN_SECRET.trim()) {
    return res.status(401).json({ ok: false, error: 'Não autorizado' });
  }

  return res.status(200).json({ ok: true, url: SUPABASE_URL, key: SUPABASE_KEY });
}
