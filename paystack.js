/**
 * paystack.js — Production-grade Paystack Integration Module for RichStore Barter Marketplace
 * Handles:
 *  1. Transaction Initialization (Standard charge into Platform Escrow balance)
 *  2. Transaction Verification (Verify payment status & channels)
 *  3. Dynamic Mobile Money Bank/Provider Code Resolution (Telecel Cash, MTN MoMo, AirtelTigo)
 *  4. Transfer Recipient Creation (Seller mobile money & Platform Telecel account)
 *  5. Dual Transfer Payout Execution (Seller listed price + Platform Telecel site fee)
 *  6. Paystack Refund API (Automatic return to buyer's original payment channel)
 *  7. Webhook HMAC-SHA512 Cryptographic Signature Verification
 *  8. Development / Simulation Mode (Enables end-to-end verification without live keys)
 */

const crypto = require("crypto");

const PAYSTACK_BASE_URL = "https://api.paystack.co";

// Read configuration from process.env
function getConfig() {
  const secretKey = (process.env.PAYSTACK_SECRET_KEY || "").trim();
  const publicKey = (process.env.PAYSTACK_PUBLIC_KEY || "").trim();
  const telecelPhone = (process.env.PLATFORM_TELECEL_PHONE || "0501373335").trim();
  const telecelName = (process.env.PLATFORM_TELECEL_NAME || "RichStore Platform Treasury").trim();
  const siteFeePercent = Number(process.env.PLATFORM_SITE_FEE_PERCENT) || 5;

  // Determine if running in live mode, test mode, or simulation mode
  const isConfigured = Boolean(secretKey && !secretKey.startsWith("sk_test_placeholder"));
  const isTest = secretKey.startsWith("sk_test_");

  return {
    secretKey,
    publicKey,
    telecelPhone,
    telecelName,
    siteFeePercent,
    isConfigured,
    isTest
  };
}

/**
 * Convert Ghana Cedis (GHS) to Pesewas (Integer)
 */
function toPesewas(ghsAmount) {
  return Math.round((Number(ghsAmount) || 0) * 100);
}

/**
 * Convert Pesewas (Integer) to Ghana Cedis (GHS, 2 decimals)
 */
function fromPesewas(pesewas) {
  return ((Number(pesewas) || 0) / 100).toFixed(2);
}

/**
 * Calculate Escrow & Platform Protection Fee Breakdown
 * @param {number} sellerPrice - Original seller item price
 * @returns {{ sellerPrice: number, siteFee: number, siteFeePercent: number, buyerTotal: number }}
 */
function calculateEscrowFee(sellerPrice) {
  const cfg = getConfig();
  const cleanSellerPrice = Math.max(0, Math.round((Number(sellerPrice) || 0) * 100) / 100);
  const feeRate = cfg.siteFeePercent / 100;
  
  // Calculate site fee (minimum GHs 1.00 or percentage, rounded to 2 decimals)
  let siteFee = Math.round(cleanSellerPrice * feeRate * 100) / 100;
  if (cleanSellerPrice > 0 && siteFee < 1.0) {
    siteFee = 1.0;
  }
  siteFee = Math.round(siteFee * 100) / 100;
  const buyerTotal = Math.round((cleanSellerPrice + siteFee) * 100) / 100;

  return {
    sellerPrice: cleanSellerPrice,
    siteFee,
    siteFeePercent: cfg.siteFeePercent,
    buyerTotal
  };
}

/**
 * Low-level HTTP client for Paystack REST API
 */
