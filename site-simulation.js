#!/usr/bin/env node
/**
 * RichStore — vital-process simulation.
 *
 * Runs the site's critical flows end-to-end against a RUNNING server and prints
 * a PASS/FAIL table. Zero dependencies (requires Node 18+ for global fetch).
 *
 *   1) node server.js            (storefront, :3000)
 *   2) node admin-server.js      (admin,      :4000)
 *   3) node tools/site-simulation.js
 *
 * Safety: db.json is backed up to db.json.simbak before the run and restored
 * afterwards, so the test accounts/listings/orders it creates do not persist.
 * Nothing in the project source is modified.
 *
 * NOTE: this script contains DELIBERATE security probes, and a FAIL is the FINDING,
 * not a bug in the script:
 *
 *   T6  — the removed wallet top-up route must stay gone (finding C1, fixed).
 *   T6b — an order must not be marked paid/released without a verified payment.
 *         THIS PROBE IS EXPECTED TO FAIL until the escrow model is wired up; see
 *         SITE_REVIEW_2026-09-30.md §2 (C-1). It is the regression test for it.
 *   T10 — claiming another account's phone number must not expose their orders
 *         (finding C2, fixed).
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.SIM_BASE || 'http://127.0.0.1:3000';
const ADMIN_BASE = process.env.SIM_ADMIN_BASE || 'http://127.0.0.1:4000';
const DB_PATH = path.join(__dirname, '..', 'db.json');
const BAK_PATH = DB_PATH + '.simbak';
const KEEP = process.argv.includes('--keep-data');
const STAMP = Date.now().toString(36);
const SELLER = { username: 'simsel_' + STAMP, password: 'SimPass123!', phone: '020' + (1000000 + (Date.now() % 8999999)) };
const BUYER = { username: 'simbuy_' + STAMP, password: 'SimPass123!', phone: '055' + (1000000 + (Date.now() % 8999999)) };

const results = [];
let fatal = false;

function record(id, kind, area, title, status, detail) {
  const entry = { id, kind, area, title, status, detail };
  results.push(entry);
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status === 'WARN' ? 'WARN' : 'INFO';
  console.log(`[${icon}] ${id} ${title}${detail ? '  — ' + detail : ''}`);
  return entry;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res, text = '';
  try {
    res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    text = await res.text();
  } catch (err) {
    return { status: 0, json: null, text: '', error: err.message };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  return { status: res.status, json, text };
}
const post = (base, p, body, token) => call(base, 'POST', p, { body, token });
const get = (base, p, token) => call(base, 'GET', p, { token });
const put = (base, p, body, token) => call(base, 'PUT', p, { body, token });
const del = (base, p, token) => call(base, 'DELETE', p, { token });

async function requireServer() {
  const r = await get(BASE, '/api/listings');
  if (!r || r.status === 0) {
    console.error(`\nCannot reach the storefront at ${BASE} (${r && r.error}). Start it first: node server.js\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- test bodies

async function t1_public() {
  const r = await get(BASE, '/api/listings');
  const ok = r.status === 200 && Array.isArray((r.json || {}).listings);
  record('T1', 'functional', 'public', 'Public listing feed responds', ok ? 'PASS' : 'FAIL',
    `status=${r.status}, listings=${r.json && r.json.listings ? r.json.listings.length : 'n/a'}`);
  return ok;
}

async function t2_signup() {
  const s = await post(BASE, '/api/signup', {
    username: SELLER.username, password: SELLER.password, accountType: 'seller',
    phone: SELLER.phone, storeName: 'Simulation Store ' + STAMP, storeLocation: 'Accra, Ghana', storeGpsAddress: '5.6037,-0.1870'
  });
  SELLER.token = s.json && s.json.token;
  const sellerOk = s.status === 201 && s.json && s.json.user && s.json.user.accountType === 'seller';
  record('T2a', 'functional', 'auth', 'Signup as SELLER (store name + location + phone)', sellerOk ? 'PASS' : 'FAIL',
    `status=${s.status}, accountType=${s.json && s.json.user ? s.json.user.accountType : 'n/a'}`);

  const b = await post(BASE, '/api/signup', {
    username: BUYER.username, password: BUYER.password, accountType: 'buyer',
    phone: BUYER.phone, name: 'Sim Buyer', location: 'Kumasi, Ghana', gpsAddress: '6.6885,-1.6244'
  });
  BUYER.token = b.json && b.json.token;
  const buyerOk = b.status === 201 && b.json && b.json.user && b.json.user.accountType === 'buyer';
  record('T2b', 'functional', 'auth', 'Signup as BUYER (name + location + phone)', buyerOk ? 'PASS' : 'FAIL',
    `status=${b.status}, accountType=${b.json && b.json.user ? b.json.user.accountType : 'n/a'}`);

  const dup = await post(BASE, '/api/signup', { username: SELLER.username, password: SELLER.password, accountType: 'seller', phone: SELLER.phone, storeName: 'x', storeLocation: 'y' });
  record('T2c', 'functional', 'auth', 'Duplicate username rejected', dup.status === 400 ? 'PASS' : 'FAIL', `status=${dup.status}`);

  const badPhone = await post(BASE, '/api/signup', { username: 'sim_bad_' + STAMP, password: 'SimPass123!', accountType: 'buyer', phone: '123', name: 'x', location: 'y' });
  record('T2d', 'functional', 'auth', 'Invalid phone format rejected at signup', badPhone.status === 400 ? 'PASS' : 'FAIL', `status=${badPhone.status}`);

  return sellerOk && buyerOk;
}

async function t3_login_token() {
  const l = await post(BASE, '/api/login', { username: SELLER.username, password: SELLER.password, accountType: 'seller' });
  const me = await get(BASE, '/api/me', l.json && l.json.token);
  const ok = l.status === 200 && me.status === 200 && me.json.user.accountType === 'seller';
  record('T3a', 'functional', 'auth', 'Seller login + GET /api/me', ok ? 'PASS' : 'FAIL',
    `login=${l.status}, me=${me.status}, role=${me.json && me.json.user && me.json.user.accountType}`);

  const wrongTab = await post(BASE, '/api/login', { username: SELLER.username, password: SELLER.password, accountType: 'buyer' });
  record('T3b', 'functional', 'auth', 'Role/tab mismatch is reported', wrongTab.status === 400 && wrongTab.json && wrongTab.json.suggestedType === 'seller' ? 'PASS' : 'FAIL',
    `status=${wrongTab.status}, suggestedType=${wrongTab.json && wrongTab.json.suggestedType}`);

  const bad = await post(BASE, '/api/login', { username: SELLER.username, password: 'wrong-password-123', accountType: 'seller' });
  record('T3c', 'functional', 'auth', 'Wrong password rejected', bad.status === 400 ? 'PASS' : 'FAIL', `status=${bad.status}`);

  return ok;
}

async function t4_otp() {
  const send = await post(BASE, '/api/send-otp', { phone: SELLER.phone }, SELLER.token);
  const devCode = send.json && send.json.devCode;
  if (send.status !== 200) {
    record('T4a', 'functional', 'otp', 'OTP dispatch', 'FAIL', `status=${send.status}, error=${send.json && send.json.error}`);
    return false;
  }
  if (!devCode) {
    record('T4a', 'functional', 'otp', 'OTP dispatch', 'WARN',
      'status=200 but no devCode returned — real SMS is configured, so the code must be entered manually. Verification skipped.');
    return null;
  }
  const verify = await post(BASE, '/api/verify-otp', { phone: SELLER.phone, code: devCode }, SELLER.token);
  const me = await get(BASE, '/api/me', SELLER.token);
  const ok = verify.status === 200 && me.json.user.phoneVerified === true;
  record('T4a', 'functional', 'otp', 'OTP verify marks phone verified', ok ? 'PASS' : 'FAIL',
    `verify=${verify.status}, phoneVerified=${me.json && me.json.user ? me.json.user.phoneVerified : 'n/a'}`);

  const wrong = await post(BASE, '/api/verify-otp', { phone: SELLER.phone, code: '000000' }, SELLER.token);
  record('T4b', 'functional', 'otp', 'Wrong OTP rejected', wrong.status === 400 ? 'PASS' : 'FAIL', `status=${wrong.status}`);
  return ok;
}

async function t5_negative() {
  const anon = await post(BASE, '/api/listings', { title: 'x', category: 'Electronics', price: 10, condition: 'New' });
  record('T5a', 'functional', 'authz', 'Unauthenticated listing creation -> 401', anon.status === 401 ? 'PASS' : 'FAIL', `status=${anon.status}`);

  const buyerPost = await post(BASE, '/api/listings', { title: 'x', category: 'Electronics', price: 10, condition: 'New' }, BUYER.token);
  record('T5b', 'functional', 'authz', 'Buyer posting a listing -> 403', buyerPost.status === 403 ? 'PASS' : 'FAIL', `status=${buyerPost.status}`);

  const sellerBuy = await post(BASE, '/api/checkout', { items: [{ id: 1, qty: 1 }] }, SELLER.token);
  record('T5c', 'functional', 'authz', 'Seller placing a buyer order -> 403', sellerBuy.status === 403 ? 'PASS' : 'FAIL', `status=${sellerBuy.status}`);

  const oversell = await post(BASE, '/api/checkout', { items: [{ id: 1, qty: 999999 }] }, BUYER.token);
  const oversellOk = oversell.status === 400 || oversell.status === 402;
  record('T5d', 'functional', 'checkout', 'Absurd quantity cannot oversell', oversellOk ? 'PASS' : 'FAIL',
    `status=${oversell.status}, error=${oversell.json && oversell.json.error}`);

  const badOrder = await put(BASE, '/api/orders/ORD-does-not-exist/status', { status: 'Delivered' }, SELLER.token);
  record('T5e', 'functional', 'orders', 'Unknown order id rejected', badOrder.status === 404 ? 'PASS' : 'FAIL', `status=${badOrder.status}`);
}

// The wallet top-up route was removed when C1 was fixed. This stays as a regression
// guard: the route must not come back, because it credits a wallet from unverified
// client input.
async function t6_removed_topup() {
  const r = await post(BASE, '/api/wallet/topup',
    { amount: 500, telecelTransactionId: 'SIMFORGED' + STAMP, senderPhone: SELLER.phone }, SELLER.token);
  const gone = r.status === 404 || r.status === 405 || r.status === 501;
  record('T6', 'security', 'money', 'Removed wallet-topup route must stay gone (was C1)', gone ? 'PASS' : 'FAIL',
    `status=${r.status}${gone ? '' : ' — the endpoint answered, so it may exist again'}`);
  return gone;
}

// REGRESSION PROBE for the open critical item: an order must not become "held" or
// "paid" (nor be releasable) without a payment that the server has verified.
// Expected to FAIL until the escrow model is implemented — that FAIL is the finding.
async function t6b_free_escrow(listingId) {
  if (!listingId) {
    record('T6b', 'security', 'money', 'Free-escrow probe skipped', 'WARN', 'No listing id available from the listing flow.');
    return;
  }
  const placed = await post(BASE, '/api/checkout', { items: [{ id: listingId, qty: 1 }] }, BUYER.token);
  const o = placed.json && placed.json.order;
  if (!o) {
    record('T6b', 'security', 'money', 'Free-escrow probe could not place an order', 'WARN',
      `status=${placed.status}, error=${placed.json && placed.json.error}`);
    return;
  }
  const stampedPaid = o.paymentConfirmed === true || !!o.paidAt;
  const released = await post(BASE, `/api/orders/${o.id}/confirm-delivery`, {}, BUYER.token);
  const rj = released.json && released.json.order;
  const fundsReleased = released.status === 200 && rj && rj.escrowStatus === 'Released';

  record('T6b', 'security', 'money',
    'Order must not be marked paid/released without a verified payment (C-1)',
    (stampedPaid || fundsReleased) ? 'FAIL' : 'PASS',
    `checkout stamped paymentConfirmed=${o.paymentConfirmed} paidAt=${!!o.paidAt}; ` +
    `confirm-delivery status=${released.status} escrow=${rj && rj.escrowStatus}`);
}

async function t7_fee_preview() {
  const r = await get(BASE, '/api/revenue/fee-preview?price=50&subtotal=100');
  const posting = r.json && r.json.postingFee;
  const service = r.json && r.json.serviceFee;
  // rates: postingBase 2.00 + 50*0.01 = 2.50 (cap 15) ; service 3.00 + 100*0.025 = 5.50
  const ok = r.status === 200 && Number(posting) === 2.5 && Number(service) === 5.5;
  record('T7', 'functional', 'fees', 'Fee preview matches documented formula', ok ? 'PASS' : 'FAIL',
    `postingFee=${posting} (expect 2.5), serviceFee=${service} (expect 5.5)`);
  return ok;
}

async function t8_listing_flow() {
  const created = await post(BASE, '/api/listings', {
    title: 'Simulation Test Item ' + STAMP, category: 'Electronics', price: 50, condition: 'New',
    description: 'Automated simulation listing.', stock: 3, sellerPhone: '0000000000'
  }, SELLER.token);

  if (created.status !== 201) {
    record('T8a', 'functional', 'listings', 'Seller can create a listing', 'FAIL', `status=${created.status}, error=${created.json && created.json.error}`);
    return { funded: false };
  }
  record('T8a', 'functional', 'listings', 'Seller can create a listing', 'PASS',
    `id=${created.json.listing.id}`);

  const listing = created.json.listing;
  const spoof = created.json.listing.sellerPhone;
  record('T8b', 'security', 'listings', 'Server ignores client-supplied sellerPhone on create', spoof !== '0000000000' ? 'PASS' : 'FAIL',
    `stored sellerPhone=${spoof}`);

  const edited = await put(BASE, '/api/listings/' + listing.id, { price: 120 }, SELLER.token);
  record('T8c', 'functional', 'listings', 'Seller can edit own listing', edited.status === 200 ? 'PASS' : 'FAIL',
    `status=${edited.status}`);

  const putPhone = await put(BASE, '/api/listings/' + listing.id, { sellerPhone: '0999999999' }, SELLER.token);
  const phoneAfter = putPhone.json && putPhone.json.listing ? putPhone.json.listing.sellerPhone : null;
  record('T8d', 'security', 'listings', 'Seller cannot overwrite sellerPhone with an unverified number on EDIT (finding H-item)',
    phoneAfter && phoneAfter.startsWith('0999') ? 'FAIL' : 'PASS',
    phoneAfter === null ? `status=${putPhone.status}` : `stored sellerPhone=${phoneAfter}${phoneAfter.startsWith('0999') ? ' (unverified override accepted)' : ''}`);

  const mine = await get(BASE, '/api/my-listings', SELLER.token);
  const listed = mine.json && Array.isArray(mine.json.listings) && mine.json.listings.some((l) => l.id === listing.id);
  record('T8e', 'functional', 'listings', 'Listing appears in /api/my-listings', listed ? 'PASS' : 'FAIL',
    `count=${mine.json && mine.json.listings ? mine.json.listings.length : 'n/a'}`);

  return { funded: true, listing };
}

async function t9_checkout(flow) {
  const before = await get(BASE, '/api/listings/' + flow.listing.id);
  const stockBefore = before.json && before.json.listing ? before.json.listing.stock : 0;
  const checkout = await post(BASE, '/api/checkout', { items: [{ id: flow.listing.id, qty: 2, color: '' }] }, BUYER.token);
  if (checkout.status !== 201) {
    record('T9a', 'functional', 'checkout', 'Buyer checkout', 'FAIL', `status=${checkout.status}, error=${checkout.json && checkout.json.error}`);
    return;
  }
  const order = checkout.json.order;
  record('T9a', 'functional', 'checkout', 'Buyer checkout creates an order without balance check', 'PASS',
    `orderId=${order.id}, subtotal=${order.subtotal}, siteFee=${order.siteFee}, total=${order.total}`);

  const after = await get(BASE, '/api/listings/' + flow.listing.id);
  const stockAfter = after.status === 200 ? after.json.listing.stock : 'deleted';
  record('T9b', 'functional', 'checkout', 'Stock is decremented by the purchased quantity',
    stockAfter === 'deleted' || Number(stockAfter) === Number(stockBefore) - 2 ? 'PASS' : 'FAIL',
    `stock ${stockBefore} -> ${stockAfter}`);

  const tracking = await get(BASE, '/api/my-orders', BUYER.token);
  const seen = tracking.json && Array.isArray(tracking.json.orders) && tracking.json.orders.some((o) => o.id === order.id);
  record('T9c', 'functional', 'orders', 'Buyer sees the order in /api/my-orders', seen ? 'PASS' : 'FAIL', `status=${tracking.status}`);

  const status = await put(BASE, '/api/orders/' + order.id + '/status', { status: 'Dispatched' }, SELLER.token);
  record('T9d', 'functional', 'orders', 'Seller can advance the order status', status.status === 200 ? 'PASS' : 'FAIL', `status=${status.status}`);

  const recheck = await get(BASE, '/api/my-orders', BUYER.token);
  const updated = recheck.json && recheck.json.orders.find((o) => o.id === order.id);
  record('T9e', 'functional', 'orders', 'Buyer sees the new status (tracking works)',
    updated && updated.status === 'Dispatched' ? 'PASS' : 'FAIL', `status=${updated && updated.status}`);
}

async function t10_security_phone_claim() {
  // Probe: can account B claim account A's identity/orders purely by writing A's phone number?
  const adminLogin = await post(ADMIN_BASE, '/api/login', {
    username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD
  });
  if (adminLogin.status !== 200 || !adminLogin.json) {
    record('T10', 'security', 'identity', 'Phone claim of another account\'s orders (C2)', 'INFO',
      'Skipped — admin login unavailable (set ADMIN_USERNAME/ADMIN_PASSWORD in .env).');
    return;
  }
  const relations = await get(ADMIN_BASE, '/api/relations', adminLogin.json.token);
  const users = (relations.json && relations.json.users) || [];
  const victim = users.find((u) => u.phone && u.phone !== 'N/A' && u.buyer && u.buyer.ordersCount > 0
    && u.username !== BUYER.username && u.username !== SELLER.username);
  if (!victim) {
    record('T10', 'security', 'identity', 'Phone claim of another account\'s orders (C2)', 'INFO',
      'Skipped — no other account with a phone number and existing orders was found.');
    return;
  }

  const claim = await put(BASE, '/api/user/profile', { phone: victim.phone }, BUYER.token);
  const claimed = await get(BASE, '/api/my-orders', BUYER.token);
  const victimOrders = new Set(
    ((relations.json.purchases || []).filter((p) => p.buyer === victim.username)).map((p) => p.orderId)
  );
  const leaked = ((claimed.json && claimed.json.orders) || []).filter((o) => victimOrders.has(o.id));

  const blocked = claim.status >= 400 || leaked.length === 0;
  record('T10', 'security', 'identity', 'Setting a phone number does not grant access to another account\'s orders (C2)',
    blocked ? 'PASS' : 'FAIL',
    blocked
      ? `profile update status=${claim.status}, no foreign orders returned`
      : `profile update status=${claim.status}; EXPOSED ${leaked.length} order(s) belonging to "${victim.username}" (${leaked.map((o) => o.id).join(', ')})`);
}

async function t11_admin() {
  const login = await post(ADMIN_BASE, '/api/login', { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  if (login.status !== 200) {
    record('T11a', 'functional', 'admin', 'Admin login', 'FAIL',
      `status=${login.status}, error=${login.json && login.json.error}`);
    return;
  }
  record('T11a', 'functional', 'admin', 'Admin login', 'PASS', `role=${login.json.admin && login.json.admin.role}`);

  const rel = await get(ADMIN_BASE, '/api/relations', login.json.token);
  const s = rel.json && rel.json.summary;
  record('T11b', 'functional', 'admin', 'Admin relations model loads', rel.status === 200 && !!s ? 'PASS' : 'FAIL',
    `orders=${s && s.totalOrders}, users=${s && s.totalUsers}, listings=${s && s.totalListings}`);

  const noAuth = await get(ADMIN_BASE, '/api/relations');
  record('T11c', 'functional', 'admin', 'Admin data requires authentication', noAuth.status === 401 ? 'PASS' : 'FAIL', `status=${noAuth.status}`);

  const fees = Number(s && s.postingFeesCollected || 0) + Number(s && s.serviceFeesCollected || 0);
  const revenue = Number(s && s.totalPlatformRevenue || 0);
  const inflated = revenue - fees > 0.01;
  record('T11d', 'security', 'money', 'Reported platform revenue equals fees actually collected (was C3)',
    inflated ? 'FAIL' : 'PASS',
    `totalPlatformRevenue=${revenue}, posting+service fees=${fees}${inflated ? ` (revenue exceeds collected fees by ${(revenue - fees).toFixed(2)})` : ''}`);
}

// ---------------------------------------------------------------------- main

(async () => {
  console.log('\nRichStore vital-process simulation');
  console.log(`  storefront: ${BASE}\n  admin:      ${ADMIN_BASE}\n  test ids:   ${SELLER.username} / ${BUYER.username}\n`);

  await requireServer();

  if (fs.existsSync(DB_PATH) && !fs.existsSync(BAK_PATH)) {
    fs.copyFileSync(DB_PATH, BAK_PATH);
    console.log(`Backed up db.json -> ${path.basename(BAK_PATH)}`);
  }

  try {
    const health = await t1_public();
    if (health) {
      const signed = await t2_signup();
      if (signed) {
        await t3_login_token();
        await t4_otp();
        await t5_negative();
        await t6_removed_topup();
        await t7_fee_preview();
        const flow = await t8_listing_flow();
        await t9_checkout(flow);
        await t6b_free_escrow(flow);
        await t10_security_phone_claim();
      } else {
        record('T3+', 'functional', 'auth', 'Downstream flows skipped', 'INFO', 'Signup failed, so later tests were not run.');
      }
    }
    await t11_admin();
  } catch (err) {
    fatal = true;
    record('EXC', 'functional', 'runner', 'Simulation crashed', 'FAIL', err && err.message);
  } finally {
    if (!KEEP && fs.existsSync(BAK_PATH)) {
      fs.copyFileSync(BAK_PATH, DB_PATH);
      fs.unlinkSync(BAK_PATH);
      console.log('\ndb.json restored from backup (test data discarded).');
    } else if (KEEP && fs.existsSync(BAK_PATH)) {
      console.log('\n--keep-data set: test data retained. Restore manually with: copy db.json.simbak db.json');
    }
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const warn = results.filter((r) => r.status === 'WARN').length;
  const info = results.filter((r) => r.status === 'INFO').length;

  console.log('\n================ SUMMARY ================');
  console.log(`PASS ${pass}   FAIL ${fail}   WARN ${warn}   INFO ${info}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  [${f.kind}] ${f.id} ${f.title}\n      ${f.detail}`);
  }
  console.log('\nLegend: [security] failures are vulnerabilities in the current code (see SITE_REVIEW_2026-09-11.md).');
  console.log('[functional] failures are broken behaviour. [INFO] = not runnable in this configuration.\n');

  process.exit(fail > 0 || fatal ? 1 : 0);
})();
