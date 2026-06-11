#!/usr/bin/env node
// ============================================================
// match-history.js — Merge all history/*.csv + resolve TMDB IDs
//
// Reads:  history/{netflix,prime,max,apple}.csv  (any source CSV)
// Writes: history/matched.csv      — unique titles + TMDB IDs + provenance
//         history/unmatched.csv    — titles TMDB couldn't resolve (review)
//         history/trakt-import.json — history + watchlist, ready for Trakt
//
// Usage:  node scripts/match-history.js
//         (TMDB_API_KEY env overrides the default key)
// ============================================================

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = join(__dirname, '..', 'history');
const TMDB_KEY = process.env.TMDB_API_KEY || 'c7cc2312d7954629d0bce9f21f57edc6';
const TMDB = 'https://api.themoviedb.org/3';

// ── CSV parsing (quote-aware) ─────────────────────────────────
function parseCSVLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readHistoryRows() {
  const files = readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.csv') && !/^(matched|unmatched)/.test(f));
  const rows = [];
  for (const f of files) {
    const text = readFileSync(join(HISTORY_DIR, f), 'utf8').trim();
    const lines = text.split('\n');
    const header = parseCSVLine(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cells = parseCSVLine(lines[i]);
      const r = {};
      header.forEach((h, idx) => { r[h] = (cells[idx] ?? '').trim(); });
      rows.push(r);
    }
  }
  return { rows, files };
}

// ── Title normalisation ───────────────────────────────────────
const norm = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function cleanForSearch(t) {
  return (t || '')
    .replace(/\s*\((?:U\.S\.|US|ES|UK|4K UHD|UHD|HDR|HD|\d{4})\)\s*/gi, ' ')
    .replace(/[.…]+$/, '')          // trailing ellipsis / dots
    .replace(/\s*[-–:]\s*$/, '')    // trailing dash/colon
    .replace(/\s{2,}/g, ' ').trim();
}

// ── TMDB search ───────────────────────────────────────────────
async function tmdbSearch(title, type, year) {
  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
  const yearKey = type === 'movie' ? 'year' : 'first_air_date_year';
  const q = cleanForSearch(title);
  if (!q) return null;

  async function run(withYear) {
    const p = new URLSearchParams({ api_key: TMDB_KEY, query: q, include_adult: 'false' });
    if (withYear && year) p.set(yearKey, String(year));
    const res = await fetch(`${TMDB}/${endpoint}?${p}`);
    if (!res.ok) return [];
    return (await res.json()).results || [];
  }

  let results = await run(true);
  if (!results.length) results = await run(false);
  if (!results.length) return null;

  // Prefer a result whose title EXACTLY matches (normalised) over the merely
  // most-popular one — fixes short/year-less titles grabbing a wrong hit
  // (e.g. "Wayward" → "Wayward Pines"). Fall back to popularity (results[0])
  // for localised titles where no exact string match exists
  // (e.g. "Para toda la humanidad" → "For All Mankind").
  const nq = norm(q), nqRaw = norm(title);
  const titleOf = r => norm(r.title || r.name || '');
  const yearOf = r => (r.release_date || r.first_air_date || '').slice(0, 4);
  const exacts = results.filter(r => titleOf(r) === nq || titleOf(r) === nqRaw);

  let chosen, exact;
  if (exacts.length) {
    exact = true;
    chosen = (year && exacts.find(r => yearOf(r) === String(year))) || exacts[0];
  } else {
    exact = false;
    chosen = results[0];
  }
  return {
    tmdb_id: chosen.id,
    tmdb_title: chosen.title || chosen.name || '',
    tmdb_year: yearOf(chosen),
    exact,
    popularity: chosen.popularity,
  };
}

