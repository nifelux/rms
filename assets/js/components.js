// ============================================================
// Site-wide header/footer loader + auth-aware navigation builder
// ============================================================
// Load notifications system globally
document.write('<script src="/assets/js/notifications.js"><\/script>');

// ... rest of your components.js code ...
async function loadComponents() {
  try {
    const headerRes = await fetch('/assets/html/header.html');
    const headerHTML = await headerRes.text();
    document.getElementById('header-container').innerHTML = headerHTML;
    initMobileMenu();
    syncHeaderHeight();
  } catch (err) { console.error('Header load failed', err); }

  try {
    const footerRes = await fetch('/assets/html/footer.html');
    const footerHTML = await footerRes.text();
    document.getElementById('footer-container').innerHTML = footerHTML;
  } catch (err) { console.error('Footer load failed', err); }

  // Only resolve auth state (and toggle #tab-bar visibility) after BOTH
  // header and footer are actually in the DOM. Previously this ran
  // right after the header loaded, in parallel with the footer fetch —
  // if auth resolved first, document.getElementById('tab-bar') was null,
  // the visibility toggle silently no-op'd, and nothing ever retried it
  // once the footer did load, so the tab bar stayed stuck hidden.
  updateAuthUI();
}

// ------------------------------------------------------------
// Nav data — single source of truth for every user-facing page.
// Edit here to add/remove pages from the menu site-wide.
// ------------------------------------------------------------
const NAV_GROUPS_AUTHED = [
  { label: 'Dashboard', href: '/dashboard.html' },
  {
    label: 'Invest',
    items: [
      { label: 'Daily Tasks', href: '/investments.html' },
      { label: 'Task History', href: '/investment-details.html' },
      { label: 'Daily Earnings', href: '/daily-earnings.html' },
      { label: 'VIP Tiers', href: '/vip.html' }
    ]
  },
  {
    label: 'Wallet',
    items: [
      { label: 'Deposit', href: '/deposit.html' },
      { label: 'Withdraw', href: '/withdraw.html' },
      { label: 'Transaction History', href: '/transaction-history.html' },
      { label: 'Income History', href: '/income-history.html' },
      { label: 'Gift Codes', href: '/gift-codes.html' }
    ]
  },
  {
    label: 'Account',
    items: [
      { label: 'Profile', href: '/profile.html' },
      { label: 'Referral Program', href: '/referral.html' },
      { label: 'Settings', href: '/settings.html' },
      { label: 'Messages', href: '/messages.html' },
      { label: 'Support', href: '/support.html' }
    ]
  }
];

const NAV_GUEST = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/about.html' },
  { label: 'FAQ', href: '/faq.html' },
  { label: 'Company News', href: '/news.html' },
  { label: 'Contact', href: '/contact.html' }
];

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

const NAV_ICONS = {
  Dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  Invest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
  Wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1"/><path d="M21 12h-6a2 2 0 0 0 0 4h6z"/></svg>',
  Account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>'
};

function navIcon(label) {
  return NAV_ICONS[label] ? `<span class="nav-icon">${NAV_ICONS[label]}</span>` : '';
}

function renderDesktopNav(groups, { user, displayName, adminLink } = {}) {
  const groupHtml = groups.map(g => {
    if (!g.items) {
      return `<a href="${g.href}" class="nav-link">${navIcon(g.label)}${g.label}</a>`;
    }
    return `
      <div class="nav-dropdown">
        <button type="button" class="nav-link dropdown-toggle">
          ${navIcon(g.label)}${g.label}
          <svg class="chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="dropdown-menu">
          ${g.items.map(i => `<a href="${i.href}">${i.label}</a>`).join('')}
        </div>
      </div>
    `;
  }).join('');

  if (!user) {
    return `
      ${groupHtml}
      <a href="/login.html" class="nav-link">Login</a>
      <a href="/register.html" class="btn btn-sm btn-primary">Get Started</a>
    `;
  }

  return `
    ${groupHtml}
    ${adminLink}
    <div class="nav-dropdown user-chip">
      <button type="button" class="nav-link dropdown-toggle user-chip-btn">
        <span class="avatar-circle">${initials(displayName)}</span>
        <span class="user-chip-name">${displayName}</span>
        <svg class="chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <div class="dropdown-menu dropdown-menu-right">
        <a href="/profile.html">My Profile</a>
        <a href="#" id="logout-link">Logout</a>
      </div>
    </div>
  `;
}

