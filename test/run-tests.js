#!/usr/bin/env node
// Offline tests for kanju.js — no network needed.
//
//   1. pure helpers against published vectors (SHA-256 / HMAC-SHA256, RFC 3986 encoding);
//   2. title matching against search results captured from the live site (see fixtures/README.md);
//   3. the whole plugin run through the local mock host — Nuvio's own polyfill, wrapper and call
//      code, under both host profiles — against scripted Kanju and TMDB stand-ins;
//   4. the repository files Nuvio loads (manifest.json, the opt-in manifest, file references).
//
// Run:  node test/run-tests.js
// The host-glue tests need a checkout of the Nuvio sources (NUVIO_SOURCES); without it they are
// skipped and the output says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findSourcesDir, loadGlue } from './host-glue.mjs';
import { PLUGIN_PATH, readPlugin, runPlugin } from './mock-host.mjs';
import { jsonResponse, scriptedTransport } from './transport.mjs';
import { FAKE_SESSION, fakeMainBundle, fakeRuntimeChunk, readJson } from './fakes.mjs';
import * as offlineWorld from './offline-world.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = require(PLUGIN_PATH);
const I = PLUGIN.internals;

const norm = (text) => text.replace(/\s+/g, ' ').trim();
const kanjuError = (code) => (error) => error && error.name === 'KanjuError' && error.code === code;

// ---------------------------------------------------------------------------------------------- 1. hashes

test('SHA-256 matches Node crypto for empty, block-edge, multi-block and non-ASCII inputs', () => {
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100000]) {
    const text = 'a'.repeat(length);
    assert.equal(I.sha256Hex(text), createHash('sha256').update(text).digest('hex'), 'length ' + length);
  }
  const unicode = '流浪地球 · The Wandering Earth 🌍'.repeat(400);
  assert.equal(I.sha256Hex(unicode), createHash('sha256').update(unicode).digest('hex'));
  // FIPS 180-4 and the empty-string vector.
  assert.equal(I.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(I.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('HMAC-SHA256 matches RFC 4231 and Node crypto, including keys longer than one block', () => {
  // RFC 4231 test case 2 (plain-text key, so it can go through the hex-text entry point).
  assert.equal(I.hmacSha256Hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  for (let i = 0; i < 120; i++) {
    const keyLength = [16, 32, 64, 65, 100, 131][i % 6];
    const key = randomBytes(keyLength).toString('base64url').slice(0, keyLength);
    const message = randomBytes(60).toString('base64url').slice(0, [0, 1, 54, 55, 56, 63, 64, 65, 200, 5000][i % 10]) + '地球🌍';
    const expected = createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(message, 'utf8')).digest('hex');
    assert.equal(I.hmacSha256Hex(key, message), expected, 'case ' + i);
  }
});

// ---------------------------------------------------------------------------------------------- 2. encoding / primitives

test('percentEncode / formEncode: strict RFC 3986, "+" for spaces, lowercase hex, UTF-8', () => {
  assert.equal(I.percentEncode("Ocean's Eleven", true), 'Ocean%27s+Eleven');
  assert.equal(I.percentEncode('Love, Death + Robots', true), 'Love%2c+Death+%2b+Robots');
  assert.equal(I.percentEncode('流浪地球', true), '%e6%b5%81%e6%b5%aa%e5%9c%b0%e7%90%83');     // lowercase, like encodeURIComponent
  assert.equal(I.percentEncode('a~b!c*d(e)f', true), 'a~b%21c%2ad%28e%29f');
  assert.equal(I.percentEncode('Kill Bill: Vol. 1', false), 'Kill%20Bill%3a%20Vol.%201');     // path segment: space is %20
  assert.equal(I.formEncode({ q: 'A B', empty: '', missing: undefined, nil: null, page: 1 }), 'q=A+B&page=1');
  // Nothing is left for OkHttp to rewrite in a query: space and ' " < > are all encoded.
  assert.equal(/[\s'"<>]/.test(I.formEncode({ q: 'it\'s "quoted" <tag> & more' })), false);
});

test('looksTruncated: NuvioMobile marker, NuvioTV cap, multibyte body at the cap', () => {
  assert.equal(I.looksTruncated('x'.repeat(1024 * 1024 - 1)), false);
  assert.equal(I.looksTruncated('x'.repeat(1024 * 1024)), true);
  assert.equal(I.looksTruncated('small\n...[truncated]'), true);
  assert.equal(I.looksTruncated('small'), false);
  assert.equal(I.looksTruncated('流'.repeat(600000)), true);      // 1.8 MB of UTF-8 in 600k chars
  assert.equal(I.looksTruncated('流'.repeat(300000)), false);
  assert.equal(I.utf8Length('aé流🌍'), 10);
});

test('absorbCookies keeps the session cookie out of the joined Set-Cookie header both hosts hand over', () => {
  // Shape seen live on 2026-11-24: four expiring cookies (empty value, "Expires=Thu, 01 Jan …")
  // followed by the real session; the hosts join repeated headers with ",".
  const expiring = (path, domain) => 'ai_movie_session=; Path=' + path + '; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT;' + (domain ? ' Domain=kanju44.com;' : '') + ' Secure';
  const session = 'ai_movie_session=ums_ABC; Path=/; HttpOnly; SameSite=Lax; Max-Age=31535999; Expires=Wed, 24 Nov 2027 04:24:49 GMT; Secure';
  const joined = [expiring('/v1', false), expiring('/v1', true), expiring('/', false), expiring('/', true), session].join(',');
  const mirror = { cookies: {} };
  I.absorbCookies(mirror, { get: (name) => (name === 'set-cookie' ? joined : null) });
  assert.deepEqual(mirror.cookies, { ai_movie_session: 'ums_ABC' });
  const cleared = { cookies: {} };
  I.absorbCookies(cleared, { get: (name) => (name === 'set-cookie' ? joined.slice(0, joined.length - session.length - 1) : null) });
  assert.deepEqual(cleared.cookies, { ai_movie_session: '' });     // an empty value is never sent back
  const none = { cookies: {} };
  I.absorbCookies(none, { get: () => null });
  I.absorbCookies(none, null);
  assert.deepEqual(none.cookies, {});
});

