// A small local stand-in for Nuvio's plugin host.
//
// What is reproduced from the hosts (see test/host-glue.mjs for where the JS comes from):
//   1. a fresh JS realm per run with ONLY the globals Nuvio defines — no fetch, timers, TextEncoder
//      or crypto of Node's own;
//   2. Nuvio's polyfill, evaluated verbatim, with `__native_fetch` bound to the emulation in
//      native-fetch.mjs (blocking for NuvioTV, promise-based for NuvioMobile);
//   3. the CommonJS wrapper and the getStreams call code, evaluated verbatim;
//   4. the caller's behaviour on NuvioTV: a 60 s timeout, an exception meaning "no streams",
//      and the same reading of the returned JSON (PluginRuntime.parseJsonResults).
// What is NOT reproduced: the QuickJS engine (see quickjs-run.mjs for a run inside real QuickJS),
// crypto-js / cheerio, and OkHttp itself.
//
//   const run = await runPlugin({ glue, profile: 'tv', code, transport, args: ['603', 'movie', null, null] });

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createNativeFetch, cryptoBridge } from './native-fetch.mjs';

export const PLUGIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'kanju', 'kanju.js');

export function readPlugin(path = PLUGIN_PATH) {
  return readFileSync(path, 'utf8');
}

// Same reading of the plugin's JSON as PluginRuntime.kt parseJsonResults / PluginRuntime.kt
// (mobile) parseJsonResults: an item without a usable url is dropped, blank strings are dropped.
export function hostResults(array) {
  const clean = (value) => (typeof value === 'string' || typeof value === 'number') && String(value).trim() && !String(value).includes('[object') ? String(value) : null;
  return array.filter((item) => item && typeof item === 'object').map((item) => {
    const url = typeof item.url === 'string' ? clean(item.url)
      : (item.url && typeof item.url === 'object' ? clean(item.url.url) : null);
    if (!url) return null;
    const out = { title: clean(item.title) || clean(item.name) || 'Unknown', name: clean(item.name), url, quality: clean(item.quality) };
    for (const key of ['size', 'language', 'provider', 'type']) out[key] = clean(item[key]);
    out.seeders = typeof item.seeders === 'number' ? item.seeders : null;
    out.peers = typeof item.peers === 'number' ? item.peers : null;
    out.infoHash = clean(item.infoHash);
    out.subtitles = Array.isArray(item.subtitles) ? item.subtitles.length : 0;
    return out;
  }).filter(Boolean);
}

export function parseUrl(urlString) {
  try {
    const u = new URL(urlString);
    const explicitPort = u.port;
    return JSON.stringify({
      protocol: u.protocol, host: u.host, hostname: u.hostname, port: explicitPort,
      pathname: u.pathname || '/', search: u.search, hash: u.hash,
    });
  } catch {
    return JSON.stringify({ protocol: '', host: '', hostname: '', port: '', pathname: '/', search: '', hash: '' });
  }
}

export async function runPlugin(options) {
  const { glue, profile, code, transport } = options;
  if (!glue) throw new Error('glue is required (loadGlue from host-glue.mjs)');
  const [tmdbId, mediaType, season, episode] = options.args;
  const scraperId = options.scraperId === undefined ? '00000000-0000-0000-0000-000000000000:kanju' : options.scraperId;
  const scraperSettings = options.scraperSettings || {};
  const tmdbApiKey = options.tmdbApiKey === undefined ? '' : options.tmdbApiKey;
  const timeoutMs = options.timeoutMs === undefined ? glue[profile].timeoutMs : options.timeoutMs;

  const logs = [];
  const requests = [];
  let closed = false;
  let captured = null;
  let captureResolve;
  const capturedPromise = new Promise((resolve) => { captureResolve = resolve; });

  const nativeFetch = createNativeFetch(transport, profile, requests);
  const sandbox = {
    console: {},
    __native_fetch: (...args) => {
      if (closed) throw new Error('runtime closed');
      return nativeFetch(...args);
    },
    __get_scraper_id: () => scraperId,
    __get_scraper_settings: () => JSON.stringify(scraperSettings),
    __get_tmdb_api_key: () => tmdbApiKey,
    __get_call_args: () => JSON.stringify({ tmdbId: String(tmdbId), mediaType, season: season ?? null, episode: episode ?? null }),
    __capture_result: (json) => { captured = String(json ?? '[]'); captureResolve(captured); return null; },
    __parse_url: (url) => parseUrl(String(url || '')),
    // Not used by this plugin; present so the polyfill loads and fails loudly if that changes.
    __cheerio_load: () => { throw new Error('cheerio is not available in the harness'); },
    __cheerio_select: () => '[]',
    __cheerio_find: () => '[]',
    __cheerio_text: () => '',
    __cheerio_html: () => '',
    __cheerio_inner_html: () => '',
    __cheerio_attr: () => '__UNDEFINED__',
    __cheerio_next: () => '__NONE__',
    __cheerio_prev: () => '__NONE__',
  };
  for (const level of ['log', 'error', 'warn', 'info', 'debug']) {
    sandbox.console[level] = (...args) => { logs.push({ level, line: args.map((value) => (value === undefined ? 'undefined' : value === null ? 'null' : String(value))).join(' ') }); return null; };
  }
  if (profile === 'mobile') {
    sandbox.__plugin_sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(60000, Math.max(0, Number(ms) || 0))));
    Object.assign(sandbox, cryptoBridge());
  }

  const context = vm.createContext(sandbox, { name: 'nuvio-' + profile });
  const started = Date.now();
  let loadError = null;
  try {
    vm.runInContext(glue[profile].polyfill, context, { filename: profile + '-polyfill.js' });
    vm.runInContext(glue.wrapper.replace('__PLUGIN_CODE__', () => code), context, { filename: 'plugin.js' });
  } catch (error) {
    // A plugin that does not even evaluate: the host logs and gets no streams.
    loadError = error;
    captureResolve('[]');
  }
  if (!loadError) {
    // Like the hosts: the call code is an async IIFE; errors inside it are caught by that code.
    try { vm.runInContext(glue[profile].callCode, context, { filename: 'call.js' }); } catch (error) { loadError = error; captureResolve('[]'); }
  }

  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve('[]'); }, timeoutMs);
  });
  let raw = '[]';
  try {
    raw = await Promise.race([capturedPromise, timeout]);
  } finally {
    clearTimeout(timer);
    closed = true;
  }

  let streams = [];
  try { streams = JSON.parse(raw); } catch { streams = []; }
  if (!Array.isArray(streams)) streams = [];
  return {
    profile,
    scraperId,
    args: { tmdbId: String(tmdbId), mediaType, season: season ?? null, episode: episode ?? null },
    streams,                       // exactly what the plugin returned
    results: hostResults(streams), // what the host makes of it
    logs,
    requests,                      // every native fetch the plugin made
    sandbox,                       // the realm's globals, for tests that want to probe them
    elapsedMs: Date.now() - started,
    timedOut,
    loadError: loadError ? String(loadError && loadError.message || loadError) : null,
  };
}
