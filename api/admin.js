import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { initiateTransfer } from '../lib/targetgrowths.js';

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    // Check if user is admin
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

    switch (action) {
      case 'get-deposits': return await getDeposits(req, res);
      case 'get-withdrawals': return await getWithdrawals(req, res);
      case 'process-deposit': return await processDeposit(req, res);
      case 'process-withdrawal': return await processWithdrawal(req, res);
      case 'get-users': return await getUsers(req, res);
      case 'save-setting': return await saveSetting(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function getAppUrl(req) { return "https://rms888.vercel.app"; }

const TG_BANK_CODES = {
  'access bank': 'NGR044', 'gtbank': 'NGR058', 'zenith bank': 'NGR057', 'uba': 'NGR033',
  'first bank': 'NGR011', 'fidelity bank': 'NGR070', 'union bank': 'NGR032', 'sterling bank': 'NGR232',
  'wema bank': 'NGR035', 'stanbic ibtc': 'NGR221', 'ecobank': 'NGR050', 'polaris bank': 'NGR076',
  'opay': 'NGR20009', 'palmpay': 'NGR999991', 'kuda': 'NGR50211', 'moniepoint': 'NGR50515', 'vfd': 'NGR566'
};

async function getWithdrawals(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('withdrawals').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ ok: true, withdrawals: data || [] });
}

async function processWithdrawal(req, res) {
  const { withdrawal_id, act, note } = req.body;
  const { data: w } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    // Refund the user
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', w.user_id).single();
    await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) + Number(w.amount) }).eq('user_id', w.user_id);
    await supabaseAdmin.from('withdrawals').update({ status: 'rejected', note, processed_at: new Date().toISOString() }).eq('id', w.id);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    const bankId = TG_BANK_CODES[w.bank_name?.toLowerCase()] || w.bank_id;
    if (!bankId) return res.status(400).json({ error: 'Invalid bank code for Target Growth' });

    const identifier = `TGW${String(w.id).replace(/-/g, '').slice(0, 12)}${Date.now().toString(36).toUpperCase()}`;
    
    // Update status to processing
    await supabaseAdmin.from('withdrawals').update({ 
      status: 'approved', provider_identifier: identifier, provider_status: 'initiating' 
    }).eq('id', w.id);

    try {
      const origin = getAppUrl(req);
      const provider = await initiateTransfer({
        identifier, amount: w.net_amount || w.amount, bankId,
        recipient: w.account_number, accountName: w.account_name,
        ipnUrl: `${origin}/api/webhooks/targetgrowths`,
        customerEmail: 'admin@rms.com'
      });

      await supabaseAdmin.from('withdrawals').update({
        provider_reference: provider?.transaction_ref, provider_status: 'provider_pending', provider_response: provider
      }).eq('id', w.id);

      return res.json({ ok: true, action: 'approved', status: 'provider_pending' });
    } catch (e) {
      // Revert if API fails
      await supabaseAdmin.from('withdrawals').update({ status: 'pending', provider_status: 'failed' }).eq('id', w.id);
      return res.status(502).json({ error: e.message });
    }
  }
}

async function getUsers(req, res) {
  // Use !left to include users even if they don't have a wallet row yet
  const { data } = await supabaseAdmin.from('profiles').select('id, email, full_name, vip_level, created_at, wallets!left(balance)').order('created_at', { ascending: false }).limit(1000);
  return res.json({ ok: true, users: data || [] });
}

async function saveSetting(req, res) {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  await supabaseAdmin.from('site_settings').upsert({ key, value: String(value) });
  return res.json({ ok: true });
}

async function getDeposits(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('deposits').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ ok: true, deposits: data || [] });
}

async function processDeposit(req, res) {
  const { deposit_id, act } = req.body;
  const { data: d } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!d) return res.status(404).json({ error: 'Deposit not found' });
  
  if (act === 'reject') {
    await supabaseAdmin.from('deposits').update({ status: 'rejected' }).eq('id', d.id);
    return res.json({ ok: true, action: 'rejected' });
  }
  
  if (act === 'approve') {
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', d.user_id).single();
    const newBal = Number(wallet?.balance || 0) + Number(d.amount);
    await supabaseAdmin.from('wallets').upsert({ user_id: d.user_id, balance: newBal });
    await supabaseAdmin.from('deposits').update({ status: 'completed', paid_at: new Date().toISOString() }).eq('id', d.id);
    return res.json({ ok: true, action: 'approved' });
  }
}
