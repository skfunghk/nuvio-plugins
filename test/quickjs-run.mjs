// The plugin inside the real QuickJS engine, on the same glue as mock-host.mjs: Nuvio's own
// polyfill, module wrapper and call code (read from the Nuvio sources), under both host profiles,
// against the scripted sites in offline-world.mjs.
//
//   npm install --no-save quickjs-emscripten@0.32.0     test-only dependency; the plugin never uses it
//   node test/quickjs-run.mjs
//
// mock-host.mjs runs the plugin in Node's own engine (V8) and leaves out only the JS engine. This
// puts that engine back: QuickJS parses and runs the plugin, its async/await and promise queue,
// and the polyfills behave as they do under QuickJS. Every scenario is also run through
// mock-host.mjs, and the two engines must return the same streams.
//
// What is still not the device: the QuickJS build Nuvio embeds (com.dokar.quickjs) and its
// bindings, crypto-js, OkHttp / Ktor, the hosts' thread model and memory limits. The wall-clock
// limit and the 1 MiB body cap are applied here as the hosts apply them.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findSourcesDir, loadGlue } from './host-glue.mjs';
import { PLUGIN_PATH, parseUrl, readPlugin, runPlugin } from './mock-host.mjs';
import { createNativeFetch, cryptoBridge } from './native-fetch.mjs';
import { jsonResponse } from './transport.mjs';
import * as offlineWorld from './offline-world.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFFICIAL_SCRAPER_ID = 'x:kanju-official';

async function loadQuickJs() {
  // A normal install first, then the copy this workspace keeps outside the plugin folder.
  const candidates = [process.env.QUICKJS_EMSCRIPTEN, 'quickjs-emscripten', join(HERE, '..', '..', 'deps', 'node_modules', 'quickjs-emscripten', 'dist', 'index.mjs')].filter(Boolean);
  const problems = [];
  for (const candidate of candidates) {
    try {
      const module = await import(candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate);
      return { QuickJS: await module.getQuickJS(), isFail: module.isFail };
    } catch (error) { problems.push(candidate + ' — ' + (error.code || error.message)); }
  }
  throw new Error('quickjs-emscripten could not be loaded (npm install --no-save quickjs-emscripten@0.32.0):\n  ' + problems.join('\n  '));
}

