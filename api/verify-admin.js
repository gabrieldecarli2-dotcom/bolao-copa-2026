// api/verify-admin.js
// Este arquivo roda no SERVIDOR da Vercel — nunca fica exposto ao usuário
// A variável ADMIN_SECRET só existe nos servidores da Vercel

export default function handler(req, res) {
  // Só aceita POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret } = req.body;

  // Busca a chave secreta das variáveis de ambiente da Vercel
  const ADMIN_SECRET = process.env.ADMIN_SECRET;

  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: 'Variável ADMIN_SECRET não configurada na Vercel' });
  }

  if (!secret || secret !== ADMIN_SECRET) {
    // Aguarda 1 segundo antes de responder para dificultar tentativas em força bruta
    return setTimeout(() => {
      res.status(401).json({ ok: false, error: 'Chave secreta incorreta' });
    }, 1000);
  }

  return res.status(200).json({ ok: true });
}
