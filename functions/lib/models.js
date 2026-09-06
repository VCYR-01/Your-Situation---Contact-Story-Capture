'use strict';

// lib/models.js
// ─────────────────────────────────────────────────────────────────
// Centralized model-string registry client.
//
// Reads from the Platform Config base in Airtable (app/table IDs below).
// Apps call getModel('model.extraction.structured') and get back the
// current model identifier (e.g. 'claude-haiku-4-5'). When Anthropic
// retires a model or we decide to swap tasks to a different model, we
// change one row in Airtable and every consumer picks it up on its
// next cold start.
//
// Architecture:
//   - Module-level cache; the first call per function instance fetches
//     from Airtable, subsequent calls return cached results.
//   - Falls back to the FALLBACKS map below if Airtable is unreachable
//     or returns an error. Apps stay up; logs flag the degraded mode.
//   - Concurrent calls during a cold start share one in-flight request
//     (coalesced via _cachePromise) so we never fetch twice.
//
// Auth: reads PLATFORM_CONFIG_API_KEY first, falls back to AIRTABLE_API_KEY.
// Either works as long as the PAT has data:records:read on the config base.
//
// Deployment note: in apps that don't have either env var set, this
// helper silently uses the baked-in FALLBACKS. That's the right behavior —
// the app stays functional even before the operator wires up the env var.
// You'll see a warning in the function logs telling you the path taken.
// ─────────────────────────────────────────────────────────────────

const CONFIG_BASE_ID  = 'appzOrnnYEiCxYlDS';
const CONFIG_TABLE_ID = 'tbl0706UJR1RA3AkK';

// Baked-in defaults used when Airtable is unreachable or the env var
// isn't configured. Keep loosely in sync with the Airtable table — the
// table is the source of truth; this is a degraded-mode safety net so
// apps stay up rather than crashing if Airtable has a bad afternoon.
const FALLBACKS = {
  'model.extraction.structured':     'claude-haiku-4-5',
  'model.extraction.classification': 'claude-haiku-4-5',
  'model.content.long-form':         'claude-sonnet-4-6',
  'model.chat.retrieval':            'claude-sonnet-4-6',
  'model.analytical.standard':       'claude-sonnet-4-6',
  'model.analytical.heavy':          'claude-opus-4-7'
};

// Module-level cache. Persists for the lifetime of this function
// instance (Netlify keeps warm instances alive for minutes-to-hours
// depending on traffic). Cold starts re-fetch.
let _cache        = null;
let _cachePromise = null;

async function fetchConfig(apiKey) {
  const url = `https://api.airtable.com/v0/${CONFIG_BASE_ID}/${CONFIG_TABLE_ID}?pageSize=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const map  = {};
  (data.records || []).forEach(r => {
    const k = r.fields && r.fields.Key;
    const v = r.fields && r.fields.Value;
    if (k && v) map[k] = v;
  });
  return map;
}

async function loadConfig() {
  // Cache hit — return immediately.
  if (_cache)        return _cache;
  // Cold start with a concurrent call already in flight — share its promise.
  if (_cachePromise) return _cachePromise;

  const apiKey = process.env.PLATFORM_CONFIG_API_KEY
              || process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    console.warn('[models] No API key set (PLATFORM_CONFIG_API_KEY or AIRTABLE_API_KEY) — using baked-in fallbacks');
    _cache = FALLBACKS;
    return _cache;
  }

  _cachePromise = fetchConfig(apiKey)
    .then(map => {
      _cache        = map;
      _cachePromise = null;
      console.log(`[models] Loaded ${Object.keys(map).length} keys from Airtable`);
      return _cache;
    })
    .catch(err => {
      console.error('[models] Airtable fetch failed, using fallbacks:', err.message);
      _cache        = FALLBACKS;
      _cachePromise = null;
      return _cache;
    });

  return _cachePromise;
}

// Public entry point. Returns the model identifier for a given task key.
// Throws if the key isn't recognized in either Airtable or the fallback
// map — that's a bug in the caller (typo in task name), not a degraded-mode
// condition, and silent failure here would be worse than a loud one.
async function getModel(taskKey) {
  const config = await loadConfig();
  if (config[taskKey]) return config[taskKey];

  // Key not in Airtable response. Try the baked-in fallback for this key
  // specifically — useful if someone deleted a row in Airtable but apps
  // still reference it.
  if (FALLBACKS[taskKey]) {
    console.warn(`[models] Key '${taskKey}' not in Airtable response, using fallback '${FALLBACKS[taskKey]}'`);
    return FALLBACKS[taskKey];
  }

  throw new Error(`[models] Unknown task key: ${taskKey}`);
}

module.exports = { getModel };
