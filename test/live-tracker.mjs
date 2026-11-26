#!/usr/bin/env node
// 动画 tracker ID 的真网络验证（Nuvio 对动画条目就是这样调用插件的）：
//
//   kitsu:7442:1    绝对第 1 集   → 期望 S1E01
//   kitsu:7442:68   绝对第 68 集  → 期望 最终季 第 09 集（站点按季拆条目，插件按季累加）
//   anilist:113415:1  咒术回战 第 1 集
//
// 用法：node test/live-tracker.mjs            跑默认三个场景
//       node test/live-tracker.mjs kitsu:7442:30 - 30      自定义（第三个参数是 season，'-' 表示 null）
//
// 需要能访问 kitsu.io / api.bgm.tv / m.anime1 之外的站点；不做断言，只打印结果，供人工核对。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const code = readFileSync(join(ROOT, 'kazumi/kazumi.js'), 'utf8');

async function call(id, season, episode) {
  const logs = [];
  const sandbox = {
    module: { exports: {} },
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    fetch,
    SCRAPER_ID: 'repo:kazumi',
    TMDB_API_KEY: '',
    setTimeout, clearTimeout, Date, JSON, Math, Promise, URL,
    encodeURIComponent, decodeURIComponent, unescape, isFinite, Number, String, Array, Object, RegExp, Error, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'kazumi.js' });
  const started = Date.now();
  const streams = await sandbox.module.exports.getStreams(id, 'tv', season, episode).catch((e) => ({ error: e }));
  return { streams, logs, ms: Date.now() - started };
}

const cases = process.argv[2]
  ? [[process.argv[2], process.argv[3] === '-' ? null : Number(process.argv[3]), Number(process.argv[4] || 1)]]
  : [
      ['kitsu:7442:1', null, 1],
      ['kitsu:7442:30', null, 30],
      ['kitsu:7442:68', null, 68],
      ['anilist:113415:1', null, 1],
      ['anilist:113415:25', null, 25],
    ];

let bad = 0;
for (const [id, season, episode] of cases) {
  const { streams, logs, ms } = await call(id, season, episode);
  const list = Array.isArray(streams) ? streams : [];
  const pick = logs.find((line) => line.includes('按季累加落在')) || '';
  console.log(`\n=== ${id}  (season ${season}, episode ${episode})  ${ms} ms  →  ${list.length} 条`);
  if (pick) console.log('   ' + pick.replace(/^\[kazumi\] /, ''));
  if (list[0]) console.log('   ' + list[0].url);
  else console.log('   ' + logs.filter((l) => /NOT_FOUND|UPSTREAM|BAD_ARGUMENT|NETWORK/.test(l)).slice(-1).join(' ').replace(/^\[kazumi\] /, ''));
  if (!list.length) bad++;
}
console.log(`\n${cases.length - bad}/${cases.length} 个场景拿到线路`);
