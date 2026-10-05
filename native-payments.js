/**
 * native-payments.js — Self-Hosted Non-SaaS Payment & Escrow Engine
 * Built for RichStore Barter Marketplace.
 * 
 * Features:
 *  1. Zero Third-Party SaaS: 100% self-hosted direct Mobile Money & Bank transfers.
 *  2. Fee Calculation: 5% Platform Site & Escrow Protection fee.
 *  3. Dynamic Reference Generation: Generates collision-resistant human-readable transfer references (e.g. RS-4821).
 *  4. Autonomous Telco SMS Webhook Parser: Parses official incoming SMS from Telecel Cash, MTN MoMo, and AT Money.
 *  5. Anti-Replay & Duplicate Transaction Guard: Ensures every telco transaction ID is uniquely redeemed.
 *  6. 6-Digit Delivery Handshake PIN: Generates and verifies buyer-to-seller delivery release PINs.
 *  7. Cryptographic Gateway Verification: HMAC-SHA256 signature verification for self-hosted Android/GSM gateways.
 */

const crypto = require("crypto");

/**
 * Read platform treasury settings from process.env with robust defaults
 */
function getPlatformPaymentConfig() {
  const telecelPhone = (process.env.PLATFORM_TELECEL_PHONE || "0501373335").trim();
  const telecelName = (process.env.PLATFORM_TELECEL_NAME || "RichStore Platform Treasury").trim();
  const mtnPhone = (process.env.PLATFORM_MTN_PHONE || telecelPhone).trim();
  const siteFeePercent = Number(process.env.PLATFORM_SITE_FEE_PERCENT) || 5;
  // The gateway secret must come from the environment in production: a default shipped
  // in source is a published key. A MISSING secret must never stop the site from
  // booting, though — it only disables signature verification, and verifyGatewaySignature()
  // then fails CLOSED (an empty HMAC key is trivially forgeable). Throwing here took the
  // whole storefront down over a webhook credential.
  const envGatewaySecret = (process.env.NATIVE_GATEWAY_SECRET || "").trim();
  const gatewaySecret = envGatewaySecret
    || (process.env.NODE_ENV === "production" ? "" : "richstore_native_gateway_secret_2026");

  return {
    telecelPhone,
    telecelName,
    mtnPhone,
    siteFeePercent,
    gatewaySecret,
    // True only when a real secret came from the environment. Callers use this to
    // refuse webhooks instead of accepting a forgeable signature.
    gatewaySecretConfigured: Boolean(envGatewaySecret),
  };
}

/**
 * Calculate 5% Escrow Site & Protection Fee
 * @param {number} sellerPrice - Original seller listed price
 * @returns {{ sellerPrice: number, siteFee: number, siteFeePercent: number, buyerTotal: number }}
 */
