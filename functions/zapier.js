// netlify/functions/zapier.js
// YourSituation — Zapier webhook proxy
// Forwards the v2 page payload to the Zapier catch hook.
//
// TRANSLATION LAYER: the Zap's steps (Create/Update Contact, Create Note,
// Lead Capture, Rounds table, Lookup Table key, Send Message prompt) were
// all built and mapped against camelCase field names during testing. Real
// production payloads from index.html use snake_case. Catch Hook silently
// discards snake_case payloads (accepts, returns 200, creates no task) for
// reasons not yet understood — this layer renames keys before forwarding
// so real traffic matches what the Zap actually expects.
//
// If the Zap is ever rebuilt to read snake_case directly, this translation
// step can be removed and the KEY_MAP below deleted.

const ZAPIER_HOOK_URL = 'https://hooks.zapier.com/hooks/catch/5383194/4heg0ok/';

// Maps real payload keys (snake_case, from index.html) -> Zap's expected keys (camelCase)
const KEY_MAP = {
  name: 'visitorFirstName',      // NOTE: real payload sends one combined "name" field;
                                  // Zap expects visitorFirstName/visitorLastName separately.
                                  // See split logic below — this direct mapping is overridden.
  phone: 'visitorPhone',
  email: 'visitorEmail',
  scenario: 'scenario',          // unchanged — Zap's Lookup Table key already reads this correctly elsewhere; scenario_detected below is the one that matters for routing
  area: 'area',
  situation: 'situation',
  price_range: 'priceRange',
  motivation: 'motivation',
  notes: 'notes',
  final_paragraph: 'finalParagraph',
  team_briefing_short: 'teamBriefingShort',
  team_briefing_full: 'teamBriefingFull',
  visitor_briefing: 'visitorBriefing',
  selected_patterns_text: 'selectedPatternsText',
  scenario_detected: 'Scenario Detected', // matches the exact field name used as the Lookup Table's key today
  referrer_page: 'referrerPage',
  refinement_count: 'refinementCount',
  pre_approved: 'preApproved',
  probe_asked: 'probeAsked',
  transcript: 'transcript',
  submitted_at: 'submittedAt',
  rounds_json: 'rounds_json',    // unchanged — Code by Zapier step reads this key as-is
  contact_provided: 'contact_provided', // unchanged — new field, not yet consumed by a mapped step
};

function translatePayload(body) {
  const out = {};

  // Name and lastname now arrive as two genuinely separate fields (fixed at
  // the WPCode redirect-URL source, which previously only captured first
  // name). Pass both through directly — no splitting needed.
  out.visitorFirstName = body.name || '';
  out.visitorLastName = body.lastname || '';

  // Apply the rest of the key map, skipping 'name' (handled above)
  for (const [oldKey, newKey] of Object.entries(KEY_MAP)) {
    if (oldKey === 'name') continue;
    if (body[oldKey] !== undefined) {
      out[newKey] = body[oldKey];
    }
  }

  // Pass through parentRecordId if present (Round 2 continuing a session);
  // real payload doesn't currently send this on Round 1, so it'll just be absent
  if (body.parentRecordId !== undefined) out.parentRecordId = body.parentRecordId;

  return out;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const translated = translatePayload(body);

  // Diagnostic logging — keep until this is confirmed solid in production,
  // then safe to remove.
  console.log('TRANSLATED keys:', Object.keys(translated));
  console.log('TRANSLATED body (first 500 chars):', JSON.stringify(translated).slice(0, 500));

  try {
    const response = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(translated),
    });

    if (!response.ok) {
      console.error('Zapier hook returned', response.status);
      return {
        statusCode: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ok: false,
          error: `Zapier hook returned ${response.status}`,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('Zapier proxy error:', err);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ok: false, error: err.message || 'Proxy error' }),
    };
  }
};
