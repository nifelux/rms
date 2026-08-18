import supabaseAdmin from '../lib/supabase.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  // Support actions sent via URL query (?action=...) or request body ({ action: '...' })
  const action = req.query.action || req.body?.action;

  try {
    switch (action) {
      case 'getAdminWithdrawals':
      case 'withdrawalsList':
        return await getAdminWithdrawals(req, res);
      case 'getAdminDeposits':
      case 'depositsList':
        return await getAdminDeposits(req, res);
      case 'approveWithdrawal':
        return await approveWithdrawal(req, res);
      case 'rejectWithdrawal':
        return await rejectWithdrawal(req, res);
      case 'approveDeposit':
        return await approveDeposit(req, res);
      case 'rejectDeposit':
        return await rejectDeposit(req, res);
      case 'kycList':
        return await kycList(req, res);
      case 'approveKYC':
        return await approveKYC(req, res);
      case 'rejectKYC':
        return await rejectKYC(req, res);
      // Gift codes
      case 'giftCodesList':
        return await giftCodesList(req, res);
      case 'createGiftCode':
        return await createGiftCode(req, res);
      case 'toggleGiftCode':
        return await toggleGiftCode(req, res);
      // Logs
      case 'activityLogs':
      case 'auditLogs':
        return await activityLogs(req, res);
      // Users
      case 'users':
        return await listUsers(req, res);
      case 'userDetail':
        return await getUserDetail(req, res);
      case 'getUserTeam':
        return await getUserTeam(req, res);
      case 'freezeUser':
        return await freezeUser(req, res, true);
      case 'unfreezeUser':
        return await freezeUser(req, res, false);
      case 'banUser':
        return await banUser(req, res, true);
      case 'unbanUser':
        return await banUser(req, res, false);
      case 'creditWallet':
        return await creditWallet(req, res);
      case 'debitWallet':
        return await debitWallet(req, res);
      // Stats / reports
      case 'stats':
        return await getStats(req, res);
      case 'exportCSV':
        return await exportCSV(req, res);
      // Settings (generic key/value — backs 9 different editor pages)
      case 'settingsGet':
        return await settingsGet(req, res);
      case 'settingsUpdate':
        return await settingsUpdate(req, res);
      case 'maintenanceMode':
        return await maintenanceMode(req, res);
      // Roles
      case 'listAdmins':
        return await listAdmins(req, res);
      case 'promoteAdmin':
        return await promoteAdmin(req, res);
      case 'demoteAdmin':
        return await demoteAdmin(req, res);
      // System health / telegram
      case 'systemHealth':
        return await systemHealth(req, res);
      case 'telegramLogs':
        return await telegramLogs(req, res);
      // Notifications (admin-wide view)
      case 'allNotifications':
        return await allNotifications(req, res);
      // VIP levels
      case 'createVipLevel':
        return await createVipLevel(req, res);
      // Task tiers (new task-based system)
      case 'taskTiersList':
        return await taskTiersList(req, res);
      case 'updateTaskTier':
        return await updateTaskTier(req, res);
      default:
        return res.status(400).json({ error: `Invalid or missing admin action: '${action}'` });
    }
  } catch (err) {
    console.error('Admin API Handler Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

/**
 * Get List of Withdrawals for Admin
 */
async function getAdminWithdrawals(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { status } = req.query;
  let query = supabaseAdmin
    .from('withdrawals')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data: withdrawals, error } = await query;
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ withdrawals });
}

/**
 * Get List of Deposits for Admin
 */
async function getAdminDeposits(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { status } = req.query;
  let query = supabaseAdmin
    .from('deposits')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data: deposits, error } = await query;
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ deposits });
}

/**
 * Approve Pending Withdrawal
 */
/**
 * Core logic for all four approve/reject actions, extracted so both
 * this file's HTTP handlers AND the Telegram bot's inline-button
 * callbacks (see api/notification.js) call the exact same code path —
 * no duplicated business logic to let drift out of sync.
 * Returns { ok, message } on success or { ok: false, error } on failure;
 * never touches req/res directly so it works from either caller.
 */
