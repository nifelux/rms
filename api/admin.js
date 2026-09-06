import supabaseAdmin from '../lib/supabase.js';
import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  // Allow CORS for local development if needed
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getDashboardStats': return await getDashboardStats(req, res);
      case 'getPendingDeposits': return await getPendingDeposits(req, res);
      case 'processDeposit': return await processDeposit(req, res);
      case 'getPendingWithdrawals': return await getPendingWithdrawals(req, res);
      case 'processWithdrawal': return await processWithdrawal(req, res);
      case 'getUsers': return await getUsers(req, res);
      case 'updateUserStatus': return await updateUserStatus(req, res);
      case 'manualWalletAdjustment': return await manualWalletAdjustment(req, res);
      case 'getSupportTickets': return await getSupportTickets(req, res);
      case 'replyToTicket': return await replyToTicket(req, res);
      case 'getWealthPlans': return await getWealthPlans(req, res);
      case 'createWealthPlan': return await createWealthPlan(req, res);
      case 'upgradeTier': return await upgradeTier(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action', received: action });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ==========================================
// 1. DASHBOARD STATS
// ==========================================
async function getDashboardStats(req, res) {
  await verifyAdmin(req);
  
  const [usersResult, depositsResult, withdrawalsResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('transactions').select('amount').eq('type', 'deposit').eq('status', 'approved'),
    supabaseAdmin.from('transactions').select('amount').eq('type', 'withdraw').eq('status', 'approved')
  ]);

  const totalDep = (depositsResult.data || []).reduce((sum, d) => sum + Number(d.amount), 0);
  const totalWith = (withdrawalsResult.data || []).reduce((sum, w) => sum + Number(w.amount), 0);
  const totalSystemBalance = totalDep - totalWith;

  const [pendingDeps, pendingWds] = await Promise.all([
    supabaseAdmin.from('deposits').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  ]);

  return res.status(200).json({
    totalUsers: usersResult.count || 0,
    totalSystemBalance,
    pendingDeposits: pendingDeps.count || 0,
    pendingWithdrawals: pendingWds.count || 0
  });
}

// ==========================================
// 2. DEPOSITS
// ==========================================
async function getPendingDeposits(req, res) {
  await verifyAdmin(req);
  
  const { data, error } = await supabaseAdmin
    .from('deposits')
    .select('*, profiles(full_name, email)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return res.status(200).json({ deposits: data || [] });
}

async function processDeposit(req, res) {
  await verifyAdmin(req);
  
  const { deposit_id, status } = req.body;
  
  if (status !== 'approved') {
    // Just reject it
    await supabaseAdmin.from('deposits').update({ 
      status: 'rejected',
      updated_at: new Date() 
    }).eq('id', deposit_id);
    
    return res.status(200).json({ message: 'Deposit rejected' });
  }
  
  // Call the database function
  const { data, error } = await supabaseAdmin.rpc('admin_approve_deposit', {
    deposit_id: deposit_id
  });
  
  if (error) {
    console.error('RPC Error:', error);
    return res.status(500).json({ error: error.message });
  }
  
  if (!data.success) {
    return res.status(400).json({ error: data.error });
  }
  
  return res.status(200).json({ message: 'Deposit approved successfully' });
} 

// ==========================================
// 3. WITHDRAWALS
// ==========================================
async function getPendingWithdrawals(req, res) {
  await verifyAdmin(req);
  
  const { data, error } = await supabaseAdmin
    .from('withdrawals')
    .select('*, profiles(full_name, email), bank_details')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return res.status(200).json({ withdrawals: data || [] });
}

async function processWithdrawal(req, res) {
  await verifyAdmin(req);
  
  const { withdrawal_id, status } = req.body;
  
  const { data: withdrawal } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawal_id)
    .single();

  if (!withdrawal) {
    return res.status(404).json({ error: 'Withdrawal not found' });
  }

  await supabaseAdmin.from('withdrawals').update({ status, updated_at: new Date() }).eq('id', withdrawal_id);

  if (status === 'approved') {
    // Update the pending withdrawal transaction to approved
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'approved' })
      .eq('reference', `wd_${withdrawal_id}`);
  }

  return res.status(200).json({ message: `Withdrawal ${status} successfully` });
}

// ==========================================
// 4. USER MANAGEMENT
// ==========================================
async function getUsers(req, res) {
  await verifyAdmin(req);
  
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, vip_level, created_at, referred_by')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;
  return res.status(200).json({ users: data || [] });
}

