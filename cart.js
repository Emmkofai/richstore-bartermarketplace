// Synchronously set data-account-type on html tag to avoid any flash of seller-only controls for buyers
(function syncAccountTypeAttr() {
  try {
    const raw = localStorage.getItem('auth_user');
    if (raw) {
      const u = JSON.parse(raw);
      if (u && u.accountType) {
        document.documentElement.setAttribute('data-account-type', u.accountType);
      }
    }
  } catch (e) {}
})();

// ---- HTML escape helper (XSS protection) ----
function escapeHTML(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

// ---- Shared display formatters (loaded on every page) ----
// Always renders "GHs " + a 2-decimal number with thousands separators.
window.formatGHs = function formatGHs(n) {
  const num = Number(n || 0);
  const safe = Number.isFinite(num) ? num : 0;
  return 'GHs ' + safe.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// One consistent date format across the site (e.g. "01 Oct 2026").
window.formatDate = function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// ---- API helper ----
const api = {
  async get(path) {
    try {
      const headers = {};
      const token = localStorage.getItem('auth_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const r = await fetch(path, { headers });
      const data = await r.json();
      return { ok: r.ok, data };
    } catch (err) {
      return { ok: false, data: { error: 'Network error. Please try again.' } };
    }
  },
  async post(path, body) {
    try {
      const headers = { "Content-Type": "application/json" };
      const token = localStorage.getItem('auth_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const r = await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return { ok: r.ok, data };
    } catch (err) {
      return { ok: false, data: { error: 'Network error. Please try again.' } };
    }
  },
  async uploadImage(file) {
    try {
      const headers = {};
      const token = localStorage.getItem('auth_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const formData = new FormData();
      formData.append('image', file);
      const r = await fetch('/api/upload-image', {
        method: 'POST',
        headers,
        body: formData,
      });
      const data = await r.json();
      return { ok: r.ok, data };
    } catch (err) {
      return { ok: false, data: { error: 'Upload failed. Please try again.' } };
    }
  },
};

// ---- Color mapping & name helper ----
const COLOR_NAMES = {
  '#D64550': 'Crimson Red',
  '#EF4444': 'Red',
  '#DC2626': 'Ruby Red',
  '#2563EB': 'Royal Blue',
  '#1E3A8A': 'Navy Blue',
  '#0000CD': 'Medium Blue',
  '#2F6F63': 'Forest Green',
  '#10B981': 'Emerald Green',
  '#0D9488': 'Teal',
  '#1E2B23': 'Deep Slate',
  '#1E293B': 'Midnight Black',
  '#000000': 'Black',
  '#FFFFFF': 'White',
  '#64748B': 'Slate Gray',
  '#94A3B8': 'Silver Gray',
  '#C9A227': 'Gold',
  '#F59E0B': 'Amber',
  '#F97316': 'Bright Orange',
  '#7C3AED': 'Purple',
  '#EC4899': 'Pink',
  '#78350F': 'Brown',
  '#A16207': 'Bronze'
};

function getColorName(hex) {
  if (!hex || typeof hex !== 'string') return '';
  const clean = hex.trim().toUpperCase();
  if (COLOR_NAMES[clean]) return COLOR_NAMES[clean];
  for (const [code, name] of Object.entries(COLOR_NAMES)) {
    if (code.toUpperCase() === clean) return name;
  }
  return clean;
}

// ---- Cart stored client-side in localStorage: { [cartKey]: { id, qty, color } } ----
const Cart = {
  KEY: "barter_cart",
  read() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.KEY)) || {};
      const normalized = {};
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val === 'number') {
          // Legacy format: { [id]: qty }
          normalized[String(key)] = {
            id: parseInt(key, 10),
            qty: Math.max(1, parseInt(val, 10) || 1),
            color: ''
          };
        } else if (val && typeof val === 'object') {
          // New format: { [key]: { id, qty, color } }
          const listingId = parseInt(val.id || key.split('__')[0], 10);
          if (!isNaN(listingId)) {
            normalized[key] = {
              id: listingId,
              qty: Math.max(1, parseInt(val.qty, 10) || 1),
              color: val.color || ''
            };
          }
        }
      }
      return normalized;
    } catch {
      return {};
    }
  },
  write(cart) {
    localStorage.setItem(this.KEY, JSON.stringify(cart));
    Cart.updateBadge();
  },
  add(id, qty = 1) {
    try {
      const u = JSON.parse(localStorage.getItem('auth_user') || 'null');
      if (u && u.accountType === 'seller') {
        showToast('Seller accounts cannot buy or add items to cart.');
        return false;
      }
    } catch (e) {}
    const cart = Cart.read();
    const count = parseInt(qty, 10) || 1;
    const key = String(id);
    if (cart[key]) {
      cart[key].qty = (parseInt(cart[key].qty, 10) || 0) + count;
    } else {
      cart[key] = {
        id: parseInt(id, 10),
        qty: count
      };
    }
    Cart.write(cart);
    return true;
  },
  getItemQty(id) {
    const cart = Cart.read();
    const targetId = parseInt(id, 10);
    return Object.values(cart)
      .filter(it => parseInt(it.id, 10) === targetId)
      .reduce((sum, it) => sum + (parseInt(it.qty, 10) || 0), 0);
  },
  setQty(key, qty) {
    const cart = Cart.read();
    const count = parseInt(qty, 10);
    if (isNaN(count) || count <= 0) {
      delete cart[key];
    } else if (cart[key]) {
      cart[key].qty = count;
    }
    Cart.write(cart);
  },
  remove(key) {
    const cart = Cart.read();
    delete cart[key];
    Cart.write(cart);
  },
  clear() {
    localStorage.removeItem(this.KEY);
    Cart.updateBadge();
  },
  count() {
    const cart = Cart.read();
    return Object.values(cart).reduce((sum, it) => sum + (parseInt(it.qty, 10) || 0), 0);
  },
  updateBadge() {
    document.querySelectorAll(".cart-count").forEach(badge => {
      badge.textContent = Cart.count();
      badge.classList.remove("bump");
      void badge.offsetWidth;
      badge.classList.add("bump");
    });
  },
};

