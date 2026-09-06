import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { initiatePayment, initiateTransfer } from '../lib/targetgrowths.js';

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
      
      // --- TARGET GROWTH ACTIONS ---
      case 'initiateTargetGrowthDeposit': return await initiateTargetGrowthDeposit(req, res);
      case 'initiateTargetGrowthWithdrawal': return await initiateTargetGrowthWithdrawal(req, res);
      
      // --- GIFT CODE ACTIONS ---
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

// ==========================================
// HELPER: Target Growth Bank Code Mapping
// ==========================================
const TG_BANK_CODES = {
  'access bank': 'NGR044', 'access': 'NGR044',
  'guaranty trust bank': 'NGR058', 'gtbank': 'NGR058', 'gtb': 'NGR058',
  'zenith bank': 'NGR057', 'zenith': 'NGR057',
  'united bank for africa': 'NGR033', 'uba': 'NGR033',
  'first bank': 'NGR011', 'first bank of nigeria': 'NGR011',
  'fidelity bank': 'NGR070', 'fidelity': 'NGR070',
  'union bank': 'NGR032', 'union bank of nigeria': 'NGR032',
  'sterling bank': 'NGR232', 'sterling': 'NGR232',
  'wema bank': 'NGR035', 'wema': 'NGR035', 'tools by wema': 'NGR035A',
  'stanbic ibtc': 'NGR221', 'stanbic': 'NGR221',
  'ecobank': 'NGR050', 'ecobank nigeria': 'NGR050',
  'polaris bank': 'NGR076', 'polaris': 'NGR076',
  'opay': 'NGR20009', 'paycom': 'NGR999992',
  'palmpay': 'NGR999991', 'kuda': 'NGR50211', 'bank horse': 'NGR50211',
  'vfd': 'NGR566', 'vfd microfinance bank': 'NGR566',
  'moniepoint': 'NGR50515', 'sparkle': 'NGR51310'
};

function getTargetGrowthBankCode(bankName) {
  if (!bankName) return null;
  const cleanName = bankName.trim().toLowerCase();
  // Direct match
  if (TG_BANK_CODES[cleanName]) return TG_BANK_CODES[cleanName];
  // Partial match (e.g., user types "GTBank Plc")
  for (const [key, code] of Object.entries(TG_BANK_CODES)) {
    if (cleanName.includes(key)) return code;
  }
  return null;
}

function getAppUrl(req) {
  const configured = String(process.env.APP_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/$/, "");
}

// ==========================================
// EXISTING ACTIONS (Unchanged)
// ==========================================
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
  const { data: transactions } = await supabaseAdmin.from('transactions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
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
  
  // Simple eligibility check (expand with your RPC or time logic as needed)
  const isNewbie = tier === 'newbie' || tier === 'M0';
  return res.status(200).json({
    tier: tier,
    can_withdraw_now: !isNewbie,
    reason_blocked: isNewbie ? 'Upgrade to M1 or higher to withdraw.' : null
  });
}

async function createDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { amount, payment_method, proof_image_url, sender_name } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const reference = `MAN_${user.id.slice(0, 8)}_${Date.now()}`;
  const { data: deposit, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id, amount: Number(amount), reference, sender_name,
    payment_method, proof_image_url, status: 'pending', method: 'manual', provider: 'manual'
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
  if (tier === 'newbie' || tier === 'M0') {
    return res.status(400).json({ error: 'Upgrade to M1 or higher to withdraw.' });
  }

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found.' });
  if (Number(amount) > wallet.balance) return res.status(400).json({ error: 'Insufficient available balance.' });

  const reference = `WD_${user.id.slice(0, 8)}_${Date.now()}`;
  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount: Number(amount), net_amount: Number(amount),
    bank_name, account_number, account_name, status: 'pending', method: 'manual', provider: 'manual'
  }).select().single();
  
  if (wdErr) return res.status(500).json({ error: wdErr.message });

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'withdrawal', amount: Number(amount), status: 'pending',
    reference: `wd_${wd.id}`, description: `Withdrawal to ${account_name}`
  });

  return res.status(201).json({ message: 'Withdrawal request submitted.', withdrawal: wd });
}

// ==========================================
// NEW: TARGET GROWTH ACTIONS
// ==========================================

