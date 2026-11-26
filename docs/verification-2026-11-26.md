# Kazumi 插件验证报告（2026-11-26）

插件：`kazumi/kazumi.js` v0.1.0（6,016 行），`kazumi/manifest.json`（两个入口：`kazumi` 默认开、`kazumi-experimental` 默认关）。
规则来源：`Predidit/KazumiRules`，main 分支。

## 离线测试

`node test/run-tests.js`：**60 passed，0 failed，0 skipped；425 assertions**。

覆盖：API 模式端到端（fixture）、XPath 模式端到端（fixture）、TMDB 片名收集（fixture）、
绝对集号选择（`season = null`，episode 87）、播唔到嘅地址唔会回传、403 地址唔会回传、
默认入口唔试实验规则、GitHub 唔通时内置快照够用、冇 TMDB key 时回 `HOST_UNSUPPORTED`、
in-app Test 掣（The Matrix 当剧集）搵唔到嘢、站点无回应时唔 hang。
另有 QuickJS 引擎运行（`test/quickjs-run.mjs`），同 Node 结果一致。
Fixture 喺 `test/fixtures/`（giri 搜索／详情、规则文件、站点 HTML、TMDB TV 数据）。

## Live 测试

经 `test/mock-host.mjs` + curl 跑 `kazumi.js`，TMDB 用 fixture 代替（测试机冇 TMDB key）。
3 个场景，全部用《进击的巨人》（TMDB 14285）：

| 场景 | 回传线路 | 确认可播 |
| --- | --- | --- |
| S1E1（实验入口） | giriGiriLove mp4 `…/AttackonTitanS1/01.mp4`；MXdm m3u8 `bfikuncdn.com/…/index.m3u8` | mp4 range 请求 206 `video/mp4`；m3u8 200 `#EXTM3U` |
| S3E1（实验入口） | giriGiriLove mp4 `…/AttackonTitanS3/01.mp4`；MXdm m3u8 `bfikuncdn.com/…/index.m3u8` | 同上 |
| S5E12（实验入口） | giriGiriLove mp4 `…/AttackonTitanS4P2/12.mp4` | 206 `video/mp4` |

akianime 喺 3 个场景全部 `NOT_FOUND`（播放页源码冇可播地址，要执行页面脚本）。
MXdm 喺 S5E12 搵唔到对应条目（`没有第 5 季第 12 集所在的条目`）。
完整记录：`test/live-results-2026-11-26.json`。

搜索 probe（12 条规则，`_dev/live/summary_search.json`）：5 条回 200 且关键字喺 body
（akianime、ezdmw、giriGiriLove、mgnacg、sorani）；2 条 403（dalvdm、mutefun）；
1 条 301（baimao）；1 条 500（xfdmneo）；3 条超时（aafun、moonci、xfdmnext）。

## 未验证

- **未喺 Nuvio app 入面装过、未按过 in-app Test 掣**（呢度冇 sideloaded 版／设备）。
- **TMDB 嗰步 live 未跑过**（测试机冇 TMDB key；fixture 代替）。
- 线路喺测试机网络确认可播，唔等于喺你嘅网络一定播到（CDN 可以按地区拒绝；MXdm 早前 probe 见过 403）。
- 约 69 条规则未逐一实测，插件默认唔试佢哋。

## 过程备注

呢个插件经历咗 3 次 agent run：首两次俾 runtime restart 打断（第一次约 11 分钟，第二次约 1 小时 50 分钟），
收尾 run 做到尾段撞 z.ai 429（`All target providers failed`）停咗，README 同本报告由主 agent 按磁盘上嘅
实测证据（live 结果 JSON、测试输出、manifest、`kazumi.js` 内 `RULE_STATUS`）直接补写，冇再派 agent。