test('fold / compact / baseTitle: entities, full-width forms, season markers, brackets', () => {
  assert.equal(I.fold('Ｋｉｌｌ　Ｂｉｌｌ：Ｖｏｌ．１ &amp; more&#x3000;x'), 'kill bill:vol.1 & more x');
  assert.equal(I.compact('Kill Bill: Vol. 1 — 杀死比尔'), 'killbillvol1杀死比尔');
  assert.equal(I.compact('A  B!'), 'ab');
  assert.equal(norm(I.baseTitle('权力的游戏 Game of Thrones 第1季')), '权力的游戏 game of thrones');
  assert.equal(norm(I.baseTitle('庆余年 第１二季（粤语）')), '庆余年');
  assert.equal(norm(I.baseTitle('Lupin S02')), 'lupin');
  assert.equal(norm(I.baseTitle('Severance Season 2')), 'severance');
  // "Part 1" is kept on purpose: the two halves are different films on TMDB.
  assert.equal(I.compact(I.baseTitle('Harry Potter and the Deathly Hallows: Part 1')), 'harrypotterandthedeathlyhallowspart1');
  assert.equal(I.compact(I.baseTitle('Se7en')), 'se7en');
});

test('seasonFromTitle: Arabic and Chinese numerals, "Season N", "S0N", and what is not a season', () => {
  assert.equal(I.seasonFromTitle('权力的游戏 第1季'), 1);
  assert.equal(I.seasonFromTitle('权力的游戏 第十二季'), 12);
  assert.equal(I.seasonFromTitle('某剧 第二十季'), 20);
  assert.equal(I.seasonFromTitle('某剧 第十季'), 10);
  assert.equal(I.seasonFromTitle('Lupin Season 2'), 2);
  assert.equal(I.seasonFromTitle('Lupin S03'), 3);
  assert.equal(I.seasonFromTitle('进击的巨人 最终季'), null);
  assert.equal(I.seasonFromTitle('流浪地球'), null);
});

test('partMarker and the tagged flag come from bracket groups', () => {
  assert.equal(I.partMarker('赤壁(上)'), 'first');
  assert.equal(I.partMarker('赤壁（下篇）'), 'second');
  assert.equal(I.partMarker('赤壁'), '');
  assert.equal(I.titleParts('庆余年 第1季（粤语）').tagged, true);
  assert.equal(I.titleParts('庆余年 特别版 第1季').tagged, true);
  assert.equal(I.titleParts('庆余年 第1季').tagged, false);
  assert.equal(I.titleParts('庆余年 第1季(2019)').tagged, false);
  assert.equal(I.titleParts('权力的游戏 Game of Thrones 第1季').key, '权力的游戏gameofthrones');
});

// ---------------------------------------------------------------------------------------------- 3. title matching

const infoFor = (pairs, extra = {}) => {
  const info = { titles: pairs.map(([text, rank]) => ({ text, rank })), year: null, seasonYear: null, firstAirYear: null, ...extra };
  return I.indexTitles(info), info;
};
const scoreIn = (info, title, aliases) => I.titleScore(I.titleParts(title), aliases || [], info);

test('titleScore: exact, translated, alternative, bilingual pair, alias, and no match', () => {
  const info = infoFor([['黑客帝国', 1], ['The Matrix', 1], ['駭客任務', 2], ['22世紀殺人網絡', 2], ['Matrix', 3]]);
  assert.equal(scoreIn(info, '黑客帝国'), 100);
  assert.equal(scoreIn(info, 'The Matrix'), 100);
  assert.equal(scoreIn(info, '駭客任務'), 90);
  assert.equal(scoreIn(info, 'matrix'), 80);
  assert.equal(scoreIn(info, '黑客帝国 The Matrix'), 70);
  assert.equal(scoreIn(info, 'The Matrix 黑客帝国'), 70);
  assert.equal(scoreIn(info, '未知片名', ['22世紀殺人網絡']), 50);
  assert.equal(scoreIn(info, '未知片名'), 0);
  assert.equal(scoreIn(info, '二十二世纪杀人网络', ['22世纪杀人网络']), 0);     // an alias must equal a known title whole
  assert.equal(scoreIn(info, '未知片名', ['黑客帝国imdbtt0133093']), 0);        // scrape debris is compared whole
});

test('titleScore: extra text in the same script, a trailing sequel number, or an unknown translation is another work', () => {
  const matrix = infoFor([['黑客帝国', 1], ['The Matrix', 1], ['駭客任務', 2]]);
  assert.equal(scoreIn(matrix, '駭客任務：重裝上阵'), 0);
  assert.equal(scoreIn(matrix, '黑客帝国：矩阵重启'), 0);
  assert.equal(scoreIn(matrix, '黑客帝国2'), 0);
  assert.equal(scoreIn(matrix, '黑客帝国1'), 70);                 // site numbering of the first film
  assert.equal(scoreIn(matrix, 'Game of Thrones 黑客帝国 前传'), 0);
  assert.equal(scoreIn(matrix, 'The Matrix 骇客任务'), 0);          // "骇客任务" is not one of the known titles
  const spider = infoFor([['蜘蛛侠', 1]]);
  assert.equal(scoreIn(spider, '蜘蛛侠：英雄归来'), 0);
  assert.equal(scoreIn(spider, '蜘蛛侠'), 100);
  const earth = infoFor([['流浪地球', 1], ['The Wandering Earth', 1]]);
  assert.equal(scoreIn(earth, '流浪地球'), 100);
  assert.equal(scoreIn(earth, '流浪地球 The Wandering Earth'), 70);
  assert.equal(scoreIn(earth, '流浪地球2'), 0);
  assert.equal(scoreIn(earth, '流浪地球3：再次冒险'), 0);
  assert.equal(scoreIn(earth, '流浪地球(特别版)'), 100);
  const bill = infoFor([['杀死比尔', 1], ['Kill Bill: Vol. 1', 1]]);
  assert.equal(scoreIn(bill, 'Kill Bill: Vol. 1 杀死比尔'), 70);
  const rocky = infoFor([['Rocky', 1]]);
  assert.equal(scoreIn(rocky, 'Rocky II'), 0);
});

test('titleScore: two halves of one film are only told apart when both sides name a half', () => {
  const both = infoFor([['赤壁(上)', 1], ['Red Cliff', 1]]);
  assert.equal(scoreIn(both, '赤壁(上)'), 100);
  assert.equal(scoreIn(both, '赤壁(下)'), 0);
  assert.equal(scoreIn(both, '赤壁（下）', ['赤壁']), 0);          // the alias names no half, the card does
  assert.equal(scoreIn(both, '别的名字', ['赤壁']), 50);              // an alias alone is still a weak match
  assert.equal(scoreIn(both, '赤壁'), 100);                        // the card names no half: still allowed
  const plain = infoFor([['赤壁', 1]]);
  assert.equal(scoreIn(plain, '赤壁(上)'), 100);
  assert.equal(scoreIn(plain, '赤壁(下)'), 100);
});

