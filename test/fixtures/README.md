# Test fixtures

Static data for the offline tests in `../run-tests.js`. Nothing here is used by the plugin at runtime.

## `kanju/`

Captured live from `https://kanju44.com` on 2026-11-24 with the site's own guest request signing
(home page, signed `/v1/browse/catalog`, `/v1/catalog/{id}/detail`, `/v1/catalog/{id}/episodes`,
`/v1/playback/resolve/{token}`), then trimmed:

- kept: titles, aliases, `content_kind`, years, season/variant lists, line labels, kinds,
  `resolve_mode`, `preference_weight`, `minimum_user_level`, `selected`;
- dropped: posters, backdrops, actors, descriptions, playback groups;
- replaced by placeholders: every `av_…` id and token (`av_FAKE_*`), playback ids, `resolve://`
  tickets (`resolve://FAKE_TICKET_<provider>`), and all stream URLs
  (`https://media.example.invalid/...`).

The site's search ranking changes from call to call, so the captured sets are one snapshot, not a
guaranteed result. `home.html` is the real home page (it only names asset files); the runtime
chunk is **not** included — the tests serve a make-believe one carrying a made-up signing key.

## `tmdb/`

Hand-written payloads in the shape of TMDB's `/movie/{id}` and `/tv/{id}` responses (with
`translations` and `alternative_titles` appended). The values come from memory of the public
TMDB listings, not from the API, and only the fields `kanju.js` reads are filled in.

- `movie/603.json` The Matrix — the id both Nuvio hosts use for their "Test" button
- `movie/129.json` Spirited Away
- `tv/1399.json` Game of Thrones
- `tv/1429.json` Attack on Titan
- `movie/9000001.json` The Wandering Earth under a **made-up id** (not a real TMDB id)

`node test/live-check.mjs` runs the plugin against the live site with these payloads standing in
for TMDB; set `TMDB_API_KEY` to ask the real TMDB API instead (then use real TMDB ids).
