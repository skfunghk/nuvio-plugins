# Gimy TV · Nuvio 插件

把 [gimytv.io](https://gimytv.io) 作为 Nuvio 的视频源。**只提供线路**，不含片库与搜索（宿主只调用 `getStreams`）。

## 装法

Nuvio：Settings → Content & Discovery → Plugins → Add repository，贴：

```
https://raw.githubusercontent.com/skfunghk/nuvio-plugins/main/gimy/manifest.json
```

或者用仓库根目录的 manifest 一次装齐（kanju + kazumi + gimy）。

## 链路（纯 HTTP，实测）

```
搜索  GET /search?q=<片名>            → 卡片（301 到 gimytw.cc，宿主自动跟随）
详情  GET /voddetail2/{id}.html       → ul#con_playlist_1 里的 /eps/{id}-{n}.html
播放  GET /eps/{id}-{n}.html          → iframe src="/_watch/{token}"
      GET /_watch/{token}             → 页面源码里的 .m3u8
```

## 为匹配做的事

| 手段 | 为什么 |
| --- | --- |
| TMDB 多语言片名（zh-CN/zh-TW/zh-HK/ja/ko/en + translations + alternative_titles） | 站点的译名跟 TMDB 的中文名常不同 |
| **繁简 + 异体字归一（202 组）** | 实测：`隱祕的角落`（站）vs `隐秘的角落`（TMDB）因「祕/秘」对不上；归一后才能命中 |
| base 名精确相等才算同一部 | 否则「進擊的巨人」会配到「進擊的巨人 LOST GIRLS」这种衍生作 |
| 季标记 + 绝对集号（TMDB 分季累加） | 站点按季拆条目时，第 2 季第 5 集要落到绝对第 30 集 |

## 实测（2026-11-27）

| TMDB | 结果 |
| --- | --- |
| 535167 流浪地球（movie） | ✅ 第 01 集 → `vip.lz-cdn10.com/…/index.m3u8` |
| 105053 沉默的真相 S1E5 | ✅ 第 05 集 → `vip.lz-cdn6.com/…/index.m3u8` |
| 104960 隐秘的角落 S1E12 | ✅ 第 12 集 → `vip.lz-cdn8.com/…/index.m3u8` |
| 104960 隐秘的角落 S1E1 | ⚠️ 站点该集没有 `_watch`（无播放器）→ 返回 0，不伪造 |
| 1429 进击的巨人 S1E1 | ⚠️ 站点该条目播放列表是 JS 渲染（HTML 里 0 条）→ 返回 0 |

## 已知限制

- 站点部分条目的播放列表由 JS 渲染（如进击的巨人），插件拿不到集数 → 返回空，不会给错片。
- 部分集数页没有 `_watch`（预告/占位）→ 该集无线路。
- 只输出 m3u8；播放时带 `Referer: https://gimytv.io/`。
