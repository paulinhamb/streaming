// ============================================================
// events.js — Live Events feature for StreamFinder
// ============================================================

import { getCountryName, countryFlag } from './config.js?v=2';

// ---- Data ----

let eventsData = null; // loaded once on init

export async function loadEventsData() {
  try {
    const res = await fetch('data/events.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    eventsData = await res.json();
  } catch (e) {
    console.warn('Could not load events data:', e);
    eventsData = { events: [] };
  }
}

// ---- Search ----

// Returns array of matching event objects (or empty array).
// Fuzzy: checks if every word of the query appears somewhere in name/aliases.
export function searchEvents(query) {
  if (!eventsData?.events?.length) return [];
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  return eventsData.events.filter(event => {
    const haystack = [event.name, ...(event.aliases || [])].join(' ').toLowerCase();
    return words.every(w => haystack.includes(w));
  });
}

export function getEvent(id) {
  return eventsData?.events?.find(e => e.id === id) || null;
}

// ---- Render ----

export function renderEventPage(event) {
  const area = document.querySelector('#content-area');
  if (!area) return;

  const broadcasts = event.broadcasts || {};
  const entries = Object.entries(broadcasts);

  // Sort: free first, then alphabetical by country name
  const sorted = entries
    .map(([code, info]) => ({
      code,
      name: getCountryName(code),
      flag: countryFlag(code),
      channel: info.channel,
      free: info.free,
      url: info.url || null,
    }))
    .sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const freeCount = sorted.filter(e => e.free).length;

  area.innerHTML = `
    <div class="event-layout">

      <div class="event-left">
        <div class="event-sport-icon">${event.emoji}</div>
        <h1 class="event-name">${escapeHtml(event.name)}</h1>
        ${event.period ? `<p class="event-period">${escapeHtml(event.period)}</p>` : ''}
        <p class="event-data-note">Broadcast rights updated quarterly</p>
        ${event.official_url ? `
          <a href="${event.official_url}" target="_blank" rel="noopener" class="event-official-link">
            Official website ↗
          </a>` : ''}
      </div>

      <div class="event-right">
        <div class="event-results-header">
          <span class="streaming-label">#BROADCAST RIGHTS</span>
          ${freeCount > 0
            ? `<span class="event-free-count">${freeCount} free ${freeCount === 1 ? 'country' : 'countries'}</span>`
            : ''}
        </div>

        <div class="broadcast-list">
          ${sorted.map(entry => `
            <div class="broadcast-row ${entry.free ? 'broadcast-row--free' : 'broadcast-row--paid'}">
              <span class="broadcast-flag">${entry.flag}</span>
              <span class="broadcast-country">${escapeHtml(entry.name)}</span>
              <span class="broadcast-channel">${escapeHtml(entry.channel)}</span>
              <span class="${entry.free ? 'free-badge' : 'paid-badge'}">${entry.free ? 'FREE' : 'PAID'}</span>
              ${entry.url && entry.free ? `
                <a href="${entry.url}" target="_blank" rel="noopener" class="broadcast-link" title="Watch on ${escapeHtml(entry.channel)}">
                  ↗
                </a>` : '<span class="broadcast-link-placeholder"></span>'}
            </div>
          `).join('')}
        </div>

        ${freeCount > 0 ? `
          <div class="event-vpn-tip">
            <span class="event-vpn-tip-icon">💡</span>
            VPN to a <strong>FREE</strong> country — no account needed, just connect and stream.
          </div>` : `
          <div class="event-vpn-tip event-vpn-tip--none">
            <span class="event-vpn-tip-icon">ℹ️</span>
            No free streams found for this event. Check official site for options.
          </div>`}
      </div>

    </div>
  `;
}

// ---- Utility ----

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
