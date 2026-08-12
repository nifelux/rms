// api/withdraw-payout.js
//
// Handles BOTH sides of a Nekpay disbursement from one file:
//
//   POST /api/withdraw-payout               → admin trigger (send an
//                                              already-approved withdrawal
//                                              to Nekpay)
//   POST /api/withdraw-payout?event=notify   → Nekpay's async callback
//                                              (set THIS as your back_url)
//
// Required env vars (Vercel project settings, never in client code):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   -- service_role key, server-only
//   NEKPAY_MCH_ID
//   NEKPAY_MERCHANT_KEY         -- disbursement signing key
//   NEKPAY_BACK_URL             -- e.g. https://yourdomain.com/api/withdraw-payout?event=notify

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const NEKPAY_ENDPOINT = 'https://api.nekpayment.com/pay/transfer';

function md5Sign(params, merchantKey) {
  // ASCII-sort keys, join as k=v&k=v (skip empty values), append &key=<merchant_key>, MD5 → lowercase hex.
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('md5').update(`${queryString}&key=${merchantKey}`, 'utf8').digest('hex').toLowerCase();
}

function formatApplyDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getSupabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (req.query?.event === 'notify') {
    return handleNotify(req, res);
  }
  return handleTrigger(req, res);
}

// ============================================================
// Admin trigger — sends an approved withdrawal to Nekpay
// ============================================================
async function handleTrigger(req, res) {
  const supabaseAdmin = getSupabaseAdmin();

  // --- Verify the caller is an authenticated admin ---
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing bearer token' });
  }

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid session' });
  }

  const { data: callerProfile } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (!callerProfile?.is_admin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  // --- Load and validate the withdrawal ---
  const { withdrawal_id, bank_code: bankCodeOverride } = req.body || {};
  if (!withdrawal_id) {
    return res.status(400).json({ success: false, error: 'withdrawal_id is required' });
  }

  const { data: withdrawal, error: fetchError } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawal_id)
    .single();

  if (fetchError || !withdrawal) {
    return res.status(404).json({ success: false, error: 'Withdrawal not found' });
  }

  if (withdrawal.status !== 'approved') {
    return res.status(400).json({ success: false, error: `Withdrawal must be approved first (current status: ${withdrawal.status})` });
  }

  if (withdrawal.payout_status === 'success') {
    return res.status(409).json({ success: false, error: 'Payout already succeeded for this withdrawal — refusing to send twice.' });
  }

  if (withdrawal.payout_status === 'processing') {
    const requestedAt = withdrawal.payout_requested_at ? new Date(withdrawal.payout_requested_at).getTime() : 0;
    const ageMs = Date.now() - requestedAt;
    const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes — Nekpay's sync response arrives immediately, so anything still "processing" this long after was likely a crash mid-request, not a real in-flight call.
    if (ageMs < STALE_AFTER_MS) {
      return res.status(409).json({ success: false, error: `Payout request sent ${Math.round(ageMs / 1000)}s ago and still processing — wait a bit before retrying.` });
    }
    // Stale — fall through and let this attempt proceed.
  }

  const bankDetails = withdrawal.bank_details || {};
  const bankCode = bankDetails.bank_code || bankCodeOverride;

  // withdraw.html now captures bank_code directly (see assets/js/bank-list.js),
  // so this should only trigger for withdrawals submitted before that change.
  if (!bankCode) {
    return res.status(400).json({
      success: false,
      error: 'No bank_code on this withdrawal and none provided. Pass bank_code in the request body, or update the withdrawal form to capture it.'
    });
  }
  if (!bankDetails.account_number || !bankDetails.account_name) {
    return res.status(400).json({ success: false, error: 'Withdrawal is missing account_number or account_name' });
  }

  // --- Build the Nekpay request ---
  const transferId = `WD${withdrawal.id.replace(/-/g, '').slice(0, 24)}`;

  const signedParams = {
    mch_id: process.env.NEKPAY_MCH_ID,
    mch_transferId: transferId,
    transfer_amount: Number(withdrawal.amount).toFixed(2),
    apply_date: formatApplyDate(new Date()),
    bank_code: bankCode,
    receive_name: bankDetails.account_name,
    receive_account: bankDetails.account_number,
    back_url: process.env.NEKPAY_BACK_URL,
  };

  const sign = md5Sign(signedParams, process.env.NEKPAY_MERCHANT_KEY);

  const body = new URLSearchParams({ ...signedParams, sign_type: 'MD5', sign });

  // Record that we're sending it, before the network call, so a crash
  // mid-request still leaves a trail instead of silently retrying later.
  await supabaseAdmin
    .from('withdrawals')
    .update({
      payout_transfer_id: transferId,
      payout_status: 'processing',
      payout_requested_at: new Date().toISOString(),
    })
    .eq('id', withdrawal.id);

  let nekpayResponse;
  try {
    const nekpayRes = await fetch(NEKPAY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    nekpayResponse = await nekpayRes.json();
  } catch (err) {
    await supabaseAdmin
      .from('withdrawals')
      .update({ payout_status: 'failed', payout_response: { error: String(err) } })
      .eq('id', withdrawal.id);
    return res.status(502).json({ success: false, error: `Could not reach Nekpay: ${err.message}` });
  }

  const isAccepted = nekpayResponse.respCode === 'SUCCESS' && nekpayResponse.tradeResult === '0';

  await supabaseAdmin
    .from('withdrawals')
    .update({
      payout_reference: nekpayResponse.tradeNo || null,
      payout_status: isAccepted ? 'processing' : 'failed',
      payout_response: nekpayResponse,
      admin_notes: isAccepted
        ? `Sent to Nekpay, tradeNo ${nekpayResponse.tradeNo}. Awaiting async confirmation.`
        : `Nekpay rejected the payout request: ${nekpayResponse.errorMsg || nekpayResponse.respCode}`,
    })
    .eq('id', withdrawal.id);

  if (!isAccepted) {
    return res.status(502).json({ success: false, error: nekpayResponse.errorMsg || 'Nekpay rejected the request', raw: nekpayResponse });
  }

  return res.status(200).json({
    success: true,
    tradeNo: nekpayResponse.tradeNo,
    tradeResult: nekpayResponse.tradeResult,
    note: 'Accepted for processing — final status arrives via the async callback (?event=notify).',
  });
}