// One plugin call, the way the hosts make it: a fresh runtime and context, the host functions,
// polyfill, the wrapped plugin, the call code, then the promise queue until the result is captured.
async function runInQuickJs({ QuickJS, isFail }, glue, { profile, code, transport, args, scraperId, scraperSettings, tmdbApiKey, timeoutMs }) {
  const runtime = QuickJS.newRuntime();
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);     // PLUGIN_TIMEOUT_MS, as on the hosts
  const vm = runtime.newContext();
  const describe = (error) => { const value = vm.dump(error); return value && value.message ? value.name + ': ' + value.message : String(value); };

  const logs = [];
  const requests = [];
  const pending = new Set();
  let captured = null;
  let loadError = null;
  let jobError = null;
  let timedOut = false;
  const nativeFetch = createNativeFetch(transport, profile, requests);

  const define = (object, name, implementation) => {
    const handle = vm.newFunction(name, implementation);
    vm.setProp(object, name, handle);
    handle.dispose();
  };
  // Argument handles live only until the callback returns, so they are read before anything else.
  const text = (handle, fallback) => (vm.typeof(handle) === 'undefined' ? fallback : vm.getString(handle));
  const fetchArgs = (handles) => [
    text(handles[0], ''), text(handles[1], 'GET'), text(handles[2], '{}'), text(handles[3], 'none'), text(handles[4], ''),
    text(handles[5], 'true').toLowerCase() !== 'false',                     // PluginRuntime.kt / FetchBridge.kt defaults
  ];

  let running = false;
  function pump() {
    if (running) return;                                                      // never re-enter the engine from a host callback
    running = true;
    try {
      while (runtime.hasPendingJob()) {
        const result = runtime.executePendingJobs();
        if (isFail(result)) jobError = describe(result.error);
        result.dispose();
        if (jobError) break;
      }
    } catch (error) {
      jobError = String((error && error.message) || error);
    } finally {
      running = false;
    }
  }
  const pumpSoon = () => setImmediate(pump);
  function settle(deferred, value) {
    if (!pending.has(deferred)) return;
    pending.delete(deferred);
    deferred.resolve(value);
    value.dispose();
    pumpSoon();
  }
  const neverSettled = () => { for (const deferred of pending) deferred.dispose(); pending.clear(); };

  // ---- what the hosts bind (PluginRuntime.kt on NuvioTV; HostFunctions, FetchBridge, CryptoBridge on NuvioMobile)
  define(vm.global, '__get_scraper_id', () => vm.newString(scraperId));
  define(vm.global, '__get_scraper_settings', () => vm.newString(JSON.stringify(scraperSettings)));
  define(vm.global, '__get_tmdb_api_key', () => vm.newString(tmdbApiKey));
  define(vm.global, '__get_call_args', () => vm.newString(JSON.stringify({ tmdbId: String(args[0]), mediaType: args[1], season: args[2] ?? null, episode: args[3] ?? null })));
  define(vm.global, '__capture_result', (json) => { captured = text(json, '[]'); return vm.undefined; });
  define(vm.global, '__parse_url', (url) => vm.newString(parseUrl(text(url, ''))));
  if (profile === 'tv') {
    // NuvioTV binds a plain function: the engine waits while the request is made.
    define(vm.global, '__native_fetch', (...handles) => vm.newString(nativeFetch(...fetchArgs(handles))));
  } else {
    // NuvioMobile binds a suspending function: the engine gets a promise and is free meanwhile.
    define(vm.global, '__native_fetch', (...handles) => {
      const call = fetchArgs(handles);
      const deferred = vm.newPromise();
      pending.add(deferred);
      nativeFetch(...call).then((json) => settle(deferred, vm.newString(json)), (error) => settle(deferred, vm.newString(JSON.stringify({
        ok: false, status: 0, statusText: String((error && error.message) || error), url: call[0], body: '', bodyBase64: '', headers: {},
      }))));
      return deferred.handle;
    });
    define(vm.global, '__plugin_sleep', (ms) => {
      const duration = Math.max(0, Math.min(60000, Number(text(ms, '0')) || 0));          // HostFunctions.kt
      const deferred = vm.newPromise();
      pending.add(deferred);
      setTimeout(() => settle(deferred, vm.undefined), duration);
      return deferred.handle;
    });
    for (const [name, implementation] of Object.entries(cryptoBridge())) {
      define(vm.global, name, (...handles) => vm.newString(String(implementation(...handles.map((handle) => text(handle, ''))))));
    }
  }
  // The HTML bridge. This plugin never parses HTML; the functions exist so the polyfills load.
  const html = { __cheerio_load: 'unused', __cheerio_select: '[]', __cheerio_find: '[]', __cheerio_text: '', __cheerio_html: '', __cheerio_inner_html: '', __cheerio_attr: '__UNDEFINED__', __cheerio_next: '__NONE__', __cheerio_prev: '__NONE__' };
  for (const [name, answer] of Object.entries(html)) define(vm.global, name, () => vm.newString(answer));
  const consoleObject = vm.newObject();
  for (const level of ['log', 'error', 'warn', 'info', 'debug']) {
    define(consoleObject, level, (...handles) => { logs.push({ level, line: handles.map((handle) => text(handle, 'undefined')).join(' ') }); return vm.undefined; });
  }
  vm.setProp(vm.global, 'console', consoleObject);
  consoleObject.dispose();

  const started = Date.now();
  const evaluate = (source, filename) => {
    const result = vm.evalCode(source, filename);
    if (isFail(result)) { loadError = describe(result.error); result.dispose(); return false; }
    result.dispose();
    return true;
  };
  if (evaluate(glue[profile].polyfill, profile + '-polyfill.js')
    && evaluate(glue.wrapper.replace('__PLUGIN_CODE__', () => code), 'plugin.js')) {
    evaluate(glue[profile].callCode, 'call.js');
  }
  if (!loadError && captured === null && jobError === null) {
    pump();
    // The engine only moves when a host callback resolves a promise; watch for the captured result.
    const until = Date.now() + timeoutMs;
    while (captured === null && jobError === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    timedOut = captured === null && jobError === null;
  }
  neverSettled();
  let streams = [];
  try { streams = JSON.parse(captured || '[]'); } catch { streams = []; }
  if (!Array.isArray(streams)) streams = [];
  vm.dispose();
  runtime.dispose();
  return { engine: 'QuickJS', profile, streams, logs, requests, elapsedMs: Date.now() - started, timedOut, loadError, jobError };
}

// ---------------------------------------------------------------------------------------------- scenarios

const unknownOfficial = () => ({
  ...offlineWorld.officialLine(), provider_id: 'bytedance', label: '高清-官方B · 普通话', url_kind: 'unknown',
  url: 'https://media.example.invalid/official/video?br=1&mime_type=video_mp4&cs=2',
});
const MOVIE = { tv: ['603', 'movie', null, null], mobile: ['603', 'movie', undefined, undefined] };
const SERIES = (season, episode) => ({ tv: ['1399', 'tv', season, episode], mobile: ['1399', 'tv', season, episode] });