export async function approveWithdrawalCore(withdrawal_id, admin_notes) {
  if (!withdrawal_id) return { ok: false, error: 'Withdrawal ID is required' };

  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!wd || wd.status !== 'pending') {
    return { ok: false, error: 'Withdrawal record not found or already processed' };
  }

  const { error: wdErr } = await supabaseAdmin
    .from('withdrawals')
    .update({ status: 'approved', admin_notes: admin_notes || null, updated_at: new Date() })
    .eq('id', withdrawal_id);
  if (wdErr) return { ok: false, error: 'Failed to update withdrawal status' };

  const { data: existingTxn } = await supabaseAdmin.from('transactions').select('id').eq('reference', `wd_${wd.id}`).maybeSingle();
  if (existingTxn) {
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${wd.id}`);
  } else {
    console.warn(`No transaction found for withdrawal ${wd.id} — creating one directly.`);
    const { error: txnInsertErr } = await supabaseAdmin.from('transactions').insert({
      user_id: wd.user_id, type: 'withdrawal', amount: wd.amount, status: 'approved', reference: `wd_${wd.id}`
    });
    if (txnInsertErr) return { ok: false, error: `Withdrawal marked approved but wallet debit failed: ${txnInsertErr.message}` };
  }

  await sendTelegramMessage(`✅ *Withdrawal Approved*\nID: \`${wd.id}\`\nAmount: ₦${wd.amount}\nUser ID: \`${wd.user_id}\``);
  return { ok: true, message: 'Withdrawal approved successfully', record: wd };
}

export async function rejectWithdrawalCore(withdrawal_id, admin_notes) {
  if (!withdrawal_id) return { ok: false, error: 'Withdrawal ID is required' };

  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!wd || wd.status !== 'pending') {
    return { ok: false, error: 'Withdrawal record not found or already processed' };
  }

  const { error: wdErr } = await supabaseAdmin
    .from('withdrawals')
    .update({ status: 'rejected', admin_notes: admin_notes || null, updated_at: new Date() })
    .eq('id', withdrawal_id);
  if (wdErr) return { ok: false, error: 'Failed to update withdrawal status' };

  await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `wd_${wd.id}`);

  // No refund needed — the wallet was never debited at request time.
  // trg_process_transaction only debits balance once the linked
  // transaction is marked 'approved', which never happens here.

  await sendTelegramMessage(`❌ *Withdrawal Rejected & Refunded*\nID: \`${wd.id}\`\nAmount: ₦${wd.amount}\nReason: ${admin_notes || 'N/A'}`);
  return { ok: true, message: 'Withdrawal rejected and funds refunded', record: wd };
}

const REFERRAL_FIRST_DEPOSIT_BONUS_PERCENT = 10;

/**
 * Credits the referrer 10% of a depositor's FIRST-EVER approved deposit
 * only. Silently does nothing if the depositor wasn't referred, or if
 * this isn't their first approved deposit.
 *
 * Credits via a direct transaction INSERT with status already
 * 'approved' (type: 'referral') — process_transaction() already
 * recognizes 'referral' as a credit type, and firing on INSERT (not an
 * update from pending) means it fires exactly once. The reference is
 * scoped to this specific deposit, so even if this function were ever
 * called twice for the same deposit, the second insert would fail on
 * the unique constraint rather than double-crediting.
 */
