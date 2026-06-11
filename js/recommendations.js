// ============================================================
// recommendations.js — Dual-engine recs (Trakt control + Local test)
// Both providers emit the same shape:
//   { tmdb_id, type, title, year, poster, score, reason, factors?, providers? }
// ============================================================

import {
  getTitleRecommendations,
  getSimilarTitles,
  getTitleDetail,
  getWatchProviders,
} from './tmdb.js?v=2';
import { getSubscribedProviderIds, getRecsCache, setRecsCache } from './config.js?v=3';
import { getSeedTitles, getWatchedTmdbIds, getTraktRecs } from './history-store.js?v=2';

const FACTORS = ['affinity', 'genreMatch', 'recency', 'subscription', 'popularity'];

const FACTOR_REASON = {
  subscription: 'On your platforms',
  affinity:     'Because you watched similar',
  genreMatch:   'Matches your taste',
  recency:      'Fits your recent watches',
  popularity:   'Popular right now',
};

// Run `fn` over `arr` in concurrent batches of `size` (polite gap between).
async function batched(arr, size, fn) {
  for (let i = 0; i < arr.length; i += size) {
    await Promise.all(arr.slice(i, i + size).map(fn));
    await new Promise(r => setTimeout(r, 80));
  }
}

// ── LOCAL PROVIDER (test) ─────────────────────────────────────

// Heavy step: build the candidate pool from TMDB + provider lookups.
// Cached 6 hr. Re-ranking on weight changes uses rankLocal() (no refetch).
export async function loadLocalPool({ country, force = false, signal } = {}) {
  if (!force) { const c = getRecsCache('local'); if (c) return c; }

  const seeds = getSeedTitles();
  if (!seeds.length) return [];
  const watched = getWatchedTmdbIds();
  const topSeeds = seeds.sort((a, b) => b.recency - a.recency).slice(0, 60);

  // 1. Candidate generation
  const pool = new Map();
  await batched(topSeeds, 10, async seed => {
    const mt = seed.type === 'movie' ? 'movie' : 'tv';
    let recs = await getTitleRecommendations(seed.tmdb_id, mt, signal).catch(() => []);
    if (recs.length < 3) {
      const sim = await getSimilarTitles(seed.tmdb_id, mt, signal).catch(() => []);
      recs = recs.concat(sim);
    }
    for (const r of recs) {
      if (!r.id || watched.has(r.id)) continue;
      let e = pool.get(r.id);
      if (!e) {
        e = {
          tmdb_id: r.id, type: seed.type, title: r.title || r.name || '',
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          poster: r.poster_path, genres: r.genre_ids || [], popularity: r.popularity || 0,
          affinityCount: 0, recencySum: 0,
        };
        pool.set(r.id, e);
      }
      e.affinityCount++; e.recencySum += seed.recency;
    }
  });

  let candidates = [...pool.values()];
  if (!candidates.length) return [];

  // 2. Factor computation (each normalised 0..1)
  const genreScore = {};
  for (const c of candidates) for (const g of c.genres) genreScore[g] = (genreScore[g] || 0) + c.affinityCount;
  const aMax = Math.max(...candidates.map(c => c.affinityCount));
  const pMaxLog = Math.log10(1 + Math.max(...candidates.map(c => c.popularity)));
  let gRawMax = 0;
  for (const c of candidates) { c._g = c.genres.reduce((s, g) => s + (genreScore[g] || 0), 0); if (c._g > gRawMax) gRawMax = c._g; }

  for (const c of candidates) {
    c.factors = {
      affinity:     aMax ? c.affinityCount / aMax : 0,
      genreMatch:   gRawMax ? c._g / gRawMax : 0,
      recency:      c.affinityCount ? c.recencySum / c.affinityCount : 0,
      popularity:   pMaxLog ? Math.log10(1 + c.popularity) / pMaxLog : 0,
      subscription: 0, // filled next, for the top slice only
    };
    delete c._g;
  }

  // 3. Pre-rank (sans subscription), keep top 80 for provider lookup
  const W0 = { affinity: 1, genreMatch: 0.6, recency: 0.4, popularity: 0.2 };
  const pre = c => Object.keys(W0).reduce((s, f) => s + W0[f] * c.factors[f], 0);
  candidates.sort((a, b) => pre(b) - pre(a));
  const top = candidates.slice(0, 80);

  // 4. Provider lookup → subscription factor (+ chips data reused by the card)
  const subIds = getSubscribedProviderIds();
  await batched(top, 8, async c => {
    const results = await getWatchProviders(c.tmdb_id, c.type === 'movie' ? 'movie' : 'tv').catch(() => ({}));
    c.providers = results;
    const flat = (country && results[country] && results[country].flatrate) || [];
    c.factors.subscription = flat.some(p => subIds.has(p.provider_id)) ? 1 : 0;
  });

  setRecsCache('local', top);
  return top;
}

