// ============================================================
// app.js — Main application logic for StreamFinder
// ============================================================

import {
  hasApiKey,
  setApiKey,
  getSubscribedProviders,
  setSubscribedProviders,
  getSubscribedProviderIds,
  getProviderIdToNameMap,
  getCountryName,
  countryFlag,
  DEFAULT_PROVIDERS,
  resetProviders,
} from './config.js';

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
let allProvidersList = null; // full TMDB provider list (for settings search)
let currentTitle = null; // currently displayed title info
let cachedTheaterImage = null; // theater PNG loaded once and reused

// ---- Theater Canvas ----

// Screen cutout coordinates within the 1350×1912 theater PNG
// Screen corners of the poster area inside the theater frame.
// Tweak live in the browser console, then call redraw():
//   CORNERS[0] = top-left   CORNERS[1] = top-right
//   CORNERS[2] = bottom-right  CORNERS[3] = bottom-left
// Example: CORNERS[1].y = 80; redraw()
const CORNERS = [
  { x: 170, y: 100  },  // top-left
  { x: 1120, y: 100 },  // top-right
  { x: 1120, y: 1700 }, // bottom-right
  { x: 170,  y: 1700 }, // bottom-left
];
window.CORNERS = CORNERS;

function loadImageEl(src, crossOrigin = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function getTheaterImage() {
  if (cachedTheaterImage) return cachedTheaterImage;
  cachedTheaterImage = await loadImageEl('assets/new_poster_transparent.webp');
  return cachedTheaterImage;
}

// Returns source rect for object-fit:cover, top-biased (shows faces)
function coverSourceRect(img, destW, destH) {
  const imgAR = img.naturalWidth / img.naturalHeight;
  const destAR = destW / destH;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (imgAR > destAR) {
    sw = img.naturalHeight * destAR;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / destAR;
    sy = 0;
  }
  return { sx, sy, sw, sh };
}

// Core drawing function — clips poster to CORNERS polygon, then overlays theater frame
async function drawToCanvas(canvasId, imageSrc, crossOrigin = true) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.dataset.posterSrc = imageSrc;
  const ctx = canvas.getContext('2d');
  try {
    const [theaterImg, posterImg] = await Promise.all([
      getTheaterImage(),
      loadImageEl(imageSrc, crossOrigin),
    ]);
    canvas.width  = theaterImg.naturalWidth;
    canvas.height = theaterImg.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Clip to the quadrilateral screen area
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(CORNERS[0].x, CORNERS[0].y);
    ctx.lineTo(CORNERS[1].x, CORNERS[1].y);
    ctx.lineTo(CORNERS[2].x, CORNERS[2].y);
    ctx.lineTo(CORNERS[3].x, CORNERS[3].y);
    ctx.closePath();
    ctx.clip();

    // Draw poster scaled to cover the bounding box of the clip region
    const xs = CORNERS.map(c => c.x);
    const ys = CORNERS.map(c => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const bw = maxX - minX, bh = maxY - minY;
    const { sx, sy, sw, sh } = coverSourceRect(posterImg, bw, bh);
    ctx.drawImage(posterImg, sx, sy, sw, sh, minX, minY, bw, bh);

    ctx.restore();

    // Overlay the theater frame (transparent PNG) on top
    ctx.drawImage(theaterImg, 0, 0, canvas.width, canvas.height);
  } catch (err) {
    console.warn(`Canvas draw error on #${canvasId}:`, err);
  }
}

// Draw movie poster into theater canvases
async function drawTheaterCanvas(posterSrc) {
  return drawToCanvas('theater-canvas', posterSrc, true);
}

// Draw default "coming soon" image — displayed as-is, no theater overlay
async function drawDefaultCanvas(canvasId = 'theater-canvas') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.dataset.posterSrc = '';
  const ctx = canvas.getContext('2d');
  try {
    const img = await loadImageEl('assets/new_poster_initial.webp');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  } catch (err) {
    console.warn('Default canvas error:', err);
  }
}

// ---- Mobile state ----

