// api/get-config.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SECRET não configurado na Vercel' });
  }

  if (!secret || secret.trim() !== ADMIN_SECRET.trim()) {
    return res.status(401).json({ ok: false, error: 'Chave secreta incorreta' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL ou SUPABASE_ANON_KEY não configurados na Vercel' });
  }

  return res.status(200).json({ ok: true, url: SUPABASE_URL, key: SUPABASE_KEY });
}
