/**
 * TargetGrowths Webhook Handler
 * Uses API verification instead of signature for maximum security
 */

import supabaseAdmin from '../../lib/supabase.js';
import { 
  parseWebhookBody, 
  webhookStatus, 
  webhookIdentifier, 
  webhookAmount, 
  isSuccessfulStatus, 
  verifyPayment 
} from '../../lib/targetgrowths.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = parseWebhookBody(req.body);
    console.log('[TG-WEBHOOK-RECEIVED]', payload);

    const status = webhookStatus(payload);
    const identifier = webhookIdentifier(payload);
    const amount = webhookAmount(payload);

    // 1. SKIP SIGNATURE CHECK - We verify via API instead
    console.log('[TG-WEBHOOK] ⚠️ Using API verification instead of signature');

    // 2. VERIFY PAYMENT VIA TARGET GROWTH API
    let verification;
    try {
      verification = await verifyPayment(identifier);
      console.log('[TG-API-VERIFY] Response:', verification);
    } catch (verifyErr) {
      console.error('[TG-API-VERIFY] Failed:', verifyErr.message);
      return res.status(500).json({ error: 'Payment verification failed' });
    }

    // 3. CHECK IF PAYMENT IS SUCCESSFUL
const apiResponseStatus = verification?.status || '';
const paymentStatus = verification?.data?.payment_status || verification?.data?.status || '';

console.log('[TG-WEBHOOK] API Response Status:', apiResponseStatus);
console.log('[TG-WEBHOOK] Payment Status:', paymentStatus);

// If API verification fails, reject
if (!isSuccessfulStatus(apiResponseStatus)) {
  console.log('[TG-WEBHOOK] API verification failed:', apiResponseStatus);
  return res.status(200).json({ message: 'Payment verification failed' });
}

