/**
 * Task-based VIP tier system.
 * Actions: myStatus, startTask, claimTask, upgradeTier, taskHistory
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'myStatus': return await myStatus(req, res);
      case 'startTask': return await startTask(req, res);
      case 'claimTask': return await claimTask(req, res);
      case 'upgradeTier': return await upgradeTier(req, res);
      case 'taskHistory': return await taskHistory(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Tasks run Monday-Saturday only, any time of day — computed in WAT
// (UTC+1, no DST), same convention as the withdrawal-hours check.
function isTaskDayOpen() {
  const now = new Date();
  const watDay = new Date(now.getTime() + 60 * 60 * 1000).getUTCDay(); // 0=Sun..6=Sat
  return watDay !== 0;
}

function startOfTodayWAT() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  wat.setUTCHours(0, 0, 0, 0);
  return new Date(wat.getTime() - 60 * 60 * 1000); // back to UTC for the DB comparison
}

async function getUserTierInfo(userId) {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('task_tier, newbie_expires_at')
    .eq('id', userId)
    .single();

  const { data: allTiers } = await supabaseAdmin.from('task_tiers').select('*').order('sort_order', { ascending: true });
  const tier = allTiers.find(t => t.key === profile.task_tier) || allTiers.find(t => t.key === 'newbie');

  const newbieExpired = profile.task_tier === 'newbie' && new Date(profile.newbie_expires_at) < new Date();

  return { profile, tier, allTiers, newbieExpired };
}

async function myStatus(req, res) {
  const user = await verifyUser(req);
  const { profile, tier, allTiers, newbieExpired } = await getUserTierInfo(user.id);

  const todayStart = startOfTodayWAT();
  const { count: doneToday } = await supabaseAdmin
    .from('task_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('claimed', true)
    .gte('started_at', todayStart.toISOString());

  const nextTier = allTiers.find(t => t.sort_order === tier.sort_order + 1) || null;
  const upgradeCost = nextTier ? Number(nextTier.price) - Number(tier.price) : null;

  return res.status(200).json({
    currentTier: tier,
    nextTier,
    upgradeCost,
    tasksDoneToday: doneToday || 0,
    tasksRemainingToday: Math.max(0, tier.tasks_per_day - (doneToday || 0)),
    newbieExpired,
    newbieExpiresAt: profile.newbie_expires_at,
    canDoTasksToday: isTaskDayOpen() && !newbieExpired,
    canReferOrWithdraw: profile.task_tier !== 'newbie'
  });
}

async function startTask(req, res) {
  const user = await verifyUser(req);
  const { product_name } = req.body;
  if (!product_name) return res.status(400).json({ error: 'product_name is required' });

  if (!isTaskDayOpen()) return res.status(400).json({ error: 'Tasks are not available on Sundays.' });

  const { profile, tier, newbieExpired } = await getUserTierInfo(user.id);
  if (newbieExpired) return res.status(400).json({ error: 'Your free Newbie period has ended. Upgrade to a VIP tier to continue.' });

  const todayStart = startOfTodayWAT();
  const { count: doneToday } = await supabaseAdmin
    .from('task_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('claimed', true)
    .gte('started_at', todayStart.toISOString());

  if ((doneToday || 0) >= tier.tasks_per_day) {
    return res.status(400).json({ error: `You've completed all ${tier.tasks_per_day} tasks for today. Come back tomorrow.` });
  }

  const { data: session, error } = await supabaseAdmin.from('task_sessions').insert({
    user_id: user.id,
    product_name,
    amount: tier.pay_per_task,
    started_at: new Date()
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  return res.status(200).json({ session_id: session.id, amount: session.amount, waitSeconds: 5 });
}

async function claimTask(req, res) {
  const user = await verifyUser(req);
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const { data: session } = await supabaseAdmin.from('task_sessions').select('*').eq('id', session_id).eq('user_id', user.id).single();
  if (!session) return res.status(404).json({ error: 'Task session not found' });
  if (session.claimed) return res.status(400).json({ error: 'This task has already been claimed' });

  const elapsedMs = Date.now() - new Date(session.started_at).getTime();
  if (elapsedMs < 5000) {
    return res.status(400).json({ error: `Please wait ${Math.ceil((5000 - elapsedMs) / 1000)} more second(s).` });
  }

  // Credit via a transaction row (type: 'earning' — already a
  // recognized credit type in trg_process_transaction), never a direct
  // wallet update. Reference is unique per session, so this can't
  // double-credit even if called twice.
  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'earning',
    amount: session.amount,
    status: 'approved',
    reference: `task_${session.id}`
  });
  if (txnErr && !txnErr.message.includes('duplicate')) {
    return res.status(500).json({ error: txnErr.message });
  }

  await supabaseAdmin.from('task_sessions').update({ claimed: true, claimed_at: new Date() }).eq('id', session.id);

  return res.status(200).json({ message: 'Task claimed', amount: session.amount });
}

/**
 * One-time payment: cost = nextTier.price - currentTier.price. Only
 * the immediate next tier is allowed (sequential upgrades, no skipping).
 * Debited via a direct atomic conditional UPDATE rather than a
 * transaction row with status 'approved' — 'task_tier_upgrade' isn't a
 * type trg_process_transaction recognizes, so relying on it here would
 * silently NOT debit the wallet (the same lesson learned from the
 * Welfare-claim flow). The audit record below is intentionally NOT
 * status 'approved', so it can never accidentally trigger it either.
 */
async function upgradeTier(req, res) {
  const user = await verifyUser(req);
  const { profile, tier, allTiers } = await getUserTierInfo(user.id);

  const nextTier = allTiers.find(t => t.sort_order === tier.sort_order + 1);
  if (!nextTier) return res.status(400).json({ error: 'You are already at the highest tier.' });

  const cost = Number(nextTier.price) - Number(tier.price);

  // Conditional debit via optimistic concurrency: read balance, verify
  // it's sufficient, then update WHERE balance still matches what we
  // read — this prevents a race where two simultaneous upgrade
  // requests both pass the balance check and both succeed.
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet || Number(wallet.balance) < cost) {
    return res.status(400).json({ error: 'Insufficient balance for this upgrade.' });
  }

  const { data: debitResult, error: debitError } = await supabaseAdmin
    .from('wallets')
    .update({ balance: Number(wallet.balance) - cost, updated_at: new Date() })
    .eq('user_id', user.id)
    .eq('balance', wallet.balance) // only succeeds if balance hasn't changed since we read it
    .select();

  if (debitError || !debitResult || debitResult.length === 0) {
    return res.status(409).json({ error: 'Balance changed — please try again.' });
  }

  await supabaseAdmin.from('profiles').update({ task_tier: nextTier.key }).eq('id', user.id);

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'task_tier_upgrade',
    amount: cost,
    status: 'paid', // deliberately not 'approved' — see function comment
    reference: `tierup_${user.id}_${nextTier.key}_${Date.now()}`,
    meta: { from: tier.key, to: nextTier.key }
  });

  try {
    await sendTelegramMessage(`⬆️ *Tier Upgrade*\nUser: \`${user.id}\`\n${tier.name} → ${nextTier.name}\nPaid: ₦${cost}`);
  } catch (e) { console.error('Telegram notify failed (upgrade still succeeded):', e.message); }

  return res.status(200).json({ message: `Upgraded to ${nextTier.name}`, tier: nextTier });
}

async function taskHistory(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin
    .from('task_sessions')
    .select('*')
    .eq('user_id', user.id)
    .eq('claimed', true)
    .order('claimed_at', { ascending: false })
    .limit(100);
  return res.status(200).json(data || []);
}
