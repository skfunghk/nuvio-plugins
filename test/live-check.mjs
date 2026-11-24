// Live run of the real plugin against the live site, on the code path the device runs: the
// plugin file, inside Nuvio's own polyfill and call code (see mock-host.mjs), with curl standing
// in for OkHttp (see transport.mjs).
//
//   node test/live-check.mjs                 default entry ("kanju"): a film and a series episode.
//                                           No guest session is created and no quota is spent.
//   node test/live-check.mjs --official      the opt-in entry ("kanju-official") only, once: creates
//                                           or reuses ONE guest identity and resolves ONE official
//                                           ticket, which spends that guest's playback quota.
//   TMDB_API_KEY=… node test/live-check.mjs  ask the real TMDB API; without it a stand-in serves the
//                                           saved payloads in fixtures/tmdb (only that step is faked).
//
// What is live: kanju44.com / kanju.ai (home page, runtime chunk, signed /v1 requests, playback
// resolve) and the first 4 KiB of every URL the plugin returns. What is not: Nuvio's app, the
// QuickJS engine, OkHttp. Tokens and signatures are masked in the output; nothing is written.

import { findSourcesDir, loadGlue } from './host-glue.mjs';
import { PLUGIN_PATH, readPlugin, runPlugin } from './mock-host.mjs';
import { compositeTransport, curlTransport, probeMedia } from './transport.mjs';
import { fakeTmdb, readJson } from './fakes.mjs';

const WITH_OFFICIAL = process.argv.includes('--official');
const REAL_TMDB_KEY = (process.env.TMDB_API_KEY || '').trim();
const STANDIN_TMDB_KEY = 'LIVE_CHECK_TMDB_STAND-IN_NOT_A_REAL_KEY';
// Fixed on purpose: the plugin derives the guest id from the scraper id, so every run maps to the
// same guest instead of minting a new one (and a new quota) each time.
const OFFICIAL_SCRAPER_ID = '00000000-0000-0000-0000-000000000000:kanju-official';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!findSourcesDir()) {
  console.error('Nuvio sources not found: set NUVIO_SOURCES (see test/host-glue.mjs).');
  process.exit(2);
}
const glue = loadGlue();
const code = readPlugin();

// ------------------------------------------------------------------ what gets printed

// Host, path and query names only. Ids are shortened, every value but x-expires is dropped.
function shape(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return String(url).slice(0, 60); }
  const path = parsed.pathname.replace(/av_[A-Za-z0-9_-]{6,}/g, (id) => 'av_' + id.slice(3, 7) + '…');
  const query = [...parsed.searchParams.keys()].map((key) => key === 'x-expires' ? key + '=' + parsed.searchParams.get(key) : key + '=…');
  return parsed.host + path + (query.length ? '?' + query.join('&') : '');
}

function lineSummary(line) {
  return {
    provider_id: line.provider_id, label: line.label, url_kind: line.url_kind, mime_type: line.mime_type || null,
    resolve_mode: line.resolve_mode, minimum_user_level: line.minimum_user_level, selected: !!line.selected,
    url: shape(line.url),
  };
}

// The two answers worth reading in full, reduced to what the report needs.
function summarize(data, url) {
  if (!data || typeof data !== 'object') return { url: shape(url), body: 'not an object' };
  if (Array.isArray(data.line_options)) {
    const byKind = {};
    for (const line of data.line_options) byKind[line.url_kind + '/' + line.resolve_mode] = (byKind[line.url_kind + '/' + line.resolve_mode] || 0) + 1;
    const pick = data.line_options.find((line) => line.selected) || null;
    return {
      answer: 'playback.resolve', lines: data.line_options.length, by_kind: byKind,
      not_offered_to_guests: data.line_options.filter((line) => Number(line.minimum_user_level) > 0).length,
      selected: pick ? lineSummary(pick) : null,
      direct: data.line_options.filter((line) => line.url_kind !== 'resolve_ticket' && Number(line.minimum_user_level) <= 0).slice(0, 3).map(lineSummary),
    };
  }
  if (data.object === 'playback.line.resolve') {
    return { answer: 'playback.line.resolve', line: data.line ? lineSummary(data.line) : null, quota_delta: data.quota_delta || null, error: null };
  }
  if (data.object === 'site.user') return { answer: 'site.user (guest session created)', user_id: String((data.user && data.user.id) || '').slice(0, 9) + '…' };
  return { answer: data.code ? 'error ' + data.code : (data.object || 'other') };
}

// ------------------------------------------------------------------ transport

const curl = curlTransport({ connectTimeout: 20, maxTime: 45 });
const tmdbStandIn = REAL_TMDB_KEY ? null : fakeTmdb({
  key: STANDIN_TMDB_KEY,
  fixtures: { 'movie/603': readJson('tmdb/movie/603.json'), 'tv/1399': readJson('tmdb/tv/1399.json') },
});
const live = compositeTransport(tmdbStandIn ? [tmdbStandIn.handler] : [], curl);

let notes = [];       // one line per request of the current run
let answers = [];     // reduced bodies of the playback answers of the current run
function record(raw, request, started) {
  notes.push({
    method: request.method, url: shape(request.url), status: raw.status, bytes: raw.bodyBytes.length,
    ms: Date.now() - started, cookie: !!request.lower.get('cookie'),
  });
  if (/\/v1\/(playback\/resolve|users)/.test(request.url)) {
    try { answers.push(summarize(JSON.parse(raw.bodyBytes.toString('utf8')), request.url)); } catch { /* not JSON: the status line says enough */ }
  }
  return raw;
}
const transport = {
  name: 'live',
  send(request) { const started = Date.now(); return record(live.send(request), request, started); },
  async sendAsync(request) { const started = Date.now(); return record(await live.sendAsync(request), request, started); },
};

