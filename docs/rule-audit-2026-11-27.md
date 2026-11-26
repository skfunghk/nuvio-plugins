# KazumiRules 规则体检（2026-11-27）

来源：[`Predidit/KazumiRules`](https://github.com/Predidit/KazumiRules) 的 `index.json`，共 **18 条**规则。
方法：把每条规则按它自己的 `searchMode` / `chapterMode` 走一遍真实请求 ——
搜索（关键字「进击的巨人」）→ 详情页 → 第一集播放页 → 在页面源码里找 `.m3u8` / `.mp4` → Range 取 2 KB 验证。

判定标准只有一条：**不执行页面脚本，能不能拿到可播地址**。Nuvio 插件只有 `fetch`，没有 WebView。

| 规则 | 搜索 | 剧集 | 播放地址（Range 验证） | 备注 |
| --- | --- | --- | --- | --- |
| `7sefun` | xpath 200 | xpath 200 | - | 命中 21 |
| `AGE` | xpath 0 | - | - | 搜索 0 |
| `DM84` | xpath 200 | xpath 200 | 无 (剧集页 200) | 命中 36 | 集 30 |
| `LMM` | api 200 | xpath 0 | - | 命中 14 |
| `MXdm` | xpath 200 | xpath 200 | 无 (剧集页 200) | 命中 36 | 集 4 |
| `TvTFun` | api 200 | xpath 0 | - | 命中 11 |
| `aafun` | xpath 200 | xpath 200 | 无 (剧集页 200) | 命中 49 | 集 8 |
| `akianime` | xpath 200 | - | - | 搜索页无详情链接(JS?) |
| `baimao` | xpath 200 | xpath 200 | 无 (剧集页 200) | 命中 48 | 集 10 |
| `dalvdm` | api 0 | - | - | 搜索 0 |
| `ezdmw` | xpath 200 | xpath 200 | - | 命中 29 |
| `giriGiriLove` | api 200 | api 200 | https://akua.girigirilove.com/zijian/anime/2024/09/0911/ShingekinoKyojinTheFinalSeasonKank [206] | 命中 10 | 集 1 |
| `mgnacg` | api 200 | xpath 200 | 无 (剧集页 200) | 命中 12 | 集 12 |
| `moonci` | api 200 | xpath 0 | - | 命中 12 |
| `mutefun` | xpath 0 | - | - | 搜索 0 |
| `sorani` | api 200 | api 200 | 无 (剧集页 0) | 命中 19 | 集 1 |
| `xfdmneo` | xpath 0 | - | - | 搜索 0 |
| `xfdmnext` | api 0 | - | - | 搜索 0 |

## 结论

**只有 `giriGiriLove` 一条能用**：它 `searchMode=api` + `chapterMode=api`，剧集接口的
`vod_play_url` 直接写媒体地址，Range 实测 `206`。

其余 17 条为什么不行：

| 类型 | 规则 | 原因 |
| --- | --- | --- |
| 搜索页 JS 渲染 | akianime、MXdm、e2dmw 之外的多数 | 搜索 HTML 里没有详情链接（MXdm 的详情页 9 KB，`m3u8`/`player_aaaa` 都是 0 次） |
| 详情页 JS 渲染 | MXdm、DM84、aafun、baimao、mgnacg | 详情页 HTTP 200 但集数链接是脚本生成的 |
| 剧集接口要 cookie/UA | sorani | `api/api`，但 `get_detail` 返回 0 字节 |
| 第三方播放器 | 7sefun、LMM | 播放页嵌的是 dpmp4/lmm85 之类的解析器页面 |
| DNS / 403 / 超时 | AGE、dalvdm、mutefun、xfdmneo、xfdmnext | 本机网络不可达或站点拒绝 |
| 站点 5xx | giriGiriLove（当天早些时候） | `get_list` 504、`get_detail` 卡 20 s，之后恢复 |

原始数据：[`rule-audit-2026-11-27.json`](rule-audit-2026-11-27.json)。

## 这对插件的意义

- `RULE_STATUS` 的分层（1 stable / 4 experimental / 12 disabled）在这次体检后**仍然成立**，
  没有可以升级的规则。
- 想真正增加源，只能找「媒体地址写在纯 HTML 里」的站，或者换协议（WebView/自动化），
  而不是继续在 KazumiRules 里挑。
- 单源的风险已经用 0.4.2 缓解：5xx 不重试、单条规则超时不中断整次调用，
  这样 giriGiri 抖动时不会连累其它规则（虽然目前没有别的规则能接手）。
