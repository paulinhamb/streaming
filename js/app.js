// ============================================================
// app.js — StreamFinder V02
// ============================================================

import {
  hasApiKey,
  getApiKey,
  setApiKey,
  getSubscribedProviders,
  setSubscribedProviders,
  getSubscribedProviderIds,
  getProviderIdToNameMap,
  getCountryName,
  countryFlag,
  DEFAULT_PROVIDERS,
  resetProviders,
} from './config.js?v=2';

import {
  searchMulti,
  getWatchProviders,
  fetchAllProviders,
  validateApiKey,
  getImageUrl,
  transformToPlatformView,
  transformRentBuyToStoreView,
} from './tmdb.js';

import {
  loadEventsData,
  searchEvents,
  getEvent,
  renderEventPage,
} from './events.js';

// ---- State ----
let currentAbortController = null;
let debounceTimer = null;
let allProvidersList = null;
let currentTitle = null;
let cachedUserCountryName = undefined; // undefined = not fetched yet, null = fetch failed
let cachedUserCountryCode = undefined; // raw 2-letter ISO code, e.g. "ES"

// Welcome page state
let welcomePosters = [];
let welcomePosterIndex = 0; // kept for compat but not used by new cycle system
let nextPosterIndex = 0;    // index of next poster to hand to a newly-back card
let welcomeCleanup = null;

// ---- DOM helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Initialization ----

async function init() {
  attachListeners();
  renderWelcomeState();
  loadEventsData(); // load events data in background (no await — non-blocking)

  // If a hardcoded key exists but localStorage is empty, persist it once
  // so it survives future loads regardless of module caching
  const key = getApiKey();
  if (key && !localStorage.getItem('streamfinder_api_key')) {
    setApiKey(key);
  }

  if (!hasApiKey()) {
    showSettings();
    return;
  }

  // Prefetch provider list in background
  try {
    allProvidersList = await fetchAllProviders();
  } catch (e) {
    console.warn('Failed to fetch provider list:', e);
  }

  handleHashRoute();
}

function renderWelcomeState() {
  // Tear down any running parallax / drag listeners from a previous welcome render
  if (welcomeCleanup) { welcomeCleanup(); welcomeCleanup = null; }
  welcomePosters = [];
  welcomePosterIndex = 0;
  nextPosterIndex = 0;

  $('#content-area').innerHTML = `
    <div class="welcome-state" id="welcome-state">
      <p class="hero-subtitle">Search any movie or series to find where it streams worldwide.</p>
      <div class="poster-stack" id="poster-stack">
        <div class="poster-layer poster-layer--back">
          <img src="" alt="" draggable="false">
        </div>
        <div class="poster-layer poster-layer--mid">
          <img src="" alt="" draggable="false">
        </div>
        <div class="poster-layer poster-layer--front">
          <img src="" alt="" draggable="false">
        </div>
      </div>
      <h1 class="hero-title">FIND YOUR<br>NEXT WATCH</h1>
    </div>
  `;

  setupWelcomeInteractions();
  loadWelcomePosters();
}

// Fetch 2 pages of trending movies — gives ~40 unique posters before any repeat
async function loadWelcomePosters() {
  try {
    const key = getApiKey();
    const [r1, r2] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${key}&page=1`),
      fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${key}&page=2`),
    ]);
    const d1 = r1.ok ? await r1.json() : { results: [] };
    const d2 = r2.ok ? await r2.json() : { results: [] };
    const all = [...(d1.results || []), ...(d2.results || [])];
    const posters = all
      .filter(m => m.poster_path)
      .map(m => getImageUrl(m.poster_path, 'w500'));

    if (posters.length < 3) return;
    welcomePosters = posters;
    initWelcomePosterImages();
  } catch (e) {
    console.warn('Could not load trending posters:', e);
  }
}

// Set initial poster images so cycling flows forward: front=0, mid=1, back=2, next=3
// (DOM elements: index 0=back layer, 1=mid layer, 2=front layer)
function initWelcomePosterImages() {
  const imgs = document.querySelectorAll('.poster-layer img');
  if (!imgs.length || welcomePosters.length < 3) return;
  const n = welcomePosters.length;
  imgs[0].src = welcomePosters[2 % n]; // back element
  imgs[1].src = welcomePosters[1 % n]; // mid element
  imgs[2].src = welcomePosters[0 % n]; // front element — user sees this first
  nextPosterIndex = 3;                  // next poster assigned to each new back card
}

// Assign the next unseen poster to a card element that just moved to the back
function assignNextPoster(cardEl) {
  if (!welcomePosters.length) return;
  const img = cardEl.querySelector('img');
  if (img) img.src = welcomePosters[nextPosterIndex % welcomePosters.length];
  nextPosterIndex++;
}