function setHasResults(title, type, year) {
  document.querySelector('.app').classList.add('has-results');
  const titleEl = $('#mobile-movie-title');
  const metaEl  = $('#mobile-movie-meta');
  if (titleEl) titleEl.textContent = title;
  if (metaEl)  metaEl.textContent  = `${type === 'movie' ? 'Movie' : 'Series'}${year ? ' · ' + year : ''}`;
}

function clearHasResults() {
  document.querySelector('.app').classList.remove('has-results');
}

// ---- Dev helper: call redraw() in console after tweaking window.CORNERS ----
window.redraw = function(url) {
  const src = url
    || document.getElementById('theater-canvas')?.dataset.posterSrc
    || 'https://picsum.photos/seed/poster/342/513';
  drawToCanvas('theater-canvas', src, true);
  drawToCanvas('mobile-theater-canvas', src, true);
  console.log('CORNERS:', JSON.stringify(window.CORNERS));
};

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Initialization ----

async function init() {
  // Attach event listeners
  attachListeners();

  // Draw the default "coming soon" image immediately
  drawDefaultCanvas();
  clearHasResults();

  // Check API key
  if (!hasApiKey()) {
    showSettings();
    return;
  }

  // Fetch provider list in background
  try {
    allProvidersList = await fetchAllProviders();
  } catch (e) {
    console.warn('Failed to fetch provider list:', e);
  }

  // Check for hash-based deep link
  handleHashRoute();
}

