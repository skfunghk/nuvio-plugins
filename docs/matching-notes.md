# 中文名对到 TMDB 的办法（以及为什么插件不能「在 Nuvio 搜到」）

写于 2026-11-27，对着 `docs/nuvio-plugin-contract.md` 的源码结论和一次实测。

## 1. 先厘清一件事：Nuvio 没有「插件搜索」

契约第 1 节：宿主只调用一个函数 `getStreams(tmdbId, mediaType, season, episode)`，没有 catalog /
home / search 钩子。也就是说：

- **在 Nuvio 搜索框打中文名，搜的是 TMDB 的片库，插件完全没参与。** 搜不到就是 TMDB 那边
  没有这个中文名（或 Nuvio 用的语言里没有），跟插件叫什么名字、manifest 写什么无关。
- 插件只在「你已经打开某个 TMDB 条目、按播放」之后才被调用，任务是**为这个 TMDB ID 找回线路**。
- 插件显示名叫 `Kazumi 规则`，出现在 Settings → Plugins 与播放源的列表里，不参与搜索建议。

所以「名字对不对得上」有两层，要分开看：

| 层 | 谁的锅 | 怎么修 |
| --- | --- | --- |
| Nuvio 搜索里找不到这部剧 | TMDB 条目 / 你 app 的语言 | 在 TMDB 补中文名，或在 Nuvio 把界面/元数据语言设成中文；跟插件无关 |
| 打开条目后插件不出线路 | 插件把 TMDB ID 换成片名去中文站搜的那一步 | 就是本文下面这些 |

## 2. Nuvio 能传什么 ID

契约第 4 节（读自 NuvioTV / NuvioMobile 源码）：

- 正常情况传**数字 TMDB ID**；`tmdb:` / `movie:` / `series:` 前缀会被剥掉，IMDb ID 会被转成 TMDB。
- 只有转换失败时，`kitsu:` / `mal:` / `anilist:` 才会原样透传（`anidb:` 三段式同理）。
- **没有 Bangumi**。Bangumi 的 subject id 不会被传进来，插件也读不到它。

结论：**Bangumi / AniList / MAL 的 ID 都不能当 Nuvio 的入口**。它们只能当插件内部的
「换名工具」——用 TMDB ID 进去，用 Bangumi 的中文名出来。

## 3. 现在这条链怎么走（kazumi.js 0.1.1）

```
tmdbId
  └─ TMDB /tv/{id}?language=zh-CN&append_to_response=translations,alternative_titles
       └─ 候选名：name、original_name、translations 里 zh-TW / zh-HK / en / ja / ko、
                  alternative_titles 里 CN / HK / TW / SG / US / GB / JP / KR 的条目
            └─ Bangumi 桥（新增）
                 ├─ POST https://api.bgm.tv/v0/search/subjects  {keyword, filter:{type:[2]}}
                 │    用中文候选名搜动画条目，按「标题相似度 + 首播年差」挑一个
                 ├─ GET  https://api.bgm.tv/v0/subjects/{id}
                 │    取 name（日文原名）、name_cn（简体）、infobox 的「别名」
                 └─ 追加为 rank 2 候选名
                      └─ 再补一层「繁体 → 简体」字的归一（片名高频字表）
                           └─ 拿这些名字去各 Kazumi 规则站点搜，找到条目后取集数与直链
```

要点：

- Bangumi 只在**需要时才补**：TMDB 名之外多出候选才有意义；它整段失败（超时、403、解析不到）
  都只写一行 warn，不影响正常搜索。预算是 6 秒。
- 命中判据不只看名字：`相似度 ≥ 0.55` 且首播年差 0（+0.3）、≤1 年（+0.1）、否则 −0.2。
  这一点防的是「同名不同片」——例如同名但不同年份的续作。
- 繁简归一是**兜底**，不是完整转换表：只覆盖片名高频字（擊/击、進/进、龍/龙…），
  真正提供两种写法的是 TMDB 的 zh-TW + Bangumi 的 name_cn / 别名。

## 4. 为什么不用别的 ID 体系