async function updateUserStatus(req, res) {
  await verifyAdmin(req);
  
  const { user_id, is_banned, is_frozen, ban_reason } = req.body;
  
  await supabaseAdmin.from('profiles').update({
    is_banned: is_banned || false,
    is_frozen: is_frozen || false,
    ban_reason: ban_reason || null,
    updated_at: new Date()
  }).eq('id', user_id);

  return res.status(200).json({ message: 'User status updated successfully' });
}

// ==========================================
// 5. WALLET ADJUSTMENTS
// ==========================================
async function manualWalletAdjustment(req, res) {
  await verifyAdmin(req);
  
  const { user_id, amount, type, description } = req.body;
  const adjAmount = Number(amount);
  
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', user_id)
    .single();

  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found for this user' });
  }

  const newBalance = type === 'credit' 
    ? Number(wallet.balance) + adjAmount
    : Number(wallet.balance) - adjAmount;

  await supabaseAdmin.from('wallets').update({
    balance: newBalance,
    updated_at: new Date()
  }).eq('user_id', user_id);

  await supabaseAdmin.from('transactions').insert({
    user_id,
    type: type === 'credit' ? 'admin_credit' : 'admin_debit',
    amount: adjAmount,
    status: 'approved',
    reference: `admin_adj_${Date.now()}`,
    description: description || `Manual ${type} by admin`
  });

  return res.status(200).json({ message: 'Wallet adjusted successfully', newBalance });
}

// ==========================================
// 6. SUPPORT TICKETS
// ==========================================
async function getSupportTickets(req, res) {
  await verifyAdmin(req);
  
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  return res.status(200).json({ tickets: data || [] });
}

async function replyToTicket(req, res) {
  await verifyAdmin(req);
  
  const { ticket_id, message } = req.body;
  
  await supabaseAdmin.from('ticket_replies').insert({
    ticket_id,
    user_id: null, // null indicates admin reply
    is_admin_reply: true,
    message,
    created_at: new Date()
  });

  await supabaseAdmin.from('support_tickets').update({
    status: 'answered',
    updated_at: new Date()
  }).eq('id', ticket_id);

  return res.status(200).json({ message: 'Reply sent successfully' });
}

// ==========================================
// 7. WEALTH PLANS
// ==========================================
async function getWealthPlans(req, res) {
  await verifyAdmin(req);
  
  const { data, error } = await supabaseAdmin
    .from('wealth_plans')
    .select('*')
    .order('invest_amount', { ascending: true });

  if (error) throw error;
  return res.status(200).json({ plans: data || [] });
}

async function createWealthPlan(req, res) {
  await verifyAdmin(req);
  
  const { name, description, invest_amount, return_amount, duration_days, is_active } = req.body;
  
  const { data, error } = await supabaseAdmin
    .from('wealth_plans')
    .insert({
      name,
      description,
      invest_amount: Number(invest_amount),
      return_amount: Number(return_amount),
      duration_days: Number(duration_days),
      is_active: is_active !== undefined ? is_active : true,
      created_at: new Date()
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ message: 'Plan created successfully', plan: data });
}

// ==========================================
// 8. VIP TIER UPGRADES (User-facing via API)
// ==========================================
async function upgradeTier(req, res) {
  try {
    // Verify user via Bearer token (not admin check, as users call this)
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization header' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { target_tier } = req.body;
    if (!target_tier) return res.status(400).json({ error: 'Target tier is required' });

    // Get current user profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level')
      .eq('id', user.id)
      .single();

    // Get tier info
    const { data: tierInfo } = await supabaseAdmin
      .from('rms_tiers')
      .select('*')
      .eq('tier', target_tier)
      .single();

    if (!tierInfo) return res.status(404).json({ error: 'Tier not found' });
    if (profile.vip_level === target_tier) return res.status(400).json({ error: 'You are already on this tier' });

    // Get wallet
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    const upgradeCost = Number(tierInfo.upgrade_cost);
    if (!wallet || Number(wallet.balance) < upgradeCost) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct cost from wallet
    const newBalance = Number(wallet.balance) - upgradeCost;
    await supabaseAdmin.from('wallets').update({
      balance: newBalance,
      updated_at: new Date()
    }).eq('user_id', user.id);

    // Update user tier
    await supabaseAdmin.from('profiles').update({
      vip_level: target_tier,
      updated_at: new Date()
    }).eq('id', user.id);

    // Record transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'vip_upgrade',
      amount: upgradeCost,
      status: 'approved',
      reference: `tier_upgrade_${target_tier}_${Date.now()}`,
      description: `Upgraded to ${target_tier}`
    });

    return res.status(200).json({ 
      message: `Successfully upgraded to ${target_tier}`,
      newBalance,
      tier: target_tier
    });
    
  } catch (err) {
    console.error('Upgrade tier error:', err);
    return res.status(500).json({ error: err.message });
  }
}