// Pure re-rank of a cached pool by current weights — instant on slider drag.
// randomize=true uses weighted random sampling so each refresh surfaces a
// genuinely different subset (probability proportional to score, so good
// candidates still dominate but lower-ranked ones get a real shot).
export function rankLocal(pool, weights, limit = 40, randomize = false) {
  const score = c => FACTORS.reduce((s, f) => s + (weights[f] || 0) * (c.factors[f] || 0), 0);
  const mapped = pool.map(c => ({ ...c, score: score(c), reason: factorReason(c.factors, weights) }));

  if (!randomize) {
    return mapped.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Weighted random sampling without replacement.
  // Each item's selection probability ∝ score + small base so every item has a chance.
  const remaining = [...mapped];
  const selected = [];
  while (selected.length < limit && remaining.length > 0) {
    const total = remaining.reduce((s, x) => s + Math.max(0, x.score) + 0.1, 0);
    let r = Math.random() * total;
    for (let i = 0; i < remaining.length; i++) {
      r -= Math.max(0, remaining[i].score) + 0.1;
      if (r <= 0) { selected.push(...remaining.splice(i, 1)); break; }
    }
    if (r > 0) selected.push(...remaining.splice(0, 1)); // safety: floating-point remainder
  }
  return selected.sort((a, b) => b.score - a.score); // display in score order
}

function factorReason(factors, weights) {
  let bestF = null, best = -Infinity;
  for (const f of FACTORS) {
    const contrib = (weights[f] || 0) * (factors[f] || 0);
    if (contrib > best) { best = contrib; bestF = f; }
  }
  return FACTOR_REASON[bestF] || 'Recommended';
}

// ── TRAKT PROVIDER (control) ──────────────────────────────────
// Reads the JSON produced locally by scripts/trakt-sync.js and imported
// into the app (Trakt blocks browser CORS, so the API can't be called here).
export async function loadTrakt() {
  const recs = getTraktRecs();
  return recs.map((r, i) => ({
    ...r, poster: r.poster || null, providers: null,
    score: 1 - i / Math.max(1, recs.length), reason: 'Trakt recommends',
  }));
}

// ── Shared card enrichment + metrics ──────────────────────────

// Ensure an item has a poster + provider data for rendering (Trakt items
// arrive bare; local items already have both). Mutates + returns the item.
export async function ensureCard(item) {
  const mt = item.type === 'movie' ? 'movie' : 'tv';
  const jobs = [];
  if (!item.poster) jobs.push(getTitleDetail(item.tmdb_id, mt).then(d => {
    item.poster = d.poster_path;
    if (!item.year) item.year = (d.release_date || d.first_air_date || '').slice(0, 4);
    if (!item.title) item.title = d.title || d.name || '';
  }).catch(() => {}));
  if (!item.providers) jobs.push(getWatchProviders(item.tmdb_id, mt)
    .then(r => { item.providers = r; }).catch(() => { item.providers = {}; }));
  await Promise.all(jobs);
  return item;
}

export function isWatchable(item, subIds, country) {
  const flat = (country && item.providers && item.providers[country] && item.providers[country].flatrate) || [];
  return flat.some(p => subIds.has(p.provider_id));
}

export { FACTORS, batched };
