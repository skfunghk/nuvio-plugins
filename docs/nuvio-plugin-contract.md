# The Nuvio native plugin contract

What a Nuvio **plugin** can rely on, as read from Nuvio's own source. It is written for
`kanju/kanju.js`, and every statement cites the file it was read in. What could not be established
from the source is listed in [§13](#13-not-established) instead of being guessed.

A Nuvio plugin is **not** a Stremio add-on. An add-on is a remote HTTP service answering
`/catalog`, `/meta` and `/stream`; a plugin is JavaScript that Nuvio downloads and runs **on the
device**, and the only thing the host ever asks it for is a list of streams.

## Sources

| | NuvioTV (Android TV) | NuvioMobile (Android / iOS) |
|---|---|---|
| Repository | `NuvioMedia/NuvioTV` | `NuvioMedia/NuvioMobile` |
| Commit read | `b70adbb8357e5c5042c35824ed1f060cd9fa973a` | `4ec93635a16aa3f5fc810c62158f6eb4aef261e5` |
| Cited below as | `TV:` + path from the repository root | `Mobile:` + path from the repository root |

Both are partial checkouts — only the files in [§14](#14-files-read) were fetched — read on
2026-11-24. The community wiki (`haaihond/Nuvio-Wiki`, `docs/integrations/plugins.md` at
`e96b1030c3013d3c8cb712e76972729584b281a2`) agrees with the source on the points it covers
(QuickJS on the device, streams only, sideloaded builds only, install path). A community
provider guide in the research folder says the engine is "Hermes"; the source says otherwise
(`com.dokar.quickjs`: `TV:app/src/full/java/com/nuvio/tv/core/plugin/PluginRuntime.kt:4`,
`Mobile:composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsRuntime.kt:4`).

Line numbers are those of the commits above.

## 1. What a plugin is

- **Code that runs on the device**, in an embedded QuickJS engine, once per request, with no
  memory of the previous call.
- **Streams only.** The host calls one function, `getStreams`. There is no catalog, home, search,
  metadata or subtitle hook (`TV:…/core/plugin/PluginRuntime.kt:132-153`,
  `Mobile:…/plugins/runtime/js/JsBindings.kt:28-47`).
- **Sideloaded builds only.** NuvioTV compiles the real `PluginManager` into the `full` flavour
  and a stub into `playstore` whose every call fails with "Plugins are not available in this
  build." (`TV:app/build.gradle.kts:188-208`,
  `TV:app/src/playstore/java/com/nuvio/tv/core/plugin/PluginManager.kt:27-28`).
  NuvioMobile does the same for its Play Store and App Store source sets
  (`Mobile:composeApp/src/androidPlaystore/kotlin/com/nuvio/app/features/plugins/PluginRepository.android.kt:10-52`,
  `Mobile:composeApp/src/iosAppStore/kotlin/com/nuvio/app/features/plugins/PluginRepository.ios.kt:10-24`).

## 2. Repository and manifest

A plugin is installed by adding a **repository**: a `manifest.json` that lists one or more
providers, each pointing at one JavaScript file.

**The manifest file.** Its URL must end in `/manifest.json`: NuvioTV appends that when missing
(`TV:…/core/plugin/PluginManager.kt:187-194`), NuvioMobile adds `https://` and then the same
suffix (`Mobile:…/plugins/PluginRepository.kt:647-661`). A URL that ends in some other `.json`
is tried as a CloudStream-style repository first (`TV:…/PluginManager.kt:327-339`).

**Shape** — the same on both hosts (`TV:app/src/main/java/com/nuvio/tv/domain/model/Plugin.kt:38-67`,
`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/plugins/PluginModels.kt:14-41`):

```json
{
  "name": "required, non-blank",
  "version": "required, a JSON string",
  "description": "optional",
  "author": "optional",
  "scrapers": [
    {
      "id": "required",
      "name": "required",
      "version": "required, a JSON string",
      "filename": "required, relative to the manifest's directory, or an http(s) URL",
      "description": "optional",
      "supportedTypes": ["movie", "tv"],
      "enabled": true,
      "logo": "optional",
      "contentLanguage": ["optional"],
      "formats": ["optional"],
      "hasSettings": false
    }
  ]
}
```

- `name`, `version` and a non-empty `scrapers` are enforced on NuvioMobile
  (`Mobile:…/plugins/PluginManifestParser.kt:16-28`); unknown keys are ignored there
  (`:12-14`). NuvioTV parses with Moshi into the same fields, without `hasSettings`.
- `filename` resolves against the manifest's directory on both hosts
  (`TV:…/PluginManager.kt:1061-1070`, `Mobile:…/PluginRepository.kt:413-422`); NuvioMobile strips
  a leading `/` and any query on the manifest URL.
- `supportedTypes`: `series`, `show` and `other` count as `tv`
  (`TV:…/domain/model/Plugin.kt:87-97`, `Mobile:…/PluginModels.kt:70-74, 214-218`).
- `enabled` is the default state of the provider: NuvioTV keeps a previously stored choice, else
  `enabled` unless the id, name or filename contains "videasy"
  (`TV:…/PluginManager.kt:1117-1131`, `TV:app/src/main/java/com/nuvio/tv/core/plugin/PluginSafety.kt:3-13`);
  NuvioMobile keeps a previous choice, else `enabled`, and a provider shipped with `enabled:
  false` cannot be switched on (`Mobile:…/PluginRepository.kt:293-299, 436-440`).
  So, against what the wiki says, a repository whose providers say `"enabled": true` **is** on as
  soon as it is added — as long as "Enable plugin providers globally" is on.
- `supportedPlatforms` / `disabledPlatforms` are honoured by NuvioMobile only
  (`Mobile:…/PluginRepository.kt:475-482`).
- NuvioTV refuses a plugin file whose `Content-Length` is over 5 MiB
  (`TV:…/PluginManager.kt:59, 1073-1085`). No such check was found on NuvioMobile.

**The scraper id**, i.e. the `SCRAPER_ID` global, is `"<repository>:<scraper id>"`: on NuvioTV
the repository part is a UUID generated when the repository is added
(`TV:…/PluginManager.kt:413, 1115`), on NuvioMobile the lower-cased manifest URL
(`Mobile:…/PluginRepository.kt:425`). Only the part after the last `:` is predictable.

**When providers run.** NuvioTV starts every enabled provider that supports the type, 60 ms apart,
up to 10 at a time, and drops the rest once a "preferred" one (the provider the user played
last) has returned something (`TV:…/PluginManager.kt:724-731, 742-795, 808-831`). NuvioMobile asks
every enabled provider whenever a stream list is loaded
(`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/streams/StreamsRepository.kt:165-170`,
`Mobile:…/plugins/PluginRepository.kt:325-331`). In both cases that is **when the source list
opens, not when the user presses play**.

## 3. How one call is made

Each call gets a fresh runtime and context (`TV:…/PluginRuntime.kt:263`,
`Mobile:…/plugins/runtime/PluginRuntime.kt:133`, `Mobile:…/runtime/js/JsRuntime.kt:12-20`), then,
in this order:

1. the host functions of [§6](#6-globals-and-host-functions) are bound;
2. the polyfill is evaluated (`TV:…/PluginRuntime.kt:462-463`, `Mobile:…/PluginRuntime.kt:165`);
3. the plugin is evaluated inside a CommonJS wrapper (`TV:…/PluginRuntime.kt:472-479`,
   `Mobile:…/PluginRuntime.kt:176-182`):

   ```js
   var module = { exports: {} };
   var exports = module.exports;
   (function() {
       /* plugin code */
   })();
   ```

4. the call code is evaluated (`TV:…/PluginRuntime.kt:132-153`, `Mobile:…/JsBindings.kt:28-47`):

   ```js
   var getStreams = module.exports.getStreams || globalThis.getStreams;
   var result = await getStreams(args.tmdbId, args.mediaType, args.season, args.episode);
   __capture_result(JSON.stringify(result || []));
   ```

Anything thrown inside `getStreams` is caught there, logged as `getStreams error`, and the host
receives `[]`. Code that does not parse, or exports no `getStreams`, also ends in `[]`.

Nothing survives between calls: there is **no storage**, no module cache and no cookie jar.

## 4. Arguments

`getStreams(tmdbId, mediaType, season, episode)`.

**`tmdbId`** — a string, normally a numeric TMDB id.

- NuvioTV converts the id first: `tmdb:`/`movie:`/`series:` are stripped, an IMDb id is converted
  to a TMDB id, digits pass through (`TV:app/src/main/java/com/nuvio/tv/core/tmdb/TmdbService.kt:209-247`).
  Only when that fails **and** the id is a `kitsu:` / `anilist:` / `mal:` id is that id passed
  through as it is (`TV:app/src/main/java/com/nuvio/tv/data/repository/StreamRepositoryImpl.kt:521-541, 595-599`).
- NuvioMobile passes the converted id, or whatever it was given when conversion fails
  (`Mobile:…/PluginRepository.kt:392-403`).

So a plugin can also receive `kitsu:6448`, `mal:63375:68` or an unconverted id.

**`mediaType`** — `"movie"` or `"tv"`; `series`/`show` are normalised to `tv`
(`TV:…/StreamRepositoryImpl.kt:543-548`). It becomes `"series"` only when the manifest's
`supportedTypes` lists `series`, the type is `tv`, and season and episode are both present
(`TV:app/src/main/java/com/nuvio/tv/core/plugin/PluginMediaType.kt:3-12`,
`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/plugins/PluginMediaType.kt:3-12`).

**`season`, `episode`** — integers for series. For a film NuvioTV passes `null` and NuvioMobile
`undefined` (`Mobile:…/PluginRuntime.kt:136-143`, `Mobile:…/JsBindings.kt:38-39`). For an
anime-tracker id (`kitsu:…`, `mal:…`, `anilist:…`, `anidb:…` with three segments) NuvioTV passes
`season = null` and the **absolute** episode number
(`TV:app/src/main/java/com/nuvio/tv/core/plugin/PluginEpisodeRequestRules.kt:24-59`).

**The in-app "Test" button** calls the plugin with TMDB id `603` (The Matrix), as a film when the
manifest supports `movie`, otherwise as series episode 1/1 (`TV:…/PluginManager.kt:985-1031`,
`Mobile:…/PluginRepository.kt:333-349`).

## 5. Return value

An array of plain objects, serialised with `JSON.stringify`, and read back field by field
(`TV:…/PluginRuntime.kt:1410-1459`, `Mobile:…/PluginRuntime.kt:196-250`):

| Field | Read as | Notes |
|---|---|---|
| `url` | string, or object with a `url` string | required; an item without one is dropped, as is one containing `[object` |
| `title` | string | falls back to `name`, then "Unknown" |
| `name` | string | on NuvioTV falls back to the provider's name |
| `quality`, `size`, `language`, `provider`, `type`, `infoHash` | string | blank values are dropped on NuvioMobile |
| `seeders`, `peers` | number | |
| `headers` | object of strings | request headers for the player |
| `subtitles` | array of `{ url, language, lang, name, headers }` | |
| `behaviorHints.audioDelayMs`, `.audioDelayLanguage` | number, string | NuvioTV only |

Anything else is ignored. A value that is not a JSON array, or does not parse, becomes an empty
list. Leave fields out rather than sending `""`.

How it is shown: NuvioTV displays `name` (or the provider's name) with ` - <quality>` appended,
and the title with the quality appended; it then overwrites `provider` with the provider's name
(`TV:…/domain/model/Plugin.kt:316-359`, `TV:…/PluginManager.kt:945`). NuvioMobile displays `name`
(or the title) and a subtitle of quality, size and language, and passes `type` on lower-cased
(`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/streams/StreamFetchSupport.kt:85-135`,
`…/features/streams/StreamModels.kt:151-152`).

After all providers: NuvioTV de-duplicates by `url` and keeps at most 150 streams per search
(`TV:…/PluginManager.kt:58, 733-735`); in the streaming path each provider's results are emitted
on their own. A provider that fails contributes nothing, and the user is not told why: the only
trace is in the logs (tag `Plugin:<scraper id>` on NuvioTV, logger `PluginRuntime` on NuvioMobile).

## 6. Globals and host functions

Defined by the polyfill before the plugin runs (`TV:…/PluginRuntime.kt:707-720`,
`Mobile:…/JsBindings.kt:4-26`):

| Global | NuvioTV | NuvioMobile | Value |
|---|---|---|---|
| `SCRAPER_ID` | yes | yes | `"<repository>:<scraper id>"`, see §2 |
| `SCRAPER_SETTINGS` | yes | yes | object; `{}` unless the user saved settings, see §11 |
| `TMDB_API_KEY` | yes | yes | the host's TMDB key; see below |
| `fetch`, `URL`, `URLSearchParams`, `atob`, `btoa`, `AbortController`, `require`, `console` | yes | yes | shims, see §7–§9 |
| `global`, `window`, `self` | aliases of `globalThis` | same | |

**`TMDB_API_KEY`.** NuvioTV injects `BuildConfig.TMDB_API_KEY` (`TV:…/PluginRuntime.kt:460`),
which is read from `local.properties` at build time and is `""` when absent
(`TV:app/build.gradle.kts:72, 157`). NuvioMobile injects the key the user set in the app's TMDB
settings, else the build-time one, which comes from `local.properties` or the environment variable
`TMDB_API_KEY` and is `""` when absent
(`Mobile:…/runtime/host/HostFunctions.kt:56`,
`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/tmdb/TmdbSettingsRepository.kt:45`,
`Mobile:composeApp/build.gradle.kts:47, 84-96, 306-308, 327`).
**A build compiled without a key has an empty `TMDB_API_KEY`** — a plugin that needs TMDB cannot
work there, and must say so.

`console.log|error|warn|info|debug` take any arguments and join them with a space
(`TV:…/PluginRuntime.kt:266-287`, `Mobile:…/HostFunctions.kt:31-52`).

`require` knows only `cheerio` (a Jsoup bridge) and `crypto-js`; anything else throws "Module
'…' is not available" (`TV:…/PluginRuntime.kt:1338-1347`, `Mobile:…/JsBindings.kt:1057-1067`).

The host functions themselves (`__native_fetch`, `__get_call_args`, `__capture_result`, …) exist
as globals, but they are the polyfill's business, not the plugin's.

## 7. `fetch`

`fetch(url, options)` returns a promise of `{ ok, status, statusText, url, headers, arrayBuffer(),
text(), json() }` (`TV:…/PluginRuntime.kt:767-827`, `Mobile:…/JsBindings.kt:185-221`).

- `options.method`: default `GET`, upper-cased. `options.headers`: a plain object.
  `options.body`: a string (sent as UTF-8) or an `ArrayBuffer` / typed array.
  `options.redirect === 'manual'` turns redirects off. `options.signal`: NuvioTV only.
- Response: `headers.get(name)` is the **only** header accessor; names are lower-cased.
  `text()`, `arrayBuffer()` and `json()`; `json()` resolves to `null` on an empty or unparsable
  body. There is no `blob()`, `formData()`, `clone()`, `Request` object or streaming.
- **No per-request timeout.**
- Default `User-Agent`, when the plugin sets none: `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
  AppleWebKit/537.36` (`TV:…/PluginRuntime.kt:549-551`, `Mobile:…/runtime/network/FetchBridge.kt:61-63`).
- An `Accept-Encoding` the plugin sets is dropped so the stack can decompress
  (`TV:…/PluginRuntime.kt:537-541`,
  `Mobile:composeApp/src/androidMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.android.kt:272`).
- A `POST` body without `Content-Type` is sent as `application/x-www-form-urlencoded`; for
  `PUT`/`PATCH`/`DELETE` the default is `application/json` (`TV:…/PluginRuntime.kt:557-576`,
  `Mobile:…/AddonPlatform.android.kt:279-280`).
- Stack timeouts: NuvioTV 30 s connect, read and write (`TV:…/PluginRuntime.kt:51-69`);
  NuvioMobile on Android 60 s each (`Mobile:…/AddonPlatform.android.kt:104-115`). Both clients
  ignore any system proxy.

**Blocking or not.**

- NuvioTV binds `__native_fetch` as a plain function: **the engine is blocked while the request
  runs** (`TV:…/PluginRuntime.kt:289-314`). Requests are sequential; `Promise.all` gives no
  parallelism there.
- NuvioMobile binds it as a suspending function, so the engine is free while requests run and
  they can overlap (`Mobile:…/FetchBridge.kt:24`).

**One body is cut at 1 MiB.**

- NuvioTV reads at most 1 048 576 bytes (`TV:…/PluginRuntime.kt:44, 607`). Its result carries a
  `truncated` flag, but the `fetch` shim does not pass it on, so **the cut is silent**; a body
  that was cut looks like a body of exactly the cap.
- NuvioMobile cuts at the same size and appends `"\n...[truncated]"`
  (`Mobile:composeApp/src/commonMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.kt:21`,
  `…/androidMain/…/AddonPlatform.android.kt:307-316`, `…/iosMain/…/AddonPlatform.ios.kt:187-193`).

**Headers.** Repeated headers are joined with `,` — so every `Set-Cookie` arrives as one string —
and each value is cut at 8 KiB (`TV:app/src/full/java/com/nuvio/tv/core/plugin/FetchResponseHeaders.kt:5-18`,
`Mobile:…/AddonPlatform.android.kt:318-320`, `Mobile:…/FetchBridge.kt:16-17, 74-75`).

**A transport failure** (DNS, connect, TLS, timeout) does **not** reject: it resolves with
`ok: false`, `status: 0`, an empty body and the error message in `statusText`
(`TV:…/PluginRuntime.kt:636-647`, `Mobile:…/FetchBridge.kt:35-48`).

## 8. The `URL` shim

`URL` is a constructor function whose `href` is the string it was given. **Changing
`url.searchParams` does not change `href`**, and `URLSearchParams.append` overwrites instead of
appending (`TV:…/PluginRuntime.kt:908-999`, `Mobile:…/JsBindings.kt:294-364`). A plugin must build
request URLs as strings; anything that signs a URL has to sign exactly the string it sends.

## 9. Timers, text encoding, crypto

| | NuvioTV | NuvioMobile |
|---|---|---|
| `setTimeout`, `setInterval` | **not defined** by the polyfill | defined, backed by a coroutine delay; one delay is capped at 60 000 ms (`Mobile:…/JsBindings.kt:66-124`, `Mobile:…/HostFunctions.kt:11, 22-29`) |
| `TextEncoder`, `TextDecoder` | not defined | defined (`Mobile:…/JsBindings.kt:897-921`) |
| `crypto.getRandomValues`, `crypto.subtle` | not defined | defined (`Mobile:…/JsBindings.kt:787-895`) |
| `CryptoJS` | the real library, loaded best-effort from a WebJar; `require('crypto-js')` throws when it did not load (`TV:…/PluginRuntime.kt:86-100, 155-179, 465-468`) | a JavaScript re-implementation over native calls (`Mobile:…/JsBindings.kt:367-759`) |

"Not defined" is a statement about the polyfill. What the engine adds on a device is [not
established](#13-not-established); in the QuickJS build the tests use, the realm held exactly the
polyfill's definitions under each host (`node test/quickjs-run.mjs`).

## 10. Limits

| | NuvioTV | NuvioMobile |
|---|---|---|
| One call | 60 s, then cancelled (`TV:…/PluginRuntime.kt:43, 225`); an outer 120 s around the whole provider (`TV:…/PluginManager.kt:64, 923`) | 60 s, then cancelled (`Mobile:…/PluginRuntime.kt:41, 69`) |
| Providers at once | 10 (`TV:…/PluginManager.kt:57, 216`) | 10 (`Mobile:…/PluginRuntime.kt:40`) |
| Streams per search | 150 (`TV:…/PluginManager.kt:58, 735`) | not found in the files read |
| Plugin file | at most 5 MiB (`TV:…/PluginManager.kt:59`) | not found in the files read |
| One fetch body | 1 MiB | 1 MiB |
| One fetch | 30 s connect, read, write | 60 s each (Android) |
| One header value | 8 KiB | 8 KiB |
| One timer | — | 60 s |

When the time is up the call is cancelled and the requests still in flight are aborted
(`TV:…/PluginRuntime.kt:243-249, 502-511`, `Mobile:…/AddonPlatform.android.kt:297-301`). The
caller only sees "no streams".

## 11. Settings

`SCRAPER_SETTINGS` is the object the user saved for this provider, or `{}`.

- NuvioTV can **store** settings per scraper (`TV:app/src/main/java/com/nuvio/tv/data/local/PluginDataStore.kt:248-280`)
  and passes them to the plugin (`TV:…/PluginManager.kt:920`), but nothing in the files read ever
  writes them, its manifest model has no `hasSettings`, and its call code has no settings step.
  So on NuvioTV `SCRAPER_SETTINGS` is `{}` as far as the source shows.
- NuvioMobile has the whole loop: `hasSettings: true` shows a settings button, which runs
  `module.exports.onSettings()` to get a form layout and saves what the user enters
  (`Mobile:…/plugins/PluginsSettingsScreen.kt:394-397`,
  `Mobile:…/plugins/PluginSettingsDialog.kt:189`, `Mobile:…/JsBindings.kt:49-64`).

So a setting cannot carry anything that has to work on both hosts. That is why this plugin puts
its one behaviour switch in the manifest entry id instead (see the README).

## 12. Installing, in the apps

**NuvioTV** — Settings → **Content & Discovery** → **Plugins** ("Manage repositories and stream
providers") → **Add repository** → paste the manifest URL (field placeholder "URL or short code")
→ **Add**. Providers then appear under "Providers", each with an on/off switch and a **Test**
button. "Enable plugin providers globally" must be on for providers to run. The Plugins tile is
only shown in builds with plugins
(`TV:app/src/main/java/com/nuvio/tv/ui/screens/settings/ContentDiscoverySettingsContent.kt:88-127`,
`TV:app/src/main/res/values/strings.xml:474-477, 2408-2443`).

**NuvioMobile** has the same parts — install a repository, a manifest URL field, "enable
globally", group by repository, a test button per provider
(`Mobile:…/plugins/PluginsSettingsScreen.kt:165, 226, 442`; string keys `plugins_button_install_repo`,
`plugins_input_manifest_placeholder`, `plugins_enable_globally_title`,
`plugins_button_test_provider`). The English texts of those strings were not in the checkout.
The wiki gives the path as Settings > Content & Discovery > Plugins > Add Repository.

A short code (a `cutt.ly` name) also works on NuvioTV (`TV:…/PluginManager.kt:121-185, 311-316`).
The wiki also describes adding a repository from the Nuvio account dashboard; that path was not
read in the source.

## 13. Not established

1. **The QuickJS build inside the apps** (`com.dokar.quickjs`): its version, options, stack and
   memory limits. The tests use the WebAssembly build in `quickjs-emscripten` 0.32.0.
2. **What that engine provides by itself on a device**, beyond the polyfills. It was measured only
   in the WebAssembly build.
3. **Which player takes a stream that has no `type` field, and what `type` values mean.** The
   consumer of `type` was not in the checkout. This plugin sends no `type`.
4. **NuvioMobile's stream screen**: the file that calls `PluginRepository.executeScraper` was not
   fetched, so the exact `mediaType`, `season` and `episode` it passes for a given screen — for
   anime ids in particular — were not read. Only what `executeScraper` does with them is
   established (§4).
5. **NuvioMobile's limits**: a result cap, a plugin file size limit, and the HTTP client behind
   `httpGetText` (used for the manifest and the plugin file) live in files that were not fetched.
6. **iOS**: `httpRequestRaw` was read (same cap, marker and header joining), but not the Ktor
   client's timeouts or proxy behaviour.
7. **`AppFeaturePolicy.pluginsEnabled`** (NuvioMobile's gate, `Mobile:…/StreamsRepository.kt:72,
   166`) is defined in `com.nuvio.app.core.build`, which was not fetched. That store builds are
   off is established by the stub repositories (§1).
8. **NuvioTV repository sync** (`PluginSyncService.kt`), the "Manage from phone" QR flow, and the
   account-dashboard install: not read.
9. **Whether `crypto-js` is present in a given NuvioTV build**: it depends on the WebJar being on
   the classpath.
10. **The player side of `headers`**: NuvioTV turns them into proxy headers
    (`TV:…/domain/model/Plugin.kt:351`), NuvioMobile marks the stream `notWebReady` and attaches
    them (`Mobile:…/StreamFetchSupport.kt:119-126`); what the players then do was not read.
11. **Nothing here was exercised inside the Nuvio apps.** There was no sideloaded build or device
    to install into.

## 14. Files read

NuvioTV, `app/`:

- `build.gradle.kts`
- `src/full/java/com/nuvio/tv/core/plugin/PluginRuntime.kt`, `PluginManager.kt`, `FetchResponseHeaders.kt`
- `src/playstore/java/com/nuvio/tv/core/plugin/PluginManager.kt`
- `src/main/java/com/nuvio/tv/core/plugin/PluginMediaType.kt`, `PluginEpisodeRequestRules.kt`, `PluginSafety.kt`
- `src/main/java/com/nuvio/tv/core/tmdb/TmdbService.kt`
- `src/main/java/com/nuvio/tv/data/repository/StreamRepositoryImpl.kt`
- `src/main/java/com/nuvio/tv/data/local/PluginDataStore.kt` (settings functions)
- `src/main/java/com/nuvio/tv/domain/model/Plugin.kt`
- `src/main/java/com/nuvio/tv/ui/screens/settings/ContentDiscoverySettingsContent.kt`
- `src/main/res/values/strings.xml` (the plugin and content-discovery strings)

NuvioMobile, `composeApp/src/`:

- `build.gradle.kts`
- `commonMain/kotlin/com/nuvio/app/features/plugins/PluginModels.kt`, `PluginRepository.kt`
  (the interface), `PluginMediaType.kt`
- `commonMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.kt`
- `commonMain/kotlin/com/nuvio/app/features/tmdb/TmdbSettingsRepository.kt`
- `commonMain/kotlin/com/nuvio/app/features/streams/StreamsRepository.kt` (the plugin gate),
  `StreamFetchSupport.kt`, `StreamModels.kt` (`normalizeStreamType`)
- `androidMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.android.kt`
- `iosMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.ios.kt` (`httpRequestRaw`)
- `fullCommonMain/kotlin/com/nuvio/app/features/plugins/PluginManifestParser.kt`,
  `PluginRepository.kt`, `PluginSettingsDialog.kt`, `PluginsSettingsScreen.kt`
- `fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/PluginRuntime.kt`
- `fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/host/HostFunctions.kt`
- `fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt`, `JsRuntime.kt`
- `fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/network/FetchBridge.kt`
- `androidPlaystore/kotlin/com/nuvio/app/features/plugins/PluginRepository.android.kt`
- `iosAppStore/kotlin/com/nuvio/app/features/plugins/PluginRepository.ios.kt`
