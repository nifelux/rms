import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getStats': return await getStats(req, res);
      case 'claimCommission': return await claimCommission(req, res);
      case 'requestGiftCode': return await requestGiftCode(req, res);
      case 'getSpinCount': return await getSpinCount(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Referral API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Get referral statistics
async function getStats(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

  // Get all direct referrals
  const { data: referrals } = await supabaseAdmin
    .from('profiles')
    .select('id, vip_level, email, full_name, created_at')
    .eq('referred_by', user.id);

  // Count by tier
  const stats = {
    total: referrals.length,
    vip_upgrades: 0,
    m2_plus: 0,
    wheel_spins: 0,
    total_commission: 0
  };

  const m2Tiers = ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
  const vipTiers = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

  referrals.forEach(ref => {
    if (vipTiers.includes(ref.vip_level)) {
      stats.vip_upgrades++;
      stats.wheel_spins++; // 1 spin per active VIP referral
    }
    if (m2Tiers.includes(ref.vip_level)) {
      stats.m2_plus++;
    }
  });

  // Get total commission earned
  const { data: commissions } = await supabaseAdmin
    .from('referral_commissions')
    .select('commission_amount')
    .eq('referrer_id', user.id)
    .eq('status', 'paid');

  stats.total_commission = commissions.reduce((sum, c) => sum + Number(c.commission_amount), 0);

  // Get wheel spins from profile
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('wheel_spins')
    .eq('id', user.id)
    .single();

  if (profile) {
    stats.wheel_spins = profile.wheel_spins || 0;
  }

  return res.status(200).json(stats);
}

// Claim 10% commission when referral upgrades to VIP
async function claimCommission(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { referred_user_id, vip_tier, upgrade_cost } = req.body;

  // VIP upgrade costs
  const vipCosts = {
    'M1': 3000, 'M2': 10000, 'M3': 30000, 'M4': 50000,
    'M5': 150000, 'M6': 300000, 'M7': 500000
  };

  const cost = upgrade_cost || vipCosts[vip_tier];
  if (!cost) return res.status(400).json({ error: 'Invalid VIP tier or cost' });

  // Calculate 10% commission
  const commissionAmount = cost * 0.10;

  // Check if already claimed
  const { data: existing } = await supabaseAdmin
    .from('referral_commissions')
    .select('id')
    .eq('referrer_id', user.id)
    .eq('referred_user_id', referred_user_id)
    .eq('tier', vip_tier)
    .single();

  if (existing) {
    return res.status(400).json({ error: 'Commission already claimed for this upgrade' });
  }

  // Save commission record
  const { error: commError } = await supabaseAdmin
    .from('referral_commissions')
    .insert({
      referrer_id: user.id,
      referred_user_id,
      commission_amount: commissionAmount,
      commission_type: 'vip_upgrade',
      tier: vip_tier,
      status: 'pending'
    });

  if (commError) return res.status(500).json({ error: 'Failed to record commission' });

  // Credit wallet immediately
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', user.id)
    .single();

  const newBalance = Number(wallet.balance) + commissionAmount;
  await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('user_id', user.id);

  // Update commission record to paid
  await supabaseAdmin
    .from('referral_commissions')
    .update({ status: 'paid', paid_at: new Date() })
    .eq('referrer_id', user.id)
    .eq('referred_user_id', referred_user_id)
    .eq('tier', vip_tier);

  // Update total commission earned
  await supabaseAdmin.rpc('increment_total_commission', { 
    user_id: user.id, 
    amount: commissionAmount 
  });

  // Record transaction
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'referral_commission',
    amount: commissionAmount,
    status: 'approved',
    reference: `comm_${Date.now()}`,
    description: `10% commission from ${vip_tier} upgrade`
  });

  return res.status(200).json({ 
    success: true, 
    message: `₦${commissionAmount.toLocaleString()} commission credited!`,
    amount: commissionAmount 
  });
}

// Request gift code based on M2+ downline
async function requestGiftCode(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { m2_downline_id, downline_tier } = req.body;

  // Validate tier
  const validTiers = ['M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
  if (!validTiers.includes(downline_tier)) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  // Get coupon percentage (5-20%)
  const { data: percentageData } = await supabaseAdmin
    .rpc('get_coupon_percentage', { tier: downline_tier });
  
  const couponPercentage = percentageData || 5;

  // Calculate coupon amount (5-20% of what? Let's use base of ₦10,000)
  const baseAmount = 10000;
  const couponAmount = baseAmount * (couponPercentage / 100);

  // Generate gift code
  const giftCode = 'GIFT-' + Math.random().toString(36).substring(2, 8).toUpperCase();

  // Save request
  const { error: reqError } = await supabaseAdmin
    .from('gift_code_requests')
    .insert({
      user_id: user.id,
      m2_downline_id,
      downline_tier,
      coupon_percentage: couponPercentage,
      gift_code: giftCode,
      status: 'approved'
    });

  if (reqError) return res.status(500).json({ error: 'Failed to create gift code' });

  // Save to gift_codes table
  await supabaseAdmin.from('gift_codes').insert({
    code: giftCode,
    amount: couponAmount,
    max_uses: 1,
    is_active: true,
    created_by: user.id
  });

  return res.status(200).json({
    success: true,
    code: giftCode,
    amount: couponAmount,
    percentage: couponPercentage,
    message: `Gift code generated: ${couponPercentage}% bonus (₦${couponAmount.toLocaleString()})`
  });
}

// Get wheel spin count from database
async function getSpinCount(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('wheel_spins')
    .eq('id', user.id)
    .single();

  return res.status(200).json({ 
    spins: profile?.wheel_spins || 0 
  });
}

// Helper function to update total commission
await supabaseAdmin.rpc(`
  CREATE OR REPLACE FUNCTION increment_total_commission(user_id UUID, amount NUMERIC)
  RETURNS void AS $$
  BEGIN
    UPDATE profiles 
    SET total_commission_earned = COALESCE(total_commission_earned, 0) + amount
    WHERE id = user_id;
  END;
  $$ LANGUAGE plpgsql;
`);
