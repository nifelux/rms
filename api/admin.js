import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { initiateTransfer } from '../lib/targetgrowths.js';

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

    switch (action) {
      case 'get-deposits': return await getDeposits(req, res);
      case 'get-withdrawals': return await getWithdrawals(req, res);
      case 'process-withdrawal': return await processWithdrawal(req, res);
      case 'get-users': return await getUsers(req, res);
      case 'update-user': return await updateUser(req, res);
      case 'adjust-balance': return await adjustBalance(req, res);
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

// ==========================================
// DEPOSITS (Read-only - Auto-approved via webhook)
// ==========================================
async function getDeposits(req, res) {
  const status = req.query.status || 'all';
  let q = supabaseAdmin
    .from('deposits')
    .select('*, profiles!user_id(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(100);
  
  if (status !== 'all') q = q.eq('status', status);
  
  const { data } = await q;
  return res.json({ ok: true, deposits: data || [] });
}

// ==========================================
// WITHDRAWALS (Requires admin approval)
// ==========================================
async function getWithdrawals(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin
    .from('withdrawals')
    .select('*, profiles!user_id(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(100);
  
  if (status !== 'all') q = q.eq('status', status);
  
  const { data } = await q;
  return res.json({ ok: true, withdrawals: data || [] });
}

const TG_BANK_CODES = {
  'access bank': 'NGR044', 'access': 'NGR044',
  'gtbank': 'NGR058', 'guaranty trust bank': 'NGR058',
  'zenith bank': 'NGR057', 'zenith': 'NGR057',
  'uba': 'NGR033', 'united bank for africa': 'NGR033',
  'first bank': 'NGR011',
  'fidelity bank': 'NGR070',
  'union bank': 'NGR032',
  'sterling bank': 'NGR232',
  'wema bank': 'NGR035',
  'stanbic ibtc': 'NGR221',
  'ecobank': 'NGR050',
  'polaris bank': 'NGR076',
  'opay': 'NGR20009', 'paycom': 'NGR999992',
  'palmpay': 'NGR999991',
  'kuda': 'NGR50211',
  'moniepoint': 'NGR50515',
  'vfd': 'NGR566'
};

async function processWithdrawal(req, res) {
  const { withdrawal_id, act, note } = req.body;
  
  const { data: w } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawal_id)
    .single();
    
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    // Refund the user
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', w.user_id)
      .single();
      
    await supabaseAdmin
      .from('wallets')
      .update({ balance: Number(wallet.balance) + Number(w.amount) })
      .eq('user_id', w.user_id);
      
    await supabaseAdmin
      .from('withdrawals')
      .update({ status: 'rejected', note, processed_at: new Date().toISOString() })
      .eq('id', w.id);
      
    // Update transaction status
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'rejected' })
      .eq('reference', `wd_${w.id}`);
      
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    const bankId = TG_BANK_CODES[w.bank_name?.toLowerCase()] || w.bank_id;
    if (!bankId) return res.status(400).json({ error: 'Invalid bank code for Target Growth' });

    const identifier = `TGW${String(w.id).replace(/-/g, '').slice(0, 12)}${Date.now().toString(36).toUpperCase()}`;
    
    // Update status to processing
    await supabaseAdmin
      .from('withdrawals')
      .update({ 
        status: 'approved', 
        provider_identifier: identifier, 
        provider_status: 'initiating' 
      })
      .eq('id', w.id);

    try {
      const provider = await initiateTransfer({
        identifier,
        amount: w.net_amount || w.amount,
        bankId,
        recipient: w.account_number,
        accountName: w.account_name,
        ipnUrl: `https://rms888.vercel.app/api/webhooks/targetgrowths`,
        customerEmail: 'admin@rms.com'
      });

      await supabaseAdmin
        .from('withdrawals')
        .update({
          provider_reference: provider?.transaction_ref,
          provider_status: 'provider_pending',
          provider_response: provider
        })
        .eq('id', w.id);

      // Update transaction
      await supabaseAdmin
        .from('transactions')
        .update({ status: 'approved' })
        .eq('reference', `wd_${w.id}`);

      return res.json({ ok: true, action: 'approved', status: 'provider_pending' });
    } catch (e) {
      await supabaseAdmin
        .from('withdrawals')
        .update({ status: 'pending', provider_status: 'failed' })
        .eq('id', w.id);
      return res.status(502).json({ error: e.message });
    }
  }
}

// ==========================================
// USERS
// ==========================================
async function getUsers(req, res) {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, vip_level, is_frozen, created_at, wallets!left(balance)')
    .order('created_at', { ascending: false })
    .limit(1000);
  return res.json({ ok: true, users: data || [] });
}

async function updateUser(req, res) {
  const { user_id, vip_level, is_frozen } = req.body;
  const updates = {};
  if (vip_level !== undefined) updates.vip_level = vip_level;
  if (is_frozen !== undefined) updates.is_frozen = is_frozen;

  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', user_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, message: 'User updated successfully' });
}

async function adjustBalance(req, res) {
  const { user_id, amount, type, reason } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

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

  await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);

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

// ==========================================
// SETTINGS
// ==========================================
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