| 方案 | 能不能让 Nuvio 直接读 | 判断 |
| --- | --- | --- |
| TMDB ID | 能（宿主本来就在传） | 唯一入口 |
| Bangumi subject id | 不能（契约没有这个字段） | 只能当内部换名工具 |
| AniList / MAL / Kitsu id | 仅在 TMDB 转换失败时透传 | 不能依赖，只作兜底 |
| IMDb id | 宿主自己会转成 TMDB | 无关 |
| TMDB 的 `external_ids`（tvdb/imdb） | 插件读得到，但站点不认这些 ID | 对搜索没帮助 |

## 5. 自测

```bash
node test/kazumi-matching.mjs     # 中文名对齐：TMDB 只有简体名，站点只有繁体名 → 仍能搜到
node test/run-tests.js            # 插件契约 / manifest / 报错行为
```

`test/kazumi-matching.mjs` 不联网：TMDB、Bangumi、KazumiRules、站点全部由 fetch 垫片回答，
断言的是「简体名先试、繁体别名后补」这条顺序，以及 Bangumi 桥真的取了别名。

## 6. 还没做

- 未在真机 Nuvio 里点过 in-app Test（本机没有 sideloaded 版）。
- TMDB 那一步 live 未跑（本机没有 TMDB key）；`test/kazumi-matching.mjs` 用 fixture 代替。
- Bangumi 没有做缓存：每次 `getStreams` 多 2 个请求（搜索 + 条目），6 秒预算内。
  如果嫌慢，可以在插件里按 tmdbId 缓一轮，但 Nuvio 每次调用都是新沙盒，跨调用缓存要靠宿主设置。

## 7. Nuvio 到底用什么「匹配」资源（0.2.0 的更正）

上一版这里写得太笼统。读 `NuvioTV:dev` 与 `NuvioMobile:cmp-rewrite` 的实际代码后，准确说法是：

```kotlin
// NuvioTV app/src/main/java/com/nuvio/tv/data/repository/StreamRepositoryImpl.kt
val tmdbId = tmdbService.ensureTmdbId(videoId, type)          // ① 先试 TMDB
val pluginRequest = buildPluginRequest(tmdbId, type, videoId) // ② 转不到才用原 id
val (pluginSeason, pluginEpisode) = resolvePluginSeasonEpisode(videoId, season, episode)  // ③
```

① `ensureTmdbId` 把 `tt…`、`kitsu:`、`anilist:`、`mal:`、`anidb:` 的 videoId 换成 TMDB id。
② 换不到且 videoId 是 `kitsu:` / `anilist:` / `mal:` 时，**把 tracker id 原样传给插件**
   （`kitsu:12345:2` 会去掉尾部集号 → `kitsu:12345`；`anilist:` / `mal:` 不去）。
③ `PluginEpisodeRequestRules.kt`：三段式的动画 id（`kitsu:6448:68`）**没有季的概念**，
   于是传 `season = null`、`episode = 绝对集号 68`。

也就是说：

| 条目来源 | 插件收到的 id | 插件收到的 season / episode |
| --- | --- | --- |
| 一般影视（有 TMDB） | `14285` | 正常 S/E |
| 动画（TMDB 能映射） | TMDB id | `season = null` + **绝对集号** |
| 动画（TMDB 映射不了） | `kitsu:7442` / `anilist:113415` / `mal:16498` | `season = null` + 绝对集号 |
| 电影 | TMDB id | `null` / `undefined`（本插件明确报错，只有动画剧集） |

**所以「匹配」跟片名没有关系：宿主只给 id，片名是插件自己换出来的。** 0.1.1 之所以还是不对，
就是因为插件把非 TMDB 的 id 直接拒了（`只支持 TMDB 数字 ID`），动画条目根本没进到搜索那一步。

NuvioMobile 侧另有 `PluginContentIds.kt`：`pluginContentId()` 会剥掉 `tmdb:` 前缀和 `:season:episode`
尾巴，所以插件收到的永远是干净的 id。

## 8. 0.2.0 改了什么

