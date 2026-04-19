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
} from './tmdb.js';

// ---- State ----
let currentAbortController = null;
let debounceTimer = null;
let allProvidersList = null;
let currentTitle = null;

// Welcome page state
let welcomePosters = [];
let welcomePosterIndex = 0;
let welcomeCleanup = null;

// ---- DOM helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Initialization ----

async function init() {
  attachListeners();
  renderWelcomeState();

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

// Fetch trending movies and populate the poster stack
async function loadWelcomePosters() {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/trending/movie/week?api_key=${getApiKey()}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const posters = (data.results || [])
      .filter(m => m.poster_path)
      .slice(0, 9)
      .map(m => getImageUrl(m.poster_path, 'w500'));

    if (posters.length < 3) return;
    welcomePosters = posters;
    welcomePosterIndex = 0;
    updateWelcomePosterImages(false);
  } catch (e) {
    console.warn('Could not load trending posters:', e);
  }
}

// Assign poster srcs for the current index window, with optional fade transition
function updateWelcomePosterImages(animate) {
  const imgs = document.querySelectorAll('.poster-layer img');
  if (!imgs.length || welcomePosters.length < 3) return;

  const n = welcomePosters.length;
  const i = welcomePosterIndex;

  if (animate) {
    const layers = document.querySelectorAll('.poster-layer');
    layers.forEach(l => (l.style.opacity = '0'));
    setTimeout(() => {
      imgs[0].src = welcomePosters[i % n];
      imgs[1].src = welcomePosters[(i + 1) % n];
      imgs[2].src = welcomePosters[(i + 2) % n];
      layers.forEach(l => (l.style.opacity = ''));
    }, 260);
  } else {
    imgs[0].src = welcomePosters[i % n];
    imgs[1].src = welcomePosters[(i + 1) % n];
    imgs[2].src = welcomePosters[(i + 2) % n];
  }
}