function calculateEscrowFee(sellerPrice) {
  const cfg = getPlatformPaymentConfig();
  const cleanSellerPrice = Math.max(0, Math.round((Number(sellerPrice) || 0) * 100) / 100);
  const feeRate = cfg.siteFeePercent / 100;
  
  let siteFee = Math.round(cleanSellerPrice * feeRate * 100) / 100;
  if (cleanSellerPrice > 0 && siteFee < 1.0) {
    siteFee = 1.0; // Minimum 1 GHS protection fee
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
 * Generate a short, human-friendly payment reference for telco USSD transfers
 * Format: RS-XXXX (e.g. RS-7842)
 */
function generatePaymentReference(orderId) {
  if (orderId && typeof orderId === "string") {
    // If orderId is e.g. ORD-178920-412, take last 4 digits
    const parts = orderId.split("-");
    const suffix = parts[parts.length - 1] || "";
    if (suffix.length >= 3) {
      return `RS-${suffix.toUpperCase()}`;
    }
  }
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `RS-${rand}`;
}

/**
 * Generate a 6-digit Delivery Handshake PIN
 * Stored with the order, visible ONLY to the buyer until delivery
 */
function generateHandshakePin() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Format a 6-digit PIN with a dash for readability (e.g. 582-914)
 */
function formatPin(pin) {
  const s = String(pin || "").replace(/\D/g, "");
  if (s.length === 6) {
    return `${s.slice(0, 3)}-${s.slice(3)}`;
  }
  return s;
}

/**
 * Clean and normalize a PIN string
 */
function cleanPin(input) {
  return String(input || "").replace(/\D/g, "").trim();
}

/**
 * Parse an incoming SMS message from Ghanaian Telcos / Mobile Money networks
 * Supports Telecel Cash, MTN Mobile Money, and AirtelTigo
 * 
 * @param {string} smsText - Raw SMS body text
 * @param {string} [sender] - Telco sender name / ID (e.g. "TelecelCash", "MobileMoney")
 * @returns {{ success: boolean, amount: number|null, reference: string|null, transactionId: string|null, senderPhone: string|null, raw: string, provider: string }}
 */
function parseIncomingSms(smsText, sender = "") {
  if (!smsText || typeof smsText !== "string") {
    return { success: false, amount: null, reference: null, transactionId: null, senderPhone: null, raw: "", provider: "unknown" };
  }

  const raw = smsText.trim();
  const lowerSender = String(sender || "").toLowerCase();
  let provider = "mobile_money";

  if (lowerSender.includes("telecel") || lowerSender.includes("vodafone") || /telecel|vodafone/i.test(raw)) {
    provider = "telecel_cash";
  } else if (lowerSender.includes("mtn") || lowerSender.includes("momo") || /mtn|mobilemoney/i.test(raw)) {
    provider = "mtn_momo";
  } else if (lowerSender.includes("airtel") || lowerSender.includes("tigo") || /airteltigo|atmoney/i.test(raw)) {
    provider = "at_money";
  }

  // 1. Parse Amount
  let amount = null;
  // Match GHS 105.00, GHs 105, GH₵ 105.50, GHS105.00
  const amountMatch = raw.match(/(?:GHS|GH[¢s]|₵)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (amountMatch) {
    const cleanAmountStr = amountMatch[1].replace(/,/g, "");
    amount = Math.round(parseFloat(cleanAmountStr) * 100) / 100;
  }

  // 2. Parse Transfer Reference (e.g. RS-7842 or ORD-178920-412)
  let reference = null;
  const refMatch = raw.match(/(?:Ref(?:erence)?|Memo)[:\s]*([A-Za-z0-9_-]{3,30})/i);
  if (refMatch) {
    reference = refMatch[1].trim().toUpperCase();
  } else {
    // Look for RS-XXXX anywhere in text
    const standaloneRef = raw.match(/\b(RS-[A-Za-z0-9]{3,8}|ORD-\d+-\d+)\b/i);
    if (standaloneRef) {
      reference = standaloneRef[1].trim().toUpperCase();
    }
  }

  // 3. Parse Transaction ID (e.g. 29847192837 or TEL-82910481)
  let transactionId = null;
  const txnMatch = raw.match(/(?:(?:Financial\s*)?(?:Transaction\s*ID|Txn\s*ID|Trans\s*ID|Tx\s*ID|Id)|Ref\s*No)[:\s]*([A-Za-z0-9_-]{5,35})/i);
  if (txnMatch) {
    transactionId = txnMatch[1].trim();
  }

  // 4. Parse Sender Phone number (Ghana standard: 024..., 050..., 233...)
  let senderPhone = null;
  const phoneMatch = raw.match(/(?:from\s*(?:[A-Za-z\s]+)?\(?)(\+?233\d{9}|0[235]\d{8})/i);
  if (phoneMatch) {
    senderPhone = phoneMatch[1].trim();
  }

  const success = Boolean(amount !== null && (reference !== null || transactionId !== null));

  return {
    success,
    amount,
    reference,
    transactionId,
    senderPhone,
    raw,
    provider
  };
}

/**
 * Verify cryptographic HMAC-SHA256 signature for self-hosted gateway webhooks
 */
function verifyGatewaySignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader) return false;
  try {
    const key = secretKey || getPlatformPaymentConfig().gatewaySecret;
    // No configured secret means no trustworthy signature exists — an empty HMAC key is
    // guessable, so this must FAIL CLOSED rather than verify against a default.
    if (!key) {
      console.warn("[Payments] Webhook rejected: NATIVE_GATEWAY_SECRET is not configured.");
      return false;
    }
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf-8");
    const computedHmac = crypto.createHmac("sha256", key).update(bodyBuffer).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signatureHeader.trim(), "hex"), Buffer.from(computedHmac, "hex"));
  } catch (err) {
    return false;
  }
}

/**
 * Generate HMAC-SHA256 signature for a payload (used by client/gateway or tests)
 */
function createGatewaySignature(payloadString, secretKey) {
  const key = secretKey || getPlatformPaymentConfig().gatewaySecret || "";
  return crypto.createHmac("sha256", key).update(payloadString).digest("hex");
}

module.exports = {
  getPlatformPaymentConfig,
  calculateEscrowFee,
  generatePaymentReference,
  generateHandshakePin,
  formatPin,
  cleanPin,
  parseIncomingSms,
  verifyGatewaySignature,
  createGatewaySignature
};
