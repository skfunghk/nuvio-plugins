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
  headers: { get: () => null },
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
    return response(routes(url, init));
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
console.log('─'.repeat(60));
console.log(failed ? `${failed} 项未通过` : '全部通过');
console.log('ℹ 动画 tracker（kitsu:/mal:/anilist:）走真网络：node test/live-tracker.mjs');
process.exit(failed ? 1 : 0);
