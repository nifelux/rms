/**
 * Investment API
 * Actions: products (list public), createInvestment, myInvestments, productDetail
 * Admin actions: createProduct, updateProduct, deleteProduct, toggleLock
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      // Public / user
      case 'products': return listProducts(req, res);
      case 'productDetail': return productDetail(req, res);
      case 'createInvestment': return createInvestment(req, res);
      case 'myInvestments': return myInvestments(req, res);
      // Welfare (user-configured amount + duration, claim-at-maturity)
      case 'welfareRate': return welfareRate(req, res);
      case 'createWelfareInvestment': return createWelfareInvestment(req, res);
      case 'myWelfarePlans': return myWelfarePlans(req, res);
      case 'claimWelfare': return claimWelfare(req, res);
      // Admin
      case 'createProduct': return createProduct(req, res);
      case 'updateProduct': return updateProduct(req, res);
      case 'deleteProduct': return deleteProduct(req, res);
      case 'toggleLock': return toggleLock(req, res);
      // Cron (daily income) — called by Vercel's scheduled cron via
      // CRON_SECRET, or manually by an admin via the admin panel
      case 'triggerDailyIncome': return triggerDailyIncome(req, res);
      case 'cronStatus': return cronStatus(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function listProducts(req, res) {
  // Exclude locked ones for non-admins? We'll show all; only admin can see locked.
  let query = supabaseAdmin.from('products').select('*');
  // If user is not admin, don't show locked
  try {
    const user = await verifyUser(req);
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!profile?.is_admin) query = query.eq('is_locked', false);
  } catch {
    query = query.eq('is_locked', false);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function productDetail(req, res) {
  const { id } = req.query;
  const { data } = await supabaseAdmin.from('products').select('*').eq('id', id).single();
  return res.status(200).json(data);
}

async function createInvestment(req, res) {
  const user = await verifyUser(req);
  const { product_id, amount } = req.body;

  // Validate product exists and not locked
  const { data: product } = await supabaseAdmin.from('products').select('*').eq('id', product_id).single();
  if (!product || product.is_locked) return res.status(400).json({ error: 'Product not available' });
  if (amount < product.min_invest) return res.status(400).json({ error: `Minimum investment: ₦${product.min_invest}` });
  if (product.max_invest && amount > product.max_invest) return res.status(400).json({ error: `Maximum investment: ₦${product.max_invest}` });

  // Purchase-limit pre-check (friendly message; the DB trigger
  // trg_enforce_purchase_limit is the real enforcement backstop in
  // case this endpoint is ever bypassed)
  if (product.max_purchases_per_user != null) {
    const { count } = await supabaseAdmin
      .from('investments')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('product_id', product.id);
    if ((count || 0) >= product.max_purchases_per_user) {
      return res.status(400).json({ error: `You've reached the purchase limit (${product.max_purchases_per_user}) for this product.` });
    }
  }

  // Check wallet balance
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Fixed-price packages (daily_income_amount set) pay a flat ₦/day
  // figure directly. Flexible/open-amount products fall back to the
  // percentage-of-amount calculation.
  const dailyIncome = product.daily_income_amount != null
    ? Number(product.daily_income_amount)
    : (amount * product.daily_roi_percent) / 100;

  // Deduct balance via transaction — this INSERT (status already
  // 'approved') is what trg_process_transaction picks up to actually
  // subtract from wallets.balance for type='investment'. This is the
  // step the old client-side direct-insert flow was skipping entirely,
  // which is why balances weren't being debited.
  const { data: txn, error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'investment',
    amount: amount,
    status: 'approved',
    reference: `inv_${Date.now()}_${user.id.substring(0,8)}`
  }).select().single();
  if (txnErr) return res.status(400).json({ error: txnErr.message });

  // Create investment record
  const { data: investment, error } = await supabaseAdmin.from('investments').insert({
    user_id: user.id,
    product_id: product.id,
    amount,
    daily_income: dailyIncome,
    duration_days: product.duration_days
  }).select().single();
  if (error) {
    return res.status(400).json({
      error: error.message.includes('Purchase limit')
        ? `You've reached the purchase limit for this product.`
        : error.message
    });
  }

  // Log activity
  await supabaseAdmin.from('activity_logs').insert({
    user_id: user.id,
    action: 'investment_create',
    details: { investment_id: investment.id, amount, product: product.name }
  });

  // Notification failures (e.g. Telegram env vars not configured) must
  // never make an already-successful investment look like it failed —
  // the money has moved and the investment row exists at this point.
  try {
    await sendTelegramMessage(`📈 New investment: ₦${amount} in ${product.name} by ${user.email}`);
  } catch (notifyErr) {
    console.error('Telegram notification failed (investment still succeeded):', notifyErr.message);
  }

  return res.status(200).json(investment);
}

async function myInvestments(req, res) {
  const user = await verifyUser(req);
  const { data, error } = await supabaseAdmin.from('investments')
    .select('*, products(name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return res.status(200).json(data);
}

// ============================================================
// WELFARE — user-configured amount + duration, claim at maturity
// ============================================================
// Daily rate tapers from WELFARE_MAX_RATE at the minimum duration down
// to WELFARE_MIN_RATE at the maximum duration: shorter plans earn a
// higher day-rate, longer plans earn a lower day-rate but accumulate a
// bigger total payout simply by running longer. Linear on purpose —
// easy to verify and explain to a user, no hidden curve.
const WELFARE_MIN_AMOUNT = 5000;
const WELFARE_MIN_DAYS = 3;
const WELFARE_MAX_DAYS = 365;
const WELFARE_MAX_RATE = 3.0;   // %/day at WELFARE_MIN_DAYS
const WELFARE_MIN_RATE = 0.5;   // %/day at WELFARE_MAX_DAYS

function welfareDailyRatePercent(days) {
  const clamped = Math.min(WELFARE_MAX_DAYS, Math.max(WELFARE_MIN_DAYS, Number(days)));
  const span = WELFARE_MAX_DAYS - WELFARE_MIN_DAYS;
  return WELFARE_MAX_RATE - (WELFARE_MAX_RATE - WELFARE_MIN_RATE) * (clamped - WELFARE_MIN_DAYS) / span;
}

// Lets the frontend show a live daily-profit preview as the user drags
// the duration slider, without trusting a client-supplied rate later.
async function welfareRate(req, res) {
  const days = Number(req.query.days);
  if (!days || days < WELFARE_MIN_DAYS || days > WELFARE_MAX_DAYS) {
    return res.status(400).json({ error: `Duration must be between ${WELFARE_MIN_DAYS} and ${WELFARE_MAX_DAYS} days` });
  }
  const rate = welfareDailyRatePercent(days);
  return res.status(200).json({ daily_rate_percent: Number(rate.toFixed(3)) });
}

async function createWelfareInvestment(req, res) {
  const user = await verifyUser(req);
  const { amount, duration_days } = req.body;

  if (!amount || Number(amount) < WELFARE_MIN_AMOUNT) {
    return res.status(400).json({ error: `Minimum Welfare investment is ₦${WELFARE_MIN_AMOUNT.toLocaleString()}` });
  }
  if (!duration_days || duration_days < WELFARE_MIN_DAYS || duration_days > WELFARE_MAX_DAYS) {
    return res.status(400).json({ error: `Duration must be between ${WELFARE_MIN_DAYS} and ${WELFARE_MAX_DAYS} days` });
  }

  // Wallet balance check
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet || Number(wallet.balance) < Number(amount)) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const dailyRate = welfareDailyRatePercent(duration_days);
  const dailyProfit = (Number(amount) * dailyRate) / 100;
  const startDate = new Date();
  const maturityDate = new Date(startDate.getTime() + Number(duration_days) * 24 * 60 * 60 * 1000);

  // Debit the wallet for the capital — this insert (status 'approved')
  // is what trg_process_transaction picks up to subtract from
  // wallets.balance for type='investment', same mechanism the normal
  // investment flow above uses.
  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'investment',
    amount: Number(amount),
    status: 'approved',
    reference: `wf_${Date.now()}_${user.id.substring(0, 8)}`
  });
  if (txnErr) return res.status(400).json({ error: txnErr.message });

  const { data: plan, error } = await supabaseAdmin.from('welfare_investments').insert({
    user_id: user.id,
    amount: Number(amount),
    duration_days: Number(duration_days),
    daily_rate_percent: Number(dailyRate.toFixed(3)),
    daily_profit: Number(dailyProfit.toFixed(2)),
    start_date: startDate,
    maturity_date: maturityDate,
    status: 'active'
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await supabaseAdmin.from('activity_logs').insert({
    user_id: user.id,
    action: 'welfare_create',
    details: { welfare_id: plan.id, amount, duration_days }
  });

  try {
    await sendTelegramMessage(`🌾 New Welfare plan: ₦${amount} for ${duration_days} days by ${user.email}`);
  } catch (notifyErr) {
    console.error('Telegram notification failed (welfare plan still created):', notifyErr.message);
  }

  return res.status(200).json(plan);
}

async function myWelfarePlans(req, res) {
  const user = await verifyUser(req);
  const { data, error } = await supabaseAdmin
    .from('welfare_investments')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function claimWelfare(req, res) {
  const user = await verifyUser(req);
  const { id } = req.body;

  const { data: plan } = await supabaseAdmin.from('welfare_investments').select('*').eq('id', id).eq('user_id', user.id).single();
  if (!plan) return res.status(404).json({ error: 'Welfare plan not found' });
  if (plan.status !== 'active') return res.status(400).json({ error: 'This plan has already been claimed' });
  if (new Date(plan.maturity_date) > new Date()) return res.status(400).json({ error: 'This plan has not matured yet' });

  const totalPayout = Number(plan.amount) + Number(plan.daily_profit) * Number(plan.duration_days);

  // Credit the wallet directly via RPC rather than inserting an
  // 'approved' transaction row: trg_process_transaction fires on ANY
  // row where status='approved' regardless of type, and it doesn't
  // recognize 'welfare_claim' as a known credit type, so we can't
  // safely rely on it here without risking either a silent no-op or an
  // unintended double-credit if the trigger's fallback behavior ever
  // changes. The RPC is the same proven mechanism already used for
  // withdrawal-rejection refunds.
  const { error: rpcErr } = await supabaseAdmin.rpc('credit_wallet_balance', {
    p_user_id: user.id,
    p_amount: totalPayout
  });
  if (rpcErr) return res.status(500).json({ error: rpcErr.message });

  // Audit-only record — status is deliberately NOT 'approved' so this
  // insert can never fire trg_process_transaction and double-credit
  // the wallet on top of the RPC call above.
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'welfare_claim',
    amount: totalPayout,
    status: 'paid',
    reference: `wfclaim_${plan.id}`,
    meta: { welfare_id: plan.id, capital: plan.amount, profit: totalPayout - Number(plan.amount) }
  });

  await supabaseAdmin.from('welfare_investments')
    .update({ status: 'claimed', claimed_at: new Date() })
    .eq('id', plan.id);

  return res.status(200).json({ message: 'Claimed successfully', amount: totalPayout });
}

// Admin actions
async function createProduct(req, res) {
  await verifyAdmin(req);
  const { name, description, min_invest, max_invest, daily_roi_percent, duration_days, daily_income_amount, max_purchases_per_user, category } = req.body;
  const { data, error } = await supabaseAdmin.from('products').insert({
    name, description, min_invest, max_invest, daily_roi_percent, duration_days,
    daily_income_amount: daily_income_amount ?? null,
    max_purchases_per_user: max_purchases_per_user ?? null,
    category: category || 'investment'
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json(data);
}

async function updateProduct(req, res) {
  await verifyAdmin(req);
  const { id, ...updates } = req.body;
  await supabaseAdmin.from('products').update(updates).eq('id', id);
  return res.status(200).json({ message: 'Product updated' });
}

async function deleteProduct(req, res) {
  await verifyAdmin(req);
  const { id } = req.body;
  await supabaseAdmin.from('products').delete().eq('id', id);
  return res.status(200).json({ message: 'Product deleted' });
}

async function toggleLock(req, res) {
  await verifyAdmin(req);
  const { id, is_locked } = req.body;
  await supabaseAdmin.from('products').update({ is_locked }).eq('id', id);
  return res.status(200).json({ message: `Product ${is_locked ? 'locked' : 'unlocked'}` });
}

/* ============================================================
   DAILY INCOME CRON
   ============================================================
   IMPORTANT: as of this fix, nothing was ever actually running this on
   a schedule — there was no /api/cron.js and no `crons` entry in
   vercel.json, so active investments' daily income was never being
   paid out automatically. This adds both: the processing action here,
   plus a `crons` entry in vercel.json calling it once daily.
*/

