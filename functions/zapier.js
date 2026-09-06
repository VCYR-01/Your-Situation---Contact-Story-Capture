// netlify/functions/zapier.js
// YourSituation — Zapier webhook proxy
// Forwards the v2 page payload to the Zapier catch hook.
// Pass-through: does not validate or transform the payload — Zapier handles
// the parent + child Airtable writes, the FUB note, and the SMS based on
// whatever fields are present in the JSON body.

const ZAPIER_HOOK_URL = 'https://hooks.zapier.com/hooks/catch/5383194/4heg0ok/';

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

  // ---- DIAGNOSTIC: log exactly what Netlify handed us, before touching it ----
  console.log('RAW event.body length:', event.body ? event.body.length : 'null/undefined');
  console.log('RAW event.isBase64Encoded:', event.isBase64Encoded);
  console.log('RAW event.body (first 500 chars):', (event.body || '').slice(0, 500));
  // ---------------------------------------------------------------------------

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.log('PARSE FAILED:', e.message);
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  // ---- DIAGNOSTIC: log what we ended up with after parsing ----
  console.log('PARSED body keys:', Object.keys(body));
  console.log('PARSED body (first 500 chars):', JSON.stringify(body).slice(0, 500));
  // ---------------------------------------------------------------

  try {
    const response = await fetch(ZAPIER_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