1. **接受动画 tracker id**：`kitsu:` / `mal:` / `anilist:` 用各自公开 API 换成片名
   （Kitsu `api/edge/anime/{id}`、AniList GraphQL `Media(id:)`、MAL 走 Jikan `v4/anime/{id}`）；
   `anidb:` 没有公开 JSON，明确报 `HOST_UNSUPPORTED` 而不是猜。
2. **绝对集号按季累加**：站点把动画按季拆成多个条目（进击的巨人 25 / 第二季 12 / 第三季 12 /
   第三季 Part.2 10 / 最终季 16…），绝对第 68 集要落在这条链的第 68 个位置。
   现在按季号升序逐条累加，「最终季 / 完结篇」这类没有季号的排在最后；
   绝对集号模式下这类条目过去会被直接丢掉（`describeAbsolute` 返回 null），现在保留。
3. **flat 模式多片名合并**：一个片名的搜索结果常常只覆盖前几季，最多合并两个片名的结果。
4. 章节抓取预算在 flat 模式下从 4 条放宽到 6 条。

## 9. 真网络验证（2026-11-27，本机）

`node test/live-tracker.mjs`：

| 调用 | 结果 | 线路 |
| --- | --- | --- |
| `kitsu:7442:1` | 绝对第 1 集 → 进击的巨人 第 1 项 | `…/AttackonTitanS1/01.mp4` |
| `kitsu:7442:30` | 25+5 → 第二季 第 5 项 | `…/AttackonTitanS2/05.mp4` |
| `kitsu:7442:68` | 25+12+12+10+9 → 最终季 第 9 项 | `…/AttackonTitanS4/09.mp4` |
| `anilist:113415:1` | 咒术回战 第 1 项 | `…/JujutsuKaisen/01.mp4` |
| `anilist:113415:25` | S1 共 24 集 → 第二季 第 1 项 | `…/JujutsuKaisenS2/01.mp4` |

`kitsu:7442:1` 的线路做过 Range 取流：`206`、`video/mp4`、`ftypisom`。

## 10. 已知未完成

- **`mal:` 未在真网络验证**：本机到 `api.jikan.moe` 超时（40 s），代码路径正确但没跑通结果；
  报错是明确的 `UPSTREAM_ERROR: api.jikan.moe 返回 0`。
- `anidb:` 不支持（无公开片名 API）。
- 站点没有对应季度条目时仍会 `NOT_FOUND`（例如站点只有「第二季」而你要第 1 集），
  这种情况换片名也救不了，属于站点片库缺口。
- 未在真机 Nuvio 里点过 in-app Test（本机没有 sideloaded 版）。

## 11. 0.3.0：改用 ani.zip 做 id 映射（比按名字猜更准）

参考实现：`https://stremio-anime1.vercel.app/plugin/manifest.json`（宿主 `plugin/providers/anime1.js`，v1.1.0，
同一个作者）。它的做法不是「拿片名去站点搜」，而是：

```
kitsu id ──► https://api.ani.zip/mappings?kitsu_id=…  ──► TMDB id / TVDB id / 多语言片名 / 每集 S/E 坐标
                                                        └─ 有 TMDB id 就再取 TMDB 的分季表与翻译名
```

`api.ani.zip/mappings` 支持 `kitsu_id` / `mal_id` / `anilist_id` / `themoviedb_id` / `thetvdb_id`，
返回：

| 字段 | 用途 |
| --- | --- |
| `mappings.themoviedb_id` | 直接把 tracker id 换成 TMDB 条目，再接 TMDB 的翻译与分季表 |
| `mappings.thetvdb_id` | TMDB 没有时走 `/find?external_source=tvdb_id` |
| `titles['zh-Hant'] / ['zh-Hans'] / ja / en / x-jat` | **繁体与简体片名直接从 id 来**，不依赖搜索命中 |
| `episodes[N].seasonNumber / episodeNumber` | 绝对集号 → 第几季第几集，不用按季累加去估 |

kazumi 0.3.0 采用同一套：