// Wire spring-physics 3D tilt + drag-to-cycle interactions
// Effect: drag the front card → it springs to the BOTTOM of the pile (with a bounce),
//         the next card rises to front. Repeats infinitely.
function setupWelcomeInteractions() {
  const state = document.getElementById('welcome-state');
  const stack = document.getElementById('poster-stack');
  if (!state || !stack) return;

  let destroyed = false;

  // ── Fixed DOM elements (never change order) ───────────────────────────────
  // index 0 = .poster-layer--back, 1 = .poster-layer--mid, 2 = .poster-layer--front
  const cardEls = [
    document.querySelector('.poster-layer--back'),
    document.querySelector('.poster-layer--mid'),
    document.querySelector('.poster-layer--front'),
  ];

  // ── Role system ───────────────────────────────────────────────────────────
  // cardRole[elementIndex] = current visual role  (0=back, 1=mid, 2=front)
  // Roles rotate on every cycle; DOM elements stay put.
  let cardRole = [0, 1, 2];

  // Visual target position per role
  const ROLE_BASE = [
    { x: 13, y: 15 }, // back
    { x:   0, y:   0 }, // mid
    { x:  15, y:  -8 }, // front
  ];

  // Spring stiffness / damping per role.
  // Back role is bouncy — the card "plonks" into place with a satisfying overshoot.
  const ROLE_SPRING = [
    { k: 0.09, damp: 0.50 }, // back  — bouncy landing
    { k: 0.10, damp: 0.64 }, // mid
    { k: 0.12, damp: 0.70 }, // front — snappy
  ];

  // Entry animation (initial page load only), indexed by ELEMENT (0/1/2)
  // Back slides from left, mid from right, front from bottom — same stagger as before.
  const ENTRY = [
    { axis: 'x', start: -90, delay:  2 }, // element 0 (starts as back)
    { axis: 'x', start:  90, delay:  6 }, // element 1 (starts as mid)
    { axis: 'y', start:  90, delay: 10 }, // element 2 (starts as front)
  ];

  // ── Per-element physics state (absolute x/y position) ────────────────────
  const sp = cardEls.map((el, i) => {
    const base  = ROLE_BASE[i];           // initial role matches element index
    const entry = ENTRY[i];
    return {
      x:  { pos: entry.axis === 'x' ? base.x + entry.start : base.x, vel: 0 },
      y:  { pos: entry.axis === 'y' ? base.y + entry.start : base.y, vel: 0 },
      rx: { pos: 0, vel: 0 },             // hover tilt X
      ry: { pos: 0, vel: 0 },             // hover tilt Y
      entered:   false,
      entryDist: Math.abs(entry.start),   // total entry travel for opacity ramp
    };
  });

  // Set z-indexes from JS (we own them — CSS class z-index is overridden)
  cardEls.forEach((el, i) => {
    el.style.zIndex = String(i + 1); // back=1, mid=2, front=3
    el.style.opacity = '0';
  });

  // ── Hover tilt ────────────────────────────────────────────────────────────
  const MAX_RX = 25, MAX_RY = 25;
  let targetRX = 0, targetRY = 0;

  function springStep(s, target, k, damp) {
    s.vel += (target - s.pos) * k;
    s.vel *= damp;
    s.pos += s.vel;
  }

  // ── Drag / cycle state ────────────────────────────────────────────────────
  // mode: 'idle' | 'drag' | 'snap' | 'cycle'
  let mode = 'idle';
  let dragStartX = 0, dragStartY = 0;
  const drag = { x: 0, y: 0, vx: 0, vy: 0 };
  const snapSp = { x: { pos: 0, vel: 0 }, y: { pos: 0, vel: 0 } };
  let cycledIdx = -1; // element index of the card that just cycled to back

  const CYCLE_THRESHOLD = 30; // px in any direction to trigger a cycle

  // ── Event handlers ────────────────────────────────────────────────────────
  function onDragStart(e) {
    if (mode !== 'idle') return;
    // Only respond to the card currently in the front role
    const touchedEl = e.target.closest('.poster-layer');
    if (!touchedEl) return;
    const idx = cardEls.indexOf(touchedEl);
    if (idx < 0 || cardRole[idx] !== 2) return; // not the front card

    mode = 'drag';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = cx; dragStartY = cy;
    drag.x = 0; drag.y = 0; drag.vx = 0; drag.vy = 0;
    stack.style.cursor = 'grabbing';
  }

  function onDragMove(e) {
    if (mode !== 'drag') return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const nx = cx - dragStartX, ny = cy - dragStartY;
    drag.vx = nx - drag.x; drag.vy = ny - drag.y;
    drag.x = nx; drag.y = ny;
  }

  function onDragEnd() {
    if (mode !== 'drag') return;
    stack.style.cursor = 'grab';
    if (Math.hypot(drag.x, drag.y) > CYCLE_THRESHOLD) {
      triggerCycle();
    } else {
      // Snap back — carry the drag offset as a spring starting position
      mode = 'snap';
      snapSp.x.pos = drag.x * 0.45; snapSp.x.vel = drag.vx * 0.45;
      snapSp.y.pos = drag.y * 0.45; snapSp.y.vel = drag.vy * 0.45;
    }
  }

  // ── Cycle: front card goes to the bottom of the pile ─────────────────────
  function triggerCycle() {
    const fi = cardRole.indexOf(2); // front element
    const mi = cardRole.indexOf(1); // mid element
    const bi = cardRole.indexOf(0); // back element
    cycledIdx = fi;

    // Rotate roles: front → back, mid → front, back → mid
    cardRole[fi] = 0;
    cardRole[mi] = 2;
    cardRole[bi] = 1;

    // The cycling card's z-index drops immediately to 0 so it visually
    // passes BEHIND the other cards as it travels to the back position.
    cardEls[fi].style.zIndex = '0';
    cardEls[mi].style.zIndex = '3'; // new front
    cardEls[bi].style.zIndex = '2'; // new mid

    // Transfer drag momentum so the card carries the gesture into its animation
    sp[fi].x.vel += drag.vx * 0.6;
    sp[fi].y.vel += drag.vy * 0.6;

    // Load the next poster onto the card going to back (invisible while traveling)
    assignNextPoster(cardEls[fi]);

    mode = 'cycle';

    // Safety valve: if spring hasn't settled in 1.4s, force idle
    setTimeout(() => {
      if (destroyed || mode !== 'cycle') return;
      finalizeZIndex();
      mode = 'idle';
    }, 1400);
  }

  function finalizeZIndex() {
    if (cycledIdx < 0) return;
    cardEls[cycledIdx].style.zIndex = '1'; // back z
    cycledIdx = -1;
  }

  // ── rAF tick ──────────────────────────────────────────────────────────────
  let rafId = null, frame = 0;

  function tick() {
    frame++;
    let allSettled = (mode === 'cycle'); // track cycle completion

    for (let i = 0; i < 3; i++) {
      const el   = cardEls[i];
      const s    = sp[i];
      const role = cardRole[i];
      const base = ROLE_BASE[role];
      const { k, damp } = ROLE_SPRING[role];

      // ── Entry animation (one-time, page load only) ───────────────────
      if (!s.entered) {
        const en = ENTRY[i]; // indexed by element, not role — correct at startup
        if (frame < en.delay) {
          el.style.transform = `translate(${s.x.pos}px, ${s.y.pos}px)`;
          continue;
        }
        // Opacity ramp: based on remaining distance to base
        const dist = Math.hypot(s.x.pos - base.x, s.y.pos - base.y);
        const prog = (s.entryDist - dist) / (s.entryDist * 0.55);
        el.style.opacity = Math.min(1, Math.max(0, prog)).toFixed(3);
        if (dist < 1.0 && Math.abs(s.x.vel) < 0.3 && Math.abs(s.y.vel) < 0.3) {
          s.entered = true;
          el.style.opacity = '1';
        }
      }

      // ── Hover tilt (idle only; return to zero otherwise) ─────────────
      if (mode === 'idle' && s.entered) {
        const t = 0.3 + (role / 2) * 0.7; // scale by role depth
        springStep(s.rx, targetRX * t, k * 0.8, damp);
        springStep(s.ry, targetRY * t, k * 0.8, damp);
      } else {
        springStep(s.rx, 0, 0.10, 0.80);
        springStep(s.ry, 0, 0.10, 0.80);
      }

      // ── Position target ───────────────────────────────────────────────
      let tx = base.x, ty = base.y;
      if (role === 2) { // this element is currently the front card
        if (mode === 'drag') {
          // Card follows finger at 45% (slight resistance makes it feel heavy)
          tx = base.x + drag.x * 0.45;
          ty = base.y + drag.y * 0.45;
        } else if (mode === 'snap') {
          tx = base.x + snapSp.x.pos;
          ty = base.y + snapSp.y.pos;
        }
      }
      springStep(s.x, tx, k, damp);
      springStep(s.y, ty, k, damp);

      // ── Snap spring advance ───────────────────────────────────────────
      if (mode === 'snap' && role === 2) {
        springStep(snapSp.x, 0, 0.15, 0.65);
        springStep(snapSp.y, 0, 0.15, 0.65);
        if (Math.abs(snapSp.x.pos) < 0.3 && Math.abs(snapSp.x.vel) < 0.05) {
          snapSp.x.pos = 0; snapSp.x.vel = 0;
          snapSp.y.pos = 0; snapSp.y.vel = 0;
          mode = 'idle';
        }
      }

      // ── Drag deformation on front card ────────────────────────────────
      // Lean + 3D fold + velocity-based skew (cloth stretch feel)
      let rotZ = 0, rotY = 0, skewX = 0;
      if (role === 2 && (mode === 'drag' || mode === 'snap')) {
        const dx = mode === 'drag' ? drag.x  : snapSp.x.pos;
        const vx = mode === 'drag' ? drag.vx : snapSp.x.vel;
        rotZ  =  dx * 0.04;
        rotY  =  dx * 0.02;
        skewX = -vx * 0.25;
      }

      // ── Apply final transform ─────────────────────────────────────────
      el.style.transform = `
        translate(${s.x.pos}px, ${s.y.pos}px)
        rotateX(${s.rx.pos}deg)
        rotateY(${s.ry.pos + rotY}deg)
        rotateZ(${rotZ}deg)
        skewX(${skewX}deg)
      `;

      // ── Cycle settle check ────────────────────────────────────────────
      if (allSettled) {
        if (Math.abs(s.x.pos - base.x) > 1.5 || Math.abs(s.y.pos - base.y) > 1.5 ||
            Math.abs(s.x.vel) > 0.3 || Math.abs(s.y.vel) > 0.3) {
          allSettled = false;
        }
      }
    }

    // Once all cards have settled into their new roles, restore z-index and go idle
    if (allSettled && mode === 'cycle') {
      finalizeZIndex();
      mode = 'idle';
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  // ── Mouse / touch handlers ────────────────────────────────────────────────
  function onMouseMove(e) {
    if (mode !== 'idle') return;
    const rect = state.getBoundingClientRect();
    const nx = (e.clientX - rect.left  - rect.width  / 2) / (rect.width  / 2);
    const ny = (e.clientY - rect.top   - rect.height / 2) / (rect.height / 2);
    targetRX = -ny * MAX_RX;
    targetRY =  nx * MAX_RY;
  }
  function onMouseLeave() { if (mode === 'idle') { targetRX = 0; targetRY = 0; } }
  function onWindowMouseMove(e) {
    if (mode === 'drag') onDragMove(e);
    else onMouseMove(e);
  }

  stack.addEventListener('mousedown',  onDragStart);
  stack.addEventListener('touchstart', onDragStart, { passive: true });
  window.addEventListener('mousemove',  onWindowMouseMove);
  window.addEventListener('touchmove',  onDragMove, { passive: true });
  window.addEventListener('mouseup',    onDragEnd);
  window.addEventListener('touchend',   onDragEnd);
  state.addEventListener('mouseleave',  onMouseLeave);

  // ── Gyroscope tilt on touch devices ──────────────────────────────────────
  let onOrientation = null;
  let gyroBtn = null; // iOS permission button (shown only when needed)

  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
    let baseBeta = null, baseGamma = null;

    onOrientation = (e) => {
      if (mode !== 'idle') return;
      if (e.beta === null || e.gamma === null) return;

      // Capture baseline on first reading so relative movement drives the effect
      if (baseBeta === null) { baseBeta = e.beta; baseGamma = e.gamma; return; }

      const dBeta  = e.beta  - baseBeta;
      const dGamma = e.gamma - baseGamma;

      // gamma (left/right tilt) → rotateY, beta delta (fwd/back) → rotateX
      targetRX = Math.max(-MAX_RX, Math.min(MAX_RX, -dBeta  / 12 * MAX_RX));
      targetRY = Math.max(-MAX_RY, Math.min(MAX_RY,  dGamma / 18 * MAX_RY));
    };

    const startGyro = () => {
      baseBeta = null; baseGamma = null; // reset baseline so tilt is relative to current hold
      window.addEventListener('deviceorientation', onOrientation);
    };

    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      // iOS 13+: try immediately — works silently if already granted in a prior visit
      DeviceOrientationEvent.requestPermission().then(result => {
        if (result === 'granted') startGyro();
        // Denied silently: do nothing, no button
      }).catch(() => {
        // Needs a user gesture — show a small intentional icon button on the poster stack
        gyroBtn = document.createElement('button');
        gyroBtn.className = 'gyro-btn';
        gyroBtn.setAttribute('aria-label', 'Enable tilt effect');
        gyroBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="28px" viewBox="0 -960 960 960" width="28px" fill="currentColor"><path d="M419-80q-28 0-52.5-12T325-126L107-403l19-20q20-21 48-25t52 11l74 45v-328q0-17 11.5-28.5T340-760q17 0 29 11.5t12 28.5v472l-97-60 104 133q6 7 14 11t17 4h221q33 0 56.5-23.5T720-240v-160q0-17-11.5-28.5T680-440H461v-80h219q50 0 85 35t35 85v160q0 66-47 113T640-80H419ZM167-620q-13-22-20-47.5t-7-52.5q0-83 58.5-141.5T340-920q83 0 141.5 58.5T540-720q0 27-7 52.5T513-620l-69-40q8-14 12-28.5t4-31.5q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 17 4 31.5t12 28.5l-69 40Zm335 280Z"/></svg><span>Make it move</span>`;
        gyroBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const granted = await DeviceOrientationEvent.requestPermission();
            gyroBtn.remove(); gyroBtn = null;
            if (granted === 'granted') startGyro();
          } catch (_) {
            gyroBtn.remove(); gyroBtn = null;
          }
        });
        // Append to body (not the stack) so position:fixed places it in the
        // viewport stacking context — completely immune to hero-title's blend mode.
        const rect = stack.getBoundingClientRect();
        gyroBtn.style.top  = Math.round(rect.top  + rect.height / 2) + 'px';
        gyroBtn.style.left = Math.round(rect.left + rect.width  / 2) + 'px';
        document.body.appendChild(gyroBtn);
      });
    } else if (window.DeviceOrientationEvent) {
      // Android / iOS 12 — no permission needed
      startGyro();
    }
  }

  welcomeCleanup = () => {
    destroyed = true;
    cancelAnimationFrame(rafId);
    stack.removeEventListener('mousedown',  onDragStart);
    stack.removeEventListener('touchstart', onDragStart);
    window.removeEventListener('mousemove',  onWindowMouseMove);
    window.removeEventListener('touchmove',  onDragMove);
    window.removeEventListener('mouseup',    onDragEnd);
    window.removeEventListener('touchend',   onDragEnd);
    state.removeEventListener('mouseleave',  onMouseLeave);
    if (onOrientation) window.removeEventListener('deviceorientation', onOrientation);
    if (gyroBtn) { gyroBtn.remove(); gyroBtn = null; }
  };
}

function attachListeners() {
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', onSearchKeydown);
  searchInput.addEventListener('focus', () => {
    $('.site-header').classList.add('search-active');
  });

  // Close dropdown + collapse search on outside click
  document.addEventListener('click', (e) => {
    const searchSection = $('.header-search-section');
    if (searchSection && !searchSection.contains(e.target)) {
      deactivateSearch();
    }
  });

  document.querySelector('.header-logo').addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', '/');
    $('#search-input').value = '';
    hideDropdown();
    renderWelcomeState();
  });

  $('#settings-btn').addEventListener('click', showSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-reset').addEventListener('click', resetToDefaults);

  window.addEventListener('hashchange', handleHashRoute);

  const platformSearch = $('#platform-search');
  if (platformSearch) platformSearch.addEventListener('input', onPlatformSearch);
}

// ---- Search ----

function onSearchInput(e) {
  const query = e.target.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (currentAbortController) currentAbortController.abort();
  if (query.length < 2) { hideDropdown(); return; }
  debounceTimer = setTimeout(() => performSearch(query), 300);
}

async function performSearch(query) {
  currentAbortController = new AbortController();
  try {
    showDropdownLoading();
    // Search TMDB and local events in parallel
    const [tmdbResults, eventResults] = await Promise.all([
      searchMulti(query, currentAbortController.signal),
      Promise.resolve(searchEvents(query).map(e => ({
        id: e.id,
        type: 'event',
        title: e.name,
        year: e.period || '',
        posterPath: null,
        sport: e.sport,
        emoji: e.emoji,
      }))),
    ]);
    // Events first (exact intent), then TMDB results
    const combined = [...eventResults, ...tmdbResults];
    if (combined.length === 0) showDropdownEmpty(query);
    else renderDropdown(combined);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Search error:', err);
    showDropdownError();
  }
}

function renderDropdown(results) {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = results.map((r, i) => {
    const isEvent = r.type === 'event';
    const badgeLabel = isEvent ? 'Event' : (r.type === 'movie' ? 'Movie' : 'TV');
    const leftCol = isEvent
      ? `<span class="dropdown-sport-emoji">${r.emoji || '🏆'}</span>`
      : `<img class="dropdown-poster"
              src="${getImageUrl(r.posterPath, 'w92') || ''}"
              alt=""
              onerror="this.style.display='none'">`;
    return `
    <button class="dropdown-item" data-index="${i}" data-id="${r.id}" data-type="${r.type}">
      ${leftCol}
      <div class="dropdown-info">
        <span class="dropdown-title">${escapeHtml(r.title)}</span>
        <span class="dropdown-meta">
          <span class="badge badge-${r.type}">${badgeLabel}</span>
          ${r.year ? `<span class="dropdown-year">${escapeHtml(r.year)}</span>` : ''}
        </span>
      </div>
    </button>`;
  }).join('');

  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      selectResult(results[parseInt(btn.dataset.index)]);
    });
  });
}

function showDropdownLoading() {
  const d = $('#search-dropdown');
  d.innerHTML = '<div class="dropdown-message"><div class="spinner"></div> Searching...</div>';
  d.classList.remove('hidden');
}

function showDropdownEmpty(q) {
  const d = $('#search-dropdown');
  d.innerHTML = `<div class="dropdown-message">No results for "${escapeHtml(q)}"</div>`;
  d.classList.remove('hidden');
}

function showDropdownError() {
  const d = $('#search-dropdown');
  d.innerHTML = '<div class="dropdown-message dropdown-error">Search failed. Check your API key.</div>';
  d.classList.remove('hidden');
}

function hideDropdown() {
  const d = $('#search-dropdown');
  d.classList.add('hidden');
  d.innerHTML = '';
}

function deactivateSearch() {
  $('.site-header').classList.remove('search-active');
  hideDropdown();
}

// ---- Keyboard navigation ----

function onSearchKeydown(e) {
  const dropdown = $('#search-dropdown');
  if (dropdown.classList.contains('hidden')) return;

  const items = dropdown.querySelectorAll('.dropdown-item');
  if (!items.length) return;

  const active = dropdown.querySelector('.dropdown-item.active');
  let idx = active ? [...items].indexOf(active) : -1;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
    items.forEach(el => el.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
    items.forEach(el => el.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && active) {
    e.preventDefault();
    active.click();
  } else if (e.key === 'Escape') {
    deactivateSearch();
    $('#search-input').blur();
  }
}

// ---- Title Selection & Availability ----

async function selectResult(result) {
  if (welcomeCleanup) { welcomeCleanup(); welcomeCleanup = null; }
  deactivateSearch();
  currentTitle = result;
  $('#search-input').value = result.title;
  if (result.type === 'event') {
    window.location.hash = `event/${result.id}`;
    const event = getEvent(result.id);
    if (event) renderEventPage(event);
    return;
  }
  window.location.hash = `${result.type}/${result.id}`;
  await loadAvailability(result.id, result.type, result.title, result.posterPath, result.year);
}

async function loadAvailability(id, mediaType, title, posterPath, year = '', runtime = null) {
  const area = $('#content-area');
  area.innerHTML = `
    <div class="loading-state">
      <div class="spinner-large"></div>
      <p>Checking streaming availability...</p>
    </div>
  `;

  try {
    // Fetch providers + movie details in parallel (details gives us runtime)
    const [results, details] = await Promise.all([
      getWatchProviders(id, mediaType),
      runtime === null
        ? fetch(`https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${getApiKey()}`)
            .then(r => r.json()).catch(() => null)
        : Promise.resolve(null),
    ]);

    // Extract runtime if we fetched details
    if (details && runtime === null) {
      runtime = mediaType === 'movie'
        ? (details.runtime || null)
        : (details.episode_run_time?.[0] || null);
      // Also improve year/posterPath if missing
      if (!year) year = (mediaType === 'movie' ? details.release_date : details.first_air_date)?.split('-')[0] || '';
      if (!posterPath) posterPath = details.poster_path || null;
    }

    const subscribedIds = getSubscribedProviderIds();
    const idToNameMap = getProviderIdToNameMap();
    const platformData = transformToPlatformView(results, subscribedIds, idToNameMap);
    const rentBuyData  = transformRentBuyToStoreView(results);
    const countryName  = await fetchUserCountryName();
    const countryCode  = cachedUserCountryCode;

    renderResultsLayout(platformData, rentBuyData, title, posterPath, year, mediaType, runtime, countryName, countryCode);
  } catch (err) {
    console.error('Availability error:', err);
    area.innerHTML = `
      <div class="loading-state">
        <p class="error-text">Failed to load availability data. Please try again.</p>
      </div>
    `;
  }
}

// ---- Render Results ----

const CHEVRON_SVG = `<svg class="row-chevron" width="20" height="20" viewBox="0 0 20 20" fill="none">
  <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Scales .movie-title down until it fits inside .movie-title-section (max 340px)
function fitTitleText() {
  const section = document.querySelector('.movie-title-section');
  const title   = document.querySelector('.movie-title');
  if (!section || !title) return;

  const MAX_HEIGHT = 340;
  const MAX_SIZE   = 60;
  const MIN_SIZE   = 18;

  // Always start from the maximum so short titles stay large
  title.style.fontSize = MAX_SIZE + 'px';

  let size = MAX_SIZE;
  while (section.scrollHeight > MAX_HEIGHT && size > MIN_SIZE) {
    size -= 1;
    title.style.fontSize = size + 'px';
  }
}

function formatRuntime(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const STAR_SVG = `<svg class="availability-star" xmlns="http://www.w3.org/2000/svg" width="31.62" height="30" viewBox="0 0 34 34" fill="none">
  <g filter="url(#sf_star_filter)">
    <path d="M13.9326 13.0762L15.8901 10.5418C16.03 10.3554 16.196 10.2185 16.3883 10.1311C16.5805 10.0437 16.7815 10 16.9913 10C17.201 10 17.402 10.0437 17.5943 10.1311C17.7865 10.2185 17.9526 10.3554 18.0924 10.5418L20.0499 13.0762L23.0212 14.0724C23.3242 14.1656 23.563 14.3375 23.7378 14.588C23.9126 14.8385 24 15.1153 24 15.4182C24 15.5581 23.9796 15.6979 23.9388 15.8377C23.898 15.9775 23.831 16.1115 23.7378 16.2397L21.8152 18.9663L21.8851 21.8327C21.8968 22.2405 21.7628 22.5843 21.4831 22.8639C21.2035 23.1436 20.8772 23.2834 20.5044 23.2834C20.4811 23.2834 20.3529 23.2659 20.1199 23.231L16.9913 22.3571L13.8627 23.231C13.8044 23.2543 13.7403 23.2688 13.6704 23.2747C13.6005 23.2805 13.5364 23.2834 13.4782 23.2834C13.1053 23.2834 12.779 23.1436 12.4994 22.8639C12.2197 22.5843 12.0857 22.2405 12.0974 21.8327L12.1673 18.9488L10.2622 16.2397C10.169 16.1115 10.102 15.9775 10.0612 15.8377C10.0204 15.6979 10 15.5581 10 15.4182C10 15.1269 10.0845 14.856 10.2534 14.6055C10.4224 14.355 10.6583 14.1773 10.9613 14.0724L13.9326 13.0762Z" fill="#fe9a00"/>
  </g>
  <defs>
    <filter id="sf_star_filter" x="0" y="0" width="34" height="33.2834" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset/><feGaussianBlur stdDeviation="5"/>
      <feComposite in2="hardAlpha" operator="out"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.733333 0 0 0 0 0 0 0 0 0.2 0"/>
      <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
      <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset/><feGaussianBlur stdDeviation="2.5"/>
      <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.5 0"/>
      <feBlend mode="lighten" in2="shape" result="effect2_innerShadow"/>
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset/><feGaussianBlur stdDeviation="0.5"/>
      <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.930394 0 0 0 0 0.738976 0 0 0 1 0"/>
      <feBlend mode="overlay" in2="effect2_innerShadow" result="effect3_innerShadow"/>
    </filter>
  </defs>
</svg>`;

function renderResultsLayout(platformData, rentBuyData, title, posterPath, year, mediaType, runtime = null, countryName = null, countryCode = null) {
  const area = $('#content-area');
  const subscribedProviders = getSubscribedProviders();

  // ---- Platform rows ----
  let rowsHtml = '';
  let hasAny = false;

  for (const provider of subscribedProviders) {
    const data = platformData[provider.name];
    const hasCountries = data && data.countries.length > 0;
    if (hasCountries) hasAny = true;

    const countLabel = hasCountries
      ? `${data.countries.length} ${data.countries.length === 1 ? 'country' : 'countries'}`
      : '';

    // Logo: from results, then fall back to allProvidersList
    let logoSrc = null;
    if (data?.logo) {
      logoSrc = getImageUrl(data.logo);
    } else if (allProvidersList) {
      for (const id of provider.ids) {
        if (allProvidersList[id]?.logoPath) {
          logoSrc = getImageUrl(allProvidersList[id].logoPath);
          break;
        }
      }
    }

    const logoHtml = logoSrc
      ? `<img src="${logoSrc}" alt="">`
      : `<div class="logo-placeholder"></div>`;

    const isLocal = hasCountries && countryCode && data.countries.includes(countryCode);
    const dotClass = hasCountries ? 'availability-dot--on' : 'availability-dot--off';
    const rowClass = hasCountries ? 'platform-row--available' : 'platform-row--unavailable';

    const indicatorHtml = isLocal
      ? STAR_SVG
      : `<span class="availability-dot ${dotClass}"></span>`;

    // Country grid cells — highlight user's country
    const countryGridHtml = hasCountries
      ? data.countries.map(code =>
          `<span class="country-cell" title="${getCountryName(code)}">${countryFlag(code)} ${code}</span>`
        ).join('')
      : '';

    rowsHtml += `
      <div class="platform-row ${rowClass}">
        <button class="platform-row__header" ${!hasCountries ? 'disabled' : ''}>
          <span class="pr-cell pr-cell--dot">
            ${indicatorHtml}
          </span>
          <span class="pr-cell pr-cell--logo">
            ${logoHtml}
          </span>
          <span class="pr-cell pr-cell--name">${escapeHtml(provider.name)}</span>
          <span class="pr-cell pr-cell--count">${hasCountries ? countLabel : '—'}</span>
          <span class="pr-cell pr-cell--chevron">
            ${hasCountries ? CHEVRON_SVG : ''}
          </span>
        </button>
        ${hasCountries ? `
          <div class="platform-row__body">
            <div class="country-grid">${countryGridHtml}</div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ---- Left column: poster + info ----
  const posterHtml = posterPath
    ? `<img class="movie-poster" src="${getImageUrl(posterPath, 'w500')}" alt="${escapeHtml(title)}">`
    : `<div class="movie-poster-placeholder"></div>`;

  const runtimeStr = formatRuntime(runtime);

  // Build info cells (only show cells that have data)
  let infoCellsHtml = '';
  if (year) infoCellsHtml += `
    <div class="movie-info-cell">
      <span class="movie-info-label">Release</span>
      <span class="movie-info-value">${year}</span>
    </div>`;
  if (runtimeStr) infoCellsHtml += `
    <div class="movie-info-cell">
      <span class="movie-info-label">Runtime</span>
      <span class="movie-info-value">${runtimeStr}</span>
    </div>`;

  area.innerHTML = `
    <div class="results-layout">

      <div class="results-left">
        <div class="movie-title-section">
          <h2 class="movie-title">${escapeHtml(title)}</h2>
        </div>
        ${infoCellsHtml ? `<div class="movie-info-row">${infoCellsHtml}</div>` : ''}
        <div class="movie-poster-section">
          ${posterHtml}
        </div>
      </div>

      <div class="results-right">
        <p class="streaming-label">#STREAMING RESULTS</p>
        <div class="platform-rows">
          ${rowsHtml}
        </div>
        ${!hasAny ? `
          <p class="empty-results">Not available on any of your streaming subscriptions in any country.</p>
        ` : ''}
        ${buildRentBuyStrip(rentBuyData, countryName)}
      </div>

    </div>
  `;

  // Scale title to fit within max-height 340px
  fitTitleText();

  // Accordion toggle — available streaming rows only
  area.querySelectorAll('.platform-row--available .platform-row__header').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.platform-row');
      const isOpen = row.classList.contains('open');
      area.querySelectorAll('.platform-row.open').forEach(r => r.classList.remove('open'));
      if (!isOpen) row.classList.add('open');
    });
  });

  // "+N more" toggle — expands overflow strip rows
  const moreBtn = area.querySelector('.rentbuy-strip__card--more');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const strip = moreBtn.closest('.rentbuy-strip');
      const isOpen = strip.classList.contains('expanded');
      strip.classList.toggle('expanded', !isOpen);
      moreBtn.setAttribute('aria-expanded', String(!isOpen));
    });
  }
}