async function maybeCreditReferralBonus(deposit) {
  const { data: depositorProfile } = await supabaseAdmin
    .from('profiles')
    .select('referred_by')
    .eq('id', deposit.user_id)
    .single();

  const referrerId = depositorProfile?.referred_by;
  if (!referrerId || referrerId === deposit.user_id) return; // not referred (or a data anomaly)

  const { count: priorApprovedDeposits } = await supabaseAdmin
    .from('deposits')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', deposit.user_id)
    .eq('status', 'approved')
    .neq('id', deposit.id);

  if ((priorApprovedDeposits || 0) > 0) return; // not their first deposit

  const rewardAmount = Number(deposit.amount) * (REFERRAL_FIRST_DEPOSIT_BONUS_PERCENT / 100);

  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: referrerId,
    type: 'referral',
    amount: rewardAmount,
    status: 'approved',
    reference: `refbonus_dep_${deposit.id}`
  });
  if (txnErr) {
    if (!txnErr.message.includes('duplicate')) console.error('Referral bonus credit failed:', txnErr.message);
    return;
  }

  await supabaseAdmin.from('referral_rewards').insert({
    referrer_id: referrerId,
    referred_user_id: deposit.user_id,
    level: 1,
    reward_percent: REFERRAL_FIRST_DEPOSIT_BONUS_PERCENT,
    reward_amount: rewardAmount,
    transaction_type: 'deposit',
    reference_id: deposit.id
  });

  await sendTelegramMessage(`🎉 *Referral Bonus Paid*\nReferrer: \`${referrerId}\`\nAmount: ₦${rewardAmount}\n(10% of referred user's first deposit, ₦${deposit.amount})`);
}

export async function approveDepositCore(deposit_id, admin_notes) {
  if (!deposit_id) return { ok: false, error: 'Deposit ID is required' };

  const { data: deposit } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!deposit || deposit.status !== 'pending') {
    return { ok: false, error: 'Deposit record not found or already processed' };
  }

  const { error: depErr } = await supabaseAdmin
    .from('deposits')
    .update({ status: 'approved', admin_notes: admin_notes || null, updated_at: new Date() })
    .eq('id', deposit_id);
  if (depErr) return { ok: false, error: 'Failed to update deposit status' };

  const { data: existingTxn } = await supabaseAdmin.from('transactions').select('id').eq('reference', `dp_${deposit.id}`).maybeSingle();
  if (existingTxn) {
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `dp_${deposit.id}`);
  } else {
    console.warn(`No transaction found for deposit ${deposit.id} — creating one directly.`);
    const { error: txnInsertErr } = await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id, type: 'deposit', amount: deposit.amount, status: 'approved', reference: `dp_${deposit.id}`
    });
    if (txnInsertErr) return { ok: false, error: `Deposit marked approved but wallet credit failed: ${txnInsertErr.message}` };
  }

  await maybeCreditReferralBonus(deposit);

  await sendTelegramMessage(`✅ *Deposit Approved & Credited*\nID: \`${deposit.id}\`\nAmount: ₦${deposit.amount}\nUser ID: \`${deposit.user_id}\``);
  return { ok: true, message: 'Deposit approved and wallet credited successfully', record: deposit };
}

export async function rejectDepositCore(deposit_id, admin_notes) {
  if (!deposit_id) return { ok: false, error: 'Deposit ID is required' };

  const { data: deposit } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!deposit || deposit.status !== 'pending') {
    return { ok: false, error: 'Deposit record not found or already processed' };
  }

  const { error: depErr } = await supabaseAdmin
    .from('deposits')
    .update({ status: 'rejected', admin_notes: admin_notes || null, updated_at: new Date() })
    .eq('id', deposit_id);
  if (depErr) return { ok: false, error: 'Failed to update deposit status' };

  await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `dp_${deposit.id}`);

  await sendTelegramMessage(`❌ *Deposit Rejected*\nID: \`${deposit.id}\`\nAmount: ₦${deposit.amount}\nReason: ${admin_notes || 'N/A'}`);
  return { ok: true, message: 'Deposit rejected successfully', record: deposit };
}

/* ---- Thin HTTP wrappers used by the admin panel (unchanged behavior) ---- */

async function approveWithdrawal(req, res) {
  await verifyAdmin(req);
  const result = await approveWithdrawalCore(req.body.withdrawal_id, req.body.admin_notes);
  return res.status(result.ok ? 200 : 400).json(result.ok ? { message: result.message } : { error: result.error });
}

