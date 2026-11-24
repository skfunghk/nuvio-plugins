// The scripted sites used by the offline tests: Kanju answering from the captured fixtures in
// fixtures/kanju, TMDB from the hand-written payloads in fixtures/tmdb. Shared by run-tests.js
// and quickjs-run.mjs.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonResponse, scriptedTransport } from './transport.mjs';
import { fakeKanju, fakeTmdb, readJson } from './fakes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const KANJU = 'https://kanju44.com';
export const TMDB_KEY = 'FAKE_TMDB_V3_KEY_0123456789abcdef';

export const SEARCH = {};
for (const q of ['权力的游戏', '黑客帝国', '流浪地球', '千与千寻']) SEARCH[q] = readJson('kanju/search-' + q + '.json');
export const DETAIL = readJson('kanju/detail-got.json');
export const MATRIX = SEARCH['黑客帝国'].cards.find((card) => card.title === '黑客帝国' && card.year === 1999);
export const MOVIE_RESOLVE = readJson('kanju/resolve-wandering-earth.json');

export const TMDB_FIXTURES = {};
for (const file of ['movie/603', 'movie/129', 'movie/9000001', 'tv/1399', 'tv/1429']) TMDB_FIXTURES[file] = readJson('tmdb/' + file + '.json');

export function labelOf(providerId) {
  return MOVIE_RESOLVE.line_options.find((line) => line.provider_id === providerId).label;
}

// The six zero-cost lines the plugin returns for either captured resolve, most preferred first.
export const TOP_DIRECT = MOVIE_RESOLVE.line_options.filter((line) => line.url_kind !== 'resolve_ticket')
  .sort((a, b) => b.preference_weight - a.preference_weight).slice(0, 6).map((line) => line.provider_id);

// The site's answer for a film's official line. The ".image" ending is the real shape of that
// URL (checked live on 2026-11-24: the server answers video/mp4, 1.4 GB, an ISO-BMFF header).
export function officialLine(expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  return {
    id: 'playback:yj:official', provider_id: 'official-r', label: '1080P-官方R · 普通话', url_kind: 'mp4', resolved: true,
    resolve_mode: 'parse', resolve_required: false, preference_weight: 999, minimum_user_level: 0, selected: true,
    url: 'https://media.example.invalid/official/video.image?x-expires=' + expiresAt,
  };
}

export function kanjuWorld() {
  const gotCard = SEARCH['权力的游戏'].cards.find((card) => card.title === '权力的游戏 第1季' && card.content_kind === 'series');
  const gotEpisodes = readJson('kanju/episodes-got-s1.json');
  const gotResolve = readJson('kanju/resolve-got-s1e1.json');
  const movieEpisodes = readJson('kanju/episodes-wandering-earth.json');

  const details = { [gotCard.id]: DETAIL };
  const episodes = {};
  const resolves = {};
  for (const season of DETAIL.seasons) episodes[season.variant_id] = gotEpisodes;
  for (const entry of gotEpisodes.episodes) resolves[entry.token] = gotResolve;
  for (const entry of movieEpisodes.episodes) resolves[entry.token] = MOVIE_RESOLVE;
  // Every other card (single-season series and movies) answers with the movie fixture.
  const seen = new Set();
  for (const q of Object.keys(SEARCH)) {
    for (const card of SEARCH[q].cards) {
      const variantId = card.selected_variant_id || card.id;
      if (variantId && !seen.has(variantId) && (card.seasons || []).length <= 1 && !episodes[variantId]) {
        seen.add(variantId);
        episodes[variantId] = movieEpisodes;
      }
    }
  }
  return { searches: SEARCH, details, episodes, resolves };
}

// options.kanju / options.tmdbKey / options.tmdbIntercept / options.transport are passed through.
export function world(options = {}) {
  const kanju = fakeKanju({ ...kanjuWorld(), ...options.kanju });
  const tmdb = fakeTmdb({ key: options.tmdbKey === undefined ? TMDB_KEY : options.tmdbKey, fixtures: TMDB_FIXTURES, intercept: options.tmdbIntercept });
  const transport = options.transport || scriptedTransport((request) => tmdb.handler(request) || kanju.handler(request)
    || jsonResponse(404, { error: 'unhandled', url: request.url }));
  return { transport, kanju, tmdb };
}

export const fixturePath = (...parts) => join(HERE, 'fixtures', ...parts);