// ---- Rent / Buy strip builder ----
// Returns HTML for the fixed-bottom store chips strip.
// Shows top 5 stores by country reach; "+N more" card if there are more.

const MAX_STRIP_STORES = 5;

/**
 * Detect the user's country name from their browser locale.
 * Returns e.g. "Spain" from "es-ES", or null if undetectable.
 */
async function fetchUserCountryName() {
  if (cachedUserCountryName !== undefined) return cachedUserCountryName;
  try {
    const res = await fetch('https://api.country.is/', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('non-ok');
    const { country } = await res.json();
    if (country && country.length === 2) {
      cachedUserCountryCode = country.toUpperCase();
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      const name = names.of(country);
      cachedUserCountryName = (name && name !== country) ? name : null;
    } else {
      cachedUserCountryCode = null;
      cachedUserCountryName = null;
    }
  } catch {
    cachedUserCountryCode = null;
    cachedUserCountryName = null;
  }
  return cachedUserCountryName;
}

function buildRentBuyStrip(rentBuyData, countryName) {
  if (!rentBuyData || Object.keys(rentBuyData).length === 0) return '';

  const storeNames = Object.keys(rentBuyData); // already sorted by country count
  if (storeNames.length === 0) return '';

  const visible = storeNames.slice(0, MAX_STRIP_STORES);
  const overflowNames = storeNames.slice(MAX_STRIP_STORES);

  const label = countryName
    ? `Also available to rent or buy in ${countryName}`
    : 'Also available to rent or buy';

  const cardHtml = visible.map(name =>
    `<div class="rentbuy-strip__card" title="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></div>`
  ).join('');

  // "+N more" button — only rendered if there are overflow stores
  const moreHtml = overflowNames.length > 0 ? `
    <button class="rentbuy-strip__card rentbuy-strip__card--more" aria-expanded="false">
      <span class="rentbuy-more-label">+${overflowNames.length} more</span>
      <svg class="rentbuy-more-chevron" width="12" height="12" viewBox="0 0 20 20" fill="none">
        <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>` : '';

  // Overflow cards — chunked into rows of MAX_STRIP_STORES so each row fills cleanly
  let overflowRowsHtml = '';
  for (let i = 0; i < overflowNames.length; i += MAX_STRIP_STORES) {
    const chunk = overflowNames.slice(i, i + MAX_STRIP_STORES);
    overflowRowsHtml += `
      <div class="rentbuy-strip__cards rentbuy-strip__cards--overflow">
        ${chunk.map(name =>
          `<div class="rentbuy-strip__card" title="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></div>`
        ).join('')}
      </div>`;
  }

  const overflowSectionHtml = overflowNames.length > 0 ? `
    <div class="rentbuy-strip__overflow">
      <div class="rentbuy-strip__overflow-inner">
        ${overflowRowsHtml}
      </div>
    </div>` : '';

  return `
    <div class="rentbuy-strip">
      <p class="rentbuy-strip__label">${escapeHtml(label)}</p>
      <div class="rentbuy-strip__cards">
        ${cardHtml}${moreHtml}
      </div>
      ${overflowSectionHtml}
    </div>
  `;
}

// ---- Hash Routing ----

async function handleHashRoute() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

  // Event route: #event/roland-garros
  const eventMatch = hash.match(/^event\/(.+)$/);
  if (eventMatch) {
    // Events data may still be loading — wait briefly then try
    await loadEventsData();
    const event = getEvent(eventMatch[1]);
    if (event) {
      $('#search-input').value = event.name;
      renderEventPage(event);
    }
    return;
  }

  const match = hash.match(/^(movie|tv)\/(\d+)$/);
  if (!match) return;

  const [, mediaType, id] = match;
  if (!hasApiKey()) return;

  try {
    const data = await (await fetch(
      `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${getApiKey()}`
    )).json();

    const title = mediaType === 'movie' ? data.title : data.name;
    const posterPath = data.poster_path;
    const year = (mediaType === 'movie' ? data.release_date : data.first_air_date)?.split('-')[0] || '';
    const runtime = mediaType === 'movie'
      ? (data.runtime || null)
      : (data.episode_run_time?.[0] || null);

    $('#search-input').value = title || '';
    await loadAvailability(parseInt(id), mediaType, title || 'Unknown', posterPath, year, runtime);
  } catch (e) {
    console.error('Hash route error:', e);
  }
}

// ---- Settings ----

function showSettings() {
  $('#api-key-input').value = hasApiKey() ? '••••••••' : '';
  renderSubscribedList();
  $('#settings-modal').showModal();
}

function closeSettings() {
  $('#settings-modal').close();
}

async function saveSettings() {
  const key = $('#api-key-input').value.trim();
  const statusEl = $('#settings-status');

  if (key && !key.startsWith('••')) {
    statusEl.textContent = 'Validating API key...';
    statusEl.className = 'settings-status';

    setApiKey(key);
    const valid = await validateApiKey();

    if (!valid) {
      statusEl.textContent = 'Invalid API key. Please check and try again.';
      statusEl.className = 'settings-status error';
      return;
    }

    statusEl.textContent = 'API key saved!';
    statusEl.className = 'settings-status success';

    try { allProvidersList = await fetchAllProviders(); } catch {}
  }

  closeSettings();
}

function resetToDefaults() {
  resetProviders();
  renderSubscribedList();
}

function renderSubscribedList() {
  const list = $('#subscribed-list');
  const providers = getSubscribedProviders();

  list.innerHTML = providers.map((p, i) => `
    <div class="subscribed-item">
      <span class="subscribed-name">${escapeHtml(p.name)}</span>
      <button class="remove-btn" data-index="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const providers = getSubscribedProviders();
      providers.splice(parseInt(btn.dataset.index), 1);
      setSubscribedProviders(providers);
      renderSubscribedList();
    });
  });
}