const SCENARIOS = [
  { name: 'film: TMDB id -> titles -> site search -> 正片 -> resolve', args: MOVIE, setup: () => offlineWorld.world(), expect: [{ streams: 6 }] },
  { name: 'series: multi-season card -> detail -> season 3 -> episode 1 -> resolve', args: SERIES(3, 1), setup: () => offlineWorld.world(), expect: [{ streams: 6 }, (result) => result.streams.every((stream) => stream.title === '权力的游戏 第3季 · 第1集 · kanju44.com')] },
  {
    name: 'official entry: 401 -> guest session -> cookie relayed -> official line, then direct lines', args: SERIES(1, 1), scraperId: OFFICIAL_SCRAPER_ID,
    setup: () => offlineWorld.world({ kanju: { official: { line: offlineWorld.officialLine() } } }),
    expect: [{ streams: 7, sessions: 1, badSignatures: 0 }, (result) => result.streams[0].name === '权力的游戏 第1季 · 1080P-官方R'],
  },
  {
    name: 'official entry: official line of kind "unknown" kept through its mime_type query', args: SERIES(1, 1), scraperId: OFFICIAL_SCRAPER_ID,
    setup: () => offlineWorld.world({ kanju: { official: { line: unknownOfficial() } } }),
    expect: [{ streams: 7 }, (result) => result.streams[0].url === unknownOfficial().url],
  },
  {
    name: 'dropped connection on the first request -> one retry (timers on mobile, busy wait on NuvioTV)', args: MOVIE,
    setup: () => { let dropped = false; return offlineWorld.world({ kanju: { intercept: (request, url) => { if (url.pathname === '/' && !dropped) { dropped = true; throw new Error('Connection reset'); } return null; } } }); },
    expect: [{ streams: 6 }],
  },
  {
    name: 'mirror fail-over: kanju44.com answers 503 -> kanju.ai', args: MOVIE,
    setup: () => offlineWorld.world({ kanju: { intercept: (request, url) => (url.origin === 'https://kanju44.com' ? jsonResponse(503, 'down') : null) } }),
    expect: [{ streams: 6 }, (result) => result.streams.every((stream) => stream.title === '黑客帝国 · kanju.ai')],
  },
  {
    name: 'changed site: no signing key on either mirror -> nothing signed', args: MOVIE,
    setup: () => offlineWorld.world({ kanju: { chunk: '/* no key here */', main: '/* no runtime chunk reference */' } }),
    expect: [{ streams: 0, signedRequests: 0 }, (result) => result.logs.some((entry) => entry.line.includes('UPSTREAM_CHANGED: 站点请求模块已变化'))],
  },
  { name: 'refused argument: a kitsu id', args: { tv: ['kitsu:6448', 'tv', 1, 1], mobile: ['kitsu:6448', 'tv', 1, 1] }, setup: () => offlineWorld.world(), expect: [{ streams: 0, requests: 0 }] },
];

// ---------------------------------------------------------------------------------------------- main

if (!findSourcesDir()) {
  console.error('Nuvio sources not found: set NUVIO_SOURCES (see test/host-glue.mjs).');
  process.exit(2);
}
const QuickJs = await loadQuickJs();
const glue = loadGlue();
const code = readPlugin();
const DEFAULT_SCRAPER_ID = '00000000-0000-0000-0000-000000000000:kanju';
console.log('plugin ' + PLUGIN_PATH);
console.log('engine  QuickJS, quickjs-emscripten WASM build;   glue from NuvioTV ' + glue.commits.tv.slice(0, 12) + ' and NuvioMobile ' + glue.commits.mobile.slice(0, 12));

const check = (scenario, result, setup) => {
  const problems = [];
  const state = setup.kanju.state;
  const facts = {
    streams: result.streams.length, requests: result.requests.length, sessions: state.sessions,
    badSignatures: state.badSignatures, signedRequests: state.signedRequests,
  };
  // Each expectation is a set of counts, or a predicate on the result.
  for (const expected of scenario.expect) {
    if (typeof expected === 'function') {
      if (!expected(result)) problems.push('the streams or logs are not what the scenario expects');
      continue;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (facts[key] !== value) problems.push(key + ': expected ' + value + ', got ' + facts[key]);
    }
  }
  if (result.timedOut) problems.push('host timeout hit');
  if (result.loadError) problems.push('did not load: ' + result.loadError);
  if (result.jobError) problems.push('job error: ' + result.jobError);
  return problems;
};