function renderMobileNav(groups, { user, displayName, adminLink } = {}) {
  const groupHtml = groups.map(g => {
    if (!g.items) {
      return `<a href="${g.href}" class="mobile-link">${navIcon(g.label)}${g.label}</a>`;
    }
    return `
      <div class="mobile-accordion">
        <button type="button" class="mobile-accordion-toggle">
          <span class="flex items-center">${navIcon(g.label)}${g.label}</span>
          <svg class="chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="mobile-accordion-panel">
          ${g.items.map(i => `<a href="${i.href}" class="mobile-sublink">${i.label}</a>`).join('')}
        </div>
      </div>
    `;
  }).join('');

  if (!user) {
    return `
      ${groupHtml}
      <div class="mobile-menu-footer">
        <a href="/login.html" class="btn btn-outline btn-block">Login</a>
        <a href="/register.html" class="btn btn-primary btn-block mt-1">Get Started</a>
      </div>
    `;
  }

  return `
    <div class="mobile-user-card">
      <span class="avatar-circle avatar-circle-lg">${initials(displayName)}</span>
      <span class="mobile-user-name">${displayName}</span>
    </div>
    ${groupHtml}
    ${adminLink ? `<a href="/admin" class="mobile-link">Admin Panel</a>` : ''}
    <div class="mobile-menu-footer">
      <a href="#" id="logout-link-mobile" class="btn btn-outline btn-block">Logout</a>
    </div>
  `;
}

// Each page's own <script type="module"> creates its Supabase client and
// sets window.supabase — that's a CDN import, so it can resolve AFTER
// DOMContentLoaded fires. Poll briefly instead of checking once and
// silently giving up (which is what left the mobile menu blank).
function waitForSupabase(timeoutMs = 4000, intervalMs = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (window.supabase) return resolve(window.supabase);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, intervalMs);
    })();
  });
}

async function updateAuthUI() {
  const nav = document.getElementById('main-nav');
  const mobileContent = document.getElementById('mobile-menu-content');
  if (!nav) return;

  const supabase = await waitForSupabase();
  if (!supabase) {
    renderNavFor(null);
    return;
  }

  // Don't call supabase.auth.getUser() right away — immediately after the
  // client is created it may not have finished restoring the session from
  // storage yet, which was causing logged-in users to briefly (or
  // permanently, depending on page speed) see the guest menu.
  // onAuthStateChange fires once with event === 'INITIAL_SESSION' as soon
  // as the client has resolved the real session, and again on any future
  // sign-in/sign-out — so the nav also updates live without a reload.
  supabase.auth.onAuthStateChange((_event, session) => {
    renderNavFor(session?.user || null);
  });
}

async function renderNavFor(user) {
  const supabase = window.supabase;
  const nav = document.getElementById('main-nav');
  const mobileContent = document.getElementById('mobile-menu-content');
  const tabBar = document.getElementById('tab-bar');
  if (!nav) return;

  // The floating tab bar (Home/Tasks/Team/Profile) links to
  // authenticated-only pages — it's hidden by default in CSS and only
  // shown once a logged-in user is confirmed, so guest pages never
  // flash it before hiding it again.
  if (tabBar) tabBar.classList.toggle('is-visible', !!user);
  document.body.classList.toggle('has-tab-bar', !!user);

  if (user && supabase) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, is_admin')
      .eq('id', user.id)
      .single();
    const displayName = profile?.full_name || user.email;
    const adminLink = profile?.is_admin ? '<a href="/admin" class="nav-link">Admin</a>' : '';

    nav.innerHTML = renderDesktopNav(NAV_GROUPS_AUTHED, { user, displayName, adminLink });
    if (mobileContent) mobileContent.innerHTML = renderMobileNav(NAV_GROUPS_AUTHED, { user, displayName, adminLink });

    const logout = async (e) => {
      e.preventDefault();
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    };
    document.getElementById('logout-link')?.addEventListener('click', logout);
    document.getElementById('logout-link-mobile')?.addEventListener('click', logout);
  } else {
    nav.innerHTML = renderDesktopNav(NAV_GUEST);
    if (mobileContent) mobileContent.innerHTML = renderMobileNav(NAV_GUEST);
  }

  initDropdowns();
  initAccordions();
}

