# Kazumi 规则 · Nuvio 插件

把 [KazumiRules](https://github.com/Predidit/KazumiRules)（MIT）的规则换成 Nuvio 可播放的线路。
只提供线路，不含片库或搜索；只有动画剧集；仅限可侧载（sideloaded）版 Nuvio。

## 安装

在 Nuvio：Settings → Content & Discovery → Plugins → Add repository，贴：

```
https://raw.githubusercontent.com/skfunghk/nuvio-plugins/main/kazumi/manifest.json
```

再打开「Enable plugin providers globally」。想一次过装 Kanju + Kazumi，用 repo 根目录的 manifest：

```
https://raw.githubusercontent.com/skfunghk/nuvio-plugins/main/manifest.json
```

## 两个入口，二选一

| 入口 | 默认 | 用咩规则 | 实测结果 |
| --- | --- | --- | --- |
| Kazumi 规则 | 开 | 只用 giriGiriLove | 2026-11-26 live：《进击的巨人》S1E1 / S3E1 / S5E12 全部出到可播 mp4（206） |
| Kazumi 规则（实验） | 关 | 再加 akianime、MXdm、ezdmw、AGE | 同日 live：MXdm 出到可播 m3u8（200，`#EXTM3U`），但早前 probe 见过 403；akianime 播唔到（要执行页面脚本）；ezdmw、AGE 未确认 |

## 中文名对齐（0.1.1）

TMDB 的 `zh-CN` 名同中文站点写法经常唔同（繁简、官方译名 vs 民间译名），所以插件除咗 TMDB 嘅
`translations` + `alternative_titles`，仲会经 **Bangumi** 补名：

```
TMDB 中文名 → POST api.bgm.tv/v0/search/subjects（type=2 动画）→ 按标题相似度 + 首播年挑条目
            → GET api.bgm.tv/v0/subjects/{id} → name / name_cn / 别名
            → 追加为候选名，再去站点搜
```

- Bangumi 只做「换名工具」，**Nuvio 读唔到 Bangumi ID**（宿主只传 TMDB，或转换失败时透传
  kitsu/mal/anilist）。所以 Bangumi 条目 id 唔可以当入口用。
- 补名失败（超时／403／解析唔到）只会写一行 warn，唔影响正常搜索；预算 6 秒。
- 另加一层片名高频繁体字 → 简体字嘅归一，做兜底比较。
- 自测：`node test/kazumi-matching.mjs`（离线，TMDB + Bangumi + 站点全部用 fetch 垫片）。

详见 [`docs/matching-notes.md`](../docs/matching-notes.md)。

## 动画 ID 点样入嚟（0.3.0：ani.zip 映射）

Nuvio 对动画条目唔系用片名配资源，而系：

```
videoId → ensureTmdbId()  →  有 TMDB id：传 TMDB id（season = null + 绝对集号）
                          →  冇：传 kitsu: / anilist: / mal: 原 id（season = null + 绝对集号）
```

所以插件收 `kitsu:` / `mal:` / `anilist:` id 之后，先用 **`api.ani.zip/mappings`** 换出 TMDB id、
繁/简/日/英片名同「第 N 集 → 第几季第几集」坐标（呢层系按 id 换 id，冇歧义），
再退返 tracker 自己的 API 同 Bangumi 补名；`anidb:` 明确报错。
绝对集号会按站点「逐季拆条目」的顺序累加（进击的巨人 25+12+12+10+9 → 最终季第 9 集）。
真网络验证：`node test/live-tracker.mjs`（5/5 场景拿到线路）。

## 做到咩、做唔到咩

- 收到 TMDB ID 之后，插件用中文／英文／日文片名（TMDB `zh-CN` + 翻译 + 别名，最多试 4 个名）去各规则站点搜，再攞集数、抽 m3u8／mp4 直链。动漫集数用绝对集号（NuvioTV 传 `season = null` + 绝对集数，插件识处理）。
- 规则文件运行时从 KazumiRules 仓库读取（先 `index.json`，再按需读规则文件），仓库不通时用插件内置的最佳规则快照。
- **做唔到**：Kazumi 本身靠 WebView 挂 hook 去捉播放连结，Nuvio 插件系 QuickJS 沙盒，得 `fetch`，冇 WebView、冇得执行页面 JS。所以播放地址只可以由页面源码度读（直链、iframe 一层、player JSON）。地址要靠页面 JS 先出现嘅规则，全部列为停用，唔会扮佢哋得。详见 `docs/kazumi-rules-survey.md`。
- 每次 `getStreams` 有预算：34 秒内唔开新请求、最多试 6 条规则、最多回 8 条线路（host 60 秒 kill）。

## 已分类规则（17 条有实测记录，其余未试）

- **稳定 1 条**：giriGiriLove（API 模式：搜索 + 集数 API 直接讲明媒体文件）。
- **实验 4 条**：akianime、MXdm、ezdmw、AGE（地址读得到，但播放未稳定确认）。
- **停用 12 条**：7sefun、LMM、mgnacg、TvTFun、baimao、DM84、sorani、xfdmnext、dalvdm（Cloudflare 403）、mutefun（验证码 403）、aafun、moonci（站点超时）。
- 其余约 69 条规则未逐一实测，插件默认唔会试佢哋。

## 测试

`output/test/`：`node test/run-tests.js` —— 2026-11-26：**60 passed，0 failed，425 assertions**。
Live 结果见 `output/test/live-results-2026-11-26.json`，报告见 `docs/verification-2026-11-26.md`。

## 未验证

- 未喺 Nuvio app 入面装过、未按过 in-app Test 掣（呢度冇 sideloaded 版／设备）。
- TMDB 嗰步 live 未跑过（测试机冇 TMDB key，用 fixture 代替）。
- 线路喺测试机网络确认可播，唔等于喺你嘅网络一定播到（CDN 可以按地区拒绝）。