// Wire spring-physics 3D tilt and drag-to-throw interactions
function setupWelcomeInteractions() {
  const state = document.getElementById('welcome-state');
  const stack = document.getElementById('poster-stack');
  if (!state || !stack) return;

  let destroyed = false; // set by cleanup to cancel any pending async work

  // ── Layer config ──────────────────────────────────────────────────────────
  //  base       : stacking offset
  //  springK    : tilt stiffness   (higher = snappier)
  //  damping    : energy loss      (lower  = more wobble)
  //  entryDelay : frames before entrance begins
  //  entry.axis : card slides in along 'x' or 'y'
  //  entry.start: initial off-screen offset (px)
  // ─────────────────────────────────────────────────────────────────────────
  const LAYERS = [
    { sel: '.poster-layer--back',  base: { x: -13, y: -18 }, springK: 0.095, damping: 0.5, entryDelay:  2, entry: { axis: 'x', start: -90 } },
    { sel: '.poster-layer--mid',   base: { x:   0, y:   0 }, springK: 0.075, damping: 0.5, entryDelay:  6, entry: { axis: 'x', start:  90 } },
    { sel: '.poster-layer--front', base: { x:  25, y:  35 }, springK: 0.55,  damping: 0.5, entryDelay: 10, entry: { axis: 'y', start:  90 } },
  ].map(cfg => ({
    ...cfg,
    el: document.querySelector(cfg.sel),
    rx: { pos: 0, vel: 0 },
    ry: { pos: 0, vel: 0 },
    eOff: { pos: cfg.entry.start, vel: 0 },
    entered: false,
  }));

  LAYERS.forEach(l => { if (l.el) l.el.style.opacity = '0'; });

  const FRONT = LAYERS[2];
  const MID   = LAYERS[1];
  const BACK  = LAYERS[0];

  const MAX_RX = 25, MAX_RY = 25;
  let targetRX = 0, targetRY = 0;
  let rafId = null, frame = 0;

  // ── Spring helper ─────────────────────────────────────────────────────────
  function springStep(axis, target, k, damp) {
    axis.vel += (target - axis.pos) * k;
    axis.vel *= damp;
    axis.pos += axis.vel;
  }

  // ── Drag / throw state machine ────────────────────────────────────────────
  //  mode: 'idle' | 'drag' | 'snap' | 'throw' | 'cycle'
  let mode = 'idle';
  let throwDir = 0;

  // Live drag position (offset from card base)
  const drag = { x: 0, y: 0, vx: 0, vy: 0 };
  // Snap-back springs
  const snap = { x: { pos: 0, vel: 0 }, y: { pos: 0, vel: 0 } };
  // Free-flight (throw) physics
  const fly  = { vx: 0, vy: 0, rotZ: 0, rotZVel: 0 };

  let dragStartX = 0;

  // Thresholds for triggering a throw vs snapping back
  const THROW_X_PX = 70;    // drag distance (px)
  const THROW_V_PX = 4;     // drag velocity (px/frame)

  // ── Interaction handlers ──────────────────────────────────────────────────
  function onDragStart(e) {
    if (mode !== 'idle') return;
    mode = 'drag';
    dragStartX = e.touches ? e.touches[0].clientX : e.clientX;
    drag.x = 0; drag.y = 0; drag.vx = 0; drag.vy = 0;
    stack.style.cursor = 'grabbing';
  }

  function onDragMove(e) {
    if (mode !== 'drag') return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const newX = cx - dragStartX;
    drag.vx = newX - drag.x;
    drag.x  = newX;
    drag.y  = Math.abs(drag.x) * 0.03; // subtle downward sag (paper weight)
  }

  function onDragEnd() {
    if (mode !== 'drag') return;
    stack.style.cursor = 'grab';

    if (Math.abs(drag.x) > THROW_X_PX || Math.abs(drag.vx) > THROW_V_PX) {
      // ── THROW ──────────────────────────────────────────────────────────
      throwDir = drag.x > 0 ? 1 : -1;
      mode = 'throw';
      // Carry release velocity; ensure minimum throw speed
      fly.vx     = Math.max(Math.abs(drag.vx), 10) * throwDir;
      fly.vy     = -1.5;                    // initial upward kick before gravity
      fly.rotZ   = drag.x * 0.05;          // start at current card lean
      fly.rotZVel = throwDir * 0.6;        // initial spin velocity
    } else {
      // ── SNAP BACK ──────────────────────────────────────────────────────
      mode = 'snap';
      snap.x.pos = drag.x; snap.x.vel = drag.vx;
      snap.y.pos = drag.y; snap.y.vel = 0;
    }
  }

  // ── rAF tick ──────────────────────────────────────────────────────────────
  function tick() {
    frame++;

    for (const layer of LAYERS) {
      if (!layer.el) continue;

      // ── Entry animation ──────────────────────────────────────────────────
      if (!layer.entered) {
        if (frame < layer.entryDelay) {
          const ex = layer.entry.axis === 'x' ? layer.base.x + layer.eOff.pos : layer.base.x;
          const ey = layer.entry.axis === 'y' ? layer.base.y + layer.eOff.pos : layer.base.y;
          layer.el.style.transform = `translate(${ex}px, ${ey}px)`;
          continue;
        }
        springStep(layer.eOff, 0, 0.12, 0.88);
        const absStart = Math.abs(layer.entry.start);
        const progress = (absStart - Math.abs(layer.eOff.pos)) / (absStart * 0.55);
        layer.el.style.opacity = Math.min(1, Math.max(0, progress)).toFixed(3);
        if (Math.abs(layer.eOff.pos) < 0.5 && Math.abs(layer.eOff.vel) < 0.15) {
          layer.eOff.pos = 0; layer.eOff.vel = 0;
          layer.entered = true; layer.el.style.opacity = '1';
        }
      }

      // ── Hover tilt — paused while front card is in motion ────────────────
      const tiltActive = (layer !== FRONT || mode === 'idle') && frame >= layer.entryDelay;
      if (tiltActive) {
        springStep(layer.rx, targetRX, layer.springK, layer.damping);
        springStep(layer.ry, targetRY, layer.springK, layer.damping);
      }

      // ── Front card: drag / throw / snap / cycle overrides ────────────────
      if (layer === FRONT) {

        if (mode === 'throw') {
          // Free-flight physics — paper thrown in the wind
          fly.vx     *= 0.97;              // air resistance
          fly.vy     += 0.12;              // gravity pulls card down
          drag.x     += fly.vx;
          drag.y     += fly.vy;
          fly.rotZVel += throwDir * 0.04;  // spin accelerates (frisbee effect)
          fly.rotZVel *= 0.99;             // rotational air resistance
          fly.rotZ   += fly.rotZVel;

          // Flutter: rotateX oscillates with spin angle (like paper waving)
          const rotX = Math.sin(fly.rotZ * 0.08) * 5;
          const rotY = drag.x * 0.015;

          // Fade starts after 120 px off-center, completes over 500 px
          const opac = Math.max(0, 1 - Math.max(0, Math.abs(drag.x) - 120) / 500);

          layer.el.style.opacity = opac.toFixed(3);
          layer.el.style.transform = `
            translate(${FRONT.base.x + drag.x}px, ${FRONT.base.y + drag.y}px)
            rotateZ(${fly.rotZ}deg)
            rotateX(${rotX}deg)
            rotateY(${rotY}deg)
          `;

          // Once off-screen, cycle to next poster
          if (Math.abs(drag.x) > 900 && mode === 'throw') {
            mode = 'cycle';
            completeFrontThrow();
          }
          continue;
        }

        if (mode === 'drag') {
          // Cloth-like deformation:
          //   rotateZ  — card leans in drag direction (like tipping a domino)
          //   rotateY  — 3D perspective fold (paper bending at its axis)
          //   skewX    — velocity-based stretch (the key fabric feel)
          //   lift     — card floats up as it's peeled away
          const rotZ  = drag.x  * 0.05;
          const rotY  = drag.x  * 0.025;
          const skewX = -drag.vx * 0.30;
          const lift  = -Math.abs(drag.x) * 0.04;

          layer.el.style.transform = `
            translate(${FRONT.base.x + drag.x}px, ${FRONT.base.y + drag.y + lift}px)
            rotateZ(${rotZ}deg)
            rotateY(${rotY}deg)
            skewX(${skewX}deg)
          `;
          continue;
        }

        if (mode === 'snap') {
          // Spring back to base position with same cloth deformation
          springStep(snap.x, 0, 0.15, 0.65);
          springStep(snap.y, 0, 0.15, 0.65);

          const rotZ  = snap.x.pos * 0.05;
          const rotY  = snap.x.pos * 0.025;
          const skewX = -snap.x.vel * 0.30;

          layer.el.style.transform = `
            translate(${FRONT.base.x + snap.x.pos}px, ${FRONT.base.y + snap.y.pos}px)
            rotateZ(${rotZ}deg)
            rotateY(${rotY}deg)
            skewX(${skewX}deg)
          `;

          if (Math.abs(snap.x.pos) < 0.3 && Math.abs(snap.x.vel) < 0.05) {
            snap.x.pos = 0; snap.x.vel = 0;
            snap.y.pos = 0; snap.y.vel = 0;
            mode = 'idle';
          }
          continue;
        }

        if (mode === 'cycle') continue; // card hidden — skip all updates
      }

      // ── Mid card: subtle counter-shift during drag / snap ─────────────────
      let extraX = 0;
      if (layer === MID) {
        const dx = mode === 'drag' ? drag.x : (mode === 'snap' ? snap.x.pos : 0);
        extraX = -dx * 0.04; // lean away from drag direction
      }

      // ── Default: entry offset + hover tilt transform ──────────────────────
      const entryX = layer.entry.axis === 'x' ? layer.eOff.pos : 0;
      const entryY = layer.entry.axis === 'y' ? layer.eOff.pos : 0;
      layer.el.style.transform = `
        translate(${layer.base.x + entryX + extraX}px, ${layer.base.y + entryY}px)
        rotateX(${layer.rx.pos}deg)
        rotateY(${layer.ry.pos}deg)
      `;
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  // ── Complete throw: cycle poster images, re-enter front card ─────────────
  function completeFrontThrow() {
    const n = welcomePosters.length;
    if (!n) { mode = 'idle'; return; }

    // Cycle index in throw direction
    welcomePosterIndex = throwDir > 0
      ? (welcomePosterIndex + 1) % n
      : (welcomePosterIndex - 1 + n) % n;

    // Briefly dim mid+back while their images swap
    [MID.el, BACK.el].forEach(el => {
      el.style.transition = 'opacity 0.18s ease';
      el.style.opacity    = '0.5';
    });

    setTimeout(() => {
      if (destroyed) return;
      updateWelcomePosterImages(false);

      // Restore mid + back
      [MID.el, BACK.el].forEach(el => {
        el.style.opacity = '1';
        setTimeout(() => { if (!destroyed) el.style.transition = ''; }, 200);
      });

      // Reset front card: hide, snap to base, kick off its entry spring
      FRONT.el.style.transition = 'none';
      FRONT.el.style.opacity    = '0';
      FRONT.el.style.transform  = `translate(${FRONT.base.x}px, ${FRONT.base.y}px)`;

      // Reset all physics
      drag.x = 0; drag.y = 0; drag.vx = 0; drag.vy = 0;
      fly.vx = 0; fly.vy = 0; fly.rotZ = 0; fly.rotZVel = 0;
      FRONT.rx.pos = 0; FRONT.rx.vel = 0;
      FRONT.ry.pos = 0; FRONT.ry.vel = 0;

      // Restart entry spring from bottom (same as initial page load)
      FRONT.entered  = false;
      FRONT.eOff.pos = FRONT.entry.start; // 90 (from below)
      FRONT.eOff.vel = 0;

      mode = 'idle';
    }, 80);
  }

  // ── Mouse / touch event handlers ──────────────────────────────────────────
  function onMouseMove(e) {
    if (mode !== 'idle') return;
    const rect = state.getBoundingClientRect();
    const nx = (e.clientX - rect.left  - rect.width  / 2) / (rect.width  / 2);
    const ny = (e.clientY - rect.top   - rect.height / 2) / (rect.height / 2);
    targetRX = -ny * MAX_RX;
    targetRY =  nx * MAX_RY;
  }
  function onMouseLeave() { if (mode === 'idle') { targetRX = 0; targetRY = 0; } }

  // Window-level: handles both drag-move AND hover tilt (one listener)
  function onWindowMouseMove(e) {
    if (mode === 'drag') onDragMove(e);
    else onMouseMove(e);
  }

  FRONT.el.addEventListener('mousedown',  onDragStart);
  FRONT.el.addEventListener('touchstart', onDragStart, { passive: true });
  window.addEventListener('mousemove',    onWindowMouseMove);
  window.addEventListener('touchmove',    onDragMove,  { passive: true });
  window.addEventListener('mouseup',      onDragEnd);
  window.addEventListener('touchend',     onDragEnd);
  state.addEventListener('mouseleave',    onMouseLeave);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  welcomeCleanup = () => {
    destroyed = true;
    cancelAnimationFrame(rafId);
    FRONT.el.removeEventListener('mousedown',  onDragStart);
    FRONT.el.removeEventListener('touchstart', onDragStart);
    window.removeEventListener('mousemove',    onWindowMouseMove);
    window.removeEventListener('touchmove',    onDragMove);
    window.removeEventListener('mouseup',      onDragEnd);
    window.removeEventListener('touchend',     onDragEnd);
    state.removeEventListener('mouseleave',    onMouseLeave);
  };
}

function attachListeners() {
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', onSearchKeydown);

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const dropdown = $('#search-dropdown');
    const searchSection = $('.header-search-section');
    if (dropdown && searchSection && !searchSection.contains(e.target)) {
      dropdown.classList.add('hidden');
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
    const results = await searchMulti(query, currentAbortController.signal);
    if (results.length === 0) showDropdownEmpty(query);
    else renderDropdown(results);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Search error:', err);
    showDropdownError();
  }
}

function renderDropdown(results) {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = results.map((r, i) => `
    <button class="dropdown-item" data-index="${i}" data-id="${r.id}" data-type="${r.type}">
      <img class="dropdown-poster"
           src="${getImageUrl(r.posterPath, 'w92') || ''}"
           alt=""
           onerror="this.style.display='none'">
      <div class="dropdown-info">
        <span class="dropdown-title">${escapeHtml(r.title)}</span>
        <span class="dropdown-meta">
          <span class="badge badge-${r.type}">${r.type === 'movie' ? 'Movie' : 'TV'}</span>
          ${r.year ? `<span class="dropdown-year">${r.year}</span>` : ''}
        </span>
      </div>
    </button>
  `).join('');

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
    hideDropdown();
  }
}

// ---- Title Selection & Availability ----

async function selectResult(result) {
  if (welcomeCleanup) { welcomeCleanup(); welcomeCleanup = null; }
  hideDropdown();
  currentTitle = result;
  $('#search-input').value = result.title;
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

    renderResultsLayout(platformData, title, posterPath, year, mediaType, runtime);
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

function renderResultsLayout(platformData, title, posterPath, year, mediaType, runtime = null) {
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

    const dotClass = hasCountries ? 'availability-dot--on' : 'availability-dot--off';
    const rowClass = hasCountries ? 'platform-row--available' : 'platform-row--unavailable';

    // Country grid cells
    const countryGridHtml = hasCountries
      ? data.countries.map(code =>
          `<span class="country-cell" title="${getCountryName(code)}">${countryFlag(code)} ${code}</span>`
        ).join('')
      : '';

    rowsHtml += `
      <div class="platform-row ${rowClass}">
        <button class="platform-row__header" ${!hasCountries ? 'disabled' : ''}>
          <span class="pr-cell pr-cell--dot">
            <span class="availability-dot ${dotClass}"></span>
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
          <p class="empty-results-hint">It may be available to rent or purchase, or on other platforms not tracked here.</p>
        ` : ''}
      </div>

    </div>
  `;

  // Scale title to fit within max-height 340px
  fitTitleText();

  // Accordion toggle for available rows
  area.querySelectorAll('.platform-row--available .platform-row__header').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.platform-row');
      const isOpen = row.classList.contains('open');
      area.querySelectorAll('.platform-row.open').forEach(r => r.classList.remove('open'));
      if (!isOpen) row.classList.add('open');
    });
  });
}

// ---- Hash Routing ----

async function handleHashRoute() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

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