const SEARCH = {};
for (const q of ['权力的游戏', '黑客帝国', '流浪地球', '千与千寻']) SEARCH[q] = readJson('kanju/search-' + q + '.json');
// What findTitle() would accept (score >= its ACCEPT_SCORE of 70), best first.
const ACCEPT = 70;
const ranked = (cards, info, args) => cards.map((c) => I.evaluateCard(c, info, args)).filter((entry) => entry && entry.score >= ACCEPT).sort((a, b) => b.score - a.score);
const infoFrom = (file) => infoFor(I.tmdbTitles(readJson('tmdb/' + file), file.startsWith('movie')).map((title) => [title.text, title.rank]));

test('evaluateCard on captured results: Game of Thrones seasons 1, 3, 8 and what must not match', () => {
  const args9 = I.parseArgs('1399', 'tv', 9, 1);
  const info = { ...infoFrom('tv/1399.json'), seasonYear: 2011 };
  const cards = SEARCH['权力的游戏'].cards;
  const s1 = ranked(cards, info, I.parseArgs('1399', 'tv', 1, 1))[0];
  assert.equal(s1.title, '权力的游戏 第1季');
  assert.equal(s1.variantTitle, '权力的游戏 第1季');
  assert.equal(s1.seasonState, 'same');
  const s3 = ranked(cards, { ...info, seasonYear: 2013 }, I.parseArgs('1399', 'tv', 3, 1))[0];
  assert.equal(s3.title, '权力的游戏 第1季');                       // the multi-season card beats the single-season ones
  assert.equal(s3.variantTitle, '权力的游戏 第3季');
  const s8 = ranked(cards, { ...info, seasonYear: 2019 }, I.parseArgs('1399', 'tv', 8, 1))[0];
  assert.match(s8.variantTitle, /第8季/);
  assert.equal(ranked(cards, info, args9).length, 0);               // no season 9 anywhere
  for (const other of cards.filter((c) => /前传|征服与反抗|最后的守夜人/.test(c.title))) {
    assert.equal(I.evaluateCard(other, info, I.parseArgs('1399', 'tv', 1, 1)), null, other.title);
  }
});

test('evaluateCard on captured results: The Matrix is the 1999 card, not the 2000 duplicate or a sequel', () => {
  const args = I.parseArgs('603', 'movie', null, null);
  const cards = SEARCH['黑客帝国'].cards;
  const info = { ...infoFrom('movie/603.json'), year: 1999 };
  const all = ranked(cards, info, args);
  assert.equal(all[0].title, '黑客帝国');
  assert.equal(all[0].card.year, 1999);
  const scored = SEARCH['黑客帝国'].cards.map((c) => I.evaluateCard(c, info, I.parseArgs('603', 'movie', null, null))).filter(Boolean);
  const duplicate = scored.find((entry) => entry.title === '黑客帝国' && entry.card.year === 2000);
  assert.ok(duplicate && duplicate.score < all[0].score && duplicate.yearState === 'near');
  for (const title of ['黑客帝国2:重装上阵', '黑客帝国3:矩阵革命', '黑客帝国:矩阵重启', '黑客帝国动画版', '黑客悲情', '重装上阵', '删除病毒码', '虚拟决斗']) {
    assert.equal(all.some((entry) => entry.title === title), false, title);
  }
  assert.equal(ranked(cards, { ...infoFrom('movie/603.json'), year: null }, args)[0].title, '黑客帝国');
});

test('evaluateCard on captured results: 流浪地球 is the plain film, then the special edition, never the sequel', () => {
  const args = I.parseArgs('9000001', 'movie', null, null);
  const all = ranked(SEARCH['流浪地球'].cards, { ...infoFrom('movie/9000001.json'), year: 2019 }, args);
  assert.deepEqual(all.map((entry) => entry.title), ['流浪地球', '流浪地球(特别版)']);
  assert.ok(all[0].score > all[1].score);
});

test('evaluateCard on captured results: Spirited Away is the 2001 card; the 2019 duplicate is refused', () => {
  const args = I.parseArgs('129', 'movie', null, null);
  const all = ranked(SEARCH['千与千寻'].cards, { ...infoFrom('movie/129.json'), year: 2001 }, args);
  assert.equal(all[0].title, '千与千寻');
  assert.equal(all[0].card.year, 2001);
  assert.equal(all.length, 1);                                        // the 2019 duplicate is below the accept threshold
  assert.ok(SEARCH['千与千寻'].cards.filter((c) => c.year === 2019).some((c) => { const entry = I.evaluateCard(c, { ...infoFrom('movie/129.json'), year: 2001 }, args); return entry && entry.yearState === 'mismatch' && entry.score < 70; }));
});

test('parseArgs and mirrorConfig: what the host may pass, and what the manifest entry decides', () => {
  assert.deepEqual(I.parseArgs(603, 'movie', null, null), { tmdbId: '603', type: 'movie', isMovie: true, season: null, episode: null });
  assert.deepEqual(I.parseArgs('1399', 'tv', 2, '5'), { tmdbId: '1399', type: 'tv', isMovie: false, season: 2, episode: 5 });
  assert.equal(I.parseArgs('1399', 'series', 2, 5).isMovie, false);
  for (const [args, code] of [
    [['tt0133093', 'movie'], 'BAD_ARGUMENT'], [['mal:63375:68', 'tv', null, 68], 'BAD_ARGUMENT'], [['kitsu:6448', 'tv'], 'BAD_ARGUMENT'],
    [['', 'movie'], 'BAD_ARGUMENT'], [['1399', 'tv', 1, 1.5], 'BAD_ARGUMENT'], [['1399', 'tv', 1], 'BAD_ARGUMENT'],
    [['1399', 'tv', -1, 1], 'BAD_ARGUMENT'], [['603', 'music'], 'BAD_ARGUMENT'], [['1399', 'tv', 0, 1], 'NOT_FOUND'],
  ]) {
    assert.throws(() => I.parseArgs(...args), kanjuError(code), JSON.stringify(args));
  }
  assert.deepEqual(I.mirrorConfig('3f2a5f0e-1111-4222-8333-444455556666:kanju'), { official: false });
  assert.deepEqual(I.mirrorConfig('https://raw.githubusercontent.com/u/nuvio-plugins/main/kanju/manifest.json:kanju-official'), { official: true });
  assert.deepEqual(I.mirrorConfig('x:officially-kanju'), { official: false });
  assert.deepEqual(I.mirrorConfig(''), { official: false });
  assert.deepEqual(I.mirrorConfig(undefined), { official: false });
});

