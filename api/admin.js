import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

    switch (action) {
      case 'get-users': return await getUsers(req, res);
      case 'update-user': return await updateUser(req, res); // Handles Tier & Freeze
      case 'adjust-balance': return await adjustBalance(req, res); // Handles Credit/Debit
      case 'get-settings': return await getSettings(req, res);
      case 'save-setting': return await saveSetting(req, res);
      case 'save-support-links': return await saveSupportLinks(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getUsers(req, res) {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, vip_level, is_frozen, created_at, wallets!left(balance)')
    .order('created_at', { ascending: false })
    .limit(1000);
  return res.json({ ok: true, users: data || [] });
}

// 1. Update User (Tier & Freeze)
async function updateUser(req, res) {
  const { user_id, vip_level, is_frozen } = req.body;
  
  const updates = {};
  if (vip_level !== undefined) updates.vip_level = vip_level;
  if (is_frozen !== undefined) updates.is_frozen = is_frozen;

  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', user_id);
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json({ ok: true, message: 'User updated successfully' });
}

// 2. Adjust Balance (Credit/Debit)
async function adjustBalance(req, res) {
  const { user_id, amount, type, reason } = req.body; // type: 'credit' or 'debit'
  const numAmount = Number(amount);
  
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  // Get current wallet
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user_id).single();
  if (!wallet) return res.status(400).json({ error: 'User wallet not found' });

  let newBalance = wallet.balance;
  if (type === 'credit') {
    newBalance += numAmount;
  } else if (type === 'debit') {
    if (wallet.balance < numAmount) return res.status(400).json({ error: 'Insufficient balance for debit' });
    newBalance -= numAmount;
  } else {
    return res.status(400).json({ error: 'Invalid type' });
  }

  // Update Wallet
  await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);

  // Record Transaction
  await supabaseAdmin.from('transactions').insert({
    user_id: user_id,
    type: type === 'credit' ? 'admin_credit' : 'admin_debit',
    amount: numAmount,
    status: 'approved',
    reference: `admin_adj_${Date.now()}`,
    description: `Admin ${type}: ${reason || 'Manual adjustment'}`
  });

  return res.json({ ok: true, new_balance: newBalance });
}

// 3. Settings & Support Links
async function getSettings(req, res) {
  const { data } = await supabaseAdmin.from('site_settings').select('key, value');
  const settings = {};
  (data || []).forEach(row => { settings[row.key] = row.value; });
  return res.json({ ok: true, settings });
}

async function saveSetting(req, res) {
  const { key, value } = req.body;
  await supabaseAdmin.from('site_settings').upsert({ key, value: String(value) });
  return res.json({ ok: true });
}

async function saveSupportLinks(req, res) {
  const { telegram, whatsapp, support } = req.body;
  if (telegram) await supabaseAdmin.from('site_settings').upsert({ key: 'telegram_link', value: telegram });
  if (whatsapp) await supabaseAdmin.from('site_settings').upsert({ key: 'whatsapp_link', value: whatsapp });
  if (support) await supabaseAdmin.from('site_settings').upsert({ key: 'support_link', value: support });
  return res.json({ ok: true });
}
