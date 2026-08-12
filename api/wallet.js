/**
 * Wallet API
 * Actions: balance, statement (generate PDF/CSV placeholder)
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'balance': return getBalance(req, res);
      case 'statement': return getStatement(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getBalance(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  return res.status(200).json(data);
}

async function getStatement(req, res) {
  const user = await verifyUser(req);
  // In future, generate PDF statement; for now return transactions
  const { data } = await supabaseAdmin.from('transactions')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(100);
  return res.status(200).json(data);
}
