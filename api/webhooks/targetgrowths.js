/**
 * Target Growth Webhook Handler (IPN)
 * 
 * Listens for payment status changes from Target Growth.
 * Handles both Deposits (Payins) and Withdrawals (Payouts).
 */
import supabaseAdmin from '../../lib/supabase.js';
import { 
  parseWebhookBody, 
  validWebhookSignature, 
  webhookIdentifier, 
  webhookAmount, 
  webhookStatus, 
  webhookType,
  isSuccessfulStatus,
  isFailedStatus
} from '../../lib/targetgrowths.js';

export default async function handler(req, res) {
  // 1. Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Parse the incoming payload (handles both JSON and form-urlencoded)
  const payload = parseWebhookBody(req.body);
  console.log('[TG-WEBHOOK-RECEIVED]', JSON.stringify(payload, null, 2));
  console.log('[TG-WEBHOOK-FULL-PAYLOAD]', JSON.stringify(payload, null, 2));
console.log('[TG-WEBHOOK-AMOUNT-DEBUG]', {
  direct: payload?.amount,
  nested: payload?.data?.amount,
  raw_amount: payload?.['data[amount]']
});
  
  // 3. SECURITY: Verify the HMAC-SHA256 signature (skip in sandbox for testing)
  const ENV = process.env.TARGETGROWTHS_ENV || "production";
  if (ENV !== "sandbox" && !validWebhookSignature(payload)) {
    console.error('[TG-WEBHOOK] ❌ Invalid signature. Rejecting request.');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  if (ENV === "sandbox") {
    console.log('[TG-WEBHOOK] ⚠️ Skipping signature verification in sandbox mode');
  }

  // 4. Extract core data
  const identifier = webhookIdentifier(payload);
  const amount = webhookAmount(payload);
  const status = webhookStatus(payload);
  const type = webhookType(payload); // 'payin' or 'payout'

  if (!identifier) {
    console.error('[TG-WEBHOOK]  No identifier found in payload.');
    return res.status(400).json({ error: 'Missing identifier' });
  }

  // 5. Route to Deposit or Withdrawal handler
  // We check the 'type' first, then fallback to identifier prefix (TGD vs TGW)
  if (type === 'payin' || identifier.startsWith('TGD')) {
    await handleDeposit(identifier, amount, status, payload);
  } else if (type === 'payout' || identifier.startsWith('TGW')) {
    await handleWithdrawal(identifier, amount, status, payload);
  } else {
    console.warn('[TG-WEBHOOK] ⚠️ Unknown webhook type:', type);
  }

  // 6. Always return 200 OK to Target Growth to stop retries
  return res.status(200).json({ ok: true, message: 'Webhook processed' });
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
      console.error(`[TG-DEPOSIT] ️ Amount mismatch! Expected: ${deposit.amount}, Got: ${amount}`);
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

    // Update wallet using .update() instead of .upsert()
    await supabaseAdmin
      .from('wallets')
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', deposit.user_id);

    console.log(`[TG-DEPOSIT] ✅ Wallet updated: ${wallet?.balance} → ${newBalance}`);

    // Record transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: Number(amount),
      status: 'approved',
      reference: deposit.reference,
      description: `Target Growth Deposit (${identifier})`
    });

    // Mark deposit as completed
    await supabaseAdmin.from('deposits').update({
      status: 'completed',
      provider_status: 'success',
      provider_response: payload,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', deposit.id);

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