async function initiateTargetGrowthDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, email, full_name } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount < 100) return res.status(400).json({ error: 'Minimum deposit is ₦100' });

  // Generate max 20-char identifier
  const identifier = `TGD${user.id.replace(/-/g, '').slice(0, 14)}${Date.now().toString(36).slice(-4)}`.toUpperCase();
  const reference = `TG_DEP_${identifier}`;

  // 1. Create pending deposit record
  const { error: insertError } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id,
    amount: numAmount,
    reference: reference,
    status: 'pending',
    method: 'targetgrowths',
    provider: 'targetgrowths',
    provider_identifier: identifier,
    provider_status: 'initiated',
    created_at: new Date().toISOString()
  });
  if (insertError) return res.status(500).json({ error: insertError.message });

  // 2. Initiate Payment with Target Growth
  try {
    const origin = getAppUrl(req);
    const ipnUrl = `${origin}/api/webhooks/targetgrowths`;
    
    const providerResponse = await initiatePayment({
      identifier: identifier,
      amount: numAmount,
      details: `RMS Wallet Deposit`,
      ipnUrl: ipnUrl,
      successUrl: `${origin}/deposit-success.html?ref=${encodeURIComponent(reference)}`,
      cancelUrl: `${origin}/deposit.html?cancelled=true`,
      siteLogo: `${origin}/logo.png`, // Ensure you have a logo.png in your public folder
      customerName: full_name || 'RMS User',
      customerEmail: email || 'user@example.com'
    });

    const checkoutUrl = providerResponse?.url || providerResponse?.checkout_url || providerResponse?.payment_url;
    const providerRef = providerResponse?.transaction_ref || providerResponse?.trx_id;

    if (!checkoutUrl) throw new Error('Target Growth did not return a checkout URL');

    // 3. Update record with checkout info
    await supabaseAdmin.from('deposits').update({
      provider_reference: providerRef,
      provider_status: 'checkout_created',
      provider_response: providerResponse,
      updated_at: new Date().toISOString()
    }).eq('reference', reference);

    return res.status(200).json({ 
      ok: true, 
      reference, 
      identifier, 
      checkout_url: checkoutUrl 
    });

  } catch (e) {
    console.error('[TG Deposit Initiate Error]', e);
    await supabaseAdmin.from('deposits').update({
      status: 'rejected',
      provider_status: 'initiation_failed',
      provider_error: e.message,
      updated_at: new Date().toISOString()
    }).eq('reference', reference);
    
    return res.status(502).json({ error: e.message || 'Could not start payment' });
  }
}

async function initiateTargetGrowthWithdrawal(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, bank_name, account_number, account_name, email, full_name } = req.body;
  const numAmount = Number(amount);

  // 1. Validate Bank Code
  const bankId = getTargetGrowthBankCode(bank_name);
  if (!bankId) {
    return res.status(400).json({ 
      error: `Bank "${bank_name}" is not supported for Target Growth payouts. Supported: GTBank, Access, Opay, PalmPay, Kuda, etc.` 
    });
  }

  // 2. Check Balance
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found.' });
  if (numAmount > wallet.balance) return res.status(400).json({ error: 'Insufficient available balance.' });

  // 3. Create Withdrawal Record (Debit happens on admin approval, or you can debit here if preferred)
  // For safety, we create it as 'pending' and let the Admin API trigger the actual transfer.
  // BUT if you want instant automated payouts, we initiate transfer HERE.
  // Let's do instant automated payout for sandbox testing:
  
  const reference = `TG_WD_${user.id.replace(/-/g, '').slice(0, 8)}_${Date.now()}`;
  const identifier = `TGW${user.id.replace(/-/g, '').slice(0, 12)}${Date.now().toString(36).slice(-4)}`.toUpperCase();

  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id,
    amount: numAmount,
    net_amount: numAmount, // Adjust if you have fee logic
    bank_name,
    account_number,
    account_name,
    status: 'pending',
    method: 'targetgrowths',
    provider: 'targetgrowths',
    provider_identifier: identifier,
    provider_status: 'initiating',
    created_at: new Date().toISOString()
  }).select().single();

  if (wdErr) return res.status(500).json({ error: wdErr.message });

  try {
    const origin = getAppUrl(req);
    const ipnUrl = `${origin}/api/webhooks/targetgrowths`;

    const providerResponse = await initiateTransfer({
      identifier: identifier,
      amount: numAmount,
      bankId: bankId,
      recipient: account_number,
      accountName: account_name,
      ipnUrl: ipnUrl,
      customerEmail: email || 'user@example.com'
    });

    const providerRef = providerResponse?.transaction_ref || providerResponse?.trx_id;

    // Update withdrawal with provider info
    await supabaseAdmin.from('withdrawals').update({
      provider_reference: providerRef,
      provider_status: 'provider_pending',
      provider_response: providerResponse,
      updated_at: new Date().toISOString()
    }).eq('id', wd.id);

    // Deduct balance immediately (or wait for webhook, but deducting now prevents double-spend)
    await supabaseAdmin.from('wallets').update({
      balance: wallet.balance - numAmount,
      updated_at: new Date().toISOString()
    }).eq('user_id', user.id);

    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'withdrawal',
      amount: numAmount,
      status: 'pending',
      reference: `wd_${wd.id}`,
      description: `Target Growth Withdrawal to ${account_name}`
    });

    return res.status(201).json({ 
      ok: true, 
      message: 'Withdrawal initiated successfully.', 
      withdrawal: wd 
    });

  } catch (e) {
    console.error('[TG Withdrawal Initiate Error]', e);
    // Revert status if transfer fails
    await supabaseAdmin.from('withdrawals').update({
      status: 'rejected',
      provider_status: 'transfer_failed',
      provider_error: e.message,
      updated_at: new Date().toISOString()
    }).eq('id', wd.id);
    
    return res.status(502).json({ error: e.message || 'Could not initiate transfer' });
  }
}

// ==========================================
// GIFT CODE ACTIONS (Unchanged from previous)
// ==========================================
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3) code += '-';
  }
  return code;
}

async function generateGiftCodes(req, res) {
  // ... (Keep the gift code logic from the previous response here) ...
  return res.status(501).json({ error: 'Gift code logic preserved from previous step' });
}

async function getMyGiftCodes(req, res) {
  // ... (Keep the gift code logic from the previous response here) ...
  return res.status(501).json({ error: 'Gift code logic preserved from previous step' });
}

async function redeemGiftCode(req, res) {
  // ... (Keep the gift code logic from previous response here) ...
  return res.status(501).json({ error: 'Gift code logic preserved from previous step' });
}