async function onPlatformSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  const resultsEl = $('#platform-search-results');

  if (query.length < 2) { resultsEl.innerHTML = ''; return; }

  if (!allProvidersList) {
    try { allProvidersList = await fetchAllProviders(); }
    catch {
      resultsEl.innerHTML = '<div class="dropdown-message">Could not load providers</div>';
      return;
    }
  }

  const subscribedIds = getSubscribedProviderIds();
  const matches = Object.entries(allProvidersList)
    .filter(([id, p]) => p.name.toLowerCase().includes(query) && !subscribedIds.has(parseInt(id)))
    .slice(0, 8);

  if (!matches.length) {
    resultsEl.innerHTML = '<div class="platform-search-empty">No matching providers</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(([id, p]) => `
    <button class="platform-search-item" data-id="${id}" data-name="${escapeHtml(p.name)}" data-logo="${p.logoPath || ''}">
      ${p.logoPath ? `<img class="platform-search-logo" src="${getImageUrl(p.logoPath)}" alt="">` : ''}
      <span>${escapeHtml(p.name)}</span>
    </button>
  `).join('');

  resultsEl.querySelectorAll('.platform-search-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const providers = getSubscribedProviders();
      providers.push({ name: btn.dataset.name, ids: [parseInt(btn.dataset.id)], color: '#666666' });
      setSubscribedProviders(providers);
      renderSubscribedList();
      resultsEl.innerHTML = '';
      $('#platform-search').value = '';
    });
  });
}

// ---- Utilities ----

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', init);
