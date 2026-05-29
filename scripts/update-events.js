#!/usr/bin/env node
// ============================================================
// update-events.js — Auto-update data/events.json
// Runs via GitHub Actions quarterly or on manual trigger.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... BRAVE_API_KEY=BSA... node scripts/update-events.js
//
// Required secrets:
//   ANTHROPIC_API_KEY  — Anthropic API key
//   BRAVE_API_KEY      — Brave Search API key (free tier: 2,000/month)
//                        Get one at: https://brave.com/search/api/
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, '..', 'data', 'events.json');

const BRAVE_API_KEY   = process.env.BRAVE_API_KEY;
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const WIKIPEDIA_API    = 'https://en.wikipedia.org/w/api.php';

const client = new Anthropic();
const CURRENT_YEAR = new Date().getFullYear();

// ── Utility ──────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Strip HTML tags → plain text, normalise whitespace, truncate
function htmlToText(html, maxChars = 4000) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxChars);
}

async function fetchPage(url, maxChars = 4000) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'StreamFinderBot/1.0 (broadcast-rights-updater; +https://github.com/paulinhamb/streaming)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return htmlToText(html, maxChars);
  } catch {
    return null;
  }
}

// ── Source 1: Official "Where to Watch" page ─────────────────

async function fetchOfficialPage(url) {
  if (!url) return null;
  console.log(`    📄 Fetching official page: ${url}`);
  const text = await fetchPage(url, 5000);
  if (!text) { console.log('       ⚠️  Could not fetch'); }
  return text;
}

// ── Source 2: Brave Search ────────────────────────────────────

