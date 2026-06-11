#!/usr/bin/env node
// ============================================================
// trakt-sync.js — Trakt "control" engine, run locally (no CORS).
//
// Does the whole Trakt round-trip from Node (where CORS doesn't apply):
//   1. Device-code auth (one-time; token cached in scripts/.trakt-token.json)
//   2. Seed Trakt with your scraped history  (history/trakt-import.json)
//   3. Fetch Trakt's recommendations → write history/trakt-recs.json
//
// Then import history/trakt-recs.json in the app
//   (Settings → Recommendations → Import Trakt recs).
//
// Usage:
//   node scripts/trakt-sync.js              # auth + seed + fetch recs
//   node scripts/trakt-sync.js --recs-only  # skip seeding (after first run)
//
// Credentials are read from scripts/trakt-creds.json (gitignored) or
// TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET env vars.
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOKEN_FILE = join(__dirname, '.trakt-token.json');
const CREDS_FILE = join(__dirname, 'trakt-creds.json');
const IMPORT_FILE = join(ROOT, 'history', 'trakt-import.json');
const RECS_FILE = join(ROOT, 'history', 'trakt-recs.json');
const TRAKT_API = 'https://api.trakt.tv';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// ── Credentials (from js/trakt.js, or env) ────────────────────
function readCreds() {
  let id = process.env.TRAKT_CLIENT_ID || '';
  let secret = process.env.TRAKT_CLIENT_SECRET || '';
  if ((!id || !secret) && existsSync(CREDS_FILE)) {
    try {
      const c = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
      id = id || c.client_id || '';
      secret = secret || c.client_secret || '';
    } catch {}
  }
  if (!id || !secret) {
    console.error('❌ Missing Trakt credentials. Put them in scripts/trakt-creds.json or set TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET.');
    process.exit(1);
  }
  return { id: id.trim(), secret: secret.trim() };
}
const { id: CLIENT_ID, secret: CLIENT_SECRET } = readCreds();

const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': CLIENT_ID,
  'User-Agent': 'StreamFinder/1.0 (+https://github.com/paulinhamb/streaming)',
  ...extra,
});
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Token storage ─────────────────────────────────────────────
function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveToken(t) {
  t.expiry = (t.created_at ? t.created_at * 1000 : Date.now()) + t.expires_in * 1000;
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

// ── Device-code auth ──────────────────────────────────────────
async function deviceAuth() {
  const dc = await (await fetch(`${TRAKT_API}/oauth/device/code`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ client_id: CLIENT_ID }),
  })).json();

  // Write code to a file too (stdout is buffered when run in background)
  try { writeFileSync(join(__dirname, '.trakt-device.json'), JSON.stringify({ url: dc.verification_url, code: dc.user_code })); } catch {}

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔑  Go to:  ${dc.verification_url}`);
  console.log(`    Enter code:  ${dc.user_code}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n    Waiting for you to authorize…');

  const deadline = Date.now() + dc.expires_in * 1000;
  let interval = (dc.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await delay(interval);
    const res = await fetch(`${TRAKT_API}/oauth/device/token`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ code: dc.device_code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    if (res.status === 200) { const t = await res.json(); saveToken(t); console.log('✅ Authorized!\n'); return t; }
    if (res.status === 400) continue;            // pending
    if (res.status === 429) { interval += 1000; continue; }
    if (res.status === 410) throw new Error('Code expired — run again.');
    if (res.status === 418) throw new Error('Authorization denied.');
    throw new Error(`device/token ${res.status}`);
  }
  throw new Error('Timed out waiting for authorization.');
}

async function refresh(tok) {
  const res = await fetch(`${TRAKT_API}/oauth/token`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      refresh_token: tok.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const t = await res.json(); saveToken(t); return t;
}

async function getToken() {
  let tok = loadToken();
  if (!tok) tok = await deviceAuth();
  else if (Date.now() > tok.expiry - 24 * 60 * 60 * 1000) {
    const r = await refresh(tok);
    tok = r || await deviceAuth();
  }
  return tok.access_token;
}

const auth = token => headers({ Authorization: `Bearer ${token}` });

// ── Seed + recommendations ────────────────────────────────────
async function seed(token) {
  if (!existsSync(IMPORT_FILE)) { console.log('⚠️  No history/trakt-import.json — run match-history.js first. Skipping seed.'); return; }
  const data = JSON.parse(readFileSync(IMPORT_FILE, 'utf8'));
  for (const [path, body] of [
    ['/sync/history',   { movies: data.history?.movies || [],  shows: data.history?.shows || [] }],
    ['/sync/watchlist', { movies: data.watchlist?.movies || [], shows: data.watchlist?.shows || [] }],
  ]) {
    const res = await fetch(`${TRAKT_API}${path}`, { method: 'POST', headers: auth(token), body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    const a = j.added || {};
    console.log(`   ${path}: added ${a.movies || 0} movies, ${a.episodes || a.shows || 0} show items`);
    await delay(800);
  }
}

async function fetchRecs(token, kind) {
  const res = await fetch(`${TRAKT_API}/recommendations/${kind}?limit=40&ignore_collected=true`, { headers: auth(token) });
  if (!res.ok) { console.log(`   recommendations/${kind}: ${res.status}`); return []; }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const recsOnly = process.argv.includes('--recs-only');
  const token = await getToken();

  if (!recsOnly) { console.log('📤 Seeding Trakt with your history…'); await seed(token); console.log(''); }

  console.log('📥 Fetching Trakt recommendations…');
  const [movies, shows] = await Promise.all([fetchRecs(token, 'movies'), fetchRecs(token, 'shows')]);
  const norm = (arr, type) => arr.filter(x => x.ids?.tmdb)
    .map((x, i) => ({ tmdb_id: x.ids.tmdb, type, title: x.title, year: x.year || '', order: i }));
  const recs = [...norm(movies, 'movie'), ...norm(shows, 'show')];

  writeFileSync(RECS_FILE, JSON.stringify({ updated: new Date().toISOString(), recs }, null, 2) + '\n');
  console.log(`\n✅ ${recs.length} recs (${movies.length} movies, ${shows.length} shows) → history/trakt-recs.json`);
  if (!recs.length) console.log('   (Trakt recomputes recommendations after seeding — re-run with --recs-only in a while.)');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
