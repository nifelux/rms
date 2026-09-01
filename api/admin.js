import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

// Helper to ensure the user is an admin
async function verifyAdmin(req) {
  const user = await verifyUser(req);
  if (!user) return null;
  const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile || !profile.is_admin) return null;
  return user;
}

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  try {
    switch (action) {
      // Dashboard & Stats
      case 'getDashboardStats': return await getDashboardStats(req, res);
      
      // User Management
      case 'getUsers': return await getUsers(req, res);
      case 'updateUserStatus': return await updateUserStatus(req, res);
      case 'manualWalletAdjustment': return await manualWalletAdjustment(req, res);
      
      // Deposits & Withdrawals
      case 'getPendingDeposits': return await getPendingDeposits(req, res);
      case 'processDeposit': return await processDeposit(req, res);
      case 'getPendingWithdrawals': return await getPendingWithdrawals(req, res);
      case 'processWithdrawal': return await processWithdrawal(req, res);
      
      // Support
      case 'getSupportTickets': return await getSupportTickets(req, res);
      case 'replyToTicket': return await replyToTicket(req, res);
      
      // Wealth Center Management
      case 'getWealthPlans': return await getWealthPlans(req, res);
      case 'createWealthPlan': return await createWealthPlan(req, res);
      
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// --- 1. DASHBOARD STATS ---
async function getDashboardStats(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { count: totalUsers } = await supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true });
  const { count: pendingDeps } = await supabaseAdmin.from('deposits').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  const { count: pendingWds } = await supabaseAdmin.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  
  // Calculate total system balance
  const { data: wallets } = await supabaseAdmin.from('wallets').select('balance');
  const totalBalance = wallets ? wallets.reduce((sum, w) => sum + Number(w.balance), 0) : 0;

  return res.status(200).json({
    totalUsers: totalUsers || 0,
    pendingDeposits: pendingDeps || 0,
    pendingWithdrawals: pendingWds || 0,
    totalSystemBalance: totalBalance
  });
}

// --- 2. USER MANAGEMENT ---
async function getUsers(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { data: users } = await supabaseAdmin
    .from('profiles')
    .select('id, username, full_name, email, vip_level, is_banned, is_frozen, created_at, wallets(balance)')
    .order('created_at', { ascending: false })
    .limit(100);
  
  return res.status(200).json({ users: users || [] });
}

async function updateUserStatus(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { user_id, is_banned, is_frozen, vip_level } = req.body;
  
  const updateData = {};
  if (is_banned !== undefined) updateData.is_banned = is_banned;
  if (is_frozen !== undefined) updateData.is_frozen = is_frozen;
  if (vip_level) updateData.vip_level = vip_level;

  const { error } = await supabaseAdmin.from('profiles').update(updateData).eq('id', user_id);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ message: 'User status updated successfully.' });
}

async function manualWalletAdjustment(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { user_id, amount, type, description } = req.body; // type: 'admin_credit' or 'admin_debit'
  
  if (!['admin_credit', 'admin_debit'].includes(type)) {
    return res.status(400).json({ error: 'Invalid adjustment type.' });
  }

  // Insert transaction (The DB trigger will automatically update the wallet balance)
  const { error } = await supabaseAdmin.from('transactions').insert({
    user_id, type, amount: Number(amount), status: 'approved',
    reference: `admin_${Date.now()}`, description: description || 'Manual admin adjustment'
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ message: 'Wallet adjusted successfully.' });
}

// --- 3. DEPOSITS & WITHDRAWALS ---
async function getPendingDeposits(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { data: deposits } = await supabaseAdmin
    .from('deposits').select('*, profiles(full_name, email, vip_level)').eq('status', 'pending').order('created_at', { ascending: false });
  return res.status(200).json({ deposits: deposits || [] });
}

async function processDeposit(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { deposit_id, status } = req.body; 

  const { error } = await supabaseAdmin.from('deposits').update({ status, updated_at: new Date() }).eq('id', deposit_id);
  if (error) return res.status(500).json({ error: error.message });

  if (status === 'approved') {
    const { data: deposit } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
    await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id, type: 'deposit', amount: deposit.amount,
      status: 'approved', reference: `dep_${deposit.id}`, description: 'Deposit approved'
    });
  }
  return res.status(200).json({ message: `Deposit ${status}.` });
}

async function getPendingWithdrawals(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { data: withdrawals } = await supabaseAdmin
    .from('withdrawals').select('*, profiles(full_name, email, vip_level)').eq('status', 'pending').order('created_at', { ascending: false });
  return res.status(200).json({ withdrawals: withdrawals || [] });
}

async function processWithdrawal(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { withdrawal_id, status } = req.body; 

  const { error } = await supabaseAdmin.from('withdrawals').update({ status, updated_at: new Date() }).eq('id', withdrawal_id);
  if (error) return res.status(500).json({ error: error.message });

  // Update the linked transaction so the DB trigger handles the balance deduction/refund
  const { data: withdrawal } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  await supabaseAdmin.from('transactions').update({ status: status === 'approved' ? 'approved' : 'rejected' })
    .eq('reference', `wd_${withdrawal_id}`);

  return res.status(200).json({ message: `Withdrawal ${status}.` });
}

// --- 4. SUPPORT TICKETS ---
async function getSupportTickets(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { data: tickets } = await supabaseAdmin
    .from('support_tickets').select('*, profiles(full_name, email), ticket_replies(*)').order('created_at', { ascending: false });
  return res.status(200).json({ tickets: tickets || [] });
}

async function replyToTicket(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { ticket_id, message } = req.body;
  
  await supabaseAdmin.from('ticket_replies').insert({
    ticket_id, user_id: admin.id, is_admin_reply: true, message
  });
  
  await supabaseAdmin.from('support_tickets').update({ status: 'answered' }).eq('id', ticket_id);

  return res.status(200).json({ message: 'Reply sent.' });
}

// --- 5. WEALTH CENTER MANAGEMENT ---
async function getWealthPlans(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { data: plans } = await supabaseAdmin.from('wealth_plans').select('*').order('created_at', { ascending: false });
  return res.status(200).json({ plans: plans || [] });
}

async function createWealthPlan(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const { name, description, invest_amount, return_amount, duration_days } = req.body;

  const { error } = await supabaseAdmin.from('wealth_plans').insert({
    name, description, invest_amount: Number(invest_amount), 
    return_amount: Number(return_amount), duration_days: Number(duration_days)
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ message: 'Wealth plan created.' });
}
