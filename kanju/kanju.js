// kanju.js — 看剧AI (kanju44.com / kanju.ai) streams for Nuvio's native plugin runtime.
//
// Port of the HGhub provider plugins/kanju.js (v0.1.3, verified 2026-11-22) to Nuvio's own
// "plugin" system: code that runs ON THE DEVICE inside Nuvio's QuickJS sandbox and can do
// one thing — turn a TMDB id into a list of playable stream URLs.
//
// The host facts quoted here were read from Nuvio's source at these commits:
//   NuvioTV     b70adbb8357e5c5042c35824ed1f060cd9fa973a   (core/plugin/PluginRuntime.kt, PluginManager.kt, …)
//   NuvioMobile 4ec93635a16aa3f5fc810c62158f6eb4aef261e5   (features/plugins/runtime/*, PluginRepository.kt, …)
// docs/nuvio-plugin-contract.md has the file paths and lists what could NOT be established.
//
// What the host gives us:
//   getStreams(tmdbId, mediaType, season, episode) -> Promise<Array<stream object>>
//     tmdbId    numeric TMDB id as a string in the normal case. IMDb ids are converted by the
//               host first; when that fails a kitsu:/mal:/anilist: id can arrive instead.
//     mediaType "movie" | "tv" ("series" only for manifests that list that type — this one does not)
//     season / episode   numbers for series; null on NuvioTV and undefined on NuvioMobile for movies.
//               NuvioTV sends season = null with an absolute episode number for anime trackers.
//   globals: fetch (shim), TMDB_API_KEY, SCRAPER_ID, SCRAPER_SETTINGS, console.
//   Anything thrown is caught by the host and logged; the caller only sees "no streams".
//   A provider is killed after 60 s (PLUGIN_TIMEOUT_MS in both runtimes).
//   One fetch body is cut at 1 MiB: silently on NuvioTV, with a "\n...[truncated]" suffix on NuvioMobile.
//
// What the host does NOT give us (each one forced an adaptation of kanju.js):
//   * no title / year / IMDb id — titles come from the TMDB API with the host-injected
//     TMDB_API_KEY (never a key embedded here). A host build compiled without one cannot use
//     this plugin (seen in NuvioTV's build.gradle.kts: the key comes from local.properties);
//   * no storage — the signing key is rediscovered on every call and the guest identity is
//     derived from SCRAPER_ID instead of being stored;
//   * no cookie jar — the site's guest-session cookie is relayed by hand;
//   * no endpoint switcher — the mirrors are tried in order (kanju44.com, then kanju.ai) and the
//     "official lines" behaviour is chosen by the manifest entry id (suffix "-official");
//   * a URL shim whose href does not follow searchParams — request URLs are built as strings
//     and signed exactly as they are sent (see docs for why the encoding is strict);
//   * NuvioTV's polyfill defines no timers, TextEncoder or WebCrypto, and loads crypto-js only
//     best-effort — so SHA-256/HMAC are implemented here in plain JS and both runtimes run the
//     same code.
//
// No account tokens, no login, no DRM handling: playback uses the site's public guest flow.

