/**
 * Barter — a peer-to-peer marketplace (eBay-style clone)
 * Pure Node.js server: no external dependencies required.
 * Run with:  node server.js 
 * Then open: http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const busboy = require("busboy");
const sharp = require("sharp");
// Shared relational model (single source of truth with admin-server)
const { buildAdminRelations } = require("./relations");

// Load .env configuration if present (Zero-dependency production environment loader)
const ENV_FILE = path.join(__dirname, ".env");
if (fs.existsSync(ENV_FILE)) {
  try {
    const lines = fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const idx = trimmed.indexOf("=");
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  } catch (err) {
    console.error("Warning: Failed to parse .env file:", err.message);
  }
}

// ---------- Self-Hosted Native Payments & Escrow Module ----------
const nativePayments = require("./native-payments");
const calculateEscrowFee = nativePayments.calculateEscrowFee;

// ---------- Paystack gateway (cards + mobile money) ----------
// IMPORTANT: this module is inert until PAYSTACK_SECRET_KEY is set, and every one of
// its initialize / verify / transfer functions returns a *simulated success* when no
// key is configured. Every caller in this file therefore gates on gatewayIsLive()
// before trusting a result — otherwise an unconfigured gateway would mark orders paid
// and payouts successful without a cedi ever moving.
const paystack = require("./paystack");

// ---------- Africa's Talking SMS ----------
const AfricasTalking = require('africastalking');
// Credentials are read ONLY from .env / environment — never hardcoded in source.
const AT_API_KEY = (process.env.AT_API_KEY || '').trim();
const AT_USERNAME = (process.env.AT_USERNAME || '').trim();
const AT_SENDER_ID = (process.env.AT_SENDER_ID || '').trim(); // Optional: registered sender ID
const SMS_ENABLED = !!(AT_API_KEY && AT_USERNAME);  // Only send real SMS if credentials are set

let sms = null;
if (SMS_ENABLED) {
  const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
  sms = at.SMS;
  console.log(`✓ Africa's Talking SMS enabled (username: ${AT_USERNAME})`);
} else {
  console.log('⚠ SMS disabled — set AT_API_KEY and AT_USERNAME env vars to enable.');
  console.log('  OTP codes will be printed to console for development.\n');
}

async function sendSMS(phone, message) {
  if (!SMS_ENABLED || !sms) {
    // Fallback: without SMS credentials the code is printed ONLY when a developer has
    // explicitly opted in with OTP_DEV_ECHO=1. Server console output ends up in
    // terminals, CI logs and log shippers, so it must not leak live codes by default.
    if (OTP_DEV_ECHO) {
      console.log(`\n📱 [DEV SMS] To ${phone}: ${message}\n`);
    } else {
      console.log(`📱 [DEV SMS] To ${phone}: (code withheld — set OTP_DEV_ECHO=1 to print it)`);
    }
    return { success: true, dev: true };
  }
  try {
    const options = {
      to: [phone],
      message,
    };
    if (AT_SENDER_ID) options.from = AT_SENDER_ID;
    const result = await sms.send(options);
    console.log(`📱 SMS sent to ${phone}:`, JSON.stringify(result));
    return { success: true, result };
  } catch (err) {
    console.error(`❌ SMS failed to ${phone}:`, err.message);
    return { success: false, error: err.message };
  }
}

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Security / policy configuration ----------
// A proxy may only be trusted when the deployment explicitly says so; otherwise a
// client could forge X-Forwarded-For and bypass every per-IP rate limit.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Relaxed throttling for local development only — never enabled by default.
const DEV_RELAX_RATE_LIMITS = process.env.DEV_RELAX_RATE_LIMITS === '1';
// Echo OTP codes in API responses. Development only: while this is off, a code is
// never returned to the caller (it is logged to the server console instead).
const OTP_DEV_ECHO = process.env.OTP_DEV_ECHO === '1';
// Console the /admin.html shortcut redirects to (never taken from the Host header).
const ADMIN_CONSOLE_PORT = Number(process.env.ADMIN_PORT) || 4000;
// Image policy — must stay in sync with /posting-policy.html.
const MIN_IMAGE_DIMENSION = 400;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Platform payment settings (settlement phone, fee %, gateway secret) are resolved in
// ONE place — native-payments.js reads them from the environment. Never re-hardcode the
// settlement number elsewhere: it used to appear as a literal in several fallbacks and
// would drift the moment the number changed.
//
// Resolved LAZILY, never at module load. getPlatformPaymentConfig() can raise, and
// evaluating it here stopped the whole server from booting — the storefront went down
// over a webhook credential, and because an older process kept serving, the new payment
// routes never existed and every call answered "Unknown API route". A failure now
// degrades to empty settings so only the features that need them are affected.
function platformPaymentConfig() {
  try {
    return nativePayments.getPlatformPaymentConfig() || {};
  } catch (err) {
    console.error('[Payments] Payment configuration unavailable:', err.message);
    return {};
  }
}

// Browser origins allowed to call this API cross-origin. The storefront is served by
// this same server, so its calls are same-origin and need no entry here; the admin
// console runs on its own port, which IS cross-origin, so it is listed. Extend with
// ALLOWED_ORIGINS="https://a.example,https://b.example".
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  `http://localhost:${PORT},http://127.0.0.1:${PORT},http://localhost:${ADMIN_CONSOLE_PORT},http://127.0.0.1:${ADMIN_CONSOLE_PORT}`
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * May this Origin call the API cross-origin?
 * Besides the explicit allow-list, accept an origin whose HOSTNAME matches the host the
 * request actually arrived on. The admin console (:4000) calls the storefront API
 * (:3000); when it is opened from a LAN address (say http://192.168.1.5:4000) instead of
 * localhost, a strict list would block EVERY admin call — including the new payments
 * reconciliation tab — with an opaque browser CORS failure. This is still not a
 * wildcard: the caller must already be addressing this same machine.
 */
function isOriginAllowed(origin, req) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const parsedOrigin = new URL(origin);
    const requestHost = String((req.headers && req.headers.host) || '').split(':')[0];
    return Boolean(requestHost) && parsedOrigin.hostname === requestHost;
  } catch (_) {
    return false;
  }
}

// ---------- payment core ----------
// How long a buyer has to pay before the order expires and its stock is released.
const PAYMENT_WINDOW_MS = Number(process.env.PAYMENT_WINDOW_MS) || 24 * 60 * 60 * 1000;

/** True only when a real Paystack secret key is configured (never in simulation). */
function gatewayIsLive() {
  try {
    return Boolean(paystack.getConfig().isConfigured);
  } catch (_) {
    return false;
  }
}

/** Safe-to-publish description of how a buyer can pay right now. */
function paymentChannels() {
  const live = gatewayIsLive();
  const cfg = platformPaymentConfig();
  return {
    card: live,
    mobileMoneyGateway: live,
    offlineMobileMoney: true,
    momoNumber: cfg.telecelPhone || cfg.momoNumber || process.env.PLATFORM_TELECEL_PHONE || '',
    momoName: cfg.telecelName || cfg.platformName || 'RichStore Platform Treasury',
    publicKey: live ? String((paystack.getConfig() || {}).publicKey || '') : '',
    currency: cfg.currency || 'GHS'
  };
}

/** Absolute base URL for gateway callback links. Set PUBLIC_BASE_URL in production. */
function getPublicBaseUrl(req) {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const host = (req && req.headers && req.headers['host']) || `localhost:${PORT}`;
  const fwd = req && req.headers && req.headers['x-forwarded-proto'];
  const proto = fwd ? String(fwd).split(',')[0].trim() : 'http';
  return `${proto}://${host}`;
}

/**
 * Allocate the reference a buyer quotes when they transfer mobile money.
 * nativePayments.generatePaymentReference() derives a SHORT RS-XXX from the order id's
 * last digits, which can repeat across orders. While a reference is still pending we
 * widen it to RS-XXXXXX — still inside the RS-[A-Za-z0-9]{3,8} pattern the SMS parser
 * recognises — so an incoming transfer can never be attributed to the wrong order.
 */
function allocatePaymentReference(db, orderId) {
  const taken = new Set(
    (db.orders || [])
      .filter((o) => o && o.paymentStatus === 'pending' && o.paymentReference)
      .map((o) => String(o.paymentReference).toUpperCase())
  );
  const base = String(nativePayments.generatePaymentReference(String(orderId))).toUpperCase();
  if (!taken.has(base)) return base;
  for (let i = 0; i < 25; i++) {
    const candidate = 'RS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * The ONE funnel through which an order becomes paid. Every source — the Paystack
 * webhook, the gateway verify call, the telco SMS webhook, and an admin confirming a
 * mobile-money transfer — lands here so the rules cannot drift apart:
 *   • idempotent, so a replayed confirmation can never double-credit;
 *   • the received amount must cover the order total (1 pesewa of rounding tolerance);
 *   • an expired, cancelled or refunded order can never be revived by money arriving late.
 * The escrow deposit that checkout used to write is written HERE instead, because this
 * is the first moment money actually exists. Escrow only becomes 'Held' on this path.
 */
function markOrderPaid(db, order, { source, reference, transactionId, amount } = {}) {
  if (!order) return { ok: false, error: 'Order not found' };

  if (order.paymentStatus === 'paid' &&
      ['Held', 'Released', 'Refunded'].includes(String(order.escrowStatus))) {
    return { ok: true, alreadyPaid: true, order };
  }
  if (order.paymentStatus === 'expired' || order.status === 'Expired') {
    return { ok: false, error: 'This order expired before payment arrived. The buyer must place a new order.' };
  }
  if (order.status === 'Cancelled' || order.escrowStatus === 'Refunded') {
    return { ok: false, error: 'This order was cancelled or refunded and cannot be paid.' };
  }
  // Never re-open an order whose money has already gone out: a late-arriving payment,
  // or an admin confirmation on a legacy order, must not drag a settled order back
  // into escrow.
  if (order.escrowStatus === 'Released' || order.status === 'Released') {
    return { ok: false, error: 'This order has already been settled and cannot be marked paid.' };
  }

  const expected = Math.round((Number(order.total) || 0) * 100);
  if (amount !== undefined && amount !== null && Number.isFinite(Number(amount))) {
    const received = Math.round(Number(amount) * 100);
    if (received < expected) {
      return {
        ok: false,
        error: `Payment of GHs ${(received / 100).toFixed(2)} is less than the order total of GHs ${(expected / 100).toFixed(2)}.`
      };
    }
  }

  const nowIso = new Date().toISOString();
  order.paymentStatus = 'paid';
  order.paymentConfirmed = true;
  order.paymentSource = source || 'unknown';
  order.paidAt = nowIso;
  if (reference) order.paymentTransactionReference = String(reference);
  if (transactionId) order.paymentTransactionId = String(transactionId);
  // Escrow protection starts only now.
  order.escrowStatus = 'Held';
  order.status = 'Held';
  order.siteFeeApplied = true;
  order.paymentExpiresAt = null;
  if (!Array.isArray(order.paymentAudit)) order.paymentAudit = [];
  order.paymentAudit.push({
    at: nowIso,
    source: order.paymentSource,
    reference: reference ? String(reference) : null,
    transactionId: transactionId ? String(transactionId) : null,
    amount: order.total
  });

  if (db.platformTreasury) {
    if (!Array.isArray(db.platformTreasury.transactions)) db.platformTreasury.transactions = [];
    db.platformTreasury.transactions.push({
      id: 'ESCROW-' + Date.now(),
      type: 'ESCROW_DEPOSIT',
      amount: order.total,
      siteFee: order.siteFee,
      sellerPayout: order.subtotal,
      referenceId: order.id,
      status: 'HELD',
      source: order.paymentSource,
      createdAt: nowIso
    });
  }

  return { ok: true, order };
}

/**
 * Release reserved stock for unpaid orders that ran past PAYMENT_WINDOW_MS.
 * Checkout still decrements stock immediately (so two buyers cannot both claim the
 * last unit while a payment page is open), so an abandoned payment MUST give the
 * stock back or the catalogue quietly bleeds inventory.
 */
function sweepExpiredPayments(db) {
  const orders = Array.isArray(db.orders) ? db.orders : [];
  const now = Date.now();
  let expiredCount = 0;
  for (const order of orders) {
    if (!order || order.paymentStatus !== 'pending') continue;
    const exp = Date.parse(order.paymentExpiresAt || order.escrowExpiresAt || '');
    if (!Number.isFinite(exp) || exp > now) continue;
    order.paymentStatus = 'expired';
    order.status = 'Expired';
    order.escrowStatus = 'None';
    order.expiredAt = new Date().toISOString();
    // Reuse restoreOrderStock instead of adjusting stock by hand: it is idempotent
    // (per-item `restocked` plus the order-wide `reversed` flag), so a later cancel or
    // refund on this same order can never return the same units to the catalogue twice.
    restoreOrderStock(db, order, 'expiry-sweep');
    expiredCount++;
  }
  if (expiredCount > 0) {
    writeDB(db);
    console.log(`[Payments] Expired ${expiredCount} unpaid order(s); reserved stock released.`);
  }
  return expiredCount;
}

// ---------- tiny file-based "database" ----------
// ---------- Production File-Based Atomic Database ----------
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (err) {
    try {
      const waitTill = Date.now() + 30;
      while (Date.now() < waitTill) {}
      return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    } catch (_) {
      console.error("Failed to read db.json:", err.message);
      return { users: [], listings: [], orders: [], sessions: {}, otpCodes: {}, verifiedPhones: {} };
    }
  }
}

// Atomic file write with retry/fallback prevents corruption & handles Windows/OneDrive file locking
function writeDB(data) {
  const content = JSON.stringify(data, null, 2);
  const tmpPath = DB_PATH + ".tmp." + Date.now() + "." + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmpPath, content, "utf-8");
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpPath, DB_PATH);
      renamed = true;
      break;
    } catch (e) {
      if (attempt === 4) break;
      const waitTill = Date.now() + 30 * (attempt + 1);
      while (Date.now() < waitTill) {}
    }
  }
  if (!renamed) {
    try {
      fs.writeFileSync(DB_PATH, content, "utf-8");
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    } catch (e) {
      console.error("Failed to write db.json:", e.message);
    }
  }
}

// ---------- Production Security & Anti-Abuse Engine ----------
const rateLimits = new Map();

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  if (DEV_RELAX_RATE_LIMITS) {
    const isLocal = key.includes('127.0.0.1') || key.includes('::1') || key.includes('::ffff:127.0.0.1') || key.includes('localhost');
    if (isLocal) {
      maxRequests = Math.max(maxRequests * 20, 200);
    }
  }
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }
  if (entry.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count };
}