async function rejectWithdrawal(req, res) {
  await verifyAdmin(req);
  const result = await rejectWithdrawalCore(req.body.withdrawal_id, req.body.admin_notes);
  return res.status(result.ok ? 200 : 400).json(result.ok ? { message: result.message } : { error: result.error });
}

async function approveDeposit(req, res) {
  await verifyAdmin(req);
  const result = await approveDepositCore(req.body.deposit_id, req.body.admin_notes);
  return res.status(result.ok ? 200 : 400).json(result.ok ? { message: result.message } : { error: result.error });
}

async function rejectDeposit(req, res) {
  await verifyAdmin(req);
  const result = await rejectDepositCore(req.body.deposit_id, req.body.admin_notes);
  return res.status(result.ok ? 200 : 400).json(result.ok ? { message: result.message } : { error: result.error });
}

/**
 * List all KYC documents for admin review, with each private storage
 * path resolved to a short-lived signed URL (service_role — the bucket
 * itself has no public access).
 */
async function kycList(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { data: docs, error } = await supabaseAdmin
    .from('kyc_documents')
    .select('*, profiles(email)')
    .order('submitted_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const withSignedUrls = await Promise.all(
    (docs || []).map(async (doc) => {
      const { data: signed } = await supabaseAdmin.storage
        .from('kyc')
        .createSignedUrl(doc.image_url, 300); // 5 minutes
      return { ...doc, signedUrl: signed?.signedUrl || null };
    })
  );

  return res.status(200).json(withSignedUrls);
}

/**
 * Approve a KYC document and mark the user's profile verified.
 */
async function approveKYC(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const { data: doc, error: fetchErr } = await supabaseAdmin
    .from('kyc_documents')
    .select('user_id')
    .eq('id', id)
    .single();
  if (fetchErr || !doc) return res.status(404).json({ error: 'Document not found' });

  const { error: docErr } = await supabaseAdmin
    .from('kyc_documents')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (docErr) return res.status(500).json({ error: docErr.message });

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ kyc_status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', doc.user_id);
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  await sendTelegramMessage(
    `✅ *KYC Approved*\n` +
    `Document: \`${id}\`\n` +
    `User ID: \`${doc.user_id}\``
  );

  return res.status(200).json({ message: 'KYC approved' });
}

/**
 * Reject a KYC document with a reason shown to the user.
 */
async function rejectKYC(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { id, reason } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const { data: doc, error: fetchErr } = await supabaseAdmin
    .from('kyc_documents')
    .select('user_id')
    .eq('id', id)
    .single();
  if (fetchErr || !doc) return res.status(404).json({ error: 'Document not found' });

  const { error: docErr } = await supabaseAdmin
    .from('kyc_documents')
    .update({
      status: 'rejected',
      admin_notes: reason || null,
      reviewed_at: new Date().toISOString()
    })
    .eq('id', id);
  if (docErr) return res.status(500).json({ error: docErr.message });

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ kyc_status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', doc.user_id);
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  await sendTelegramMessage(
    `❌ *KYC Rejected*\n` +
    `Document: \`${id}\`\n` +
    `User ID: \`${doc.user_id}\`\n` +
    `Reason: ${reason || 'N/A'}`
  );

  return res.status(200).json({ message: 'KYC rejected' });
}

/* ============================================================
   GIFT CODES
   ============================================================ */
