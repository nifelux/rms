/**
 * Webhook Handler for External Payment Gateways
 * Actions:
 *   - initiateDeposit  : called by deposit.html to start a NekPayment deposit
 *   - depositWebhook   : called by NekPayment's servers on payment completion
 *   - monnify          : placeholder for future Monnify integration
 */
import crypto from 'crypto';
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

const DEPOSIT_URL = 'https://api.nekpayment.com/pay/web';

// Set these in your Vercel project's Environment Variables — never
// commit the merchant key (or any of these) to the repo.
const MCH_ID = process.env.NEKPAYMENT_MCH_ID;
const MERCHANT_KEY = process.env.NEKPAYMENT_MERCHANT_KEY;
const NOTIFY_URL = process.env.NEKPAYMENT_NOTIFY_URL; // e.g. https://dts-stocks.vercel.app/api/webhook?action=depositWebhook
const PAGE_URL = process.env.NEKPAYMENT_PAGE_URL;     // e.g. https://dts-stocks.vercel.app/deposit.html
// Nekpay's docs confirm pay_type is account/channel-specific — "you must
// verify the exact code in your Nekpay Merchant Backend." Falls back to
// their documented sample value if unset.
const PAY_TYPE = process.env.NEKPAYMENT_PAY_TYPE || '122';
// Which collection bank channel to use — a merchant-side setting, not
// something the depositing user chooses. Falls back to Access Bank
// (NGR044) from the sample doc if unset.
const BANK_CODE = process.env.NEKPAYMENT_BANK_CODE || 'NGR044';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'initiateDeposit': return initiateDeposit(req, res);
      case 'depositWebhook': return depositWebhook(req, res);
      case 'monnify': return monnifyWebhook(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * "Sort all non-empty parameters (excluding sign and sign_type)
 * alphabetically by ASCII code. Concatenate as k=v&k=v. Append the
 * merchant private key using &key=merchant_key. Generate a lowercase
 * MD5 hash."
 */
function generateSign(params, merchantKey) {
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const joined = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const toHash = `${joined}&key=${merchantKey}`;
  return crypto.createHash('md5').update(toHash, 'utf8').digest('hex').toLowerCase();
}

// Confirmed format from Nekpay's sample doc: "2026-07-19 15:30:00"
function formatOrderDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function initiateDeposit(req, res) {
  const user = await verifyUser(req);
  const { amount } = req.body;

  if (!amount || Number(amount) < 1000) {
    return res.status(400).json({ error: 'Minimum deposit is ₦1,000' });
  }

  const orderNumber = `DTL${Date.now()}${user.id.slice(0, 6)}`;

  // Record the pending order BEFORE calling out, so the webhook has
  // something to match against even if the outbound request fails.
  const { error: insertErr } = await supabaseAdmin.from('payment_orders').insert({
    order_number: orderNumber,
    user_id: user.id,
    amount: Number(amount),
    bank_code: BANK_CODE,
    type: 'deposit',
    status: 'pending'
  });
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  const params = {
    version: '1.0',
    mch_id: MCH_ID,
    notify_url: NOTIFY_URL,
    page_url: PAGE_URL,
    mch_order_no: orderNumber,
    pay_type: PAY_TYPE,
    trade_amount: Number(amount).toFixed(2),
    order_date: formatOrderDate(new Date()),
    bank_code: BANK_CODE,
    goods_name: 'Wallet Deposit',
    mch_return_msg: 'DTL Stocks wallet top-up',
    sign_type: 'MD5'
  };
  params.sign = generateSign(params, MERCHANT_KEY);

  let gatewayRes;
  try {
    const resp = await fetch(DEPOSIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    gatewayRes = await resp.json();
  } catch (fetchErr) {
    await supabaseAdmin.from('payment_orders')
      .update({ status: 'failed', gateway_response: { error: fetchErr.message }, updated_at: new Date().toISOString() })
      .eq('order_number', orderNumber);
    return res.status(502).json({ error: 'Could not reach payment provider. Please try again.' });
  }

  await supabaseAdmin.from('payment_orders')
    .update({ gateway_response: gatewayRes, updated_at: new Date().toISOString() })
    .eq('order_number', orderNumber);

  // Confirmed from the sample doc: respCode === "SUCCESS" and
  // tradeResult === "1" together indicate a valid response to proceed on.
  if (gatewayRes?.respCode !== 'SUCCESS' || String(gatewayRes?.tradeResult) !== '1' || !gatewayRes?.payInfo) {
    return res.status(400).json({ error: gatewayRes?.tradeMsg || 'Payment initiation failed.' });
  }

  return res.status(200).json({ payment_url: gatewayRes.payInfo, order_number: orderNumber });
}

async function depositWebhook(req, res) {
  // Called directly by NekPayment's servers, not your frontend — no
  // user JWT to check. Authenticity comes ENTIRELY from the signature
  // check below. Never credit a wallet here without verifying `sign`
  // first — anyone who found this URL could otherwise fake a
  // "payment successful" call and get free money.
  const params = req.body;
  const receivedSign = params.sign;
  const expectedSign = generateSign(params, MERCHANT_KEY);

  if (!receivedSign || receivedSign.toLowerCase() !== expectedSign) {
    console.error('NekPayment webhook signature mismatch:', params);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Per the doc: async notification includes tradeResult (1 = success),
  // mchId, mchOrderNo, amount, orderNo.
  const orderNumber = params.mchOrderNo;
  const isSuccess = String(params.tradeResult) === '1';

  const { data: order } = await supabaseAdmin.from('payment_orders').select('*').eq('order_number', orderNumber).single();
  if (!order) {
    console.error('NekPayment webhook for unknown order:', orderNumber);
    return res.status(404).json({ error: 'Unknown order' });
  }

  // Idempotency: gateways commonly retry webhooks until they get the
  // expected acknowledgement — don't re-credit an already-processed
  // order, but still ack with "success" so Nekpay stops retrying it.
  if (order.status === 'success') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('success');
  }

  await supabaseAdmin.from('payment_orders')
    .update({ status: isSuccess ? 'success' : 'failed', gateway_response: params, updated_at: new Date().toISOString() })
    .eq('order_number', orderNumber);

  if (isSuccess) {
    // This insert (status already 'approved') is what actually credits
    // the wallet, via the trg_process_transaction trigger. Using the
    // order_number as the unique `reference` means a duplicate webhook
    // call fails safely on the unique constraint instead of double-
    // crediting, as a second layer of protection beyond the check above.
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: order.user_id,
      type: 'deposit',
      amount: order.amount,
      status: 'approved',
      reference: orderNumber,
      meta: { gateway: 'nekpayment', bank_code: order.bank_code, gateway_order_no: params.orderNo }
    });
    if (txnErr && !txnErr.message.includes('duplicate')) {
      console.error('Failed to credit wallet for order', orderNumber, txnErr.message);
    }
  }

  // CONFIRMED from Nekpay's sample doc: "your server must respond with
  // the string success to acknowledge receipt and prevent further
  // retries from Nekpay" — this must be plain text, NOT a JSON body.
  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('success');
}

async function monnifyWebhook(req, res) {
  // Future: verify Monnify signature, process payment notification.
  // For now, return 200 to acknowledge.
  try {
    const payload = req.body;
    await supabaseAdmin.from('activity_logs').insert({ action: 'webhook_monnify', details: payload });
    return res.status(200).json({ status: 'received' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