test('anonymousId is a stable, uuid-shaped guest id per scraper id and mirror', () => {
  globalThis.SCRAPER_ID = 'repo:kanju-official';
  const first = I.anonymousId({ base: 'https://kanju44.com' });
  assert.match(first, /^web_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, I.anonymousId({ base: 'https://kanju44.com' }));
  assert.notEqual(first, I.anonymousId({ base: 'https://kanju.ai' }));
  globalThis.SCRAPER_ID = 'repo:kanju';
  assert.notEqual(I.anonymousId({ base: 'https://kanju44.com' }), first);
  delete globalThis.SCRAPER_ID;
});

test('line helpers: dedupe key, quality and language labels, playable kinds', () => {
  assert.equal(I.lineKey({ provider_id: 'maoyan', resolve_mode: 'direct', label: '猫眼资源' }), '["maoyan","direct","猫眼资源"]');
  assert.equal(I.lineKey({ id: 'playback:yj:1' }), 'playback:yj:1');
  assert.equal(I.qualityOf('1080P-官方Z · 普通话'), '1080p');
  assert.equal(I.qualityOf('AI4K-专享J'), '4K');
  assert.equal(I.qualityOf('高清-官方B · 普通话'), 'HD');
  assert.equal(I.qualityOf('猫眼资源'), '');
  assert.equal(I.lineLabel({ label: '红牛资源 · 普通话' }), '红牛资源');
  assert.equal(I.lineLabel({ label: '1080P-官方Z · 普通话' }), '1080P-官方Z');
  assert.equal(I.lineLabel({ label: '猫眼资源' }), '猫眼资源');
  assert.equal(I.lineLabel({ provider_id: 'maoyan' }), 'maoyan');
  assert.equal(I.audioOf('1080P-官方Z · 普通话'), '普通话');
  assert.equal(I.audioOf('猫眼资源'), '');
  assert.equal(I.mediaUrl({ url_kind: 'm3u8', url: 'https://x.example/a/index.m3u8' }), 'https://x.example/a/index.m3u8');
  assert.equal(I.mediaUrl({ url_kind: 'unknown', url: 'https://x.example/a/index.m3u8?token=1' }), 'https://x.example/a/index.m3u8?token=1');
  assert.equal(I.mediaUrl({ url_kind: 'unknown', url: 'https://cdn.example/tos~image?x-expires=1' }), '');
  assert.equal(I.mediaUrl({ url_kind: 'external', url: 'https://x.example/a/index.m3u8' }), '');
  assert.equal(I.mediaUrl({ url_kind: 'mp4', url: 'http://x.example/a.mp4' }), '');
  assert.equal(I.mediaUrl({ url_kind: 'resolve_ticket', url: 'resolve://abc' }), '');
  // Seen live 2026-11-24: a film's official line had url_kind "unknown" and its type only in the query.
  assert.equal(I.mediaUrl({ url_kind: 'unknown', url: 'https://v.example/video/tos/cn/abc/?br=1&mime_type=video_mp4&cs=2' }), 'https://v.example/video/tos/cn/abc/?br=1&mime_type=video_mp4&cs=2');
  assert.equal(I.mediaUrl({ url_kind: 'unknown', mime_type: 'application/vnd.apple.mpegurl', url: 'https://x.example/play/abc' }), 'https://x.example/play/abc');
  assert.equal(I.mediaUrl({ url_kind: 'unknown', url: 'https://v.example/video/tos/cn/abc/?mime_type=text%2Fhtml' }), '');
  assert.equal(I.mediaUrl({ url_kind: 'unknown', url: 'https://v.example/video/tos/cn/abc/?br=1' }), '');
  assert.equal(I.mediaUrl({ url_kind: 'external', url: 'https://x.example/a/?mime_type=video_mp4' }), '');
  // The site's video CDN signs its MP4s with an ".image" path (checked live: video/mp4, ftyp).
  assert.equal(I.mediaUrl({ url_kind: 'mp4', url: 'https://p.example/tos/cn/x~tplv-1-image.image?x-expires=1' }), 'https://p.example/tos/cn/x~tplv-1-image.image?x-expires=1');
});

test('httpError maps site statuses to the reference plugin error codes', () => {
  const codes = [
    [401, 'playback_user_session_required', 'AUTH_REQUIRED'], [402, '', 'CONTENT_LOCKED'], [403, 'playback_quota_exhausted', 'CONTENT_LOCKED'],
    [404, 'playback_line_unavailable', 'NOT_FOUND'], [404, '', 'NOT_FOUND'], [429, 'rate_limited', 'RATE_LIMITED'],
    [500, 'boom', 'UPSTREAM_CHANGED'], [500, '', 'UPSTREAM_ERROR'], [503, '', 'UPSTREAM_ERROR'],
  ];
  for (const [status, code, expected] of codes) assert.equal(I.httpError(status, code, { error: { code, message: 'm' } }).code, expected, status + ' ' + code);
});

test('tmdbTitles: ranks localized/original first, then translations by language, then a few regions', () => {
  const movie = readJson('tmdb/movie/603.json');
  assert.deepEqual(I.tmdbTitles(movie, true).map((title) => title.text + ':' + title.rank), ['黑客帝国:1', 'The Matrix:1', '駭客任務:2', '22世紀殺人網絡:2', 'マトリックス:2', '매트릭스:2']);
  const tv = readJson('tmdb/tv/1399.json');
  const titles = I.tmdbTitles(tv, false);
  assert.deepEqual(titles.slice(0, 2).map((title) => title.text), ['权力的游戏', 'Game of Thrones']);
  assert.equal(titles[titles.length - 1].text, '冰与火之歌：权力游戏');
  assert.equal(titles[titles.length - 1].rank, 3);
  // Payloads without the appended sections still yield the two primary titles.
  assert.deepEqual(I.tmdbTitles({ title: 'Only Title', original_title: 'Only Original' }, true).map((title) => title.text), ['Only Title', 'Only Original']);
  assert.deepEqual(I.tmdbTitles({}, true), []);                 // nothing usable: the caller reports NOT_FOUND
});

// ---------------------------------------------------------------------------------------------- 4. through the mock host