async function paystackRequest(endpoint, method = "GET", body = null) {
  const cfg = getConfig();

  if (!cfg.isConfigured) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured in environment variables.");
  }

  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const headers = {
    "Authorization": `Bearer ${cfg.secretKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  const options = {
    method,
    headers
  };

  if (body && (method === "POST" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const responseData = await response.json();

  if (!response.ok || !responseData.status) {
    const errorMsg = responseData.message || `Paystack API error (${response.status})`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.data = responseData;
    throw err;
  }

  return responseData;
}

// In-memory cache for dynamic Mobile Money Provider Codes
let cachedMobileMoneyBanks = null;
let lastBanksFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Dynamically query Paystack Bank API for current Ghana Mobile Money provider codes
 * Endpoint: GET /bank?currency=GHS&type=mobile_money
 */
async function getMobileMoneyBanks() {
  const now = Date.now();
  if (cachedMobileMoneyBanks && (now - lastBanksFetchTime < CACHE_TTL_MS)) {
    return cachedMobileMoneyBanks;
  }

  const cfg = getConfig();
  if (!cfg.isConfigured) {
    // Return standard fallback provider list for Ghana
    return [
      { name: "Telecel Cash", code: "VOD", slug: "telecel-cash-gh", currency: "GHS", type: "mobile_money" },
      { name: "MTN Mobile Money", code: "MTN", slug: "mtn-gh", currency: "GHS", type: "mobile_money" },
      { name: "AirtelTigo Money", code: "ATL", slug: "airteltigo-gh", currency: "GHS", type: "mobile_money" }
    ];
  }

  try {
    const res = await paystackRequest("/bank?currency=GHS&type=mobile_money", "GET");
    if (Array.isArray(res.data) && res.data.length > 0) {
      cachedMobileMoneyBanks = res.data;
      lastBanksFetchTime = now;
      return cachedMobileMoneyBanks;
    }
  } catch (err) {
    console.warn("Warning: Failed to fetch mobile money banks from Paystack, using cached/fallback codes:", err.message);
    if (cachedMobileMoneyBanks) return cachedMobileMoneyBanks;
  }

  // Fallback defaults
  return [
    { name: "Telecel Cash", code: "VOD", slug: "telecel-cash-gh", currency: "GHS", type: "mobile_money" },
    { name: "MTN Mobile Money", code: "MTN", slug: "mtn-gh", currency: "GHS", type: "mobile_money" },
    { name: "AirtelTigo Money", code: "ATL", slug: "airteltigo-gh", currency: "GHS", type: "mobile_money" }
  ];
}

/**
 * Resolve provider bank code for a given network (e.g. Telecel, MTN, AirtelTigo)
 */
async function resolveProviderCode(providerHint = "telecel") {
  const banks = await getMobileMoneyBanks();
  const hint = String(providerHint || "").toLowerCase().trim();

  // Look for Telecel / Vodafone
  if (hint.includes("telecel") || hint.includes("vodafone") || hint.includes("voda") || hint === "vod") {
    const found = banks.find(b => {
      const name = (b.name || "").toLowerCase();
      const code = (b.code || "").toUpperCase();
      const slug = (b.slug || "").toLowerCase();
      return name.includes("telecel") || name.includes("vodafone") || code === "VOD" || slug.includes("telecel") || slug.includes("vodafone");
    });
    return found ? found.code : "VOD";
  }

  // Look for MTN
  if (hint.includes("mtn")) {
    const found = banks.find(b => {
      const name = (b.name || "").toLowerCase();
      const code = (b.code || "").toUpperCase();
      return name.includes("mtn") || code === "MTN";
    });
    return found ? found.code : "MTN";
  }

  // Look for AirtelTigo
  if (hint.includes("airtel") || hint.includes("tigo") || hint === "atl") {
    const found = banks.find(b => {
      const name = (b.name || "").toLowerCase();
      const code = (b.code || "").toUpperCase();
      return name.includes("airtel") || name.includes("tigo") || code === "ATL";
    });
    return found ? found.code : "ATL";
  }

  // Default to first available or VOD
  return banks[0]?.code || "VOD";
}

/**
 * Deduce Ghana network provider from phone number prefix
 * e.g. 050, 020 -> Telecel (Vodafone)
 *      024, 054, 055, 059, 025 -> MTN
 *      027, 057, 026, 056 -> AirtelTigo
 */
function detectProviderFromPhone(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  let prefix = "";
  if (clean.startsWith("233")) {
    prefix = "0" + clean.slice(3, 5);
  } else if (clean.startsWith("0")) {
    prefix = clean.slice(0, 3);
  }

  if (["050", "020"].includes(prefix)) return "telecel";
  if (["024", "054", "055", "059", "025"].includes(prefix)) return "mtn";
  if (["027", "057", "026", "056"].includes(prefix)) return "airteltigo";
  return "telecel";
}

/**
 * 1. Initialize Paystack Transaction (Standard charge collected into Platform balance)
 */
async function initializeTransaction({ email, amountInPesewas, reference, callbackUrl, metadata = {} }) {
  const cfg = getConfig();

  // Validate parameters
  if (!email || !amountInPesewas || !reference) {
    throw new Error("Missing required fields: email, amountInPesewas, and reference are required.");
  }

  if (!cfg.isConfigured) {
    // DEV / TEST SIMULATION MODE
    console.log(`[Paystack Simulation] Initializing transaction: ref=${reference}, amount=${amountInPesewas} pesewas, email=${email}`);
    return {
      ok: true,
      simulation: true,
      authorizationUrl: `/cart.html?paystack_ref=${encodeURIComponent(reference)}&simulation=1`,
      accessCode: `sim_access_${Date.now()}`,
      reference
    };
  }

  try {
    const payload = {
      email,
      amount: amountInPesewas,
      reference,
      currency: "GHS",
      callback_url: callbackUrl,
      channels: ["card", "mobile_money"],
      metadata: {
        ...metadata,
        platform: "RichStore Marketplace",
        escrowSystem: "Buyer Protection Escrow"
      }
    };

    const res = await paystackRequest("/transaction/initialize", "POST", payload);
    return {
      ok: true,
      simulation: false,
      authorizationUrl: res.data.authorization_url,
      accessCode: res.data.access_code,
      reference: res.data.reference
    };
  } catch (err) {
    console.error("Paystack Transaction Initialization Failed:", err.message);
    throw err;
  }
}

/**
 * 2. Verify Paystack Transaction Status
 * Endpoint: GET /transaction/verify/:reference
 */
async function verifyTransaction(reference) {
  const cfg = getConfig();

  if (!reference) {
    throw new Error("Reference parameter is required for transaction verification.");
  }

  if (!cfg.isConfigured) {
    // DEV / TEST SIMULATION MODE
    console.log(`[Paystack Simulation] Verifying transaction: ref=${reference}`);
    return {
      ok: true,
      simulation: true,
      status: "success",
      amount: 10500, // simulated
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date().toISOString(),
      customer: { email: "customer@richstore.local", phone: "0501373335" },
      raw: { status: "success", gateway_response: "Successful (Simulation)" }
    };
  }

  try {
    const res = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, "GET");
    const data = res.data;

    const isSuccess = data.status === "success";
    return {
      ok: isSuccess,
      simulation: false,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      channel: data.channel,
      paidAt: data.paid_at || new Date().toISOString(),
      customer: data.customer,
      authorization: data.authorization,
      raw: data
    };
  } catch (err) {
    console.error(`Paystack Verify Failed for ref ${reference}:`, err.message);
    return {
      ok: false,
      simulation: false,
      error: err.message,
      status: "failed"
    };
  }
}

/**
 * 3. Create Transfer Recipient
 * Endpoint: POST /transferrecipient
 */
async function createTransferRecipient({ name, accountNumber, bankCode, description = "Escrow Payout" }) {
  const cfg = getConfig();

  if (!cfg.isConfigured) {
    console.log(`[Paystack Simulation] Creating transfer recipient: name="${name}", account="${accountNumber}", bankCode="${bankCode}"`);
    return {
      ok: true,
      simulation: true,
      recipientCode: `RCP_sim_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    };
  }

  try {
    const payload = {
      type: "mobile_money",
      name: String(name || "RichStore User").trim().slice(0, 100),
      account_number: String(accountNumber || "").replace(/\D/g, ""),
      bank_code: bankCode,
      currency: "GHS",
      description
    };

    const res = await paystackRequest("/transferrecipient", "POST", payload);
    return {
      ok: true,
      simulation: false,
      recipientCode: res.data.recipient_code,
      data: res.data
    };
  } catch (err) {
    console.error("Paystack Create Transfer Recipient Failed:", err.message);
    throw err;
  }
}

