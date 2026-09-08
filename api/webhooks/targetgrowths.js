/**
 * TargetGrowths Webhook Handler — COMPLETE (deposits + withdrawals)
 *
 * TargetGrowths posts to this SAME url for two different kinds of events:
 *   - Payment IPNs (deposits)      — identifier looked up in `deposits`
 *   - Transfer IPNs (payouts)      — identifier looked up in `withdrawals`
 * (see api/finance.js's initiatePayment call and api/admin.js's
 * initiateTransfer call — both pass the same ipn_url).
 *
 * An earlier pass at this file only ever queried `deposits`, so every
 * withdrawal payout callback 404'd — a failed payout would never trigger
 * its refund, and a successful one would never get marked completed. This
 * version looks up both tables and handles both event types.
 *
 * Other fixes carried over from the deposit-only version:
 *  1. Verifies the webhook signature before trusting anything in the payload.
 *  2. Every status transition is a single, conditional `UPDATE ... WHERE
 *     status = <expected>` — atomic, so concurrent/duplicate webhook
 *     deliveries can't race each other into an inconsistent final state.
 *  3. Wallet credits/refunds are real atomic increments (INSERT ... ON
 *     CONFLICT DO UPDATE SET balance = balance + $amount) via Postgres
 *     functions, not a select-balance-then-write-balance round trip.
 *  4. If a wallet/transaction write fails, the row is NOT marked terminal
 *     and the handler returns 5xx so the gateway retries.
 *
 * Requires deposit-and-withdrawal-webhook-fixes.sql to be applied first:
 *   complete_deposit_and_credit, reject_deposit_safe, mark_deposit_pending_safe,
 *   complete_withdrawal_safe, fail_withdrawal_and_refund.
 */