function getClientIP(req) {
  // X-Forwarded-For is attacker-controlled unless a reverse proxy sets it. Only
  // honour it when the deployment declares TRUST_PROXY=1.
  if (TRUST_PROXY) {
    const forwarded = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

// Periodic cleanup of rate limit table every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries()) {
    if (now > v.resetAt) rateLimits.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ---------- Helpers & Security Headers ----------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  res.end(body);
}

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB protection against Memory Exhaustion / DoS
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let received = 0;
    req.on("data", (c) => {
      received += c.length;
      if (received > MAX_PAYLOAD_BYTES) {
        req.destroy();
        return reject(new Error("Payload Too Large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let received = 0;
    req.on("data", (c) => {
      received += c.length;
      if (received > MAX_PAYLOAD_BYTES) {
        req.destroy();
        return reject(new Error("Payload Too Large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let relativePath = pathname === "/" ? "/index.html" : pathname;
  if (relativePath === "/manage-order.html") relativePath = "/manage-orders.html";
  if (relativePath === "/buyer-order.html") relativePath = "/buyer-orders.html";
  if (relativePath === "/admin.html") {
    // The Host header is client-controlled, so it is sanitised before being used in
    // a Location header — otherwise this shortcut becomes an open redirect.
    const rawHost = String(req.headers.host || '').split(':')[0];
    const safeHost = /^[a-z0-9.\-]+$/i.test(rawHost) ? rawHost : 'localhost';
    res.writeHead(302, { Location: `http://${safeHost}:${ADMIN_CONSOLE_PORT}/` });
  }
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, "");
  const resolvedPublicDir = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(resolvedPublicDir, "." + safePath);

  // Strict boundary check: the file must reside inside PUBLIC_DIR. Comparing with a
  // trailing separator prevents a sibling directory whose name merely starts with
  // "public" (e.g. "public_backup") from passing the check.
  const publicPrefix = resolvedPublicDir.endsWith(path.sep) ? resolvedPublicDir : resolvedPublicDir + path.sep;
  if (filePath !== resolvedPublicDir && !filePath.startsWith(publicPrefix)) {
    res.writeHead(403, { 
      "Content-Type": "text/plain",
      "X-Content-Type-Options": "nosniff" 
    });
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 
        "Content-Type": "text/html",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN"
      });
      return res.end("<h1>404 Not Found</h1><p><a href='/'>Go home</a></p>");
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] || "application/octet-stream";
    
    // Add caching headers for static assets
    let cacheControl = "public, max-age=3600"; // 1 hour default
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      cacheControl = "public, max-age=0, must-revalidate"; // No cache for HTML/JS/CSS
    } else if (['.png', '.svg', '.ico', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      cacheControl = "public, max-age=86400"; // 24 hours for images
    }
    
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(content);
  });
}

// ---------- auth helpers ----------
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}
function getUserByUsername(db, username) {
  // Case-insensitive lookup: prevents duplicate accounts that differ only by case
  return Array.isArray(db.users)
    ? db.users.find((u) => String(u.username).toLowerCase() === String(username).toLowerCase())
    : undefined;
}

/**
 * Delete the given session tokens using a FRESH read of the database.
 *
 * Session expiry cleanup runs on ordinary requests, before the handler has called
 * refreshDb(). Writing that request's initial snapshot straight back to disk could
 * therefore clobber a change another request had already committed (for example
 * resurrecting stock that a concurrent checkout had just decremented). Re-reading
 * here means we only ever remove the session keys and touch nothing else.
 */
function purgeSessions(tokens) {
  const list = (Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean);
  if (list.length === 0) return;
  const fresh = refreshDb();
  if (!fresh.sessions) return;
  let changed = false;
  for (const t of list) {
    if (fresh.sessions[t]) {
      delete fresh.sessions[t];
      changed = true;
    }
  }
  if (changed) writeDB(fresh);
}

function cleanupSessions(db) {
  const now = Date.now();
  if (!db.sessions || !Array.isArray(db.users)) return;
  const expired = [];
  for (const [token, sess] of Object.entries(db.sessions)) {
    const exp = Number(sess && sess.expiresAt); // coerce: a string date must not bypass expiry
    const userExists = db.users.some((u) => u.id === (sess && sess.userId));
    if (!Number.isFinite(exp) || exp <= now || !userExists) expired.push(token);
  }
  purgeSessions(expired);
}

function getUserFromToken(db, token) {
  if (!token || !db.sessions) return null;
  const sess = db.sessions[token];
  if (!sess) return null;
  const exp = Number(sess.expiresAt); // coerce: invalid/string expiry is treated as expired
  const user = (Array.isArray(db.users) ? db.users : []).find((u) => u.id === sess.userId);
  if (!Number.isFinite(exp) || exp <= Date.now() || !user) {
    // session expired or its user no longer exists
    purgeSessions([token]);
    return null;
  }
  return user;
}

// ---------- OTP helpers ----------
const OTP_TTL = 1000 * 60 * 10; // 10 minutes
const OTP_COOLDOWN = 1000 * 60;  // 1 minute between sends
const MAX_OTP_ATTEMPTS = 5;      // a code is cancelled after this many wrong guesses

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function validatePhoneGH(phone) {
  // Strip spaces, dashes
  let p = String(phone).replace(/[\s\-()]/g, '');
  // Accept: 0XXXXXXXXX, +233XXXXXXXXX, 233XXXXXXXXX
  if (/^0\d{9}$/.test(p)) {
    p = '+233' + p.slice(1);
  } else if (/^233\d{9}$/.test(p)) {
    p = '+' + p;
  } else if (/^\+233\d{9}$/.test(p)) {
    // already normalized
  } else {
    return null; // invalid
  }
  return p;
}

function isSellerPhoneVerified(db, sellerUsername, sellerPhone) {
  const cleanDigits = (p) => (p ? String(p).replace(/\D/g, '').slice(-9) : '');
  const target = cleanDigits(sellerPhone);

  // 1. Check if the seller user account has verified their phone
  const sellerUser = (db.users || []).find(
    (u) => u.username && u.username.toLowerCase() === String(sellerUsername || '').toLowerCase()
  );
  if (sellerUser && db.verifiedPhones) {
    const verifiedEntry = db.verifiedPhones[String(sellerUser.id)];
    if (verifiedEntry) {
      if (!target || cleanDigits(verifiedEntry.phone) === target) {
        return true;
      }
    }
  }

  // 2. Check if the phone number itself is in verifiedPhones
  if (target && db.verifiedPhones) {
    for (const key of Object.keys(db.verifiedPhones)) {
      const entry = db.verifiedPhones[key];
      if (entry && cleanDigits(entry.phone) === target) {
        return true;
      }
    }
  }

  return false;
}

function cleanupOTPs(db) {
  if (!db.otpCodes) return;
  const now = Date.now();
  const expired = [];
  for (const [phone, otp] of Object.entries(db.otpCodes)) {
    if (otp.expiresAt <= now) expired.push(phone);
  }
  if (expired.length === 0) return;
  // Same reason as purgeSessions: only remove these keys, and only from a fresh
  // read, so a concurrent request's committed change is never overwritten.
  const fresh = refreshDb();
  if (!fresh.otpCodes) return;
  let changed = false;
  for (const phone of expired) {
    if (fresh.otpCodes[phone]) {
      delete fresh.otpCodes[phone];
      changed = true;
    }
  }
  if (changed) writeDB(fresh);
}

// Re-read the DB right before a mutation completes, so a request never writes
// over state that another request changed while it was awaiting its body.
// All post-await work is synchronous, so a fresh read + sync mutation is atomic.
function refreshDb() {
  const d = readDB();
  d.users = d.users || [];
  d.sessions = d.sessions || {};
  d.otpCodes = d.otpCodes || {};
  d.verifiedPhones = d.verifiedPhones || {};
  if (typeof d.nextUserId !== 'number') d.nextUserId = 1;
  return d;
}

// ---------- Atomic Checkout Queue (Concurrency Mutex) ----------
// Chains all checkout operations sequentially in memory so only one checkout can inspect inventory,
// decrement stock, and commit the order to disk at any given microsecond.
// This guarantees zero race conditions or overselling even under high concurrency.
let checkoutQueue = Promise.resolve();

function runAtomicCheckout(task) {
  return new Promise((resolve, reject) => {
    checkoutQueue = checkoutQueue
      .catch(() => {}) // Prevent a previous checkout failure from halting subsequent orders
      .then(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
  });
}

// Usernames that can never be registered by new signups (privilege-escalation guard)
const RESERVED_USERNAMES = ['admin', 'wedidit', 'ayikoo', 'emmanuelk', 'ricchy', 'kumodjisenyo'];

// Admin status is granted ONLY through db.admins (numeric user ids), never by username,
// so registering a name like "admin" or "ayikoo" cannot escalate to admin privileges.
function normalizeAdmins(db) {
  if (!Array.isArray(db.admins)) db.admins = [];
  // Legacy migration: resolve any username entries to numeric ids
  db.admins = db.admins.map((a) => {
    const n = Number(a);
    if (Number.isInteger(n) && n > 0) return n;
    const u = (db.users || []).find(
      (x) => x.username && String(x.username).toLowerCase() === String(a).toLowerCase()
    );
    return u ? u.id : null;
  }).filter((id) => id !== null);
}

function isAdminUser(db, user) {
  if (!user) return false;
  normalizeAdmins(db);
  const id = Number(user.id);
  return Number.isInteger(id) && db.admins.includes(id);
}

function sanitizeUser(user, db) {
  if (!user) return null;
  const isAdmin = isAdminUser(db, user);
  const phoneVerified = !!(db.verifiedPhones && db.verifiedPhones[String(user.id)]);
  const phone = user.phone || (db.verifiedPhones && db.verifiedPhones[String(user.id)] && db.verifiedPhones[String(user.id)].phone) || '';
  const accountType = user.accountType || 'seller';
  return {
    id: user.id,
    username: user.username,
    accountType,
    phone,
    phoneVerified,
    isAdmin,
    storeName: user.storeName || (accountType === 'seller' ? user.username + "'s Store" : ''),
    storeLocation: user.storeLocation || '',
    storeGpsAddress: user.storeGpsAddress || '',
    name: user.name || (accountType === 'buyer' ? user.username : ''),
    location: user.location || '',
    gpsAddress: user.gpsAddress || ''
  };
}

function migrateUserSchema(db) {
  if (!Array.isArray(db.users)) return;
  let changed = false;
  for (const u of db.users) {
    if (!u.accountType) {
      u.accountType = 'seller';
      changed = true;
    }
    if (u.accountType === 'seller') {
      if (!u.storeName) { u.storeName = u.username + "'s Store"; changed = true; }
      if (!u.storeLocation) { u.storeLocation = 'Accra, Ghana'; changed = true; }
    }
    if (db.verifiedPhones && db.verifiedPhones[String(u.id)] && !u.phone) {
      u.phone = db.verifiedPhones[String(u.id)].phone;
      changed = true;
    }
  }

  // Backfill sellerId on listings if missing
  if (Array.isArray(db.listings)) {
    for (const l of db.listings) {
      if (!l.sellerId && l.seller) {
        const u = db.users.find(x => x.username && x.username.toLowerCase() === l.seller.toLowerCase());
        if (u) {
          l.sellerId = u.id;
          changed = true;
        }
      }
    }
  }

  // Backfill buyerId on orders and sellerId on order items if missing
  if (Array.isArray(db.orders)) {
    for (const o of db.orders) {
      if (!o.buyerId && o.buyer) {
        const u = db.users.find(x => x.username && x.username.toLowerCase() === o.buyer.toLowerCase());
        if (u) {
          o.buyerId = u.id;
          changed = true;
        }
      }
      if (Array.isArray(o.items)) {
        for (const it of o.items) {
          if (!it.sellerId && it.seller) {
            const u = db.users.find(x => x.username && x.username.toLowerCase() === it.seller.toLowerCase());
            if (u) {
              it.sellerId = u.id;
              changed = true;
            }
          }
          if (!it.sellerPhone && it.seller) {
            const u = db.users.find(x => x.username && x.username.toLowerCase() === it.seller.toLowerCase());
            if (u && u.phone) {
              it.sellerPhone = u.phone;
              changed = true;
            }
          }
        }
      }
    }
  }

  // Listings are NEVER destroyed by a migration. A row with a missing, blank or
  // otherwise invalid stock value used to be deleted here — which silently
  // destroyed real listings just for starting the server. Such rows are repaired
  // to 0 (sold out) and kept so the owner can restock them and order history keeps
  // resolving.
  if (Array.isArray(db.listings)) {
    for (const l of db.listings) {
      if (!l) continue;
      const stockNum = Number(l.stock);
      if (!Number.isFinite(stockNum) || stockNum < 0) {
        l.stock = 0;
        changed = true;
      } else if (stockNum !== l.stock) {
        l.stock = stockNum;
        changed = true;
      }
    }
  }

  // Keep the listing id counter ahead of every id already in the file, so a newly
  // created listing can never collide with an existing one. (See POST /api/listings.)
  if (Array.isArray(db.listings)) {
    const maxListingId = db.listings.reduce((max, l) => Math.max(max, Number(l && l.id) || 0), 0);
    if (typeof db.nextId !== 'number' || !Number.isFinite(db.nextId) || db.nextId <= maxListingId) {
      db.nextId = maxListingId + 1;
      changed = true;
    }
  }

  // Orders created before the payment integration carry no paymentStatus, yet checkout
  // used to stamp them as paid and held. No money was ever verified for them, so they
  // are labelled "unverified": they appear in the admin reconciliation queue, and
  // releasing funds on one requires an administrator to confirm the payment first.
  if (Array.isArray(db.orders)) {
    for (const o of db.orders) {
      if (!o || typeof o !== 'object') continue;
      if (!o.paymentStatus) {
        o.paymentStatus = 'unverified';
        changed = true;
      }
      if (!o.paymentReference) {
        o.paymentReference = o.paymentRef || `RS-${String(o.id || '').slice(-4)}`;
        changed = true;
      }
      if (o.paymentSource === undefined) {
        o.paymentSource = 'pre-integration';
        changed = true;
      }
    }
  }

  if (!db.otpCodes) { db.otpCodes = {}; changed = true; }
  if (!db.verifiedPhones) { db.verifiedPhones = {}; changed = true; }
  if (changed) writeDB(db);
}

function phonesMatch(phoneA, phoneB) {
  const clean = (p) => (p ? String(p).replace(/\D/g, '') : '');
  const a = clean(phoneA);
  const b = clean(phoneB);
  if (!a || !b) return false;
  if (a === b) return true;
  const normA = a.startsWith('233') ? a.slice(3) : (a.startsWith('0') ? a.slice(1) : a);
  const normB = b.startsWith('233') ? b.slice(3) : (b.startsWith('0') ? b.slice(1) : b);
  return normA === normB || normA.endsWith(normB) || normB.endsWith(normA);
}

/**
 * Ownership of an order item.
 *
 * SECURITY: only IMMUTABLE identifiers may establish ownership. The account's
 * phone number and store name are user-editable profile fields (and a phone can
 * be changed without consent), so they are never used as identity here — doing so
 * let one account read and mutate another account's orders.
 */
function isItemForSeller(item, user, db) {
  if (!item || !user) return false;
  const uname = String(user.username || '').trim().toLowerCase();
  const userId = Number(user.id);

  // 1. Immutable account id recorded on the order line
  if (item.sellerId && Number(item.sellerId) === userId) return true;

  // 2. Listing owner username (stable; usernames cannot be changed)
  if (item.seller && String(item.seller).trim().toLowerCase() === uname) return true;

  // 3. Legacy fallback: resolve the listing the line came from
  if (db && Array.isArray(db.listings) && item.id) {
    const listing = db.listings.find(l => Number(l.id) === Number(item.id));
    if (listing) {
      if (listing.sellerId && Number(listing.sellerId) === userId) return true;
      if (listing.seller && String(listing.seller).trim().toLowerCase() === uname) return true;
    }
  }

  return false;
}

/**
 * Ownership of an order (buyer side).
 * SECURITY: see isItemForSeller — phone numbers are never identity.
 */
function isOrderForBuyer(order, user, db) {
  if (!order || !user) return false;
  const uname = String(user.username || '').trim().toLowerCase();
  const userId = Number(user.id);

  if (order.buyerId && Number(order.buyerId) === userId) return true;
  if (order.buyer && String(order.buyer).trim().toLowerCase() === uname) return true;

  return false;
}


/**
 * Restore the stock reserved by an order when it is cancelled:
 *   - stock reserved by the order is returned to each listing that still exists
 *
 * Idempotent: the order is flagged once restored, so a repeated cancellation can
 * never restock twice.
 */
function restoreOrderStock(db, order, actor) {
  const result = { restored: [], missingListings: [] };
  if (!order || order.reversed) return result;

  const items = Array.isArray(order.items) ? order.items : [];
  for (const it of items) {
    if (!it || it.restocked) continue;
    const listing = (db.listings || []).find(l => Number(l.id) === Number(it.id));
    if (!listing) {
      it.restocked = true;
      result.missingListings.push(it.id);
      continue;
    }
    const qty = Math.max(1, Number(it.qty) || 1);
    listing.stock = (Number(listing.stock) || 0) + qty;
    it.restocked = true;
    result.restored.push({ id: listing.id, qty, stock: listing.stock });
  }

  order.reversed = true;
  order.reversedAt = new Date().toISOString();
  order.reversedBy = actor || 'system';
  return result;
}

// ---------- Product Posting & Content Moderation Policy Validator ----------
const PROHIBITED_ADULT_TERMS = [
  'porn', 'porno', 'pornography', 'xxx', 'sex toy', 'sextoy', 'dildo', 'vibrator',
  'fleshlight', 'bondage', 'fetish', 'erotic', 'nudity', 'nude photo', 'naked photo',
  'nude', 'naked', 'camgirl', 'onlyfans', 'escort', 'sensual massage', 'prostitution', 'csam', 'child sexual',
  'underage sex', 'rape', 'sexual exploit', 'pedophile', 'pedophilia', 'nsfw',
  'blowjob', 'handjob', 'orgasm', 'masturbat', 'adult dvd', 'adult magazine',
  'sexy video', 'boobs photo', 'nude picture', 'non-consensual', 'voyeur'
];

const DECEPTIVE_MISMATCH_PATTERNS = [
  /empty\s+box\s+(only)?/i,
  /picture\s+(only|of\s+item)/i,
  /photo\s+only/i,
  /box\s+only/i,
  /no\s+(phone|item|device)\s+inside/i,
  /read\s+description\s+before\s+bidding/i
];

function validateProductPolicy({ title, description, category }) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();

  // 1. Check for Nudity, Pornography & Sexual Exploitation
  for (const term of PROHIBITED_ADULT_TERMS) {
    const regex = new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (regex.test(text)) {
      return {
        valid: false,
        clause: 'Section 2.1 & 2.2 — Prohibited Adult, Nudity & Sexual Exploitation Content',
        error: 'Listing rejected by RichStore Content Safety: Items related to nudity, pornography, adult novelties, or sexual exploitation are strictly prohibited.'
      };
    }
  }

  // 2. Check for Deceptive Description & Bait-and-Switch Patterns
  for (const pattern of DECEPTIVE_MISMATCH_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        clause: 'Section 2.4 — Deceptive Listings & Mismatched Descriptions',
        error: 'Listing rejected: Deceptive listings (e.g. empty boxes, picture-only sales) are prohibited to ensure buyer transparency.'
      };
    }
  }

  // 3. Category & Description Mismatch Check
  const cat = String(category || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (cat.includes('electronic')) {
    if ((t.includes('dress') || t.includes('high heels') || t.includes('wig') || t.includes('lipstick')) &&
        !t.includes('electronic') && !t.includes('hair dryer') && !t.includes('clipper') && !t.includes('straightener')) {
      return {
        valid: false,
        clause: 'Section 2.4 — Category & Description Mismatch',
        error: `Listing rejected: Category "Electronics" does not match the product "${title}". Please select the correct category.`
      };
    }
  } else if (cat.includes('book')) {
    if (t.includes('smartphone') || t.includes('laptop') || t.includes('sneaker') || t.includes('refrigerator')) {
      return {
        valid: false,
        clause: 'Section 2.4 — Category & Description Mismatch',
        error: `Listing rejected: Category "Books" does not match the product "${title}". Please select the appropriate category.`
      };
    }
  }

  return { valid: true };
}

// ---------- Automated Computer-Vision Nudity & NSFW Image Inspection ----------
async function detectNudity(imageBufferOrPath) {
  try {
    const { data, info } = await sharp(imageBufferOrPath)
      .resize(120, 120, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const totalPixels = width * height;
    const channels = info.channels;
    const skinGrid = new Uint8Array(totalPixels);

    let totalSkinPixels = 0;

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * channels;
      // Skip transparent pixels if RGBA
      if (channels >= 4 && data[idx + 3] < 128) {
        continue;
      }

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // RGB criteria (Peer et al.)
      const rgbSkin = (
        r > 95 && g > 40 && b > 20 &&
        (Math.max(r, g, b) - Math.min(r, g, b)) > 15 &&
        Math.abs(r - g) > 15 &&
        r > g && r > b
      );

      // YCbCr conversion & criteria (Kovac et al.)
      const y  =  0.299000 * r + 0.587000 * g + 0.114000 * b;
      const cb = -0.168736 * r - 0.331264 * g + 0.500000 * b + 128;
      const cr =  0.500000 * r - 0.418688 * g - 0.081312 * b + 128;
      const ycbcrSkin = (y > 75 && cb >= 85 && cb <= 135 && cr >= 135 && cr <= 180);

      // HSV conversion
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const sat = max === 0 ? 0 : delta / max;
      const val = max / 255;
      let hue = 0;
      if (delta !== 0) {
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue = Math.round(hue * 60);
        if (hue < 0) hue += 360;
      }
      const hsvSkin = ((hue >= 0 && hue <= 50) || hue >= 340) && (sat >= 0.15 && sat <= 0.68) && (val >= 0.35);

      // Multi-color space consensus (at least two models agree)
      if ((rgbSkin && ycbcrSkin) || (rgbSkin && hsvSkin) || (ycbcrSkin && hsvSkin)) {
        skinGrid[i] = 1;
        totalSkinPixels++;
      }
    }

    const skinRatio = (totalSkinPixels / totalPixels);

    // BFS connected component analysis to find largest contiguous skin region
    const visited = new Uint8Array(totalPixels);
    let largestRegion = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (skinGrid[idx] === 1 && visited[idx] === 0) {
          let regionSize = 0;
          const queue = [idx];
          visited[idx] = 1;

          while (queue.length > 0) {
            const curr = queue.pop();
            regionSize++;
            const cx = curr % width;
            const cy = Math.floor(curr / width);

            const neighbors = [
              cy > 0 ? (cy - 1) * width + cx : -1,
              cy < height - 1 ? (cy + 1) * width + cx : -1,
              cx > 0 ? cy * width + (cx - 1) : -1,
              cx < width - 1 ? cy * width + (cx + 1) : -1
            ];

            for (const n of neighbors) {
              if (n >= 0 && skinGrid[n] === 1 && visited[n] === 0) {
                visited[n] = 1;
                queue.push(n);
              }
            }
          }

          if (regionSize > largestRegion) {
            largestRegion = regionSize;
          }
        }
      }
    }

    const largestRatio = (largestRegion / totalPixels);

    // Nudity rule:
    // Nude/NSFW photo has:
    // - Skin ratio >= 30% AND largest contiguous region >= 20%
    // OR largest contiguous region >= 35%
    const isNude = (skinRatio >= 0.30 && largestRatio >= 0.20) || (largestRatio >= 0.35);

    return {
      isNude,
      skinRatio,
      largestRatio
    };
  } catch (err) {
    // FAIL CLOSED. If the scan cannot complete, the image must not reach the
    // catalog: returning isNude:false here let a malformed or truncated upload
    // bypass the safety scan entirely. isNude stays true so every existing caller
    // rejects the file even if it never checks scanFailed.
    console.error("Nudity detection error (image rejected — failing closed):", err.message);
    return { isNude: true, skinRatio: 0, largestRatio: 0, scanFailed: true, error: err.message };
  }
}

// ---------- API route handlers ----------
async function handleApi(req, res, pathname, query) {
  let db = readDB();
  db.users = db.users || [];
  db.sessions = db.sessions || {};
  db.otpCodes = db.otpCodes || {};
  db.verifiedPhones = db.verifiedPhones || {};
  if (typeof db.nextUserId !== 'number') db.nextUserId = 1;

  // cleanup expired sessions and OTPs on each API call
  cleanupSessions(db);
  cleanupOTPs(db);
  // Give back stock reserved by orders that were never paid (a no-op most calls).
  // Swept from a FRESH read, because expiry writes the whole database back — running it
  // on this request's initial snapshot could discard a change another request committed
  // while this one was reading its body.
  sweepExpiredPayments(refreshDb());

  // ---------- payment webhooks ----------
  // Public by design: authenticated by cryptographic signature, never by a user token,
  // so they are handled before any account check.

  // POST /api/webhooks/paystack — Paystack notifies us that a charge succeeded.
  if (req.method === 'POST' && pathname === '/api/webhooks/paystack') {
    let raw;
    try { raw = await readRawBody(req); } catch { return sendJSON(res, 400, { error: 'Unreadable body' }); }

    // Without a configured key there is no way to verify a signature, so nothing may
    // be accepted — paystack.verifyWebhookSignature() returns true when unconfigured.
    if (!gatewayIsLive()) return sendJSON(res, 503, { error: 'Payment gateway is not configured.' });
    if (!paystack.verifyWebhookSignature(raw, req.headers['x-paystack-signature'])) {
      console.warn('[Paystack Webhook] Rejected: invalid HMAC signature.');
      return sendJSON(res, 401, { error: 'Invalid signature' });
    }

    let event;
    try { event = JSON.parse(raw.toString('utf-8')); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const data = (event && event.data) || {};
    const reference = String(data.reference || '').toUpperCase();
    const metaOrderId = String(((data.metadata || {}).orderId) || '').trim();

    const fresh = refreshDb();
    const order = (fresh.orders || []).find((o) =>
      (reference && String(o.paymentReference || '').toUpperCase() === reference) ||
      (metaOrderId && String(o.id) === metaOrderId)
    );

    if (!order) {
      // Acknowledge so Paystack stops retrying, but log loudly for reconciliation.
      console.error(`[Paystack Webhook] No order matches reference "${reference}" (event ${event && event.event}).`);
      return sendJSON(res, 200, { received: true, matched: false });
    }
    if (!(event && event.event === 'charge.success')) {
      return sendJSON(res, 200, { received: true, ignored: event && event.event });
    }

    // Defence in depth: never trust the payload's own amount — ask the gateway.
    try {
      const verification = await paystack.verifyTransaction(reference);
      if (!verification || verification.ok !== true || verification.status !== 'success') {
        console.error(`[Paystack Webhook] Verification did not confirm reference ${reference}.`);
        return sendJSON(res, 200, { received: true, verified: false });
      }
      const receivedGhs = Number(verification.amount) / 100;
      const applied = markOrderPaid(fresh, order, {
        source: 'paystack',
        reference,
        transactionId: String(data.id || ''),
        amount: receivedGhs
      });
      if (!applied.ok) {
        console.error(`[Paystack Webhook] Order ${order.id} not marked paid: ${applied.error}`);
        return sendJSON(res, 200, { received: true, markedPaid: false });
      }
      writeDB(fresh);
      console.log(`[Paystack Webhook] Order ${order.id} paid (GHs ${receivedGhs.toFixed(2)}).`);
      return sendJSON(res, 200, { received: true, markedPaid: true });
    } catch (err) {
      console.error('[Paystack Webhook] Verification failed:', err.message);
      return sendJSON(res, 500, { error: 'Verification failed' });
    }
  }

  // POST /api/webhooks/telco — an SMS forwarder posts the telco transfer SMS here.
  // Body: the raw SMS text, or JSON { sms, sender }.
  if (req.method === 'POST' && pathname === '/api/webhooks/telco') {
    let raw;
    try { raw = await readRawBody(req); } catch { return sendJSON(res, 400, { error: 'Unreadable body' }); }

    if (!nativePayments.verifyGatewaySignature(raw, req.headers['x-richstore-signature'])) {
      console.warn('[Telco Webhook] Rejected: invalid HMAC signature.');
      return sendJSON(res, 401, { error: 'Invalid signature' });
    }

    const text = raw.toString('utf-8');
    let smsText = text;
    let sender = String(req.headers['x-sms-sender'] || '');
    try {
      const parsedJson = JSON.parse(text);
      if (parsedJson && typeof parsedJson === 'object') {
        smsText = String(parsedJson.sms || parsedJson.text || parsedJson.message || '');
        sender = String(parsedJson.sender || sender || '');
      }
    } catch (_) { /* plain-text SMS body */ }

    const parsed = nativePayments.parseIncomingSms(smsText, sender);
    if (!parsed.success || !parsed.reference) {
      return sendJSON(res, 202, { received: true, parsed: false, reason: 'No amount/reference recognised' });
    }

    const fresh = refreshDb();
    const wanted = String(parsed.reference).toUpperCase();
    const order = (fresh.orders || []).find((o) => String(o.paymentReference || '').toUpperCase() === wanted);
    if (!order) {
      console.error(`[Telco Webhook] No order matches reference "${wanted}".`);
      return sendJSON(res, 202, { received: true, matched: false });
    }

    const applied = markOrderPaid(fresh, order, {
      source: 'telco-sms',
      reference: wanted,
      transactionId: parsed.transactionId || '',
      amount: parsed.amount
    });
    if (!applied.ok) {
      console.warn(`[Telco Webhook] Order ${order.id} not marked paid: ${applied.error}`);
      return sendJSON(res, 202, { received: true, matched: true, markedPaid: false, reason: applied.error });
    }
    writeDB(fresh);
    console.log(`[Telco Webhook] Order ${order.id} paid via ${parsed.provider} (txn ${parsed.transactionId || 'n/a'}).`);
    return sendJSON(res, 200, { received: true, matched: true, markedPaid: true });
  }

  // POST /api/signup
  if (req.method === 'POST' && pathname === '/api/signup') {
    const signupIp = getClientIP(req);
    const signupRl = checkRateLimit(`signup:${signupIp}`, 10, 60 * 60 * 1000);
    if (!signupRl.allowed) {
      return sendJSON(res, 429, { error: 'Too many accounts created from this network. Please try again later.' });
    }
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    db = refreshDb(); // never race another concurrent signup for the same username/id
    const { username, password, accountType } = body || {};
    if (!username || !password) return sendJSON(res, 400, { error: 'Username and password required' });
    // basic validation
    if (!/^[a-zA-Z0-9_\-]{3,30}$/.test(username)) return sendJSON(res, 400, { error: 'Username must be 3-30 chars and alphanumeric/_- only' });
    if (String(password).length < 8) return sendJSON(res, 400, { error: 'Password must be at least 8 characters' });
    if (RESERVED_USERNAMES.includes(String(username).toLowerCase())) {
      return sendJSON(res, 400, { error: 'Username is reserved and cannot be used' });
    }
    if (getUserByUsername(db, username)) return sendJSON(res, 400, { error: 'Username already exists' });

    const selectedType = accountType === 'buyer' ? 'buyer' : 'seller';
    const rawPhone = body.phone || '';
    const normalizedPhone = validatePhoneGH(rawPhone);
    if (!normalizedPhone) {
      return sendJSON(res, 400, { error: 'Valid Ghanaian phone number required (e.g. 0501234567 or 0241234567)' });
    }

    let storeName = '';
    let storeLocation = '';
    let storeGpsAddress = '';
    let buyerName = '';
    let buyerLocation = '';
    let buyerGpsAddress = '';

    if (selectedType === 'seller') {
      storeName = String(body.storeName || '').trim();
      storeLocation = String(body.storeLocation || '').trim();
      storeGpsAddress = String(body.storeGpsAddress || '').trim();
      if (!storeName) return sendJSON(res, 400, { error: 'Store name is required for seller registration' });
      if (!storeLocation) return sendJSON(res, 400, { error: 'Store location is required for seller registration' });
    } else {
      buyerName = String(body.name || '').trim();
      buyerLocation = String(body.location || '').trim();
      buyerGpsAddress = String(body.gpsAddress || '').trim();
      if (!buyerName) return sendJSON(res, 400, { error: 'Your name is required for buyer registration' });
      if (!buyerLocation) return sendJSON(res, 400, { error: 'Location/delivery address is required for buyer registration' });
    }

    const salt = genSalt();
    const passwordHash = hashPassword(password, salt);
    const user = {
      id: db.nextUserId++,
      username: String(username),
      passwordHash,
      salt,
      accountType: selectedType,
      phone: normalizedPhone,
      ...(selectedType === 'buyer' ? {
        name: buyerName,
        location: buyerLocation,
        gpsAddress: buyerGpsAddress
      } : {
        storeName: storeName,
        storeLocation: storeLocation,
        storeGpsAddress: storeGpsAddress
      }),
      createdAt: new Date().toISOString()
    };
    db.users.push(user);

    // create session with expiry
    const token = generateToken();
    const expiresAt = Date.now() + SESSION_TTL;
    db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString(), expiresAt };
    writeDB(db);

    return sendJSON(res, 201, {
      token,
      user: sanitizeUser(user, db),
      expiresAt
    });
  }

  // POST /api/login
  if (req.method === 'POST' && pathname === '/api/login') {
    const ip = getClientIP(req);
    const rl = checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return sendJSON(res, 429, { error: `Too many login attempts. Please wait ${rl.retryAfterSeconds}s before trying again.` });
    }

    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    db = refreshDb();
    const { username, password, accountType } = body || {};
    if (!username || !password) return sendJSON(res, 400, { error: 'Username and password required' });
    const user = getUserByUsername(db, username);
    if (!user) return sendJSON(res, 400, { error: 'Invalid username or password' });
    const hash = hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return sendJSON(res, 400, { error: 'Invalid username or password' });

    // Validate account type if specified
    const userType = user.accountType || 'seller';
    if (accountType && accountType !== userType) {
      const typeLabel = userType === 'seller' ? 'Seller' : 'Buyer';
      return sendJSON(res, 400, {
        error: `This account is registered as a ${typeLabel}. Please switch to the "Login as ${typeLabel}" tab.`,
        suggestedType: userType
      });
    }

    const token = generateToken();
    const expiresAt = Date.now() + SESSION_TTL;
    db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString(), expiresAt };
    writeDB(db);

    return sendJSON(res, 200, {
      token,
      user: sanitizeUser(user, db),
      expiresAt
    });
  }

  // POST /api/logout
  if (req.method === 'POST' && pathname === '/api/logout') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      writeDB(db);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // GET /api/me
  if (req.method === 'GET' && pathname === '/api/me') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    return sendJSON(res, 200, { user: sanitizeUser(user, db) });
  }

  // PUT /api/user/profile
  if (req.method === 'PUT' && pathname === '/api/user/profile') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    db = refreshDb();
    const dbUser = db.users.find(u => u.id === user.id);
    if (!dbUser) return sendJSON(res, 404, { error: 'User not found' });

    if (dbUser.accountType === 'buyer') {
      if (body.name !== undefined) dbUser.name = String(body.name).trim();
      if (body.location !== undefined) dbUser.location = String(body.location).trim();
      if (body.gpsAddress !== undefined) dbUser.gpsAddress = String(body.gpsAddress).trim();
    } else {
      if (body.storeName !== undefined) dbUser.storeName = String(body.storeName).trim();
      if (body.storeLocation !== undefined) dbUser.storeLocation = String(body.storeLocation).trim();
      if (body.storeGpsAddress !== undefined) dbUser.storeGpsAddress = String(body.storeGpsAddress).trim();
    }

    if (body.phone !== undefined) {
      const requestedPhone = validatePhoneGH(body.phone);
      if (!requestedPhone) {
        return sendJSON(res, 400, { error: 'Invalid phone number. Use format: 0XX XXX XXXX or +233 XX XXX XXXX' });
      }
      if (requestedPhone !== dbUser.phone) {
        // SECURITY: changing the contact number is identity-relevant, so it requires
        // an OTP that was sent to — and received on — the NEW number. It is never
        // applied from raw client input.
        const otp = db.otpCodes && db.otpCodes[requestedPhone];
        const suppliedCode = String(body.phoneCode || body.otpCode || '').trim();
        const codeOk = !!(otp && suppliedCode && Number(otp.userId) === Number(dbUser.id)
          && Number(otp.expiresAt) > Date.now() && suppliedCode === otp.code);
        if (!codeOk) {
          return sendJSON(res, 400, {
            error: 'Your new phone number must be verified before it can be saved. Request a code for it, then submit the change with that code.',
            requiresPhoneVerification: true,
            phonePendingVerification: requestedPhone
          });
        }
        dbUser.phone = requestedPhone;
        delete db.otpCodes[requestedPhone];
        db.verifiedPhones[String(dbUser.id)] = { phone: requestedPhone, verifiedAt: Date.now() };
      }
    }
    writeDB(db);
    return sendJSON(res, 200, { ok: true, user: sanitizeUser(dbUser, db) });
  }

  // POST /api/send-otp
  if (req.method === 'POST' && pathname === '/api/send-otp') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    db = refreshDb();
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    // Throttle OTP dispatch per account and per network, so an authenticated user
    // cannot SMS-bomb arbitrary numbers or drain the SMS account's credit.
    const otpUserRl = checkRateLimit(`otp-user:${user.id}`, 5, 60 * 60 * 1000);
    if (!otpUserRl.allowed) {
      return sendJSON(res, 429, { error: `Too many verification codes requested. Please wait ${otpUserRl.retryAfterSeconds}s before requesting another.` });
    }
    const otpIpRl = checkRateLimit(`otp-ip:${getClientIP(req)}`, 10, 60 * 60 * 1000);
    if (!otpIpRl.allowed) {
      return sendJSON(res, 429, { error: 'Too many verification codes requested from this network. Please try again later.' });
    }

    const rawPhone = body.phone || user.phone;
    const phone = validatePhoneGH(rawPhone);
    if (!phone) return sendJSON(res, 400, { error: 'Invalid phone number. Use format: 0XX XXX XXXX or +233 XX XXX XXXX' });

    // Rate limit: 1 OTP per minute per phone
    const existing = db.otpCodes[phone];
    if (existing && (Date.now() - (existing.createdAt || 0)) < OTP_COOLDOWN) {
      const wait = Math.ceil((OTP_COOLDOWN - (Date.now() - existing.createdAt)) / 1000);
      return sendJSON(res, 429, { error: `Please wait ${wait}s before requesting another code`, cooldown: wait });
    }

    const code = generateOTP();
    db.otpCodes[phone] = {
      code,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL,
    };
    writeDB(db);

    // Send OTP via SMS (falls back to console in dev mode)
    const smsMessage = `Your RichStore verification code is: ${code}. It expires in 10 minutes.`;
    const smsResult = await sendSMS(phone, smsMessage);

    const response = { ok: true, message: 'Verification code sent', phone };
    // The code is echoed ONLY when a developer explicitly opts in with
    // OTP_DEV_ECHO=1. In every other case — including any deployment where SMS
    // happens to be unconfigured — it stays in the server console and is never
    // handed back through the API (otherwise phone verification means nothing).
    if (smsResult.dev && OTP_DEV_ECHO) response.devCode = code;
    if (!smsResult.success) {
      // SMS failed but code is stored — let user know
      console.error('SMS delivery failed for', phone, '— the OTP is stored and still valid');
      response.warning = 'SMS delivery may be delayed. Check your phone.';
    }

    return sendJSON(res, 200, response);
  }

  // POST /api/verify-otp
  if (req.method === 'POST' && pathname === '/api/verify-otp') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    db = refreshDb();
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const rawPhone = body.phone || user.phone;
    const phone = validatePhoneGH(rawPhone);
    if (!phone) return sendJSON(res, 400, { error: 'Invalid phone number' });

    const otp = db.otpCodes[phone];
    if (!otp) return sendJSON(res, 400, { error: 'No verification code found. Please request a new one.' });
    if (otp.expiresAt <= Date.now()) {
      delete db.otpCodes[phone];
      writeDB(db);
      return sendJSON(res, 400, { error: 'Code expired. Please request a new one.' });
    }
    if (Number(otp.userId) !== Number(user.id)) return sendJSON(res, 400, { error: 'Code was not sent to this account' });
    if (String(body.code).trim() !== otp.code) {
      otp.attempts = (Number(otp.attempts) || 0) + 1;
      const remaining = Math.max(0, MAX_OTP_ATTEMPTS - otp.attempts);
      if (otp.attempts >= MAX_OTP_ATTEMPTS) {
        delete db.otpCodes[phone];
        writeDB(db);
        return sendJSON(res, 429, { error: 'Too many incorrect attempts. That code has been cancelled — please request a new one.' });
      }
      writeDB(db);
      return sendJSON(res, 400, { error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
    }

    // Mark phone as verified for this user
    db.verifiedPhones[String(user.id)] = { phone, verifiedAt: Date.now() };
    const dbUser = db.users.find(u => u.id === user.id);
    if (dbUser) dbUser.phone = phone;
    delete db.otpCodes[phone];
    writeDB(db);

    return sendJSON(res, 200, { ok: true, verified: true, user: sanitizeUser(dbUser || user, db) });
  }

  // GET /api/my-listings
  if (req.method === 'GET' && pathname === '/api/my-listings') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    const myListings = db.listings.filter((l) => isItemForSeller(l, user, db));
    return sendJSON(res, 200, { listings: myListings });
  }

  // POST /api/upload-image
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    // Listing images belong to sellers; buyers have no use for this endpoint.
    if (user.accountType === 'buyer') {
      return sendJSON(res, 403, { error: 'Only seller accounts can upload listing images.' });
    }
    const uploadIp = getClientIP(req);
    const uploadRl = checkRateLimit(`upload:${user.id}:${uploadIp}`, 30, 15 * 60 * 1000);
    if (!uploadRl.allowed) {
      return sendJSON(res, 429, { error: `Too many image uploads. Please wait ${uploadRl.retryAfterSeconds}s before trying again.` });
    }

    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
    const fileParts = [];
    let mimeType = 'image/jpeg';
    let filename = 'upload.jpg';

    let uploadError = null;
    try {
      await new Promise((resolve, reject) => {
        bb.on('file', (fieldname, file, info) => {
          const { filename: incomingName, mimeType: incomingType } = info;
          filename = incomingName || filename;
          mimeType = incomingType || mimeType;
          if (!mimeType.startsWith('image/')) {
            file.resume(); // drain the stream so it doesn't hang
            return reject(new Error('Only image uploads are allowed'));
          }
          file.on('data', (chunk) => fileParts.push(chunk));
          file.on('end', () => resolve());
        });
        bb.on('error', reject);
        req.pipe(bb);
      });
    } catch (err) {
      uploadError = err;
    }

    if (uploadError) {
      return sendJSON(res, 400, { error: uploadError.message || 'Upload failed' });
    }

    if (!fileParts.length) {
      return sendJSON(res, 400, { error: 'No image uploaded' });
    }

    const buffer = Buffer.concat(fileParts);
    const format = mimeType.split('/')[1] || 'jpeg';
    const ext = ['jpg', 'jpeg', 'png', 'webp'].includes(format) ? format : 'jpg';
    const safeName = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
    const outPath = path.join(UPLOADS_DIR, safeName);
    const thumbPath = path.join(UPLOADS_DIR, 'thumb-' + safeName);

    try {
      const metadata = await sharp(buffer).metadata();
      // Minimum resolution threshold to prevent unclear, pixelated, or empty
      // placeholder photos. Kept in sync with the promise made on
      // /posting-policy.html via MIN_IMAGE_DIMENSION.
      if ((metadata.width && metadata.width < MIN_IMAGE_DIMENSION) || (metadata.height && metadata.height < MIN_IMAGE_DIMENSION)) {
        return sendJSON(res, 422, { 
          error: `Image rejected: Photo resolution is too low (${metadata.width || 0}×${metadata.height || 0}px). To protect buyer transparency, please upload a clear, focused photo of at least ${MIN_IMAGE_DIMENSION}×${MIN_IMAGE_DIMENSION} pixels.`,
          clause: 'Section 2.3 — Quality & Image Clarity Standards',
          policyUrl: '/posting-policy.html'
        });
      }

      // Automated Computer-Vision Nudity & NSFW Content Inspection
      const nudityAnalysis = await detectNudity(buffer);
      if (nudityAnalysis.scanFailed) {
        return sendJSON(res, 422, {
          error: 'Upload rejected — our content safety system could not read this image. Please try a different file (a standard JPEG or PNG).',
          clause: 'Section 2.2 — Image Quality & Verification',
          policyUrl: '/posting-policy.html'
        });
      }
      if (nudityAnalysis.isNude) {
        return sendJSON(res, 422, { 
          error: 'Image rejected by RichStore Content Safety: Prohibited nudity, excessive exposed skin, or sexually explicit content detected.',
          clause: 'Section 2.1 & 2.2 — Prohibited Adult & Nudity Content',
          policyUrl: '/posting-policy.html'
        });
      }

      await sharp(buffer)
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .toFormat(ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext, { quality: 88 })
        .toFile(outPath);
      await sharp(buffer)
        .resize(300, 300, { fit: 'cover' })
        .toFormat(ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext, { quality: 85 })
        .toFile(thumbPath);
    } catch (error) {
      return sendJSON(res, 500, { error: 'Failed to process image' });
    }

    return sendJSON(res, 201, {
      path: '/uploads/' + safeName,
      thumbnail: '/uploads/' + 'thumb-' + safeName,
    });
  }

  // GET /api/listings?search=&category=
  if (req.method === "GET" && pathname === "/api/listings") {
    // Sold-out rows stay in the database (for restocking and order history) but are
    // not part of the shoppable feed.
    let results = db.listings.filter((l) => l && Number(l.stock) > 0);
    if (query.category && query.category !== "All") {
      results = results.filter((l) => l.category === query.category);
    }
    if (query.search) {
      const term = query.search.toLowerCase();
      // Every field is coerced: one legacy row with a missing description or
      // category used to throw here and fail the ENTIRE feed with a 500.
      results = results.filter(
        (l) =>
          String(l.title || '').toLowerCase().includes(term) ||
          String(l.description || '').toLowerCase().includes(term) ||
          String(l.category || '').toLowerCase().includes(term)
      );
    }
    // Contact details are deliberately NOT part of the bulk feed — they are served
    // per listing (item page) so they cannot be harvested in one request.
    const publicListings = results.map(({ sellerPhone, sellerAddress, ...rest }) => rest);

    // Optional pagination. Omitting limit/offset keeps the previous behaviour (the
    // full list), so every existing caller is unaffected.
    const total = publicListings.length;
    const offset = Math.max(0, Number(query.offset) || 0);
    const limitRaw = Number(query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : null;
    const page = limit === null ? publicListings.slice(offset) : publicListings.slice(offset, offset + limit);

    return sendJSON(res, 200, {
      listings: page,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total
    });
  }

  // GET /api/categories
  if (req.method === "GET" && pathname === "/api/categories") {
    const cats = [...new Set(db.listings.map((l) => l.category))].sort();
    return sendJSON(res, 200, { categories: cats });
  }

  // GET /api/listings/:id
  const singleMatch = pathname.match(/^\/api\/listings\/(\d+)$/);
  if (singleMatch) {
    const id = Number(singleMatch[1]);
    if (req.method === "GET") {
      const item = db.listings.find((l) => l.id === id);
      if (!item) return sendJSON(res, 404, { error: "Listing not found" });
      const phoneVerified = isSellerPhoneVerified(db, item.seller, item.sellerPhone);
      return sendJSON(res, 200, {
        listing: {
          ...item,
          sellerPhoneVerified: phoneVerified
        }
      });
    }

    // DELETE /api/listings/:id (only owner)
    if (req.method === 'DELETE') {
      const authHeader = (req.headers['authorization'] || '');
      const token = authHeader.split(' ')[1];
      const user = getUserFromToken(db, token);
      if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
      const idx = db.listings.findIndex((l) => l.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Listing not found' });
      if (!isItemForSeller(db.listings[idx], user, db) && !isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Forbidden' });
      db.listings.splice(idx, 1);
      writeDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    // PUT /api/listings/:id (update only owner or admin)
    if (req.method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
      db = refreshDb(); // operate on the freshest state (no lost updates vs concurrent checkouts)
      const authHeader = (req.headers['authorization'] || '');
      const token = authHeader.split(' ')[1];
      const user = getUserFromToken(db, token);
      if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
      const item = db.listings.find((l) => l.id === id);
      if (!item) return sendJSON(res, 404, { error: 'Listing not found' });
      if (!isItemForSeller(item, user, db) && !isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Forbidden' });
      // NOTE: 'sellerPhone' is deliberately NOT writable here. Listing creation forces
      // the phone its owner verified; allowing it on edit re-opened the exact phone
      // spoofing that creation already blocks. It is re-applied from the verified
      // record below instead.
      const allowed = ['title','category','price','condition','description','stock','emoji','color','colors','sellerAddress','address','images'];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        if (k === 'images') {
          item.images = Array.isArray(body.images) ? body.images.filter(p => typeof p === 'string').slice(0, 5) : [];
        } else if (k === 'colors') {
          if (Array.isArray(body.colors)) {
            item.colors = body.colors.map(c => typeof c === 'string' ? c.trim().slice(0, 30) : '').filter(Boolean).slice(0, 15);
            if (item.colors.length > 0) item.color = item.colors[0];
          }
        } else if (k === 'address') {
          item.sellerAddress = String(body.address).trim();
        } else if (k === 'price') {
          const p = Number(body.price);
          if (!Number.isFinite(p) || p < 0) return sendJSON(res, 400, { error: 'price must be a non-negative number' });
          item.price = Math.round(p * 100) / 100;
        } else if (k === 'stock') {
          const rawStock = String(body.stock).trim();
          if (!/^\d+$/.test(rawStock)) return sendJSON(res, 400, { error: 'stock must be a non-negative integer' });
          item.stock = parseInt(rawStock, 10);
        } else if (k === 'title') {
          item.title = String(body.title).slice(0, 120);
        } else if (k === 'description') {
          item.description = String(body.description).slice(0, 2000);
        } else if (k === 'sellerAddress') {
          item.sellerAddress = String(body.sellerAddress).trim();
        } else {
          item[k] = String(body[k]);
        }
      }
      // Anti-spoof, same rule as creation: a listing's contact phone is always the
      // phone its owner verified — never a client-supplied value.
      const owner = db.users.find((u) =>
        (item.sellerId && Number(u.id) === Number(item.sellerId)) ||
        (u.username && item.seller && String(u.username).toLowerCase() === String(item.seller).toLowerCase())
      );
      const ownerVerified = owner && db.verifiedPhones ? db.verifiedPhones[String(owner.id)] : null;
      if (ownerVerified && ownerVerified.phone) item.sellerPhone = ownerVerified.phone;

      // Enforcement: Product Posting & Content Moderation Policy check
      const policyCheck = validateProductPolicy({ 
        title: item.title, 
        description: item.description, 
        category: item.category 
      });
      if (!policyCheck.valid) {
        return sendJSON(res, 422, { 
          error: policyCheck.error, 
          clause: policyCheck.clause,
          policyUrl: '/posting-policy.html'
        });
      }

      // Inspect any attached images for nudity/safety policy compliance
      const attachedImages = [...(Array.isArray(item.images) ? item.images : []), item.emoji].filter(
        (img) => typeof img === 'string' && img.startsWith('/uploads/')
      );
      for (const imgPath of attachedImages) {
        const localFile = path.join(PUBLIC_DIR, imgPath.replace(/^\/+/, ''));
        if (fs.existsSync(localFile)) {
          const nudeRes = await detectNudity(localFile);
          if (nudeRes.scanFailed) {
            try { fs.unlinkSync(localFile); } catch (e) {}
            return sendJSON(res, 422, {
              error: 'Listing rejected — an attached photo could not be verified by our content safety system. Please re-upload a standard JPEG or PNG.',
              clause: 'Section 2.2 — Image Quality & Verification',
              policyUrl: '/posting-policy.html'
            });
          }
          if (nudeRes.isNude) {
            try { fs.unlinkSync(localFile); } catch (e) {}
            return sendJSON(res, 422, {
              error: 'Listing rejected by RichStore Content Safety: Attached photo violates policy (prohibited nudity or sexually explicit content detected).',
              clause: 'Section 2.1 & 2.2 — Prohibited Adult & Nudity Content',
              policyUrl: '/posting-policy.html'
            });
          }
        }
      }

      // Stock 0 means SOLD OUT — never deleted. The listing is hidden from the
      // public feed but stays in the seller's account so it can be restocked.
      if (Number(item.stock) <= 0) {
        writeDB(db);
        return sendJSON(res, 200, {
          ok: true,
          soldOut: true,
          listing: item,
          message: 'Stock is 0. The listing is marked sold out and hidden from shoppers. Set a stock above 0 to make it live again.'
        });
      }

      writeDB(db);
      return sendJSON(res, 200, { listing: item });
    }
  }

  // POST /api/listings  (create a new listing = "Sell an item")
  if (req.method === "POST" && pathname === "/api/listings") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }
    db = refreshDb(); // avoid duplicate nextId / lost listings under concurrent creates

    // authenticate via Bearer token
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    // Buyer accounts cannot post listings
    if (user.accountType === 'buyer') {
      return sendJSON(res, 403, { error: 'Buyer accounts cannot post listings. Please register or log in as a seller.' });
    }

    // Rate-limit listing creation per user + IP
    const createIp = getClientIP(req);
    const createRl = checkRateLimit(`create:${user.id}:${createIp}`, 10, 15 * 60 * 1000);
    if (!createRl.allowed) {
      return sendJSON(res, 429, { error: `Too many listings created. Please wait ${createRl.retryAfterSeconds}s before trying again.` });
    }

    // Require phone verification before posting
    if (!db.verifiedPhones || !db.verifiedPhones[String(user.id)]) {
      return sendJSON(res, 403, { error: 'Phone verification required before posting. Please verify your phone number.' });
    }

    const { title, category, price, condition, description, stock, emoji, color, colors, sellerPhone, sellerAddress, address, images } = body;
    if (!title || !category || price == null || !condition) {
      return sendJSON(res, 400, { error: "title, category, price, and condition are required" });
    }
    // Numeric validation — never store NaN / negative values
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return sendJSON(res, 400, { error: 'price must be a non-negative number' });
    }
    const finalPrice = Math.round(priceNum * 100) / 100;
    let stockNum = 1;
    if (stock !== undefined && stock !== null && stock !== '') {
      const rawStock = String(stock).trim();
      if (!/^\d+$/.test(rawStock) || parseInt(rawStock, 10) < 1) {
        return sendJSON(res, 400, { error: 'stock must be a positive integer' });
      }
      stockNum = parseInt(rawStock, 10);
    }
    // Never hand out an id that is already in use. `nextId` is a plain persisted
    // counter, so a stale value (the live db.json carried nextId 105 while listings
    // already used ids up to 155) made a new listing collide with an existing one —
    // after which edits, stock decrements and order lookups hit the wrong row.
    const maxListingId = (Array.isArray(db.listings) ? db.listings : [])
      .reduce((max, l) => Math.max(max, Number(l && l.id) || 0), 0);
    if (typeof db.nextId !== 'number' || !Number.isFinite(db.nextId) || db.nextId <= maxListingId) {
      db.nextId = maxListingId + 1;
    }

    // Process available colors
    let colorList = [];
    if (Array.isArray(colors) && colors.length > 0) {
      colorList = colors.map(c => typeof c === 'string' ? c.trim().slice(0, 30) : '').filter(Boolean).slice(0, 15);
    }
    if (colorList.length === 0) {
      colorList = [color || "#2F6F63"];
    }
    const primaryColor = colorList[0] || color || "#2F6F63";

    // Enforcement: Product Posting & Content Moderation Policy check
    const policyCheck = validateProductPolicy({ title, description, category });
    if (!policyCheck.valid) {
      return sendJSON(res, 422, { 
        error: policyCheck.error, 
        clause: policyCheck.clause,
        policyUrl: '/posting-policy.html'
      });
    }

    // Inspect any attached images for nudity/safety policy compliance
    const attachedImages = [...(Array.isArray(images) ? images : []), emoji].filter(
      (img) => typeof img === 'string' && img.startsWith('/uploads/')
    );
    for (const imgPath of attachedImages) {
      const localFile = path.join(PUBLIC_DIR, imgPath.replace(/^\/+/, ''));
      if (fs.existsSync(localFile)) {
        const nudeRes = await detectNudity(localFile);
        if (nudeRes.scanFailed) {
          try { fs.unlinkSync(localFile); } catch (e) {}
          return sendJSON(res, 422, {
            error: 'Listing rejected — an attached photo could not be verified by our content safety system. Please re-upload a standard JPEG or PNG.',
            clause: 'Section 2.2 — Image Quality & Verification',
            policyUrl: '/posting-policy.html'
          });
        }
        if (nudeRes.isNude) {
          try { fs.unlinkSync(localFile); } catch (e) {}
          return sendJSON(res, 422, { 
            error: 'Listing rejected by RichStore Content Safety: Attached photo violates policy (prohibited nudity or sexually explicit content detected).',
            clause: 'Section 2.1 & 2.2 — Prohibited Adult & Nudity Content',
            policyUrl: '/posting-policy.html'
          });
        }
      }
    }

    const dbSeller = db.users.find(u => u.id === user.id);
    if (!dbSeller) return sendJSON(res, 404, { error: 'Seller account not found' });

    const newListing = {
      id: db.nextId++,
      title: String(title).slice(0, 120),
      category: String(category),
      price: finalPrice,
      condition: String(condition),
      seller: String(user.username),
      sellerId: user.id,
      // Server-side enforcement: the listing phone is ALWAYS the phone this user verified — never a spoofed input
      sellerPhone: (db.verifiedPhones[String(user.id)] && db.verifiedPhones[String(user.id)].phone) || user.phone || "",
      sellerAddress: (sellerAddress || address) ? String(sellerAddress || address).trim() : (user.storeLocation || ""),
      stock: stockNum,
      emoji: emoji || "📦",
      color: primaryColor,
      colors: colorList,
      description: description ? String(description).slice(0, 2000) : "",
      images: Array.isArray(images) ? images.filter(p => typeof p === 'string').slice(0, 5) : [],
      active: true,
    };
    db.listings.unshift(newListing);

    writeDB(db);
    return sendJSON(res, 201, { listing: newListing });
  }

  // POST /api/checkout  { items: [{id, qty}] } — buyer comes from the auth token
  if (req.method === "POST" && pathname === "/api/checkout") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return sendJSON(res, 400, { error: "Cart is empty" });

    // Process through the Atomic Checkout Queue to serialize concurrent purchases:
    return await runAtomicCheckout(async () => {
      let db = refreshDb(); // re-read stock fresh inside the atomic lock

      // Checkout requires a logged-in account: prevents anonymous stock draining
      // and attributes each order to a real buyer instead of a spoofable string.
      const authHeader = (req.headers['authorization'] || '');
      const token = authHeader.split(' ')[1];
      const user = getUserFromToken(db, token);
      if (!user) return sendJSON(res, 401, { error: 'Authentication required before checkout. Please log in.' });

      // Gating: Sellers are not allowed to buy or checkout items
      if (user.accountType === 'seller') {
        return sendJSON(res, 403, { error: 'Sellers are not allowed to buy or place orders. Please use a buyer account to purchase items.' });
      }

      const ip = getClientIP(req);
      const rl = checkRateLimit(`checkout:${user.id}:${ip}`, 20, 15 * 60 * 1000);
      if (!rl.allowed) {
        return sendJSON(res, 429, { error: `Too many checkout attempts. Please wait ${rl.retryAfterSeconds}s before trying again.` });
      }
      const buyerUsername = user.username;

      let subtotal = 0;
      const orderItems = [];

      // Check total demand per listing across potential color variations
      const demandByListing = {};
      for (const { id, qty } of items) {
        const listingId = Number(id);
        if (!Number.isInteger(listingId) || listingId <= 0) continue;
        const q = Math.max(1, parseInt(qty, 10) || 1);
        demandByListing[listingId] = (demandByListing[listingId] || 0) + q;
      }
      for (const [listingIdStr, totalDemanded] of Object.entries(demandByListing)) {
        const listing = db.listings.find(l => l.id === Number(listingIdStr));
        if (listing && listing.stock < totalDemanded) {
          return sendJSON(res, 400, {
            error: `The quantity demanded (${totalDemanded}) for "${listing.title}" is not equal to the quantity available (only ${listing.stock} available). Please reduce your demand to the stock available.`
          });
        }
      }

      for (const { id, qty, color } of items) {
        const listingId = Number(id);
        if (!Number.isInteger(listingId) || listingId <= 0) continue;

        const listing = db.listings.find((l) => l.id === listingId);
        if (!listing) continue;

        const quantity = Math.max(1, parseInt(qty, 10) || 1);
        if (listing.stock < quantity) {
          return sendJSON(res, 400, {
            error: `The quantity demanded (${quantity}) for "${listing.title}" is not equal to the quantity available (only ${listing.stock} available). Please reduce your demand to the stock available.`
          });
        }
        listing.stock -= quantity;
        subtotal += listing.price * quantity;

        // Stock 0 = sold out. The listing stays in the catalogue (hidden from the
        // public feed) so the seller can restock it and order history still resolves.
        if (listing.stock <= 0) {
          console.log(`[Sold Out] Listing #${listing.id} ("${listing.title}") reached 0 stock and is now sold out (kept for restocking).`);
        }

        const sellerUser = db.users.find(u => 
          (listing.sellerId && u.id === listing.sellerId) ||
          (u.username && listing.seller && u.username.toLowerCase() === listing.seller.toLowerCase()) ||
          (u.storeName && listing.seller && u.storeName.toLowerCase() === listing.seller.toLowerCase())
        );
        const resolvedSeller = listing.seller || (sellerUser ? sellerUser.username : "KumodjiSenyo");
        const resolvedSellerId = listing.sellerId || (sellerUser ? sellerUser.id : null);
        const resolvedSellerPhone = listing.sellerPhone || (sellerUser ? (sellerUser.phone || '') : platformPaymentConfig().telecelPhone);
        const resolvedColor = typeof color === 'string' && color.trim() ? color.trim().slice(0, 30) : (listing.color || (listing.colors && listing.colors[0]) || '');

        orderItems.push({
          id: listing.id,
          title: listing.title,
          price: listing.price,
          qty: quantity,
          color: resolvedColor,
          seller: resolvedSeller,
          sellerId: resolvedSellerId,
          sellerPhone: resolvedSellerPhone,
          category: listing.category || 'General',
          emoji: listing.emoji || '📦',
          images: Array.isArray(listing.images) ? listing.images : []
        });
      }

      if (orderItems.length === 0) {
        return sendJSON(res, 400, { error: "Cart is empty or contains items no longer available" });
      }

      subtotal = Math.round(subtotal * 100) / 100;

      // Calculate 5% Platform Site & Escrow Protection Fee
      const feeBreakdown = calculateEscrowFee(subtotal);
      const siteFee = feeBreakdown.siteFee;
      const total = feeBreakdown.buyerTotal;

      const buyerName = String(body.buyerName || user.name || user.username || 'Valued Customer').trim();
      const buyerLocation = String(body.buyerLocation || body.location || body.address || user.gpsAddress || user.location || 'Accra, Ghana').trim();
      const verifiedPhoneObj = db.verifiedPhones && db.verifiedPhones[String(user.id)];
      const buyerPhone = String(body.buyerPhone || body.phone || user.phone || (verifiedPhoneObj && verifiedPhoneObj.phone) || '').trim();

      const orderId = "ORD-" + Date.now() + "-" + Math.floor(100 + Math.random() * 900); // random suffix = no ms collisions
      const paymentRef = allocatePaymentReference(db, orderId);
      const buyerEmailClean = String(user.email || '').trim();
      const handshakePin = nativePayments.generateHandshakePin();
      const nowIso = new Date().toISOString();

      // The order is created AWAITING PAYMENT. Nothing is held, no fee is applied and
      // no treasury entry is written here — markOrderPaid() does all three, and only
      // once a payment has actually been verified. Writing an escrow deposit at
      // checkout (as this used to) recorded money that had never existed.
      const order = {
        id: orderId,
        buyer: buyerUsername,
        buyerId: user.id,
        buyerName,
        buyerLocation,
        buyerPhone,
        buyerEmail: buyerEmailClean,
        items: orderItems,
        subtotal,
        siteFee,
        total,
        sellerPayoutAmount: subtotal,
        status: 'PendingPayment',
        paymentStatus: 'pending',
        escrowStatus: 'None',
        paymentConfirmed: false,
        siteFeeApplied: false, // applied when the escrow deposit is confirmed paid
        paymentRef,            // legacy field name, kept for older pages
        paymentReference: paymentRef,
        paymentSource: null,
        paidAt: null,
        paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString(),
        escrowExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString(),
        // The buyer reads this to the delivery agent. It is never returned in the
        // public feed nor shown to the seller, so only the buyer can release funds.
        deliveryPin: handshakePin,
        placedAt: nowIso,
      };
      db.orders.push(order);

      writeDB(db);
      return sendJSON(res, 201, {
        ok: true,
        order
      });
    });
  }

  // ---------- payment flow for one order ----------

  // GET /api/payment/config — which payment channels can THIS deployment actually take?
  if (req.method === 'GET' && pathname === '/api/payment/config') {
    return sendJSON(res, 200, {
      ok: true,
      channels: paymentChannels(),
      paymentWindowMs: PAYMENT_WINDOW_MS,
      gatewayLive: gatewayIsLive()
    });
  }

  // POST /api/orders/:id/payment/initialize — the buyer starts paying.
  if (req.method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/payment/initialize')) {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = pathname.replace('/api/orders/', '').replace('/payment/initialize', '').trim();
    const fresh = refreshDb();
    const order = (fresh.orders || []).find((o) => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });
    if (!isOrderForBuyer(order, user, fresh) && !isAdminUser(fresh, user)) {
      return sendJSON(res, 403, { error: 'Only the buyer who placed this order can pay for it.' });
    }
    if (order.paymentStatus === 'paid') return sendJSON(res, 409, { error: 'This order has already been paid.' });
    if (order.paymentStatus === 'expired' || order.status === 'Expired') {
      return sendJSON(res, 409, { error: 'This order expired before payment. Please place a new order.' });
    }

    const rl = checkRateLimit(`payinit:${user.id}:${order.id}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return sendJSON(res, 429, { error: `Too many payment attempts. Please wait ${rl.retryAfterSeconds}s.` });
    }

    const channels = paymentChannels();

    if (!gatewayIsLive()) {
      // Offline mode. We must NEVER fall back to the gateway's simulation responses:
      // they report success without a payment, which is precisely the bug this flow
      // was built to remove. The buyer transfers, and a human confirms.
      return sendJSON(res, 200, {
        ok: true,
        mode: 'offline',
        reference: order.paymentReference,
        amount: order.total,
        momoNumber: channels.momoNumber,
        momoName: channels.momoName,
        note: 'Transfer the exact amount using your reference. Mobile-money transfers are confirmed by our team, usually within minutes.'
      });
    }

    const email = String(user.email || order.buyerEmail || '').trim()
      || `${String(user.username || 'buyer').replace(/[^a-z0-9._-]/gi, '')}@richstore.local`;
    try {
      const init = await paystack.initializeTransaction({
        email,
        amountInPesewas: paystack.toPesewas(order.total),
        reference: order.paymentReference,
        callbackUrl: `${getPublicBaseUrl(req)}/pay.html?order=${encodeURIComponent(order.id)}&verify=1`,
        metadata: { orderId: order.id, buyerId: user.id }
      });
      if (!init || init.simulation === true || !init.authorizationUrl) {
        return sendJSON(res, 502, { error: 'The payment gateway did not return a checkout link. Please try again.' });
      }
      order.paymentGatewayReference = init.reference || order.paymentReference;
      order.paymentInitializedAt = new Date().toISOString();
      writeDB(fresh);
      return sendJSON(res, 200, {
        ok: true,
        mode: 'gateway',
        authorizationUrl: init.authorizationUrl,
        reference: order.paymentReference,
        publicKey: channels.publicKey,
        amount: order.total
      });
    } catch (err) {
      console.error('Payment initialization failed:', err.message);
      return sendJSON(res, 502, {
        error: 'Could not start the card / mobile-money payment. You can still pay by mobile-money transfer using your reference.'
      });
    }
  }

  // POST /api/orders/:id/payment/verify — buyer returns from the gateway, or checks an
  // offline transfer. Only a verified gateway response or an admin may mark an order paid.
  if (req.method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/payment/verify')) {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = pathname.replace('/api/orders/', '').replace('/payment/verify', '').trim();
    const fresh = refreshDb();
    const order = (fresh.orders || []).find((o) => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });
    if (!isOrderForBuyer(order, user, fresh) && !isAdminUser(fresh, user)) {
      return sendJSON(res, 403, { error: 'Only the buyer who placed this order can check its payment.' });
    }
    if (order.paymentStatus === 'paid') {
      return sendJSON(res, 200, { ok: true, paymentStatus: order.paymentStatus, escrowStatus: order.escrowStatus, order });
    }

    if (!gatewayIsLive()) {
      return sendJSON(res, 200, {
        ok: true,
        paymentStatus: order.paymentStatus,
        escrowStatus: order.escrowStatus,
        order,
        awaitingManualConfirmation: true,
        note: 'Mobile-money transfers are confirmed by our team, so this can take a few minutes.'
      });
    }

    try {
      const verification = await paystack.verifyTransaction(order.paymentReference);
      // verification.simulation guards against a *simulated* success being treated as
      // a real payment.
      if (verification && verification.ok === true && verification.status === 'success' && verification.simulation !== true) {
        const applied = markOrderPaid(fresh, order, {
          source: 'paystack',
          reference: order.paymentReference,
          amount: Number(verification.amount) / 100
        });
        if (applied.ok) writeDB(fresh);
      }
      return sendJSON(res, 200, {
        ok: true,
        paymentStatus: order.paymentStatus,
        escrowStatus: order.escrowStatus,
        order
      });
    } catch (err) {
      console.error('Payment verification failed:', err.message);
      return sendJSON(res, 502, { error: 'Could not reach the payment gateway to confirm. Please try again.' });
    }
  }

  // POST /api/orders/:id/payment/manual-confirm — an administrator confirms an offline
  // mobile-money transfer that landed on the platform number.
  if (req.method === 'POST' && pathname.startsWith('/api/orders/') && pathname.endsWith('/payment/manual-confirm')) {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    if (!isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Administrator access required to confirm a payment.' });

    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }

    const orderId = pathname.replace('/api/orders/', '').replace('/payment/manual-confirm', '').trim();
    const fresh = refreshDb();
    const order = (fresh.orders || []).find((o) => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });

    const reference = String((body && body.reference) || '').trim();
    if (!reference) {
      return sendJSON(res, 400, { error: 'The transfer reference you matched is required — it is the audit trail for this confirmation.' });
    }

    const applied = markOrderPaid(fresh, order, {
      source: 'admin',
      reference,
      transactionId: String((body && body.transactionId) || '')
    });
    if (!applied.ok) return sendJSON(res, 400, { error: applied.error });

    order.paymentConfirmedBy = user.username;
    order.paymentConfirmNote = String((body && body.note) || '').slice(0, 300);
    writeDB(fresh);
    console.log(`[Payments] Order ${order.id} confirmed paid by admin ${user.username} (ref ${reference}).`);
    return sendJSON(res, 200, { ok: true, order });
  }

  // GET /api/admin/payments/pending — the operator's reconciliation queue.
  if (req.method === 'GET' && pathname === '/api/admin/payments/pending') {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    if (!isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Administrator access required' });

    const rows = (db.orders || [])
      .filter((o) => o && ['pending', 'expired', 'unverified'].includes(String(o.paymentStatus || '')))
      .map((o) => ({
        id: o.id,
        total: o.total,
        buyer: o.buyerName || o.buyer,
        buyerPhone: o.buyerPhone,
        paymentStatus: o.paymentStatus,
        paymentReference: o.paymentReference || o.paymentRef || null,
        createdAt: o.placedAt || o.createdAt || null,
        paymentExpiresAt: o.paymentExpiresAt || null,
        status: o.status
      }));

    const pending = rows.filter((r) => r.paymentStatus === 'pending');
    return sendJSON(res, 200, {
      ok: true,
      orders: rows,
      totals: {
        pendingCount: pending.length,
        pendingAmount: Math.round(pending.reduce((s, r) => s + (Number(r.total) || 0), 0) * 100) / 100,
        expiredCount: rows.filter((r) => r.paymentStatus === 'expired').length,
        unverifiedCount: rows.filter((r) => r.paymentStatus === 'unverified').length
      }
    });
  }

  // GET /api/my-payments — the signed-in user's payment / escrow history.
  if (req.method === 'GET' && pathname === '/api/my-payments') {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const shape = (o) => ({
      id: o.id,
      total: o.total,
      subtotal: o.subtotal,
      siteFee: o.siteFee,
      paymentStatus: o.paymentStatus || 'unverified',
      escrowStatus: o.escrowStatus || 'None',
      paymentReference: o.paymentReference || o.paymentRef || null,
      createdAt: o.placedAt || o.createdAt || null,
      paidAt: o.paidAt || null,
      payouts: o.payouts || null
    });
    const sum = (list) => Math.round(list.reduce((s, o) => s + (Number(o.total) || 0), 0) * 100) / 100;

    const asBuyer = (db.orders || []).filter((o) => o && (
      (o.buyerId && Number(o.buyerId) === Number(user.id)) ||
      (o.buyer && String(o.buyer).toLowerCase() === String(user.username).toLowerCase())
    )).map(shape);

    const asSeller = (db.orders || []).filter((o) => o && Array.isArray(o.items) &&
      o.items.some((it) => isItemForSeller(it, user, db) || (it.sellerId && Number(it.sellerId) === Number(user.id)))
    ).map(shape);

    return sendJSON(res, 200, {
      ok: true,
      orders: asBuyer,
      sellerOrders: asSeller,
      summary: {
        paidTotal: sum(asBuyer.filter((o) => o.paymentStatus === 'paid')),
        pendingTotal: sum(asBuyer.filter((o) => o.paymentStatus === 'pending')),
        heldTotal: sum(asBuyer.filter((o) => o.escrowStatus === 'Held')),
        releasedTotal: sum(asBuyer.filter((o) => o.escrowStatus === 'Released'))
      }
    });
  }


  // POST /api/orders/:id/confirm-delivery — Buyer confirms receipt and triggers dual payouts
  if (req.method === "POST" && pathname.startsWith("/api/orders/") && pathname.endsWith("/confirm-delivery")) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = pathname.replace("/api/orders/", "").replace("/confirm-delivery", "").trim();
    if (!orderId) return sendJSON(res, 400, { error: "Order ID required" });

    return await runAtomicCheckout(async () => {
      let db = refreshDb();
      const order = (db.orders || []).find(o => String(o.id) === orderId);
      if (!order) return sendJSON(res, 404, { error: "Order not found" });

      const isAdmin = isAdminUser(db, user);
      if (!isOrderForBuyer(order, user, db) && !isAdmin) {
        return sendJSON(res, 403, { error: "Permission denied: Only the buyer who placed this order can confirm delivery." });
      }

      if (order.escrowStatus === 'Released' || order.status === 'Released') {
        return sendJSON(res, 200, { ok: true, order, message: "Funds for this order were already released." });
      }

      if (order.escrowStatus === 'Refunded' || order.status === 'Cancelled' || order.status === 'Refunded') {
        return sendJSON(res, 400, { error: "Cannot release funds for a cancelled or refunded order." });
      }

      // Money must exist before it can be released, and an order only reaches Held
      // through markOrderPaid(). Orders marked "unverified" pre-date the payment
      // integration and were never actually funded, so an administrator must confirm
      // the payment before any real transfer is attempted for them.
      if (order.paymentStatus !== 'paid' || order.escrowStatus !== 'Held') {
        const reason = order.paymentStatus === 'pending'
          ? 'Cannot release funds: the buyer has not paid yet.'
          : order.paymentStatus === 'expired'
            ? 'Cannot release funds: this order expired unpaid and its stock was released.'
            : order.paymentStatus === 'unverified'
              ? 'Cannot release funds: this order pre-dates the payment integration and no payment was ever verified. An administrator can confirm the payment first.'
              : 'Cannot release funds: this order is not in a releasable state.';
        return sendJSON(res, 400, { error: reason });
      }

      // Resolve ONE payout per seller on the order. Previously a single seller was
      // resolved from items[0] and the WHOLE order subtotal was released to them, so
      // on a multi-seller order every other seller was silently paid nothing.
      const orderItems = Array.isArray(order.items) ? order.items : [];
      const payoutGroups = new Map();
      for (const it of orderItems) {
        if (!it) continue;
        const lineTotal = Math.round(((Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1)) * 100) / 100;
        const sellerUser = db.users.find(u =>
          (it.sellerId && Number(u.id) === Number(it.sellerId)) ||
          (u.username && it.seller && String(u.username).toLowerCase() === String(it.seller).toLowerCase())
        );
        const key = it.sellerId ? `id:${it.sellerId}` : `name:${String(it.seller || '').toLowerCase()}`;
        if (!payoutGroups.has(key)) {
          payoutGroups.set(key, {
            recipient: (sellerUser && (sellerUser.name || sellerUser.username)) || it.seller || 'RichStore Seller',
            sellerId: it.sellerId || (sellerUser && sellerUser.id) || null,
            phone: (sellerUser && sellerUser.phone) || it.sellerPhone || platformPaymentConfig().telecelPhone,
            amount: 0
          });
        }
        const group = payoutGroups.get(key);
        group.amount = Math.round((group.amount + lineTotal) * 100) / 100;
      }
      const sellerPayouts = [...payoutGroups.values()];
      const sellerPayoutAmount = Math.round(sellerPayouts.reduce((sum, g) => sum + g.amount, 0) * 100) / 100;
      const siteFeeAmount = Number(order.siteFee)
        || Math.max(0, Math.round(((Number(order.total) || 0) - sellerPayoutAmount) * 100) / 100);

      const nowIso = new Date().toISOString();

      // Attempt the REAL transfers. When no gateway key is configured we must never
      // record SUCCESS — paystack's simulation responses claim success while nothing
      // moves — so those payouts are queued as PENDING for an operator to settle.
      const gatewayReady = gatewayIsLive();
      const settlements = [];
      for (const group of sellerPayouts) {
        if (!gatewayReady) {
          settlements.push({
            recipient: group.recipient, sellerId: group.sellerId, phone: group.phone,
            amount: group.amount, status: 'PENDING', reference: null,
            note: 'Payment gateway not configured — queued for manual settlement'
          });
          continue;
        }
        try {
          const t = await paystack.payoutToSeller({
            orderId: order.id,
            sellerName: group.recipient,
            sellerPhone: group.phone,
            amountGhs: group.amount
          });
          const settled = t && t.ok === true && t.simulation !== true &&
            ['success', 'pending', 'otp'].includes(String(t.status));
          settlements.push({
            recipient: group.recipient, sellerId: group.sellerId, phone: group.phone,
            amount: group.amount,
            status: settled ? (String(t.status) === 'success' ? 'SUCCESS' : 'PENDING') : 'FAILED',
            reference: (t && t.reference) || null,
            transferCode: (t && t.transferCode) || null,
            note: t && t.skipped ? String(t.reason || '') : ''
          });
        } catch (err) {
          console.error(`Seller payout failed for order ${order.id} (${group.recipient}):`, err.message);
          settlements.push({
            recipient: group.recipient, sellerId: group.sellerId, phone: group.phone,
            amount: group.amount, status: 'FAILED', reference: null, note: err.message
          });
        }
      }

      // The platform fee really is in the platform's gateway balance only when the buyer
      // paid through the gateway; an offline transfer is still held by an operator.
      const feeCollectedViaGateway = order.paymentSource === 'paystack' && gatewayReady;

      order.status = 'Released';
      order.escrowStatus = 'Released';
      order.releasedAt = nowIso;
      order.releasedBy = user.username;
      order.payouts = {
        // One entry per seller on the order.
        sellers: settlements.map(g => ({
          recipient: g.recipient,
          sellerId: g.sellerId,
          phone: g.phone,
          amount: g.amount,
          status: g.status,
          reference: g.reference || null,
          note: g.note || '',
          releasedAt: nowIso
        })),
        // Back-compat: the previous shape exposed a single `seller` object, which the
        // seller and buyer order pages still read. For a single-seller order it is
        // identical to before; on a shared order it is that seller's own line.
        seller: settlements.length
          ? {
              recipient: settlements[0].recipient,
              phone: settlements[0].phone,
              amount: settlements[0].amount,
              status: settlements[0].status,
              reference: settlements[0].reference || null,
              releasedAt: nowIso
            }
          : null,
        platformTelecel: {
          feeAmount: siteFeeAmount,
          status: feeCollectedViaGateway ? 'COLLECTED' : 'PENDING',
          collectedAt: feeCollectedViaGateway ? nowIso : null,
          note: feeCollectedViaGateway ? '' : 'Held by the platform pending manual settlement'
        }
      };

      // Record in platform treasury
      if (db.platformTreasury) {
        if (!Array.isArray(db.platformTreasury.transactions)) db.platformTreasury.transactions = [];
        db.platformTreasury.transactions.push({
          id: 'RELEASE-' + Date.now(),
          type: 'ESCROW_RELEASE_COMPLETE',
          amount: order.total,
          sellerPayout: sellerPayoutAmount,
          siteFee: siteFeeAmount,
          referenceId: order.id,
          meta: order.payouts,
          createdAt: nowIso
        });
        if (db.platformTreasury.stats && feeCollectedViaGateway) {
          db.platformTreasury.stats.serviceFeesCollected = (Number(db.platformTreasury.stats.serviceFeesCollected) || 0) + siteFeeAmount;
          db.platformTreasury.stats.serviceFeesCollected = Math.round(db.platformTreasury.stats.serviceFeesCollected * 100) / 100;
        }
      }

      writeDB(db);
      return sendJSON(res, 200, {
        ok: true,
        order,
        message: (() => {
          const settledOk = settlements.filter(s => s.status === 'SUCCESS');
          const queued = settlements.filter(s => s.status === 'PENDING');
          const failed = settlements.filter(s => s.status === 'FAILED');
          if (failed.length) {
            return `Delivery confirmed, but ${failed.length} seller transfer(s) failed and need attention.`;
          }
          if (settlements.length > 0 && settledOk.length === settlements.length) {
            return `Delivery confirmed! GHs ${sellerPayoutAmount.toFixed(2)} sent to ${settlements.map(g => g.recipient).join(', ')}.`;
          }
          if (queued.length) {
            return `Delivery confirmed. GHs ${queued.reduce((s, g) => s + g.amount, 0).toFixed(2)} queued for settlement to ${queued.map(g => g.recipient).join(', ')} — no transfer has been sent yet.`;
          }
          return 'Delivery confirmed.';
        })()
      });
    });
  }

  // POST /api/orders/:id/refund — 24-hour non-delivery refund or unfulfilled cancellation
  if (req.method === "POST" && pathname.startsWith("/api/orders/") && pathname.endsWith("/refund")) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = pathname.replace("/api/orders/", "").replace("/refund", "").trim();
    if (!orderId) return sendJSON(res, 400, { error: "Order ID required" });

    return await runAtomicCheckout(async () => {
      let db = refreshDb();
      const order = (db.orders || []).find(o => String(o.id) === orderId);
      if (!order) return sendJSON(res, 404, { error: "Order not found" });

      const isAdmin = isAdminUser(db, user);
      if (!isOrderForBuyer(order, user, db) && !isAdmin) {
        return sendJSON(res, 403, { error: "Permission denied: Only the buyer who placed this order can request a refund." });
      }

      // An unpaid order has no money to return. Cancelling it is a stock release, not a
      // refund, and it must never be recorded as money handed back to the buyer.
      if (order.paymentStatus === 'pending' || order.paymentStatus === 'expired') {
        const releasedStock = restoreOrderStock(db, order, user.username);
        const cancelledAt = new Date().toISOString();
        order.status = 'Cancelled';
        order.escrowStatus = 'None';
        order.cancelledAt = cancelledAt;
        order.cancelledBy = user.username;
        writeDB(db);
        return sendJSON(res, 200, {
          ok: true,
          order,
          restoration: releasedStock,
          message: `Order #${order.id} cancelled — no payment had been received, so nothing was refunded.`
        });
      }

      // The money is the source of truth. A bare "Completed" status is deliberately
      // NOT a blocker on its own — it used to let a seller lock the buyer out of a
      // refund while the funds were still held.
      if (order.escrowStatus === 'Released' || order.status === 'Released') {
        return sendJSON(res, 400, { error: "Cannot refund an order after delivery has been confirmed and funds have been released." });
      }

      if (order.escrowStatus === 'Refunded' || order.status === 'Refunded') {
        return sendJSON(res, 200, { ok: true, order, message: "This order was already refunded." });
      }

      // Restore inventory stock atomically
      const restoration = restoreOrderStock(db, order, user.username);

      const nowIso = new Date().toISOString();

      // Attempt a REAL refund through the gateway when the buyer paid through it,
      // otherwise queue it for an operator. Either way we never report SUCCESS for a
      // transfer that nobody has made.
      let refundRes;
      const refundableViaGateway = order.paymentSource === 'paystack'
        && gatewayIsLive()
        && Boolean(order.paymentTransactionReference);

      if (refundableViaGateway) {
        try {
          const r = await paystack.refundTransaction({
            transactionReference: order.paymentTransactionReference,
            merchantNote: `Order ${order.id} cancelled`,
            customerNote: 'Your RichStore order has been refunded to your original payment method.'
          });
          const accepted = r && r.ok === true && r.simulation !== true;
          refundRes = {
            refundedAmount: order.total,
            status: accepted ? 'SUCCESS' : 'PENDING',
            refundId: (r && r.refundId) || null,
            processedAt: nowIso,
            note: accepted ? '' : 'The gateway did not confirm the refund; reconcile manually.'
          };
        } catch (err) {
          console.error(`Gateway refund failed for order ${order.id}:`, err.message);
          refundRes = { refundedAmount: order.total, status: 'FAILED', processedAt: nowIso, note: err.message };
        }
      } else {
        refundRes = {
          refundedAmount: order.total,
          status: 'PENDING',
          processedAt: nowIso,
          note: 'No gateway refund is available for this payment method — queued for manual settlement.'
        };
      }

      order.status = 'Refunded';
      order.escrowStatus = 'Refunded';
      order.refundedAt = nowIso;
      order.refundedBy = user.username;
      order.refundDetails = refundRes;

      if (db.platformTreasury) {
        if (!Array.isArray(db.platformTreasury.transactions)) db.platformTreasury.transactions = [];
        db.platformTreasury.transactions.push({
          id: 'REFUND-' + Date.now(),
          type: 'ESCROW_REFUND_PROCESSED',
          amount: order.total,
          referenceId: order.id,
          meta: refundRes,
          createdAt: nowIso
        });
      }

      writeDB(db);
      return sendJSON(res, 200, {
        ok: true,
        order,
        restoration,
        message: refundRes.status === 'SUCCESS'
          ? `Order #${order.id} cancelled. GHs ${order.total.toFixed(2)} has been refunded to the original payment method.`
          : refundRes.status === 'PENDING'
            ? `Order #${order.id} cancelled. The GHs ${order.total.toFixed(2)} refund is queued and will be settled manually.`
            : `Order #${order.id} cancelled, but the refund could not be completed and needs attention.`
      });
    });
  }

  // GET /api/orders/:id — one order, visible to its buyer, its sellers, or an admin.
  // pay.html polls this while a payment is pending.
  if (req.method === "GET" && pathname.startsWith("/api/orders/")) {
    const user = getUserFromToken(db, (req.headers['authorization'] || '').split(' ')[1]);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = decodeURIComponent(pathname.replace("/api/orders/", "").trim());
    if (!orderId) return sendJSON(res, 400, { error: "Order ID required" });

    const fresh = refreshDb();
    const order = (fresh.orders || []).find(o => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: "Order not found" });

    const isAdmin = isAdminUser(fresh, user);
    const isSeller = Array.isArray(order.items) && order.items.some(it => isItemForSeller(it, user, fresh));
    const isBuyer = isOrderForBuyer(order, user, fresh);
    if (!isAdmin && !isSeller && !isBuyer) {
      return sendJSON(res, 403, { error: "Permission denied: this order does not belong to you." });
    }

    // The delivery PIN is the buyer's proof-of-delivery handshake, so it is never
    // disclosed to the seller or anyone else looking at the order.
    const safeOrder = { ...order };
    if (!isAdmin && !isBuyer) delete safeOrder.deliveryPin;
    return sendJSON(res, 200, { ok: true, order: safeOrder });
  }

  // GET /api/orders (Manage Orders)
  if (req.method === "GET" && pathname === "/api/orders") {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    db = refreshDb();
    const isAdmin = isAdminUser(db, user);
    const allOrders = Array.isArray(db.orders) ? db.orders : [];
    const isBuyerAccount = user.accountType === 'buyer';

    // Build visible orders:
    // - Admin sees every order in full.
    // - Buyers see the full orders they placed with the complete list of items.
    // - Sellers see ONLY orders containing items they posted, and ONLY their own items within each order, with recalculated totals.
    let enriched = [];

    for (const o of allOrders) {
      const allItems = Array.isArray(o.items) ? o.items : [];
      const orderSubtotal = Number(o.subtotal) || Number(o.total) || 0;
      const orderTotal = Number(o.total) || orderSubtotal;
      const siteFee = Number(o.siteFee) || Math.max(0, Math.round((orderTotal - orderSubtotal) * 100) / 100);
      const escrowStatus = o.escrowStatus || (
        o.status === 'Cancelled' ? 'Refunded' :
        ['Completed', 'Released'].includes(o.status) ? 'Released' :
        ['PendingPayment', 'pending'].includes(o.status) ? 'PendingPayment' :
        'Held'
      );
      const isPaymentConfirmed = Boolean(o.paymentConfirmed || o.paidAt || ['Held', 'Released'].includes(escrowStatus));
      const siteFeeApplied = isPaymentConfirmed;

      if (isAdmin) {
        // Admin: show the full order unchanged with all escrow details
        let totalQty = allItems.reduce((sum, it) => sum + (Number(it.qty) || 1), 0);
        enriched.push({
          id: o.id,
          buyer: o.buyer || "guest",
          buyerName: o.buyerName || o.buyer || "Valued Customer",
          buyerLocation: o.buyerLocation || o.location || o.address || "Accra, Ghana",
          buyerPhone: o.buyerPhone || o.phone || (allItems[0] && allItems[0].sellerPhone) || platformPaymentConfig().telecelPhone,
          items: allItems,
          totalQuantity: totalQty,
          subtotal: orderSubtotal,
          siteFee,
          total: orderTotal,
          sellerPayoutAmount: orderSubtotal,
          siteFeeAmount: siteFee,
          status: o.status || "Processing",
          escrowStatus,
          paymentConfirmed: isPaymentConfirmed,
          siteFeeApplied,
          paymentRef: o.paymentRef || o.paystackRef || null,
          paystackRef: o.paystackRef || o.paymentRef || null,
          paidAt: o.paidAt || null,
          escrowExpiresAt: o.escrowExpiresAt || null,
          canConfirmDelivery: isPaymentConfirmed && escrowStatus !== 'Released' && o.status !== 'Cancelled',
          canRefund: isPaymentConfirmed && escrowStatus !== 'Released' && o.status !== 'Cancelled',
          payouts: o.payouts || null,
          refundDetails: o.refundDetails || null,
          placedAt: o.placedAt || new Date().toISOString(),
        });
      } else if (isBuyerAccount) {
        // Buyer: show full orders placed by this buyer with complete item list and escrow transparency
        if (!isOrderForBuyer(o, user, db)) continue;
        let totalQty = allItems.reduce((sum, it) => sum + (Number(it.qty) || 1), 0);
        enriched.push({
          id: o.id,
          buyer: o.buyer || user.username,
          buyerName: o.buyerName || user.name || user.username,
          buyerLocation: o.buyerLocation || o.location || user.location || "Accra, Ghana",
          buyerPhone: o.buyerPhone || o.phone || user.phone || "",
          items: allItems,
          totalQuantity: totalQty,
          subtotal: orderSubtotal,
          siteFee,
          total: orderTotal,
          sellerPayoutAmount: orderSubtotal,
          siteFeeAmount: siteFee,
          status: o.status || "Processing",
          escrowStatus,
          paymentConfirmed: isPaymentConfirmed,
          siteFeeApplied,
          paymentRef: o.paymentRef || o.paystackRef || null,
          paystackRef: o.paystackRef || o.paymentRef || null,
          paidAt: o.paidAt || null,
          escrowExpiresAt: o.escrowExpiresAt || null,
          canConfirmDelivery: isPaymentConfirmed && escrowStatus !== 'Released' && o.status !== 'Cancelled',
          canRefund: isPaymentConfirmed && escrowStatus !== 'Released' && o.status !== 'Cancelled',
          payouts: o.payouts || null,
          refundDetails: o.refundDetails || null,
          placedAt: o.placedAt || new Date().toISOString(),
        });
      } else {
        // Seller: ONLY include orders containing items this seller posted!
        // Show BOTH the total paid by the buyer withheld in escrow, and the seller's net payout!
        const sellerItems = allItems.filter(it => isItemForSeller(it, user, db));
        if (sellerItems.length === 0) continue; // Skip order if no items from this seller

        const sellerSubtotal = Math.round(sellerItems.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 1), 0) * 100) / 100;
        const sellerQty = sellerItems.reduce((sum, it) => sum + (Number(it.qty) || 1), 0);
        const buyerPaidTotal = orderTotal;

        enriched.push({
          id: o.id,
          buyer: o.buyer || "guest",
          buyerName: o.buyerName || o.buyer || "Valued Customer",
          buyerLocation: o.buyerLocation || o.location || o.address || "Accra, Ghana",
          buyerPhone: o.buyerPhone || o.phone || "",
          items: sellerItems,
          totalQuantity: sellerQty,
          subtotal: sellerSubtotal,
          siteFee,
          total: buyerPaidTotal,
          buyerPaidTotal,
          sellerPayoutAmount: sellerSubtotal,
          siteFeeAmount: siteFee,
          status: o.status || "Processing",
          escrowStatus,
          paymentConfirmed: isPaymentConfirmed,
          siteFeeApplied,
          paymentRef: o.paymentRef || o.paystackRef || null,
          paystackRef: o.paystackRef || o.paymentRef || null,
          paidAt: o.paidAt || null,
          escrowExpiresAt: o.escrowExpiresAt || null,
          payouts: o.payouts || null,
          refundDetails: o.refundDetails || null,
          placedAt: o.placedAt || new Date().toISOString(),
        });
      }
    }

    // Sort newest orders first
    enriched.sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));

    return sendJSON(res, 200, { ok: true, orders: enriched });
  }

  // GET /api/my-orders (Buyer Order History / Tracking)
  if (req.method === "GET" && pathname === "/api/my-orders") {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    db = refreshDb();
    const allOrders = Array.isArray(db.orders) ? db.orders : [];

    let myOrders = [];
    for (const o of allOrders) {
      if (!isOrderForBuyer(o, user, db)) continue;
      const allItems = Array.isArray(o.items) ? o.items : [];
      let totalQty = allItems.reduce((sum, it) => sum + (Number(it.qty) || 1), 0);

      // Enrich items with seller details if missing
      const completeItems = allItems.map(it => {
        let seller = it.seller;
        let sellerPhone = it.sellerPhone;
        let emoji = it.emoji;
        let images = it.images;
        if (!seller || !sellerPhone || !emoji || !images) {
          const l = Array.isArray(db.listings) ? db.listings.find(x => x.id === it.id) : null;
          if (l) {
            if (!seller) seller = l.seller;
            if (!sellerPhone) sellerPhone = l.sellerPhone;
            if (!emoji) emoji = l.emoji;
            if (!images) images = l.images;
          }
        }
        return {
          ...it,
          seller: seller || 'RichStore',
          sellerPhone: sellerPhone || '',
          emoji: emoji || '📦',
          images: Array.isArray(images) ? images : []
        };
      });

      const orderSubtotal = Number(o.subtotal) || Number(o.total) || 0;
      const orderTotal = Number(o.total) || orderSubtotal;
      const siteFee = Number(o.siteFee) || Math.max(0, Math.round((orderTotal - orderSubtotal) * 100) / 100);
      const escrowStatus = o.escrowStatus || (o.status === 'Cancelled' ? 'Refunded' : (['Completed', 'Released'].includes(o.status) ? 'Released' : 'Held'));

      myOrders.push({
        id: o.id,
        buyer: o.buyer || user.username,
        buyerName: o.buyerName || user.name || user.username,
        buyerLocation: o.buyerLocation || user.location || "Accra, Ghana",
        buyerPhone: o.buyerPhone || user.phone || "",
        items: completeItems,
        totalQuantity: totalQty,
        subtotal: orderSubtotal,
        siteFee,
        total: orderTotal,
        sellerPayoutAmount: orderSubtotal,
        siteFeeAmount: siteFee,
        status: o.status || "Processing",
        escrowStatus,
        paymentRef: o.paymentRef || o.paystackRef || null,
        paystackRef: o.paystackRef || o.paymentRef || null,
        paidAt: o.paidAt || null,
        escrowExpiresAt: o.escrowExpiresAt || null,
        canConfirmDelivery: (escrowStatus === 'Held' || ['Processing', 'Dispatched', 'Delivered', 'Held'].includes(o.status)) && escrowStatus !== 'Released' && o.status !== 'Cancelled',
        canRefund: (escrowStatus === 'Held' || ['Processing', 'Dispatched', 'Held'].includes(o.status)) && escrowStatus !== 'Released' && o.status !== 'Cancelled',
        payouts: o.payouts || null,
        refundDetails: o.refundDetails || null,
        placedAt: o.placedAt || new Date().toISOString(),
      });
    }

    myOrders.sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
    return sendJSON(res, 200, { ok: true, orders: myOrders });
  }

  // PUT /api/orders/:id/status (Update order status / location / phone)
  if (req.method === "PUT" && pathname.startsWith("/api/orders/")) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }

    const orderId = pathname.replace("/api/orders/", "").replace("/status", "").trim();
    if (!orderId) return sendJSON(res, 400, { error: "Order ID required" });

    db = refreshDb();
    const order = (db.orders || []).find(o => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: "Order not found" });

    const isAdmin = isAdminUser(db, user);
    const isSeller = Array.isArray(order.items) && order.items.some(it => isItemForSeller(it, user, db));
    if (!isAdmin && !isSeller) {
      return sendJSON(res, 403, { error: "Permission denied: Only sellers or administrators can update order status" });
    }

    const allowedStatuses = ["PendingPayment", "Pending", "Held", "Processing", "Dispatched", "Delivered", "Completed", "Released", "Refunded", "Cancelled"];
    // A fulfilment order moves forward through delivery stages:
    const ORDER_STATUS_FLOW = {
      PendingPayment: ['Held', 'Cancelled'],
      Pending: ['Processing', 'Dispatched', 'Cancelled'],
      Held: ['Processing', 'Dispatched', 'Cancelled'],
      Processing: ['Dispatched', 'Cancelled'],
      Dispatched: ['Delivered', 'Cancelled'],
      Delivered: ['Completed', 'Released'],
      Released: [],
      Completed: [],
      Refunded: [],
      Cancelled: [],
    };

    if (body.status !== undefined) {
      const next = String(body.status);
      if (!allowedStatuses.includes(next)) {
        return sendJSON(res, 400, { error: `Unknown order status "${next}"` });
      }

      // A seller must not be able to self-certify delivery, nor to cancel an order
      // that contains other sellers' items. Previously a seller could walk an order
      // to "Completed" — which permanently blocked the buyer's refund — or set an
      // order-wide "Cancelled" and restock inventory that was not theirs. Delivery
      // and completion are administrator-only: the buyer confirms receipt through
      // /confirm-delivery, which is what releases the funds.
      if (!isAdmin) {
        if (next === 'Delivered' || next === 'Completed') {
          return sendJSON(res, 403, {
            error: `Only an administrator can move this order to "${next}". The buyer confirms receipt from their own orders page.`
          });
        }
        if (next === 'Cancelled') {
          const orderItems = Array.isArray(order.items) ? order.items : [];
          const ownsEveryItem = orderItems.length > 0 && orderItems.every(it => isItemForSeller(it, user, db));
          if (!ownsEveryItem) {
            return sendJSON(res, 403, {
              error: 'This order contains items from other sellers, so only an administrator can cancel it.'
            });
          }
        }
      }

      const current = order.status || 'Processing';
      if (next !== current && !isAdmin) {
        const permitted = ORDER_STATUS_FLOW[current] || [];
        if (!permitted.includes(next)) {
          return sendJSON(res, 409, {
            error: `This order cannot move from "${current}" to "${next}".`
          });
        }
      }
      if (next === 'Cancelled' && current !== 'Cancelled') {
        // Cancelling restores the stock this order had reserved.
        const restoration = restoreOrderStock(db, order, user.username);
        order.status = 'Cancelled';
        order.updatedAt = new Date().toISOString();
        order.updatedBy = user.username;
        writeDB(db);
        return sendJSON(res, 200, { ok: true, order, restoration });
      }
      order.status = next;
      order.updatedAt = new Date().toISOString();
      order.updatedBy = user.username;
    }

    // Delivery contact details belong to the buyer; only an administrator may
    // correct them, and a phone number must still be a valid Ghanaian number.
    if (body.buyerLocation !== undefined || body.buyerPhone !== undefined) {
      if (!isAdmin) {
        return sendJSON(res, 403, { error: 'Only the buyer or an administrator can change delivery contact details.' });
      }
      if (body.buyerLocation !== undefined) {
        order.buyerLocation = String(body.buyerLocation).trim().slice(0, 300);
      }
      if (body.buyerPhone !== undefined) {
        const normalizedBuyerPhone = validatePhoneGH(body.buyerPhone);
        if (!normalizedBuyerPhone) return sendJSON(res, 400, { error: 'Invalid buyer phone number' });
        order.buyerPhone = normalizedBuyerPhone;
      }
    }

    writeDB(db);
    return sendJSON(res, 200, { ok: true, order });
  }

  // POST /api/orders/:id/cancel — the buyer may cancel their own order while it is
  // still Pending/Processing (i.e. before it has been dispatched).
  if (req.method === "POST" && pathname.startsWith("/api/orders/") && pathname.endsWith("/cancel")) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    const orderId = pathname.replace("/api/orders/", "").replace("/cancel", "").trim();
    if (!orderId) return sendJSON(res, 400, { error: "Order ID required" });

    db = refreshDb();
    const order = (db.orders || []).find(o => String(o.id) === orderId);
    if (!order) return sendJSON(res, 404, { error: "Order not found" });

    const isAdmin = isAdminUser(db, user);
    if (!isOrderForBuyer(order, user, db) && !isAdmin) {
      return sendJSON(res, 403, { error: 'Only the buyer of this order can cancel it.' });
    }
    if (order.status === 'Cancelled') {
      return sendJSON(res, 200, { ok: true, order, message: 'This order was already cancelled.' });
    }
    if (!isAdmin && !['Pending', 'Processing'].includes(order.status || 'Processing')) {
      return sendJSON(res, 409, {
        error: `This order can no longer be cancelled because it is already "${order.status}".`
      });
    }

    const restoration = restoreOrderStock(db, order, user.username);
    order.status = 'Cancelled';
    order.updatedAt = new Date().toISOString();
    order.updatedBy = user.username;
    writeDB(db);
    return sendJSON(res, 200, {
      ok: true,
      order,
      restoration,
      message: 'Order cancelled and the reserved stock was returned to the seller.'
    });
  }

  // DELETE /api/orders/:id — Admin-only: delete a specific order from the system (sellers & buyers pages)
  if (req.method === "DELETE" && pathname.startsWith("/api/orders/")) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    db = refreshDb();
    if (!isAdminUser(db, user)) {
      return sendJSON(res, 403, { error: 'Access denied: Only administrators can delete orders' });
    }

    const orderId = pathname.replace("/api/orders/", "").trim();
    const allOrders = Array.isArray(db.orders) ? db.orders : [];
    const idx = allOrders.findIndex(o => String(o.id) === String(orderId));
    if (idx === -1) {
      return sendJSON(res, 404, { error: `Order #${orderId} not found` });
    }

    db.orders.splice(idx, 1);
    writeDB(db);
    return sendJSON(res, 200, {
      ok: true,
      orderId,
      message: `Order #${orderId} permanently deleted from the system (sellers & buyers pages).`,
      remainingOrders: db.orders.length
    });
  }

  // DELETE /api/orders — Admin-only: clear all orders from the system (sellers & buyers pages)
  if (req.method === "DELETE" && pathname === "/api/orders") {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });

    db = refreshDb();
    if (!isAdminUser(db, user)) {
      return sendJSON(res, 403, { error: 'Access denied: Only administrators can delete orders' });
    }

    const allOrders = Array.isArray(db.orders) ? db.orders : [];
    const cleared = allOrders.length;
    db.orders = [];
    writeDB(db);
    return sendJSON(res, 200, {
      ok: true,
      message: `All ${cleared} orders cleared successfully from the system (sellers & buyers pages).`,
      cleared,
      remaining: 0
    });
  }

  // GET /api/admin/data (Strict Admin Privileges)
  if (req.method === 'GET' && pathname === '/api/admin/data') {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    if (!isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Access denied: Admin privileges required' });

    const relations = buildAdminRelations(db);
    return sendJSON(res, 200, { ok: true, ...relations });
  }

  // GET /api/admin/user/:username (Relational drilldown for specific user)
  if (req.method === 'GET' && pathname.startsWith('/api/admin/user/')) {
    const authHeader = (req.headers['authorization'] || '');
    const token = authHeader.split(' ')[1];
    const user = getUserFromToken(db, token);
    if (!user) return sendJSON(res, 401, { error: 'Authentication required' });
    if (!isAdminUser(db, user)) return sendJSON(res, 403, { error: 'Access denied: Admin privileges required' });

    const targetUsername = decodeURIComponent(pathname.slice('/api/admin/user/'.length)).trim();
    const relations = buildAdminRelations(db);
    const targetUser = relations.users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
    if (!targetUser) return sendJSON(res, 404, { error: 'User not found' });

    const userListings = relations.listings.filter(l => l.seller.toLowerCase() === targetUsername.toLowerCase());
    const userPurchases = relations.purchases.filter(p => p.buyer.toLowerCase() === targetUsername.toLowerCase());
    const userSales = relations.orderItems.filter(i => i.seller.toLowerCase() === targetUsername.toLowerCase());

    return sendJSON(res, 200, {
      ok: true,
      user: targetUser,
      listings: userListings,
      purchases: userPurchases,
      sales: userSales
    });
  }

  // Log the exact method and path. Without this line a client-side "route error" is
  // almost impossible to trace back to the request that was missed.
  console.warn(`[API] Unknown route: ${req.method} ${pathname}`);
  return sendJSON(res, 404, { error: "Unknown API route" });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Add security and CORS headers.
  // CORS is limited to an explicit allow-list — a wildcard let any website drive this
  // API using a token it had obtained. Only an allowed Origin is echoed back; requests
  // we do not recognise simply receive no CORS grant.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const requestOrigin = req.headers.origin;
  if (requestOrigin && isOriginAllowed(requestOrigin, req)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Internal documentation (site_logic.md) must never be served from the web root.
  // The file is kept on disk for reference but is blocked here.
  if (pathname === '/site_logic.md' || pathname.startsWith('/site_logic.')) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    return res.end('Not Found');
  }

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname, parsed.query);
    } catch (err) {
      console.error("API Error:", err.message);
      sendJSON(res, 500, { error: "Server error" });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

try {
  migrateUserSchema(readDB());
  console.log('✓ User schema migrated/validated successfully');
} catch (err) {
  console.error('User schema migration error:', err.message);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Server running on port ${PORT}`);
  console.log(`✓ On this PC: http://localhost:${PORT}`);
  console.log(`✓ On your phone (same Wi-Fi): http://<your-PC-IP>:${PORT}\n`);
});