async function giftCodesList(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('gift_codes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

/**
 * Core logic, extracted so the Telegram bot (/giftcode) can call this
 * directly in-process — same reasoning as the approve/reject and purge
 * refactors: one code path, no HTTP self-call, no duplicated logic.
 */
export async function createGiftCodeCore(code, amount, max_uses) {
  if (!code || !amount) return { ok: false, error: 'Code and amount are required' };

  const { data, error } = await supabaseAdmin.from('gift_codes').insert({
    code: code.trim().toUpperCase(),
    amount: Number(amount),
    max_uses: Number(max_uses) || 1,
    current_uses: 0,
    is_active: true
  }).select().single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, record: data };
}

function generateRandomGiftCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to misread
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
export { generateRandomGiftCode };

async function createGiftCode(req, res) {
  await verifyAdmin(req);
  const { code, amount, max_uses } = req.body;
  const result = await createGiftCodeCore(code, amount, max_uses);
  return res.status(result.ok ? 200 : 400).json(result.ok ? result.record : { error: result.error });
}

async function toggleGiftCode(req, res) {
  await verifyAdmin(req);
  const { id } = req.body;
  const { data: code } = await supabaseAdmin.from('gift_codes').select('is_active').eq('id', id).single();
  if (!code) return res.status(404).json({ error: 'Gift code not found' });
  await supabaseAdmin.from('gift_codes').update({ is_active: !code.is_active }).eq('id', id);
  return res.status(200).json({ message: `Gift code ${code.is_active ? 'deactivated' : 'reactivated'}` });
}

/* ============================================================
   LOGS
   ============================================================ */
// Both "Activity" and "Audit" log views in the admin UI currently read
// from the same activity_logs table — there is only one log table in
// the system today, so this intentionally serves both.
async function activityLogs(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin
    .from('activity_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

/* ============================================================
   USERS
   ============================================================ */
async function listUsers(req, res) {
  await verifyAdmin(req);
  const page = Number(req.query.page) || 0;
  const limit = Number(req.query.limit) || 15;
  const search = (req.query.search || '').trim();

  let query = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, vip_level, is_banned, is_frozen, wallets(balance)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ data, count });
}

/**
 * Everything an admin needs to see about one user, in a single call —
 * profile, wallet, and their full activity across every feature. This
 * is READ-ONLY: it does not let the admin act as the user, only view
 * their account exactly as they'd see it themselves.
 */
async function getUserDetail(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const [profile, wallet, transactions, investments, welfare, deposits, withdrawals, tasks, referrals, notifications] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', user_id).single(),
    supabaseAdmin.from('wallets').select('*').eq('user_id', user_id).single(),
    supabaseAdmin.from('transactions').select('*').eq('user_id', user_id).order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('investments').select('*, products(name)').eq('user_id', user_id).order('created_at', { ascending: false }),
    supabaseAdmin.from('welfare_investments').select('*').eq('user_id', user_id).order('created_at', { ascending: false }),
    supabaseAdmin.from('deposits').select('*').eq('user_id', user_id).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('task_sessions').select('*').eq('user_id', user_id).order('started_at', { ascending: false }).limit(50),
    supabaseAdmin.from('profiles').select('id, full_name, email, created_at').eq('referred_by', user_id).order('created_at', { ascending: false }),
    supabaseAdmin.from('notifications').select('*').eq('user_id', user_id).order('created_at', { ascending: false }).limit(30)
  ]);

  if (profile.error || !profile.data) return res.status(404).json({ error: 'User not found' });

  return res.status(200).json({
    profile: profile.data,
    wallet: wallet.data || null,
    transactions: transactions.data || [],
    investments: investments.data || [],
    welfare: welfare.data || [],
    deposits: deposits.data || [],
    withdrawals: withdrawals.data || [],
    tasks: tasks.data || [],
    referrals: referrals.data || [],
    notifications: notifications.data || []
  });
}

/**
 * Admin-side equivalent of what referral.html shows a user about their
 * own team — their direct referrals, with the same active/inactive
 * definition (active = at least one approved deposit).
 */
