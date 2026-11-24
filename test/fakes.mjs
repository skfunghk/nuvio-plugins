// Scripted stand-ins for the two sites the plugin talks to, used by the offline tests.
//
//   fakeKanju()  serves the saved home page, a make-believe runtime chunk that carries a
//                made-up signing key, the saved search/detail/episodes/resolve fixtures, and
//                the guest-session + official-line flow. Every /v1 request is checked for a
//                valid HMAC over the exact "path?query" that was sent, so a wrong canonical
//                string, key or encoding fails here exactly as it would on the real site.
//   fakeTmdb()  serves the hand-written TMDB fixtures and checks the api_key / Bearer token.
//
// No real key, token or cookie value lives in this file or in the fixtures.

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonResponse } from './transport.mjs';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const readFixture = (...parts) => readFileSync(join(FIXTURES, ...parts), 'utf8');
export const readJson = (...parts) => JSON.parse(readFixture(...parts));
export const FAKE_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const FAKE_SESSION = 'ums_FAKESESSION0000000000000000000000000000000000000';
export const KANJU_HOSTS = ['https://kanju44.com', 'https://kanju.ai'];
export const TMDB_HOST = 'https://api.themoviedb.org';

const SESSION_COOKIES = [
  'ai_movie_session=; Path=/v1; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
  'ai_movie_session=; Path=/v1; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=kanju44.com; Secure',
  'ai_movie_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
  'ai_movie_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=kanju44.com; Secure',
  'ai_movie_session=' + FAKE_SESSION + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31535999; Expires=Wed, 24 Nov 2027 04:24:49 GMT; Secure',
];

// The site's runtime chunk is a minified bundle; only this one pattern is read from it.
export function fakeRuntimeChunk(key = FAKE_KEY) {
  return '/* make-believe movie-card-runtime chunk */(function(){var e={};e.d=function(t,n){for(var r in n)Object.defineProperty(t,r,{enumerable:!0,get:n[r]})};'
    + 'var o="x-ai-movie";var s={"x-ai-movie-signature",aB3xY=' + JSON.stringify(key) + '};var u=["x-ai-movie-timestamp","x-ai-movie-nonce",'
    + '"x-ai-movie-signature"];e.sign=function(t,n){return u.length+o.length+s.length+t.length+n.length};window.__runtime=e})();';
}

export function fakeMainBundle() {
  // Names the runtime chunk the way the real bundle does: "./movie-card-runtime-<hash>.js".
  return '/* make-believe main bundle */import("./movie-card-runtime-Ddt--41l.js").then(function(m){return m.sign(1,2)});'
    + 'var x=__vite__mapDeps(["assets/movie-card-runtime-Ddt--41l.js","assets/other-abc.js"]);';
}

const sign = (key, method, target, timestamp, nonce) => createHmac('sha256', Buffer.from(key, 'utf8')).update([method, target, timestamp, nonce].join('\n')).digest('hex');

