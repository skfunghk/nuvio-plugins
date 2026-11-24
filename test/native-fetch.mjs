// Emulation of the native side of Nuvio's plugin fetch, i.e. what `__native_fetch` returns.
//
//   NuvioTV     PluginRuntime.kt   performNativeFetch()      (blocking, 1 MiB read cap, silent)
//   NuvioMobile FetchBridge.kt → AddonPlatform httpRequestRaw() (suspending, 1 MiB cap + marker)
//
// The JS half (the `fetch` function itself) is NOT emulated: the tests evaluate Nuvio's own
// polyfill and only bind `__native_fetch` to this. Behaviour kept identical on purpose:
//   - default User-Agent when the caller sets none; caller's Accept-Encoding dropped;
//   - default Content-Type for POST (form) and PUT/PATCH/DELETE (json);
//   - body read to at most 1 MiB; lower-cased header names with repeated values joined by ",";
//     each value cut at 8 KiB; transport errors reported as status 0 in a normal JSON result.

import { createHmac, createHash, randomBytes } from 'node:crypto';

const MAX_FETCH_RESPONSE_BYTES = 1024 * 1024;
const MAX_FETCH_BODY_CHARS = 1024 * 1024;
const MAX_FETCH_HEADER_VALUE_CHARS = 8 * 1024;
const FETCH_TRUNCATION_SUFFIX = '\n...[truncated]';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function truncateString(value, maxChars) {
  if (value.length <= maxChars) return value;
  const end = maxChars - FETCH_TRUNCATION_SUFFIX.length;
  if (end <= 0) return FETCH_TRUNCATION_SUFFIX.slice(0, maxChars);
  return value.slice(0, end) + FETCH_TRUNCATION_SUFFIX;
}

function normalizeHeaders(headersJson) {
  const map = new Map();
  let parsed = {};
  try { parsed = JSON.parse(headersJson || '{}') || {}; } catch { /* host ignores header parse errors */ }
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    if (name.toLowerCase() === 'accept-encoding') continue;
    map.set(name, String(value));
  }
  if (![...map.keys()].some((name) => name === 'User-Agent')) map.set('User-Agent', DEFAULT_USER_AGENT);
  return map;
}

function decodeBody(bytes, contentType) {
  const charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}