async function getUserTeam(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const { data: direct, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, created_at')
    .eq('referred_by', user_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const referralIds = (direct || []).map(d => d.id);
  let activeIds = [];
  if (referralIds.length > 0) {
    const { data: activeDeposits } = await supabaseAdmin
      .from('deposits')
      .select('user_id')
      .eq('status', 'approved')
      .in('user_id', referralIds);
    activeIds = [...new Set((activeDeposits || []).map(d => d.user_id))];
  }

  const team = (direct || []).map(d => ({ ...d, is_active: activeIds.includes(d.id) }));
  return res.status(200).json({
    team,
    totalCount: team.length,
    activeCount: activeIds.length
  });
}

async function freezeUser(req, res, freeze) {
  const admin = await verifyAdmin(req);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  await supabaseAdmin.from('profiles').update({ is_frozen: freeze }).eq('id', user_id);
  await supabaseAdmin.from('activity_logs').insert({
    user_id: admin.id, action: freeze ? 'admin_freeze_user' : 'admin_unfreeze_user', details: { target_user: user_id }
  });
  return res.status(200).json({ message: `User ${freeze ? 'frozen' : 'unfrozen'}` });
}

async function banUser(req, res, ban) {
  const admin = await verifyAdmin(req);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  await supabaseAdmin.from('profiles').update({ is_banned: ban }).eq('id', user_id);
  await supabaseAdmin.from('activity_logs').insert({
    user_id: admin.id, action: ban ? 'admin_ban_user' : 'admin_unban_user', details: { target_user: user_id }
  });
  return res.status(200).json({ message: `User ${ban ? 'banned' : 'unbanned'}` });
}

// Credit/debit go through a real transaction row (type: 'admin_credit' /
// 'admin_debit', status: 'approved') so trg_process_transaction is the
// one thing that ever touches wallets.balance — same reasoning as the
// double-debit fix elsewhere in this codebase. Never update the wallet
// balance directly here.
async function creditWallet(req, res) {
  const admin = await verifyAdmin(req);
  const { user_id, amount, note } = req.body;
  if (!user_id || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'user_id and a positive amount are required' });

  const { error } = await supabaseAdmin.from('transactions').insert({
    user_id, type: 'admin_credit', amount: Number(amount), status: 'approved',
    reference: `admincr_${Date.now()}_${user_id.substring(0, 8)}`,
    meta: { note: note || null, admin_id: admin.id }
  });
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ message: 'Wallet credited' });
}

async function debitWallet(req, res) {
  const admin = await verifyAdmin(req);
  const { user_id, amount, note } = req.body;
  if (!user_id || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'user_id and a positive amount are required' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user_id).single();
  if (!wallet || Number(wallet.balance) < Number(amount)) {
    return res.status(400).json({ error: 'User has insufficient balance for this debit' });
  }

  const { error } = await supabaseAdmin.from('transactions').insert({
    user_id, type: 'admin_debit', amount: Number(amount), status: 'approved',
    reference: `admindb_${Date.now()}_${user_id.substring(0, 8)}`,
    meta: { note: note || null, admin_id: admin.id }
  });
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ message: 'Wallet debited' });
}

/* ============================================================
   STATS / REPORTS
   ============================================================ */
async function getStats(req, res) {
  await verifyAdmin(req);
  const [users, deposits, withdrawals, investments] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('investments').select('amount, status')
  ]);

  const totalDeposits = (deposits.data || []).reduce((s, d) => s + Number(d.amount), 0);
  const totalWithdrawals = (withdrawals.data || []).reduce((s, w) => s + Number(w.amount), 0);
  const investmentRows = investments.data || [];
  const totalInvestments = investmentRows.reduce((s, i) => s + Number(i.amount), 0);
  const activeInvestments = investmentRows.filter(i => i.status === 'active').length;

  return res.status(200).json({
    totalUsers: users.count || 0,
    totalDeposits,
    totalWithdrawals,
    totalInvestments,
    activeInvestments
  });
}

// Simple CSV export for the four tables Reports links to. Streams a
// flat CSV of whatever columns come back from a plain select — good
// enough for an admin download, not meant to be a general-purpose
// report builder.
async function exportCSV(req, res) {
  await verifyAdmin(req);
  const { table } = req.query;
  const allowedTables = ['transactions', 'deposits', 'withdrawals', 'users'];
  if (!allowedTables.includes(table)) return res.status(400).json({ error: 'Invalid table' });

  const sourceTable = table === 'users' ? 'profiles' : table;
  const { data, error } = await supabaseAdmin.from(sourceTable).select('*').order('created_at', { ascending: false }).limit(5000);
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    return res.status(200).send('');
  }

  const headers = Object.keys(data[0]);
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...data.map(row => headers.map(h => escapeCsv(row[h])).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
  return res.status(200).send(csv);
}