function createUserAvatarSVG(size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="M12 12c2.4 0 4.4-2 4.4-4.4S14.4 3.2 12 3.2 7.6 5.2 7.6 7.6 9.6 12 12 12zm0 2.4c-2.9 0-8.8 1.5-8.8 4.4v2h17.6v-2c0-2.9-5.9-4.4-8.8-4.4z"/></svg>`;
}

function updateAuthUI() {
  let token = localStorage.getItem('auth_token');
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('auth_user') || 'null');
  } catch {
    user = null;
  }

  const isSignedIn = !!(token && user);

  if (user && user.accountType) {
    document.documentElement.setAttribute('data-account-type', user.accountType);
  } else {
    document.documentElement.removeAttribute('data-account-type');
  }

  document.querySelectorAll('.buyer-wallet-badge, #buyer-wallet-badge').forEach(badge => {
    badge.style.display = isSignedIn ? '' : 'none';
  });

  document.querySelectorAll('.nav-actions').forEach(nav => {
    nav.querySelectorAll('.auth-link, .auth-user, .manage-link, .admin-nav-link, .user-nav-wrapper').forEach(el => el.remove());

    if (token && user) {
      const isSeller = user.accountType !== 'buyer';

      // Ensure wallet badge exists in nav-actions when signed in
      let walletBadge = nav.querySelector('.buyer-wallet-badge');
      if (!walletBadge) {
        walletBadge = document.createElement('a');
        walletBadge.className = 'buyer-wallet-badge';
        walletBadge.id = 'buyer-wallet-badge';
        walletBadge.href = isSeller ? '/manage-orders.html' : '/buyer-orders.html';
        walletBadge.setAttribute('aria-label', 'Account wallet');
        walletBadge.setAttribute('title', 'Amount paid securely held in account');
        walletBadge.innerHTML = `
          <span class="wallet-badge-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="20" height="15" rx="3"></rect>
              <path d="M16 12h4"></path>
              <circle cx="18" cy="12" r="1" fill="currentColor"></circle>
            </svg>
          </span>
          <span class="wallet-badge-label">Account:</span>
          <span class="wallet-badge-amount" id="buyer-wallet-amount">GHs 0.00</span>
        `;
        nav.insertBefore(walletBadge, nav.firstChild);
      }
      walletBadge.style.display = '';

      // Ensure sell item button visibility matches account type: strictly hidden for buyers
      nav.querySelectorAll(':scope > a[href*="sell.html"], :scope > .btn-sell').forEach(el => {
        el.style.display = isSeller ? '' : 'none';
        if (isSeller) el.classList.add('btn-sell');
      });

      // Sellers are not allowed to buy or add items to cart: hide cart link from nav
      nav.querySelectorAll('.cart-link').forEach(el => {
        el.style.display = isSeller ? 'none' : '';
      });

      if (isSeller) {
        const manageLink = document.createElement('a');
        manageLink.className = 'manage-link';
        manageLink.href = '/manage.html';
        manageLink.textContent = 'Manage listings';
        nav.appendChild(manageLink);
      }

      // User avatar icon and name at the far right corner of the nav
      const userWrapper = document.createElement('div');
      userWrapper.className = 'user-nav-wrapper';

      const userBadge = document.createElement('button');
      userBadge.type = 'button';
      userBadge.className = 'user-nav-badge';
      userBadge.setAttribute('aria-expanded', 'false');
      userBadge.setAttribute('aria-haspopup', 'true');
      userBadge.setAttribute('aria-label', 'Account menu for ' + (user.username || 'User'));
      userBadge.innerHTML = `
        <span class="user-avatar-circle">${createUserAvatarSVG(14)}</span>
        <span class="user-nav-name">${escapeHTML(user.username || 'User')}</span>
        <span class="user-nav-arrow">▾</span>
      `;

      let roleHtml = '';
      if (user.isAdmin) {
        roleHtml = `<span style="color:#0000CD;font-weight:700;">Administrator</span>`;
      } else if (isSeller) {
        if (user.phoneVerified) {
          roleHtml = `<span style="color:#059669;font-weight:700;display:inline-flex;align-items:center;gap:4px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            Verified Seller
          </span>`;
        } else {
          roleHtml = `<span style="color:var(--ink-lighter);font-weight:600;">Seller <span style="font-size:12.3px;color:#d97706;font-weight:600;">(Unverified Phone)</span></span>`;
        }
      } else {
        if (user.phoneVerified) {
          roleHtml = `<span style="color:#059669;font-weight:700;display:inline-flex;align-items:center;gap:4px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            Verified Member
          </span>`;
        } else {
          roleHtml = `<span style="color:var(--ink-lighter);font-weight:600;">Member <span style="font-size:12.3px;color:#d97706;font-weight:600;">(Unverified Phone)</span></span>`;
        }
      }

      // Conditional menu items
      let menuLinks = '';
      if (isSeller) {
        menuLinks = `
          <a href="/manage.html">Manage listings</a>
          <a href="/manage-orders.html">Manage orders</a>
          <a href="/sell.html">Sell an Item</a>
          <a href="/profile.html">User Profile</a>
        `;
      } else {
        menuLinks = `
          <a href="/buyer-orders.html">Manage/Track orders</a>
          <a href="/cart.html">Cart</a>
          <a href="/profile.html">User Profile</a>
        `;
      }

      const dropdown = document.createElement('div');
      dropdown.className = 'user-dropdown-menu';
      dropdown.innerHTML = `
        <div class="user-dropdown-header">
          <div class="dropdown-user-name">${escapeHTML(user.username || 'User')}</div>
          <div class="dropdown-user-role">${roleHtml}</div>
        </div>
        ${menuLinks}
        ${user.isAdmin ? `<a href="/admin.html" style="color:var(--search);font-weight:600;">Admin Console</a>` : ''}
        <div class="user-dropdown-divider"></div>
        <button type="button" class="dropdown-logout-btn">Logout</button>
      `;

      userBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('show');
        document.querySelectorAll('.user-dropdown-menu.show').forEach(d => d.classList.remove('show'));
        document.querySelectorAll('.user-nav-badge[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        if (!isOpen) {
          dropdown.classList.add('show');
          userBadge.setAttribute('aria-expanded', 'true');
        }
      });

      dropdown.querySelector('.dropdown-logout-btn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const headers = {};
        const t = localStorage.getItem('auth_token');
        if (t) headers['Authorization'] = 'Bearer ' + t;
        try { await fetch('/api/logout', { method: 'POST', headers }); } catch (err) {}
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        updateAuthUI();
        location.href = '/';
      });

      userWrapper.appendChild(userBadge);
      userWrapper.appendChild(dropdown);
      nav.appendChild(userWrapper);
    } else {
      // Guest: Hide wallet badge
      nav.querySelectorAll('.buyer-wallet-badge').forEach(el => {
        el.style.display = 'none';
      });

      nav.querySelectorAll(':scope > a[href*="sell.html"], :scope > .btn-sell').forEach(el => {
        el.style.display = '';
        el.classList.add('btn-sell');
      });

      nav.querySelectorAll('.cart-link').forEach(el => {
        el.style.display = '';
      });

      // Guest: User icon and "Sign In" at the far right corner
      const guestWrapper = document.createElement('div');
      guestWrapper.className = 'user-nav-wrapper';

      const loginLink = document.createElement('a');
      loginLink.className = 'user-nav-badge guest';
      loginLink.href = '/login.html';
      loginLink.setAttribute('aria-label', 'Sign In');
      loginLink.innerHTML = `
        <span class="user-avatar-circle">${createUserAvatarSVG(14)}</span>
        <span class="user-nav-name">Sign In</span>
      `;
      guestWrapper.appendChild(loginLink);
      nav.appendChild(guestWrapper);
    }
  });

  if (token) {
    fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.user) {
          const prevKey = `${user?.isAdmin}-${user?.phoneVerified}-${user?.accountType}`;
          const currKey = `${data.user.isAdmin}-${data.user.phoneVerified}-${data.user.accountType}`;
          localStorage.setItem('auth_user', JSON.stringify(data.user));
          if (prevKey !== currKey) {
            updateAuthUI();
          }
        }
      })
      .catch(() => {});

    // For sellers: fetch new orders alerting the seller of customer orders for their postings
    if (user && user.accountType !== 'buyer') {
      checkSellerOrderAlerts(token);
    }

    // Dynamic escrow wallet calculation for buyer / seller
    checkBuyerEscrowPaid(token, user);
  } else {
    updateBuyerWalletBadge(0, 'buyer');
  }
}

// Global buyer escrow wallet state and helpers
window.__buyerWalletPaidAmount = 0;

function updateBuyerWalletBadge(amount = 0, role = 'buyer') {
  const token = localStorage.getItem('auth_token');
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('auth_user') || 'null');
  } catch {}

  const num = Math.max(0, Number(amount) || 0);
  window.__buyerWalletPaidAmount = num;
  const formatted = window.formatGHs(num);
  const badges = document.querySelectorAll('.buyer-wallet-badge, #buyer-wallet-badge');

  badges.forEach(badge => {
    // Hide wallet badge when user has not signed in
    if (!token || !user) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';

    const amountEl = badge.querySelector('.wallet-badge-amount');
    const labelEl = badge.querySelector('.wallet-badge-label');
    if (amountEl) {
      amountEl.textContent = formatted;
    }
    if (labelEl) {
      labelEl.textContent = 'Account:';
    }
    if (role === 'seller') {
      badge.setAttribute('title', `${formatted} in seller account balance`);
      badge.setAttribute('aria-label', `Account balance ${formatted}`);
      badge.setAttribute('href', '/manage-orders.html');
    } else {
      badge.setAttribute('title', `${formatted} in buyer account balance`);
      badge.setAttribute('aria-label', `Account balance ${formatted}`);
      badge.setAttribute('href', '/buyer-orders.html');
    }
  });

  // Also update drawer wallet badge if present
  const drawerAmount = document.getElementById('drawer-wallet-amount');
  if (drawerAmount) {
    drawerAmount.textContent = formatted;
  }
}

async function checkBuyerEscrowPaid(token, user) {
  if (!token || !user) {
    updateBuyerWalletBadge(0, 'buyer');
    return 0;
  }
  const isSeller = user.accountType === 'seller';
  try {
    const endpoint = isSeller ? '/api/orders' : '/api/my-orders';
    const res = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) {
      updateBuyerWalletBadge(0, isSeller ? 'seller' : 'buyer');
      return 0;
    }
    const data = await res.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];

    // Orders currently held in escrow (payment confirmed / held, not released/refunded/cancelled)
    const heldOrders = orders.filter(o => {
      const es = String(o.escrowStatus || '').toLowerCase();
      const s = String(o.status || '').toLowerCase();
      if (es === 'released' || es === 'refunded' || s === 'cancelled' || s === 'completed') {
        return false;
      }
      return es === 'held' || o.paymentConfirmed || ['processing', 'dispatched', 'delivered'].includes(s);
    });

    const totalPaid = heldOrders.reduce((sum, o) => {
      const amt = isSeller ? (Number(o.buyerPaidTotal) || Number(o.total) || 0) : (Number(o.total) || 0);
      return sum + amt;
    }, 0);

    updateBuyerWalletBadge(totalPaid, isSeller ? 'seller' : 'buyer');
    return totalPaid;
  } catch (err) {
    updateBuyerWalletBadge(0, isSeller ? 'seller' : 'buyer');
    return 0;
  }
}

window.updateBuyerWalletBadge = updateBuyerWalletBadge;
window.checkBuyerEscrowPaid = checkBuyerEscrowPaid;

// Global seller order alert state and helpers
window.__sellerOrderAlertCount = 0;

async function checkSellerOrderAlerts(token) {
  if (!token) return 0;
  try {
    const res = await fetch('/api/orders', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const orders = Array.isArray(data.orders) ? data.orders : [];
    // Active / new orders awaiting seller fulfillment
    const newOrders = orders.filter(o => {
      const s = String(o.status || '').toLowerCase();
      return !s.includes('deliver') && !s.includes('cancel') && !s.includes('complet');
    });
    const alertCount = newOrders.length;
    updateSellerAlertBadges(alertCount);
    return alertCount;
  } catch (err) {
    return 0;
  }
}

function updateSellerAlertBadges(count) {
  window.__sellerOrderAlertCount = count;
  const displayVal = count > 99 ? '99+' : String(count);

  // 1. Navbar Profile Badge: Red alert notification badge with order count on avatar circle
  document.querySelectorAll('.user-nav-badge .user-avatar-circle').forEach(circle => {
    let badge = circle.querySelector('.nav-order-alert-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-order-alert-badge';
        circle.appendChild(badge);
      }
      badge.textContent = displayVal;
      badge.title = `${count} new order${count > 1 ? 's' : ''} received!`;
      badge.style.display = 'inline-flex';
    } else if (badge) {
      badge.remove();
    }
  });

  // 2. Dropdown Menu: Red alert badges for Manage Orders and Profile
  document.querySelectorAll('.user-dropdown-menu').forEach(menu => {
    const ordersLink = menu.querySelector('a[href*="manage-orders.html"]');
    if (ordersLink) {
      let badge = ordersLink.querySelector('.menu-order-alert-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'menu-order-alert-badge';
          ordersLink.appendChild(badge);
        }
        badge.textContent = `${displayVal} new`;
        badge.style.display = 'inline-flex';
      } else if (badge) {
        badge.remove();
      }
    }

    const profileLink = menu.querySelector('a[href*="profile.html"]');
    if (profileLink) {
      let badge = profileLink.querySelector('.menu-order-alert-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'menu-order-alert-badge';
          profileLink.appendChild(badge);
        }
        badge.textContent = displayVal;
        badge.style.display = 'inline-flex';
      } else if (badge) {
        badge.remove();
      }
    }

    let headerBanner = menu.querySelector('.dropdown-order-alert-banner');
    if (count > 0) {
      if (!headerBanner) {
        headerBanner = document.createElement('div');
        headerBanner.className = 'dropdown-order-alert-banner';
        const header = menu.querySelector('.user-dropdown-header');
        if (header) header.insertAdjacentElement('afterend', headerBanner);
      }
      headerBanner.innerHTML = `<span class="badge-dot-alert"></span> ${count} new order${count > 1 ? 's' : ''} received!`;
    } else if (headerBanner) {
      headerBanner.remove();
    }
  });

  // 3. Mobile Drawer Items
  document.querySelectorAll('.mobile-drawer').forEach(drawer => {
    const drawerAvatar = drawer.querySelector('.drawer-user-badge .user-avatar-circle');
    if (drawerAvatar) {
      let dBadge = drawerAvatar.querySelector('.nav-order-alert-badge');
      if (count > 0) {
        if (!dBadge) {
          dBadge = document.createElement('span');
          dBadge.className = 'nav-order-alert-badge';
          drawerAvatar.appendChild(dBadge);
        }
        dBadge.textContent = displayVal;
        dBadge.style.display = 'inline-flex';
      } else if (dBadge) {
        dBadge.remove();
      }
    }

    const ordersLink = drawer.querySelector('a[href*="manage-orders.html"]');
    if (ordersLink) {
      let badge = ordersLink.querySelector('.drawer-order-alert-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'drawer-order-alert-badge';
          ordersLink.appendChild(badge);
        }
        badge.textContent = `${displayVal} new`;
        badge.style.display = 'inline-flex';
      } else if (badge) {
        badge.remove();
      }
    }

    const profileLink = drawer.querySelector('a[href*="profile.html"]');
    if (profileLink) {
      let badge = profileLink.querySelector('.drawer-order-alert-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'drawer-order-alert-badge';
          profileLink.appendChild(badge);
        }
        badge.textContent = displayVal;
        badge.style.display = 'inline-flex';
      } else if (badge) {
        badge.remove();
      }
    }
  });

  // 4. Mobile Hamburger Button: indicator badge
  const hamburger = document.querySelector('.hamburger');
  if (hamburger) {
    let hBadge = hamburger.querySelector('.hamburger-order-alert-badge');
    if (count > 0) {
      if (!hBadge) {
        hBadge = document.createElement('span');
        hBadge.className = 'hamburger-order-alert-badge';
        hamburger.appendChild(hBadge);
      }
      hBadge.textContent = displayVal;
      hBadge.style.display = 'inline-flex';
    } else if (hBadge) {
      hBadge.remove();
    }
  }

  // 5. Hook for public/profile.html
  if (typeof window.renderProfileOrderAlerts === 'function') {
    window.renderProfileOrderAlerts(count);
  }
}

window.checkSellerOrderAlerts = checkSellerOrderAlerts;
window.updateSellerAlertBadges = updateSellerAlertBadges;

document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-nav-wrapper')) {
    document.querySelectorAll('.user-dropdown-menu.show').forEach(d => d.classList.remove('show'));
    document.querySelectorAll('.user-nav-badge[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
});

document.addEventListener("DOMContentLoaded", () => {
  Cart.updateBadge();
  updateAuthUI();
  setupHamburgerMenu();
  setupFloatingMissionBanner();
});

function setupFloatingMissionBanner() {
  // Only display on the main page (index.html or root '/')
  const path = window.location.pathname.toLowerCase();
  const isMainPage = path === '/' || path.endsWith('/index.html') || path === '' || path.endsWith('/');
  if (!isMainPage) return;

  const mainWrap = document.querySelector('main.wrap');
  if (!mainWrap) return;
  if (mainWrap.querySelector('.floating-mission-banner')) return;

  const banner = document.createElement('div');
  banner.className = 'floating-mission-banner';

  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('auth_user') || 'null');
  } catch {}

  const isSeller = user && user.accountType === 'seller';

  const buyerMessages = [
    { text: 'Our goal is to bring to your doorstep what you need, stress-free.' },
    { text: 'Our vision is to become a global marketplace where all your needs are defined with integrity and security.' }
  ];

  const sellerMessages = [
    { text: 'Our goal is to take you where you are needed with what you have.' },
    { text: 'Our vision is to bring our local market, small or big to the public.' }
  ];

  const messages = isSeller ? sellerMessages : buyerMessages;
  let currentIndex = 0;

  banner.innerHTML = `
    <div class="banner-track">
      <div class="banner-text"></div>
    </div>
  `;

  mainWrap.insertBefore(banner, mainWrap.firstChild);

  const textEl = banner.querySelector('.banner-text');

  function updateMessage() {
    const msg = messages[currentIndex];
    
    // 1. Exit active text smoothly to the right
    textEl.className = 'banner-text exiting';
    
    setTimeout(() => {
      // 2. Load next message
      textEl.textContent = msg.text;
      textEl.className = 'banner-text entering';
      
      // Force re-flow retrigger
      void textEl.offsetWidth;
      
      // 3. Float horizontally across to the right
      textEl.className = 'banner-text floating';

      // 4. Pause for easy readability
      setTimeout(() => {
        textEl.className = 'banner-text paused';
      }, 3500);

    }, 500);

    currentIndex = (currentIndex + 1) % messages.length;
  }

  // Initial display
  updateMessage();

  // Cycle every 7.5 seconds
  setInterval(updateMessage, 7500);
}

function setupHamburgerMenu() {
  const siteInner = document.querySelector('.site-inner');
  if (!siteInner) return;

  // Create hamburger button (appended on the right)
  const burger = document.createElement('button');
  burger.className = 'hamburger';
  burger.setAttribute('aria-label', 'Open menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.innerHTML = '<span></span><span></span><span></span>';
  siteInner.appendChild(burger);

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';
  document.body.appendChild(overlay);

  // Create drawer
  const drawer = document.createElement('nav');
  drawer.className = 'mobile-drawer';
  drawer.setAttribute('aria-label', 'Mobile navigation');
  document.body.appendChild(drawer);

  async function populateDrawer() {
    drawer.innerHTML = '';

    // Auth items in mobile drawer
    const token = localStorage.getItem('auth_token');
    let user = null;
    try { user = JSON.parse(localStorage.getItem('auth_user') || 'null'); } catch { user = null; }

    if (token && user) {
      const isSeller = user.accountType !== 'buyer';
      const userCard = document.createElement('div');
      userCard.className = 'drawer-user-badge';
      userCard.innerHTML = `
        <span class="user-avatar-circle">${createUserAvatarSVG(18)}</span>
        <span class="drawer-user-name">${escapeHTML(user.username || 'User')}</span>
      `;
      drawer.appendChild(userCard);

      // Escrow Wallet badge in mobile drawer
      const walletItem = document.createElement('a');
      walletItem.className = 'drawer-wallet-badge';
      walletItem.href = isSeller ? '/manage-orders.html' : '/buyer-orders.html';
      const formattedAmt = window.formatGHs(window.__buyerWalletPaidAmount);
      walletItem.innerHTML = `
        <span class="drawer-wallet-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="5" width="20" height="15" rx="3"></rect>
            <path d="M16 12h4"></path>
            <circle cx="16" cy="12.5" r="1" fill="currentColor"></circle>
          </svg>
        </span>
        <span class="drawer-wallet-text">
          <span class="drawer-wallet-label">Account Balance</span>
          <span class="drawer-wallet-amount" id="drawer-wallet-amount">${formattedAmt}</span>
        </span>
      `;
      drawer.appendChild(walletItem);

      if (isSeller) {
        if (window.__sellerOrderAlertCount > 0) {
          const circle = userCard.querySelector('.user-avatar-circle');
          if (circle) {
            const b = document.createElement('span');
            b.className = 'nav-order-alert-badge';
            b.textContent = window.__sellerOrderAlertCount > 99 ? '99+' : String(window.__sellerOrderAlertCount);
            circle.appendChild(b);
          }
        }

        const sellLink = document.createElement('a');
        sellLink.href = 'sell.html';
        sellLink.className = 'btn primary btn-sell';
        sellLink.textContent = 'Sell an item';
        drawer.appendChild(sellLink);

        const manageLink = document.createElement('a');
        manageLink.href = '/manage.html';
        manageLink.textContent = 'Manage listings';
        drawer.appendChild(manageLink);

        const ordersLink = document.createElement('a');
        ordersLink.href = '/manage-orders.html';
        if (window.__sellerOrderAlertCount > 0) {
          ordersLink.innerHTML = `<span>Manage orders</span><span class="drawer-order-alert-badge">${window.__sellerOrderAlertCount > 99 ? '99+' : window.__sellerOrderAlertCount} new</span>`;
        } else {
          ordersLink.textContent = 'Manage orders';
        }
        drawer.appendChild(ordersLink);

        const profileLink = document.createElement('a');
        profileLink.href = '/profile.html';
        if (window.__sellerOrderAlertCount > 0) {
          profileLink.innerHTML = `<span>User Profile</span><span class="drawer-order-alert-badge">${window.__sellerOrderAlertCount > 99 ? '99+' : window.__sellerOrderAlertCount}</span>`;
        } else {
          profileLink.textContent = 'User Profile';
        }
        drawer.appendChild(profileLink);
      } else {
        const ordersLink = document.createElement('a');
        ordersLink.href = '/buyer-orders.html';
        ordersLink.textContent = 'Manage/Track orders';
        drawer.appendChild(ordersLink);

        const cartLink = document.createElement('a');
        cartLink.href = '/cart.html';
        cartLink.textContent = 'Cart';
        drawer.appendChild(cartLink);

        const profileLink = document.createElement('a');
        profileLink.href = '/profile.html';
        profileLink.textContent = 'User Profile';
        drawer.appendChild(profileLink);
      }

      if (user.isAdmin) {
        const adminLink = document.createElement('a');
        adminLink.href = '/admin.html';
        adminLink.textContent = 'Admin Console';
        adminLink.style.color = 'var(--search)';
        adminLink.style.fontWeight = '700';
        drawer.appendChild(adminLink);
      }

      const logoutLink = document.createElement('a');
      logoutLink.href = '#';
      logoutLink.textContent = 'Logout';
      logoutLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const headers = {};
        const t = localStorage.getItem('auth_token');
        if (t) headers['Authorization'] = 'Bearer ' + t;
        try { await fetch('/api/logout', { method: 'POST', headers }); } catch {}
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        closeDrawer();
        updateAuthUI();
        location.href = '/';
      });
      drawer.appendChild(logoutLink);
    } else {
      const loginLink = document.createElement('a');
      loginLink.className = 'drawer-user-badge';
      loginLink.href = '/login.html';
      loginLink.innerHTML = `
        <span class="user-avatar-circle">${createUserAvatarSVG(18)}</span>
        <span class="drawer-user-name">Sign In / Register</span>
      `;
      drawer.appendChild(loginLink);

      const sellLink = document.createElement('a');
      sellLink.href = 'sell.html';
      sellLink.className = 'btn primary btn-sell';
      sellLink.textContent = 'Sell an item';
      drawer.appendChild(sellLink);

      const cartLink = document.createElement('a');
      cartLink.href = '/cart.html';
      cartLink.textContent = 'Cart';
      drawer.appendChild(cartLink);
    }

    // Categories section
    const catSection = document.createElement('div');
    catSection.className = 'drawer-section';
    const catTitle = document.createElement('div');
    catTitle.className = 'drawer-section-title';
    catTitle.textContent = 'Categories';
    catSection.appendChild(catTitle);

    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'drawer-chips';

    let categories = ["All", "Electronics", "Fashion", "Home", "Collectibles", "Sports", "Books"];
    try {
      const r = await api.get('/api/categories');
      if (r.ok && r.data && Array.isArray(r.data.categories)) {
        categories = ["All", ...r.data.categories];
      }
    } catch {}

    const currentCatParam = new URLSearchParams(location.search).get('cat') || 'All';

    categories.forEach(cat => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chips drawer-chip' + (cat === currentCatParam ? ' active' : '');
      chip.textContent = cat;
      chip.setAttribute('data-cat', cat);
      chip.addEventListener('click', (e) => {
        if (typeof window.selectCategoryMobile === 'function') {
          e.preventDefault();
          window.selectCategoryMobile(cat);
          // update active state on drawer chips
          chipsWrap.querySelectorAll('.drawer-chip, .chips').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          closeDrawer();
        } else {
          location.href = '/index.html?cat=' + encodeURIComponent(cat);
          closeDrawer();
        }
      });
      chipsWrap.appendChild(chip);
    });

    catSection.appendChild(chipsWrap);
    drawer.appendChild(catSection);
  }

  function openDrawer() {
    populateDrawer();
    burger.classList.add('active');
    burger.setAttribute('aria-expanded', 'true');
    drawer.classList.add('open');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    burger.classList.remove('active');
    burger.setAttribute('aria-expanded', 'false');
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  burger.addEventListener('click', () => {
    const isOpen = drawer.classList.contains('open');
    if (isOpen) closeDrawer();
    else openDrawer();
  });

  overlay.addEventListener('click', closeDrawer);

  // Close drawer when clicking non-category links
  drawer.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && !e.target.classList.contains('drawer-chip') && e.target.getAttribute('href') !== '#') {
      closeDrawer();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      closeDrawer();
    }
  });

  // Scroll elevation effect on header for smaller devices (without hamburger or layout shifts)
  let ticking = false;
  function onWindowScroll() {
    const isScrolled = (window.scrollY || document.documentElement.scrollTop || 0) > 15;
    const siteHeader = document.querySelector('header.site');
    if (siteHeader) {
      siteHeader.classList.toggle('scrolled', isScrolled);
    }
    ticking = false;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(onWindowScroll);
      ticking = true;
    }
  }, { passive: true });

  onWindowScroll();
}

function showToast(msg, duration = 2200) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  // Force animation retrigger
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), duration);
}