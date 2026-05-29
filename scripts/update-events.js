#!/usr/bin/env node
// ============================================================
// update-events.js — Auto-update data/events.json
// Runs via GitHub Actions quarterly or on manual trigger.
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/update-events.js
//
// Requires: @anthropic-ai/sdk (see package.json in scripts/)
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = join(__dirname, '..', 'data', 'events.json');
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

const client = new Anthropic();

// ── Fetch Wikipedia page HTML ─────────────────────────────────

async function fetchWikipediaBroadcasts(slug) {
  const params = new URLSearchParams({
    action: 'parse',
    page: slug,
    prop: 'sections|text',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`${WIKIPEDIA_API}?${params}`);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for ${slug}`);
  const json = await res.json();
  const html = json?.parse?.text?.['*'] || '';

  // Extract the broadcasting/television section only (lighter payload for Claude)
  const broadcastKeywords = [
    'broadcasti', 'television', 'broadcast rights', 'media rights',
    'tv coverage', 'telecast', 'streaming rights',
  ];

  // Simple heuristic: find sections containing broadcast-related keywords
  const sections = json?.parse?.sections || [];
  const broadcastSection = sections.find(s =>
    broadcastKeywords.some(kw => s.line?.toLowerCase().includes(kw))
  );

  if (broadcastSection) {
    // Re-fetch just that section
    const sectionParams = new URLSearchParams({
      action: 'parse',
      page: slug,
      prop: 'text',
      section: broadcastSection.index,
      format: 'json',
      origin: '*',
    });
    const sectionRes = await fetch(`${WIKIPEDIA_API}?${sectionParams}`);
    if (sectionRes.ok) {
      const sectionJson = await sectionRes.json();
      return sectionJson?.parse?.text?.['*'] || html;
    }
  }

  return html;
}

// ── Ask Claude to extract broadcast rights ────────────────────

async function extractBroadcastRights(eventName, html) {
  const prompt = `You are extracting TV broadcast rights data from a Wikipedia article about "${eventName}".

Here is the relevant HTML from the Wikipedia article:

<wikipedia_html>
${html.slice(0, 12000)}
</wikipedia_html>

Extract the broadcast rights information and return ONLY a valid JSON object mapping ISO 3166-1 alpha-2 country codes to broadcast details. Format:

{
  "COUNTRY_CODE": {
    "channel": "Channel Name",
    "free": true_or_false,
    "url": "optional_stream_url"
  }
}

Rules:
- Use ISO 2-letter country codes (e.g. "GB", "DE", "FR", "US", "AU", "JP", etc.)
- "free" should be true for free-to-air/public broadcasters, false for cable/satellite/streaming subscriptions
- Free broadcasters include: BBC, ITV, Channel 4, ARD, ZDF, RAI, France TV, RTVE, NOS, SVT, DR, NRK, Yle, ORF, SRF, RTP, RTBF, VRT, NHK, ABC, NBC, CBS, Fox (free-to-air), SBS, Channel 7/9/10, Telemundo, TV Globo, TV Pública, SABC, TVP
- Paid services include: Sky, Canal+, DAZN, ESPN, Amazon Prime, Netflix, Eurosport (subscription), BT Sport, Movistar, Stan, Peacock (paid tier), TNT, HBO, beIN Sports
- Only include countries with confirmed broadcast information
- If no broadcast data found, return {}
- Return ONLY the JSON object, no explanation or markdown`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0]?.text || '{}';

  // Parse JSON — handle if Claude wrapped it in backticks
  const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn(`  Could not parse Claude response for ${eventName}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('📡 Loading events.json...');
  const eventsJson = JSON.parse(readFileSync(EVENTS_PATH, 'utf8'));
  let updatedCount = 0;

  for (const event of eventsJson.events) {
    if (!event.wikipedia) {
      console.log(`  ⏭  Skipping ${event.name} (no wikipedia slug)`);
      continue;
    }
    if (event.locked) {
      console.log(`  🔒 Skipping ${event.name} (manually locked)`);
      continue;
    }

    console.log(`\n🔍 Updating: ${event.name} (${event.wikipedia})`);

    try {
      const html = await fetchWikipediaBroadcasts(event.wikipedia);
      if (!html) {
        console.warn(`  ⚠️  No HTML returned for ${event.name}`);
        continue;
      }

      const newBroadcasts = await extractBroadcastRights(event.name, html);
      if (!newBroadcasts || Object.keys(newBroadcasts).length === 0) {
        console.warn(`  ⚠️  No broadcasts extracted for ${event.name}`);
        continue;
      }

      // Merge: preserve any entries marked locked in existing data
      const merged = { ...newBroadcasts };
      for (const [code, info] of Object.entries(event.broadcasts || {})) {
        if (info.locked) merged[code] = info;
      }

      event.broadcasts = merged;
      updatedCount++;
      console.log(`  ✅ ${Object.keys(merged).length} countries extracted`);

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`  ❌ Error updating ${event.name}:`, err.message);
    }
  }

  // Update metadata
  const today = new Date().toISOString().slice(0, 10);
  eventsJson.updated = today;
  eventsJson.version = today.slice(0, 7).replace('-', '-');

  writeFileSync(EVENTS_PATH, JSON.stringify(eventsJson, null, 2) + '\n');
  console.log(`\n✨ Done. Updated ${updatedCount}/${eventsJson.events.length} events.`);
  console.log(`📝 Written to ${EVENTS_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
