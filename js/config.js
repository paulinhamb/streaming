// ============================================================
// config.js — Configuration module for StreamFinder
// ============================================================

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const PROVIDER_CACHE_KEY = 'streamfinder_providers';
const PROVIDER_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// Default subscribed platforms with known TMDB provider IDs
// Some platforms have multiple IDs across regions
const DEFAULT_PROVIDERS = [
  { name: 'Apple TV+', ids: [350], color: '#000000' },
  { name: 'Max', ids: [384, 1899], color: '#002BE7' },
  { name: 'Disney+', ids: [337], color: '#113CCF' },
  { name: 'Amazon Prime Video', ids: [9, 119, 10], color: '#00A8E1' },
  { name: 'Filmin', ids: [64], color: '#D2213C' },
  { name: 'Mubi', ids: [11], color: '#001B2B' },
];

// --- API Key ---
const HARDCODED_API_KEY = 'c7cc2312d7954629d0bce9f21f57edc6';

function getApiKey() {
  return localStorage.getItem('streamfinder_api_key') || HARDCODED_API_KEY;
}

function setApiKey(key) {
  localStorage.setItem('streamfinder_api_key', key.trim());
}

function hasApiKey() {
  return getApiKey().length > 0;
}

// --- Subscribed Providers ---
function getSubscribedProviders() {
  const stored = localStorage.getItem('streamfinder_subscribed');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return [...DEFAULT_PROVIDERS];
    }
  }
  return [...DEFAULT_PROVIDERS];
}

function setSubscribedProviders(providers) {
  localStorage.setItem('streamfinder_subscribed', JSON.stringify(providers));
}

function resetProviders() {
  localStorage.removeItem('streamfinder_subscribed');
}

// --- Provider ID lookup helpers ---

// Returns a Set of all subscribed provider IDs (flattened from all platforms)
function getSubscribedProviderIds() {
  const providers = getSubscribedProviders();
  const ids = new Set();
  for (const p of providers) {
    for (const id of p.ids) {
      ids.add(id);
    }
  }
  return ids;
}

// Returns a map: providerId -> platform name
function getProviderIdToNameMap() {
  const providers = getSubscribedProviders();
  const map = {};
  for (const p of providers) {
    for (const id of p.ids) {
      map[id] = p.name;
    }
  }
  return map;
}

// --- Provider cache (full TMDB provider list) ---
function getCachedProviderList() {
  const raw = localStorage.getItem(PROVIDER_CACHE_KEY);
  if (!raw) return null;
  try {
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp < PROVIDER_CACHE_TTL) {
      return data;
    }
  } catch {}
  return null;
}

function setCachedProviderList(data) {
  localStorage.setItem(
    PROVIDER_CACHE_KEY,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

// --- Country name helper ---
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

function getCountryName(code) {
  try {
    return regionNames.of(code);
  } catch {
    return code;
  }
}

function countryFlag(code) {
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split('')
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

export {
  TMDB_API_BASE,
  TMDB_IMAGE_BASE,
  DEFAULT_PROVIDERS,
  getApiKey,
  setApiKey,
  hasApiKey,
  getSubscribedProviders,
  setSubscribedProviders,
  resetProviders,
  getSubscribedProviderIds,
  getProviderIdToNameMap,
  getCachedProviderList,
  setCachedProviderList,
  getCountryName,
  countryFlag,
};