// ============================================================
// Nekpay callback — POSTs here once a disbursement is finalized.
// Must respond with the literal string "success" once persisted,
// or Nekpay keeps retrying.
//
// IMPORTANT — the integration doc shows the *request* signature scheme
// but doesn't spell out the exact field set Nekpay signs on the
// *callback*. This verifies a `sign` field if present, using the same
// algorithm over whatever fields Nekpay actually sends (minus
// sign/sign_type). Treat this as best-effort until confirmed against a
// real test transaction or Nekpay's own docs/dashboard.
// ============================================================
async function handleNotify(req, res) {
  const payload = req.body || {};
  const merTransferId = payload.merTransferId || payload.mch_transferId;
  const tradeResult = String(payload.tradeResult ?? '');
  const tradeNo = payload.tradeNo;

  if (!merTransferId) {
    return res.status(400).send('missing transfer id');
  }

  const supabaseAdmin = getSupabaseAdmin();

  if (process.env.NEKPAY_MERCHANT_KEY && payload.sign) {
    const { sign, sign_type, ...rest } = payload;
    const expected = md5Sign(rest, process.env.NEKPAY_MERCHANT_KEY);
    if (expected !== String(sign).toLowerCase()) {
      console.error('withdraw-payout notify: signature mismatch', payload);
      return res.status(400).send('bad signature');
    }
  }

  const { data: withdrawal, error: fetchError } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('payout_transfer_id', merTransferId)
    .single();

  if (fetchError || !withdrawal) {
    console.error('withdraw-payout notify: no withdrawal matches', merTransferId);
    // Ack anyway — a transfer id we don't recognize will never resolve on retry.
    return res.status(200).send('success');
  }

  // Already handled — Nekpay retried after our "success" got lost. Ack and stop.
  if (withdrawal.payout_status === 'success' || withdrawal.payout_status === 'failed') {
    return res.status(200).send('success');
  }

  if (tradeResult === '1') {
    // Success — wallet was already debited when the admin approved the
    // withdrawal, so nothing further to deduct here.
    await supabaseAdmin
      .from('withdrawals')
      .update({
        payout_status: 'success',
        payout_reference: tradeNo || withdrawal.payout_reference,
        payout_response: payload,
      })
      .eq('id', withdrawal.id);

  } else if (tradeResult === '2' || tradeResult === '3') {
    // Failure / rejected — the money never left, so refund the wallet by
    // recording an admin_credit transaction (the existing
    // process_transaction trigger adds it back to balance once approved).
    await supabaseAdmin.from('transactions').insert({
      user_id: withdrawal.user_id,
      type: 'admin_credit',
      amount: withdrawal.amount,
      status: 'approved',
      reference: `payout_refund_${withdrawal.id}`,
      description: 'Automatic refund — Nekpay payout failed/rejected',
      meta: { withdrawal_id: withdrawal.id, nekpay_response: payload },
    });

    await supabaseAdmin
      .from('withdrawals')
      .update({
        status: 'rejected',
        payout_status: 'failed',
        payout_reference: tradeNo || withdrawal.payout_reference,
        payout_response: payload,
        admin_notes: `Nekpay payout ${tradeResult === '2' ? 'failed' : 'was rejected'} — amount refunded to wallet.`,
      })
      .eq('id', withdrawal.id);

  } else {
    // tradeResult 4 (still processing) or anything unrecognized — record and wait.
    await supabaseAdmin
      .from('withdrawals')
      .update({ payout_status: 'processing', payout_response: payload })
      .eq('id', withdrawal.id);
  }

  return res.status(200).send('success');
}
