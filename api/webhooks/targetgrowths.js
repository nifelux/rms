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
  isFailedStatus,
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

    // 1. FIND THE DEPOSIT RECORD FIRST (Fixes "deposit is not defined" error)
    const { data: deposit, error: depositError } = await supabaseAdmin
      .from('deposits')
      .select('id, user_id, amount, status, reference')
      .eq('provider_identifier', identifier)
      .single();

    if (depositError || !deposit) {
      console.error('[TG-WEBHOOK] Deposit not found for identifier:', identifier);
      return res.status(404).json({ error: 'Deposit not found' });
    }

    // Idempotency: Skip if already completed
    if (deposit.status === 'completed') {
      console.log('[TG-WEBHOOK] Already processed, skipping duplicate');
      return res.status(200).json({ message: 'Already processed' });
    }

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

    // 3. CHECK STATUSES
    const apiResponseStatus = verification?.status || '';
    const paymentStatus = verification?.data?.payment_status || verification?.data?.status || '';

    console.log('[TG-WEBHOOK] API Response Status:', apiResponseStatus);
    console.log('[TG-WEBHOOK] Payment Status:', paymentStatus);

    // If API verification fails
    if (!isSuccessfulStatus(apiResponseStatus)) {
      console.log('[TG-WEBHOOK] API verification failed:', apiResponseStatus);
      await supabaseAdmin.from('deposits').update({
        status: 'rejected',
        provider_status: paymentStatus || apiResponseStatus,
        provider_response: verification,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      return res.status(200).json({ message: 'Payment verification failed' });
    }

    // 4. HANDLE DIFFERENT PAYMENT STATES
    
    if (isSuccessfulStatus(paymentStatus)) {
      console.log('[TG-WEBHOOK] ✅ Payment is successful, proceeding to credit');
      
      // Verify amount matches
      const apiAmount = Number(verification?.data?.amount || verification?.amount);
      if (apiAmount !== Number(deposit.amount)) {
        console.error(`[TG-WEBHOOK] Amount mismatch! Webhook: ${deposit.amount}, API: ${apiAmount}`);
        await supabaseAdmin.from('deposits').update({
          status: 'rejected',
          provider_status: 'amount_mismatch',
          provider_response: verification,
          updated_at: new Date().toISOString()
        }).eq('id', deposit.id);
        return res.status(400).json({ error: 'Amount mismatch' });
      }

      console.log(`[TG-WEBHOOK] ✅ Payment verified via API: ${identifier} - ₦${deposit.amount}`);

      // Credit wallet
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

      // Record transaction
      await supabaseAdmin.from('transactions').insert({
        user_id: deposit.user_id,
        type: 'deposit',
        amount: Number(deposit.amount),
        status: 'approved',
        reference: deposit.reference,
        description: `Target Growth Deposit (${identifier})`
      });

      // Mark deposit as completed
      await supabaseAdmin.from('deposits').update({
        status: 'completed',
        provider_status: 'success',
        provider_response: verification,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);

      console.log(`[TG-DEPOSIT] ✅ Successfully credited ₦${deposit.amount} to user ${deposit.user_id}`);
      return res.status(200).json({ success: true });

    } else if (paymentStatus === 'initiated' || paymentStatus === 'pending') {
      // Payment is processing - update DB but don't credit yet
      console.log('[TG-WEBHOOK] ⏳ Payment is processing:', paymentStatus);
      
      await supabaseAdmin.from('deposits').update({
        status: 'pending',
        provider_status: paymentStatus,
        provider_response: verification,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      
      // Return 200 OK so the gateway doesn't show "Fail" to the user
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
      }).eq('id', deposit.id);
      
      return res.status(200).json({ message: 'Payment failed' });
    }

  } catch (err) {
    console.error('[TG-WEBHOOK] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DEPOSIT HANDLER (PAYIN) - Kept for reference/legacy
// ==========================================
async function handleDeposit(identifier, amount, status, payload) {
  console.log(`[TG-DEPOSIT] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  const { data: deposit, error: findError } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !deposit) {
    console.error('[TG-DEPOSIT] ❌ Record not found for identifier:', identifier);
    return;
  }

  if (deposit.status === 'completed' || deposit.status === 'rejected') {
    console.log('[TG-DEPOSIT] ⏭️ Already processed. Skipping.');
    return;
  }

  if (isSuccessfulStatus(status)) {
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

    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', deposit.user_id)
      .single();

    const newBalance = Number(wallet?.balance || 0) + Number(amount);

    await supabaseAdmin
      .from('wallets')
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', deposit.user_id);

    console.log(`[TG-DEPOSIT] ✅ Wallet updated: ${wallet?.balance} → ${newBalance}`);

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
  } else if (isFailedStatus(status)) {
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
// WITHDRAWAL HANDLER (PAYOUT) - Kept for reference/legacy
// ==========================================
async function handleWithdrawal(identifier, amount, status, payload) {
  console.log(`[TG-WITHDRAWAL] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  const { data: withdrawal, error: findError } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !withdrawal) {
    console.error('[TG-WITHDRAWAL] ❌ Record not found for identifier:', identifier);
    return;
  }

  if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
    console.log('[TG-WITHDRAWAL] ⏭️ Already processed. Skipping.');
    return;
  }

  if (isSuccessfulStatus(status)) {
    await supabaseAdmin.from('withdrawals').update({
      status: 'completed',
      provider_status: 'success',
      provider_response: payload,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ✅ Payout successful for ${identifier}`);
  } else if (isFailedStatus(status)) {
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', withdrawal.user_id)
      .single();

    const refundAmount = Number(amount);
    const newBalance = Number(wallet?.balance || 0) + refundAmount;

    await supabaseAdmin.from('wallets').update({
      user_id: withdrawal.user_id,
      balance: newBalance,
      updated_at: new Date().toISOString()
    }).eq('user_id', withdrawal.user_id);

    await supabaseAdmin.from('transactions').insert({
      user_id: withdrawal.user_id,
      type: 'withdrawal_refund',
      amount: refundAmount,
      status: 'approved',
      reference: `REF_${withdrawal.reference}`,
      description: `Target Growth Payout Failed - Refund (${identifier})`
    });

    await supabaseAdmin.from('withdrawals').update({
      status: 'failed',
      provider_status: 'failed',
      provider_response: payload,
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ❌ Payout failed. Refunded ₦${refundAmount} to user ${withdrawal.user_id}`);
  }
}
