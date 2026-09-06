/**
 * TargetGrowths Payment Gateway Integration for RMS
 * 
 * Supports:
 * - Sandbox & Production environments
 * - Payment initiation (deposits)
 * - Transfer initiation (withdrawals)
 * - Payment verification
 * - Webhook parsing & signature validation
 * 
 * Environment Variables Required:
 * - TARGETGROWTHS_ENV: "sandbox" or "production" (default: production)
 * - TARGETGROWTHS_PUBLIC_KEY: Your public API key
 * - TARGETGROWTHS_SECRET_KEY: Your secret API key
 */

const crypto = require("crypto");

// ==========================================
// ENVIRONMENT CONFIGURATION
// ==========================================
const ENV = process.env.TARGETGROWTHS_ENV || "production";
const BASE_URL = ENV === "sandbox" 
  ? "https://targetgrowths.com/sandbox" 
  : "https://targetgrowths.com";

console.log(`[TargetGrowths] Environment: ${ENV} | Base URL: ${BASE_URL}`);

// ==========================================
// CREDENTIALS
// ==========================================
function getCredentials() {
  const publicKey = process.env.TARGETGROWTHS_PUBLIC_KEY;
  const secretKey = process.env.TARGETGROWTHS_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error("TargetGrowths credentials are not configured. Check TARGETGROWTHS_PUBLIC_KEY and TARGETGROWTHS_SECRET_KEY in environment variables.");
  }
  return { publicKey, secretKey, env: ENV };
}

// ==========================================
// CORE REQUEST HANDLER
// ==========================================
async function postForm(path, params) {
  const { publicKey } = getCredentials();
  const body = new URLSearchParams();
  
  Object.entries({ ...params, public_key: publicKey }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      body.set(key, String(value));
    }
  });

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (error) {
    error.retryable = true;
    throw error;
  }

  const text = await response.text();
  let data;
  try { 
    data = JSON.parse(text); 
  } catch { 
    data = { raw: text }; 
  }
  
  if (!response.ok || data?.error === "true" || data?.success === false) {
    const error = new Error(data?.message || data?.error || `TargetGrowths request failed (${response.status})`);
    error.retryable = false;
    error.providerResponse = data;
    throw error;
  }
  return data;
}

// ==========================================
// PAYMENT INITIATION (DEPOSITS)
// ==========================================
function initiatePayment({ 
  identifier, 
  amount, 
  details, 
  ipnUrl, 
  successUrl, 
  cancelUrl, 
  siteLogo, 
  customerName, 
  customerEmail 
}) {
  return postForm("/payment/initiate", {
    identifier,
    currency: "NGN",
    amount: Number(amount).toFixed(2),
    details,
    gateway_id: "21",
    ipn_url: ipnUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
    site_logo: siteLogo,
    checkout_theme: "light",
    customer_name: customerName,
    customer_email: customerEmail,
  });
}

// ==========================================
// TRANSFER INITIATION (WITHDRAWALS)
// ==========================================
function initiateTransfer({ 
  identifier, 
  amount, 
  bankId, 
  recipient, 
  accountName, 
  ipnUrl, 
  customerEmail 
}) {
  return postForm("/payment/transfer", {
    identifier,
    currency: "NGN",
    amount: Number(amount).toFixed(2),
    fee_bearer: "merchant",
    bank_id: bankId,
    ipn_url: ipnUrl,
    recipient,
    account_name: accountName,
    customer_email: customerEmail,
  });
}

// ==========================================
// WALLET BALANCE
// ==========================================
async function getWalletBalance(currency = "NGN") {
  const profile = await postForm("/payment/profile", { currency });
  const wallets = profile?.data?.wallets || profile?.wallets || [];
  const walletList = Array.isArray(wallets) ? wallets : Object.values(wallets || {});
  const wanted = String(currency || "NGN").toUpperCase();
  
  const wallet = walletList.find(item => 
    String(item?.currency_code || item?.currency || item?.code || "").toUpperCase() === wanted
  ) || walletList[0] || null;
  
  const rawBalance = wallet?.balance ?? wallet?.available_balance ?? wallet?.amount ?? null;
  const balance = Number(rawBalance);
  
  if (!wallet || !Number.isFinite(balance)) {
    const error = new Error("TargetGrowths returned no usable wallet balance");
    error.providerResponse = profile;
    throw error;
  }
  
  return { 
    currency: wanted, 
    balance, 
    balance_raw: String(rawBalance), 
    provider: "targetgrowths" 
  };
}

// ==========================================
// PAYMENT VERIFICATION
// ==========================================
async function verifyPayment(transactionId) {
  const { secretKey } = getCredentials();
  const url = `${BASE_URL}/verify/payment/${encodeURIComponent(transactionId)}?secret_key=${encodeURIComponent(secretKey)}`;
  
  const response = await fetch(url, { 
    headers: { Accept: "application/json" } 
  });
  
  const text = await response.text();
  console.log("[TG-VERIFY-RAW]", url.replace(/secret_key=[^&]+/, "secret_key=REDACTED"), text);
  
  let data;
  try { 
    data = JSON.parse(text); 
  } catch { 
    data = { raw: text }; 
  }
  
  if (!response.ok) {
    throw new Error(data?.message || `TargetGrowths verification failed (${response.status})`);
  }
  
  return data;
}

