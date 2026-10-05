/**
 * relations.js — shared relational data model.
 * Single source of truth used by BOTH the storefront server (server.js) and the
 * admin server (admin-server.js), so the two dashboards can never drift apart.
 */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---------- admin id resolution (authorization labels only — never gates access) ----------
function getAdminIds(db) {
  const ids = new Set();
  const admins = Array.isArray(db.admins) ? db.admins : [];
  for (const a of admins) {
    const n = Number(a);
    if (Number.isInteger(n) && n > 0) {
      ids.add(n);
      continue;
    }
    const u = (db.users || []).find(
      (x) => x.username && String(x.username).toLowerCase() === String(a).toLowerCase()
    );
    if (u) ids.add(u.id);
  }
  return ids;
}

// ---------- Relational Data Model ----------
function buildAdminRelations(db) {
  const listings = Array.isArray(db.listings) ? db.listings : [];
  const orders = Array.isArray(db.orders) ? db.orders : [];
  const users = Array.isArray(db.users) ? db.users : [];
  const verifiedPhones = db.verifiedPhones || {};
  const adminIds = getAdminIds(db);

  const listingMap = new Map();
  for (const l of listings) {
    listingMap.set(Number(l.id), l);
  }

  // Order Lines & Purchases Relations + per-listing sales from ORDER SNAPSHOTS
  const orderItemsRelation = [];
  const purchasesRelation = [];

  let totalGrossMerchandiseValue = 0;
  let totalUnitsSold = 0;
  let escrowWithheldTotal = 0;
  let sellerPayoutsDisbursed = 0;
  let siteFeesCollected = 0;
  let refundsProcessed = 0;

  const sellerStatsMap = new Map();
  const buyerStatsMap = new Map();

  // Listing-based sales per seller (units sold & gross are filled from orders below)
  const listingSalesMap = new Map(); // listingId -> { unitsSold, gross }

  // Initialize seller stats from active listings
  for (const l of listings) {
    const seller = l.seller || 'Unknown';
    if (!sellerStatsMap.has(seller)) {
      sellerStatsMap.set(seller, {
        itemsListed: 0,
        activeStock: 0,
        unitsSold: 0,
        grossSales: 0,
        phone: l.sellerPhone || 'N/A'
      });
    }
    const s = sellerStatsMap.get(seller);
    s.itemsListed += 1;
    s.activeStock += (Number(l.stock) || 0);
    if (!s.phone || s.phone === 'N/A') s.phone = l.sellerPhone || 'N/A';
  }

  for (const ord of orders) {
    const buyer = ord.buyer || 'guest';
    const subtotal = ord.subtotal !== undefined ? Number(ord.subtotal) : (Number(ord.total) || 0);
    const finalTotal = Number(ord.total) || subtotal;

    totalGrossMerchandiseValue += subtotal;

    if (!buyerStatsMap.has(buyer)) {
      buyerStatsMap.set(buyer, {
        ordersCount: 0,
        unitsBought: 0,
        totalSpent: 0
      });
    }
    const b = buyerStatsMap.get(buyer);
    b.ordersCount += 1;
    b.totalSpent += finalTotal;

    const sellersInOrder = new Set();
    let orderUnitCount = 0;

    const items = Array.isArray(ord.items) ? ord.items : [];
    items.forEach((item, idx) => {
      const listing = listingMap.get(Number(item.id));
      const seller = item.seller || (listing ? listing.seller : 'KumodjiSenyo');
      // An unknown seller phone is reported as unknown — never as the platform's own
      // settlement number, which is not the seller's contact line.
      const sellerPhone = item.sellerPhone || (listing ? listing.sellerPhone : '');
      const unitPrice = Number(item.price) || 0;
      const qty = Number(item.qty) || 1;
      const lineSubtotal = round2(unitPrice * qty);

      orderUnitCount += qty;
      totalUnitsSold += qty;
      sellersInOrder.add(seller);

      // Snapshot-based per-listing sales (price at the time of purchase)
      const ls = listingSalesMap.get(Number(item.id)) || { unitsSold: 0, gross: 0 };
      ls.unitsSold += qty;
      ls.gross = round2(ls.gross + lineSubtotal);
      listingSalesMap.set(Number(item.id), ls);

      if (!sellerStatsMap.has(seller)) {
        sellerStatsMap.set(seller, {
          itemsListed: 0,
          activeStock: 0,
          unitsSold: 0,
          grossSales: 0,
          phone: sellerPhone
        });
      }
      const s = sellerStatsMap.get(seller);
      s.unitsSold += qty;
      s.grossSales = round2(s.grossSales + lineSubtotal);
      b.unitsBought += qty;

      orderItemsRelation.push({
        lineId: `${ord.id}-L${idx + 1}`,
        orderId: ord.id,
        listingId: item.id,
        title: item.title,
        unitPrice,
        qty,
        lineSubtotal,
        seller,
        sellerPhone,
        buyer,
        placedAt: ord.placedAt
      });
    });

    const escrowStatus = ord.escrowStatus || (
      ord.status === 'Cancelled' ? 'Refunded' :
      ['Completed', 'Released'].includes(ord.status) ? 'Released' :
      ['PendingPayment', 'pending'].includes(ord.status) ? 'PendingPayment' :
      'Held'
    );
    const orderSiteFee = Number(ord.siteFee) || Math.max(0, Math.round((finalTotal - subtotal) * 100) / 100);

    // Site charges apply only when payment from buyer has been confirmed received (Held / Released)
    if (escrowStatus === 'Held') {
      escrowWithheldTotal += finalTotal;
    } else if (escrowStatus === 'Released') {
      sellerPayoutsDisbursed += subtotal;
      siteFeesCollected += orderSiteFee;
    } else if (escrowStatus === 'Refunded') {
      refundsProcessed += finalTotal;
    }

    purchasesRelation.push({
      orderId: ord.id,
      placedAt: ord.placedAt,
      buyer,
      itemCount: items.length,
      totalUnits: orderUnitCount,
      subtotalPricing: round2(subtotal),
      siteFee: round2(orderSiteFee),
      finalTotal: round2(finalTotal),
      escrowStatus,
      sellersInvolved: Array.from(sellersInOrder)
    });
  }

  // Users Relation (Sellers & Buyers)
  const usersRelation = [];
  const processedUsernames = new Set();

  for (const u of users) {
    const uname = u.username;
    processedUsernames.add(String(uname).toLowerCase());
    const isVerified = !!verifiedPhones[String(u.id)];
    const verifiedData = verifiedPhones[String(u.id)] || {};
    const isAdmin = adminIds.has(Number(u.id));

    const sStats = sellerStatsMap.get(uname) || { itemsListed: 0, activeStock: 0, unitsSold: 0, grossSales: 0, phone: verifiedData.phone || 'N/A' };
    const bStats = buyerStatsMap.get(uname) || { ordersCount: 0, unitsBought: 0, totalSpent: 0 };

    let role = 'Member';
    if (isAdmin) role = 'Platform Admin';
    else if (u.accountType === 'buyer') role = isVerified ? 'Verified Buyer' : 'Buyer (Unverified)';
    else if (sStats.itemsListed > 0 && isVerified) role = 'Verified Seller';
    else if (sStats.itemsListed > 0) role = 'Seller (Unverified)';
    else if (isVerified) role = 'Verified Seller';
    else role = 'Seller (Unverified)';

    usersRelation.push({
      userId: u.id,
      username: uname,
      role,
      isAdmin,
      isVerified,
      phone: verifiedData.phone || sStats.phone || 'N/A',
      seller: {
        itemsListed: sStats.itemsListed,
        activeStock: sStats.activeStock,
        unitsSold: sStats.unitsSold,
        grossSales: round2(sStats.grossSales)
      },
      buyer: {
        ordersCount: bStats.ordersCount,
        unitsBought: bStats.unitsBought,
        totalSpent: round2(bStats.totalSpent)
      }
    });
  }

  // Include guest/unknown shoppers in users relation
  for (const [buyerName, bStats] of buyerStatsMap.entries()) {
    if (!processedUsernames.has(String(buyerName).toLowerCase())) {
      usersRelation.push({
        userId: 'EXT-' + buyerName,
        username: buyerName,
        role: buyerName === 'guest' ? 'Guest Shopper' : 'Shopper',
        isAdmin: false,
        isVerified: false,
        phone: 'N/A',
        seller: { itemsListed: 0, activeStock: 0, unitsSold: 0, grossSales: 0 },
        buyer: {
          ordersCount: bStats.ordersCount,
          unitsBought: bStats.unitsBought,
          totalSpent: round2(bStats.totalSpent)
        }
      });
    }
  }

  // Listings Relation (sales from order snapshots)
  const listingsRelation = listings.map((l) => {
    const sold = listingSalesMap.get(Number(l.id)) || { unitsSold: 0, gross: 0 };
    return {
      listingId: l.id,
      title: l.title,
      category: l.category || 'General',
      price: Number(l.price) || 0,
      stock: Number(l.stock) || 0,
      condition: l.condition || 'Pre-owned',
      seller: l.seller || 'Unknown',
      sellerPhone: l.sellerPhone || 'N/A',
      unitsSold: sold.unitsSold,
      grossSalesGenerated: sold.gross
    };
  });

  // Summary KPIs
  const summaryMetrics = {
    grossMerchandiseValue: round2(totalGrossMerchandiseValue),
    totalOrders: orders.length,
    totalUnitsSold,
    totalListings: listings.length,
    totalUsers: users.length,
    escrow: {
      withheldTotal: round2(escrowWithheldTotal),
      sellerPayoutsDisbursed: round2(sellerPayoutsDisbursed),
      siteFeesCollected: round2(siteFeesCollected),
      refundsProcessed: round2(refundsProcessed)
    }
  };

  return {
    summary: summaryMetrics,
    purchases: purchasesRelation.reverse(),
    orderItems: orderItemsRelation.reverse(),
    users: usersRelation,
    listings: listingsRelation
  };
}

module.exports = {
  round2,
  buildAdminRelations
};