// ------------------------------------------------------------
// Desktop dropdowns: click to open, click outside to close
// ------------------------------------------------------------
function initDropdowns() {
  const dropdowns = document.querySelectorAll('.nav-dropdown');
  dropdowns.forEach(dd => {
    const toggle = dd.querySelector('.dropdown-toggle');
    toggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dd.classList.contains('open');
      dropdowns.forEach(d => d.classList.remove('open'));
      if (!isOpen) dd.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    dropdowns.forEach(d => d.classList.remove('open'));
  });
}

// ------------------------------------------------------------
// Mobile accordions inside the drawer
// ------------------------------------------------------------
function initAccordions() {
  document.querySelectorAll('.mobile-accordion-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.parentElement.classList.toggle('open');
    });
  });
}

// ------------------------------------------------------------
// Mobile drawer open/close (hamburger, overlay, close button, Esc)
// ------------------------------------------------------------
function initMobileMenu() {
  const toggleBtn = document.getElementById('mobile-toggle-btn');
  const closeBtn = document.getElementById('mobile-close-btn');
  const overlay = document.getElementById('mobile-overlay');
  const menu = document.getElementById('mobile-menu');

  function open() {
    menu?.classList.add('active');
    overlay?.classList.add('active');
    toggleBtn?.classList.add('active');
    toggleBtn?.setAttribute('aria-expanded', 'true');
    menu?.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    menu?.classList.remove('active');
    overlay?.classList.remove('active');
    toggleBtn?.classList.remove('active');
    toggleBtn?.setAttribute('aria-expanded', 'false');
    menu?.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  function toggle() {
    menu?.classList.contains('active') ? close() : open();
  }

  toggleBtn?.addEventListener('click', toggle);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  menu?.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
}

// Keeps body's top padding matched to the header's ACTUAL rendered
// height via a CSS var, instead of a hardcoded px guess that silently
// goes stale the moment the header's content changes (which is exactly
// what caused the header to overlap page content previously — the
// header grew taller but body{padding-top} was never updated to match).
// ResizeObserver re-fires on breakpoint changes, orientation changes,
// and webfont-load reflow, not just once at page load.
function syncHeaderHeight() {
  const header = document.querySelector('.floating-header');
  if (!header) return;

  const apply = () => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  };
  apply();

  if ('ResizeObserver' in window) {
    new ResizeObserver(apply).observe(header);
  } else {
    window.addEventListener('resize', apply);
  }
}

document.addEventListener('DOMContentLoaded', loadComponents);

async function loadComponent(id, url) {
  const container = document.getElementById(id);
  if (!container) return;
  try {
    const res = await fetch(url);
    const html = await res.text();
    container.innerHTML = html;
    
    // If header was loaded, update VIP badge
    if (id === 'header-container') {
      setTimeout(updateHeaderVipBadge, 500);
    }
    
    // Re-execute scripts
    container.querySelectorAll('script').forEach(oldScript => {
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
      newScript.appendChild(document.createTextNode(oldScript.innerHTML));
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  } catch (err) {
    console.error(`Failed to load ${url}:`, err);
  }
}

// VIP Badge function for header
async function updateHeaderVipBadge() {
  try {
    if (!window.supabase) return;
    
    const { data: { user } } = await window.supabase.auth.getUser();
    if (!user) return;
    
    const { data: profile } = await window.supabase
      .from('profiles')
      .select('vip_level')
      .eq('id', user.id)
      .single();
    
    if (profile && profile.vip_level) {
      const levelText = document.getElementById('vip-level-text');
      const indicator = document.getElementById('vip-indicator');
      
      if (levelText && indicator) {
        levelText.textContent = profile.vip_level.toUpperCase();
        
        // Remove all tier classes and add correct one
        indicator.className = 'vip-indicator';
        indicator.classList.add(profile.vip_level.toLowerCase());
      }
    }
  } catch (err) {
    console.error('Header VIP error:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadComponent('header-container', '/assets/html/header.html');
  loadComponent('footer-container', '/assets/html/footer.html');
});
