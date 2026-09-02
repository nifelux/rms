import supabaseAdmin from '../lib/supabase.js';
import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getDashboardStats':
        return await getDashboardStats(req, res);
      case 'getPendingDeposits':
        return await getPendingDeposits(req, res);
      case 'processDeposit':
        return await processDeposit(req, res);
      case 'getPendingWithdrawals':
        return await getPendingWithdrawals(req, res);
      case 'processWithdrawal':
        return await processWithdrawal(req, res);
      case 'getUsers':
        return await getUsers(req, res);
      case 'updateUserStatus':
        return await updateUserStatus(req, res);
      case 'manualWalletAdjustment':
        return await manualWalletAdjustment(req, res);
      case 'getSupportTickets':
        return await getSupportTickets(req, res);
      case 'replyToTicket':
        return await replyToTicket(req, res);
      case 'getWealthPlans':
        return await getWealthPlans(req, res);
      case 'createWealthPlan':
        return await createWealthPlan(req, res);
      case 'upgradeTier':
        return await upgradeTier(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action', received: action });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getDashboardStats(req, res) {
  await verifyAdmin(req);
  
  const [usersResult, depositsResult, withdrawalsResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact' }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved')
  ]);

  const totalDep = (depositsResult.data || []).reduce((sum, d) => sum + Number(d.amount), 0);
  const totalWith = (withdrawalsResult.data || []).reduce((sum, w) => sum + Number(w.amount), 0);
  const totalSystemBalance = totalDep - totalWith;

  const [pendingDeps, pendingWds] = await Promise.all([
    supabaseAdmin.from('deposits').select('id', { count: 'exact' }).eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('id', { count: 'exact' }).eq('status', 'pending')
  ]);

  return res.status(200).json({
    totalUsers: usersResult.count || 0,
    totalSystemBalance,
    pendingDeposits: pendingDeps.count || 0,
    pendingWithdrawals: pendingWds.count || 0
  });
}

async function getPendingDeposits(req, res) {
  await verifyAdmin(req);
  
  const { data } = await supabaseAdmin
    .from('deposits')
    .select('*, profiles(full_name, email)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  return res.status(200).json({ deposits: data || [] });
}

async function processDeposit(req, res) {
  await verifyAdmin(req);
  
  const { deposit_id, status } = req.body;
  
  const { data: deposit } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('id', deposit_id)
    .single();

  if (!deposit) {
    return res.status(404).json({ error: 'Deposit not found' });
  }

  await supabaseAdmin.from('deposits').update({ status, updated_at: new Date() }).eq('id', deposit_id);

  if (status === 'approved') {
    await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: deposit.amount,
      status: 'approved',
      reference: `dep_${deposit_id}`,
      description: 'Deposit approved by admin'
    });

    // Check if this is first deposit for referral bonus
    const { data: referrer } = await supabaseAdmin
      .from('profiles')
      .select('referred_by')
      .eq('id', deposit.user_id)
      .single();

    if (referrer?.referred_by) {
      const bonus = Number(deposit.amount) * 0.05; // 5% bonus
      await supabaseAdmin.from('transactions').insert({
        user_id: referrer.referred_by,
        type: 'referral',
        amount: bonus,
        status: 'approved',
        reference: `ref_bonus_${deposit_id}`,
        description: 'Referral bonus from deposit'
      });
    }
  }

  return res.status(200).json({ message: `Deposit ${status}` });
}

async function getPendingWithdrawals(req, res) {
  await verifyAdmin(req);
  
  const { data } = await supabaseAdmin
    .from('withdrawals')
    .select('*, profiles(full_name, email), bank_details')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  return res.status(200).json({ withdrawals: data || [] });
}

async function processWithdrawal(req, res) {
  await verifyAdmin(req);
  
  const { withdrawal_id, status } = req.body;
  
  await supabaseAdmin.from('withdrawals').update({ status, updated_at: new Date() }).eq('id', withdrawal_id);

  if (status === 'approved') {
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${withdrawal_id}`);
  }

  return res.status(200).json({ message: `Withdrawal ${status}` });
}

async function getUsers(req, res) {
  await verifyAdmin(req);
  
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, vip_level, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  return res.status(200).json({ users: data || [] });
}

async function updateUserStatus(req, res) {
  await verifyAdmin(req);
  
  const { user_id, is_banned, is_frozen, ban_reason } = req.body;
  
  await supabaseAdmin.from('profiles').update({
    is_banned: is_banned || false,
    is_frozen: is_frozen || false,
    ban_reason: ban_reason || null
  }).eq('id', user_id);

  return res.status(200).json({ message: 'User updated' });
}

async function manualWalletAdjustment(req, res) {
  await verifyAdmin(req);
  
  const { user_id, amount, type, description } = req.body;
  
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', user_id)
    .single();

  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found' });
  }

  const newBalance = type === 'credit' 
    ? Number(wallet.balance) + Number(amount)
    : Number(wallet.balance) - Number(amount);

  await supabaseAdmin.from('wallets').update({
    balance: newBalance,
    updated_at: new Date()
  }).eq('user_id', user_id);

  await supabaseAdmin.from('transactions').insert({
    user_id,
    type: type === 'credit' ? 'admin_credit' : 'admin_debit',
    amount: Number(amount),
    status: 'approved',
    reference: `admin_adj_${Date.now()}`,
    description: description || 'Manual adjustment by admin'
  });

  return res.status(200).json({ message: 'Wallet adjusted', newBalance });
}

async function getSupportTickets(req, res) {
  await verifyAdmin(req);
  
  const { data } = await supabaseAdmin
    .from('support_tickets')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(50);

  return res.status(200).json({ tickets: data || [] });
}

async function replyToTicket(req, res) {
  await verifyAdmin(req);
  
  const { ticket_id, message } = req.body;
  
  await supabaseAdmin.from('ticket_replies').insert({
    ticket_id,
    user_id: null,
    is_admin_reply: true,
    message
  });

  await supabaseAdmin.from('support_tickets').update({
    status: 'answered',
    updated_at: new Date()
  }).eq('id', ticket_id);

  return res.status(200).json({ message: 'Reply sent' });
}

async function getWealthPlans(req, res) {
  await verifyAdmin(req);
  
  const { data } = await supabaseAdmin
    .from('wealth_plans')
    .select('*')
    .order('created_at', { ascending: false });

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
      is_active: is_active !== undefined ? is_active : true
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ message: 'Plan created', plan: data });
}

// NEW: Upgrade Tier Function
async function upgradeTier(req, res) {
  try {
    // Verify user (not admin - this is for users upgrading themselves)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
      req.headers.authorization?.replace('Bearer ', '')
    );
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { target_tier } = req.body;
    
    if (!target_tier) {
      return res.status(400).json({ error: 'Target tier is required' });
    }

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

    if (!tierInfo) {
      return res.status(404).json({ error: 'Tier not found' });
    }

    // Check if already this tier
    if (profile.vip_level === target_tier) {
      return res.status(400).json({ error: 'You are already on this tier' });
    }

    // Get wallet
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (!wallet || Number(wallet.balance) < Number(tierInfo.upgrade_cost)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct cost from wallet
    const newBalance = Number(wallet.balance) - Number(tierInfo.upgrade_cost);
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
      type: 'tier_upgrade',
      amount: tierInfo.upgrade_cost,
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
