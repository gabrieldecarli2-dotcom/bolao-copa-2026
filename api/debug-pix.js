// api/debug-pix.js — REMOVA após resolver o problema
module.exports = async function handler(req, res) {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  const info = {
    node_version: process.version,
    has_mp_token: !!MP_TOKEN,
    mp_token_prefix: MP_TOKEN ? MP_TOKEN.substring(0, 15) + '...' : 'NOT SET',
    has_supabase_url: !!SUPABASE_URL,
    has_supabase_key: !!SUPABASE_KEY,
    fetch_available: typeof fetch !== 'undefined',
  };

  // Testa conexão com MP
  if (MP_TOKEN) {
    try {
      const r = await fetch('https://api.mercadopago.com/v1/payment_methods', {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      info.mp_status = r.status;
      info.mp_ok = r.ok;
      if (!r.ok) {
        const t = await r.text();
        info.mp_error = t.substring(0, 300);
      }
    } catch(e) {
      info.mp_fetch_error = e.message;
    }
  }

  return res.status(200).json(info);
}
