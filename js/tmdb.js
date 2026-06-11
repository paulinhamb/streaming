// ============================================================
// tmdb.js — TMDB API wrapper for StreamFinder
// ============================================================

import {
  TMDB_API_BASE,
  TMDB_IMAGE_BASE,
  getApiKey,
  getCachedProviderList,
  setCachedProviderList,
} from './config.js?v=3';

// --- Helpers ---

function apiUrl(path, params = {}) {
  const key = getApiKey();
  const url = new URL(`${TMDB_API_BASE}${path}`);
  url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB API error ${res.status}: ${body}`);
  }
  return res.json();
}

// --- Public API ---

/**
 * Search for movies and TV shows.
 * Returns normalized array: [{ id, title, year, type, posterPath }]
 */
async function searchMulti(query, signal) {
  if (!query || query.trim().length < 2) return [];

  const data = await fetchJson(
    apiUrl('/search/multi', {
      query: query.trim(),
      include_adult: 'false',
      page: '1',
    }),
    signal
  );

  return data.results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => ({
      id: r.id,
      title: r.media_type === 'movie' ? r.title : r.name,
      year: extractYear(r),
      type: r.media_type,
      posterPath: r.poster_path,
      overview: r.overview || '',
    }))
    .slice(0, 10); // limit to top 10 results
}

function extractYear(item) {
  const date = item.release_date || item.first_air_date || '';
  return date ? date.substring(0, 4) : '';
}

/**
 * Get watch providers for a title across ALL countries.
 * Returns the raw `results` object keyed by country code.
 * Each country has: { flatrate: [...], rent: [...], buy: [...], link }
 */
async function getWatchProviders(id, mediaType) {
  const data = await fetchJson(
    apiUrl(`/${mediaType}/${id}/watch/providers`)
  );
  return data.results || {};
}

/**
 * Get TMDB's "recommendations" for a title (behaviour-based).
 * Returns the raw results array (each item: id, title/name, poster_path,
 * genre_ids, popularity, release_date/first_air_date, ...).
 */
async function getTitleRecommendations(id, mediaType, signal) {
  const data = await fetchJson(apiUrl(`/${mediaType}/${id}/recommendations`), signal);
  return data.results || [];
}

/**
 * Get TMDB's "similar" titles (keyword/genre-based) — used as a fallback
 * when /recommendations is sparse.
 */
async function getSimilarTitles(id, mediaType, signal) {
  const data = await fetchJson(apiUrl(`/${mediaType}/${id}/similar`), signal);
  return data.results || [];
}

/**
 * Get a title's detail (poster, title, dates, genres) — used to enrich
 * recommendation items that arrive without a poster (e.g. from Trakt).
 */
async function getTitleDetail(id, mediaType, signal) {
  return fetchJson(apiUrl(`/${mediaType}/${id}`), signal);
}

/**
 * Fetch the full list of streaming providers from TMDB.
 * Uses localStorage cache with 7-day TTL.
 * Returns: { providerId: { name, logoPath } }
 */
async function fetchAllProviders() {
  // Check cache first
  const cached = getCachedProviderList();
  if (cached) return cached;

  const data = await fetchJson(
    apiUrl('/watch/providers/movie')
  );

  const map = {};
  for (const provider of data.results || []) {
    map[provider.provider_id] = {
      name: provider.provider_name,
      logoPath: provider.logo_path,
    };
  }

  setCachedProviderList(map);
  return map;
}

/**
 * Validate the API key by making a lightweight request.
 * Returns true if valid, false otherwise.
 */
async function validateApiKey() {
  try {
    await fetchJson(apiUrl('/configuration'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a full image URL from a TMDB image path.
 * @param {string} path - e.g. "/abc123.jpg"
 * @param {string} size - e.g. "w92", "w185", "w342", "original"
 */
function getImageUrl(path, size = 'w92') {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

// --- Data Transformation ---

/**
 * Transform TMDB watch provider response into platform-grouped view.
 *
 * Input: { "US": { flatrate: [{ provider_id, provider_name, logo_path }], ... }, ... }
 * Output: { "Disney+": { logo, countries: ["US", "BR", "GB"] }, ... }
 *
 * @param {Object} results - Raw TMDB watch providers results (country-keyed)
 * @param {Set} subscribedIds - Set of subscribed provider IDs
 * @param {Object} idToNameMap - Map of provider ID to platform display name
 */
function transformToPlatformView(results, subscribedIds, idToNameMap) {
  const platformMap = {}; // platformName -> { logo, countries: [] }

  for (const [countryCode, countryData] of Object.entries(results)) {
    const flatrate = countryData.flatrate || [];
    for (const provider of flatrate) {
      if (subscribedIds.has(provider.provider_id)) {
        const platformName = idToNameMap[provider.provider_id] || provider.provider_name;
        if (!platformMap[platformName]) {
          platformMap[platformName] = {
            logo: provider.logo_path,
            countries: [],
          };
        }
        if (!platformMap[platformName].countries.includes(countryCode)) {
          platformMap[platformName].countries.push(countryCode);
        }
      }
    }
  }

  // Sort countries alphabetically within each platform
  for (const platform of Object.values(platformMap)) {
    platform.countries.sort();
  }

  return platformMap;
}

/**
 * Transform TMDB watch provider response into country-grouped view.
 *
 * Output: { "US": ["Disney+", "Max"], "BR": ["Disney+"], ... }
 */
function transformToCountryView(results, subscribedIds, idToNameMap) {
  const countryMap = {}; // countryCode -> [platformName, ...]

  for (const [countryCode, countryData] of Object.entries(results)) {
    const flatrate = countryData.flatrate || [];
    for (const provider of flatrate) {
      if (subscribedIds.has(provider.provider_id)) {
        const platformName = idToNameMap[provider.provider_id] || provider.provider_name;
        if (!countryMap[countryCode]) {
          countryMap[countryCode] = [];
        }
        if (!countryMap[countryCode].includes(platformName)) {
          countryMap[countryCode].push(platformName);
        }
      }
    }
  }

  return countryMap;
}

/**
 * Extract rent/buy availability for subscribed platforms.
 * Returns: { "US": { rent: ["Amazon Prime Video"], buy: ["Apple TV+"] }, ... }
 */
function extractRentBuy(results, subscribedIds, idToNameMap) {
  const rentBuyMap = {};

  for (const [countryCode, countryData] of Object.entries(results)) {
    const rent = countryData.rent || [];
    const buy = countryData.buy || [];

    for (const provider of [...rent, ...buy]) {
      if (subscribedIds.has(provider.provider_id)) {
        const platformName = idToNameMap[provider.provider_id] || provider.provider_name;
        if (!rentBuyMap[countryCode]) {
          rentBuyMap[countryCode] = { rent: [], buy: [] };
        }
        const isRent = rent.some((r) => r.provider_id === provider.provider_id);
        const isBuy = buy.some((b) => b.provider_id === provider.provider_id);
        if (isRent && !rentBuyMap[countryCode].rent.includes(platformName)) {
          rentBuyMap[countryCode].rent.push(platformName);
        }
        if (isBuy && !rentBuyMap[countryCode].buy.includes(platformName)) {
          rentBuyMap[countryCode].buy.push(platformName);
        }
      }
    }
  }

  return rentBuyMap;
}

/**
 * Transform TMDB watch providers into a store-first rent/buy view.
 * Shows ALL stores (not filtered by subscriptions).
 *
 * Returns: {
 *   "Apple TV": { logo, rentCountries: ["US","GB",...], buyCountries: ["US",...] },
 *   "Amazon":   { ... },
 *   ...
 * }
 * Sorted by total country reach descending.
 */
function transformRentBuyToStoreView(results) {
  const storeMap = {};

  for (const [countryCode, countryData] of Object.entries(results)) {
    for (const provider of (countryData.rent || [])) {
      const name = provider.provider_name;
      if (!storeMap[name]) {
        storeMap[name] = { logo: provider.logo_path, rentCountries: [], buyCountries: [] };
      }
      if (!storeMap[name].rentCountries.includes(countryCode)) {
        storeMap[name].rentCountries.push(countryCode);
      }
    }
    for (const provider of (countryData.buy || [])) {
      const name = provider.provider_name;
      if (!storeMap[name]) {
        storeMap[name] = { logo: provider.logo_path, rentCountries: [], buyCountries: [] };
      }
      if (!storeMap[name].buyCountries.includes(countryCode)) {
        storeMap[name].buyCountries.push(countryCode);
      }
    }
  }

  // Sort countries alphabetically within each store
  for (const store of Object.values(storeMap)) {
    store.rentCountries.sort();
    store.buyCountries.sort();
  }

  // Sort stores by total unique country reach (descending)
  return Object.fromEntries(
    Object.entries(storeMap).sort(([, a], [, b]) => {
      const aCount = new Set([...a.rentCountries, ...a.buyCountries]).size;
      const bCount = new Set([...b.rentCountries, ...b.buyCountries]).size;
      return bCount - aCount;
    })
  );
}

export {
  searchMulti,
  getWatchProviders,
  getTitleRecommendations,
  getSimilarTitles,
  getTitleDetail,
  fetchAllProviders,
  validateApiKey,
  getImageUrl,
  transformToPlatformView,
  transformToCountryView,
  extractRentBuy,
  transformRentBuyToStoreView,
};