// ------------------------------------------------------------------ one run

async function runCase(label, profile, args, more = {}) {
  notes = [];
  answers = [];
  const result = await runPlugin({ glue, profile, code, transport, args, tmdbApiKey: REAL_TMDB_KEY || STANDIN_TMDB_KEY, ...more });
  const entry = more.scraperId ? more.scraperId.split(':').pop() : 'kanju';
  console.log('\n== ' + label + '   [' + profile + ' host profile, entry "' + entry + '"]');
  for (const log of result.logs) console.log('   plugin ' + log.level.padEnd(5) + log.line);
  console.log('   requests (' + notes.length + '):');
  for (const note of notes) {
    console.log('     ' + note.method.padEnd(5) + String(note.status).padEnd(5) + String(note.bytes).padStart(8) + ' B' + String(note.ms).padStart(7) + ' ms '
      + (note.cookie ? 'with session cookie  ' : '') + note.url);
  }
  for (const answer of answers) console.log('   ' + JSON.stringify(answer));
  console.log('   streams returned: ' + result.streams.length + '   (' + result.elapsedMs + ' ms, host timeout hit: ' + result.timedOut + ')');

  const probes = [];
  console.log('   play-head probe, first 4 KiB of each URL:');
  for (const stream of result.streams) {
    const probe = await probeMedia(stream.url, curl);
    // A playlist or an MP4 box is media; an image, an HTML page or an error is not.
    const media = probe.ok && /^(hls-|mp4)/.test(probe.kind);
    const status = probe.status ? 'HTTP ' + probe.status : 'FAILED ' + (probe.detail || '');
    probes.push({ name: stream.name, media, status, kind: probe.kind, type: probe.type || '', first_bytes: probe.firstBytes || '', url: shape(stream.url) });
    console.log('     ' + (media ? 'media     ' : 'NOT media ') + status.padEnd(46) + probe.kind.padEnd(13) + JSON.stringify(stream.name) + '  ' + shape(stream.url));
    if (probe.ok) console.log('               first bytes: ' + JSON.stringify(probe.firstBytes));
    await pause(300);
  }
  return { result, notes, probes };
}

// ------------------------------------------------------------------ main

console.log('live check ' + new Date().toISOString() + '   plugin ' + PLUGIN_PATH + '   v' + pluginVersion());
console.log('TMDB step: ' + (REAL_TMDB_KEY ? 'real API (key from TMDB_API_KEY)' : 'stand-in with the saved fixtures (no TMDB key set)'));

function pluginVersion() {
  // Read as text: the plugin is only ever evaluated inside the mock host.
  return /var VERSION = '([^']+)'/.exec(code)[1];
}

const CASES = [
  ['film 603 — The Matrix, the id both Nuvio "Test" buttons use', 'tv', ['603', 'movie', null, null]],
  ['series 1399 S1E1 — Game of Thrones', 'tv', ['1399', 'tv', 1, 1]],
  ['film 603 again, through the NuvioMobile host profile (async fetch, timers)', 'mobile', ['603', 'movie', undefined, undefined]],
];

let failed = false;
const totals = [];
const count = (list, test) => list.filter(test).length;
const tally = (label, { result, notes: requests, probes }) => {
  // "ok": the site answered every request, the host timeout was not hit, and at least one returned
  // URL really is a playlist or an MP4. Lines this machine cannot reach do not fail the run.
  const site = requests.filter((note) => !note.url.startsWith('api.themoviedb.org'));
  const playable = count(probes, (probe) => probe.media);
  const ok = !result.timedOut && playable > 0 && site.every((note) => note.status < 400);
  if (!ok) failed = true;
  totals.push({
    case: label, streams: result.streams.length, site_requests: site.length,
    playable: playable,
    region_denied_403: count(probes, (probe) => probe.status === 'HTTP 403'),
    no_reply: count(probes, (probe) => /FAILED/.test(probe.status)),
    ok,
  });
};

if (WITH_OFFICIAL) {
  // One guest identity (see OFFICIAL_SCRAPER_ID), one ticket: the minimum that shows what the
  // site gives a guest for an official line.
  // A series episode: on 2026-11-24 the film 603 had no official line at all (19 direct lines only),
  // while this episode listed six official tickets.
  const run = await runCase('opt-in entry "kanju-official", series 1399 S1E1', 'tv', ['1399', 'tv', 1, 1], { scraperId: OFFICIAL_SCRAPER_ID });
  tally('kanju-official entry, series 1399 S1E1', run);
  const answer = answers.find((item) => item.answer === 'playback.line.resolve');
  const error = answers.find((item) => /^error/.test(item.answer));
  // The official line, when resolved, is always the first stream the plugin returns.
  Object.assign(totals[0], {
    guest_session_created: notes.some((note) => note.url.endsWith('/v1/users/anonymous') && note.status < 300),
    official_answer: answer && answer.line ? answer.line : (error ? error : { answer: 'none' }),
    quota_spent: answer && answer.quota_delta ? answer.quota_delta : null,
    // When an official line is resolved it is the first stream the plugin returns.
    official_url_probe: answer && answer.line ? (run.probes[0] || null) : null,
  });
} else {
  for (const [label, profile, args] of CASES) {
    tally(label.split(',')[0], await runCase(label, profile, args));
    await pause(1500);
  }
}

console.log('\nSUMMARY ' + JSON.stringify({ when: new Date().toISOString(), tmdb: REAL_TMDB_KEY ? 'real' : 'stand-in', runs: totals }));
console.log(failed ? 'RESULT: FAIL (see above)'
  : 'RESULT: PASS (' + (WITH_OFFICIAL ? 'the opt-in entry returned media URLs' : 'every run returned media URLs') + ' from the live site)');
process.exit(failed ? 1 : 0);