// ==========================================
// WEBHOOK PARSING
// ==========================================
function parseWebhookBody(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  if (!text) return {};
  
  try { 
    return JSON.parse(text); 
  } catch {}

  const params = new URLSearchParams(text);
  const payload = {};
  const nestedData = {};
  
  for (const [key, value] of params.entries()) {
    const match = key.match(/^data\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (match) {
      const field = match[1];
      const child = match[2];
      if (child) {
        if (!nestedData[field] || typeof nestedData[field] !== "object") {
          nestedData[field] = {};
        }
        nestedData[field][child] = value;
      } else {
        nestedData[field] = value;
      }
    } else {
      payload[key] = value;
    }
  }

  if (payload.data) {
    try {
      const parsed = JSON.parse(payload.data);
      payload.data = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      payload.data = {};
    }
  }
  
  if (Object.keys(nestedData).length > 0) {
    payload.data = { ...nestedData, ...(payload.data || {}) };
  }
  
  return payload;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { 
    return JSON.parse(value); 
  } catch { 
    return {}; 
  }
}

function webhookData(payload) {
  return asObject(payload?.data);
}

function webhookPaymentObject(payload) {
  const data = webhookData(payload);
  return data.transaction || data.payment || payload?.transaction || payload?.payment || {};
}

function webhookTransactionReference(payload) {
  const data = webhookData(payload);
  const payment = webhookPaymentObject(payload);
  return payload?.transaction_ref || payload?.transactionReference || payload?.trx_id || payload?.transaction_id ||
    data.transaction_ref || data.transactionReference || data.trx_id || data.transaction_id || 
    data.payment_trx || data.ref_trx ||
    payment.transaction_ref || payment.transactionReference || payment.trx_id || 
    payment.transaction_id || payment.payment_trx || payment.ref_trx || null;
}

function webhookIdentifier(payload) {
  const data = webhookData(payload);
  const payment = webhookPaymentObject(payload);
  return payload?.identifier || data.identifier || payment.identifier || null;
}

function webhookAmountRaw(payload) {
  const data = webhookData(payload);
  const payment = webhookPaymentObject(payload);
  const value = payload?.amount ?? data.amount ?? data.payment_amount ?? data.final_amount ??
    payment.amount ?? payment.payment_amount ?? payment.final_amount;
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value).trim();
}

function webhookAmount(payload) {
  const raw = webhookAmountRaw(payload);
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : null;
}

function webhookChargeRaw(payload) {
  const data = webhookData(payload);
  const payment = webhookPaymentObject(payload);
  const value = payload?.charge ?? payload?.fee ?? data.charge ?? data.fee ?? data.processing_fee ??
    payment.charge ?? payment.fee ?? payment.processing_fee;
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value).trim();
}

function amountFormats(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return [];
  return [...new Set([
    String(value).trim(),
    String(numeric),
    numeric.toFixed(2),
    numeric.toFixed(4),
    numeric.toFixed(8),
    numeric.toFixed(0),
  ])];
}

function webhookStatus(payload) {
  const data = webhookData(payload);
  const payment = webhookPaymentObject(payload);
  return String(data.payment_status || payment.payment_status || data.status || 
    payment.status || payload?.payment_status || payload?.status || "").trim().toLowerCase();
}

function webhookType(payload) {
  const data = webhookData(payload);
  return String(payload?.pay_type || payload?.payType || data.pay_type || 
    data.payType || data.type || "payin").toLowerCase();
}

function isSuccessfulStatus(status) {
  return ["success", "successful", "completed", "complete", "paid", "approved"].includes(
    String(status).toLowerCase()
  );
}

function isFailedStatus(status) {
  return ["failed", "failure", "rejected", "reject", "cancelled", "canceled", "declined"].includes(
    String(status).toLowerCase()
  );
}

// ==========================================
// WEBHOOK SIGNATURE VERIFICATION
// ==========================================
function webhookSignatureCheck(payload) {
  const { secretKey } = getCredentials();
  const data = webhookData(payload);
  const signature = String(payload?.signature || data.signature || "").trim();
  const identifier = webhookIdentifier(payload);
  const amountRaw = webhookAmountRaw(payload);
  const amount = Number(amountRaw);
  const chargeRaw = webhookChargeRaw(payload);
  const charge = chargeRaw === null ? null : Number(chargeRaw);
  
  if (!signature || !identifier || amountRaw === null || !Number.isFinite(amount)) {
    return { valid: false, amountRaw, identifier, chargeRaw, matched: null };
  }

  const candidates = new Set(amountFormats(amountRaw));
  if (Number.isFinite(charge)) {
    for (const value of [amount + charge, amount - charge, charge]) {
      for (const formatted of amountFormats(value)) candidates.add(formatted);
    }
  }
  
  const provided = Buffer.from(signature.toUpperCase());
  for (const value of candidates) {
    const expected = Buffer.from(
      crypto.createHmac("sha256", secretKey)
        .update(`${value}${identifier}`)
        .digest("hex")
        .toUpperCase()
    );
    if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
      return { valid: true, amountRaw, identifier, chargeRaw, matched: value };
    }
  }
  
  return { valid: false, amountRaw, identifier, chargeRaw, matched: null };
}

function validWebhookSignature(payload) {
  return webhookSignatureCheck(payload).valid;
}

// ==========================================
// ES MODULE EXPORTS
// ==========================================
export {
  getCredentials,
  parseWebhookBody,
  initiatePayment,
  initiateTransfer,
  getWalletBalance,
  verifyPayment,
  webhookData,
  webhookPaymentObject,
  webhookTransactionReference,
  webhookIdentifier,
  webhookAmountRaw,
  webhookAmount,
  webhookChargeRaw,
  webhookStatus,
  webhookType,
  isSuccessfulStatus,
  isFailedStatus,
  webhookSignatureCheck,
  validWebhookSignature,
};
