const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execFile } = require('child_process');
// Shared relational model (single source of truth with server.js)
const { buildAdminRelations } = require('./relations');

// Load .env configuration if present (Zero-dependency production environment loader)
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  } catch (err) {
    console.error('Warning: Failed to parse .env file:', err.message);
  }
}

const PORT = parseInt(process.env.ADMIN_PORT, 10) || 4000;
const DB_FILE = path.join(__dirname, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'admin-public');
// Access DB path comes ONLY from environment/.env — never hardcoded to a machine path.
const ACCESS_DB_FILE = (process.env.ACCESS_DB_PATH || '').trim();

// X-Forwarded-For is attacker-controlled unless a reverse proxy sets it, so the
// admin login lockout only honours it when the deployment opts in with TRUST_PROXY=1.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function getAdminClientIP(req) {
  if (TRUST_PROXY) {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

// Master Admin credentials come ONLY from environment/.env. No hardcoded fallbacks:
// if unset, admin login is disabled (fail closed).
const ADMIN_CREDENTIALS = {
  username: (process.env.ADMIN_USERNAME || '').trim().toLowerCase(),
  password: process.env.ADMIN_PASSWORD || '',
};
const ADMIN_AUTH_CONFIGURED = !!(ADMIN_CREDENTIALS.username && ADMIN_CREDENTIALS.password);
if (!ADMIN_AUTH_CONFIGURED) {
  console.error('⚠ Admin login DISABLED: set ADMIN_USERNAME and ADMIN_PASSWORD in .env to enable.');
}

// In-Memory or Persisted Admin Sessions
const adminSessions = new Map(); // token -> { username, createdAt, expiresAt }
let lastAccessSync = null;

function syncToAccess() {
  return new Promise((resolve, reject) => {
    if (!ACCESS_DB_FILE) {
      return reject(new Error('ACCESS_DB_PATH is not configured in .env'));
    }
    const psScript = path.join(__dirname, 'scripts', 'sync_access.ps1');
    execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', psScript, '-AccdbPath', ACCESS_DB_FILE], (error, stdout, stderr) => {
      if (error) {
        console.error('MS Access Sync Error:', error.message, stderr);
        return reject(error);
      }
      try {
        const json = JSON.parse(stdout.trim());
        lastAccessSync = json;
        resolve(json);
      } catch (err) {
        lastAccessSync = { ok: true, syncedAt: new Date().toISOString() };
        resolve(lastAccessSync);
      }
    });
  });
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    console.error('Failed to read db.json:', err.message);
    return { listings: [], users: [], orders: [] };
  }
}

function writeDB(db) {
  const content = JSON.stringify(db, null, 2);
  const tmpFile = DB_FILE + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');
    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmpFile, DB_FILE);
        renamed = true;
        break;
      } catch (e) {
        if (attempt === 4) break;
      }
    }
    if (!renamed) {
      fs.writeFileSync(DB_FILE, content, 'utf-8');
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (err) {
    console.error('Failed to write db.json atomically:', err.message);
  }
}

// ---------- Production Admin Anti-Brute-Force Engine ----------
const adminRateLimits = new Map();
function checkAdminRateLimit(ip, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const entry = adminRateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    adminRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  if (entry.count >= maxAttempts) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, remaining: maxAttempts - entry.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of adminRateLimits.entries()) {
    if (now > v.resetAt) adminRateLimits.delete(k);
  }
}, 10 * 60 * 1000).unref();