1. `trackerInfo` 先打 ani.zip，片名与集数坐标都来自它；tracker 自己的 API（Kitsu/AniList/Jikan）降级成补名。
2. `makeWant` 优先用 `episodeMap` 把绝对集号换成 `(season, episode)`，走原来那套经过测试的分季定位；
   `episodeMap` 没覆盖（例如 kitsu:7442 只有 26 集，而你要第 68 集）才退回按季累加。
3. 宿主有 `TMDB_API_KEY` 时，用 ani.zip 给的 `themoviedb_id` 取 TMDB 分季表 → `info.flat` 变 false，
   season 定位完全走 TMDB 语义。

实测（2026-11-27，本机真网络，无 TMDB key）：

| 调用 | ani.zip 映射 | 结果 |
| --- | --- | --- |
| `anilist:206401:1`（FX战士久留美） | tmdb 311842 / tvdb 472962 / 12 集 / `zh-Hant` = FX戰士久留美 | 2 条 HLS（繁體 `…CHT/01/playlist.m3u8` + 原版） |
| `kitsu:7442:1` | tmdb 1429 / 26 集坐标 | S1E1 |
| `kitsu:7442:30` | 26 集坐标 | 第二季 第 5 项 |
| `kitsu:7442:68` | 26 集坐标不够 → 按季累加 | 最终季 第 9 项 |
| `anilist:113415:25` | tmdb 95479 / 25 集坐标 | 第二季 第 1 项 |

离线断言（`node test/kazumi-matching.mjs`，场景 B）：ani.zip 以 `anilist_id` 查询、用它的季集坐标定位、
用它给的繁体片名去站点搜、拿到线路 —— 4 项全过。

### 为什么这一层比「Bangumi 补名」更靠前

- Bangumi 桥是**按名字搜条目**，要判断相似度、年份，同名不同片会错；ani.zip 是**按 id 换 id**，没有歧义。
- Bangumi 只给中文名，ani.zip 一次给 TMDB id + 繁体/简体/日文/英文 + 集数坐标。
- 但两者不冲突：ani.zip 拿不到（小站/新番）时，Bangumi 桥仍然补中文名，作为第二层。

## 12. 与 `Stremio/addons/anime1` 的实现逐项对比（0.4.0）

参考文件：`~/Developer/projects/Stremio/addons/anime1/plugin/providers/anime1.js`（715 行，v1.1.0）。

它比 kazumi 强的地方是**匹配靠本地方案索引，不靠站点搜索**：

| 维度 | anime1 插件 | kazumi 0.3.0（改前） | kazumi 0.4.0（改后） |
| --- | --- | --- | --- |
| id → 片名 | ani.zip + TMDB（有内置备用 key） | ani.zip + tracker API + Bangumi | 同 0.3.0 |
| 检索对象 | 本地索引 `animelist.json`（1966 行，缓存 30 分钟） | 每个规则站点的搜索接口 | 同 0.3.0（站点搜索是外部约束，改不了） |
| 集数区间 | `spanOf(status)` 解析「連載中(08)」「29-38」「劇場」 | 无 | 无（规则站点的 `vod_remarks` 不带区间） |
| 编号模式 | `span.start > 1 ? abs : rel` —— 条目接着上季编号时用绝对集号 | 一律按位置累加 | **按条目自带编号直取**（`numberedRoad` 第一项 > 1 且含目标集号时） |
| 季名对齐 | 用 TMDB 的 season `name` 跟条目名比（「The Final Season」↔「最终季」） | 只有季号标记正则 | 同左（未采用季名比对） |
| 片名相似度 | 精确 100 / 包含 84·66 / CJK 重合 ≥0.85 且 ≥3 字 → 72，拉丁词命中 | 前缀匹配 + 繁→简归一 | 前缀匹配 + 繁→简归一 + **CJK 重合兜底（≥0.85、≥3 字，仅在前缀失败时）** |
| 媒体请求头 | 带 `Referer` / `Origin` / `UA`，并把 watch API 的 `Set-Cookie` 转给 MP4 主机 | 不带任何 headers | **带 `Referer`（规则 baseURL）/ `UA` / 站点 Cookie** |
| 播放地址校验 | 不校验 | 发 Range 探测（2 字节前缀） | 同左 |

