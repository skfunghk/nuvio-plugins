#!/usr/bin/env node
// 中文名对齐的离线验证：TMDB 只给简体名，站点只有繁体名时，插件仍要能搜到。
// 不需要 Nuvio 源码，不联网：TMDB / Bangumi / 规则仓库 / 站点全部由本文件的 fetch 垫片回答。
//
//   node test/kazumi-matching.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const code = readFileSync(join(ROOT, 'kazumi/kazumi.js'), 'utf8');

const TMDB_TV = {
  id: 14285,
  name: '进击的巨人',
  original_name: '進撃の巨人',
  first_air_date: '2013-04-03',
  overview: '',
  seasons: [
    { season_number: 1, episode_count: 25, name: '第 1 季', air_date: '2013-04-07' },
    { season_number: 2, episode_count: 12, name: '第 2 季', air_date: '2017-04-01' },
  ],
  translations: { translations: [] },
  alternative_titles: { results: [] },
};

const BGM_SEARCH = { data: [{ id: 55770, name: '進撃の巨人', name_cn: '进击的巨人', date: '2013-04-06', eps: 25, type: 2 }] };
const BGM_SUBJECT = {
  id: 55770,
  name: '進撃の巨人',
  name_cn: '进击的巨人',
  infobox: [
    { key: '别名', value: [{ v: '進擊的巨人' }, { v: 'Attack on Titan' }, { v: '进击的巨人 第一季' }] },
  ],
};

// 站点只认繁体标题：给简体名就搜不到，给「進擊的巨人」才回条目。
// giriGiriLove 的搜索是 API 模式：列表在 $.info.rows[*]，名字 $.vod_name，id $.vod_id。
// 站点只有繁体条目，所以简体名回空 rows（200 + 合法 JSON），繁体别名才回一条。
const SITE_SEARCH = (query) => ({
  json: String(query).includes('進擊的巨人')
    ? { info: { rows: [{ vod_name: '進擊的巨人', vod_id: '123' }] } }
    : { info: { rows: [] } },
});

const calls = [];
// 场景 B（id → ani.zip → 站点）：只用 ani.zip 给的繁体名去搜，命中一集 12 部的动画。
const FX = { rows: [{ vod_id: '27179', vod_name: 'FX戰士久留美' }], eps: 12 };
const routesId = (url) => {
  const u = String(url);
  if (u.startsWith('https://api.ani.zip/mappings')) {
    return { json: {
      mappings: { themoviedb_id: 311842, thetvdb_id: 472962 },
      titles: { 'zh-Hant': 'FX戰士久留美', ja: 'FX戦士くるみちゃん', en: 'FX Fighter Kurumi-chan', 'x-jat': 'FX Senshi Kurumi-chan' },
      episodes: { 1: { seasonNumber: 1, episodeNumber: 1 }, 2: { seasonNumber: 1, episodeNumber: 2 } },
    } };
  }
  if (u.startsWith('https://api.bgm.tv')) return { status: 404, text: '' };
  if (u.includes('get_list')) {
    const hit = /FX|久留美|Kurumi/i.test(decodeURIComponent(u));
    return { json: { info: { rows: hit ? FX.rows : [] } } };
  }
  if (u.startsWith('https://ana.example/')) return { status: 200, text: 'ftypisom', type: 'video/mp4' };   // 地址探测
  if (u.includes('get_detail')) {
    const eps = Array.from({ length: FX.eps }, (_, i) => `${String(i + 1).padStart(2, '0')}$https://ana.example/fx/${String(i + 1).padStart(2, '0')}.mp4`).join('#');
    return { json: { info: { vod_id: '27179', vod_name: 'FX戰士久留美', vod_play_from: 'chs', vod_play_note: '', vod_play_server: '', vod_play_url: eps } } };
  }
  return { status: 404, text: 'not found' };
};

// 场景 C（条目自带连续编号）：站点把「第二季」的集数接着上季编号（29-38），
// 绝对第 34 集应当按标签直接命中，而不是按位置累加。
const seqRoutes = (url) => {
  const u = String(url);
  if (u.startsWith('https://kitsu.io/api/edge/anime/')) {
    return { json: { data: { id: '9999', attributes: { canonicalTitle: 'Frieren', titles: { en: 'Frieren', ja_jp: '葬送のフリーレン' }, startDate: '2023-09-29' } } } };
  }
  if (u.startsWith('https://api.ani.zip/mappings')) return { status: 404, text: '' };   // 不给季集坐标，逼进 flat 模式
  if (u.startsWith('https://api.bgm.tv')) return { status: 404, text: '' };
  if (u.includes('get_list')) return { json: { info: { rows: [{ vod_id: '555', vod_name: '葬送のフリーレン 第二季' }] } } };
  if (u.startsWith('https://ana.example/')) return { status: 200, text: 'ftypisom', type: 'video/mp4' };
  if (u.includes('get_detail')) {
    const eps = Array.from({ length: 10 }, (_, i) => `${29 + i}$https://ana.example/frieren/${29 + i}.mp4`).join('#');
    return { json: { info: { vod_id: '555', vod_name: '葬送のフリーレン 第二季', vod_play_from: 'chs', vod_play_note: '', vod_play_server: '', vod_play_url: eps } } };
  }
  return { status: 404, text: 'not found' };
};

