# kanju — 看剧AI streams for Nuvio

A plugin for Nuvio's **native plugin** system that offers the streams of 看剧AI
(`kanju44.com`, mirror `kanju.ai`) for films and series.

- **Streams only.** A Nuvio plugin is asked one question — "streams for this TMDB id?" — and this
  answers it. It adds no catalog, no search and no metadata.
- **Guest only.** No account, no login, no token. It uses the same request signing as the site's
  public web client, and the site's own guest flow. The signing key is read from the site at run
  time; nothing is embedded in the plugin.
- **No DRM handling.** Lines the site marks as not directly playable are left alone.
- **Sideloaded Nuvio builds only.** App-store builds have no plugins at all.
- Written for personal learning and self-use. See [Known limits](#known-limits).

It is a port of the HGhub provider `plugins/kanju.js` (v0.1.3). The Nuvio side — what a plugin can
rely on, with the source it was read in — is in [`docs/nuvio-plugin-contract.md`](docs/nuvio-plugin-contract.md);
what has and has not been tested is in [`docs/verification-2026-11-24.md`](docs/verification-2026-11-24.md).

## Two entries, one plugin file

Nuvio has no setting that works on both of its apps ([contract §11](docs/nuvio-plugin-contract.md#11-settings)),
so the plugin's one behaviour switch is the **entry it is installed as**. That is why there are two
manifest files and one plugin file, and why you should add **one** of the two repositories, not both:

| Add this manifest | Entry | What it returns |
|---|---|---|
| `manifest.json` | **看剧AI** (`kanju`) — the default | Up to 6 third-party lines (`m3u8` / `mp4`) that cost the site's guests nothing. It never creates a guest session and never spends playback quota. |
| `kanju/manifest.json` | **看剧AI 官方线路** (`kanju-official`) — opt-in | The same lines **plus the site's own official line**. To get it, the plugin creates the site's guest session when asked and resolves one ticket — which **spends the guest's playback quota, every time a source list is opened**, not only when you play. Films cost quota (60 000–72 000 tokens per load on 2026-11-24); the series episode tested did not. |

Both manifests point at the same file, `kanju/kanju.js`. There is no second copy of the plugin.

## Install

You need a **sideloaded** Nuvio build (NuvioTV `full` flavour, NuvioMobile `full`), and a Nuvio
build that has a TMDB key — official builds do; one compiled without `TMDB_API_KEY` cannot use this
plugin, which then logs `HOST_UNSUPPORTED`.

Once this folder is published as `skfunghk/nuvio-plugins` with `main` as its branch, the two
manifest URLs are:

```
https://raw.githubusercontent.com/skfunghk/nuvio-plugins/main/manifest.json            default entry
https://raw.githubusercontent.com/skfunghk/nuvio-plugins/main/kanju/manifest.json      opt-in official line
```

The manifest has to be called `manifest.json`, and `filename` in it is relative to the manifest's
folder — so keep `kanju/kanju.js` next to `kanju/manifest.json`.

**NuvioTV:** Settings → **Content & Discovery** → **Plugins** → **Add repository** → paste the
manifest URL → **Add**. The provider appears under *Providers*, switched on. Check that **Enable
plugin providers globally** is on. Select the provider and press **Test**: Nuvio then runs the
plugin for The Matrix (TMDB `603`) and shows how many streams came back.

**NuvioMobile:** the same section (Settings → Content & Discovery → Plugins), an *install
repository* button and a *test provider* button.

Then open any film or episode: the source list shows a **看剧AI** group.

To update the plugin later, refresh the repository.

## How a TMDB id becomes a stream

Nuvio passes only a TMDB id, a type (`movie` / `tv`) and, for series, a season and episode — never
a title. So:

1. **Titles.** `GET api.themoviedb.org/3/movie/{id}` or `/tv/{id}` with `language=zh-CN` and
   `translations,alternative_titles` appended, using the host's `TMDB_API_KEY`. Titles are ranked:
   the localized and the original title first, then Chinese, English, Japanese and Korean
   translations, then alternative titles from a few regions.
2. **Site search.** Each title is searched on the site (`/v1/browse/catalog`, at most 4 titles, a
   second page only if the first has nothing usable).
3. **Choosing a card.** A card scores points for its title (exact known title 100, translation 90,
   alternative title 80, a bilingual pair 70, an alias 50), the season marker in its title (+50 for
   the right season; a card with no marker counts as season 1), the year (+30 same, +15 one off,
   −60 otherwise) and popularity, minus a penalty for dubbed or re-cut variants. 70 or more is
   accepted; the best card wins. A card for another season is never accepted.
4. **Season.** A card can hold several seasons, so `/v1/catalog/{id}/detail` is read to pick the
   one whose `season_number` matches.
5. **Episode.** `/v1/catalog/{id}/episodes` is read for the episode with that number. A film takes
   its "正片" entry.
6. **Lines.** `/v1/playback/resolve/{token}` lists the lines. They are de-duplicated by provider,
   lines not offered to guests are skipped, and up to 6 direct media URLs are returned in the
   site's own order of preference. The official entry additionally resolves the site's selected
   official ticket.
7. **Result.** `[{ name, title, url, quality?, language? }]` — only fields the hosts read.

**Request signing.** Every `/v1` request carries `x-ai-movie-timestamp`, `x-ai-movie-nonce` and
`x-ai-movie-signature = hex(HMAC-SHA256(key, "METHOD\npath?query\ntimestamp\nnonce"))`. The key is
the 64-hex constant in the site's `movie-card-runtime-*.js`, found from the home page on every
call, because plugins have no storage. A rejected signature makes the plugin look the key up once
more. `kanju44.com` is tried first; if it is unreachable or has changed, `kanju.ai`.

**Budget.** The host kills a plugin after 60 s. The plugin stops starting new steps at 40 s and
stops retrying dropped connections after 15 s.

## Repository layout

```
manifest.json                     repository entry "kanju"          → kanju/kanju.js
kanju/
  kanju.js                        the plugin — the only copy
  manifest.json                   repository entry "kanju-official" → kanju.js (same folder)
docs/
  nuvio-plugin-contract.md        what Nuvio gives a plugin, with sources
  verification-2026-11-24.md      what was tested, and how
test/
  run-tests.js                    offline suite (Node's engine, Nuvio's own glue)
  quickjs-run.mjs                 the same scenarios inside the QuickJS engine
  live-check.mjs                  the plugin against the live site
  mock-host.mjs, host-glue.mjs, native-fetch.mjs, transport.mjs, fakes.mjs, offline-world.mjs
  fixtures/                       captured and hand-written data for the offline suite
```

Nuvio downloads only the manifest and the plugin file; everything else is for development.

## Known limits

- **Matching is by title, so it is lossy.** Same-name films are told apart by year alone. A dubbed
  or re-cut version is ranked lower, not excluded. A title the site files under a name TMDB does
  not have is not found (`NOT_FOUND`).
- **No anime numbering.** Season and episode must be TMDB's. NuvioTV sends an absolute episode
  number for anime trackers (`kitsu:` / `mal:` / `anilist:` ids); the plugin refuses those rather
  than guess. Season 0 (specials) is refused too.
- **Lines are third-party servers.** The plugin returns what the site lists, in the site's order,
  and does not test whether each one answers *from your network*. Some will not. When a line does
  not play, try the next. From the machine the plugin was tested on, 1 of 6 lines per title was
  reachable (one CDN answered "The region has been denied"); that says nothing about yours.
- **The official entry has a cost and gives no choice.** It creates a guest session (with a stable
  id per installation, so it is always the same guest), spends quota on films, and resolves only
  the one official line the site selects. When the quota is used up the site answers
  `playback_quota_exhausted`; the plugin logs it and still returns the third-party lines.
- **No caching.** Every call downloads the home page and the site's runtime chunk (about 260 KB).
  On NuvioTV, requests run one after another.
- **1 MiB per fetch.** Both hosts cut a response body at 1 MiB. If the site's runtime chunk ever
  grows past that, the plugin reports `UPSTREAM_CHANGED` rather than using a truncated key.
- **The site can change.** A changed home page, bundle or signing protocol ends in
  `UPSTREAM_CHANGED` and no streams; the reason is in Nuvio's log.
- **Not tried on a device.** See the verification report.

## Testing

Needs Node.js (tested with 24) and a checkout of the Nuvio sources at the commits named in
`test/host-glue.mjs`. Point `NUVIO_SOURCES` at it; the harness also looks, on its own, for a folder
named `nuvio-research` two levels above this one.

```sh
node test/run-tests.js                                  # offline, in Node's engine
npm install --no-save quickjs-emscripten@0.32.0         # test-only dependency
node test/quickjs-run.mjs                               # offline, in the QuickJS engine
node test/live-check.mjs                                # the live site, default entry
node test/live-check.mjs --official                     # the live site, opt-in entry (spends guest quota)
```

- `run-tests.js` runs the pure helpers, the title matching against results captured from the site,
  and the whole plugin inside Nuvio's own polyfill, wrapper and call code under both host
  profiles.
- `quickjs-run.mjs` repeats the scenarios in the QuickJS engine and fails if its streams differ
  from the first run's.
- `live-check.mjs` runs the real plugin file against the live site and prints every request, the
  plugin's log lines and what the first 4 KiB of each returned URL contain. Without
  `TMDB_API_KEY` in the environment, a stand-in answers for TMDB from `test/fixtures/tmdb`, so
  only the TMDB step is not live. It masks tokens and writes nothing.

To test on the device, use the provider's **Test** button, then open a title and look for the
**看剧AI** group in its sources.

## 中文快速說明

- 這是 Nuvio 原生插件（Plugins），只提供播放線路，沒有片庫、搜尋或詳情；只限可側載（sideloaded）版 Nuvio。
- 純遊客身份：不用帳號、不登入、不含任何 token；簽名金鑰每次從網站讀取。
- 兩個入口，只裝其中一個：
  - `manifest.json`（「看剧AI」）：只返回第三方直鏈，不建遊客會話、不耗額度。
  - `kanju/manifest.json`（「看剧AI 官方线路」）：多返回網站自己的一條官方線路；會建立遊客會話，電影每次載入線路列表都消耗遊客額度。
- 安裝：設定 → Content & Discovery → Plugins → Add repository → 貼上 manifest 網址 → Add → 確認「Enable plugin providers globally」已開 → 按 Test。
- 限制：靠片名比對，同名作品只憑年份區分；不支援動畫絕對集數及特別篇；第三方線路能否播放視乎你的網絡地區，播不到就換下一條。
- 未曾在實機上的 Nuvio 內測試；測試範圍見 `docs/verification-2026-11-24.md`。