let failed = 0;
let ran = 0;
for (const scenario of SCENARIOS) {
  for (const profile of ['tv', 'mobile']) {
    const options = {
      profile, code, args: scenario.args[profile], scraperId: scenario.scraperId || DEFAULT_SCRAPER_ID,
      tmdbApiKey: offlineWorld.TMDB_KEY, timeoutMs: glue[profile].timeoutMs,
    };
    const v8Setup = scenario.setup();
    const qjsSetup = scenario.setup();
    const v8 = await runPlugin({ ...options, glue, transport: v8Setup.transport });
    const qjs = await runInQuickJs(QuickJs, glue, { ...options, transport: qjsSetup.transport, scraperSettings: {} });
    ran++;
    const problems = check(scenario, qjs, qjsSetup);
    if (JSON.stringify(qjs.streams) !== JSON.stringify(v8.streams)) problems.push('QuickJS and V8 returned different streams');
    if (problems.length) failed++;
    console.log((problems.length ? '✖' : '✔') + ' [' + profile.padEnd(6) + '] ' + scenario.name + '   ' + qjs.streams.length + ' streams, ' + qjs.requests.length + ' requests, ' + qjs.elapsedMs + ' ms in QuickJS'
      + (problems.length ? '\n    ' + problems.join('\n    ') : ''));
  }
}

// ---- the host contract, read from the engine itself: what a plugin that throws, does not parse,
// or exports nothing gets, and what the realm holds under each polyfill. run-tests.js makes the
// same checks on V8; these are the ones that depend on the engine.
const hostChecks = [];
const hostRun = async (profile, probe, extra = {}) => runInQuickJs(QuickJs, glue, {
  profile, code: probe, transport: offlineWorld.world().transport, args: ['1', 'movie', null, null],
  scraperId: 'x:contract', scraperSettings: {}, tmdbApiKey: '', timeoutMs: 5000, ...extra,
});
for (const profile of ['tv', 'mobile']) {
  const throws = await hostRun(profile, 'module.exports = { getStreams: async function () { throw new Error("boom"); } };');
  hostChecks.push([profile + ': a plugin that throws gives the host "no streams" and an error line',
    throws.streams.length === 0 && throws.logs.some((entry) => entry.level === 'error' && entry.line.includes('getStreams error') && entry.line.includes('boom'))]);
  const broken = await hostRun(profile, 'this is not ( valid javascript');
  hostChecks.push([profile + ': a plugin that does not parse gives the host "no streams"',
    broken.streams.length === 0 && typeof broken.loadError === 'string' && /SyntaxError/.test(broken.loadError)]);
  const none = await hostRun(profile, 'module.exports = {};');
  hostChecks.push([profile + ': a plugin that exports nothing gives the host "no streams" and says why',
    none.streams.length === 0 && none.logs.some((entry) => entry.line.includes('getStreams function not found'))]);
  const probe = await hostRun(profile, 'module.exports = { getStreams: async function () { return [{ url: "https://a.example/x.mp4", name: ['
    + 'typeof fetch, typeof setTimeout, typeof crypto, typeof TextEncoder, typeof URL, typeof require, typeof SCRAPER_ID, typeof TMDB_API_KEY, '
    + 'typeof String.prototype.normalize].join(" ") }]; } };');
  const realm = probe.streams[0] ? probe.streams[0].name : '(no result) ' + (probe.loadError || probe.jobError || '');
  // fetch, setTimeout, crypto, TextEncoder, URL, require, SCRAPER_ID, TMDB_API_KEY — then
  // String.prototype.normalize, which is only measured: the plugin does not depend on it.
  const expected = {
    tv: 'function undefined undefined undefined function function string string',
    mobile: 'function function object function function function string string',
  }[profile];
  const described = realm.split(' ');
  hostChecks.push([profile + ': the realm holds what the polyfill defines — [' + described.slice(0, 8).join(' ') + ']',
    described.slice(0, 8).join(' ') === expected]);
  console.log('[' + profile.padEnd(6) + '] String.prototype.normalize in this engine: ' + described[8]);
}
for (const [label, ok] of hostChecks) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? '✔' : '✖') + ' ' + label);
}

console.log('\n' + (ran - failed) + ' of ' + ran + ' runs passed inside QuickJS; every scenario returned the same streams as the V8 mock host.');
process.exit(failed ? 1 : 0);
for (const [label, ok] of hostChecks) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? '✔' : '✖') + ' ' + label);
}

console.log('\n' + (ran - failed) + ' of ' + ran + ' runs passed inside QuickJS; every scenario returned the same streams as the V8 mock host.');
process.exit(failed ? 1 : 0);
