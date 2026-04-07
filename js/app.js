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
  getViewMode,
  setViewMode,
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
  transformToCountryView,
} from './tmdb.js';

// ---- State ----
let currentAbortController = null;
let debounceTimer = null;
let allProvidersList = null; // full TMDB provider list (for settings search)
let currentTitle = null; // currently displayed title info

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Initialization ----

async function init() {
  // Attach event listeners
  attachListeners();

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

  // View toggle
  $('#view-toggle').addEventListener('click', toggleView);

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

  await loadAvailability(result.id, result.type, result.title, result.posterPath);
}

async function loadAvailability(id, mediaType, title, posterPath) {
  const main = $('#results');
  main.innerHTML = `
    <div class="loading-state">
      <div class="spinner-large"></div>
      <p>Checking availability across all countries...</p>
    </div>
  `;
  $('#view-toggle').classList.add('hidden');

  try {
    const results = await getWatchProviders(id, mediaType);
    const subscribedIds = getSubscribedProviderIds();
    const idToNameMap = getProviderIdToNameMap();

    const platformData = transformToPlatformView(results, subscribedIds, idToNameMap);
    const countryData = transformToCountryView(results, subscribedIds, idToNameMap);

    const hasPlatformResults = Object.keys(platformData).length > 0;

    if (!hasPlatformResults) {
      renderNoResults(title);
      return;
    }

    // Show view toggle
    $('#view-toggle').classList.remove('hidden');

    // Store data for view switching
    main.dataset.platformJson = JSON.stringify(platformData);
    main.dataset.countryJson = JSON.stringify(countryData);
    main.dataset.title = title;
    main.dataset.posterPath = posterPath || '';

    // Render current view
    const viewMode = getViewMode();
    updateViewToggleButton(viewMode);
    if (viewMode === 'country') {
      renderCountryView(countryData, platformData, title, posterPath);
    } else {
      renderPlatformView(platformData, title, posterPath);
    }
  } catch (err) {
    console.error('Availability error:', err);
    main.innerHTML = `
      <div class="empty-state">
        <p class="error-text">Failed to load availability data. Please try again.</p>
      </div>
    `;
  }
}

function renderPlatformView(platformData, title, posterPath) {
  const main = $('#results');
  const subscribedProviders = getSubscribedProviders();

  // Build header
  let html = `
    <div class="result-header">
      ${posterPath ? `<img class="result-poster" src="${getImageUrl(posterPath, 'w185')}" alt="">` : ''}
      <div>
        <h2 class="result-title">${escapeHtml(title)}</h2>
        <p class="result-subtitle">Streaming availability on your platforms</p>
      </div>
    </div>
    <div class="platform-cards">
  `;

  // Render a card for each subscribed platform
  for (const provider of subscribedProviders) {
    const data = platformData[provider.name];
    const hasCountries = data && data.countries.length > 0;

    html += `
      <div class="platform-card ${hasCountries ? '' : 'platform-card--empty'}">
        <div class="platform-card__header">
          ${data?.logo ? `<img class="platform-logo" src="${getImageUrl(data.logo)}" alt="">` : ''}
          <h3 class="platform-name">${escapeHtml(provider.name)}</h3>
          ${hasCountries ? `<span class="country-count">${data.countries.length} ${data.countries.length === 1 ? 'country' : 'countries'}</span>` : ''}
        </div>
        <div class="platform-card__body">
          ${
            hasCountries
              ? `<div class="country-pills">${data.countries
                  .map(
                    (code) =>
                      `<span class="country-pill" title="${getCountryName(code)}">${countryFlag(code)} ${code}</span>`
                  )
                  .join('')}</div>`
              : `<p class="platform-empty-text">Not available with subscription</p>`
          }
        </div>
      </div>
    `;
  }

  html += '</div>';
  main.innerHTML = html;
}

function renderCountryView(countryData, platformData, title, posterPath) {
  const main = $('#results');
  const subscribedProviders = getSubscribedProviders();

  // Sort countries by number of platforms (most first), then alphabetically
  const sortedCountries = Object.entries(countryData)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  // Collect all platform logos from platformData
  const platformLogos = {};
  for (const [name, data] of Object.entries(platformData)) {
    platformLogos[name] = data.logo;
  }

  let html = `
    <div class="result-header">
      ${posterPath ? `<img class="result-poster" src="${getImageUrl(posterPath, 'w185')}" alt="">` : ''}
      <div>
        <h2 class="result-title">${escapeHtml(title)}</h2>
        <p class="result-subtitle">Available in ${sortedCountries.length} ${sortedCountries.length === 1 ? 'country' : 'countries'}</p>
      </div>
    </div>
    <div class="country-table-wrapper">
      <table class="country-table">
        <thead>
          <tr>
            <th class="country-table__country-col">Country</th>
            ${subscribedProviders
              .map(
                (p) =>
                  `<th class="country-table__platform-col">
                    ${platformLogos[p.name] ? `<img class="table-platform-logo" src="${getImageUrl(platformLogos[p.name])}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}">` : `<span title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`}
                  </th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody>
          ${sortedCountries
            .map(
              ([code, platforms]) => `
            <tr>
              <td class="country-cell">${countryFlag(code)} ${getCountryName(code)}</td>
              ${subscribedProviders
                .map(
                  (p) =>
                    `<td class="availability-cell">${platforms.includes(p.name) ? '<span class="check">&#10003;</span>' : '<span class="dash">&mdash;</span>'}</td>`
                )
                .join('')}
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  main.innerHTML = html;
}

function renderNoResults(title) {
  const main = $('#results');
  main.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">&#128566;</div>
      <h3>Not available</h3>
      <p>"${escapeHtml(title)}" is not included with any of your streaming subscriptions in any country.</p>
      <p class="empty-hint">It may be available for rent or purchase, or on other platforms.</p>
    </div>
  `;
}

// ---- View Toggle ----

function toggleView() {
  const main = $('#results');
  const current = getViewMode();
  const next = current === 'platform' ? 'country' : 'platform';
  setViewMode(next);
  updateViewToggleButton(next);

  // Re-render with stored data
  const platformData = JSON.parse(main.dataset.platformJson || '{}');
  const countryData = JSON.parse(main.dataset.countryJson || '{}');
  const title = main.dataset.title || '';
  const posterPath = main.dataset.posterPath || '';

  if (next === 'country') {
    renderCountryView(countryData, platformData, title, posterPath);
  } else {
    renderPlatformView(platformData, title, posterPath);
  }
}

function updateViewToggleButton(mode) {
  const btn = $('#view-toggle');
  btn.textContent = mode === 'platform' ? 'Switch to Country View' : 'Switch to Platform View';
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

    $('#search-input').value = title || '';
    await loadAvailability(parseInt(id), mediaType, title || 'Unknown', posterPath);
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