function attachListeners() {
  // Search input
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', onSearchKeydown);

  // Click outside dropdown to close
  document.addEventListener('click', (e) => {
    const dropdown = $('#search-dropdown');
    const searchBox = $('.search-box');
    if (dropdown && !searchBox.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  // Settings
  $('#settings-btn').addEventListener('click', showSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-reset').addEventListener('click', resetToDefaults);

  // Hash change
  window.addEventListener('hashchange', handleHashRoute);

  // Platform search in settings
  const platformSearch = $('#platform-search');
  if (platformSearch) {
    platformSearch.addEventListener('input', onPlatformSearch);
  }
}

// ---- Search ----

function onSearchInput(e) {
  const query = e.target.value;

  if (debounceTimer) clearTimeout(debounceTimer);
  if (currentAbortController) currentAbortController.abort();

  if (query.length < 2) {
    hideDropdown();
    return;
  }

  debounceTimer = setTimeout(() => performSearch(query), 300);
}

async function performSearch(query) {
  currentAbortController = new AbortController();

  try {
    showDropdownLoading();
    const results = await searchMulti(query, currentAbortController.signal);

    if (results.length === 0) {
      showDropdownEmpty(query);
    } else {
      renderDropdown(results);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Search error:', err);
    showDropdownError();
  }
}

function renderDropdown(results) {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = results
    .map(
      (r, i) => `
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
  `
    )
    .join('');

  dropdown.classList.remove('hidden');

  // Attach click listeners
  dropdown.querySelectorAll('.dropdown-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      selectResult(results[idx]);
    });
  });
}

function showDropdownLoading() {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = '<div class="dropdown-message"><div class="spinner"></div> Searching...</div>';
  dropdown.classList.remove('hidden');
}

function showDropdownEmpty(query) {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = `<div class="dropdown-message">No results for "${escapeHtml(query)}"</div>`;
  dropdown.classList.remove('hidden');
}

function showDropdownError() {
  const dropdown = $('#search-dropdown');
  dropdown.innerHTML = '<div class="dropdown-message dropdown-error">Search failed. Check your API key.</div>';
  dropdown.classList.remove('hidden');
}

function hideDropdown() {
  const dropdown = $('#search-dropdown');
  dropdown.classList.add('hidden');
  dropdown.innerHTML = '';
}

// ---- Keyboard navigation in dropdown ----

function onSearchKeydown(e) {
  const dropdown = $('#search-dropdown');
  if (dropdown.classList.contains('hidden')) return;

  const items = dropdown.querySelectorAll('.dropdown-item');
  if (items.length === 0) return;

  const active = dropdown.querySelector('.dropdown-item.active');
  let idx = active ? [...items].indexOf(active) : -1;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
    items.forEach((el) => el.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
    items.forEach((el) => el.classList.remove('active'));
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
  hideDropdown();
  currentTitle = result;
  $('#search-input').value = result.title;

  // Update URL hash
  window.location.hash = `${result.type}/${result.id}`;

  // Draw poster into both canvases
  if (result.posterPath) {
    const src = getImageUrl(result.posterPath, 'w500');
    drawTheaterCanvas(src);
    drawToCanvas('mobile-theater-canvas', src, true);
  }

  await loadAvailability(result.id, result.type, result.title, result.posterPath, result.year);
}

async function loadAvailability(id, mediaType, title, posterPath, year = '') {
  const main = $('#results');
  main.innerHTML = `
    <div class="loading-state">
      <div class="spinner-large"></div>
      <p>Checking availability across all countries...</p>
    </div>
  `;

  // Draw poster into canvases (hash route or direct call)
  if (posterPath) {
    const src = getImageUrl(posterPath, 'w500');
    drawTheaterCanvas(src);
    drawToCanvas('mobile-theater-canvas', src, true);
  }

  // Set mobile results state
  setHasResults(title, mediaType, year);

  try {
    const results = await getWatchProviders(id, mediaType);
    const subscribedIds = getSubscribedProviderIds();
    const idToNameMap = getProviderIdToNameMap();

    const platformData = transformToPlatformView(results, subscribedIds, idToNameMap);

    if (Object.keys(platformData).length === 0) {
      renderNoResults(title);
      return;
    }

    renderPlatformView(platformData, title, posterPath);
  } catch (err) {
    console.error('Availability error:', err);
    main.innerHTML = `
      <div class="empty-state">
        <p class="error-text">Failed to load availability data. Please try again.</p>
      </div>
    `;
  }
}

const CHEVRON_SVG = `<svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M3.5 5.5L8 10L12.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function renderPlatformView(platformData, title, posterPath) {
  const main = $('#results');
  const subscribedProviders = getSubscribedProviders();

  let html = `
    <div class="result-header">
      <h2 class="result-title">${escapeHtml(title)}</h2>
      <p class="result-subtitle">Streaming availability on your platforms</p>
    </div>
    <div class="platform-cards">
  `;

  for (const provider of subscribedProviders) {
    const data = platformData[provider.name];
    const hasCountries = data && data.countries.length > 0;
    const countLabel = hasCountries
      ? `${data.countries.length} ${data.countries.length === 1 ? 'country' : 'countries'}`
      : '—';

    html += `
      <div class="platform-card ${hasCountries ? '' : 'platform-card--empty'}">
        <button class="platform-card__header">
          ${data?.logo ? `<img class="platform-logo" src="${getImageUrl(data.logo)}" alt="">` : '<div class="platform-logo" style="background:var(--pill-bg)"></div>'}
          <span class="platform-name">${escapeHtml(provider.name)}</span>
          <span class="country-count">${countLabel}</span>
          ${CHEVRON_SVG}
        </button>
        <div class="platform-card__body">
          ${
            hasCountries
              ? `<div class="country-pills">${data.countries
                  .map(code => `<span class="country-pill" title="${getCountryName(code)}">${countryFlag(code)} ${code}</span>`)
                  .join('')}</div>`
              : `<p class="platform-empty-text">Not available with subscription</p>`
          }
        </div>
      </div>
    `;
  }

  html += '</div>';
  main.innerHTML = html;

  // Accordion toggle — only one card open at a time
  main.querySelectorAll('.platform-card__header').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.platform-card');
      const isOpen = card.classList.contains('open');
      main.querySelectorAll('.platform-card.open').forEach(c => c.classList.remove('open'));
      if (!isOpen) card.classList.add('open');
    });
  });
}

function renderNoResults(title) {
  const main = $('#results');
  main.innerHTML = `
    <div class="empty-state">
      <p>"${escapeHtml(title)}" is not included with any of your streaming subscriptions in any country.</p>
      <p class="empty-hint">It may be available for rent or purchase, or on other platforms.</p>
    </div>
  `;
}

// ---- Hash Routing ----

async function handleHashRoute() {
  const hash = window.location.hash.slice(1); // remove #
  if (!hash) return;

  const match = hash.match(/^(movie|tv)\/(\d+)$/);
  if (!match) return;

  const [, mediaType, id] = match;

  if (!hasApiKey()) return;

  // We need to fetch title info first
  try {
    const data = await (await fetch(
      `${new URL(`https://api.themoviedb.org/3/${mediaType}/${id}`)}?api_key=${(await import('./config.js')).getApiKey()}`
    )).json();

    const title = mediaType === 'movie' ? data.title : data.name;
    const posterPath = data.poster_path;
    const year = (mediaType === 'movie' ? data.release_date : data.first_air_date)?.split('-')[0] || '';

    $('#search-input').value = title || '';
    await loadAvailability(parseInt(id), mediaType, title || 'Unknown', posterPath, year);
  } catch (e) {
    console.error('Hash route error:', e);
  }
}

// ---- Settings ----

function showSettings() {
  const dialog = $('#settings-modal');
  const apiKeyInput = $('#api-key-input');
  const subscribedList = $('#subscribed-list');

  // Populate API key field
  apiKeyInput.value = (hasApiKey() && getApiKey) ? '••••••••' : '';
  apiKeyInput.placeholder = 'Enter your TMDB API key (v3 auth)';

  // Populate subscribed platforms
  renderSubscribedList();

  dialog.showModal();
}

function closeSettings() {
  $('#settings-modal').close();
}

async function saveSettings() {
  const apiKeyInput = $('#api-key-input');
  const statusEl = $('#settings-status');
  const key = apiKeyInput.value.trim();

  // Only update API key if user typed a new one (not the masked dots)
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

    // Refresh provider list
    try {
      allProvidersList = await fetchAllProviders();
    } catch (e) {
      console.warn('Failed to fetch providers:', e);
    }
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

  list.innerHTML = providers
    .map(
      (p, i) => `
    <div class="subscribed-item">
      <span class="subscribed-name">${escapeHtml(p.name)}</span>
      <button class="remove-btn" data-index="${i}" title="Remove">&times;</button>
    </div>
  `
    )
    .join('');

  // Attach remove listeners
  list.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      const providers = getSubscribedProviders();
      providers.splice(idx, 1);
      setSubscribedProviders(providers);
      renderSubscribedList();
    });
  });
}

async function onPlatformSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  const resultsEl = $('#platform-search-results');

  if (query.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }

  // Ensure we have the provider list
  if (!allProvidersList) {
    try {
      allProvidersList = await fetchAllProviders();
    } catch {
      resultsEl.innerHTML = '<div class="dropdown-message">Could not load providers</div>';
      return;
    }
  }

  const subscribedIds = getSubscribedProviderIds();

  // Filter providers matching query, exclude already subscribed
  const matches = Object.entries(allProvidersList)
    .filter(
      ([id, p]) =>
        p.name.toLowerCase().includes(query) && !subscribedIds.has(parseInt(id))
    )
    .slice(0, 8);

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div class="platform-search-empty">No matching providers</div>';
    return;
  }

  resultsEl.innerHTML = matches
    .map(
      ([id, p]) => `
    <button class="platform-search-item" data-id="${id}" data-name="${escapeHtml(p.name)}" data-logo="${p.logoPath || ''}">
      ${p.logoPath ? `<img class="platform-search-logo" src="${getImageUrl(p.logoPath)}" alt="">` : ''}
      <span>${escapeHtml(p.name)}</span>
    </button>
  `
    )
    .join('');

  // Attach add listeners
  resultsEl.querySelectorAll('.platform-search-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const providers = getSubscribedProviders();
      providers.push({
        name: btn.dataset.name,
        ids: [parseInt(btn.dataset.id)],
        color: '#666666',
      });
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