/* ============================================================
   SETTINGS (generic key/value — backs 9 different editor pages)
   ============================================================ */
async function settingsGet(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('settings').select('*');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

async function settingsUpdate(req, res) {
  await verifyAdmin(req);
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });

  const { error } = await supabaseAdmin.from('settings').upsert({ key, value, updated_at: new Date() });
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ message: 'Setting saved' });
}

// Stored as the literal string 'true'/'false' (not a JSON boolean) to
// match what settings.html and maintenance.html already check for
// (`mm === 'true'`) — changing the representation would silently break
// both pages' maintenance-mode toggle display.
async function maintenanceMode(req, res) {
  await verifyAdmin(req);
  const { enabled } = req.body;
  const { error } = await supabaseAdmin.from('settings').upsert({
    key: 'maintenance_mode', value: enabled ? 'true' : 'false', updated_at: new Date()
  });
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}` });
}

/* ============================================================
   ROLES
   ============================================================ */
async function listAdmins(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('profiles').select('id, email, full_name').eq('is_admin', true);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

async function promoteAdmin(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const { data: target } = await supabaseAdmin.from('profiles').select('id').eq('id', user_id).single();
  if (!target) return res.status(404).json({ error: 'No user found with that ID' });

  await supabaseAdmin.from('profiles').update({ is_admin: true }).eq('id', user_id);
  return res.status(200).json({ message: 'User promoted to admin' });
}

async function demoteAdmin(req, res) {
  const admin = await verifyAdmin(req);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  // Guard against an admin locking themselves (and everyone else) out
  // by demoting the last remaining admin account.
  if (user_id === admin.id) {
    const { count } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('is_admin', true);
    if ((count || 0) <= 1) return res.status(400).json({ error: 'Cannot remove the last remaining admin' });
  }
  await supabaseAdmin.from('profiles').update({ is_admin: false }).eq('id', user_id);
  return res.status(200).json({ message: 'Admin access removed' });
}

/* ============================================================
   SYSTEM HEALTH / TELEGRAM
   ============================================================ */
async function systemHealth(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('cron_logs').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ dbOk: true, lastCron: data?.[0] || null });
}

async function telegramLogs(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('telegram_logs').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

/* ============================================================
   NOTIFICATIONS (admin-wide view)
   ============================================================ */
async function allNotifications(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .select('*, profiles(email)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

/* ============================================================
   VIP LEVELS
   ============================================================ */
async function createVipLevel(req, res) {
  await verifyAdmin(req);
  const { level, min_deposit, min_investments, min_referrals, daily_bonus_percent } = req.body;
  if (!level) return res.status(400).json({ error: 'level is required' });

  const { data, error } = await supabaseAdmin.from('vip_levels').insert({
    level, min_deposit: Number(min_deposit) || 0, min_investments: Number(min_investments) || 0,
    min_referrals: Number(min_referrals) || 0, daily_bonus_percent: Number(daily_bonus_percent) || 0
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json(data);
}

/* ============================================================
   TASK TIERS (Newbie + VIP1-6 — the task-based earning system)
   ============================================================ */
async function taskTiersList(req, res) {
  await verifyAdmin(req);
  const { data, error } = await supabaseAdmin.from('task_tiers').select('*').order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

// Price/tasks_per_day/pay_per_task are editable; key/sort_order are
// not — changing sequence would silently break the "next tier"
// upgrade logic in task.js, which relies on sort_order being stable.
async function updateTaskTier(req, res) {
  await verifyAdmin(req);
  const { id, price, tasks_per_day, pay_per_task } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { data, error } = await supabaseAdmin
    .from('task_tiers')
    .update({
      price: Number(price),
      tasks_per_day: Number(tasks_per_day),
      pay_per_task: Number(pay_per_task)
    })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json(data);
}
