# KazumiRules 调查（2026-11-26）

来源：`Predidit/KazumiRules`，main 分支。仓库有 **86 个规则文件 + `index.json`**（共 87 个 JSON）。

## 点解 `index.json` 得 18 条，仓库有 86 条

`index.json` 系 CI 自动生成（`.github/workflows/update-index.yml` 跑 `script/update_index.dart`）。
生成脚本会跳过两类文件：`deprecated: true` 嘅规则，同埋冇 `version` 字段嘅规则。
所以 `index.json` 唔系全部规则，只系通过咗呢两重过滤嘅 18 条。插件唔依赖 `index.json` 做唯一来源：
运行时先读 `index.json`，再按需读规则文件；内置快照兜底。

## 规则有咩模式

| 模式 | 点运作 | Nuvio 插件做到吗 |
| --- | --- | --- |
| api | 搜索 + 集数全部行 JSON API（`searchApiConfig` / `chapterApiConfig`，JSONPath + 分隔符格式） | **做到**，最稳（giriGiriLove） |
| xpath | 搜索页 + 集数页行 HTML + XPath（`searchURL` / `searchList` / `searchName` / `chapterRoads` / `chapterResult`） | **部分做到**：插件内置咗细 HTML 解析器 + XPath 子集；播放地址要由页面源码读到先得 |
| post | 搜索用 POST（API level 2+） | 视乎规则，代码有支援 POST 描述嘅请求，未逐一验证 |
| legacy parser | 用 iframe src 方式解析（API level 3+） | 概念上同插件嘅 iframe 跟进一样，但未逐一验证 |
| webview / JS hook | Kazumi 用 WebView 挂 hook 捉播放连结 | **做唔到**：QuickJS 沙盒冇 WebView、冇得执行页面 JS |

## 分类结果（17 条有实测记录）

### 稳定（1）

| 规则 | 模式 | 证据 |
| --- | --- | --- |
| giriGiriLove | api / api | Live：《进击的巨人》S1E1、S3E1、S5E12 全部出到 mp4，range 请求回 206 `video/mp4` |

### 实验（4）

| 规则 | 模式 | 证据 |
| --- | --- | --- |
| MXdm | xpath | Live S1E1、S3E1 出到 m3u8，回 200 `#EXTM3U`；但早前 probe 嗰阵同一类地址回过 403，唔稳定 |
| akianime | xpath | 搜到、读到集数，但播放页源码冇可播地址（要执行页面脚本）；live 3 个场景全部 `NOT_FOUND` |
| ezdmw | xpath | iframe src 用 base64 藏住 mp4 地址；早前 probe 回过 403，未确认可播 |
| AGE | xpath | 搜索页验证过；详情页超时，集数同播放未验证 |

### 停用（12）

| 规则 | 原因 |
| --- | --- |
| 7sefun | 播放地址系第三方播放器页（lmm85.com），回 404 + JS loader |
| LMM | 搜到、集数读到；播放页用 dpmp4 解析播放器 |
| mgnacg | 搜到、集数读到；播放地址由站点 JS 加密 |
| TvTFun | 搜到、集数读到；播放页靠脚本渲染 |
| baimao | iframe src 由页面 JS 写入 |
| DM84 | 第三方播放器 + 加密参数 |
| sorani | 搜索 + 集数 API 得；播放页靠脚本加载（`playUrl` 系 null） |
| xfdmnext | API 两次都超时 |
| dalvdm | Cloudflare 403（`Attention Required!`） |
| mutefun | 搜索回验证码页（403），规则本身开咗 `antiCrawlerConfig` |
| aafun、moonci | 站点超时（moonci.com 30 秒无回应） |

## 搜索 probe（`_dev/live/summary_search.json`，12 条规则，用《进击的巨人》）

| 规则 | 模式 | HTTP | 关键字喺 body |
| --- | --- | --- | --- |
| akianime | xpath | 200 | 有 |
| ezdmw | xpath | 200 | 有 |
| giriGiriLove | api | 200 | 有 |
| mgnacg | api | 200 | 有 |
| sorani | api | 200 | 有 |
| baimao | xpath | 301 | 无 |
| dalvdm | api | 403 | 无 |
| mutefun | xpath | 403 | 无 |
| xfdmneo | xpath | 500 | 无 |
| aafun、moonci、xfdmnext | xpath / api | 超时 | 无 |

其余约 69 条规则未逐一 probe／实测，插件默认唔试佢哋；有需要可以按上面嘅分类方法逐条加。