// Authorizes either Vercel's scheduled cron (via a shared secret) or a
// logged-in admin clicking "Run Now" in the admin panel. Throws if
// neither check passes, same convention as verifyAdmin/verifyUser.
async function verifyCronOrAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const providedSecret = authHeader.replace('Bearer ', '');
  if (process.env.CRON_SECRET && providedSecret === process.env.CRON_SECRET) {
    return { via: 'cron' };
  }
  const admin = await verifyAdmin(req);
  return { via: 'admin', admin };
}

async function triggerDailyIncome(req, res) {
  let auth;
  try {
    auth = await verifyCronOrAdmin(req);
  } catch (err) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Idempotency: only pick up investments not already paid today. This
  // makes it safe to call this endpoint more than once on the same day
  // (e.g. an admin clicking "Run Now" right after the scheduled cron
  // already ran) without double-paying anyone.
  const { data: dueInvestments, error: fetchErr } = await supabaseAdmin
    .from('investments')
    .select('*')
    .eq('status', 'active')
    .or(`last_income_date.is.null,last_income_date.lt.${today}`);

  if (fetchErr) {
    await supabaseAdmin.from('cron_logs').insert({ job_name: 'daily_income', status: 'failed', details: { error: fetchErr.message } });
    return res.status(500).json({ error: fetchErr.message });
  }

  let paidCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  const failures = [];

  for (const inv of dueInvestments || []) {
    try {
      const newDaysElapsed = Number(inv.days_elapsed) + 1;
      const newTotalIncome = Number(inv.total_income) + Number(inv.daily_income);
      const isComplete = newDaysElapsed >= Number(inv.duration_days);

      // Credit the day's income via a transaction row — same reasoning
      // as everywhere else in this codebase: trg_process_transaction is
      // the only thing that should ever touch wallets.balance. A unique
      // reference per investment per day also gives a second layer of
      // idempotency beyond the last_income_date check above.
      const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
        user_id: inv.user_id,
        type: 'earning',
        amount: Number(inv.daily_income),
        status: 'approved',
        reference: `inv_income_${inv.id}_day${newDaysElapsed}`
      });
      if (txnErr && !txnErr.message.includes('duplicate')) throw txnErr;

      await supabaseAdmin.from('investments').update({
        days_elapsed: newDaysElapsed,
        total_income: newTotalIncome,
        last_income_date: today,
        status: isComplete ? 'completed' : 'active'
      }).eq('id', inv.id);

      paidCount++;
      if (isComplete) completedCount++;
    } catch (err) {
      failedCount++;
      failures.push({ investment_id: inv.id, error: err.message });
    }
  }

  await supabaseAdmin.from('cron_logs').insert({
    job_name: 'daily_income',
    status: failedCount > 0 ? 'partial_failure' : 'success',
    details: { paidCount, completedCount, failedCount, failures, triggeredBy: auth.via }
  });

  return res.status(200).json({ message: 'Daily income processed', paidCount, completedCount, failedCount });
}

async function cronStatus(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('cron_logs').select('*').order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
  