// ── CSV writing ───────────────────────────────────────────────
const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
function toCSV(headers, rows) {
  return headers.join(',') + '\n' +
    rows.map(r => headers.map(h => {
      const v = r[h] ?? '';
      return /[",\n]/.test(String(v)) ? q(v) : v;
    }).join(',')).join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const { rows, files } = readHistoryRows();
  console.log(`📥 Read ${rows.length} rows from: ${files.join(', ')}\n`);

  // Pre-dedupe by (type + normalised title) to minimise TMDB calls
  const pre = new Map();
  for (const r of rows) {
    const type = r.type === 'movie' ? 'movie' : 'show';
    const key = type + '|' + norm(r.title);
    if (!key.endsWith('|')) {
      let e = pre.get(key);
      if (!e) { e = { title: r.title, type, year: '', sources: new Set(), lists: new Set(), dates: [] }; pre.set(key, e); }
      e.sources.add(r.source);
      if (r.list) e.lists.add(r.list);
      if (r.year && !e.year) e.year = r.year;
      if (r.watched_at) e.dates.push(r.watched_at);
    }
  }
  const preList = [...pre.values()];
  console.log(`🔢 ${preList.length} unique titles to resolve (from ${rows.length} rows)\n`);

  // Resolve via TMDB in small concurrent batches
  const BATCH = 8;
  for (let i = 0; i < preList.length; i += BATCH) {
    const slice = preList.slice(i, i + BATCH);
    await Promise.all(slice.map(async e => {
      try { e.match = await tmdbSearch(e.title, e.type, e.year); }
      catch { e.match = null; }
    }));
    process.stdout.write(`\r   matched ${Math.min(i + BATCH, preList.length)}/${preList.length}`);
    await new Promise(r => setTimeout(r, 120));
  }
  console.log('\n');

  // Post-dedupe by (type + tmdb_id); merge provenance across platforms
  const matched = new Map();
  const unmatched = [];
  for (const e of preList) {
    const dates = e.dates.filter(Boolean).sort();
    const base = {
      type: e.type,
      sources: [...e.sources].sort().join(';'),
      lists: [...e.lists].sort().join(';'),
      first_watched: dates[0] || '',
      last_watched: dates[dates.length - 1] || '',
    };
    if (!e.match) { unmatched.push({ title: e.title, ...base }); continue; }
    const key = e.type + '|' + e.match.tmdb_id;
    const m = matched.get(key);
    if (!m) {
      matched.set(key, {
        type: e.type, title: e.title,
        tmdb_id: e.match.tmdb_id, tmdb_title: e.match.tmdb_title, tmdb_year: e.match.tmdb_year,
        exact: e.match.exact ? 'yes' : 'no',
        sources: new Set(e.sources), lists: new Set(e.lists), dates: [...dates],
      });
    } else {
      e.sources.forEach(s => m.sources.add(s));
      e.lists.forEach(l => m.lists.add(l));
      m.dates.push(...dates);
      if (e.match.exact && m.exact === 'no') { m.exact = 'yes'; m.title = e.title; }
    }
  }

  const matchedRows = [...matched.values()].map(m => {
    const dates = m.dates.filter(Boolean).sort();
    return {
      type: m.type, title: m.title,
      tmdb_id: m.tmdb_id, tmdb_title: m.tmdb_title, tmdb_year: m.tmdb_year, exact: m.exact,
      sources: [...m.sources].sort().join(';'),
      lists: [...m.lists].sort().join(';'),
      first_watched: dates[0] || '', last_watched: dates[dates.length - 1] || '',
    };
  }).sort((a, b) => (b.last_watched || '').localeCompare(a.last_watched || '') || a.title.localeCompare(b.title));

  // Write matched.csv + unmatched.csv
  const matchedHeaders = ['type', 'title', 'tmdb_id', 'tmdb_title', 'tmdb_year', 'exact', 'sources', 'lists', 'first_watched', 'last_watched'];
  writeFileSync(join(HISTORY_DIR, 'matched.csv'), toCSV(matchedHeaders, matchedRows));
  const unmatchedHeaders = ['type', 'title', 'sources', 'lists', 'first_watched', 'last_watched'];
  writeFileSync(join(HISTORY_DIR, 'unmatched.csv'), toCSV(unmatchedHeaders, unmatched));

  // Build Trakt import JSON (history if ever watched, else watchlist)
  const WATCHED = new Set(['watched', 'continue_watching']);
  const trakt = { history: { movies: [], shows: [] }, watchlist: { movies: [], shows: [] } };
  for (const m of matchedRows) {
    const ids = { tmdb: Number(m.tmdb_id) };
    const bucket = m.type === 'movie' ? 'movies' : 'shows';
    const isWatched = m.lists.split(';').some(l => WATCHED.has(l));
    if (isWatched) {
      const item = { title: m.tmdb_title, ids };
      if (m.last_watched) item.watched_at = `${m.last_watched}T20:00:00.000Z`;
      trakt.history[bucket].push(item);
    } else {
      trakt.watchlist[bucket].push({ title: m.tmdb_title, ids });
    }
  }
  writeFileSync(join(HISTORY_DIR, 'trakt-import.json'), JSON.stringify(trakt, null, 2) + '\n');

  // Summary
  const exactN = matchedRows.filter(m => m.exact === 'yes').length;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Matched:   ${matchedRows.length} unique titles (${exactN} exact, ${matchedRows.length - exactN} fuzzy)`);
  console.log(`   ↳ history:   ${trakt.history.movies.length} movies + ${trakt.history.shows.length} shows`);
  console.log(`   ↳ watchlist: ${trakt.watchlist.movies.length} movies + ${trakt.watchlist.shows.length} shows`);
  console.log(`⚠️  Unmatched: ${unmatched.length}  (see history/unmatched.csv)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (unmatched.length) {
    console.log('\nUnmatched titles:');
    unmatched.forEach(u => console.log(`   • [${u.type}] ${u.title}  (${u.sources})`));
  }
  console.log('\n📝 Wrote: history/matched.csv, history/unmatched.csv, history/trakt-import.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
