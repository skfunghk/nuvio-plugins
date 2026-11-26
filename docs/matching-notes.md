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
