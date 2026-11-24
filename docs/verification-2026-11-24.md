# Verification report — 2026-11-24

What was tested, how, and what was not. Three groups, kept apart on purpose:

- **(a) Verified live** — the real plugin file talked to the real site.
- **(b) Verified by syntax, mock or engine only** — nothing left the machine.
- **(c) Not verifiable here** — including everything that needs the Nuvio app.

Plugin: `kanju/kanju.js` v0.1.0 (1 250 lines) as it is in this folder. **No Nuvio install test
was run** — there was no sideloaded build or device.

## At a glance

| | Result |
|---|---|
| (a) Default entry, live site | 3 runs (2 titles, both host profiles): every site request `200`, 6 lines each, and in each run at least one returned URL confirmed to be a real HLS playlist |
| (a) Opt-in entry, live site | Series episode: official line resolved with one request, no session, no quota; confirmed HLS. Film: three different outcomes on three calls — see below |
| (a) Line reachability from the test machine | 1 of 6 lines per title. The rest were refused by the CDNs for this machine's region, or dropped; **not** a measure of another network |
| (b) `node --check` | 10 of 10 JS files |
| (b) Offline suite, Node's engine | 45 tests: 45 pass, 0 fail, 0 skipped |
| (b) QuickJS engine | 24 of 24 runs, each identical to the Node-engine result |
| (c) TMDB step | never against the real TMDB API (no key); a stand-in answered |
| (c) In the Nuvio app | not run |

## (a) Verified live

**How.** `node test/live-check.mjs` runs the real plugin file through Nuvio's own polyfill, module
wrapper and call code (read from the Nuvio sources), with curl in place of OkHttp, against the live
`kanju44.com`. It prints every request, the plugin's log lines and what the first 4 KiB of each
returned URL contain. `kanju.ai` was only checked for reachability (home page `200`), not used.

**Two things about the test machine matter for reading the results.**

- It has no TMDB key, so a stand-in answered the one TMDB request from saved payloads. The titles
  it supplied are hand-written (黑客帝国 / The Matrix, 权力的游戏 / Game of Thrones), so **the
  TMDB step was not live**.
- It sits behind a datacentre egress proxy that intercepts TLS. Which lines are reachable from
  here says nothing about a home network.

### Default entry (`kanju`)

| Run | Host profile | Requests to the site | Status | Lines returned | Returned URLs that are media |
|---|---|---|---|---|---|
| Film — TMDB 603, The Matrix (what the in-app **Test** button uses) | NuvioTV | 5 | all `200` | 6 | 1 — `bfikuncdn.com`, `#EXTM3U` + `#EXT-X-STREAM-INF` |
| Series — TMDB 1399, S1E1 | NuvioTV | 6 | all `200` | 6 | 1 — `hn.bfvvs.com`, `#EXTM3U`, AES-128 HLS |
| Film — TMDB 603 | NuvioMobile | 5 | all `200` | 6 | 1 — same as above |

Established by this:

- **The signing flow works against the live site.** Home page → `movie-card-runtime-*.js`
  (260 935 bytes, under the 1 MiB cap) → signed `/v1/browse/catalog`, `/v1/catalog/{id}/detail`,
  `/v1/catalog/{id}/episodes`, `/v1/playback/resolve/{token}` all answered `200`. A wrong
  canonical string or key would have been a `401`.
- **Title matching on live search results:** `黑客帝国 score=140 year=same` and
  `权力的游戏 第1季 score=190 season=same year=same`.
- **The same code runs under both host profiles** (blocking fetch with `null` season/episode on
  NuvioTV; promise-based fetch with timers and `undefined` on NuvioMobile).
- **Elapsed per call here:** 5.6–6.6 s, against a 60 s limit.

**What was not reachable from here.** Of the 6 lines per title, 5 did not answer with media:

| Symptom | Hosts | Count | Cause, as far as it could be read |
|---|---|---|---|
| `HTTP 403`, HTML page "**The region has been denied.**" | `yzzy21.playback-speed.com`, `yzzy1.play-cdn16.com`, `v8.rstu6.com`, `v14.rstu6.com` | 4 per film, 1 per episode | the CDN refuses this machine's egress region; the page names the client IP |
| Connection opened, then empty reply | `vodcnd03.ajupf.com`, `vodcnd04.ajupf.com`, `play.xluuss.com`, `vv.jisuzyv.com`, `play.hhuus.com` | 1 per film, 4 per episode | **undetermined**: the TLS session is terminated by this machine's proxy, so a drop by the proxy and a drop by the server look the same |