// Handle different payment states
if (isSuccessfulStatus(paymentStatus)) {
  console.log('[TG-WEBHOOK] ✅ Payment is successful, proceeding to credit');
  // Continue to credit the user
} else if (paymentStatus === 'initiated' || paymentStatus === 'pending') {
  // Payment is processing - update DB but don't credit yet
  console.log('[TG-WEBHOOK] ⏳ Payment is processing:', paymentStatus);
  
  // Update deposit status to processing
  await supabaseAdmin.from('deposits').update({
    status: 'pending',
    provider_status: paymentStatus,
    provider_response: verification,
    updated_at: new Date().toISOString()
  }).eq('id', deposit.id).eq('status', 'pending');
  
  // Return success so gateway doesn't show "Fail"
  return res.status(200).json({ 
    message: 'Payment processing, will be credited when confirmed',
    status: paymentStatus 
  });
} else {
  // Payment failed or cancelled
  console.log('[TG-WEBHOOK] Payment failed:', paymentStatus);
  await supabaseAdmin.from('deposits').update({
    status: 'rejected',
    provider_status: paymentStatus,
    provider_response: verification,
    updated_at: new Date().toISOString()
  }).eq('id', deposit.id).eq('status', 'pending');
  
  return res.status(200).json({ message: 'Payment failed' });
}    
    // 4. VERIFY AMOUNT MATCHES
    const apiAmount = Number(verification?.data?.amount || verification?.amount);
    if (apiAmount !== amount) {
      console.error(`[TG-WEBHOOK] Amount mismatch! Webhook: ${amount}, API: ${apiAmount}`);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    console.log(`[TG-WEBHOOK] ✅ Payment verified via API: ${identifier} - ₦${amount}`);

    // 5. FIND THE DEPOSIT RECORD
    const { data: deposit } = await supabaseAdmin
      .from('deposits')
      .select('id, user_id, amount, status')
      .eq('provider_identifier', identifier)
      .single();

    if (!deposit) {
      console.error('[TG-WEBHOOK] Deposit not found for identifier:', identifier);
      return res.status(404).json({ error: 'Deposit not found' });
    }

    if (deposit.status === 'completed') {
      console.log('[TG-WEBHOOK] Already processed, skipping duplicate');
      return res.status(200).json({ message: 'Already processed' });
    }

    // 6. CREDIT WALLET (Using .update() to fix the balance issue)
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', deposit.user_id)
      .single();

    const newBalance = (wallet?.balance || 0) + Number(deposit.amount);
    console.log(`[TG-WEBHOOK] Updating wallet: ${wallet?.balance} → ${newBalance} for user ${deposit.user_id}`);

    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({ 
        balance: newBalance, 
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', deposit.user_id);

    if (walletError) {
      console.error('[TG-WEBHOOK] ❌ Wallet update failed:', walletError.message);
      throw new Error(`Wallet update failed: ${walletError.message}`);
    }
    console.log(`[TG-WEBHOOK] ✅ Wallet updated successfully`);

    // 7. RECORD TRANSACTION
    await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: Number(deposit.amount),
      status: 'approved',
      reference: deposit.reference,
      description: `Target Growth Deposit (${identifier})`
    });

    // 8. MARK DEPOSIT AS COMPLETED
    await supabaseAdmin.from('deposits').update({
      status: 'completed',
      provider_status: 'success',
      provider_response: verification,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', deposit.id);

    console.log(`[TG-DEPOSIT] ✅ Successfully credited ₦${deposit.amount} to user ${deposit.user_id}`);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[TG-WEBHOOK] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DEPOSIT HANDLER (PAYIN)
// ==========================================
async function handleDeposit(identifier, amount, status, payload) {
  console.log(`[TG-DEPOSIT] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  // 1. Find the pending deposit record
  const { data: deposit, error: findError } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !deposit) {
    console.error('[TG-DEPOSIT] ❌ Record not found for identifier:', identifier);
    return;
  }

  // 2. Idempotency: If already completed, ignore duplicate webhooks
  if (deposit.status === 'completed' || deposit.status === 'rejected') {
    console.log('[TG-DEPOSIT] ⏭️ Already processed. Skipping.');
    return;
  }

  // 3. Handle SUCCESS
  if (isSuccessfulStatus(status)) {
    // Safety check: Ensure amount matches
    if (Number(amount) !== Number(deposit.amount)) {
      console.error(`[TG-DEPOSIT] ⚠️ Amount mismatch! Expected: ${deposit.amount}, Got: ${amount}`);
      await supabaseAdmin.from('deposits').update({
        status: 'pending',
        provider_status: 'amount_mismatch',
        provider_response: payload,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      return;
    }

    // Credit the user's wallet
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', deposit.user_id)
      .single();

    const newBalance = Number(wallet?.balance || 0) + Number(amount);

    // Update wallet using .update()
    await supabaseAdmin
      .from('wallets')
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', deposit.user_id);

    console.log(`[TG-DEPOSIT] ✅ Wallet updated: ${wallet?.balance} → ${newBalance}`);

    // Record transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: deposit.user_id,
        type: 'deposit',
        amount: Number(amount),
        status: 'approved',
        reference: deposit.reference,
        description: `Target Growth Deposit (${identifier})`
      });

    // CRITICAL: Mark deposit as completed
    await supabaseAdmin
      .from('deposits')
      .update({
        status: 'completed',
        provider_status: 'success',
        provider_response: payload,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', deposit.id);

    console.log(`[TG-DEPOSIT] ✅ Successfully credited ₦${amount} to user ${deposit.user_id}`);
  } 
  // 4. Handle FAILURE
  else if (isFailedStatus(status)) {
    await supabaseAdmin.from('deposits').update({
      status: 'rejected',
      provider_status: 'failed',
      provider_response: payload,
      updated_at: new Date().toISOString()
    }).eq('id', deposit.id);

    console.log(`[TG-DEPOSIT] ❌ Deposit failed for ${identifier}`);
  }
}

// ==========================================
// WITHDRAWAL HANDLER (PAYOUT)
// ==========================================
async function handleWithdrawal(identifier, amount, status, payload) {
  console.log(`[TG-WITHDRAWAL] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  // 1. Find the pending withdrawal record
  const { data: withdrawal, error: findError } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !withdrawal) {
    console.error('[TG-WITHDRAWAL] ❌ Record not found for identifier:', identifier);
    return;
  }

  // 2. Idempotency check
  if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
    console.log('[TG-WITHDRAWAL] ⏭️ Already processed. Skipping.');
    return;
  }

  // 3. Handle SUCCESS
  if (isSuccessfulStatus(status)) {
    await supabaseAdmin.from('withdrawals').update({
      status: 'completed',
      provider_status: 'success',
      provider_response: payload,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ✅ Payout successful for ${identifier}`);
  } 
  
  // 4. Handle FAILURE (CRITICAL: REFUND THE USER)
  else if (isFailedStatus(status)) {
    // Since we deducted the money when the withdrawal was initiated, 
    // we MUST refund it back to the user's wallet now.
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', withdrawal.user_id)
      .single();

    const refundAmount = Number(amount);
    const newBalance = Number(wallet?.balance || 0) + refundAmount;

    // Refund wallet
    await supabaseAdmin.from('wallets').upsert({
      user_id: withdrawal.user_id,
      balance: newBalance,
      updated_at: new Date().toISOString()
    });

    // Record refund transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: withdrawal.user_id,
      type: 'withdrawal_refund',
      amount: refundAmount,
      status: 'approved',
      reference: `REF_${withdrawal.reference}`,
      description: `Target Growth Payout Failed - Refund (${identifier})`
    });

    // Mark withdrawal as failed
    await supabaseAdmin.from('withdrawals').update({
      status: 'failed',
      provider_status: 'failed',
      provider_response: payload,
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ❌ Payout failed. Refunded ₦${refundAmount} to user ${withdrawal.user_id}`);
  }
}
