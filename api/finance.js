import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  try {
    switch (action) {
      case 'getWallet': return await getWallet(req, res);
      case 'getTransactions': return await getTransactions(req, res);
      case 'getDeposits': return await getDeposits(req, res);
      case 'getWithdrawals': return await getWithdrawals(req, res);
      case 'getWithdrawalEligibility': return await getWithdrawalEligibility(req, res);
      case 'createDeposit': return await createDeposit(req, res);
      case 'createWithdrawal': return await createWithdrawal(req, res);
      
      // --- NEW GIFT CODE ACTIONS ---
      case 'generateGiftCodes': return await generateGiftCodes(req, res);
      case 'getMyGiftCodes': return await getMyGiftCodes(req, res);
      case 'redeemGiftCode': return await redeemGiftCode(req, res);
      
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Finance API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// --- HELPER: RMS Withdrawal Rules ---
function getWithdrawalRules(tier) {
  const t = (tier || '').toUpperCase();
  if (t === 'M1' || t === 'M2') return { day: 1, name: 'Monday' };
  if (t === 'M3' || t === 'M4') return { day: 2, name: 'Tuesday' };
  if (t === 'M5') return { day: 3, name: 'Wednesday' };
  if (t === 'M6') return { day: 4, name: 'Thursday' };
  if (t === 'M7') return { day: 5, name: 'Friday' };
  return null;
}

function checkWithdrawalWindow(tier) {
  const now = new Date();
  const watHour = (now.getUTCHours() + 1) % 24; // WAT is UTC+1
  const watDay = new Date(now.getTime() + 60 * 60 * 1000).getUTCDay(); // 0=Sun, 6=Sat

  if (watDay === 0 || watDay === 6) return { allowed: false, reason: 'No withdrawals on weekends.' };
  if (watHour < 10 || watHour >= 18) return { allowed: false, reason: 'Withdrawals are only open from 10am to 6pm WAT.' };

  const rules = getWithdrawalRules(tier);
  if (!rules) return { allowed: false, reason: 'Upgrade to an M-tier to withdraw.' };
  if (watDay !== rules.day) return { allowed: false, reason: `Your tier (${tier}) can only withdraw on ${rules.name}.` };

  return { allowed: true };
}

// --- HELPER: Generate Unique Code ---
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3) code += '-';
  }
  return code;
}

// --- ACTIONS ---

async function getWallet(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', user.id).single();
  if (!wallet) return res.status(200).json({ balance: 0, total_earned: 0, total_deposited: 0, total_withdrawn: 0 });
  
  return res.status(200).json(wallet);
}

async function getTransactions(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: transactions } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
    
  return res.status(200).json({ transactions: transactions || [] });
}

async function getDeposits(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: deposits } = await supabaseAdmin.from('deposits').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json({ deposits: deposits || [] });
}

async function getWithdrawals(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: withdrawals } = await supabaseAdmin.from('withdrawals').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json({ withdrawals: withdrawals || [] });
}

async function getWithdrawalEligibility(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level').eq('id', user.id).single();
  const tier = profile?.vip_level || 'newbie';
  
  const windowCheck = checkWithdrawalWindow(tier);
  const rules = getWithdrawalRules(tier);

  const now = new Date();
  const startOfTodayWAT = new Date(now.getTime() + 60 * 60 * 1000);
  startOfTodayWAT.setUTCHours(0, 0, 0, 0);
  const startOfTodayUTC = new Date(startOfTodayWAT.getTime() - 60 * 60 * 1000);

  const { count: todaysCount } = await supabaseAdmin.from('withdrawals').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).gte('created_at', startOfTodayUTC.toISOString());

  return res.status(200).json({
    tier: tier,
    withdrawal_day: rules ? rules.name : 'None',
    can_withdraw_now: windowCheck.allowed && todaysCount === 0,
    reason_blocked: windowCheck.allowed ? (todaysCount > 0 ? 'You have already withdrawn today.' : null) : windowCheck.reason,
    schedule: {
      'Monday': ['M1', 'M2'],
      'Tuesday': ['M3', 'M4'],
      'Wednesday': ['M5'],
      'Thursday': ['M6'],
      'Friday': ['M7']
    }
  });
}

async function createDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, payment_method, proof_image_url } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const { data: deposit, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id, amount: Number(amount), payment_method, proof_image_url, status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ message: 'Deposit submitted for approval.', deposit });
}