/**
 * 4. Initiate Transfer
 * Endpoint: POST /transfer
 */
async function initiateTransfer({ amountInPesewas, recipientCode, reason, reference }) {
  const cfg = getConfig();

  if (!cfg.isConfigured) {
    console.log(`[Paystack Simulation] Initiating transfer: amount=${amountInPesewas} pesewas, recipient=${recipientCode}, ref=${reference}`);
    return {
      ok: true,
      simulation: true,
      status: "success",
      transferCode: `TRF_sim_${Date.now()}`,
      reference
    };
  }

  try {
    const payload = {
      source: "balance",
      amount: amountInPesewas,
      recipient: recipientCode,
      reason: reason || "RichStore Escrow Settlement",
      reference: reference || `TRF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      currency: "GHS"
    };

    const res = await paystackRequest("/transfer", "POST", payload);
    return {
      ok: true,
      simulation: false,
      status: res.data.status, // "success", "pending", "otp"
      transferCode: res.data.transfer_code,
      reference: res.data.reference,
      data: res.data
    };
  } catch (err) {
    console.error("Paystack Transfer Initiation Failed:", err.message);
    throw err;
  }
}

/**
 * 5. Payout to Seller (100% of seller listed price)
 */
async function payoutToSeller({ orderId, sellerName, sellerPhone, amountGhs }) {
  const amountPesewas = toPesewas(amountGhs);
  if (amountPesewas <= 0) return { ok: true, skipped: true, reason: "Zero amount" };

  const provider = detectProviderFromPhone(sellerPhone);
  const bankCode = await resolveProviderCode(provider);

  console.log(`[Escrow Payout] Setting up seller transfer recipient for order ${orderId}: ${sellerName} (${sellerPhone}, bankCode: ${bankCode})`);
  const recipientRes = await createTransferRecipient({
    name: sellerName || "Seller",
    accountNumber: sellerPhone,
    bankCode,
    description: `RichStore Seller Payout - Order #${orderId}`
  });

  const transferRef = `PAY-SELLER-${orderId}-${Date.now()}`;
  console.log(`[Escrow Payout] Dispatching GHs ${amountGhs} (${amountPesewas} pesewas) to seller recipient ${recipientRes.recipientCode}`);
  
  const transferRes = await initiateTransfer({
    amountInPesewas: amountPesewas,
    recipientCode: recipientRes.recipientCode,
    reason: `RichStore Seller Payout for Order #${orderId}`,
    reference: transferRef
  });

  return {
    ok: true,
    recipientCode: recipientRes.recipientCode,
    transferCode: transferRes.transferCode,
    reference: transferRef,
    amountGhs,
    status: transferRes.status || "success"
  };
}