Same result with and without a `Range` header and with three different User-Agents. The plugin
returns lines in the site's order and does not test them, so a user may have to try several.

### Opt-in entry (`kanju-official`)

| Title | What the site did | What the plugin did |
|---|---|---|
| Film — TMDB 603 | Resolve listed 19 lines, **all direct, no official ticket** | Same as the default entry: 6 lines, no session, no quota |
| Series — TMDB 1399, S1E1 | Resolve listed 29 lines (6 official tickets, 23 direct). `POST /v1/playback/resolve-line` answered `201` **without a session cookie**; no `quota_delta` | Created no session. Returned 7 lines; the official one (`official-r`, `url_kind: m3u8`, `sign.site.zshtys888.com/file.m3u8`) answered `200`, `application/x-mpegURL`, `#EXTM3U` |
| Film — 流浪地球, call 1 | Selected ticket `bytedance` "高清-官方B". `resolve-line` `401` → guest session → `201`; `used_tokens: 60000`. Line: `url_kind: "unknown"`, on `v3-gray.toutiaovod.com`, type only in a `mime_type` query | **Dropped it** (`UPSTREAM_CHANGED — 官方线路解析结果不是可直接播放的地址（unknown）`) and returned 6 lines. This was before the change described under (b) |
| Film — 流浪地球, call 2 | Selected ticket `bytevod-lv2` "1080P-官方Z". `401` → guest session → `201`; `used_tokens: 72000`. Line: `url_kind: "mp4"`, on `p6-heycan-sign.byteimg.com/…~tplv-…-image.image` | Returned it (7 lines). Probed separately: `HEAD` `200`, `Content-Type: video/mp4`, `Content-Length: 1 477 555 582`; first 64 KiB start with `….ftypisom` — **a real 1.4 GB MP4, despite the `.image` path** |
| Film — 流浪地球, call 3 (after the change) | `resolve-line` `404 playback_line_unavailable`, without a session | Logged `NOT_FOUND: 播放资源暂时不可用`, created no session, returned 6 lines |

So, live on this date:

- The opt-in entry **does** deliver a real official line, and for a series episode it cost no
  session and no quota.
- For films it is unreliable: which ticket the site selects changed from call to call, one answer
  was "unavailable", and two of the answers needed a guest session and spent 60 000–72 000 tokens.
- The `.image` URL that an earlier run had suspected of being a picture is a video file. The plugin
  was right to trust `url_kind: "mp4"`.
- **Not established:** what the `url_kind: "unknown"` line really is. It was seen once, before the
  change, and its URL was never probed. After the change the plugin returns such a line on the
  strength of the site's `mime_type` hint, as the reference plugin does. If it turns out not to
  play, the change to `mediaUrl()` is the one to revert.

**Cost of these checks to the site:** one guest identity was used (a fixed test id, so every run is
the same guest), two guest sessions, and 132 000 tokens of that guest's playback quota.

## (b) Verified by syntax, mock or engine only

**`node --check`** — 10 files, all clean: `kanju/kanju.js`, `test/run-tests.js`, `test/live-check.mjs`,
`test/quickjs-run.mjs`, `test/mock-host.mjs`, `test/host-glue.mjs`, `test/native-fetch.mjs`,
`test/transport.mjs`, `test/fakes.mjs`, `test/offline-world.mjs`.

**Offline suite — `node test/run-tests.js`: 45 tests, 45 pass, 0 fail, 0 skipped** (4.7 s). The
plugin runs inside Nuvio's own polyfill, wrapper and call code, with a scripted Kanju that rejects
any wrong signature. It covers:

- SHA-256 and HMAC-SHA256 against published vectors and Node's crypto (120 random cases);
  strict URL encoding; the 1 MiB truncation check; joined `Set-Cookie` parsing.
- Title matching against four searches captured from the live site, and against hand-written TMDB
  payloads.
- Both host profiles: film, multi-season series, the official entry (session, cookie relay, locked,
  exhausted, expired, and the two `"unknown"`-kind cases), a rejected signature, mirror fail-over,
  a changed site, a bundle over the cap, the fallback key discovery, refused arguments, a missing
  or rejected TMDB key, a v4 read token, rate limiting, and the host timeout.