const SOURCES = findSourcesDir();
const glue = SOURCES ? loadGlue() : null;
const HOSTS = glue ? ['tv', 'mobile'] : [];

const { KANJU, TMDB_KEY, DETAIL, MATRIX, TOP_DIRECT, labelOf, officialLine, world } = offlineWorld;

const run = (profile, setup, args, more = {}) => runPlugin({ glue, profile, code: readPlugin(), transport: setup.transport, args, tmdbApiKey: TMDB_KEY, ...more });
// The plugin prefixes every line with "[kanju] "; assertions are written without it.
const logLines = (result, level) => result.logs.filter((entry) => !level || entry.level === level).map((entry) => entry.line.replace(/^\[kanju\] /, ''));
const siteUrls = (result) => result.requests.map((request) => request.url).filter((url) => !url.includes('themoviedb'));

for (const profile of HOSTS) {
  const MOVIE_ARGS = profile === 'tv' ? ['603', 'movie', null, null] : ['603', 'movie', undefined, undefined];

  test(`[${profile}] movie: TMDB id -> titles -> site search -> 正片 -> resolve, inside Nuvio's own polyfill and call code`, async () => {
    const setup = world();
    const result = await run(profile, setup, MOVIE_ARGS);

    assert.equal(result.timedOut, false);
    assert.equal(result.loadError, null);
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.deepEqual(result.streams.map((stream) => stream.name), TOP_DIRECT.map((id) => '黑客帝国 · ' + labelOf(id).replace(/\s*·\s*\S+\s*$/, '')));
    assert.ok(result.streams.every((stream) => stream.title === '黑客帝国 · kanju44.com'));     // "正片" is left out for a film
    for (const stream of result.streams) {
      assert.match(stream.url, /^https:\/\/media\.example\.invalid\/[\w.-]+\/index\.m3u8$/);
      // Only fields the hosts read, and none of them blank: the site gives no resolution for
      // these lines, so `quality` is left out rather than shown empty, and so is `language`
      // for a line whose label carries no audio tag ("豆瓣资源").
      const keys = Object.keys(stream).sort();
      assert.deepEqual(keys.filter((key) => !['language', 'quality'].includes(key)), ['name', 'title', 'url']);
      assert.ok(stream.name && stream.title && stream.url && stream.language !== '' && stream.quality !== '');
    }
    assert.ok(result.streams.some((stream) => stream.language === '普通话') && result.streams.some((stream) => stream.language === undefined));
    // What Nuvio makes of it.
    assert.deepEqual(result.results.map((item) => item.url), result.streams.map((stream) => stream.url));
    assert.ok(result.results.every((item) => item.name && item.title && item.quality === null));

    // Request sequence on the site: home, runtime chunk, one search, episodes, resolve.
    assert.deepEqual(siteUrls(result).map((url) => new URL(url).pathname), ['/', '/assets/movie-card-runtime-Ddt--41l.js',
      '/v1/browse/catalog', '/v1/catalog/' + MATRIX.id + '/episodes', '/v1/playback/resolve/av_FAKE_MOVIE_EPISODE_TOKEN_1']);
    assert.ok(siteUrls(result).every((url) => url.startsWith(KANJU)));
    assert.equal(siteUrls(result)[2], KANJU + '/v1/browse/catalog?q=%e9%bb%91%e5%ae%a2%e5%b8%9d%e5%9b%bd&query_mode=fast_v3&search_fields=all&limit=12&page=1');
    assert.equal(siteUrls(result)[3], KANJU + '/v1/catalog/' + MATRIX.id + '/episodes?limit=100&offset=0');
    assert.equal(siteUrls(result)[4], KANJU + '/v1/playback/resolve/av_FAKE_MOVIE_EPISODE_TOKEN_1?view=compact');
    // …and one TMDB call with the host's key.
    assert.deepEqual(result.requests.map((request) => request.url).filter((url) => url.includes('themoviedb')),
      ['https://api.themoviedb.org/3/movie/603?language=zh-CN&append_to_response=translations%2calternative_titles&api_key=' + TMDB_KEY]);
    assert.ok(result.requests.every((request) => request.method === 'GET' && request.status === 200 && request.bytes < 1024 * 1024));
    assert.equal(setup.kanju.state.badSignatures, 0);
    assert.equal(setup.kanju.state.sessions, 0);
    assert.equal(setup.kanju.state.resolveLines, 0);
    assert.match(logLines(result).join('\n'), /匹配 黑客帝国 score=\d+ season=n\/a year=same @kanju44\.com/);
  });

  test(`[${profile}] series: multi-season card -> detail -> the requested season's episodes -> resolve`, async () => {
    const setup = world();
    const result = await run(profile, setup, ['1399', 'tv', 3, 1]);
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.ok(result.streams.every((stream) => stream.title === '权力的游戏 第3季 · 第1集 · kanju44.com' && stream.name.startsWith('权力的游戏 第3季 · ')));
    const season3 = DETAIL.seasons.find((season) => season.season_number === 3).variant_id;
    assert.deepEqual(siteUrls(result).map((url) => new URL(url).pathname + new URL(url).search), ['/', '/assets/movie-card-runtime-Ddt--41l.js',
      '/v1/browse/catalog?q=%e6%9d%83%e5%8a%9b%e7%9a%84%e6%b8%b8%e6%88%8f&query_mode=fast_v3&search_fields=all&limit=12&page=1',
      '/v1/catalog/' + DETAIL.id + '/detail', '/v1/catalog/' + season3 + '/episodes?limit=100&offset=0',
      '/v1/playback/resolve/av_FAKE_EPISODE_TOKEN_1?view=compact']);
    assert.equal(setup.kanju.state.badSignatures, 0);
  });
}