/**
 * 6. Payout Site Fee to Platform Telecel Cash Account
 */
async function payoutSiteFeeToTelecel({ orderId, feeAmountGhs }) {
  const cfg = getConfig();
  const amountPesewas = toPesewas(feeAmountGhs);
  if (amountPesewas <= 0) return { ok: true, skipped: true, reason: "Zero fee" };

  // Dynamically resolve Telecel bank code
  const telecelBankCode = await resolveProviderCode("telecel");
  console.log(`[Escrow Site Fee] Resolving Telecel recipient: ${cfg.telecelPhone}, provider code: ${telecelBankCode}`);

  const recipientRes = await createTransferRecipient({
    name: cfg.telecelName,
    accountNumber: cfg.telecelPhone,
    bankCode: telecelBankCode,
    description: `RichStore Platform Escrow Fee - Order #${orderId}`
  });

  const transferRef = `FEE-TELECEL-${orderId}-${Date.now()}`;
  console.log(`[Escrow Site Fee] Dispatching GHs ${feeAmountGhs} to Telecel Cash recipient ${recipientRes.recipientCode}`);

  const transferRes = await initiateTransfer({
    amountInPesewas: amountPesewas,
    recipientCode: recipientRes.recipientCode,
    reason: `RichStore Escrow Fee for Order #${orderId}`,
    reference: transferRef
  });

  return {
    ok: true,
    recipientCode: recipientRes.recipientCode,
    transferCode: transferRes.transferCode,
    reference: transferRef,
    amountGhs: feeAmountGhs,
    telecelNumber: cfg.telecelPhone,
    status: transferRes.status || "success"
  };
}

/**
 * 7. Refund Transaction to Buyer (Automatic return to original payment method)
 * Endpoint: POST /refund
 */
async function refundTransaction({ transactionReference, amountInPesewas = null, merchantNote = "", customerNote = "" }) {
  const cfg = getConfig();

  if (!transactionReference) {
    throw new Error("Transaction reference is required for refund.");
  }

  if (!cfg.isConfigured) {
    console.log(`[Paystack Simulation] Executing refund for transaction: ${transactionReference}`);
    return {
      ok: true,
      simulation: true,
      status: "processed",
      refundId: `RFD_sim_${Date.now()}`,
      reference: transactionReference
    };
  }

  try {
    const payload = {
      transaction: transactionReference,
      merchant_note: merchantNote || "Order cancelled - Escrow refunded to buyer",
      customer_note: customerNote || "Your RichStore order has been refunded back to your original payment method."
    };
    if (amountInPesewas) {
      payload.amount = amountInPesewas;
    }

    const res = await paystackRequest("/refund", "POST", payload);
    return {
      ok: true,
      simulation: false,
      status: res.data.status,
      refundId: res.data.id,
      transactionReference,
      data: res.data
    };
  } catch (err) {
    console.error(`Paystack Refund Failed for ref ${transactionReference}:`, err.message);
    throw err;
  }
}

/**
 * 8. Cryptographic HMAC-SHA512 Webhook Signature Verification
 */
function verifyWebhookSignature(rawBodyBuffer, signatureHeader) {
  const cfg = getConfig();
  if (!cfg.isConfigured) return true; // In simulation mode, accept local testing
  if (!signatureHeader) return false;

  try {
    const hash = crypto
      .createHmac("sha512", cfg.secretKey)
      .update(rawBodyBuffer)
      .digest("hex");
    return hash === signatureHeader;
  } catch (err) {
    console.error("Webhook signature verification error:", err.message);
    return false;
  }
}

module.exports = {
  getConfig,
  toPesewas,
  fromPesewas,
  calculateEscrowFee,
  getMobileMoneyBanks,
  resolveProviderCode,
  detectProviderFromPhone,
  initializeTransaction,
  verifyTransaction,
  createTransferRecipient,
  initiateTransfer,
  payoutToSeller,
  payoutSiteFeeToTelecel,
  refundTransaction,
  verifyWebhookSignature
};
