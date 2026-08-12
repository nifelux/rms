/**
 * User API
 * Actions: getProfile, updateProfile, getWallet, getTransactions, getReferrals, getNotifications, markNotificationRead
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'getProfile': return getProfile(req, res);
      case 'updateProfile': return updateProfile(req, res);
      case 'getWallet': return getWallet(req, res);
      case 'getTransactions': return getTransactions(req, res);
      case 'getReferrals': return getReferrals(req, res);
      case 'getNotifications': return getNotifications(req, res);
      case 'markNotificationRead': return markNotificationRead(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getProfile(req, res) {
  const user = await verifyUser(req);
  const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  return res.status(200).json(data);
}

async function updateProfile(req, res) {
  const user = await verifyUser(req);
  const allowed = ['full_name','phone','username'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  await supabaseAdmin.from('profiles').update(updates).eq('id', user.id);
  return res.status(200).json({ message: 'Profile updated' });
}

async function getWallet(req, res) {
  const user = await verifyUser(req);
  const { data, error } = await supabaseAdmin.from('wallets').select('*').eq('user_id', user.id).single();
  if (error) return res.status(404).json({ error: 'Wallet not found' });
  return res.status(200).json(data);
}

async function getTransactions(req, res) {
  const user = await verifyUser(req);
  const { limit = 20, offset = 0, type } = req.query;
  let query = supabaseAdmin.from('transactions').select('*').eq('user_id', user.id);
  if (type) query = query.eq('type', type);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(+offset, +offset + +limit - 1).limit(+limit);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ data, count });
}

async function getReferrals(req, res) {
  const user = await verifyUser(req);
  // Direct referrals
  const { data: direct, error } = await supabaseAdmin.from('profiles').select('id, full_name, email, created_at').eq('referred_by', user.id);
  // Referral rewards earned
  const { data: rewards } = await supabaseAdmin.from('referral_rewards').select('*').eq('referrer_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json({ direct, rewards });
}

async function getNotifications(req, res) {
  const user = await verifyUser(req);
  const { data, error } = await supabaseAdmin.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
  return res.status(200).json(data);
}

async function markNotificationRead(req, res) {
  const user = await verifyUser(req);
  const { id } = req.body;
  if (id) {
    await supabaseAdmin.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
  } else {
    // mark all as read
    await supabaseAdmin.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
  }
  return res.status(200).json({ message: 'Updated' });
}