已经搬过来的三条：

1. **Cookie 转发 + Referer/UA**（0.4.0）：`rawFetch` 统一吸收 `Set-Cookie`，`buildStream` 把它们放进
   `stream.headers`。实测 giriGiri 的媒体主机不需要，但 MXdm 之类的 CDN 需要，之前是要靠宿主猜。
2. **条目自带连续编号**：站点把第二季编号接着上季（29-38）时，绝对集号直接对标签，不再按位置累加。
3. **CJK 重合度兜底**：前缀匹配失败时，用「至少 3 个汉字且重合 ≥0.85」再认一次，避免换写法就搜不到。

没有搬的：

- **本地索引**：kazumi 面对的是几十条规则的几十个站点，没有统一的索引可抓；这一点 anime1 插件天然占优（
  它只服务一个站，且那个站提供了 `animelist.json`）。
- **`spanOf` 集数区间**：规则站点的列表接口只给「更新至 09 集」，不给区间，拿不到就只能按条目顺序推。

离线断言（`node test/kazumi-matching.mjs`，三组场景全过）：

| 场景 | 断言 |
| --- | --- |
| A：TMDB 只有简体名，站点只有繁体名 | Bangumi 补名 → 繁体别名搜索 → 出线路 |
| B：`anilist:206401:1` | ani.zip 查询 → 季集坐标 → 繁体片名搜索 → 出线路 |
| C：`kitsu:9999:34`，站点条目编号 29-38 | 按条目自带编号命中第 34 项 → 取到 34.mp4 → 线路带 Referer |

## 13. 0.4.1：季名对齐实测（带 TMDB key）修掉两个 bug

用 `anime1` 插件的内置 key 那套做法实测 TMDB（`/tv/1429?language=zh-CN`）：

```
S1 第 1 季(25)   S2 第 2 季(12)   S3 第 3 季(22)   S4 最终季(28)
```

TMDB 的 S4 名就叫「最终季」，所以 `nameSignature` 本来就能对齐站点的「进击的巨人 最终季」。
但一跑就暴露两个真问题：

### bug 1：整名别名把季号吞掉

0.1.1 加的 Bangumi 别名里有一条就叫「进击的巨人 最终季」。`titlesByKey` 用「最长已知名」做同分
tie-break，于是整名别名命中、`rest` 变空，条目被判成 `whole` 而不是 `season`，S4 就没有 head 可用：

```
[候选] 进击的巨人 最终季 | group=whole marker=null score=100   ← 错
```

改为「rest 里还留着季号的已知名优先，同分取较短已知名」后：

```
[候选] 进击的巨人 最终季 | group=season marker=null score=190  ← 对（走 season signature 分支）
giriGiriLove:「进击的巨人 最终季」线路「chs」第 9 项 =「09」
```

### bug 2：TMDB 的分季跟站点不一致时没有退路

咒术回战：TMDB 95479 把两季合成 `S1 = 59 集`，站点却是 `咒术回战 24` + `咒术回战 第二季 23`。
ani.zip 给的坐标是 `第 25 集 = S1E25`，`want.episode = 25` 超过站点 24 集的条目 → `NOT_FOUND`。

新增一条退路：分季定位失败后，按**站点自己的条目顺序**再累加一次：

```
giriGiriLove: 换用站点自己的分季顺序命中
```

### 实测矩阵（真网络，两个 key 状态各 6 个场景）

| 调用 | 无 key | 带 key |
| --- | --- | --- |
| `kitsu:7442:1` | 1 条 | 1 条 |
| `kitsu:7442:30` | 1 条 | 1 条 |
| `kitsu:7442:68` | 1 条 | 1 条（最终季第 9 项） |
| `anilist:113415:1` | 1 条 | 1 条 |
| `anilist:113415:25` | 1 条 | 1 条（换用站点分季顺序） |
| `anilist:206401:1` | 2 条 | 2 条 |

## 14. 为什么默认只有 1 条源（2026-11-27 复测）

`RULE_STATUS` 的分层不是随便定的，是按「纯 HTTP 能不能拿到播放地址」实测：

