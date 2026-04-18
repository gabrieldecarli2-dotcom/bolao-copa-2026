// api/verify-admin.js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { secret } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) return res.status(500).json({ error: 'ADMIN_SECRET não configurado' });
  if (!secret || secret.trim() !== ADMIN_SECRET.trim())
    return res.status(401).json({ ok: false, error: 'Chave secreta incorreta' });
  return res.status(200).json({ ok: true });
}