// 场景 D（内置 anime1 源）：KazumiRules 全挂时，anime1 的索引 + apireq 链路仍要出线路。
const A1_LIB = JSON.stringify([[1989, '进击的巨人', '連載中(25)', '2013', '春', '']]);
const A1_CAT = '<html><body>' + [1, 2, 3].map((n) => `<article><a href="/1000${n}/"></a><h2 class="entry-title">进击的巨人 [0${n}]</h2></article>`).join('') + '</body></html>';
const A1_POST = '<html><body><video data-apireq="%7B%22c%22%3A%221989%22%2C%22e%22%3A%22x%22%7D"></video></body></html>';
const routesAnime1 = (url) => {
  const u = String(url);
  if (u.includes('animelist.json')) return { text: A1_LIB, type: 'application/json' };
  if (u.includes('anime1.me/?cat=')) return { text: A1_CAT, type: 'text/html' };
  if (/anime1\.me\/1000\d/.test(u)) return { text: A1_POST, type: 'text/html' };
  if (u.includes('v.anime1.me/api')) return { json: { s: [{ src: '//hinata.v.anime1.me/1989/03.mp4', type: 'video/mp4' }] }, cookie: 'laravel_session=FAKE; Path=/', type: 'application/json' };
  if (u.includes('hinata.v.anime1.me')) return { text: 'xxxxftypisom', type: 'video/mp4' };
  if (u.includes('kitsu.io/api/edge/anime/')) return { json: { data: { id: '7442', attributes: { canonicalTitle: '进击的巨人', titles: { ja_jp: '進撃の巨人' }, startDate: '2013-04-07' } } }, type: 'application/json' };
  return { status: 404, text: 'nope' };      // 规则站、ani.zip、Bangumi、规则仓库一律不可用
};

const routes = (url) => {
  const u = String(url);
  if (u.startsWith('https://api.themoviedb.org/3/tv/14285')) return { json: TMDB_TV };
  if (u.startsWith('https://api.bgm.tv/v0/search/subjects')) return { json: BGM_SEARCH };
  if (u.startsWith('https://api.bgm.tv/v0/subjects/55770')) return { json: BGM_SUBJECT };
  if (u.includes('get_list')) return SITE_SEARCH(decodeURIComponent(u));
  if (u.includes('get_detail')) return { json: { info: { vod_play_from: '', vod_play_url: '' } } };
  return { status: 404, text: 'not found' };
};

const response = (spec) => ({
  ok: (spec.status || 200) < 400,
  status: spec.status || 200,
  statusText: '',
  url: '',
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key === 'content-type') return spec.type || null;
      if (key === 'set-cookie') return spec.cookie || null;
      return null;
    },
  },
  text: async () => (spec.json ? JSON.stringify(spec.json) : (spec.text || '')),
  json: async () => spec.json || null,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const logs = [];
const sandbox = {
  module: { exports: {} },
  console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  fetch: async (url, init) => {
    calls.push(String(url));
    return response((sandbox.__routes || routes)(url, init));
  },
  SCRAPER_ID: 'repo:kazumi',
  TMDB_API_KEY: 'fake-key',
  setTimeout: undefined,
  clearTimeout: undefined,
  Date,
  JSON,
  Math,
  Promise,
  URL,
  encodeURIComponent,
  decodeURIComponent,
  unescape,
  isFinite,
  Number,
  String,
  Array,
  Object,
  RegExp,
  Error,
  parseInt,
  parseFloat,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'kazumi.js' });

const getStreams = sandbox.module.exports.getStreams;

const streams = await getStreams('14285', 'tv', 1, 1).catch((error) => ({ error }));

const joined = logs.join('\n');
const assertions = [
  ['插件已加载', typeof getStreams === 'function'],
  ['向 Bangumi 发了搜索', calls.some((u) => u.includes('api.bgm.tv/v0/search/subjects'))],
  ['取了 Bangumi 条目别名', calls.some((u) => u.includes('api.bgm.tv/v0/subjects/'))],
  ['日志记录了补充的中文候选名', /Bangumi 补充 \d+ 个中文候选名/.test(joined) || /Bangumi 55770 命中/.test(joined)],
  ['用繁体别名搜了站点', calls.some((u) => decodeURIComponent(u).includes('進擊的巨人'))],
  ['简体名先试、繁体别名后补', (() => {
    const simp = calls.findIndex((u) => decodeURIComponent(u).includes('进击的巨人'));
    const trad = calls.findIndex((u) => decodeURIComponent(u).includes('進擊的巨人'));
    return simp >= 0 && trad > simp;
  })()],
];