| 规则 | 搜索 | 剧集 | 播放地址 | 结论 |
| --- | --- | --- | --- | --- |
| giriGiriLove | API 200 | API 200（返回媒体 URL） | 直接给 | 唯一稳定 |
| akianime | 200（49 KB） | 200 | 播放页要执行脚本才有地址 | 不可用 |
| MXdm | 200（13 KB） | — | 搜索结果页 HTML 里 **0 个详情链接**（JS 渲染） | 不可用 |
| ezdmw | 200（52 KB） | 未验 | 未验 | 不可用 |
| 其余 12 条 | 多为 403/404/超时 | — | — | 停用 |

也就是说：**「多一条规则」不等于「多一条能播的源」**——中文动漫站基本都改成 JS 渲染搜索/播放页，
而 Nuvio 插件只有 `fetch`，没有 WebView，拿不到脚本生成的东西。

同一天的上游健康状况也说明单源的风险：

```
giriGiri  get_list  08:xx 504 / 20 s 超时（连续两次）→ 之后恢复 200
giriGiri  get_detail 卡住 20 s 以上（搜索正常、剧集接口挂）
anime1.me animelist.json / 首页 → 521（Cloudflare 源站宕机）
```

## 15. 0.4.2：单源挂掉时不要陪葬

| 改动 | 原因 |
| --- | --- |
| 5xx 不再重试 | giriGiri 返回 504 时，重试会把 40 秒预算烧光，别的规则一条也没机会 |
| 单条规则 TIMEOUT 不再中断整次调用 | 之前在 `attempt()` 里 `throw`，一条规则卡住 → 整次返回 0 |
| 单集无编号的条目判为剧场版/合集并跳过 | akianime 把「进击的巨人后篇自由之翼」当第 1 集 |
| flat 累加按 ani.zip 给的季过滤 | 站点只有「第二季」时，第 1 集被当成第二季第 1 集；该季确实没有条目时直接报 NOT_FOUND，不猜 |

复测（giriGiri 恢复后）：

```
kitsu:7442:1     → 1 条 mp4（S1E1）     12.7 s
anilist:206401:1 → 2 条 HLS（繁體 + 原版）
```

## 16. 0.5.0：把 anime1.me 做成内置源

`docs/rule-audit-2026-11-27.md` 的结论是 KazumiRules 18 条里只有 giriGiriLove 能用，所以 0.5.0 把
**anime1.me 直接内置进插件**，不再依赖规则库：

```
索引  GET https://anime1.me/animelist.json        → [[catId, 名称, "連載中(25)" | "29-38" | "劇場", 年, 季, …]]
集数  GET https://anime1.me/?cat=<catId>&paged=N  → <article> 里是各集文章 /{postId}
换址  GET https://anime1.me/<postId>              → <video data-apireq="…">
      POST https://v.anime1.me/api  d=…           → { s: [ { src: "//hinata.v.anime1.me/1989/03.mp4" } ] } + Set-Cookie
```

跟规则并列跑，互不依赖：

- 规则拿到 2 条线路时也会继续问 anime1（受 `MAX_STREAMS = 8` 限制）；
- 规则全挂（例如 giriGiri 504）时 anime1 仍然出线路，反之亦然；
- 行选取用站点的 `status` 区间：`span.start > 1`（如 `29-38`）按**绝对集号**，否则按季内集号；
- 片名匹配用「精确 100 / 包含 84·66 / CJK 重合 ≥0.85 且 ≥3 字 72」，和 anime1 那份 addon 一致；
- 换址响应里的 `Set-Cookie` 会带进 `stream.headers.Cookie`（MP4 主机要用），Referer/Origin 也一起给。

离线断言（`node test/kazumi-matching.mjs` 场景 D，6 项）：读索引 → 区间命中 → apireq 换址 → 出 mp4 → Cookie 带上 → 规则全挂仍出线路。

真网络：giriGiri 正常（`kitsu:7442:3` → `AttackonTitanS1/03.mp4`），anime1 当天 `521`（源站宕机），
插件按设计只记一条 warn，不影响另一条线路。