async function braveSearch(query) {
  if (!BRAVE_API_KEY) {
    console.log('    ⚠️  No BRAVE_API_KEY — skipping web search');
    return [];
  }
  try {
    const params = new URLSearchParams({
      q: query,
      count: '5',
      freshness: 'py', // past year — keeps rights data current
    });
    const res = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.log(`    ⚠️  Brave Search HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    return json?.web?.results || [];
  } catch (err) {
    console.log(`    ⚠️  Brave Search error: ${err.message}`);
    return [];
  }
}

async function fetchSearchSources(eventName) {
  const queries = [
    `"${eventName}" broadcast rights ${CURRENT_YEAR} countries`,
    `"${eventName}" streaming rights TV channel by country ${CURRENT_YEAR}`,
  ];

  const allResults = [];
  for (const query of queries) {
    console.log(`    🔍 Brave Search: ${query}`);
    const results = await braveSearch(query);
    allResults.push(...results);
    await delay(500); // polite pause between search requests
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Build snippet summary (lightweight — no page fetch needed for snippets)
  const snippetText = unique
    .slice(0, 6)
    .map(r => `[${r.title}]\n${r.description || ''}\n${(r.extra_snippets || []).join(' ')}`)
    .join('\n\n---\n\n');

  // Fetch full HTML for top 2 most relevant results (sport/broadcast-specific URLs)
  const broadcastKeywords = ['broadcast', 'rights', 'watch', 'stream', 'tv', 'channel', 'media'];
  const topUrls = unique
    .filter(r => broadcastKeywords.some(kw => r.url.toLowerCase().includes(kw) || r.title.toLowerCase().includes(kw)))
    .slice(0, 2)
    .map(r => r.url);

  const pageTexts = [];
  for (const url of topUrls) {
    console.log(`    🌐 Fetching: ${url}`);
    const text = await fetchPage(url, 3000);
    if (text) pageTexts.push(`[From: ${url}]\n${text}`);
    await delay(800);
  }

  return { snippets: snippetText, pages: pageTexts };
}

// ── Source 3: Wikipedia (fallback) ───────────────────────────

async function fetchWikipediaBroadcasts(slug) {
  if (!slug) return null;
  try {
    // First pass: get section index for the broadcast/television section
    const indexParams = new URLSearchParams({
      action: 'parse', page: slug, prop: 'sections', format: 'json', origin: '*',
    });
    const indexRes = await fetch(`${WIKIPEDIA_API}?${indexParams}`);
    if (!indexRes.ok) return null;
    const indexJson = await indexRes.json();

    const broadcastKeywords = ['broadcast', 'television', 'media rights', 'tv coverage', 'streaming'];
    const sections = indexJson?.parse?.sections || [];
    const section = sections.find(s =>
      broadcastKeywords.some(kw => s.line?.toLowerCase().includes(kw))
    );

    const sectionIndex = section?.index;
    const params = new URLSearchParams({
      action: 'parse',
      page: slug,
      prop: 'text',
      ...(sectionIndex ? { section: sectionIndex } : {}),
      format: 'json',
      origin: '*',
    });

    const res = await fetch(`${WIKIPEDIA_API}?${params}`);
    if (!res.ok) return null;
    const json = await res.json();
    const html = json?.parse?.text?.['*'] || '';
    return htmlToText(html, 3000);
  } catch {
    return null;
  }
}

// ── Claude synthesis ──────────────────────────────────────────

async function synthesizeBroadcastRights(event, sources) {
  const sourceSections = [];

  if (sources.official) {
    sourceSections.push(`=== SOURCE 1: OFFICIAL BROADCASTER PAGE (highest priority) ===\n${sources.official}`);
  }
  if (sources.searchSnippets) {
    sourceSections.push(`=== SOURCE 2: RECENT NEWS & PRESS RELEASES (high priority) ===\n${sources.searchSnippets}`);
  }
  if (sources.searchPages?.length) {
    sources.searchPages.forEach((p, i) =>
      sourceSections.push(`=== SOURCE 3.${i + 1}: FULL ARTICLE FROM SEARCH ===\n${p}`)
    );
  }
  if (sources.wikipedia) {
    sourceSections.push(`=== SOURCE 4: WIKIPEDIA (lower priority, may be outdated) ===\n${sources.wikipedia}`);
  }

  if (!sourceSections.length) return null;

  const prompt = `You are extracting TV/streaming broadcast rights for "${event.name}" (${CURRENT_YEAR}).

${sourceSections.join('\n\n')}

---

Extract the broadcast rights and return ONLY a valid JSON object. Format:

{
  "COUNTRY_CODE": {
    "channel": "Channel Name(s)",
    "free": true_or_false,
    "url": "optional_direct_stream_url"
  }
}

Rules:
- Use ISO 3166-1 alpha-2 country codes (GB, DE, FR, US, BR, AU, JP, ES, IT, NL, etc.)
- "free": true for services that are free to watch (no subscription or payment required):
    Free: BBC, ITV, Channel 4, ARD, ZDF, RAI, France TV, RTVE, NOS, SVT, DR, NRK, Yle, ORF, SRF,
          RTP, RTBF, VRT, NHK, ABC, NBC/CBS/Fox (OTA), Telemundo, TV Globo, Bandeirantes, CazeTV,
          TV Pública, SBS, Channel 7/9/10, SABC, TVP, any YouTube channel, any free-to-air channel
    Paid: Sky, Canal+, DAZN, ESPN, Amazon Prime, Netflix, Eurosport (sub), BT Sport/TNT Sport,
          Movistar, Stan, Peacock (paid), beIN Sports, HBO, Paramount+, Disney+, Viaplay, WOWOW
- Include ALL broadcasters per country (free and paid), separated by " / "
- If a country has both free and paid options, set free: true (there IS a free way to watch)
- Include streaming-native services (YouTube channels, apps) — not just traditional TV
- If url is available for a free service, include it
- Prefer information from more recent sources over older ones
- Only include countries where broadcast rights are confirmed
- If no data found, return {}
- Return ONLY the JSON, no markdown or explanation`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0]?.text || '{}';
  const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn(`    ⚠️  Could not parse Claude response`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('📡 Loading events.json...\n');
  const eventsJson = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  let updatedCount = 0;
  let skippedCount = 0;

  for (const event of eventsJson.events) {
    if (event.locked) {
      console.log(`🔒 Skipping ${event.name} (event is locked)`);
      skippedCount++;
      continue;
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🏟  ${event.name}`);

    try {
      // Collect all sources in parallel where possible
      const [officialText, searchData, wikiText] = await Promise.all([
        fetchOfficialPage(event.official_broadcasters_url),
        fetchSearchSources(event.name),
        fetchWikipediaBroadcasts(event.wikipedia),
      ]);

      const sources = {
        official:      officialText || null,
        searchSnippets: searchData.snippets || null,
        searchPages:    searchData.pages || [],
        wikipedia:      wikiText || null,
      };

      const sourceCount = [
        sources.official      ? 'official page' : null,
        sources.searchSnippets ? 'search snippets' : null,
        sources.searchPages.length ? `${sources.searchPages.length} full page(s)` : null,
        sources.wikipedia     ? 'wikipedia' : null,
      ].filter(Boolean);

      console.log(`    📦 Sources: ${sourceCount.join(', ') || 'none'}`);

      if (!sourceCount.length) {
        console.warn(`    ⚠️  No sources collected — skipping`);
        continue;
      }

      console.log(`    🤖 Asking Claude to synthesise...`);
      const newBroadcasts = await synthesizeBroadcastRights(event, sources);

      if (!newBroadcasts || Object.keys(newBroadcasts).length === 0) {
        console.warn(`    ⚠️  No broadcasts extracted`);
        continue;
      }

      // Merge: preserve per-entry locked overrides from existing data
      const merged = { ...newBroadcasts };
      for (const [code, info] of Object.entries(event.broadcasts || {})) {
        if (info.locked) {
          merged[code] = info;
          console.log(`    🔒 Preserved locked entry: ${code}`);
        }
      }

      event.broadcasts = merged;
      updatedCount++;
      const freeCount = Object.values(merged).filter(b => b.free).length;
      console.log(`    ✅ ${Object.keys(merged).length} countries (${freeCount} free)`);

      // Polite delay between events
      await delay(2000);

    } catch (err) {
      console.error(`    ❌ Error: ${err.message}`);
    }
  }

  // Update metadata
  const today = new Date().toISOString().slice(0, 10);
  eventsJson.updated = today;
  eventsJson.version = today.slice(0, 7);

  writeFileSync(EVENTS_PATH, JSON.stringify(eventsJson, null, 2) + '\n');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✨ Done. Updated: ${updatedCount} | Skipped (locked): ${skippedCount}`);
  console.log(`📝 Written to ${EVENTS_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