- What the host does with a plugin that throws, does not parse or exports nothing; which globals
  each polyfill defines.
- The repository files: both manifests have the shape the hosts parse, versions match the plugin,
  every referenced file exists, and the plugin embeds no key or token.

**QuickJS engine — `node test/quickjs-run.mjs`: 24 of 24.** The same plugin, on the same glue, run
inside the QuickJS engine (`quickjs-emscripten` 0.32.0, WebAssembly build) under both host profiles,
including a promise-based `fetch` and timers. 16 scenario runs, each returning the same streams as
the Node-engine run of the same scenario; plus 8 host-contract checks. Measured there, not assumed:
under NuvioTV's polyfill the realm has `fetch`, `URL`, `require`, `SCRAPER_ID`, `TMDB_API_KEY` and
**no** `setTimeout`, `crypto` or `TextEncoder`; under NuvioMobile's it has all of them.

**The tests can fail.** Against the superseded first draft, in a scratch copy, the offline suite
passed 10 of 45 and the QuickJS run exited 1.

**The one change to plugin logic** is covered by tests that fail without it: with the previous
`mediaUrl()`, a line of kind `"unknown"` with a `mime_type=video_mp4` query, and one with an
`application/vnd.apple.mpegurl` MIME field, were both refused; everything else is unchanged.

**`docs/nuvio-plugin-contract.md`** cites 115 places in the Nuvio sources. All were checked by
script: the file exists, the lines exist; and the first line of each range was read against the
claim.

## (c) Not verifiable here

1. **Installing in Nuvio.** No sideloaded build, no device: the repository was never added in the
   app, and neither "Test" button was pressed.
2. **The TMDB step against the real API.** The request shape (path, `language`, `append_to_response`,
   `api_key` or `Bearer`) is verified only against the stand-in. With a real key, run
   `TMDB_API_KEY=… node test/live-check.mjs`.
3. **How a player on the device handles the returned URLs**, and what the `type` field would do.
   The plugin sends no `type`.
4. **NuvioMobile's stream screen**: which `mediaType`, `season` and `episode` it passes for a given
   screen (the calling file was not in the checkout).
5. **Which lines work from the user's network.** See the table above; 1 of 6 from here.
6. **Why five hosts per title open a connection and then go silent.** Undetermined.
7. **The `url_kind: "unknown"` official line.** Never probed.
8. **iOS**, and the embedded QuickJS build of the apps (the tests use the WebAssembly build).
9. **Timing on a device.** 5.6–6.6 s per call here; unknown on a TV box or phone.

## Changes made in this run

So they can be reviewed or reverted one by one:

| File | Change |
|---|---|
| `kanju.js` (repository root) | **Removed.** It was the superseded first draft, byte-identical to `kanju.draft-2026-11-24.orig.js` one folder up, and referenced by no manifest. `kanju/kanju.js` is the only plugin file |
| `kanju/kanju.js` | `mediaUrl()` now reads a MIME type from the line's `mime_type` field and, for kind `"unknown"`, from a `mime_type` query hint — the reference plugin's behaviour, minus its HEAD request. +26 lines; version unchanged (unreleased) |
| `test/run-tests.js` | 6 assertions added to the existing "line helpers" test; 2 tests added beside the other official-entry tests. Nothing rewritten |
| `test/live-check.mjs` | New. The live check |
| `test/quickjs-run.mjs` | New. The QuickJS engine run |
| `test/mock-host.mjs` | `parseUrl` exported for the QuickJS run |
| `test/offline-world.mjs`, `test/transport.mjs`, `test/fixtures/README.md` | Comments corrected: three of them referred to files that did not exist, and one described this machine's network as a property of the harness |
| `README.md`, `docs/nuvio-plugin-contract.md`, this file | New |
| `manifest.json`, `kanju/manifest.json` | Unchanged. They are **not** duplicates: two repository entries with different ids and behaviour, one plugin file |

## What is left for the owner

1. Decide whether to keep the opt-in entry (`kanju/manifest.json`). It works for series without
   cost and is unreliable for films; dropping it means deleting that file and the tests that
   mention `kanju-official`.
2. Publish the folder as `skfunghk/nuvio-plugins` and add the manifest URL in a sideloaded Nuvio.
3. Press **Test** (TMDB 603), then open a title. The plugin's own lines are in the log under
   `[kanju]` — they say which title was matched, with what score, and why nothing was returned.