const TV = HOSTS[0];
if (TV) {
  test('[tv] default entry never starts a guest session or resolves an official ticket', async () => {
    const setup = world({ kanju: { official: { line: officialLine() } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1]);
    assert.equal(result.streams.length, 6);
    assert.equal(setup.kanju.state.resolveLines, 0);
    assert.equal(setup.kanju.state.sessions, 0);
  });

  test('[tv] default entry: only official tickets on the site -> nothing, and a warning that says why', async () => {
    const base = offlineWorld.kanjuWorld();
    const ticketsOnly = { line_options: base.resolves.av_FAKE_EPISODE_TOKEN_1.line_options.filter((line) => line.url_kind === 'resolve_ticket') };
    const setup = world({ kanju: { resolves: { ...base.resolves, av_FAKE_EPISODE_TOKEN_1: ticketsOnly }, official: { line: officialLine() } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1]);
    assert.deepEqual(result.streams, []);
    assert.equal(setup.kanju.state.resolveLines, 0);
    assert.equal(setup.kanju.state.sessions, 0);
    assert.ok(logLines(result, 'warn').some((line) => line.includes('CONTENT_LOCKED: 只有需要解析额度的官方线路')), logLines(result).join('\n'));
  });

  test('[tv] "kanju-official" entry: 401 -> guest session -> cookie relayed -> the site\'s selected official line, then the zero-cost ones', async () => {
    const setup = world({ kanju: { official: { line: officialLine() } } });
    const scraperId = 'https://raw.githubusercontent.com/u/nuvio-plugins/main/kanju/manifest.json:kanju-official';
    const result = await run(TV, setup, ['1399', 'tv', 1, 1], { scraperId });

    assert.equal(result.streams.length, 7, logLines(result).join('\n'));
    const official = result.streams[0];
    assert.equal(official.name, '权力的游戏 第1季 · 1080P-官方R');     // the audio tag is reported in `language`, not repeated
    assert.equal(official.title, '权力的游戏 第1季 · 第1集 · kanju44.com');
    assert.equal(official.quality, '1080p');
    assert.equal(official.language, '普通话');
    assert.match(official.url, /^https:\/\/media\.example\.invalid\/official\/video\.image\?x-expires=(\d+)$/);
    assert.ok(Number(/x-expires=(\d+)/.exec(official.url)[1]) * 1000 > Date.now());
    assert.ok(result.streams.slice(1).every((stream) => /\.m3u8$/.test(stream.url)));

    assert.deepEqual(setup.transport.calls.filter((call) => call.method === 'POST').map((call) => [new URL(call.url).pathname + new URL(call.url).search, call.lower.get('cookie') || '', call.lower.get('content-type')]),
      [['/v1/playback/resolve-line?view=compact', '', 'application/json'], ['/v1/users/anonymous', '', 'application/json'], ['/v1/playback/resolve-line?view=compact', 'ai_movie_session=' + FAKE_SESSION, 'application/json']]);
    assert.deepEqual(setup.transport.calls.filter((call) => call.url.includes('/v1/playback/resolve-line')).map((call) => JSON.parse(call.body.toString('utf8'))),
      [{ ticket: 'FAKE_TICKET_bytedance' }, { ticket: 'FAKE_TICKET_bytedance' }]);   // the site's selected ticket, once
    assert.equal(setup.kanju.state.resolveLines, 2);
    assert.equal(setup.kanju.state.sessions, 1);
    assert.match(setup.kanju.state.anonIds[0], /^web_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(setup.kanju.state.badSignatures, 0);
    assert.ok(logLines(result).some((line) => line.startsWith('v' + I.version + ' (+official) tmdb=1399 tv S1E1')));
  });

  test('[tv] "kanju-official" entry: locked / exhausted -> logged, no second ticket, zero-cost lines still returned', async () => {
    const setup = world({ kanju: { official: { error: { status: 403, body: { statusCode: 403, code: 'playback_quota_exhausted', message: '额度不足' } } } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1], { scraperId: 'x:kanju-official' });
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.equal(setup.kanju.state.resolveLines, 2);
    assert.equal(setup.kanju.state.sessions, 1);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('CONTENT_LOCKED: ') && line.includes('额度不足')), logLines(result).join('\n'));
  });

  test('[tv] "kanju-official" entry: an already expired official URL is dropped with a warning', async () => {
    const setup = world({ kanju: { official: { line: officialLine(Math.floor(Date.now() / 1000) - 60) } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1], { scraperId: 'x:kanju-official' });
    assert.equal(result.streams.length, 6);
    assert.ok(logLines(result, 'warn').some((line) => line.includes('官方线路返回的地址已过期')));
  });

  // Both seen live on 2026-11-24: a film's official line came back as url_kind "unknown" with
  // ("...&mime_type=video_mp4&...") and without a type hint, on different calls.
  test('[tv] "kanju-official" entry: an official line of kind "unknown" is kept when its mime_type query names a media type', async () => {
    const line = { ...officialLine(), provider_id: 'bytedance', label: '高清-官方B · 普通话', url_kind: 'unknown', url: 'https://media.example.invalid/official/video?br=1&mime_type=video_mp4&cs=2' };
    const setup = world({ kanju: { official: { line } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1], { scraperId: 'x:kanju-official' });
    assert.equal(result.streams.length, 7, logLines(result).join('\n'));
    assert.equal(result.streams[0].name, '权力的游戏 第1季 · 高清-官方B');
    assert.equal(result.streams[0].quality, 'HD');
    assert.equal(result.streams[0].language, '普通话');
    assert.equal(result.streams[0].url, line.url);
    assert.ok(result.streams.slice(1).every((stream) => /\.m3u8$/.test(stream.url)));
  });

  test('[tv] "kanju-official" entry: an official line of kind "unknown" with no type hint is dropped and says so', async () => {
    const line = { ...officialLine(), url_kind: 'unknown', url: 'https://media.example.invalid/official/video?br=1&cs=2' };
    const setup = world({ kanju: { official: { line } } });
    const result = await run(TV, setup, ['1399', 'tv', 1, 1], { scraperId: 'x:kanju-official' });
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.ok(logLines(result, 'warn').some((line) => line.startsWith('UPSTREAM_CHANGED') && line.includes('（unknown）')), logLines(result).join('\n'));
  });

  test('[tv] a rejected signature makes the plugin rediscover the key once and succeed', async () => {
    let rejected = 0;
    const setup = world({ kanju: { intercept: (request, url) => {
      if (rejected === 0 && url.pathname === '/v1/browse/catalog') {
        rejected++;
        return jsonResponse(401, { error: 'request_error', code: 'invalid_request_signature', message: '签名无效' });
      }
      return null;
    } } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.equal(rejected, 1);
    assert.equal(setup.kanju.state.keyHits, 2);                    // home -> chunk again after the rejection
    const searches = setup.transport.calls.filter((call) => call.url.includes('/v1/browse/catalog'));
    assert.equal(searches.length, 2);
    assert.notEqual(searches[0].lower.get('x-ai-movie-nonce'), searches[1].lower.get('x-ai-movie-nonce'));
    assert.notEqual(searches[0].lower.get('x-ai-movie-signature'), searches[1].lower.get('x-ai-movie-signature'));
  });

  test('[tv] mirror fail-over: kanju44.com down -> kanju.ai serves the same title', async () => {
    const setup = world({ kanju: { intercept: (request, url) => (url.origin === 'https://kanju44.com' ? jsonResponse(503, 'down') : null) } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.ok(result.streams.every((stream) => stream.title === '黑客帝国 · kanju.ai'));
    assert.deepEqual(siteUrls(result).slice(0, 2), ['https://kanju44.com/', 'https://kanju.ai/']);
    assert.ok(siteUrls(result).slice(2).every((url) => url.startsWith('https://kanju.ai/')));
    assert.ok(logLines(result, 'warn').some((line) => line.includes('UPSTREAM_ERROR: kanju44.com 不可用，改试 kanju.ai')), logLines(result).join('\n'));
    assert.equal(setup.kanju.state.badSignatures, 0);
  });

  test('[tv] changed site: no signing key on either mirror -> UPSTREAM_CHANGED, nothing signed', async () => {
    const setup = world({ kanju: { chunk: '/* no key here */', main: '/* no runtime chunk reference */' } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.deepEqual(result.streams, []);
    assert.equal(setup.kanju.state.signedRequests, 0);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('UPSTREAM_CHANGED: 站点请求模块已变化')), logLines(result).join('\n'));
    assert.deepEqual(siteUrls(result).map((url) => new URL(url).hostname + new URL(url).pathname), ['kanju44.com/', 'kanju44.com/assets/movie-card-runtime-Ddt--41l.js', 'kanju44.com/assets/main-Bm8Nb--g.js', 'kanju.ai/', 'kanju.ai/assets/movie-card-runtime-Ddt--41l.js', 'kanju.ai/assets/main-Bm8Nb--g.js']);
  });

  test('[tv] a bundle over the 1 MiB fetch cap is reported as that, not as a changed site', async () => {
    const setup = world({ kanju: { chunk: '/*' + 'x'.repeat(1200 * 1024) + '*/' + fakeRuntimeChunk() } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.deepEqual(result.streams, []);
    assert.equal(setup.kanju.state.signedRequests, 0);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('UPSTREAM_CHANGED: 站点脚本超过宿主单次 1 MiB 抓取上限')), logLines(result).join('\n'));
    const chunk = result.requests.find((request) => request.url.includes('movie-card-runtime'));
    assert.equal(chunk.bytes, 1024 * 1024);
    assert.equal(chunk.rawBytes, 1200 * 1024 + 4 + fakeRuntimeChunk().length);
  });

  test('[tv] the fallback chain home -> main bundle -> runtime chunk still finds the key', async () => {
    const home = readFileSync(join(ROOT, 'test', 'fixtures', 'kanju', 'home.html'), 'utf8').replace(/<link rel="modulepreload"[^>]*movie-card-runtime[^>]*>\s*/, '');
    const setup = world({ kanju: { home, main: fakeMainBundle() } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    assert.deepEqual(siteUrls(result).slice(0, 3), [KANJU + '/', KANJU + '/assets/main-Bm8Nb--g.js', KANJU + '/assets/movie-card-runtime-Ddt--41l.js']);
  });

  test('[tv] not found, refused arguments, missing or rejected TMDB key all end in "no streams" with a clear line', async () => {
    let result = await run(TV, world(), ['999999999', 'movie', null, null]);
    assert.deepEqual(result.streams, []);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('NOT_FOUND: TMDB 没有这个')), logLines(result).join('\n'));

    result = await run(TV, world(), ['1429', 'tv', 3, 1]);
    assert.deepEqual(result.streams, []);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('NOT_FOUND: 站点找不到匹配的影片')), logLines(result).join('\n'));
    assert.ok(siteUrls(result).includes(KANJU + '/v1/browse/catalog?q=%e8%bf%9b%e5%87%bb%e7%9a%84%e5%b7%a8%e4%ba%ba&query_mode=fast_v3&search_fields=all&limit=12&page=1'), siteUrls(result).join('\n'));

    for (const args of [['tt0133093', 'movie', null, null], ['mal:63375:68', 'tv', null, 68], ['1399', 'tv', 0, 1]]) {
      result = await run(TV, world(), args);
      assert.deepEqual(result.streams, [], JSON.stringify(args));
      assert.equal(result.requests.length, 0, JSON.stringify(args));
      assert.ok(logLines(result, 'error').some((line) => /^(BAD_ARGUMENT|NOT_FOUND): /.test(line)), JSON.stringify(args));
    }

    result = await runPlugin({ glue, profile: TV, code: readPlugin(), transport: world().transport, args: ['603', 'movie', null, null], tmdbApiKey: '' });
    assert.deepEqual(result.streams, []);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('HOST_UNSUPPORTED: 宿主没有提供 TMDB_API_KEY')), logLines(result).join('\n'));

    result = await run(TV, world({ tmdbKey: 'ANOTHER_KEY' }), ['603', 'movie', null, null]);
    assert.deepEqual(result.streams, []);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('HOST_UNSUPPORTED: 宿主提供的 TMDB_API_KEY 被 TMDB 拒绝')), logLines(result).join('\n'));
  });

  test('[tv] TMDB: a v4 read token goes in the Authorization header; a failed append falls back to the plain detail call', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidGVzdCJ9.sig-nature';
    const setup = world({ tmdbKey: token, tmdbIntercept: (request, url) => (url.search.includes('append_to_response') ? jsonResponse(500, { error: 'boom' }) : null) });
    const result = await runPlugin({ glue, profile: TV, code: readPlugin(), transport: setup.transport, args: ['603', 'movie', null, null], tmdbApiKey: token });
    assert.equal(result.streams.length, 6, logLines(result).join('\n'));
    const calls = setup.transport.calls.filter((call) => call.url.includes('themoviedb'));
    assert.deepEqual(calls.map((call) => call.url), ['https://api.themoviedb.org/3/movie/603?language=zh-CN&append_to_response=translations%2calternative_titles', 'https://api.themoviedb.org/3/movie/603?language=zh-CN']);
    assert.ok(calls.every((call) => call.lower.get('authorization') === 'Bearer ' + token));
    assert.ok(calls.every((call) => call.lower.get('accept') === 'application/json' && /^Mozilla\/5\.0/.test(call.lower.get('user-agent'))));
  });

  test('[tv] RATE_LIMITED on the site search is logged as such and not retried to death', async () => {
    const setup = world({ kanju: { intercept: (request, url) => (url.pathname === '/v1/browse/catalog' ? jsonResponse(429, { error: 'request_error', code: 'rate_limited', message: '慢点' }) : null) } });
    const result = await run(TV, setup, ['603', 'movie', null, null]);
    assert.deepEqual(result.streams, []);
    assert.equal(setup.transport.calls.filter((call) => call.url.includes('/v1/browse/catalog')).length, 1);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('RATE_LIMITED: ')));
  });
}

