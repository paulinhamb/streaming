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

// ---- DOM helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Initialization ----

async function init() {
  attachListeners();
  renderWelcomeState();

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
  $('#content-area').innerHTML = `
    <div class="welcome-state">
      <div class="hero-text-col">
        <h1 class="hero-heading">FIND YOUR<br>NEXT WATCH</h1>
        <p class="hero-sub">Search for any movie or series to see<br>which countries have it on your streaming platforms.</p>
      </div>
      <div class="hero-visual-col">
        <img class="hero-poster" src="assets/new_poster_initial.webp" alt="" draggable="false">
      </div>
    </div>
  `;
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