async function createWithdrawal(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, bank_name, account_number, account_name } = req.body;

  const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level').eq('id', user.id).single();
  const tier = profile?.vip_level || 'newbie';
  const windowCheck = checkWithdrawalWindow(tier);
  if (!windowCheck.allowed) return res.status(400).json({ error: windowCheck.reason });

  const ALLOWED_AMOUNTS = [1800, 3000, 8000, 16000, 32000, 70000, 120000, 300000, 700000, 1000000, 2500000, 3000000];
  if (!amount || !ALLOWED_AMOUNTS.includes(Number(amount))) return res.status(400).json({ error: 'Invalid withdrawal amount.' });

  const now = new Date();
  const startOfTodayWAT = new Date(now.getTime() + 60 * 60 * 1000);
  startOfTodayWAT.setUTCHours(0, 0, 0, 0);
  const startOfTodayUTC = new Date(startOfTodayWAT.getTime() - 60 * 60 * 1000);

  const { count: todaysCount } = await supabaseAdmin.from('withdrawals').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).gte('created_at', startOfTodayUTC.toISOString());
  if (todaysCount > 0) return res.status(400).json({ error: 'You can only make one withdrawal request per day.' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found. Please contact support.' });
  
  const { data: pending } = await supabaseAdmin.from('withdrawals').select('amount').eq('user_id', user.id).eq('status', 'pending');
  const pendingTotal = (pending || []).reduce((sum, r) => sum + Number(r.amount), 0);
  
  if (Number(amount) > (wallet.balance - pendingTotal)) return res.status(400).json({ error: 'Insufficient available balance.' });

  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount: Number(amount),
    bank_details: { bank_name, account_number, account_name }, status: 'pending'
  }).select().single();
  if (wdErr) return res.status(500).json({ error: wdErr.message });

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'withdrawal', amount: Number(amount), status: 'pending',
    reference: `wd_${wd.id}`, description: `Withdrawal to ${account_name}`
  });

  return res.status(201).json({ message: 'Withdrawal request submitted.', withdrawal: wd });
}

// ==========================================
// NEW GIFT CODE ACTIONS
// ==========================================

async function generateGiftCodes(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Check if user already generated codes recently (30-day cooldown)
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('last_gift_code_generation')
      .eq('id', user.id)
      .single();

    if (profile?.last_gift_code_generation) {
      const lastGen = new Date(profile.last_gift_code_generation);
      const now = new Date();
      const daysSinceLastGen = (now - lastGen) / (1000 * 60 * 60 * 24);
      
      if (daysSinceLastGen < 30) {
        const daysRemaining = Math.ceil(30 - daysSinceLastGen);
        return res.status(400).json({ 
          error: `You can only generate gift codes once every 30 days. Try again in ${daysRemaining} day(s).` 
        });
      }
    }

    // Get user's M2+ referrals
    const { data: referrals } = await supabaseAdmin
      .from('profiles')
      .select('id, vip_level, email, full_name')
      .eq('referred_by', user.id)
      .in('vip_level', ['M2', 'M3', 'M4', 'M5', 'M6', 'M7']);

    if (!referrals || referrals.length === 0) {
      return res.status(400).json({ error: 'No eligible M2+ referrals found' });
    }

    const generatedCodes = [];

    for (const ref of referrals) {
      // Generate random amount between 50 and 500
      const randomAmount = Math.floor(Math.random() * 451) + 50; // 50 to 500
      const code = generateCode();

      const { data, error } = await supabaseAdmin
        .from('gift_codes')
        .insert({
          code: code,
          amount: randomAmount,
          max_uses: 1,
          used_count: 0,
          is_active: true,
          created_by: user.id,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      generatedCodes.push({
        code: code,
        referral: ref.full_name || ref.email,
        tier: ref.vip_level,
        amount: randomAmount
      });
    }

    // Update the last generation timestamp
    await supabaseAdmin
      .from('profiles')
      .update({ 
        last_gift_code_generation: new Date().toISOString() 
      })
      .eq('id', user.id);

    return res.status(200).json({
      success: true,
      codes: generatedCodes,
      message: `Generated ${generatedCodes.length} gift codes successfully`
    });

  } catch (err) {
    console.error('Generate codes error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getMyGiftCodes(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: codes } = await supabaseAdmin
      .from('gift_codes')
      .select('*')
      .eq('created_by', user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    return res.status(200).json({ codes: codes || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function redeemGiftCode(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    // 1. Find the gift code
    const { data: giftCode, error: findError } = await supabaseAdmin
      .from('gift_codes')
      .select('*')
      .eq('code', code.toUpperCase().trim())
      .single();

    if (findError || !giftCode) {
      return res.status(404).json({ error: 'Invalid gift code. Please check and try again.' });
    }

    // 2. STRICT SINGLE-USE CHECK
    if (!giftCode.is_active) {
      return res.status(400).json({ error: 'This gift code has already been used by someone else.' });
    }

    // 3. Check if expired
    if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This gift code has expired.' });
    }

    

    // 5. Get current wallet balance
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    const currentBalance = wallet?.balance || 0;
    const newBalance = currentBalance + Number(giftCode.amount);

    // 6. Update wallet balance directly
    await supabaseAdmin
      .from('wallets')
      .update({ 
        balance: newBalance,
        updated_at: new Date()
      })
      .eq('user_id', user.id);

    // 7. MARK CODE AS USED
    await supabaseAdmin
      .from('gift_codes')
      .update({ 
        is_active: false, 
        used_count: 1,
        used_by: user.id
      })
      .eq('id', giftCode.id);

    // 8. Record transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: user.id,
        type: 'gift_code',
        amount: giftCode.amount,
        status: 'approved',
        reference: `gift_redeem_${Date.now()}`,
        description: `Redeemed Gift Code: ${code}`
      });

    return res.status(200).json({
      success: true,
      amount: giftCode.amount,
      new_balance: newBalance,
      message: `Success! ₦${giftCode.amount.toLocaleString()} added to your wallet.`
    });

  } catch (err) {
    console.error('Redeem code error:', err);
    return res.status(500).json({ error: err.message });
  }
}