export function fakeKanju(options = {}) {
  const key = options.key || FAKE_KEY;
  const hosts = options.hosts || KANJU_HOSTS;
  const searches = options.searches || {};
  const details = options.details || {};
  const episodes = options.episodes || {};
  const resolves = options.resolves || {};
  const official = options.official || {};
  const state = { nonces: new Set(), signedRequests: 0, badSignatures: 0, sessions: 0, resolveLines: 0, keyHits: 0, homeHits: 0, anonIds: [] };
  let session = null;

  const handler = (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    // The plugin sends its headers with HTTP casing ("Cookie"); look them up case-insensitively.
    const header = (name) => (request.lower && request.lower.get(name)) || request.headers.get(name) || '';

    if (options.intercept) {
      const hit = options.intercept(request, url);
      if (hit) return hit;
    }
    if (!hosts.some((host) => url.origin === host)) return null;

    if (path === '/' && request.method === 'GET') {
      state.homeHits++;
      return jsonResponse(200, options.home ?? readFixture('kanju', 'home.html'), [['content-type', 'text/html; charset=utf-8']]);
    }
    if (/^\/assets\/movie-card-runtime-[\w-]+\.js$/.test(path)) {
      state.keyHits++;
      return jsonResponse(200, options.chunk ?? fakeRuntimeChunk(key), [['content-type', 'text/javascript; charset=utf-8']]);
    }
    if (/^\/assets\/main-[\w-]+\.js$/.test(path)) return jsonResponse(200, options.main ?? fakeMainBundle(), [['content-type', 'text/javascript; charset=utf-8']]);
    if (!path.startsWith('/v1/')) return jsonResponse(404, { error: 'not_found' });

    // --- signature check: same canonical string the website signs -------------------------
    const target = path + url.search;
    const timestamp = header('x-ai-movie-timestamp');
    const nonce = header('x-ai-movie-nonce');
    const expected = sign(key, request.method, target, timestamp, nonce);
    state.signedRequests++;
    if (header('x-ai-movie-signature') !== expected) {
      state.badSignatures++;
      return jsonResponse(401, { error: 'request_error', code: 'invalid_request_signature', message: '签名无效' });
    }
    if (state.nonces.has(nonce)) {
      return jsonResponse(401, { error: 'request_error', code: 'invalid_request_nonce', message: 'nonce 已使用' });
    }
    state.nonces.add(nonce);

    if (request.method === 'POST' && path === '/v1/users/anonymous') {
      state.sessions++;
      const body = JSON.parse(request.body ? request.body.toString('utf8') : '{}');
      state.anonIds.push(body.anonymous_id);
      session = 'ai_movie_session=' + FAKE_SESSION;
      return jsonResponse(201, { object: 'site.user', user: { id: 'user_FAKE' } }, [['set-cookie', SESSION_COOKIES[0]], ['set-cookie', SESSION_COOKIES[1]],
        ['set-cookie', SESSION_COOKIES[2]], ['set-cookie', SESSION_COOKIES[3]], ['set-cookie', SESSION_COOKIES[4]]]);
    }
    if (request.method === 'POST' && path === '/v1/playback/resolve-line') {
      state.resolveLines++;
      if (!session || header('cookie') !== session) {
        return jsonResponse(401, { statusCode: 401, code: 'playback_user_session_required', state: 'login_required', message: '该内容需要登录后播放' });
      }
      if (official.error) return jsonResponse(official.error.status, official.error.body);
      return jsonResponse(201, { object: 'playback.line.resolve', line: official.line, quota_delta: { used_tokens: 72000 }, view: 'compact' });
    }

    const query = url.searchParams;
    if (request.method === 'GET' && path === '/v1/browse/catalog') {
      const found = searches[query.get('q')];
      const cards = Array.isArray(found) ? found : (found ? found.cards : []);
      return jsonResponse(200, { object: 'catalog.search', request: { q: query.get('q') }, cards, pagination: { page: 1, limit: Number(query.get('limit')), returned_count: cards.length, has_more: false } });
    }
    const detail = /^\/v1\/catalog\/([^/]+)\/detail$/.exec(path);
    if (detail && request.method === 'GET') return details[decodeURIComponent(detail[1])] ? jsonResponse(200, details[decodeURIComponent(detail[1])]) : jsonResponse(404, { statusCode: 404, code: 'catalog_not_found' });
    const list = /^\/v1\/catalog\/([^/]+)\/episodes$/.exec(path);
    if (list && request.method === 'GET') return episodes[decodeURIComponent(list[1])] ? jsonResponse(200, episodes[decodeURIComponent(list[1])]) : jsonResponse(404, { statusCode: 404, code: 'catalog_not_found' });
    const play = /^\/v1\/playback\/resolve\/([^/]+)$/.exec(path);
    if (play && request.method === 'GET') {
      const token = decodeURIComponent(play[1]);
      return resolves[token] ? jsonResponse(200, resolves[token]) : jsonResponse(404, { statusCode: 404, code: 'playback_token_not_found' });
    }
    return jsonResponse(404, { statusCode: 404, code: 'not_found', message: 'not found' });
  };
  return { handler, state };
}

// `key` is what the host injects as TMDB_API_KEY; fixtures maps "<movie|tv>/<id>" to a payload.
export function fakeTmdb(options = {}) {
  const key = options.key === undefined ? 'FAKE_TMDB_V3_KEY_0123456789abcdef' : options.key;
  const fixtures = options.fixtures || {};
  const state = { calls: [], fixture: 0, missed: 0 };
  const handler = (request, url = new URL(request.url)) => {
    if (url.origin !== TMDB_HOST) return null;
    state.calls.push(url.pathname + url.search);
    if (options.intercept) { const hit = options.intercept(request, url); if (hit) return hit; }
    const auth = (request.lower && request.lower.get('authorization')) || request.headers.get('authorization');
    const given = auth ? auth.replace(/^Bearer\s+/i, '') : url.searchParams.get('api_key');
    if (!key) return jsonResponse(401, { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.', success: false });
    if (given !== key) return jsonResponse(401, { status_message: 'Invalid API key: You must be granted a valid key.', success: false });
    const match = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    const payload = match ? fixtures[match[1] + '/' + match[2]] : undefined;
    if (!payload) {
      state.missed++;
      return jsonResponse(match ? 404 : 401, { status_code: match ? 34 : 7, status_message: match ? 'The resource you requested could not be found.' : 'Invalid API key', success: false });
    }
    state.fixture++;
    return jsonResponse(200, payload);
  };
  return { handler, state, key };
}

export function randomHex(byteCount) {
  return randomBytes(byteCount).toString('hex');
}