// `transport` must expose send() (NuvioTV profile) or sendAsync() (NuvioMobile profile).
export function createNativeFetch(transport, profile, record) {
  if (profile !== 'tv' && profile !== 'mobile') throw new Error('profile must be "tv" or "mobile"');
  const fail = (url, message) => JSON.stringify({
    ok: false, status: 0, statusText: message || 'Fetch failed', url, body: '', bodyBase64: '', headers: {},
  });

  function finish(url, method, raw, truncated) {
    const contentType = raw.headers.filter(([name]) => name.toLowerCase() === 'content-type').map(([, value]) => value).join(',');
    const bodyBytes = Buffer.from(raw.bodyBytes || Buffer.alloc(0)).subarray(0, MAX_FETCH_RESPONSE_BYTES);
    let body = decodeBody(bodyBytes, contentType);
    if (profile === 'mobile' && truncated) body += FETCH_TRUNCATION_SUFFIX;
    body = truncateString(body, MAX_FETCH_BODY_CHARS);
    const headers = {};
    for (const [name, value] of raw.headers) {
      const key = name.toLowerCase();
      headers[key] = truncateString(headers[key] === undefined ? value : headers[key] + ',' + value, MAX_FETCH_HEADER_VALUE_CHARS);
    }
    const result = {
      ok: raw.status >= 200 && raw.status < 300,
      status: raw.status,
      statusText: raw.statusText,
      url: raw.url,
      body,
      bodyBase64: bodyBytes.toString('base64'),
      headers,
    };
    if (profile === 'tv') result.truncated = truncated;
    if (record) record.push({ url, status: raw.status, bytes: bodyBytes.length, rawBytes: raw.bodyBytes ? raw.bodyBytes.length : 0, truncated, contentType, method });
    return JSON.stringify(result);
  }

  function prepare(url, method, headersJson, bodyKind, body, followRedirects) {
    const headers = normalizeHeaders(headersJson);
    const upper = method.toUpperCase();
    let bytes = null;
    if (bodyKind === 'none') bytes = null;
    else if (bodyKind === 'text') bytes = Buffer.from(body || '', 'utf8');
    else if (bodyKind === 'base64') bytes = Buffer.from((body || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    else throw new Error('Unsupported fetch body kind: ' + bodyKind);
    if (bytes && !upper.match(/^(POST|PUT|PATCH|DELETE)$/)) bytes = null;
    if (bytes) {
      const type = [...headers.entries()].find(([name]) => name.toLowerCase() === 'content-type');
      if (!type) headers.set('Content-Type', upper === 'POST' ? 'application/x-www-form-urlencoded' : 'application/json');
    }
    const lower = new Map();
    for (const [name, value] of headers) {
      const key = name.toLowerCase();
      // Keep the caller's casing for the first occurrence; the plugin uses it to read its own headers back.
      lower.set(key, lower.has(key) ? lower.get(key) + ', ' + value : value);
    }
    return { url, method: upper, headers, lower, body: bytes, followRedirects };
  }

  if (profile === 'tv') {
    if (typeof transport.send !== 'function') throw new Error('the tv profile needs a transport with send()');
    // Like the host: every property is built even on failure, and nothing here can await.
    return function __native_fetch(url, method = 'GET', headersJson = '{}', bodyKind = 'none', body = '', followRedirects = true) {
      const started = Date.now();
      try {
        const request = prepare(String(url), String(method), String(headersJson), String(bodyKind), String(body), followRedirects !== false);
        request.at = started;
        const raw = transport.send(request);
        return finish(request.url, request.method, raw, raw.bodyBytes.length > MAX_FETCH_RESPONSE_BYTES);
      } catch (error) {
        return fail(url, error && error.message ? String(error.message) : 'Fetch failed');
      }
    };
  }

  if (typeof transport.sendAsync !== 'function') throw new Error('the mobile profile needs a transport with sendAsync()');
  return async function __native_fetch(url, method = 'GET', headersJson = '{}', bodyKind = 'none', body = '', followRedirects = true) {
    const started = Date.now();
    try {
      const request = prepare(String(url), String(method), String(headersJson), String(bodyKind), String(body), followRedirects !== true ? false : true);
      request.at = started;
      const raw = await transport.sendAsync(request);
      return finish(request.url, request.method, raw, raw.bodyBytes.length > MAX_FETCH_RESPONSE_BYTES);
    } catch (error) {
      return fail(url, error && error.message ? String(error.message) : 'Fetch failed');
    }
  };
}

// The crypto bridges NuvioMobile binds (CryptoBridge.kt), so its polyfill's TextEncoder,
// crypto.getRandomValues and crypto.subtle.digest / HMAC sign work in the harness too.
export function cryptoBridge() {
  const hex = (bytes) => Buffer.from(bytes).toString('hex');
  const unhex = (text) => Buffer.from(String(text || '').replace(/[^0-9a-fA-F]/g, '') || '', 'hex');
  const normal = (algorithm) => String(algorithm || 'SHA256').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SHA(\d)$/, 'SHA-$1');
  return {
    __crypto_get_random_values_hex: (length) => randomBytes(Math.max(0, Number(length) || 0)).toString('hex'),
    __crypto_digest_hex_raw: (algorithm, data) => createHash(normal(algorithm)).update(unhex(data)).digest('hex'),
    __crypto_hmac_hex_raw: (algorithm, key, data) => createHmac(normal(algorithm), unhex(key)).update(unhex(data)).digest('hex'),
    __crypto_utf8_to_hex: (text) => Buffer.from(String(text ?? ''), 'utf8').toString('hex'),
    __crypto_hex_to_utf8: (text) => unhex(text).toString('utf8'),
    __crypto_base64_encode: (text) => Buffer.from(String(text ?? ''), 'utf8').toString('base64'),
    __crypto_base64_decode: (text) => Buffer.from(String(text ?? ''), 'base64').toString('utf8'),
    __crypto_digest_hex: (algorithm, text) => createHash(normal(algorithm)).update(String(text ?? ''), 'utf8').digest('hex'),
    __crypto_hmac_hex: (algorithm, key, text) => createHmac(normal(algorithm), String(key ?? '')).update(String(text ?? '')).digest('hex'),
  };
}
