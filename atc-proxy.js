/**
 * ════════════════════════════════════════════════════════════
 *  ATC DASHBOARD — API PROXY (Cloudflare Worker)
 * ════════════════════════════════════════════════════════════
 *
 *  This Worker hides your CheckWX and WeatherAPI keys from the
 *  browser. The dashboard calls this Worker, the Worker adds the
 *  secret keys server-side, and forwards the request.
 *
 *  ── DEPLOYMENT ────────────────────────────────────────────────
 *
 *  1. Go to https://dash.cloudflare.com → Workers & Pages
 *  2. Create application → Create Worker → name it (e.g. "atc-proxy")
 *  3. Click "Edit code", paste THIS ENTIRE FILE, click "Deploy"
 *  4. Settings → Variables and Secrets → "Add" (TYPE: Secret) for each:
 *        Name: CHECKWX_KEY     Value: <your CheckWX key>
 *        Name: WX_API_KEY      Value: <your WeatherAPI.com key>
 *        Name: ALLOWED_ORIGIN  Value: https://yourdomain.com
 *                              (or "*" for any origin while testing)
 *     Click "Deploy" again so secrets take effect.
 *  5. Copy your Worker URL — looks like:
 *        https://atc-proxy.<your-subdomain>.workers.dev
 *  6. Open dashboard.html, find the line:
 *        const PROXY_BASE = '...';
 *     and paste the Worker URL there.
 *
 *  ── ENDPOINTS ─────────────────────────────────────────────────
 *
 *    GET /metar/<icaos>     →  proxies CheckWX decoded METAR
 *    GET /taf/<icaos>       →  proxies CheckWX decoded TAF
 *    GET /wx?q=<query>      →  proxies WeatherAPI.com current
 *
 *  ── RATE LIMITING ─────────────────────────────────────────────
 *
 *  Cloudflare Workers free tier = 100k requests/day.
 *  Your dashboard refreshes every 5 min = 288 refreshes/day, with
 *  ~5 API calls each = ~1440 requests/day. Tiny fraction.
 * ════════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Only GET allowed
    if (request.method !== 'GET') {
      return jsonError('Method not allowed', 405, origin);
    }

    try {
      // ── METAR endpoint ──
      // /metar/TNCA,TNCC,TNCB
      if (path.startsWith('/metar/')) {
        const icaos = path.slice('/metar/'.length).replace(/[^A-Z0-9,]/gi, '');
        if (!icaos) return jsonError('Missing ICAO codes', 400, origin);
        return proxyCheckWX(
          `https://api.checkwx.com/metar/${icaos}/decoded`,
          env.CHECKWX_KEY,
          origin
        );
      }

      // ── TAF endpoint ──
      if (path.startsWith('/taf/')) {
        const icaos = path.slice('/taf/'.length).replace(/[^A-Z0-9,]/gi, '');
        if (!icaos) return jsonError('Missing ICAO codes', 400, origin);
        return proxyCheckWX(
          `https://api.checkwx.com/taf/${icaos}/decoded`,
          env.CHECKWX_KEY,
          origin
        );
      }

      // ── WeatherAPI current conditions ──
      // /wx?q=Willemstad,Curacao
      if (path === '/wx') {
        const q = url.searchParams.get('q');
        if (!q) return jsonError('Missing q parameter', 400, origin);
        const apiUrl = `https://api.weatherapi.com/v1/current.json?key=${env.WX_API_KEY}&q=${encodeURIComponent(q)}&aqi=no`;
        const r = await fetch(apiUrl, { cf: { cacheTtl: 60 } });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
            ...corsHeaders(origin),
          },
        });
      }

      // ── Health check ──
      if (path === '/' || path === '/health') {
        return new Response(
          JSON.stringify({
            ok: true,
            service: 'atc-dashboard-proxy',
            endpoints: ['/metar/<icaos>', '/taf/<icaos>', '/wx?q=<query>'],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders(origin),
            },
          }
        );
      }

      return jsonError('Not found', 404, origin);
    } catch (err) {
      return jsonError('Proxy error: ' + err.message, 502, origin);
    }
  },
};

async function proxyCheckWX(apiUrl, key, origin) {
  if (!key) {
    return jsonError('CHECKWX_KEY not configured on Worker', 500, origin);
  }
  const r = await fetch(apiUrl, {
    headers: { 'X-API-Key': key },
    cf: { cacheTtl: 60 }, // cache 60 s at Cloudflare's edge
  });
  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