let failed = 0;
for (const [name, ok] of assertions) {
  console.log((ok ? '✔ ' : '✖ ') + name);
  if (!ok) failed++;
}
if (Array.isArray(streams)) {
  console.log(`ℹ 回传线路 ${streams.length} 条（本测试不校验可播性）`);
} else {
  console.log('ℹ 结束状态：' + JSON.stringify(streams.error && (streams.error.code || streams.error.message)));
}
// —— 场景 B：anilist id → ani.zip → 站点
sandbox.__routes = routesId;
calls.length = 0;
logs.length = 0;
const idStreams = await getStreams('anilist:206401:1', 'tv', null, 1).catch((error) => ({ error }));
const idLog = logs.join('\n');
const idAsserts = [
  ['ani.zip 以 anilist_id 查询', calls.some((u) => u.includes('api.ani.zip/mappings?anilist_id=206401'))],
  ['用 ani.zip 的季集坐标定位', /按 TMDB 分季 = S1E1/.test(idLog)],
  ['用 ani.zip 的片名去站点搜', calls.some((u) => u.includes('get_list') && decodeURIComponent(u).includes('FX戰士久留美'))],
  ['拿到线路', Array.isArray(idStreams) && idStreams.length > 0 && /\/fx\/01\.mp4$/.test(String(idStreams[0].url))],
];
for (const [name, ok] of idAsserts) {
  console.log((ok ? '✔ ' : '✖ ') + name);
  if (!ok) failed++;
}
if (Array.isArray(idStreams) && idStreams[0]) console.log('ℹ 线路：' + idStreams[0].url);
else if (process.env.DUMP) console.log(idLog);

// —— 场景 C：条目自带连续编号 29-38，绝对第 34 集
sandbox.__routes = seqRoutes;
calls.length = 0;
logs.length = 0;
const seqStreams = await getStreams('kitsu:9999:34', 'tv', null, 34).catch((error) => ({ error }));
const seqLog = logs.join('\n');
const seqAsserts = [
  ['按条目自带编号命中', /按条目自带编号命中第 34 项/.test(seqLog)],
  ['取到第 34 集的地址', Array.isArray(seqStreams) && seqStreams[0] && /\/frieren\/34\.mp4$/.test(String(seqStreams[0].url))],
  ['线路带 Referer / UA 头', Array.isArray(seqStreams) && seqStreams[0] && seqStreams[0].headers && !!seqStreams[0].headers.Referer],
];
if (process.env.DUMP) { console.log('--- C 请求'); console.log(calls.join('\n')); console.log('--- C 日志'); console.log(seqLog); }
for (const [name, ok] of seqAsserts) {
  console.log((ok ? '✔ ' : '✖ ') + name);
  if (!ok) failed++;
}

// —— 场景 D：内置 anime1 源
sandbox.__routes = routesAnime1;
calls.length = 0;
logs.length = 0;
const a1Streams = await getStreams('kitsu:7442:3', 'tv', null, 3).catch((error) => ({ error }));
const a1Log = logs.join('\n');
const a1Asserts = [
  ['读的是 anime1 索引', calls.some((u) => u.includes('animelist.json'))],
  ['区间命中索引行', /anime1: 命中「进击的巨人」\(連載中\(25\)\)/.test(a1Log)],
  ['换址用了 data-apireq', calls.some((u) => u.includes('v.anime1.me/api'))],
  ['出 mp4 线路', Array.isArray(a1Streams) && a1Streams[0] && /hinata\.v\.anime1\.me\/1989\/03\.mp4$/.test(String(a1Streams[0].url))],
  ['线路带上站点 Cookie', Array.isArray(a1Streams) && a1Streams[0] && a1Streams[0].headers && /laravel_session=FAKE/.test(String(a1Streams[0].headers.Cookie || ''))],
  ['规则全挂不影响出线路', Array.isArray(a1Streams) && a1Streams.length > 0],
];
for (const [name, ok] of a1Asserts) {
  console.log((ok ? '✔ ' : '✖ ') + name);
  if (!ok) failed++;
}
if (!Array.isArray(a1Streams) && process.env.DUMP) console.log(a1Log);

console.log('─'.repeat(60));
console.log(failed ? `${failed} 项未通过` : '全部通过');
console.log('ℹ 动画 tracker（kitsu:/mal:/anilist:）走真网络：node test/live-tracker.mjs');
process.exit(failed ? 1 : 0);