import supabaseAdmin from '../../lib/supabase.js';
import {
  parseWebhookBody,
  webhookStatus,
  webhookIdentifier,
  webhookAmount,
  isSuccessfulStatus,
  isFailedStatus,
  validWebhookSignature,
} from '../../lib/targetgrowths.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payload;
  try {
    payload = parseWebhookBody(req.body);
  } catch (err) {
    console.error('[TG-WEBHOOK] Failed to parse body:', err);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const status = webhookStatus(payload);
  const identifier = webhookIdentifier(payload);
  const amount = webhookAmount(payload);

  console.log('[TG-WEBHOOK] status:', status, '| identifier:', identifier, '| amount:', amount);

  // --- 1. AUTHENTICATE THE REQUEST FIRST, before touching the DB at all ---
  if (!validWebhookSignature(payload)) {
    console.error('[TG-WEBHOOK] ❌ Invalid or missing signature for identifier:', identifier);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (!identifier) {
    console.error('[TG-WEBHOOK] Missing identifier in payload');
    return res.status(400).json({ error: 'Missing identifier' });
  }

  try {
    // --- 2. FIGURE OUT WHICH KIND OF EVENT THIS IS ---
    const { data: deposit, error: depositLookupErr } = await supabaseAdmin
      .from('deposits')
      .select('id, user_id, amount, status, reference')
      .eq('provider_identifier', identifier)
      .maybeSingle();

    if (depositLookupErr) {
      console.error('[TG-WEBHOOK] Error looking up deposit:', depositLookupErr.message);
      return res.status(500).json({ error: 'Lookup failed, will retry' });
    }

    if (deposit) {
      return await handleDepositWebhook({ deposit, status, identifier, amount, payload, res });
    }

    const { data: withdrawal, error: withdrawalLookupErr } = await supabaseAdmin
      .from('withdrawals')
      .select('id, user_id, amount, net_amount, status, reference')
      .eq('provider_identifier', identifier)
      .maybeSingle();

    if (withdrawalLookupErr) {
      console.error('[TG-WEBHOOK] Error looking up withdrawal:', withdrawalLookupErr.message);
      return res.status(500).json({ error: 'Lookup failed, will retry' });
    }

    if (withdrawal) {
      return await handleWithdrawalWebhook({ withdrawal, status, identifier, payload, res });
    }

    console.error('[TG-WEBHOOK] No deposit or withdrawal found for identifier:', identifier);
    return res.status(404).json({ error: 'No matching deposit or withdrawal for this identifier' });
  } catch (err) {
    console.error('[TG-WEBHOOK] Unhandled error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DEPOSIT (PAYIN) EVENTS
// ==========================================
async function handleDepositWebhook({ deposit, status, identifier, amount, payload, res }) {
  console.log('[TG-WEBHOOK] matched deposit | id:', deposit.id, '| current status:', deposit.status);

  if (deposit.status === 'completed' || deposit.status === 'rejected') {
    console.log(`[TG-WEBHOOK] Deposit ${deposit.id} already terminal (${deposit.status}) — ignoring webhook with status "${status}"`);
    return res.status(200).json({ message: `Already ${deposit.status}` });
  }

  if (isSuccessfulStatus(status)) {
    if (Number(amount) !== Number(deposit.amount)) {
      console.error(`[TG-WEBHOOK] ⚠️ Amount mismatch! Expected: ${deposit.amount}, Got: ${amount}`);
      const { data: rejected, error: rejectErr } = await supabaseAdmin.rpc('reject_deposit_safe', {
        p_deposit_id: deposit.id,
        p_provider_status: 'amount_mismatch',
        p_provider_response: payload,
      });
      if (rejectErr) console.error('[TG-WEBHOOK] Supabase error rejecting mismatched deposit:', rejectErr.message);
      console.log('[TG-WEBHOOK] old status: pending | new status:', rejected ? 'rejected' : '(unchanged — already terminal)');
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    const { data: result, error: creditErr } = await supabaseAdmin.rpc('complete_deposit_and_credit', {
      p_deposit_id: deposit.id,
      p_user_id: deposit.user_id,
      p_amount: Number(deposit.amount),
      p_reference: deposit.reference,
      p_identifier: identifier,
      p_provider_response: payload,
    });

    if (creditErr) {
      console.error('[TG-WEBHOOK] ❌ Supabase error crediting deposit — left as-is for retry:', creditErr.message);
      return res.status(500).json({ error: 'Failed to credit deposit, will retry' });
    }

    const row = Array.isArray(result) ? result[0] : result;
    if (!row?.applied) {
      console.log(`[TG-WEBHOOK] Deposit ${deposit.id} was already resolved by another request — no-op.`);
      return res.status(200).json({ message: 'Already processed' });
    }

    console.log('[TG-WEBHOOK] old status: pending | new status: completed | new balance:', row.new_balance);
    console.log(`[TG-DEPOSIT] ✅ Credited ₦${deposit.amount} to user ${deposit.user_id}`);
    return res.status(200).json({ success: true, new_balance: row.new_balance });
  }

  if (isFailedStatus(status)) {
    const { data: rejected, error: rejectErr } = await supabaseAdmin.rpc('reject_deposit_safe', {
      p_deposit_id: deposit.id,
      p_provider_status: status,
      p_provider_response: payload,
    });
    if (rejectErr) {
      console.error('[TG-WEBHOOK] Supabase error rejecting deposit:', rejectErr.message);
      return res.status(500).json({ error: 'Failed to update deposit, will retry' });
    }
    console.log('[TG-WEBHOOK] old status: pending | new status:', rejected ? 'rejected' : '(unchanged — already terminal)');
    return res.status(200).json({ message: 'Payment failed' });
  }

  console.log('[TG-WEBHOOK] ⏳ Non-terminal deposit status:', status, '- leaving pending');
  const { error: pendingErr } = await supabaseAdmin.rpc('mark_deposit_pending_safe', {
    p_deposit_id: deposit.id,
    p_provider_status: status,
    p_provider_response: payload,
  });
  if (pendingErr) console.error('[TG-WEBHOOK] Supabase error logging pending status:', pendingErr.message);
  return res.status(200).json({ message: 'Payment pending' });
}

// ==========================================
// WITHDRAWAL (PAYOUT) EVENTS
// ==========================================
async function handleWithdrawalWebhook({ withdrawal, status, identifier, payload, res }) {
  console.log('[TG-WEBHOOK] matched withdrawal | id:', withdrawal.id, '| current status:', withdrawal.status);

  if (['completed', 'failed', 'rejected'].includes(withdrawal.status)) {
    console.log(`[TG-WEBHOOK] Withdrawal ${withdrawal.id} already terminal (${withdrawal.status}) — ignoring webhook with status "${status}"`);
    return res.status(200).json({ message: `Already ${withdrawal.status}` });
  }

  if (withdrawal.status !== 'approved') {
    // A payout webhook for a withdrawal that was never actually sent to the
    // provider (still 'pending', i.e. admin hasn't approved it yet) should
    // never happen — log it loudly rather than silently ignoring, since it
    // means the provider is confused about which transaction this is.
    console.error(`[TG-WEBHOOK] ⚠️ Payout webhook received for withdrawal ${withdrawal.id} which is in unexpected status "${withdrawal.status}" (expected 'approved') — ignoring.`);
    return res.status(200).json({ message: `Unexpected withdrawal status: ${withdrawal.status}` });
  }

  if (isSuccessfulStatus(status)) {
    const { data: applied, error: completeErr } = await supabaseAdmin.rpc('complete_withdrawal_safe', {
      p_withdrawal_id: withdrawal.id,
      p_provider_response: payload,
    });

    if (completeErr) {
      console.error('[TG-WEBHOOK] ❌ Supabase error completing withdrawal — left as-is for retry:', completeErr.message);
      return res.status(500).json({ error: 'Failed to complete withdrawal, will retry' });
    }
    if (!applied) {
      console.log(`[TG-WEBHOOK] Withdrawal ${withdrawal.id} was already resolved by another request — no-op.`);
      return res.status(200).json({ message: 'Already processed' });
    }

    console.log('[TG-WEBHOOK] old status: approved | new status: completed');
    console.log(`[TG-WITHDRAWAL] ✅ Payout confirmed for ${identifier}`);
    return res.status(200).json({ success: true });
  }

  if (isFailedStatus(status)) {
    const { data: result, error: refundErr } = await supabaseAdmin.rpc('fail_withdrawal_and_refund', {
      p_withdrawal_id: withdrawal.id,
      p_user_id: withdrawal.user_id,
      p_amount: Number(withdrawal.net_amount || withdrawal.amount),
      p_reference: withdrawal.reference,
      p_provider_response: payload,
    });

    if (refundErr) {
      // Deliberately does NOT mark failed if this errors — the money is
      // still deducted from the user and we need a clean retry, not a
      // "failed but never refunded" state.
      console.error('[TG-WEBHOOK] ❌ Supabase error refunding failed withdrawal — left as-is for retry:', refundErr.message);
      return res.status(500).json({ error: 'Failed to refund withdrawal, will retry' });
    }

    const row = Array.isArray(result) ? result[0] : result;
    if (!row?.applied) {
      console.log(`[TG-WEBHOOK] Withdrawal ${withdrawal.id} was already resolved by another request — no-op.`);
      return res.status(200).json({ message: 'Already processed' });
    }

    console.log('[TG-WEBHOOK] old status: approved | new status: failed | refunded, new balance:', row.new_balance);
    console.log(`[TG-WITHDRAWAL] ❌ Payout failed for ${identifier} — refunded to user ${withdrawal.user_id}`);
    return res.status(200).json({ message: 'Payout failed, refunded' });
  }

  console.log('[TG-WEBHOOK] ⏳ Non-terminal withdrawal status:', status, '- leaving approved, awaiting final callback');
  return res.status(200).json({ message: 'Payout pending' });
}