if (HOSTS.includes('mobile')) {
  test('[mobile] host timeout: a hung request ends the run with no streams', async () => {
    const setup = world();
    const hanging = { ...setup.transport, sendAsync: () => new Promise(() => {}) };
    const result = await runPlugin({ glue, profile: 'mobile', code: readPlugin(), transport: hanging, args: ['603', 'movie'], timeoutMs: 400, tmdbApiKey: TMDB_KEY });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.streams, []);
    assert.ok(result.elapsedMs < 5000);
  });

  test('[mobile] NuvioMobile marks a cut body; the plugin reads it the same way as on NuvioTV', async () => {
    const setup = world({ kanju: { chunk: '/*' + 'y'.repeat(1200 * 1024) + '*/' + fakeRuntimeChunk() } });
    const result = await run('mobile', setup, ['603', 'movie']);
    assert.deepEqual(result.streams, []);
    assert.equal(setup.kanju.state.signedRequests, 0);
    assert.ok(logLines(result, 'error').some((line) => line.startsWith('UPSTREAM_CHANGED: 站点脚本超过宿主单次 1 MiB 抓取上限')), logLines(result).join('\n'));
    assert.equal(result.requests.find((request) => request.url.includes('movie-card-runtime')).bytes, 1024 * 1024);
  });
}

