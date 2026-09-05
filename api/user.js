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
        case 'claimReferralGift': return await claimReferralGift(req, res);
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

async function claimReferralGift(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // 1. Get user profile to check if already claimed recently
    const { data: profile } = await supabaseAdmin.from('profiles').select('referral_gift_claimed_at').eq('id', user.id).single();
    
    // Optional: Prevent claiming more than once a month. Remove this if you want it to be a one-time lifetime reward.
    if (profile.referral_gift_claimed_at) {
      const lastClaim = new Date(profile.referral_gift_claimed_at);
      const daysSince = (Date.now() - lastClaim.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        return res.status(400).json({ error: `You already claimed a gift code recently. Try again in ${Math.ceil(30 - daysSince)} days.` });
      }
    }

    // 2. Fetch all direct referrals
    const { data: referrals } = await supabaseAdmin.from('profiles').select('vip_level').eq('referred_by', user.id);
    
    if (!referrals || referrals.length === 0) {
      return res.status(400).json({ error: 'You have no referrals yet.' });
    }

    // 3. Count referrals on M2 or higher
    const highTierCount = referrals.filter(r => ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'].includes(r.vip_level)).length;

    if (highTierCount < 2) {
      return res.status(400).json({ error: `You need at least 2 referrals on M2 or higher to claim this reward. You currently have ${highTierCount}.` });
    }

    // 4. Generate Gift Code
    const code = 'GIFT-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const rewardAmount = 5000; // Set your reward amount here (e.g., ₦5,000)

    // 5. Save the code to the gift_codes table
    const { error: codeError } = await supabaseAdmin.from('gift_codes').insert({
      code: code,
      amount: rewardAmount,
      max_uses: 1,
      is_active: true,
      created_by: user.id // Track who generated it
    });

    if (codeError) throw codeError;

    // 6. Update profile to mark as claimed
    await supabaseAdmin.from('profiles').update({ referral_gift_claimed_at: new Date().toISOString() }).eq('id', user.id);

    return res.status(200).json({ 
      success: true, 
      code: code, 
      amount: rewardAmount,
      message: `Congratulations! You've earned a ₦${rewardAmount.toLocaleString()} gift code.`
    });

  } catch (err) {
    console.error('claimReferralGift error:', err);
    return res.status(500).json({ error: err.message });
  }
}