function isSellerPhoneVerified(db, sellerUsername, sellerPhone) {
  const cleanDigits = (p) => (p ? String(p).replace(/\D/g, '').slice(-9) : '');
  const target = cleanDigits(sellerPhone);

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

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Request entity too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getAdminSession(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  const session = adminSessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}



// Static File Mime Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  safePath = path.normalize(safePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // Boundary compare with a trailing separator so a sibling directory whose name
  // merely starts with "admin-public" cannot pass the check.
  const publicPrefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- Main Server Handler ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Security and CORS Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // --- API Endpoints ---

  // POST /api/login (Master Admin Login)
  if (req.method === 'POST' && pathname === '/api/login') {
    const clientIP = getAdminClientIP(req);
    const rl = checkAdminRateLimit(clientIP, 6, 15 * 60 * 1000); // 6 attempts per 15 mins
    if (!rl.allowed) {
      return sendJSON(res, 429, { error: `Too many failed admin login attempts. Locked out for ${rl.retryAfterSeconds}s for security.` });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJSON(res, 400, { error: 'Invalid JSON request' });
    }

    const { username, password } = body || {};
    const inputUser = String(username || '').trim().toLowerCase();
    const inputPass = String(password || '');

    if (!ADMIN_AUTH_CONFIGURED) {
      return sendJSON(res, 503, { error: 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env.' });
    }

    // Timing-safe comparison over fixed-length sha256 digests (no plaintext ===)
    const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
    const u1 = digest(inputUser); const u2 = digest(ADMIN_CREDENTIALS.username);
    const p1 = digest(inputPass); const p2 = digest(ADMIN_CREDENTIALS.password);
    const userOk = crypto.timingSafeEqual(u1, u2);
    const passOk = crypto.timingSafeEqual(p1, p2);

    if (userOk && passOk) {
      const token = generateToken();
      const session = {
        username: ADMIN_CREDENTIALS.username,
        createdAt: Date.now(),
        expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24-hour TTL
      };
      adminSessions.set(token, session);

      return sendJSON(res, 200, {
        ok: true,
        token,
        admin: { username: ADMIN_CREDENTIALS.username, role: 'Super Administrator' },
      });
    }

    return sendJSON(res, 401, { error: 'Invalid admin username or password' });
  }

  // POST /api/logout
  if (req.method === 'POST' && pathname === '/api/logout') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (token) adminSessions.delete(token);
    return sendJSON(res, 200, { ok: true, message: 'Logged out successfully' });
  }

  // GET /api/me
  if (req.method === 'GET' && pathname === '/api/me') {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });
    return sendJSON(res, 200, {
      ok: true,
      admin: { username: session.username, role: 'Super Administrator' },
    });
  }

  // GET /api/relations (Complete Relational Model Data)
  if (req.method === 'GET' && pathname === '/api/relations') {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });

    const db = readDB();
    const relations = buildAdminRelations(db);
    return sendJSON(res, 200, { ok: true, ...relations });
  }

  // GET /api/user/:username (Drilldown Relation)
  if (req.method === 'GET' && pathname.startsWith('/api/user/')) {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });

    const targetUsername = decodeURIComponent(pathname.slice('/api/user/'.length)).trim();
    const db = readDB();
    const relations = buildAdminRelations(db);
    const targetUser = relations.users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
    if (!targetUser) return sendJSON(res, 404, { error: 'User not found in relations' });

    const userListings = relations.listings.filter(l => l.seller.toLowerCase() === targetUsername.toLowerCase());
    const userPurchases = relations.purchases.filter(p => p.buyer.toLowerCase() === targetUsername.toLowerCase());
    const userSales = relations.orderItems.filter(i => i.seller.toLowerCase() === targetUsername.toLowerCase());

    return sendJSON(res, 200, {
      ok: true,
      user: targetUser,
      listings: userListings,
      purchases: userPurchases,
      sales: userSales,
    });
  }

  // POST /api/sync-access (Trigger MS Access Database Sync)
  if (req.method === 'POST' && pathname === '/api/sync-access') {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });

    try {
      const result = await syncToAccess();
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { error: 'MS Access synchronization failed: ' + err.message });
    }
  }

  // GET /api/sync-access/status
  if (req.method === 'GET' && pathname === '/api/sync-access/status') {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });
    return sendJSON(res, 200, { ok: true, lastSync: lastAccessSync, database: ACCESS_DB_FILE });
  }

  // --- Admin Order Management ---

  // DELETE /api/orders (Delete all orders across the system for both sellers and buyers)
  if (req.method === 'DELETE' && pathname === '/api/orders') {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });

    const db = readDB();
    const count = Array.isArray(db.orders) ? db.orders.length : 0;
    db.orders = [];
    writeDB(db);

    // Auto background sync to MS Access
    syncToAccess().catch(() => {});

    return sendJSON(res, 200, {
      ok: true,
      deletedCount: count,
      message: `All ${count} orders permanently deleted from the system (sellers & buyers pages).`
    });
  }

  // DELETE /api/orders/:id (Delete a specific order by ID for both sellers and buyers)
  const adminOrderDeleteMatch = pathname.match(/^\/api\/orders\/([^\/]+)$/);
  if (req.method === 'DELETE' && adminOrderDeleteMatch) {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });

    const orderId = decodeURIComponent(adminOrderDeleteMatch[1]).trim();
    const db = readDB();
    db.orders = Array.isArray(db.orders) ? db.orders : [];

    const orderIdx = db.orders.findIndex(o => String(o.id) === String(orderId));
    if (orderIdx === -1) {
      return sendJSON(res, 404, { error: `Order #${orderId} not found.` });
    }

    db.orders.splice(orderIdx, 1);
    writeDB(db);

    // Auto background sync to MS Access
    syncToAccess().catch(() => {});

    return sendJSON(res, 200, {
      ok: true,
      orderId,
      message: `Order #${orderId} permanently deleted from the system (sellers & buyers pages).`,
      remainingOrders: db.orders.length
    });
  }

  // GET, PUT, DELETE /api/listings/:id (Admin Single Listing Management)
  const listingIdMatch = pathname.match(/^\/api\/listings\/(\d+)$/);
  if (listingIdMatch) {
    const session = getAdminSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Admin authentication required' });
    const id = Number(listingIdMatch[1]);
    const db = readDB();
    const item = (db.listings || []).find(l => l.id === id);
    if (!item) return sendJSON(res, 404, { error: 'Listing not found' });

    if (req.method === 'GET') {
      const phoneVerified = isSellerPhoneVerified(db, item.seller, item.sellerPhone);
      return sendJSON(res, 200, { ok: true, listing: { ...item, sellerPhoneVerified: phoneVerified } });
    }

    if (req.method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }

      const allowed = ['title', 'category', 'price', 'condition', 'description', 'stock', 'emoji', 'color', 'sellerPhone', 'sellerAddress', 'seller', 'images'];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        if (k === 'price') {
          const p = Number(body.price);
          if (!Number.isFinite(p) || p < 0) return sendJSON(res, 400, { error: 'price must be a non-negative number' });
          item.price = Math.round(p * 100) / 100;
        } else if (k === 'stock') {
          const rawStock = String(body.stock).trim();
          if (!/^\d+$/.test(rawStock)) return sendJSON(res, 400, { error: 'stock must be a non-negative integer' });
          item.stock = parseInt(rawStock, 10);
        } else if (k === 'images') {
          item.images = Array.isArray(body.images) ? body.images : [String(body.images || '')];
        } else if (k === 'title') {
          item.title = String(body.title).slice(0, 120);
        } else if (k === 'description') {
          item.description = String(body.description).slice(0, 2000);
        } else {
          item[k] = String(body[k]);
        }
      }
      writeDB(db);
      // Background sync to MS Access
      syncToAccess().catch(() => {});
      return sendJSON(res, 200, { ok: true, listing: item });
    }

    if (req.method === 'DELETE') {
      const idx = (db.listings || []).findIndex(l => l.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Listing not found' });
      const removed = db.listings.splice(idx, 1)[0];
      writeDB(db);
      // Background sync to MS Access
      syncToAccess().catch(() => {});
      return sendJSON(res, 200, { ok: true, deleted: removed });
    }
  }

  // Fallback to static files
  if (pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: 'Unknown Admin API route' });
  }

  serveStatic(req, res, pathname);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`👑 RichStore Standalone Admin Server Live on Port ${PORT}`);
    console.log(`🔒 Access URL: http://localhost:${PORT}/login.html`);
    console.log(ADMIN_AUTH_CONFIGURED
      ? `🔑 Master login configured (username from .env)`
      : `🔒 Master login DISABLED — set ADMIN_USERNAME/ADMIN_PASSWORD in .env`);
    console.log(`======================================================\n`);
  });
}

module.exports = {
  server,
  buildAdminRelations,
  readDB
};