(function () {
  'use strict';

  var VERSION = '0.1.0';
  var TAG = '[kanju]';

  // Nuvio kills a provider after 60 s in both runtimes; stop starting new work before that.
  var SOFT_DEADLINE_MS = 40000;
  var RETRY_BUDGET_MS = 15000;    // after this, a dropped connection is reported instead of retried
  var MAX_SEARCH_TITLES = 4;      // distinct titles tried against the Kanju search
  var MAX_SEARCH_PAGES = 2;       // second page only when page 1 has no acceptable card
  var SEARCH_PAGE_SIZE = 12;
  var MAX_DIRECT_LINES = 6;       // zero-cost lines returned per call
  var EPISODE_PAGE_SIZE = 100;
  var MAX_EPISODE_PAGES = 3;
  // Same default the Nuvio fetch shims apply; set explicitly so tests match the device.
  var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  var FETCH_CAP_BYTES = 1024 * 1024; // Nuvio cuts one fetch body at 1 MiB
  var TRUNCATION_SUFFIX = '\n...[truncated]';   // how NuvioMobile marks a cut body

  // Same two entrances as kanju.js. Both serve one SPA and one API; tried in this order.
  var MIRRORS = [
    { id: 'kanju44', label: 'kanju44.com', url: 'https://kanju44.com' },
    { id: 'kanju', label: 'kanju.ai', url: 'https://kanju.ai' },
  ];

  // ---------------------------------------------------------------- logging

  function emit(level, message, extra) {
    var line = TAG + ' ' + message + (extra !== undefined && extra !== null && extra !== '' ? ' — ' + extra : '');
    try {
      if (typeof console[level] === 'function') console[level](line);
      else console.log(line);
    } catch (e) {
      try { console.log(line); } catch (e2) { /* nothing else we can do */ }
    }
  }

  function fail(code, message) {
    var error = new Error(message || code);
    error.name = 'KanjuError';
    error.code = code;
    return error;
  }

  function report(error) {
    if (error && error.code) emit('error', error.code + ': ' + error.message);
    else emit('error', 'UPSTREAM_ERROR: ' + (error && error.message ? error.message : String(error)));
  }

  // ------------------------------------------------------------ primitives
  // Plain-JS SHA-256/HMAC so the file does not depend on what each runtime polyfills.

  function utf8Bytes(text) {
    var out = [];
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8Length(text) {
    var s = String(text);
    var total = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) i++;
      if (c < 0x80) total += 1;
      else if (c < 0x800) total += 2;
      else if (c >= 0xd800 && c <= 0xdfff) total += 4;
      else total += 3;
    }
    return total;
  }

  function hex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
    return out;
  }

  function put32(arr, offset, value) {
    arr[offset] = (value >>> 24) & 255;
    arr[offset + 1] = (value >>> 16) & 255;
    arr[offset + 2] = (value >>> 8) & 255;
    arr[offset + 3] = value & 255;
  }

  function get32(arr, offset) {
    return ((arr[offset] << 24) | (arr[offset + 1] << 16) | (arr[offset + 2] << 8) | arr[offset + 3]) >>> 0;
  }

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Bytes(input) {
    var length = input.length;
    var total = ((length + 9 + 63) >> 6) << 6;
    var block = new Array(total);
    var i;
    for (i = 0; i < length; i++) block[i] = input[i] & 255;
    block[length] = 0x80;
    for (i = length + 1; i < total; i++) block[i] = 0;
    put32(block, total - 8, Math.floor(length / 536870912));
    put32(block, total - 4, (length * 8) >>> 0);

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var offset = 0; offset < total; offset += 64) {
      for (i = 0; i < 16; i++) w[i] = get32(block, offset + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (i = 0; i < 64; i++) {
        var bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var choose = (e & f) ^ (~e & g);
        var t1 = (k + bigS1 + choose + SHA256_K[i] + w[i]) >>> 0;
        var bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var majority = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (bigS0 + majority) >>> 0;
        k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
    }
    var digest = [];
    for (i = 0; i < 8; i++) put32(digest, i * 4, h[i]);
    return digest;
  }

  function hmacSha256(key, message) {
    if (key.length > 64) key = sha256Bytes(key);
    var inner = new Array(64), outer = new Array(64);
    for (var i = 0; i < 64; i++) {
      var byte = i < key.length ? key[i] : 0;
      inner[i] = byte ^ 0x36;
      outer[i] = byte ^ 0x5c;
    }
    return sha256Bytes(outer.concat(sha256Bytes(inner.concat(message))));
  }

  function sha256Hex(text) { return hex(sha256Bytes(utf8Bytes(text))); }

  // The server rejects a replayed nonce, so every signed request needs a fresh one. Use the
  // host's RNG when it has one and always mix in time + a counter.
  var randomTick = 0;
  function randomHex(byteCount) {
    var native = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function';
    var seed = (Date.now() ^ (++randomTick * 2654435761)) >>> 0;
    var out = '';
    for (var i = 0; i < byteCount; i++) {
      var value;
      if (native) {
        try {
          var buffer = new Uint8Array(1);
          crypto.getRandomValues(buffer);
          value = buffer[0];
        } catch (e) {
          native = false;
        }
      }
      if (value === undefined) value = Math.floor(Math.random() * 256);
      out += ((value ^ ((seed >>> (8 * (i % 4))) & 255)) & 255).toString(16).padStart(2, '0');
    }
    return out;
  }

  // Percent-encode everything except RFC 3986 unreserved characters. The string returned here
  // is the one that gets signed, so it must already be in the form OkHttp (the engine behind
  // Nuvio's fetch) sends on the wire: OkHttp rewrites a literal ' " < > in a query.
  var UNRESERVED = /^[A-Za-z0-9\-_.~]$/;
  function percentEncode(text, spaceAsPlus) {
    var out = '';
    var value = String(text);
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (UNRESERVED.test(ch)) { out += ch; continue; }
      if (spaceAsPlus && ch === ' ') { out += '+'; continue; }
      var bytes = utf8Bytes(ch);
      for (var j = 0; j < bytes.length; j++) {
        out += '%' + (bytes[j] >> 4).toString(16) + (bytes[j] & 15).toString(16);
      }
    }
    return out;
  }

  function formEncode(params) {
    var parts = [];
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      var value = params[keys[i]];
      if (value === undefined || value === null || value === '') continue;
      parts.push(percentEncode(keys[i], true) + '=' + percentEncode(value, true));
    }
    return parts.join('&');
  }

  function encodeSegment(value) { return percentEncode(value, false); }

  function resolveUrl(base, reference) {
    if (/^https?:\/\//i.test(reference)) return reference;
    var origin = /^(https?:\/\/[^\/]+)/i.exec(base);
    if (reference.charAt(0) === '/') return (origin ? origin[1] : base) + reference;
    return base.replace(/\/[^\/]*$/, '/') + reference;
  }

  function parseJson(text) {
    try {
      var value = JSON.parse(text);
      return value && typeof value === 'object' ? value : null;
    } catch (e) {
      return null;
    }
  }

  // NuvioTV exposes no timers, so a short busy wait is the only sleep it can do.
  function sleep(ms) {
    if (typeof setTimeout === 'function') {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }
    var end = Date.now() + Math.min(ms, 500);
    while (Date.now() < end) { /* busy wait on a background worker thread */ }
    return Promise.resolve();
  }

  // ------------------------------------------------------------------- HTTP

  async function rawFetch(url, options) {
    try {
      var response = await fetch(url, options);
      var body = await response.text();
      return {
        ok: !!response.ok,
        status: Number(response.status) || 0,
        statusText: String(response.statusText || ''),
        url: String(response.url || ''),
        headers: response.headers,
        body: typeof body === 'string' ? body : '',
      };
    } catch (e) {
      // Transport failures surface as status 0 on both hosts; a thrown error means the same.
      return { ok: false, status: 0, statusText: e && e.message ? String(e.message) : String(e), url: url, headers: null, body: '' };
    }
  }

  // Unsigned GET (site bundles, TMDB). Signed requests re-sign in api() instead of coming here.
  async function httpText(url, headers, retries) {
    var result;
    for (var attempt = 0; ; attempt++) {
      result = await rawFetch(url, { method: 'GET', headers: headers });
      if (result.status !== 0 || attempt >= retries || Date.now() > run.retryUntil) return result;
      await sleep(250 * (attempt + 1));
    }
  }

  // --------------------------------------------------------------- Kanju API
  // Same protocol as the public website (movie-card-runtime-*.js) and kanju.js:
  //   x-ai-movie-signature = hex(HMAC-SHA256(key, METHOD \n path?query \n timestamp \n nonce))
  // where key is the 64-character hex string found in the runtime chunk, used as ASCII bytes.

  function createMirror(config) {
    return {
      id: config.id,
      label: config.label,
      base: config.url,
      signingKey: null,
      cookies: {},
      sessionReady: false,
    };
  }

  function signedHeaders(mirror, method, target, hasBody) {
    var timestamp = String(Date.now());
    var nonce = randomHex(16);
    var canonical = [method.toUpperCase(), target, timestamp, nonce].join('\n');
    var signature = hex(hmacSha256(utf8Bytes(mirror.signingKey), utf8Bytes(canonical)));
    var headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'x-ai-movie-timestamp': timestamp,
      'x-ai-movie-nonce': nonce,
      'x-ai-movie-signature': signature,
    };
    if (hasBody) headers['Content-Type'] = 'application/json';
    var cookie = cookieHeader(mirror);
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  // Nuvio cuts a fetch body at 1 MiB. NuvioMobile appends a marker; NuvioTV truncates silently,
  // which for an ASCII bundle still shows as a body of exactly the cap.
  function looksTruncated(body) {
    if (body.slice(-TRUNCATION_SUFFIX.length) === TRUNCATION_SUFFIX) return true;
    if (body.length >= FETCH_CAP_BYTES) return true;
    return body.length > FETCH_CAP_BYTES / 2 && utf8Length(body) >= FETCH_CAP_BYTES;
  }

  async function fetchChunkText(url) {
    var result = await httpText(url, { 'User-Agent': USER_AGENT, Accept: '*/*' }, 2);
    if (result.status === 0) throw fail('NETWORK', '无法连接站点（' + result.statusText + '）');
    if (!result.ok) throw fail('UPSTREAM_ERROR', '站点脚本下载失败（' + result.status + '）');
    if (looksTruncated(result.body)) throw fail('UPSTREAM_CHANGED', '站点脚本超过宿主单次 1 MiB 抓取上限');
    return result.body;
  }

  async function keyFromChunk(url) {
    var code = await fetchChunkText(url);
    var hit = /"x-ai-movie-signature",\w+="([a-f0-9]{64})"/.exec(code);
    return hit ? hit[1] : null;
  }

  // kanju.js stores this key for an hour; Nuvio plugins have no storage, so it is found again
  // on every call. The site's home page names the runtime chunk directly, which saves the
  // 340 KB main bundle; the original home -> main -> runtime chain remains as the fallback.
  async function discoverSigningKey(mirror) {
    var homeUrl = mirror.base + '/';
    var home = await fetchChunkText(homeUrl);

    var preloaded = /href="([^" ]*\/assets\/movie-card-runtime-[\w-]+\.js)"/.exec(home);
    if (preloaded) {
      var direct = await keyFromChunk(resolveUrl(homeUrl, preloaded[1])).catch(function () { return null; });
      if (direct) return direct;
    }

    var main = /src="([^" ]*\/assets\/main-[^" ]+\.js)"/.exec(home);
    if (!main) throw fail('UPSTREAM_CHANGED', '站点入口已变化，请更新插件');
    var mainUrl = resolveUrl(homeUrl, main[1]);
    var bundle = await fetchChunkText(mainUrl);
    var asset = /\.\/movie-card-runtime-[\w-]+\.js/.exec(bundle);
    if (!asset) throw fail('UPSTREAM_CHANGED', '站点请求模块已变化，请更新插件');
    var key = await keyFromChunk(mainUrl.replace(/\/[^\/]*$/, '/') + asset[0].slice(2));
    if (!key) throw fail('UPSTREAM_CHANGED', '站点签名协议已变化，请更新插件');
    return key;
  }

  // Nuvio has no endpoint switcher: try the mirrors in order and keep the first one that answers.
  // A mirror that is unreachable, blocked or serving a changed site is skipped; the error of the
  // first mirror is reported when none works, since both entrances run the same deployment.
  async function selectMirror() {
    var first = null;
    for (var i = 0; i < MIRRORS.length; i++) {
      var mirror = createMirror(MIRRORS[i]);
      try {
        mirror.signingKey = await discoverSigningKey(mirror);
        return mirror;
      } catch (error) {
        if (!first) first = error;
        if (i + 1 < MIRRORS.length) emit('warn', error.code + ': ' + mirror.label + ' 不可用，改试 ' + MIRRORS[i + 1].label);
      }
    }
    throw first;
  }

  // The website keeps one visitor id in localStorage("movie-search:anonymous-id") for the life
  // of a browser profile and the server meters guests against it. Nuvio has no storage, so the
  // id is derived from the per-install scraper id: the same install always maps to the same
  // guest, never a fresh one per call.
  function anonymousId(mirror) {
    var scraperId = typeof SCRAPER_ID === 'string' ? SCRAPER_ID : '';
    var digest = sha256Hex('nuvio-kanju-guest/v1|' + mirror.base + '|' + scraperId);
    return 'web_' + digest.slice(0, 8) + '-' + digest.slice(8, 12) + '-4' + digest.slice(13, 16) +
      '-' + '89ab'.charAt(parseInt(digest.charAt(16), 16) & 3) + digest.slice(17, 20) + '-' + digest.slice(20, 32);
  }

  function absorbCookies(mirror, headers) {
    if (!headers || typeof headers.get !== 'function') return;
    var raw = headers.get('set-cookie');
    if (!raw) return;
    // Both hosts join repeated Set-Cookie headers with ","; a comma inside Expires is followed by
    // a space and a digit, a new cookie by "name=". The site sends four expiring cookies
    // ("ai_movie_session=; Max-Age=0") before the real session, so empty values must not win.
    var parts = String(raw).split(/,\s*(?=[^\s;,=]+=[^;,]*)/);
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split(';')[0].trim();
      var equal = pair.indexOf('=');
      if (equal > 0) mirror.cookies[pair.slice(0, equal).trim()] = pair.slice(equal + 1).trim();
    }
  }

  function cookieHeader(mirror) {
    var parts = [];
    var names = Object.keys(mirror.cookies);
    for (var i = 0; i < names.length; i++) {
      if (mirror.cookies[names[i]]) parts.push(names[i] + '=' + mirror.cookies[names[i]]);
    }
    return parts.join('; ');
  }

  function errorCode(data) {
    if (!data || typeof data !== 'object') return '';
    if (data.error && typeof data.error === 'object' && data.error.code) return String(data.error.code);
    return data.code ? String(data.code) : '';
  }

  function httpError(status, code, data) {
    var detail = data && data.error && typeof data.error.message === 'string' ? data.error.message
      : (data && typeof data.message === 'string' ? data.message : '');
    if (status === 401) return fail('AUTH_REQUIRED', '站点要求有效会话后才能播放该内容' + (detail ? '（' + detail + '）' : ''));
    if (status === 402 || status === 403) return fail('CONTENT_LOCKED', '该线路需要站点权限或剩余额度' + (detail ? '（' + detail + '）' : ''));
    if (status === 404) return fail('NOT_FOUND', code === 'playback_line_unavailable' ? '播放资源暂时不可用' : '站点未找到该内容');
    if (status === 429) return fail('RATE_LIMITED', '站点请求过于频繁，请稍后重试');
    return fail(code ? 'UPSTREAM_CHANGED' : 'UPSTREAM_ERROR', '站点请求失败（' + status + (code ? ' ' + code : '') + '）');
  }

  // Guest session: the site's own flow for a first-time visitor. Created only when the server
  // asks for a session (401), exactly like kanju.js, and never upgraded to a login.
  async function ensureGuestSession(mirror) {
    if (mirror.sessionReady) return;
    await api(mirror, 'POST', '/v1/users/anonymous', null, { anonymous_id: anonymousId(mirror) }, { session: true });
    mirror.sessionReady = true;
  }

  // One signed request. `path` must already be encoded; `query` is encoded here and the exact
  // "path?query" string that goes on the wire is the string that gets signed.
  async function api(mirror, method, path, query, body, opt) {
    opt = opt || {};
    var queryString = formEncode(query);
    var target = path + (queryString ? '?' + queryString : '');
    var url = mirror.base + target;
    var retries = method === 'GET' ? 2 : 1;

    for (var attempt = 0; ; attempt++) {
      if (!mirror.signingKey) mirror.signingKey = await discoverSigningKey(mirror);
      var headers = signedHeaders(mirror, method, target, body !== undefined);
      var result = await rawFetch(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
      absorbCookies(mirror, result.headers);

      if (result.status === 0) {
        // Transport failure: retry with a fresh nonce, never a replay of the signed request.
        if (attempt >= retries || Date.now() > run.retryUntil) throw fail('NETWORK', '无法连接站点（' + result.statusText + '）');
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (result.url && result.url !== url) {
        emit('warn', '宿主改写了请求地址，签名可能失效', result.url);
      }

      var data = parseJson(result.body);
      if (result.ok) return data;

      var code = errorCode(data);
      if (code === 'invalid_request_signature' && !opt.resigned) {
        mirror.signingKey = null;
        return api(mirror, method, path, query, body, { resigned: true, session: opt.session });
      }
      if (result.status === 401 && !opt.session) {
        await ensureGuestSession(mirror);
        return api(mirror, method, path, query, body, { resigned: opt.resigned, session: true });
      }
      throw httpError(result.status, code, data);
    }
  }

  // -------------------------------------------------------------------- TMDB
  // The host passes only a TMDB id. Titles come from TMDB with the key the host injects; this
  // file embeds no key. A JWT-shaped key is a v4 read token and goes in the Authorization header.
  // Could not be exercised live while this was written (no TMDB key at hand): the request only
  // uses long-standing fields and falls back to the plain detail call if the appended ones fail.

  var TMDB_API = 'https://api.themoviedb.org/3';
  // Most likely names first: the site catalogues everything under its mainland-Chinese title.
  var TMDB_LANGUAGES = ['zh TW', 'zh HK', 'zh SG', 'en US', 'en GB', 'en', 'ja JP', 'ko KR'];
  var TMDB_REGIONS = /^(CN|HK|TW|SG|US|GB|JP|KR)$/;

  function hostTmdbKey() {
    return typeof TMDB_API_KEY === 'string' ? TMDB_API_KEY.trim() : '';
  }

  async function tmdbGet(key, path, query) {
    var headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    var params = {};
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i++) params[keys[i]] = query[keys[i]];
    if (/^eyJ[\w-]+\.[\w-]+\./.test(key)) headers.Authorization = 'Bearer ' + key;
    else params.api_key = key;

    var result = await httpText(TMDB_API + path + '?' + formEncode(params), headers, 2);
    if (result.status === 0) throw fail('NETWORK', '无法连接 TMDB（' + result.statusText + '）');
    if (result.status === 401) throw fail('HOST_UNSUPPORTED', '宿主提供的 TMDB_API_KEY 被 TMDB 拒绝');
    if (result.status === 404) throw fail('NOT_FOUND', 'TMDB 没有这个 ' + path.split('/')[1] + ' ID');
    if (!result.ok) throw fail('UPSTREAM_ERROR', 'TMDB 请求失败（' + result.status + '）');
    var data = parseJson(result.body);
    if (!data) throw fail('UPSTREAM_CHANGED', 'TMDB 返回了无法解析的数据');
    return data;
  }

  function pushTitle(list, seen, text, rank) {
    var value = String(text || '').trim();
    if (value.length < 2 || seen[value]) return;
    seen[value] = true;
    list.push({ text: value, rank: rank });
  }

  // Rank 1: the localized and the original title; 2: Chinese/English/Japanese/Korean
  // translations; 3: alternative titles from a few regions. Anything else is not searched.
  function tmdbTitles(data, isMovie) {
    var titles = [];
    var seen = {};
    pushTitle(titles, seen, isMovie ? data.title : data.name, 1);
    pushTitle(titles, seen, isMovie ? data.original_title : data.original_name, 1);

    var translations = Array.isArray(data.translations && data.translations.translations) ? data.translations.translations : [];
    for (var l = 0; l < TMDB_LANGUAGES.length; l++) {
      var want = TMDB_LANGUAGES[l].split(' ');
      for (var t = 0; t < translations.length; t++) {
        var entry = translations[t];
        if (entry.iso_639_1 !== want[0]) continue;
        if (want[1] && entry.iso_3166_1 !== want[1]) continue;
        pushTitle(titles, seen, entry.data && (entry.data.title || entry.data.name), 2);
      }
    }

    var list = data.alternative_titles && (data.alternative_titles.titles || data.alternative_titles.results);
    list = Array.isArray(list) ? list : [];
    for (var i = 0; i < list.length; i++) {
      if (!TMDB_REGIONS.test(String(list[i].iso_3166_1 || ''))) continue;
      pushTitle(titles, seen, list[i].title, 3);
    }
    return titles;
  }

  async function tmdbInfo(args) {
    var key = hostTmdbKey();
    if (!key) throw fail('HOST_UNSUPPORTED', '宿主没有提供 TMDB_API_KEY，无法把 TMDB ID 换成片名');

    var kind = args.isMovie ? 'movie' : 'tv';
    var path = '/' + kind + '/' + args.tmdbId;
    var data = null;
    try {
      data = await tmdbGet(key, path, { language: 'zh-CN', append_to_response: 'translations,alternative_titles' });
    } catch (error) {
      if (error.code !== 'UPSTREAM_CHANGED' && error.code !== 'UPSTREAM_ERROR') throw error;
    }
    if (!data) data = await tmdbGet(key, path, { language: 'zh-CN' });

    var titles = tmdbTitles(data, args.isMovie);
    if (!titles.length) throw fail('NOT_FOUND', 'TMDB 没有这部影片的片名');

    var info = { titles: titles, year: null, seasonYear: null, totalSeasons: 0, firstAirYear: null };
    var seasons = Array.isArray(data.seasons) ? data.seasons : [];
    info.totalSeasons = Number(data.number_of_seasons) || seasons.length;
    info.firstAirYear = yearOf(data.first_air_date);
    if (args.isMovie) {
      info.year = yearOf(data.release_date) || yearOf(data.first_air_date);
    } else {
      for (var s = 0; s < seasons.length; s++) {
        if (Number(seasons[s].season_number) === args.season) info.seasonYear = yearOf(seasons[s].air_date);
      }
    }
    return info;
  }

  function yearOf(date) {
    var match = /^(\d{4})/.exec(String(date || ''));
    return match ? Number(match[1]) : null;
  }

  // ------------------------------------------------------------ title tools
  // Kanju titles look like "权力的游戏 Game of Thrones 第1季" or "庆余年 第1季（粤语）"; their
  // aliases carry scrape debris ("冰与火之歌权力的游戏一", "黑客帝国30"), so aliases are only
  // ever a weak signal and are compared as whole strings.

  var CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  var LETTER = /[A-Za-z0-9À-ɏͰ-ԯ]/;
  // "Part 1 / Part 2" is NOT stripped: two halves of one story are different films on TMDB.
  var SEASON_MARKERS = [
    /第\s*[0-9一二三四五六七八九十百零〇两]+\s*[季期]/g,
    /\bseason\s*[0-9]+\b/gi,
    /(?:^|[\s(\[])s[0-9]{1,2}\b/gi,
  ];
  var BRACKET_TAG = /[（(\[【〔][^）)\]】〕]*[）)\]】〕]/g;
  var LANGUAGE_TAG = /语[版音]?|配音|原声|国配|双语|特别版|剧场版|未删减|导演剪辑版/;
  // Bracketed halves of a two-part film ("赤壁(上)" / "赤壁(下)").
  var PART_FIRST = /^(?:上|上部|上集|上篇|前篇|前传|前集)$/;
  var PART_SECOND = /^(?:下|下部|下集|下篇|后篇|后传|后集)$/;

  function fold(text) {
    var value = String(text || '');
    value = value.replace(/&#x([0-9a-f]+);/gi, function (_, code) { return String.fromCodePoint(parseInt(code, 16)); })
      .replace(/&#(\d+);/g, function (_, code) { return String.fromCodePoint(parseInt(code, 10)); })
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
    if (typeof value.normalize === 'function') {
      try { value = value.normalize('NFKC'); } catch (e) { /* older engines: the fold below is enough */ }
    }
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code >= 0xff01 && code <= 0xff5e) code -= 0xfee0;
      else if (code === 0x3000) code = 32;
      out += String.fromCharCode(code);
    }
    return out.toLowerCase();
  }

  function compact(text) {
    var value = fold(text);
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (LETTER.test(ch) || CJK.test(ch)) out += ch;
    }
    return out;
  }

  function baseTitle(text) {
    var value = fold(text);
    for (var i = 0; i < SEASON_MARKERS.length; i++) value = value.replace(SEASON_MARKERS[i], ' ');
    return value.replace(BRACKET_TAG, ' ');
  }

  function bracketTags(text) {
    var tags = [];
    var value = fold(text);
    value.replace(BRACKET_TAG, function (tag) { tags.push(tag.slice(1, -1).trim()); return ' '; });
    return tags;
  }

  function partMarker(text) {
    var tags = bracketTags(text);
    var marker = '';
    for (var i = 0; i < tags.length; i++) {
      if (PART_FIRST.test(tags[i])) marker = 'first';
      else if (PART_SECOND.test(tags[i])) marker = marker || 'second';
    }
    return marker;
  }

  function seasonFromTitle(text) {
    var value = fold(text);
    var match = /第\s*([0-9]+)\s*[季期]/.exec(value) || /\bseason\s*([0-9]+)/i.exec(value) || /(?:^|[\s(\[])s([0-9]{1,2})\b/i.exec(value);
    if (match) return Number(match[1]);
    match = /第\s*([一二三四五六七八九十]+)\s*[季期]/.exec(value);
    return match ? chineseNumber(match[1]) : null;
  }

  function chineseNumber(text) {
    var digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text === '十') return 10;
    var parts = text.split('十');
    if (parts.length === 2) return (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0);
    return digits[text] || null;
  }

  // Splits a stripped title into same-script runs: "权力的游戏 Game of Thrones" gives
  // cjk ["权力的游戏"] and latin ["gameofthrones"], so either name can be recognised.
  function titleParts(text) {
    var value = baseTitle(text);
    var runs = [];
    var current = null;
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      var kind = CJK.test(ch) ? 'cjk' : (LETTER.test(ch) ? 'latin' : null);
      if (!kind) { current = null; continue; }
      if (current && current.kind === kind) current.text += ch;
      else { current = { kind: kind, text: ch }; runs.push(current); }
    }
    var tags = bracketTags(text);
    var loose = value.replace(/[a-z0-9]/gi, '');     // unbracketed tags such as "国语版"
    return {
      key: runs.map(function (run) { return run.text; }).join(''),
      runs: runs,
      // A language or edition tag makes a variant a fallback ("（粤语）", "特别版").
      tagged: tags.some(function (tag) { return LANGUAGE_TAG.test(tag); }) || LANGUAGE_TAG.test(loose),
      part: partMarker(text),
    };
  }

  // A card half is only refused when every TMDB title under that key names a different half.
  function partsAgree(info, key, cardPart) {
    if (!cardPart) return true;
    var parts = info.partsByKey[key];
    return !parts || parts.none || !!parts[cardPart];
  }

  // 100 exact primary TMDB title, 90 other known title, 80 known alternative title, 70 a
  // bilingual pair whose two halves are both known titles, 50 alias. Anything else is no match.
  function titleScore(parts, aliases, info) {
    var i;
    if (parts.key && info.titlesByKey[parts.key] && partsAgree(info, parts.key, parts.part)) return info.titlesByKey[parts.key];
    for (i = 0; i < parts.runs.length; i++) {
      if (isKnownRun(parts, i, info) && isTranslationPair(parts.runs, i, info)) return 70;
    }
    var list = Array.isArray(aliases) ? aliases : [];
    for (i = 0; i < list.length; i++) {
      var alias = compact(baseTitle(list[i]));
      // An alias that names no half inherits the card's: "赤壁（下）" cannot be "赤壁(上)".
      if (alias.length >= 2 && info.titlesByKey[alias] && partsAgree(info, alias, partMarker(list[i]) || parts.part)) return 50;
    }
    return 0;
  }

  function isKnownRun(parts, index, info) {
    var run = parts.runs[index];
    return run.text.length >= 2 && !!info.titlesByKey[run.text] && partsAgree(info, run.text, parts.part);
  }

  // One script-run of a mixed title only stands for the whole when the rest is the same name in
  // the other script, itself exactly a known title: "权力的游戏 Game of Thrones". Any further
  // text in the matched script is a subtitle or a sequel ("駭客任務：重裝上阵", "蜘蛛侠：英雄归来"),
  // and so is a number after the name ("流浪地球2").
  var HARMLESS_SUFFIX = /^(?:1|i)$/;

  function isTranslationPair(runs, matchedIndex, info) {
    var kind = runs[matchedIndex].kind;
    var other = '';
    for (var i = 0; i < runs.length; i++) {
      if (i === matchedIndex) continue;
      if (runs[i].kind === kind) return false;
      other += runs[i].text;
    }
    return other === '' || HARMLESS_SUFFIX.test(other) || !!info.titlesByKey[other];
  }

  function scoreYear(cardYear, wantedYear) {
    if (!cardYear || !wantedYear) return { points: 0, state: 'unknown' };
    var diff = Math.abs(Number(cardYear) - wantedYear);
    if (diff === 0) return { points: 30, state: 'same' };
    if (diff === 1) return { points: 15, state: 'near' };
    return { points: -60, state: 'mismatch' };
  }

  var KINDS = {
    movie: { movie: true, documentary: true },
    tv: { series: true, anime: true, variety: true },
  };

  function evaluateCard(card, info, args) {
    if (!card || !card.id || !KINDS[args.type][String(card.content_kind || '')]) return null;
    var cardTitle = String(card.title || '');
    var cardParts = titleParts(cardTitle);
    var cardScore = titleScore(cardParts, card.aliases, info);
    if (!cardScore) return null;

    var variants = Array.isArray(card.seasons) && card.seasons.length ? card.seasons
      : [{ variant_id: card.selected_variant_id || card.id, title: cardTitle, year: card.year }];
    var wantedYear = args.isMovie ? info.year : (info.seasonYear || info.firstAirYear);
    var best = null;

    for (var i = 0; i < variants.length; i++) {
      var variant = variants[i] || {};
      if (variant.has_playback === false) continue;
      var variantId = variant.variant_id || variant.id;
      if (!variantId) continue;
      var variantTitle = String(variant.title || cardTitle);
      var variantParts = titleParts(variantTitle);
      var variantScore = variantParts.key && variantParts.key !== cardParts.key ? titleScore(variantParts, null, info) : cardScore;
      if (!variantScore) continue;

      var seasonPoints = 0;
      var seasonState = 'n/a';
      if (!args.isMovie) {
        var season = seasonFromTitle(variantTitle);
        if (season === null) season = seasonFromTitle(cardTitle);
        if (season !== null) {
          if (season !== args.season) continue;
          seasonPoints = 50;
          seasonState = 'same';
        } else if (args.season === 1) {
          // No marker at all: the card is the whole show or its first season.
          seasonPoints = 40;
          seasonState = 'implicit';
        } else {
          seasonState = 'unsupported';
          continue;
        }
      }

      var year = scoreYear(variant.year || card.year, wantedYear);
      var playback = Number(variant.playback_count || card.playback_count) || 0;
      var penalty = (variantParts.tagged || cardParts.tagged ? 8 : 0);
      var score = Math.min(cardScore, variantScore) + seasonPoints + year.points + Math.min(10, Math.log(playback + 1) * 4) - penalty;
      if (!best || score > best.score) {
        best = {
          score: score,
          card: card,
          variantId: variantId,
          title: cardTitle,
          variantTitle: variantTitle,
          seasonState: seasonState,
          yearState: year.state,
          titleScore: Math.min(cardScore, variantScore),
        };
      }
    }
    return best;
  }

  async function search(mirror, text, page) {
    var data = await api(mirror, 'GET', '/v1/browse/catalog', {
      q: text, query_mode: 'fast_v3', search_fields: 'all', limit: SEARCH_PAGE_SIZE, page: page,
    });
    if (!Array.isArray(data.cards)) throw fail('UPSTREAM_CHANGED', '站点片库结构已变化');
    return data.cards;
  }

  var ACCEPT_SCORE = 70;   // an exact title with unknown year, or an alias with the same year

  async function findTitle(mirror, info, args, deadline) {
    var best = null;
    var count = Math.min(info.titles.length, MAX_SEARCH_TITLES);
    for (var t = 0; t < count; t++) {
      for (var page = 1; page <= MAX_SEARCH_PAGES; page++) {
        if (Date.now() > deadline) return best ? settle(best) : timeout('搜索');
        var cards = await search(mirror, info.titles[t].text, page);
        for (var i = 0; i < cards.length; i++) {
          var candidate = evaluateCard(cards[i], info, args);
          if (candidate && (!best || candidate.score > best.score)) best = candidate;
        }
        // Page 2 only helps when page 1 had nothing usable.
        if (best && best.score >= ACCEPT_SCORE) break;
        if (cards.length < SEARCH_PAGE_SIZE) break;
      }
      // An exact primary title with the right season and no year conflict cannot be improved
      // on by trying another spelling.
      if (best && best.titleScore >= 100 && best.yearState !== 'mismatch' && (!args.isMovie || best.score >= ACCEPT_SCORE)) return settle(best);
    }
    return settle(best);
  }

  function settle(best) {
    if (!best || best.score < ACCEPT_SCORE) {
      throw fail('NOT_FOUND', '站点找不到匹配的影片');
    }
    return best;
  }

  function timeout(step) { throw fail('TIMEOUT', '超时，停在「' + step + '」'); }

  // A card can hold several seasons ("variants"); only the detail payload carries the site's
  // own season_number, so it is fetched when there is more than one to choose from. An
  // untagged variant is preferred over a dubbed or re-cut one.
  async function chooseVariant(mirror, match, args) {
    var card = match.card;
    if (args.isMovie || !(Array.isArray(card.seasons) && card.seasons.length > 1)) return match.variantId;

    var detail = await api(mirror, 'GET', '/v1/catalog/' + encodeSegment(card.id) + '/detail');
    if (!detail || !detail.id || !detail.title) throw fail('UPSTREAM_CHANGED', '站点详情结构已变化');
    var variants = Array.isArray(detail.variants) && detail.variants.length ? detail.variants : (Array.isArray(detail.seasons) ? detail.seasons : []);
    var cardKey = titleParts(card.title).key;
    var fallback = null;

    for (var i = 0; i < variants.length; i++) {
      var variant = variants[i] || {};
      if (variant.has_playback === false) continue;
      var id = variant.variant_id || variant.id;
      if (!id) continue;
      var title = String(variant.title || detail.title || '');
      var parts = titleParts(title);
      if (parts.key && cardKey && parts.key !== cardKey) continue;   // a different work bundled in
      var marker = seasonFromTitle(title);
      var site = Number(variant.season_number);
      var fits = site === args.season || (marker !== null && marker === args.season);
      var unnumberedDefault = site !== site && marker === null && variant.selected;
      if (!fits && !(args.season === 1 && unnumberedDefault)) continue;
      if (parts.tagged) { if (!fallback) fallback = id; continue; }
      return id;
    }
    return fallback || match.variantId;
  }

  async function pickEpisode(mirror, variantId, args) {
    var offset = 0;
    for (var page = 0; page < MAX_EPISODE_PAGES; page++) {
      var data = await api(mirror, 'GET', '/v1/catalog/' + encodeSegment(variantId) + '/episodes', { limit: EPISODE_PAGE_SIZE, offset: offset });
      if (!Array.isArray(data.episodes)) throw fail('UPSTREAM_CHANGED', '站点分集结构已变化');
      var list = [];
      for (var i = 0; i < data.episodes.length; i++) {
        var entry = data.episodes[i];
        if (entry && entry.id && entry.token && entry.episode_track !== 'trailer') list.push(entry);
      }

      if (args.isMovie) {
        // Movies list named entries ("正片" is the film itself, "特别版" a re-cut).
        var feature = null;
        for (i = 0; i < list.length; i++) {
          if (!feature) feature = list[i];
          if (String(list[i].title) === '正片') { feature = list[i]; break; }
        }
        if (feature) return { token: feature.token, label: String(feature.title || '正片') };
        break;
      }

      var numbered = list.filter(function (item) { return item.number !== undefined && item.number !== null; });
      for (i = 0; i < numbered.length; i++) {
        if (Number(numbered[i].number) === args.episode) return { token: numbered[i].token, label: String(numbered[i].title || '第' + args.episode + '集') };
      }
      if (!numbered.length && list[args.episode - 1]) {
        return { token: list[args.episode - 1].token, label: String(list[args.episode - 1].title || '第' + args.episode + '集') };
      }
      var paging = data.episode_pagination;
      if (!paging || !paging.has_more) break;
      offset += Number(paging.returned_count) || list.length;
    }
    throw fail('NOT_FOUND', args.isMovie ? '站点没有可播放的正片' : '站点没有第 ' + args.season + ' 季第 ' + args.episode + ' 集');
  }

  // -------------------------------------------------------------- playback

  function lineKey(line) {
    // Upstream playback ids change per episode; preferences must use a stable provider identity.
    return line.provider_id ? JSON.stringify([line.provider_id, line.resolve_mode || '', line.label || line.provider_name || '']) : line.id;
  }

  function isTicket(line) {
    return line.url_kind === 'resolve_ticket' || String(line.url || '').indexOf('resolve://') === 0;
  }

  function lineName(line) {
    return String(line.label || line.provider_name || line.provider_id || '线路').trim();
  }

  // Display name without the trailing audio tag ("红牛资源 · 普通话"), which is reported
  // separately in `language` and would otherwise be shown twice.
  function lineLabel(line) {
    var name = lineName(line);
    return name.replace(/\s*[·•・]\s*[^\s·•・]+\s*$/, '').trim() || name;
  }

  function qualityOf(text) {
    var value = String(text || '');
    if (/4k|2160p/i.test(value)) return '4K';
    var match = /(\d{3,4})\s*p/i.exec(value);
    if (match) return match[1] + 'p';
    if (/高清|\bhd\b/i.test(value)) return 'HD';
    return '';
  }

  function audioOf(text) {
    var match = /[·•・]\s*([^\s·•・]+)\s*$/.exec(String(text || '').trim());
    return match ? match[1] : '';
  }

  // Only kinds that are a media URL already. "external"/"drm"-style lines are not playable by
  // Nuvio and are left alone; nothing here tries to unwrap them.
  // A kind or MIME type that names a media file, read the way kanju.js reads them.
  var MEDIA_TYPES = {
    m3u8: 'hls', hls: 'hls', 'application/vnd.apple.mpegurl': 'hls', 'application/x-mpegurl': 'hls',
    'audio/mpegurl': 'hls', 'audio/x-mpegurl': 'hls',
    mp4: 'mp4', progressive: 'mp4', 'video/mp4': 'mp4', 'video/webm': 'mp4', 'video/ogg': 'mp4',
    'audio/mp4': 'mp4', 'audio/mpeg': 'mp4',
  };

  function mediaType(type) {
    var value = String(type || '').toLowerCase().split(';')[0].trim().replace(/_/g, '/');
    return MEDIA_TYPES[value] || '';
  }

  // The url is the media URL itself when its kind or MIME type says so, or, for an "unknown"
  // kind, when a "mime_type" query hint or the file extension does. kanju.js asks the server
  // (HEAD) when there is no hint; that is not done here, because on NuvioTV every fetch blocks
  // the plugin for as long as the server takes and the whole call has 60 s.
  // Seen live 2026-11-24: a film's official line came back as url_kind "unknown" with the type
  // only in the query ("...&mime_type=video_mp4&...").
  function mediaUrl(line) {
    var url = String(line.url || '');
    if (!/^https:\/\//i.test(url)) return '';
    var kind = String(line.url_kind || '').toLowerCase();
    if (mediaType(kind) || mediaType(line.mime_type)) return url;
    if (kind && kind !== 'unknown') return '';
    var hint = /[?&]mime_type=([^&#]*)/i.exec(url);
    var type = '';
    if (hint) {
      try { type = mediaType(decodeURIComponent(hint[1].replace(/\+/g, ' '))); } catch (e) { type = ''; }
    }
    if (type || /\.(m3u8|mp4|m4v|webm)(\?|$)/i.test(url)) return url;
    return '';
  }

  function buildStream(context, line, url, quality, language) {
    // Fields the hosts read: name, title, url, quality, size, language, headers, subtitles.
    // Empty quality/language are left out rather than shown as blank by the host.
    var stream = { name: context.siteTitle + ' · ' + lineLabel(line), title: context.title, url: url };
    if (quality) stream.quality = quality;
    if (language) stream.language = language;
    return stream;
  }

  function expired(url) {
    var match = /[?&]x-expires=(\d{4,})/.exec(url);
    if (!match) return false;
    return Number(match[1]) * 1000 < Date.now() + 15000;   // gone, or about to be
  }

  async function resolveStreams(mirror, official, episode, context) {
    var resolved = await api(mirror, 'GET', '/v1/playback/resolve/' + encodeSegment(episode.token), { view: 'compact' });
    if (!Array.isArray(resolved.line_options) || !resolved.line_options.length) throw fail('NOT_FOUND', '站点未返回可用线路');

    // Dedupe by provider identity, keep the site's own order.
    var seen = {};
    var lines = [];
    for (var i = 0; i < resolved.line_options.length; i++) {
      var line = resolved.line_options[i] || {};
      var key = lineKey(line);
      if (seen[key]) continue;
      seen[key] = true;
      lines.push(line);
    }

    var tickets = [];
    var direct = [];
    for (i = 0; i < lines.length; i++) {
      if (Number(lines[i].minimum_user_level) > 0) continue;    // not offered to guests; left alone
      if (isTicket(lines[i])) tickets.push(lines[i]);
      else direct.push(lines[i]);
    }

    var streams = [];

    // Official lines are metered: every ticket resolution spends the guest's playback quota
    // (the site answers with quota_delta.used_tokens). Nuvio asks for streams whenever a source
    // list is loaded, not when the user presses play, so they are only resolved by the opt-in
    // manifest entry (id "kanju-official"), and only the site's own pick, once.
    if (official && tickets.length) {
      var pick = null;
      for (i = 0; i < tickets.length; i++) {
        if (!pick) pick = tickets[i];
        if (tickets[i].selected) { pick = tickets[i]; break; }
      }
      try {
        var answer = await api(mirror, 'POST', '/v1/playback/resolve-line', { view: 'compact' }, { ticket: String(pick.url).slice('resolve://'.length) });
        var url = answer && answer.line ? mediaUrl(answer.line) : '';
        if (url && !expired(url)) {
          streams.push(buildStream(context, answer.line, url,
            qualityOf(answer.line.label || answer.line.provider_name) || qualityOf(pick.label || pick.provider_name),
            audioOf(pick.label) || audioOf(answer.line.label) || context.language));
        } else if (url) emit('warn', 'CONTENT_LOCKED: 官方线路返回的地址已过期');
        else emit('warn', 'UPSTREAM_CHANGED', '官方线路解析结果不是可直接播放的地址（' + (answer && answer.line ? answer.line.url_kind : 'empty') + '）');
      } catch (error) {
        // Gated, out of quota, unavailable or too many requests: report it and do NOT try the
        // next ticket — each one would spend quota again or hit the same gate.
        report(error);
      }
    } else if (!official && tickets.length && !direct.length) {
      emit('warn', 'CONTENT_LOCKED: 只有需要解析额度的官方线路；默认不消耗站点游客额度（见 README）');
    }

    // Zero-cost lines, most preferred by the site first (the cap does not count an official line).
    direct.sort(function (a, b) { return (Number(b.preference_weight) || 0) - (Number(a.preference_weight) || 0); });
    var added = 0;
    for (i = 0; i < direct.length && added < MAX_DIRECT_LINES; i++) {
      var candidate = mediaUrl(direct[i]);
      if (candidate && !expired(candidate)) {
        added++;
        streams.push(buildStream(context, direct[i], candidate,
          qualityOf(direct[i].label || direct[i].provider_name),
          audioOf(direct[i].label) || context.language));
      }
    }
    return streams;
  }

  // -------------------------------------------------------------- entry point

  // Per-call budget: soft deadline for starting new steps, and a cut-off after which a dropped
  // connection is no longer retried (one hung request can already cost 30 s of the 60 s).
  var run = { deadline: 0, retryUntil: 0 };

  function parseArgs(tmdbId, mediaType, season, episode) {
    var id = String(tmdbId === undefined || tmdbId === null ? '' : tmdbId).trim();
    var type = String(mediaType || '').toLowerCase();
    if (!/^\d+$/.test(id)) {
      // The host passes kitsu:/mal:/anilist: ids through when it cannot map them to TMDB.
      throw fail('BAD_ARGUMENT', '只支持 TMDB 数字 ID（收到 ' + (id || '空') + '）');
    }
    var isMovie = type === 'movie';
    if (!isMovie && type !== 'tv' && type !== 'series') throw fail('BAD_ARGUMENT', '不支持的媒体类型：' + (type || '空'));
    var args = { tmdbId: id, type: isMovie ? 'movie' : 'tv', isMovie: isMovie, season: null, episode: null };
    if (!isMovie) {
      var s = Number(season), e = Number(episode);
      if (season === undefined || season === null || episode === undefined || episode === null ||
          !isFinite(s) || !isFinite(e) || Math.floor(s) !== s || Math.floor(e) !== e) {
        // Includes NuvioTV's absolute episode numbers for anime trackers (season = null).
        throw fail('BAD_ARGUMENT', '剧集需要 TMDB 的季和集编号（绝对集号不支持）');
      }
      if (s === 0) throw fail('NOT_FOUND', '特别篇（第 0 季）在站点上没有可靠的对应分集');
      if (s < 1 || e < 1) throw fail('BAD_ARGUMENT', '季和集编号从 1 开始');
      args.season = s;
      args.episode = e;
    }
    return args;
  }

  // Nuvio has no endpoint switcher. Both hosts build the scraper id as
  // "<repository>:<entry id>", so the manifest entry this file is installed as is the suffix.
  function mirrorConfig(scraperId) {
    var id = String(scraperId || '').toLowerCase().split(':').pop().split('/').pop();
    return { official: /(^|-)official(-|$)/.test(id) };
  }

  function indexTitles(info) {
    // normalized title -> score, and which film halves the TMDB titles under it name
    info.titlesByKey = {};
    info.partsByKey = {};
    for (var t = 0; t < info.titles.length; t++) {
      var key = compact(baseTitle(info.titles[t].text));
      var rank = info.titles[t].rank;
      var score = rank === 1 ? 100 : (rank === 2 ? 90 : 80);
      if (key && (!info.titlesByKey[key] || info.titlesByKey[key] < score)) info.titlesByKey[key] = score;
      if (key) {
        var parts = info.partsByKey[key] || (info.partsByKey[key] = {});
        parts[partMarker(info.titles[t].text) || 'none'] = true;
      }
    }
  }

  async function getStreams(tmdbId, mediaType, season, episode) {
    var started = Date.now();
    run.deadline = started + SOFT_DEADLINE_MS;
    run.retryUntil = started + RETRY_BUDGET_MS;
    try {
      var args = parseArgs(tmdbId, mediaType, season, episode);
      var official = mirrorConfig(typeof SCRAPER_ID === 'string' ? SCRAPER_ID : '').official;
      emit('log', 'v' + VERSION + (official ? ' (+official)' : '') + ' tmdb=' + args.tmdbId + ' ' + args.type +
        (args.isMovie ? '' : ' S' + args.season + 'E' + args.episode));

      // Independent lookups: NuvioMobile's fetch bridge is async so they overlap; NuvioTV's is
      // synchronous and they simply run one after the other.
      var lookups = await Promise.all([
        selectMirror().then(function (mirror) { return mirror; }, function (error) { return error; }),
        tmdbInfo(args).then(function (info) { return info; }, function (error) { return error; }),
      ]);
      if (lookups[0] instanceof Error) throw lookups[0];
      if (lookups[1] instanceof Error) throw lookups[1];
      var mirror = lookups[0];
      var info = lookups[1];
      indexTitles(info);

      var match = await findTitle(mirror, info, args, run.deadline);
      emit('log', '匹配 ' + match.title + (match.variantTitle !== match.title ? ' / ' + match.variantTitle : '') +
        ' score=' + match.score + ' season=' + match.seasonState + ' year=' + match.yearState + ' @' + mirror.label);
      if (Date.now() > run.deadline) return timeout('选季');

      var variantId = await chooseVariant(mirror, match, args);
      var picked = await pickEpisode(mirror, variantId, args);
      if (Date.now() > run.deadline) return timeout('解析线路');

      // "正片" is noise for a film; other entries ("特别版") are worth showing.
      var entryLabel = args.isMovie ? (picked.label && picked.label !== '正片' ? ' · ' + picked.label : '') : ' · ' + picked.label;
      var context = {
        siteTitle: match.variantTitle,
        title: match.variantTitle + entryLabel + ' · ' + mirror.label,
        language: '',
      };
      var streams = await resolveStreams(mirror, official, picked, context);
      emit('log', '返回 ' + streams.length + ' 条线路');
      return streams;
    } catch (error) {
      report(error);
      return [];
    }
  }

  module.exports = { getStreams: getStreams };
  // Exposed only so test/ can exercise the pure helpers; the host never calls these.
  module.exports.internals = {
    version: VERSION,
    mirrors: MIRRORS,
    sha256Hex: sha256Hex,
    hmacSha256Hex: function (keyHex, message) { return hex(hmacSha256(utf8Bytes(keyHex), utf8Bytes(message))); },
    utf8Length: utf8Length,
    percentEncode: percentEncode,
    formEncode: formEncode,
    looksTruncated: looksTruncated,
    absorbCookies: absorbCookies,
    fold: fold,
    compact: compact,
    baseTitle: baseTitle,
    titleParts: titleParts,
    partMarker: partMarker,
    seasonFromTitle: seasonFromTitle,
    indexTitles: indexTitles,
    titleScore: titleScore,
    evaluateCard: evaluateCard,
    parseArgs: parseArgs,
    mirrorConfig: mirrorConfig,
    anonymousId: anonymousId,
    lineKey: lineKey,
    qualityOf: qualityOf,
    audioOf: audioOf,
    lineLabel: lineLabel,
    mediaUrl: mediaUrl,
    httpError: httpError,
    tmdbTitles: tmdbTitles,
  };
})();