if (glue) {
  test('host contract: a plugin that throws, does not parse, or exports nothing gives the host "no streams"', async () => {
    const transport = scriptedTransport(() => jsonResponse(200, {}));
    const rejects = await runPlugin({ glue, profile: 'tv', code: 'module.exports = { getStreams: async function () { throw new Error("boom"); } };', transport, args: ['1', 'movie'] });
    assert.deepEqual(rejects.streams, []);
    assert.ok(logLines(rejects, 'error').some((line) => line.includes('getStreams error')), logLines(rejects).join('\n'));
    const broken = await runPlugin({ glue, profile: 'tv', code: 'this is not ( valid javascript', transport, args: ['1', 'movie'] });
    assert.deepEqual(broken.streams, []);
    assert.ok(broken.loadError);
    const none = await runPlugin({ glue, profile: 'tv', code: 'module.exports = {};', transport, args: ['1', 'movie'] });
    assert.deepEqual(none.streams, []);
    assert.ok(logLines(none, 'error').some((line) => line.includes('getStreams function not found')));
  });

  test('host contract: the realm holds what the polyfills define — NuvioTV has no timers, TextEncoder or WebCrypto', async () => {
    const probe = 'module.exports = { getStreams: async function () { return [{ url: "https://a.example/x.mp4", name: "n" }]; } };'
      + 'globalThis.__types = [typeof fetch, typeof setTimeout, typeof crypto, typeof TextEncoder, typeof URL, typeof require, typeof SCRAPER_ID, typeof TMDB_API_KEY];';
    const transport = scriptedTransport(() => jsonResponse(200, {}));
    const tv = await runPlugin({ glue, profile: 'tv', code: probe, transport, args: ['1', 'movie'] });
    assert.deepEqual([...tv.sandbox.__types], ['function', 'undefined', 'undefined', 'undefined', 'function', 'function', 'string', 'string']);
    const mobile = await runPlugin({ glue, profile: 'mobile', code: probe, transport, args: ['1', 'movie'] });
    assert.deepEqual([...mobile.sandbox.__types], ['function', 'function', 'object', 'function', 'function', 'function', 'string', 'string']);
  });
}

// ---------------------------------------------------------------------------------------------- 5. repository files

test('repository: both manifests follow the shape the Nuvio hosts parse and point at the one plugin file', () => {
  const check = (file, ids) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    for (const key of ['name', 'version']) assert.ok(typeof manifest[key] === 'string' && manifest[key], file + ': missing ' + key);
    assert.deepEqual(manifest.scrapers.map((scraper) => scraper.id), ids, file);
    for (const scraper of manifest.scrapers) {
      for (const key of ['id', 'name', 'version', 'filename']) assert.ok(typeof scraper[key] === 'string' && scraper[key], file + ': scraper missing ' + key);
      assert.deepEqual(scraper.supportedTypes, ['movie', 'tv'], file);
      assert.equal(scraper.enabled, true, file + ': enabled=false cannot be switched back on in NuvioMobile');
      assert.equal(scraper.version, I.version, file + ': version differs from VERSION in kanju.js');
      assert.ok(!('hasSettings' in scraper), file + ': this plugin exports no onSettings');
      assert.equal(I.mirrorConfig('https://example.invalid/' + file + ':' + scraper.id).official, scraper.id.endsWith('-official'), scraper.id);
      const target = resolve(dirname(join(ROOT, file)), scraper.filename);
      assert.ok(existsSync(target), scraper.filename + ' not found');
      assert.equal(target, resolve(PLUGIN_PATH), scraper.filename + ' must be the one plugin file');
    }
  };
  check('manifest.json', ['kanju']);
  check('kanju/manifest.json', ['kanju-official']);
  for (const file of ['README.md', 'docs/nuvio-plugin-contract.md']) assert.ok(existsSync(join(ROOT, file)), file + ' missing');
});

test('plugin file: no embedded key or token, CommonJS entry as the hosts expect', () => {
  const code = readPlugin();
  assert.match(code, /module\.exports = \{ getStreams: getStreams \};/);
  assert.doesNotMatch(code, /"x-ai-movie-signature",\w+="([a-f0-9]{64})"/);          // the site's key is discovered, not embedded
  assert.doesNotMatch(code, /\b[0-9a-f]{32}\b/);
  assert.doesNotMatch(code, /eyJ[\w-]+\.eyJ/);
  assert.doesNotMatch(code, /\b(cookie|session|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i);
  assert.equal(new Set((code.match(/\b(?:var|function)\s+([A-Za-z_$][\w$]*)/g) || []).map((s) => s.split(/\s+/)[1])).has('fetch'), false);
});

if (!glue) {
  test('host glue', { skip: 'Nuvio sources not found: set NUVIO_SOURCES (see test/host-glue.mjs); the mock-host tests did not run' }, () => {});
}
