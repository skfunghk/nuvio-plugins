// kazumi.js — KazumiRules (github.com/Predidit/KazumiRules, MIT) as streams for Nuvio's native
// plugin runtime.
//
// Kazumi is an anime app whose "rules" are small JSON files that tell it how to search a site and
// list a show's episodes. This plugin reads those same rule files at run time and replays them with
// plain HTTP fetches, so a Nuvio user gets the streams of every rule that works without a browser.
// As of 2026-11-26 that is one rule for certain (giriGiriLove, api mode) and, behind an opt-in
// entry, four whose address is readable but did not play from the test network. See README.md and
// docs/kazumi-rules-survey.md.
//
// The host facts quoted here were read from Nuvio's source (see docs/nuvio-plugin-contract.md):
//   getStreams(tmdbId, mediaType, season, episode) -> Promise<Array<stream object>>
//     tmdbId    numeric TMDB id as a string in the normal case. IMDb ids are converted by the
//               host first; a kitsu:/mal:/anilist: id arrives when that failed (not usable here).
//     mediaType "movie" | "tv" | "series" — this plugin declares ["tv"] only (Kazumi rules are
//               anime-only), so the host normalises the type to "tv".
//     season / episode   numbers for a season. NuvioTV sends season = null with the ABSOLUTE
//               episode number for anime trackers: that case is supported, see makeWant().
//   globals: fetch (shim), TMDB_API_KEY, SCRAPER_ID, SCRAPER_SETTINGS, console.
//   Anything thrown is caught by the host and logged; the caller only sees "no streams".
//   A provider is killed after 60 s. One fetch body is cut at 1 MiB (silently on NuvioTV).
//
// What the host does NOT give us, and what this file does about it:
//   * no DOM, no cheerio for HTML parsing — a small HTML5-style tree builder and an evaluator for
//     the XPath dialect the rules are written in are implemented here in plain JS;
//   * no JS execution and no WebView — Kazumi finds the video address by loading the play page in a
//     WebView and hooking its player. That is impossible here, so the address is read from the page
//     source instead. Rules whose video only exists after the page's JS has run are not shipped as
//     working (see RULE_STATUS);
//   * no storage — rule files are fetched on every call (index.json first, then only the rules
//     that are tried), with a snapshot of the best rules embedded below that is used first;
//   * no timers on NuvioTV — the time budget is checked between requests, never waited on.
//
// Time and request budget per getStreams call (the host kills the call after 60 s):
//   SOFT_DEADLINE_MS     34 s: no new request is started after this
//   RETRY_BUDGET_MS      15 s: a dropped connection is retried only before this
//   VERIFY_UNTIL_MS      20 s: a found address is confirmed with a 2 KB range request, and a second
//                               road of the same entry is read, only before this
//   REMOTE_UNTIL_MS      22 s: the rule repository (GitHub) is asked only before this
//   MAX_SEARCH_TITLES     4    titles tried per rule (one search request each)
//   MAX_RULES_TRIED       4    rules tried from the embedded snapshot
//   MAX_RULES_TRIED_TOTAL 6    rules tried in the whole call, the repository's files included
//   MAX_REMOTE_REFRESH    2    rules tried again with the repository's file after the snapshot failed
//   MAX_RULES_WITH_STREAMS 2   rules that may contribute streams before the call stops
//   MAX_CHAPTER_FETCHES   4    episode-list requests per rule
//   MAX_ROADS_PER_ENTRY   2    roads ("线路") of one entry whose address is read
//   MAX_VERIFICATIONS     2    addresses confirmed per episode address
//   MAX_STREAMS           8    streams returned per call
//   There is no per-request timeout in the host: one request may block for 30 s (NuvioTV), which is
//   why the deadline for starting work is 34 s and not later.
// Order: api-mode rules first (cheap, deterministic), then xpath-mode; stable rules before
// experimental ones.
//
// Rule files are data: a rule can describe a request (method, URL, headers, body) and an XPath /
// JSONPath to read the answer. It is never evaluated as code. The request a rule describes is made
// only to the host named in that rule.

(function () {
  'use strict';

  var VERSION = '0.4.2';
  var TAG = '[kazumi]';

  var SOFT_DEADLINE_MS = 34000;
  var RETRY_BUDGET_MS = 15000;
  var BGM_BUDGET_MS = 6000;         // Bangumi 补名最多花这么久，超时就不补
  var TRACKER_ID = /^(kitsu|mal|anilist|anidb):(\d+)(?::(\d+))?$/i;
  var FINAL_SEASON = /最终|最終|完结篇|完結篇|final/i;
  // ani.zip 是跨库映射服务：给任一 id 就能拿到 TMDB/TVDB id、多语言片名，以及「第 N 集 → 第几季第几集」。
  var ANIZIP_API = 'https://api.ani.zip/mappings';
  var ANIZIP_QUERY = { kitsu: 'kitsu_id', mal: 'mal_id', anilist: 'anilist_id', tmdb: 'themoviedb_id', tvdb: 'thetvdb_id' };
  var VERIFY_UNTIL_MS = 20000;
  var REMOTE_UNTIL_MS = 22000;
  var MAX_SEARCH_TITLES = 4;
  var MAX_RULES_TRIED = 4;
  var MAX_RULES_TRIED_TOTAL = 6;
  var MAX_REMOTE_REFRESH = 2;   // rules tried a second time with the repository's file
  var MAX_RULES_WITH_STREAMS = 2;
  var MAX_CHAPTER_FETCHES = 4;
  var MAX_ROADS_PER_ENTRY = 2;
  var MAX_VERIFICATIONS = 2;
  var MAX_STREAMS = 8;
  // The rule engine sends a desktop Chrome UA from Kazumi's userAgentsList (these sites serve
  // other markup to mobile UAs) and one of its Accept-Language values.
  var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  var ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9';
  var FETCH_CAP_BYTES = 1024 * 1024; // Nuvio cuts one fetch body at 1 MiB
  var TRUNCATION_SUFFIX = '\n...[truncated]';   // how NuvioMobile marks a cut body

  // ---------------------------------------------------------------- logging

  function emit(level, message, extra) {
    var line = TAG + ' ' + message + (extra !== undefined && extra !== null && extra !== '' ? ' -- ' + extra : '');
    try {
      if (typeof console[level] === 'function') console[level](line);
      else console.log(line);
    } catch (e) {
      try { console.log(line); } catch (e2) { /* nothing else we can do */ }
    }
  }

  function fail(code, message) {
    var error = new Error(message || code);
    error.name = 'KazumiError';
    error.code = code;
    return error;
  }

  function timeout(step) { throw fail('TIMEOUT', '超时，停在「' + step + '」'); }

  function report(error) {
    if (error && error.code) emit('error', error.code + ': ' + error.message);
    else emit('error', 'UPSTREAM_ERROR: ' + (error && error.message ? error.message : String(error)));
  }

  // ---------------------------------------------------------------- primitives
  // Text, encoding and title helpers copied from kanju.js (the reference plugin in the same repo
  // family), plus asStringMap for the rule model.

  function utf8Bytes(text) {
    var out = [];
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8Length(text) {
    var s = String(text);
    var total = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) i++;
      if (c < 0x80) total += 1;
      else if (c < 0x800) total += 2;
      else if (c >= 0xd800 && c <= 0xdfff) total += 4;
      else total += 3;
    }
    return total;
  }

  var UNRESERVED = /^[A-Za-z0-9\-_.~]$/;
  function percentEncode(text, spaceAsPlus) {
    var out = '';
    var value = String(text);
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (UNRESERVED.test(ch)) { out += ch; continue; }
      if (spaceAsPlus && ch === ' ') { out += '+'; continue; }
      var bytes = utf8Bytes(ch);
      for (var j = 0; j < bytes.length; j++) {
        out += '%' + (bytes[j] >> 4).toString(16) + (bytes[j] & 15).toString(16);
      }
    }
    return out;
  }

  function formEncode(params) {
    var parts = [];
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      var value = params[keys[i]];
      if (value === undefined || value === null || value === '') continue;
      parts.push(percentEncode(keys[i], true) + '=' + percentEncode(value, true));
    }
    return parts.join('&');
  }

  function yearOf(date) {
    var match = /^(\d{4})/.exec(String(date || ''));
    return match ? Number(match[1]) : null;
  }

  function parseJson(text) {
    try {
      var value = JSON.parse(text);
      return value && typeof value === 'object' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function asStringMap(value) {
    var out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[String(key)] = value[key];
    return out;
  }

  // NuvioTV exposes no timers, so a short busy wait is the only sleep it can do.
  function sleep(ms) {
    if (typeof setTimeout === 'function') {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }
    var end = Date.now() + Math.min(ms, 500);
    while (Date.now() < end) { /* busy wait on a background worker thread */ }
    return Promise.resolve();
  }

  var CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  var LETTER = /[A-Za-z0-9À-ɏͰ-ԯ]/;

  function fold(text) {
    var value = String(text || '');
    value = value.replace(/&#x([0-9a-f]+);/gi, function (_, code) { return String.fromCodePoint(parseInt(code, 16)); })
      .replace(/&#(\d+);/g, function (_, code) { return String.fromCodePoint(parseInt(code, 10)); })
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
    if (typeof value.normalize === 'function') {
      try { value = value.normalize('NFKC'); } catch (e) { /* older engines: the fold below is enough */ }
    }
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code >= 0xff01 && code <= 0xff5e) code -= 0xfee0;
      else if (code === 0x3000) code = 32;
      out += String.fromCharCode(code);
    }
    return out.toLowerCase();
  }

  function compact(text) {
    var value = fold(text);
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (LETTER.test(ch) || CJK.test(ch)) out += ch;
    }
    return out;
  }

  function baseTitle(text) {
    var value = fold(text);
    for (var i = 0; i < SEASON_MARKERS.length; i++) value = value.replace(SEASON_MARKERS[i], ' ');
    return value.replace(BRACKET_TAG, ' ');
  }

  function seasonFromTitle(text) {
    var value = fold(text);
    var match = /第\s*([0-9]+)\s*[季期]/.exec(value) || /\bseason\s*([0-9]+)/i.exec(value) || /(?:^|[\s(\[])s([0-9]{1,2})\b/i.exec(value);
    if (match) return Number(match[1]);
    match = /第\s*([一二三四五六七八九十]+)\s*[季期]/.exec(value);
    return match ? chineseNumber(match[1]) : null;
  }

  function chineseNumber(text) {
    var digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text === '十') return 10;
    var parts = text.split('十');
    if (parts.length === 2) return (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0);
    return digits[text] || null;
  }

  // ------------------------------------------------------------------- HTTP
  // A transport failure does not reject on either host: it resolves with ok:false and status 0.
  // Every caller checks the call's deadline before sending, so one hung request cannot eat the
  // whole 60 s: before each request the remaining time is compared with how long a request may
  // take (30 s connect/read on NuvioTV, 60 s on NuvioMobile); once the retry budget is used up the
  // rule is skipped.

  async function rawFetch(url, options) {
    try {
      var response = await fetch(url, options);
      var body = await response.text();
      var result = {
        ok: !!response.ok,
        status: Number(response.status) || 0,
        statusText: String(response.statusText || ''),
        url: String(response.url || ''),
        headers: response.headers,
        body: typeof body === 'string' ? body : '',
      };
      absorbCookies(result);
      return result;
    } catch (e) {
      return { ok: false, status: 0, statusText: e && e.message ? String(e.message) : String(e), url: url, headers: null, body: '' };
    }
  }

  // 站点在搜索/剧集接口上发的 Cookie，媒体主机有时要用（Nuvio 的播放器会把 headers 原样带上）。
  // 只收 name=value，不理会属性；同名取最后一次。
  function absorbCookies(result) {
    if (!result || !result.headers || typeof result.headers.get !== 'function') return;
    var raw = '';
    try { raw = result.headers.get('set-cookie') || ''; } catch (e) { return; }
    if (!raw) return;
    var parts = String(raw).split(/,\s*(?=[A-Za-z0-9_\-]+=)/);
    for (var i = 0; i < parts.length; i++) {
      var pair = String(parts[i]).split(';')[0].trim();
      if (!pair || pair.indexOf('=') < 1) continue;
      var name = pair.split('=')[0];
      if (!name) continue;
      run.jar[name] = pair;
    }
  }

  function cookieHeader() {
    var names = Object.keys(run.jar);
    var pairs = [];
    for (var i = 0; i < names.length; i++) pairs.push(run.jar[names[i]]);
    return pairs.join('; ');
  }

  // Nuvio cuts a fetch body at 1 MiB. NuvioMobile appends a marker; NuvioTV truncates silently,
  // which for an ASCII body still shows as a body of exactly the cap.
  function looksTruncated(body) {
    if (body.slice(-TRUNCATION_SUFFIX.length) === TRUNCATION_SUFFIX) return true;
    if (body.length >= FETCH_CAP_BYTES) return true;
    return body.length > FETCH_CAP_BYTES / 2 && utf8Length(body) >= FETCH_CAP_BYTES;
  }

  // One GET, retried on a dropped connection while the retry budget lasts.
  async function httpText(url, headers, retries) {
    var result;
    for (var attempt = 0; ; attempt++) {
      result = await rawFetch(url, { method: 'GET', headers: headers });
      // 5xx 是站点自己的问题，重试只会把预算烧光（giriGiriLove 的 API 挂掉时能烧掉 40 秒），
      // 直接交给调用方去试下一条规则。只有连接失败（status 0）才重试。
      if (result.status !== 0 || attempt >= retries || Date.now() > run.retryUntil) return result;
      await sleep(250 * (attempt + 1));
    }
  }
  // The HTML5 named character references (the complete WHATWG list html5lib and browsers use), as
  // code points; names ending in ";" need the semicolon, the others are the legacy forms valid without.
  // Generated from Python html.entities.html5: 2231 entries.
  var ENTITIES = {
    "AElig":"\u00C6",
    "AElig;":"\u00C6",
    "AMP":"\u0026",
    "AMP;":"\u0026",
    "Aacute":"\u00C1",
    "Aacute;":"\u00C1",
    "Abreve;":"\u0102",
    "Acirc":"\u00C2",
    "Acirc;":"\u00C2",
    "Acy;":"\u0410",
    "Afr;":"\uD835\uDD04",
    "Agrave":"\u00C0",
    "Agrave;":"\u00C0",
    "Alpha;":"\u0391",
    "Amacr;":"\u0100",
    "And;":"\u2A53",
    "Aogon;":"\u0104",
    "Aopf;":"\uD835\uDD38",
    "ApplyFunction;":"\u2061",
    "Aring":"\u00C5",
    "Aring;":"\u00C5",
    "Ascr;":"\uD835\uDC9C",
    "Assign;":"\u2254",
    "Atilde":"\u00C3",
    "Atilde;":"\u00C3",
    "Auml":"\u00C4",
    "Auml;":"\u00C4",
    "Backslash;":"\u2216",
    "Barv;":"\u2AE7",
    "Barwed;":"\u2306",
    "Bcy;":"\u0411",
    "Because;":"\u2235",
    "Bernoullis;":"\u212C",
    "Beta;":"\u0392",
    "Bfr;":"\uD835\uDD05",
    "Bopf;":"\uD835\uDD39",
    "Breve;":"\u02D8",
    "Bscr;":"\u212C",
    "Bumpeq;":"\u224E",
    "CHcy;":"\u0427",
    "COPY":"\u00A9",
    "COPY;":"\u00A9",
    "Cacute;":"\u0106",
    "Cap;":"\u22D2",
    "CapitalDifferentialD;":"\u2145",
    "Cayleys;":"\u212D",
    "Ccaron;":"\u010C",
    "Ccedil":"\u00C7",
    "Ccedil;":"\u00C7",
    "Ccirc;":"\u0108",
    "Cconint;":"\u2230",
    "Cdot;":"\u010A",
    "Cedilla;":"\u00B8",
    "CenterDot;":"\u00B7",
    "Cfr;":"\u212D",
    "Chi;":"\u03A7",
    "CircleDot;":"\u2299",
    "CircleMinus;":"\u2296",
    "CirclePlus;":"\u2295",
    "CircleTimes;":"\u2297",
    "ClockwiseContourIntegral;":"\u2232",
    "CloseCurlyDoubleQuote;":"\u201D",
    "CloseCurlyQuote;":"\u2019",
    "Colon;":"\u2237",
    "Colone;":"\u2A74",
    "Congruent;":"\u2261",
    "Conint;":"\u222F",
    "ContourIntegral;":"\u222E",
    "Copf;":"\u2102",
    "Coproduct;":"\u2210",
    "CounterClockwiseContourIntegral;":"\u2233",
    "Cross;":"\u2A2F",
    "Cscr;":"\uD835\uDC9E",
    "Cup;":"\u22D3",
    "CupCap;":"\u224D",
    "DD;":"\u2145",
    "DDotrahd;":"\u2911",
    "DJcy;":"\u0402",
    "DScy;":"\u0405",
    "DZcy;":"\u040F",
    "Dagger;":"\u2021",
    "Darr;":"\u21A1",
    "Dashv;":"\u2AE4",
    "Dcaron;":"\u010E",
    "Dcy;":"\u0414",
    "Del;":"\u2207",
    "Delta;":"\u0394",
    "Dfr;":"\uD835\uDD07",
    "DiacriticalAcute;":"\u00B4",
    "DiacriticalDot;":"\u02D9",
    "DiacriticalDoubleAcute;":"\u02DD",
    "DiacriticalGrave;":"\u0060",
    "DiacriticalTilde;":"\u02DC",
    "Diamond;":"\u22C4",
    "DifferentialD;":"\u2146",
    "Dopf;":"\uD835\uDD3B",
    "Dot;":"\u00A8",
    "DotDot;":"\u20DC",
    "DotEqual;":"\u2250",
    "DoubleContourIntegral;":"\u222F",
    "DoubleDot;":"\u00A8",
    "DoubleDownArrow;":"\u21D3",
    "DoubleLeftArrow;":"\u21D0",
    "DoubleLeftRightArrow;":"\u21D4",
    "DoubleLeftTee;":"\u2AE4",
    "DoubleLongLeftArrow;":"\u27F8",
    "DoubleLongLeftRightArrow;":"\u27FA",
    "DoubleLongRightArrow;":"\u27F9",
    "DoubleRightArrow;":"\u21D2",
    "DoubleRightTee;":"\u22A8",
    "DoubleUpArrow;":"\u21D1",
    "DoubleUpDownArrow;":"\u21D5",
    "DoubleVerticalBar;":"\u2225",
    "DownArrow;":"\u2193",
    "DownArrowBar;":"\u2913",
    "DownArrowUpArrow;":"\u21F5",
    "DownBreve;":"\u0311",
    "DownLeftRightVector;":"\u2950",
    "DownLeftTeeVector;":"\u295E",
    "DownLeftVector;":"\u21BD",
    "DownLeftVectorBar;":"\u2956",
    "DownRightTeeVector;":"\u295F",
    "DownRightVector;":"\u21C1",
    "DownRightVectorBar;":"\u2957",
    "DownTee;":"\u22A4",
    "DownTeeArrow;":"\u21A7",
    "Downarrow;":"\u21D3",
    "Dscr;":"\uD835\uDC9F",
    "Dstrok;":"\u0110",
    "ENG;":"\u014A",
    "ETH":"\u00D0",
    "ETH;":"\u00D0",
    "Eacute":"\u00C9",
    "Eacute;":"\u00C9",
    "Ecaron;":"\u011A",
    "Ecirc":"\u00CA",
    "Ecirc;":"\u00CA",
    "Ecy;":"\u042D",
    "Edot;":"\u0116",
    "Efr;":"\uD835\uDD08",
    "Egrave":"\u00C8",
    "Egrave;":"\u00C8",
    "Element;":"\u2208",
    "Emacr;":"\u0112",
    "EmptySmallSquare;":"\u25FB",
    "EmptyVerySmallSquare;":"\u25AB",
    "Eogon;":"\u0118",
    "Eopf;":"\uD835\uDD3C",
    "Epsilon;":"\u0395",
    "Equal;":"\u2A75",
    "EqualTilde;":"\u2242",
    "Equilibrium;":"\u21CC",
    "Escr;":"\u2130",
    "Esim;":"\u2A73",
    "Eta;":"\u0397",
    "Euml":"\u00CB",
    "Euml;":"\u00CB",
    "Exists;":"\u2203",
    "ExponentialE;":"\u2147",
    "Fcy;":"\u0424",
    "Ffr;":"\uD835\uDD09",
    "FilledSmallSquare;":"\u25FC",
    "FilledVerySmallSquare;":"\u25AA",
    "Fopf;":"\uD835\uDD3D",
    "ForAll;":"\u2200",
    "Fouriertrf;":"\u2131",
    "Fscr;":"\u2131",
    "GJcy;":"\u0403",
    "GT":"\u003E",
    "GT;":"\u003E",
    "Gamma;":"\u0393",
    "Gammad;":"\u03DC",
    "Gbreve;":"\u011E",
    "Gcedil;":"\u0122",
    "Gcirc;":"\u011C",
    "Gcy;":"\u0413",
    "Gdot;":"\u0120",
    "Gfr;":"\uD835\uDD0A",
    "Gg;":"\u22D9",
    "Gopf;":"\uD835\uDD3E",
    "GreaterEqual;":"\u2265",
    "GreaterEqualLess;":"\u22DB",
    "GreaterFullEqual;":"\u2267",
    "GreaterGreater;":"\u2AA2",
    "GreaterLess;":"\u2277",
    "GreaterSlantEqual;":"\u2A7E",
    "GreaterTilde;":"\u2273",
    "Gscr;":"\uD835\uDCA2",
    "Gt;":"\u226B",
    "HARDcy;":"\u042A",
    "Hacek;":"\u02C7",
    "Hat;":"\u005E",
    "Hcirc;":"\u0124",
    "Hfr;":"\u210C",
    "HilbertSpace;":"\u210B",
    "Hopf;":"\u210D",
    "HorizontalLine;":"\u2500",
    "Hscr;":"\u210B",
    "Hstrok;":"\u0126",
    "HumpDownHump;":"\u224E",
    "HumpEqual;":"\u224F",
    "IEcy;":"\u0415",
    "IJlig;":"\u0132",
    "IOcy;":"\u0401",
    "Iacute":"\u00CD",
    "Iacute;":"\u00CD",
    "Icirc":"\u00CE",
    "Icirc;":"\u00CE",
    "Icy;":"\u0418",
    "Idot;":"\u0130",
    "Ifr;":"\u2111",
    "Igrave":"\u00CC",
    "Igrave;":"\u00CC",
    "Im;":"\u2111",
    "Imacr;":"\u012A",
    "ImaginaryI;":"\u2148",
    "Implies;":"\u21D2",
    "Int;":"\u222C",
    "Integral;":"\u222B",
    "Intersection;":"\u22C2",
    "InvisibleComma;":"\u2063",
    "InvisibleTimes;":"\u2062",
    "Iogon;":"\u012E",
    "Iopf;":"\uD835\uDD40",
    "Iota;":"\u0399",
    "Iscr;":"\u2110",
    "Itilde;":"\u0128",
    "Iukcy;":"\u0406",
    "Iuml":"\u00CF",
    "Iuml;":"\u00CF",
    "Jcirc;":"\u0134",
    "Jcy;":"\u0419",
    "Jfr;":"\uD835\uDD0D",
    "Jopf;":"\uD835\uDD41",
    "Jscr;":"\uD835\uDCA5",
    "Jsercy;":"\u0408",
    "Jukcy;":"\u0404",
    "KHcy;":"\u0425",
    "KJcy;":"\u040C",
    "Kappa;":"\u039A",
    "Kcedil;":"\u0136",
    "Kcy;":"\u041A",
    "Kfr;":"\uD835\uDD0E",
    "Kopf;":"\uD835\uDD42",
    "Kscr;":"\uD835\uDCA6",
    "LJcy;":"\u0409",
    "LT":"\u003C",
    "LT;":"\u003C",
    "Lacute;":"\u0139",
    "Lambda;":"\u039B",
    "Lang;":"\u27EA",
    "Laplacetrf;":"\u2112",
    "Larr;":"\u219E",
    "Lcaron;":"\u013D",
    "Lcedil;":"\u013B",
    "Lcy;":"\u041B",
    "LeftAngleBracket;":"\u27E8",
    "LeftArrow;":"\u2190",
    "LeftArrowBar;":"\u21E4",
    "LeftArrowRightArrow;":"\u21C6",
    "LeftCeiling;":"\u2308",
    "LeftDoubleBracket;":"\u27E6",
    "LeftDownTeeVector;":"\u2961",
    "LeftDownVector;":"\u21C3",
    "LeftDownVectorBar;":"\u2959",
    "LeftFloor;":"\u230A",
    "LeftRightArrow;":"\u2194",
    "LeftRightVector;":"\u294E",
    "LeftTee;":"\u22A3",
    "LeftTeeArrow;":"\u21A4",
    "LeftTeeVector;":"\u295A",
    "LeftTriangle;":"\u22B2",
    "LeftTriangleBar;":"\u29CF",
    "LeftTriangleEqual;":"\u22B4",
    "LeftUpDownVector;":"\u2951",
    "LeftUpTeeVector;":"\u2960",
    "LeftUpVector;":"\u21BF",
    "LeftUpVectorBar;":"\u2958",
    "LeftVector;":"\u21BC",
    "LeftVectorBar;":"\u2952",
    "Leftarrow;":"\u21D0",
    "Leftrightarrow;":"\u21D4",
    "LessEqualGreater;":"\u22DA",
    "LessFullEqual;":"\u2266",
    "LessGreater;":"\u2276",
    "LessLess;":"\u2AA1",
    "LessSlantEqual;":"\u2A7D",
    "LessTilde;":"\u2272",
    "Lfr;":"\uD835\uDD0F",
    "Ll;":"\u22D8",
    "Lleftarrow;":"\u21DA",
    "Lmidot;":"\u013F",
    "LongLeftArrow;":"\u27F5",
    "LongLeftRightArrow;":"\u27F7",
    "LongRightArrow;":"\u27F6",
    "Longleftarrow;":"\u27F8",
    "Longleftrightarrow;":"\u27FA",
    "Longrightarrow;":"\u27F9",
    "Lopf;":"\uD835\uDD43",
    "LowerLeftArrow;":"\u2199",
    "LowerRightArrow;":"\u2198",
    "Lscr;":"\u2112",
    "Lsh;":"\u21B0",
    "Lstrok;":"\u0141",
    "Lt;":"\u226A",
    "Map;":"\u2905",
    "Mcy;":"\u041C",
    "MediumSpace;":"\u205F",
    "Mellintrf;":"\u2133",
    "Mfr;":"\uD835\uDD10",
    "MinusPlus;":"\u2213",
    "Mopf;":"\uD835\uDD44",
    "Mscr;":"\u2133",
    "Mu;":"\u039C",
    "NJcy;":"\u040A",
    "Nacute;":"\u0143",
    "Ncaron;":"\u0147",
    "Ncedil;":"\u0145",
    "Ncy;":"\u041D",
    "NegativeMediumSpace;":"\u200B",
    "NegativeThickSpace;":"\u200B",
    "NegativeThinSpace;":"\u200B",
    "NegativeVeryThinSpace;":"\u200B",
    "NestedGreaterGreater;":"\u226B",
    "NestedLessLess;":"\u226A",
    "NewLine;":"\u000A",
    "Nfr;":"\uD835\uDD11",
    "NoBreak;":"\u2060",
    "NonBreakingSpace;":"\u00A0",
    "Nopf;":"\u2115",
    "Not;":"\u2AEC",
    "NotCongruent;":"\u2262",
    "NotCupCap;":"\u226D",
    "NotDoubleVerticalBar;":"\u2226",
    "NotElement;":"\u2209",
    "NotEqual;":"\u2260",
    "NotEqualTilde;":"\u2242\u0338",
    "NotExists;":"\u2204",
    "NotGreater;":"\u226F",
    "NotGreaterEqual;":"\u2271",
    "NotGreaterFullEqual;":"\u2267\u0338",
    "NotGreaterGreater;":"\u226B\u0338",
    "NotGreaterLess;":"\u2279",
    "NotGreaterSlantEqual;":"\u2A7E\u0338",
    "NotGreaterTilde;":"\u2275",
    "NotHumpDownHump;":"\u224E\u0338",
    "NotHumpEqual;":"\u224F\u0338",
    "NotLeftTriangle;":"\u22EA",
    "NotLeftTriangleBar;":"\u29CF\u0338",
    "NotLeftTriangleEqual;":"\u22EC",
    "NotLess;":"\u226E",
    "NotLessEqual;":"\u2270",
    "NotLessGreater;":"\u2278",
    "NotLessLess;":"\u226A\u0338",
    "NotLessSlantEqual;":"\u2A7D\u0338",
    "NotLessTilde;":"\u2274",
    "NotNestedGreaterGreater;":"\u2AA2\u0338",
    "NotNestedLessLess;":"\u2AA1\u0338",
    "NotPrecedes;":"\u2280",
    "NotPrecedesEqual;":"\u2AAF\u0338",
    "NotPrecedesSlantEqual;":"\u22E0",
    "NotReverseElement;":"\u220C",
    "NotRightTriangle;":"\u22EB",
    "NotRightTriangleBar;":"\u29D0\u0338",
    "NotRightTriangleEqual;":"\u22ED",
    "NotSquareSubset;":"\u228F\u0338",
    "NotSquareSubsetEqual;":"\u22E2",
    "NotSquareSuperset;":"\u2290\u0338",
    "NotSquareSupersetEqual;":"\u22E3",
    "NotSubset;":"\u2282\u20D2",
    "NotSubsetEqual;":"\u2288",
    "NotSucceeds;":"\u2281",
    "NotSucceedsEqual;":"\u2AB0\u0338",
    "NotSucceedsSlantEqual;":"\u22E1",
    "NotSucceedsTilde;":"\u227F\u0338",
    "NotSuperset;":"\u2283\u20D2",
    "NotSupersetEqual;":"\u2289",
    "NotTilde;":"\u2241",
    "NotTildeEqual;":"\u2244",
    "NotTildeFullEqual;":"\u2247",
    "NotTildeTilde;":"\u2249",
    "NotVerticalBar;":"\u2224",
    "Nscr;":"\uD835\uDCA9",
    "Ntilde":"\u00D1",
    "Ntilde;":"\u00D1",
    "Nu;":"\u039D",
    "OElig;":"\u0152",
    "Oacute":"\u00D3",
    "Oacute;":"\u00D3",
    "Ocirc":"\u00D4",
    "Ocirc;":"\u00D4",
    "Ocy;":"\u041E",
    "Odblac;":"\u0150",
    "Ofr;":"\uD835\uDD12",
    "Ograve":"\u00D2",
    "Ograve;":"\u00D2",
    "Omacr;":"\u014C",
    "Omega;":"\u03A9",
    "Omicron;":"\u039F",
    "Oopf;":"\uD835\uDD46",
    "OpenCurlyDoubleQuote;":"\u201C",
    "OpenCurlyQuote;":"\u2018",
    "Or;":"\u2A54",
    "Oscr;":"\uD835\uDCAA",
    "Oslash":"\u00D8",
    "Oslash;":"\u00D8",
    "Otilde":"\u00D5",
    "Otilde;":"\u00D5",
    "Otimes;":"\u2A37",
    "Ouml":"\u00D6",
    "Ouml;":"\u00D6",
    "OverBar;":"\u203E",
    "OverBrace;":"\u23DE",
    "OverBracket;":"\u23B4",
    "OverParenthesis;":"\u23DC",
    "PartialD;":"\u2202",
    "Pcy;":"\u041F",
    "Pfr;":"\uD835\uDD13",
    "Phi;":"\u03A6",
    "Pi;":"\u03A0",
    "PlusMinus;":"\u00B1",
    "Poincareplane;":"\u210C",
    "Popf;":"\u2119",
    "Pr;":"\u2ABB",
    "Precedes;":"\u227A",
    "PrecedesEqual;":"\u2AAF",
    "PrecedesSlantEqual;":"\u227C",
    "PrecedesTilde;":"\u227E",
    "Prime;":"\u2033",
    "Product;":"\u220F",
    "Proportion;":"\u2237",
    "Proportional;":"\u221D",
    "Pscr;":"\uD835\uDCAB",
    "Psi;":"\u03A8",
    "QUOT":"\u0022",
    "QUOT;":"\u0022",
    "Qfr;":"\uD835\uDD14",
    "Qopf;":"\u211A",
    "Qscr;":"\uD835\uDCAC",
    "RBarr;":"\u2910",
    "REG":"\u00AE",
    "REG;":"\u00AE",
    "Racute;":"\u0154",
    "Rang;":"\u27EB",
    "Rarr;":"\u21A0",
    "Rarrtl;":"\u2916",
    "Rcaron;":"\u0158",
    "Rcedil;":"\u0156",
    "Rcy;":"\u0420",
    "Re;":"\u211C",
    "ReverseElement;":"\u220B",
    "ReverseEquilibrium;":"\u21CB",
    "ReverseUpEquilibrium;":"\u296F",
    "Rfr;":"\u211C",
    "Rho;":"\u03A1",
    "RightAngleBracket;":"\u27E9",
    "RightArrow;":"\u2192",
    "RightArrowBar;":"\u21E5",
    "RightArrowLeftArrow;":"\u21C4",
    "RightCeiling;":"\u2309",
    "RightDoubleBracket;":"\u27E7",
    "RightDownTeeVector;":"\u295D",
    "RightDownVector;":"\u21C2",
    "RightDownVectorBar;":"\u2955",
    "RightFloor;":"\u230B",
    "RightTee;":"\u22A2",
    "RightTeeArrow;":"\u21A6",
    "RightTeeVector;":"\u295B",
    "RightTriangle;":"\u22B3",
    "RightTriangleBar;":"\u29D0",
    "RightTriangleEqual;":"\u22B5",
    "RightUpDownVector;":"\u294F",
    "RightUpTeeVector;":"\u295C",
    "RightUpVector;":"\u21BE",
    "RightUpVectorBar;":"\u2954",
    "RightVector;":"\u21C0",
    "RightVectorBar;":"\u2953",
    "Rightarrow;":"\u21D2",
    "Ropf;":"\u211D",
    "RoundImplies;":"\u2970",
    "Rrightarrow;":"\u21DB",
    "Rscr;":"\u211B",
    "Rsh;":"\u21B1",
    "RuleDelayed;":"\u29F4",
    "SHCHcy;":"\u0429",
    "SHcy;":"\u0428",
    "SOFTcy;":"\u042C",
    "Sacute;":"\u015A",
    "Sc;":"\u2ABC",
    "Scaron;":"\u0160",
    "Scedil;":"\u015E",
    "Scirc;":"\u015C",
    "Scy;":"\u0421",
    "Sfr;":"\uD835\uDD16",
    "ShortDownArrow;":"\u2193",
    "ShortLeftArrow;":"\u2190",
    "ShortRightArrow;":"\u2192",
    "ShortUpArrow;":"\u2191",
    "Sigma;":"\u03A3",
    "SmallCircle;":"\u2218",
    "Sopf;":"\uD835\uDD4A",
    "Sqrt;":"\u221A",
    "Square;":"\u25A1",
    "SquareIntersection;":"\u2293",
    "SquareSubset;":"\u228F",
    "SquareSubsetEqual;":"\u2291",
    "SquareSuperset;":"\u2290",
    "SquareSupersetEqual;":"\u2292",
    "SquareUnion;":"\u2294",
    "Sscr;":"\uD835\uDCAE",
    "Star;":"\u22C6",
    "Sub;":"\u22D0",
    "Subset;":"\u22D0",
    "SubsetEqual;":"\u2286",
    "Succeeds;":"\u227B",
    "SucceedsEqual;":"\u2AB0",
    "SucceedsSlantEqual;":"\u227D",
    "SucceedsTilde;":"\u227F",
    "SuchThat;":"\u220B",
    "Sum;":"\u2211",
    "Sup;":"\u22D1",
    "Superset;":"\u2283",
    "SupersetEqual;":"\u2287",
    "Supset;":"\u22D1",
    "THORN":"\u00DE",
    "THORN;":"\u00DE",
    "TRADE;":"\u2122",
    "TSHcy;":"\u040B",
    "TScy;":"\u0426",
    "Tab;":"\u0009",
    "Tau;":"\u03A4",
    "Tcaron;":"\u0164",
    "Tcedil;":"\u0162",
    "Tcy;":"\u0422",
    "Tfr;":"\uD835\uDD17",
    "Therefore;":"\u2234",
    "Theta;":"\u0398",
    "ThickSpace;":"\u205F\u200A",
    "ThinSpace;":"\u2009",
    "Tilde;":"\u223C",
    "TildeEqual;":"\u2243",
    "TildeFullEqual;":"\u2245",
    "TildeTilde;":"\u2248",
    "Topf;":"\uD835\uDD4B",
    "TripleDot;":"\u20DB",
    "Tscr;":"\uD835\uDCAF",
    "Tstrok;":"\u0166",
    "Uacute":"\u00DA",
    "Uacute;":"\u00DA",
    "Uarr;":"\u219F",
    "Uarrocir;":"\u2949",
    "Ubrcy;":"\u040E",
    "Ubreve;":"\u016C",
    "Ucirc":"\u00DB",
    "Ucirc;":"\u00DB",
    "Ucy;":"\u0423",
    "Udblac;":"\u0170",
    "Ufr;":"\uD835\uDD18",
    "Ugrave":"\u00D9",
    "Ugrave;":"\u00D9",
    "Umacr;":"\u016A",
    "UnderBar;":"\u005F",
    "UnderBrace;":"\u23DF",
    "UnderBracket;":"\u23B5",
    "UnderParenthesis;":"\u23DD",
    "Union;":"\u22C3",
    "UnionPlus;":"\u228E",
    "Uogon;":"\u0172",
    "Uopf;":"\uD835\uDD4C",
    "UpArrow;":"\u2191",
    "UpArrowBar;":"\u2912",
    "UpArrowDownArrow;":"\u21C5",
    "UpDownArrow;":"\u2195",
    "UpEquilibrium;":"\u296E",
    "UpTee;":"\u22A5",
    "UpTeeArrow;":"\u21A5",
    "Uparrow;":"\u21D1",
    "Updownarrow;":"\u21D5",
    "UpperLeftArrow;":"\u2196",
    "UpperRightArrow;":"\u2197",
    "Upsi;":"\u03D2",
    "Upsilon;":"\u03A5",
    "Uring;":"\u016E",
    "Uscr;":"\uD835\uDCB0",
    "Utilde;":"\u0168",
    "Uuml":"\u00DC",
    "Uuml;":"\u00DC",
    "VDash;":"\u22AB",
    "Vbar;":"\u2AEB",
    "Vcy;":"\u0412",
    "Vdash;":"\u22A9",
    "Vdashl;":"\u2AE6",
    "Vee;":"\u22C1",
    "Verbar;":"\u2016",
    "Vert;":"\u2016",
    "VerticalBar;":"\u2223",
    "VerticalLine;":"\u007C",
    "VerticalSeparator;":"\u2758",
    "VerticalTilde;":"\u2240",
    "VeryThinSpace;":"\u200A",
    "Vfr;":"\uD835\uDD19",
    "Vopf;":"\uD835\uDD4D",
    "Vscr;":"\uD835\uDCB1",
    "Vvdash;":"\u22AA",
    "Wcirc;":"\u0174",
    "Wedge;":"\u22C0",
    "Wfr;":"\uD835\uDD1A",
    "Wopf;":"\uD835\uDD4E",
    "Wscr;":"\uD835\uDCB2",
    "Xfr;":"\uD835\uDD1B",
    "Xi;":"\u039E",
    "Xopf;":"\uD835\uDD4F",
    "Xscr;":"\uD835\uDCB3",
    "YAcy;":"\u042F",
    "YIcy;":"\u0407",
    "YUcy;":"\u042E",
    "Yacute":"\u00DD",
    "Yacute;":"\u00DD",
    "Ycirc;":"\u0176",
    "Ycy;":"\u042B",
    "Yfr;":"\uD835\uDD1C",
    "Yopf;":"\uD835\uDD50",
    "Yscr;":"\uD835\uDCB4",
    "Yuml;":"\u0178",
    "ZHcy;":"\u0416",
    "Zacute;":"\u0179",
    "Zcaron;":"\u017D",
    "Zcy;":"\u0417",
    "Zdot;":"\u017B",
    "ZeroWidthSpace;":"\u200B",
    "Zeta;":"\u0396",
    "Zfr;":"\u2128",
    "Zopf;":"\u2124",
    "Zscr;":"\uD835\uDCB5",
    "aacute":"\u00E1",
    "aacute;":"\u00E1",
    "abreve;":"\u0103",
    "ac;":"\u223E",
    "acE;":"\u223E\u0333",
    "acd;":"\u223F",
    "acirc":"\u00E2",
    "acirc;":"\u00E2",
    "acute":"\u00B4",
    "acute;":"\u00B4",
    "acy;":"\u0430",
    "aelig":"\u00E6",
    "aelig;":"\u00E6",
    "af;":"\u2061",
    "afr;":"\uD835\uDD1E",
    "agrave":"\u00E0",
    "agrave;":"\u00E0",
    "alefsym;":"\u2135",
    "aleph;":"\u2135",
    "alpha;":"\u03B1",
    "amacr;":"\u0101",
    "amalg;":"\u2A3F",
    "amp":"\u0026",
    "amp;":"\u0026",
    "and;":"\u2227",
    "andand;":"\u2A55",
    "andd;":"\u2A5C",
    "andslope;":"\u2A58",
    "andv;":"\u2A5A",
    "ang;":"\u2220",
    "ange;":"\u29A4",
    "angle;":"\u2220",
    "angmsd;":"\u2221",
    "angmsdaa;":"\u29A8",
    "angmsdab;":"\u29A9",
    "angmsdac;":"\u29AA",
    "angmsdad;":"\u29AB",
    "angmsdae;":"\u29AC",
    "angmsdaf;":"\u29AD",
    "angmsdag;":"\u29AE",
    "angmsdah;":"\u29AF",
    "angrt;":"\u221F",
    "angrtvb;":"\u22BE",
    "angrtvbd;":"\u299D",
    "angsph;":"\u2222",
    "angst;":"\u00C5",
    "angzarr;":"\u237C",
    "aogon;":"\u0105",
    "aopf;":"\uD835\uDD52",
    "ap;":"\u2248",
    "apE;":"\u2A70",
    "apacir;":"\u2A6F",
    "ape;":"\u224A",
    "apid;":"\u224B",
    "apos;":"\u0027",
    "approx;":"\u2248",
    "approxeq;":"\u224A",
    "aring":"\u00E5",
    "aring;":"\u00E5",
    "ascr;":"\uD835\uDCB6",
    "ast;":"\u002A",
    "asymp;":"\u2248",
    "asympeq;":"\u224D",
    "atilde":"\u00E3",
    "atilde;":"\u00E3",
    "auml":"\u00E4",
    "auml;":"\u00E4",
    "awconint;":"\u2233",
    "awint;":"\u2A11",
    "bNot;":"\u2AED",
    "backcong;":"\u224C",
    "backepsilon;":"\u03F6",
    "backprime;":"\u2035",
    "backsim;":"\u223D",
    "backsimeq;":"\u22CD",
    "barvee;":"\u22BD",
    "barwed;":"\u2305",
    "barwedge;":"\u2305",
    "bbrk;":"\u23B5",
    "bbrktbrk;":"\u23B6",
    "bcong;":"\u224C",
    "bcy;":"\u0431",
    "bdquo;":"\u201E",
    "becaus;":"\u2235",
    "because;":"\u2235",
    "bemptyv;":"\u29B0",
    "bepsi;":"\u03F6",
    "bernou;":"\u212C",
    "beta;":"\u03B2",
    "beth;":"\u2136",
    "between;":"\u226C",
    "bfr;":"\uD835\uDD1F",
    "bigcap;":"\u22C2",
    "bigcirc;":"\u25EF",
    "bigcup;":"\u22C3",
    "bigodot;":"\u2A00",
    "bigoplus;":"\u2A01",
    "bigotimes;":"\u2A02",
    "bigsqcup;":"\u2A06",
    "bigstar;":"\u2605",
    "bigtriangledown;":"\u25BD",
    "bigtriangleup;":"\u25B3",
    "biguplus;":"\u2A04",
    "bigvee;":"\u22C1",
    "bigwedge;":"\u22C0",
    "bkarow;":"\u290D",
    "blacklozenge;":"\u29EB",
    "blacksquare;":"\u25AA",
    "blacktriangle;":"\u25B4",
    "blacktriangledown;":"\u25BE",
    "blacktriangleleft;":"\u25C2",
    "blacktriangleright;":"\u25B8",
    "blank;":"\u2423",
    "blk12;":"\u2592",
    "blk14;":"\u2591",
    "blk34;":"\u2593",
    "block;":"\u2588",
    "bne;":"\u003D\u20E5",
    "bnequiv;":"\u2261\u20E5",
    "bnot;":"\u2310",
    "bopf;":"\uD835\uDD53",
    "bot;":"\u22A5",
    "bottom;":"\u22A5",
    "bowtie;":"\u22C8",
    "boxDL;":"\u2557",
    "boxDR;":"\u2554",
    "boxDl;":"\u2556",
    "boxDr;":"\u2553",
    "boxH;":"\u2550",
    "boxHD;":"\u2566",
    "boxHU;":"\u2569",
    "boxHd;":"\u2564",
    "boxHu;":"\u2567",
    "boxUL;":"\u255D",
    "boxUR;":"\u255A",
    "boxUl;":"\u255C",
    "boxUr;":"\u2559",
    "boxV;":"\u2551",
    "boxVH;":"\u256C",
    "boxVL;":"\u2563",
    "boxVR;":"\u2560",
    "boxVh;":"\u256B",
    "boxVl;":"\u2562",
    "boxVr;":"\u255F",
    "boxbox;":"\u29C9",
    "boxdL;":"\u2555",
    "boxdR;":"\u2552",
    "boxdl;":"\u2510",
    "boxdr;":"\u250C",
    "boxh;":"\u2500",
    "boxhD;":"\u2565",
    "boxhU;":"\u2568",
    "boxhd;":"\u252C",
    "boxhu;":"\u2534",
    "boxminus;":"\u229F",
    "boxplus;":"\u229E",
    "boxtimes;":"\u22A0",
    "boxuL;":"\u255B",
    "boxuR;":"\u2558",
    "boxul;":"\u2518",
    "boxur;":"\u2514",
    "boxv;":"\u2502",
    "boxvH;":"\u256A",
    "boxvL;":"\u2561",
    "boxvR;":"\u255E",
    "boxvh;":"\u253C",
    "boxvl;":"\u2524",
    "boxvr;":"\u251C",
    "bprime;":"\u2035",
    "breve;":"\u02D8",
    "brvbar":"\u00A6",
    "brvbar;":"\u00A6",
    "bscr;":"\uD835\uDCB7",
    "bsemi;":"\u204F",
    "bsim;":"\u223D",
    "bsime;":"\u22CD",
    "bsol;":"\u005C",
    "bsolb;":"\u29C5",
    "bsolhsub;":"\u27C8",
    "bull;":"\u2022",
    "bullet;":"\u2022",
    "bump;":"\u224E",
    "bumpE;":"\u2AAE",
    "bumpe;":"\u224F",
    "bumpeq;":"\u224F",
    "cacute;":"\u0107",
    "cap;":"\u2229",
    "capand;":"\u2A44",
    "capbrcup;":"\u2A49",
    "capcap;":"\u2A4B",
    "capcup;":"\u2A47",
    "capdot;":"\u2A40",
    "caps;":"\u2229\uFE00",
    "caret;":"\u2041",
    "caron;":"\u02C7",
    "ccaps;":"\u2A4D",
    "ccaron;":"\u010D",
    "ccedil":"\u00E7",
    "ccedil;":"\u00E7",
    "ccirc;":"\u0109",
    "ccups;":"\u2A4C",
    "ccupssm;":"\u2A50",
    "cdot;":"\u010B",
    "cedil":"\u00B8",
    "cedil;":"\u00B8",
    "cemptyv;":"\u29B2",
    "cent":"\u00A2",
    "cent;":"\u00A2",
    "centerdot;":"\u00B7",
    "cfr;":"\uD835\uDD20",
    "chcy;":"\u0447",
    "check;":"\u2713",
    "checkmark;":"\u2713",
    "chi;":"\u03C7",
    "cir;":"\u25CB",
    "cirE;":"\u29C3",
    "circ;":"\u02C6",
    "circeq;":"\u2257",
    "circlearrowleft;":"\u21BA",
    "circlearrowright;":"\u21BB",
    "circledR;":"\u00AE",
    "circledS;":"\u24C8",
    "circledast;":"\u229B",
    "circledcirc;":"\u229A",
    "circleddash;":"\u229D",
    "cire;":"\u2257",
    "cirfnint;":"\u2A10",
    "cirmid;":"\u2AEF",
    "cirscir;":"\u29C2",
    "clubs;":"\u2663",
    "clubsuit;":"\u2663",
    "colon;":"\u003A",
    "colone;":"\u2254",
    "coloneq;":"\u2254",
    "comma;":"\u002C",
    "commat;":"\u0040",
    "comp;":"\u2201",
    "compfn;":"\u2218",
    "complement;":"\u2201",
    "complexes;":"\u2102",
    "cong;":"\u2245",
    "congdot;":"\u2A6D",
    "conint;":"\u222E",
    "copf;":"\uD835\uDD54",
    "coprod;":"\u2210",
    "copy":"\u00A9",
    "copy;":"\u00A9",
    "copysr;":"\u2117",
    "crarr;":"\u21B5",
    "cross;":"\u2717",
    "cscr;":"\uD835\uDCB8",
    "csub;":"\u2ACF",
    "csube;":"\u2AD1",
    "csup;":"\u2AD0",
    "csupe;":"\u2AD2",
    "ctdot;":"\u22EF",
    "cudarrl;":"\u2938",
    "cudarrr;":"\u2935",
    "cuepr;":"\u22DE",
    "cuesc;":"\u22DF",
    "cularr;":"\u21B6",
    "cularrp;":"\u293D",
    "cup;":"\u222A",
    "cupbrcap;":"\u2A48",
    "cupcap;":"\u2A46",
    "cupcup;":"\u2A4A",
    "cupdot;":"\u228D",
    "cupor;":"\u2A45",
    "cups;":"\u222A\uFE00",
    "curarr;":"\u21B7",
    "curarrm;":"\u293C",
    "curlyeqprec;":"\u22DE",
    "curlyeqsucc;":"\u22DF",
    "curlyvee;":"\u22CE",
    "curlywedge;":"\u22CF",
    "curren":"\u00A4",
    "curren;":"\u00A4",
    "curvearrowleft;":"\u21B6",
    "curvearrowright;":"\u21B7",
    "cuvee;":"\u22CE",
    "cuwed;":"\u22CF",
    "cwconint;":"\u2232",
    "cwint;":"\u2231",
    "cylcty;":"\u232D",
    "dArr;":"\u21D3",
    "dHar;":"\u2965",
    "dagger;":"\u2020",
    "daleth;":"\u2138",
    "darr;":"\u2193",
    "dash;":"\u2010",
    "dashv;":"\u22A3",
    "dbkarow;":"\u290F",
    "dblac;":"\u02DD",
    "dcaron;":"\u010F",
    "dcy;":"\u0434",
    "dd;":"\u2146",
    "ddagger;":"\u2021",
    "ddarr;":"\u21CA",
    "ddotseq;":"\u2A77",
    "deg":"\u00B0",
    "deg;":"\u00B0",
    "delta;":"\u03B4",
    "demptyv;":"\u29B1",
    "dfisht;":"\u297F",
    "dfr;":"\uD835\uDD21",
    "dharl;":"\u21C3",
    "dharr;":"\u21C2",
    "diam;":"\u22C4",
    "diamond;":"\u22C4",
    "diamondsuit;":"\u2666",
    "diams;":"\u2666",
    "die;":"\u00A8",
    "digamma;":"\u03DD",
    "disin;":"\u22F2",
    "div;":"\u00F7",
    "divide":"\u00F7",
    "divide;":"\u00F7",
    "divideontimes;":"\u22C7",
    "divonx;":"\u22C7",
    "djcy;":"\u0452",
    "dlcorn;":"\u231E",
    "dlcrop;":"\u230D",
    "dollar;":"\u0024",
    "dopf;":"\uD835\uDD55",
    "dot;":"\u02D9",
    "doteq;":"\u2250",
    "doteqdot;":"\u2251",
    "dotminus;":"\u2238",
    "dotplus;":"\u2214",
    "dotsquare;":"\u22A1",
    "doublebarwedge;":"\u2306",
    "downarrow;":"\u2193",
    "downdownarrows;":"\u21CA",
    "downharpoonleft;":"\u21C3",
    "downharpoonright;":"\u21C2",
    "drbkarow;":"\u2910",
    "drcorn;":"\u231F",
    "drcrop;":"\u230C",
    "dscr;":"\uD835\uDCB9",
    "dscy;":"\u0455",
    "dsol;":"\u29F6",
    "dstrok;":"\u0111",
    "dtdot;":"\u22F1",
    "dtri;":"\u25BF",
    "dtrif;":"\u25BE",
    "duarr;":"\u21F5",
    "duhar;":"\u296F",
    "dwangle;":"\u29A6",
    "dzcy;":"\u045F",
    "dzigrarr;":"\u27FF",
    "eDDot;":"\u2A77",
    "eDot;":"\u2251",
    "eacute":"\u00E9",
    "eacute;":"\u00E9",
    "easter;":"\u2A6E",
    "ecaron;":"\u011B",
    "ecir;":"\u2256",
    "ecirc":"\u00EA",
    "ecirc;":"\u00EA",
    "ecolon;":"\u2255",
    "ecy;":"\u044D",
    "edot;":"\u0117",
    "ee;":"\u2147",
    "efDot;":"\u2252",
    "efr;":"\uD835\uDD22",
    "eg;":"\u2A9A",
    "egrave":"\u00E8",
    "egrave;":"\u00E8",
    "egs;":"\u2A96",
    "egsdot;":"\u2A98",
    "el;":"\u2A99",
    "elinters;":"\u23E7",
    "ell;":"\u2113",
    "els;":"\u2A95",
    "elsdot;":"\u2A97",
    "emacr;":"\u0113",
    "empty;":"\u2205",
    "emptyset;":"\u2205",
    "emptyv;":"\u2205",
    "emsp13;":"\u2004",
    "emsp14;":"\u2005",
    "emsp;":"\u2003",
    "eng;":"\u014B",
    "ensp;":"\u2002",
    "eogon;":"\u0119",
    "eopf;":"\uD835\uDD56",
    "epar;":"\u22D5",
    "eparsl;":"\u29E3",
    "eplus;":"\u2A71",
    "epsi;":"\u03B5",
    "epsilon;":"\u03B5",
    "epsiv;":"\u03F5",
    "eqcirc;":"\u2256",
    "eqcolon;":"\u2255",
    "eqsim;":"\u2242",
    "eqslantgtr;":"\u2A96",
    "eqslantless;":"\u2A95",
    "equals;":"\u003D",
    "equest;":"\u225F",
    "equiv;":"\u2261",
    "equivDD;":"\u2A78",
    "eqvparsl;":"\u29E5",
    "erDot;":"\u2253",
    "erarr;":"\u2971",
    "escr;":"\u212F",
    "esdot;":"\u2250",
    "esim;":"\u2242",
    "eta;":"\u03B7",
    "eth":"\u00F0",
    "eth;":"\u00F0",
    "euml":"\u00EB",
    "euml;":"\u00EB",
    "euro;":"\u20AC",
    "excl;":"\u0021",
    "exist;":"\u2203",
    "expectation;":"\u2130",
    "exponentiale;":"\u2147",
    "fallingdotseq;":"\u2252",
    "fcy;":"\u0444",
    "female;":"\u2640",
    "ffilig;":"\uFB03",
    "fflig;":"\uFB00",
    "ffllig;":"\uFB04",
    "ffr;":"\uD835\uDD23",
    "filig;":"\uFB01",
    "fjlig;":"\u0066\u006A",
    "flat;":"\u266D",
    "fllig;":"\uFB02",
    "fltns;":"\u25B1",
    "fnof;":"\u0192",
    "fopf;":"\uD835\uDD57",
    "forall;":"\u2200",
    "fork;":"\u22D4",
    "forkv;":"\u2AD9",
    "fpartint;":"\u2A0D",
    "frac12":"\u00BD",
    "frac12;":"\u00BD",
    "frac13;":"\u2153",
    "frac14":"\u00BC",
    "frac14;":"\u00BC",
    "frac15;":"\u2155",
    "frac16;":"\u2159",
    "frac18;":"\u215B",
    "frac23;":"\u2154",
    "frac25;":"\u2156",
    "frac34":"\u00BE",
    "frac34;":"\u00BE",
    "frac35;":"\u2157",
    "frac38;":"\u215C",
    "frac45;":"\u2158",
    "frac56;":"\u215A",
    "frac58;":"\u215D",
    "frac78;":"\u215E",
    "frasl;":"\u2044",
    "frown;":"\u2322",
    "fscr;":"\uD835\uDCBB",
    "gE;":"\u2267",
    "gEl;":"\u2A8C",
    "gacute;":"\u01F5",
    "gamma;":"\u03B3",
    "gammad;":"\u03DD",
    "gap;":"\u2A86",
    "gbreve;":"\u011F",
    "gcirc;":"\u011D",
    "gcy;":"\u0433",
    "gdot;":"\u0121",
    "ge;":"\u2265",
    "gel;":"\u22DB",
    "geq;":"\u2265",
    "geqq;":"\u2267",
    "geqslant;":"\u2A7E",
    "ges;":"\u2A7E",
    "gescc;":"\u2AA9",
    "gesdot;":"\u2A80",
    "gesdoto;":"\u2A82",
    "gesdotol;":"\u2A84",
    "gesl;":"\u22DB\uFE00",
    "gesles;":"\u2A94",
    "gfr;":"\uD835\uDD24",
    "gg;":"\u226B",
    "ggg;":"\u22D9",
    "gimel;":"\u2137",
    "gjcy;":"\u0453",
    "gl;":"\u2277",
    "glE;":"\u2A92",
    "gla;":"\u2AA5",
    "glj;":"\u2AA4",
    "gnE;":"\u2269",
    "gnap;":"\u2A8A",
    "gnapprox;":"\u2A8A",
    "gne;":"\u2A88",
    "gneq;":"\u2A88",
    "gneqq;":"\u2269",
    "gnsim;":"\u22E7",
    "gopf;":"\uD835\uDD58",
    "grave;":"\u0060",
    "gscr;":"\u210A",
    "gsim;":"\u2273",
    "gsime;":"\u2A8E",
    "gsiml;":"\u2A90",
    "gt":"\u003E",
    "gt;":"\u003E",
    "gtcc;":"\u2AA7",
    "gtcir;":"\u2A7A",
    "gtdot;":"\u22D7",
    "gtlPar;":"\u2995",
    "gtquest;":"\u2A7C",
    "gtrapprox;":"\u2A86",
    "gtrarr;":"\u2978",
    "gtrdot;":"\u22D7",
    "gtreqless;":"\u22DB",
    "gtreqqless;":"\u2A8C",
    "gtrless;":"\u2277",
    "gtrsim;":"\u2273",
    "gvertneqq;":"\u2269\uFE00",
    "gvnE;":"\u2269\uFE00",
    "hArr;":"\u21D4",
    "hairsp;":"\u200A",
    "half;":"\u00BD",
    "hamilt;":"\u210B",
    "hardcy;":"\u044A",
    "harr;":"\u2194",
    "harrcir;":"\u2948",
    "harrw;":"\u21AD",
    "hbar;":"\u210F",
    "hcirc;":"\u0125",
    "hearts;":"\u2665",
    "heartsuit;":"\u2665",
    "hellip;":"\u2026",
    "hercon;":"\u22B9",
    "hfr;":"\uD835\uDD25",
    "hksearow;":"\u2925",
    "hkswarow;":"\u2926",
    "hoarr;":"\u21FF",
    "homtht;":"\u223B",
    "hookleftarrow;":"\u21A9",
    "hookrightarrow;":"\u21AA",
    "hopf;":"\uD835\uDD59",
    "horbar;":"\u2015",
    "hscr;":"\uD835\uDCBD",
    "hslash;":"\u210F",
    "hstrok;":"\u0127",
    "hybull;":"\u2043",
    "hyphen;":"\u2010",
    "iacute":"\u00ED",
    "iacute;":"\u00ED",
    "ic;":"\u2063",
    "icirc":"\u00EE",
    "icirc;":"\u00EE",
    "icy;":"\u0438",
    "iecy;":"\u0435",
    "iexcl":"\u00A1",
    "iexcl;":"\u00A1",
    "iff;":"\u21D4",
    "ifr;":"\uD835\uDD26",
    "igrave":"\u00EC",
    "igrave;":"\u00EC",
    "ii;":"\u2148",
    "iiiint;":"\u2A0C",
    "iiint;":"\u222D",
    "iinfin;":"\u29DC",
    "iiota;":"\u2129",
    "ijlig;":"\u0133",
    "imacr;":"\u012B",
    "image;":"\u2111",
    "imagline;":"\u2110",
    "imagpart;":"\u2111",
    "imath;":"\u0131",
    "imof;":"\u22B7",
    "imped;":"\u01B5",
    "in;":"\u2208",
    "incare;":"\u2105",
    "infin;":"\u221E",
    "infintie;":"\u29DD",
    "inodot;":"\u0131",
    "int;":"\u222B",
    "intcal;":"\u22BA",
    "integers;":"\u2124",
    "intercal;":"\u22BA",
    "intlarhk;":"\u2A17",
    "intprod;":"\u2A3C",
    "iocy;":"\u0451",
    "iogon;":"\u012F",
    "iopf;":"\uD835\uDD5A",
    "iota;":"\u03B9",
    "iprod;":"\u2A3C",
    "iquest":"\u00BF",
    "iquest;":"\u00BF",
    "iscr;":"\uD835\uDCBE",
    "isin;":"\u2208",
    "isinE;":"\u22F9",
    "isindot;":"\u22F5",
    "isins;":"\u22F4",
    "isinsv;":"\u22F3",
    "isinv;":"\u2208",
    "it;":"\u2062",
    "itilde;":"\u0129",
    "iukcy;":"\u0456",
    "iuml":"\u00EF",
    "iuml;":"\u00EF",
    "jcirc;":"\u0135",
    "jcy;":"\u0439",
    "jfr;":"\uD835\uDD27",
    "jmath;":"\u0237",
    "jopf;":"\uD835\uDD5B",
    "jscr;":"\uD835\uDCBF",
    "jsercy;":"\u0458",
    "jukcy;":"\u0454",
    "kappa;":"\u03BA",
    "kappav;":"\u03F0",
    "kcedil;":"\u0137",
    "kcy;":"\u043A",
    "kfr;":"\uD835\uDD28",
    "kgreen;":"\u0138",
    "khcy;":"\u0445",
    "kjcy;":"\u045C",
    "kopf;":"\uD835\uDD5C",
    "kscr;":"\uD835\uDCC0",
    "lAarr;":"\u21DA",
    "lArr;":"\u21D0",
    "lAtail;":"\u291B",
    "lBarr;":"\u290E",
    "lE;":"\u2266",
    "lEg;":"\u2A8B",
    "lHar;":"\u2962",
    "lacute;":"\u013A",
    "laemptyv;":"\u29B4",
    "lagran;":"\u2112",
    "lambda;":"\u03BB",
    "lang;":"\u27E8",
    "langd;":"\u2991",
    "langle;":"\u27E8",
    "lap;":"\u2A85",
    "laquo":"\u00AB",
    "laquo;":"\u00AB",
    "larr;":"\u2190",
    "larrb;":"\u21E4",
    "larrbfs;":"\u291F",
    "larrfs;":"\u291D",
    "larrhk;":"\u21A9",
    "larrlp;":"\u21AB",
    "larrpl;":"\u2939",
    "larrsim;":"\u2973",
    "larrtl;":"\u21A2",
    "lat;":"\u2AAB",
    "latail;":"\u2919",
    "late;":"\u2AAD",
    "lates;":"\u2AAD\uFE00",
    "lbarr;":"\u290C",
    "lbbrk;":"\u2772",
    "lbrace;":"\u007B",
    "lbrack;":"\u005B",
    "lbrke;":"\u298B",
    "lbrksld;":"\u298F",
    "lbrkslu;":"\u298D",
    "lcaron;":"\u013E",
    "lcedil;":"\u013C",
    "lceil;":"\u2308",
    "lcub;":"\u007B",
    "lcy;":"\u043B",
    "ldca;":"\u2936",
    "ldquo;":"\u201C",
    "ldquor;":"\u201E",
    "ldrdhar;":"\u2967",
    "ldrushar;":"\u294B",
    "ldsh;":"\u21B2",
    "le;":"\u2264",
    "leftarrow;":"\u2190",
    "leftarrowtail;":"\u21A2",
    "leftharpoondown;":"\u21BD",
    "leftharpoonup;":"\u21BC",
    "leftleftarrows;":"\u21C7",
    "leftrightarrow;":"\u2194",
    "leftrightarrows;":"\u21C6",
    "leftrightharpoons;":"\u21CB",
    "leftrightsquigarrow;":"\u21AD",
    "leftthreetimes;":"\u22CB",
    "leg;":"\u22DA",
    "leq;":"\u2264",
    "leqq;":"\u2266",
    "leqslant;":"\u2A7D",
    "les;":"\u2A7D",
    "lescc;":"\u2AA8",
    "lesdot;":"\u2A7F",
    "lesdoto;":"\u2A81",
    "lesdotor;":"\u2A83",
    "lesg;":"\u22DA\uFE00",
    "lesges;":"\u2A93",
    "lessapprox;":"\u2A85",
    "lessdot;":"\u22D6",
    "lesseqgtr;":"\u22DA",
    "lesseqqgtr;":"\u2A8B",
    "lessgtr;":"\u2276",
    "lesssim;":"\u2272",
    "lfisht;":"\u297C",
    "lfloor;":"\u230A",
    "lfr;":"\uD835\uDD29",
    "lg;":"\u2276",
    "lgE;":"\u2A91",
    "lhard;":"\u21BD",
    "lharu;":"\u21BC",
    "lharul;":"\u296A",
    "lhblk;":"\u2584",
    "ljcy;":"\u0459",
    "ll;":"\u226A",
    "llarr;":"\u21C7",
    "llcorner;":"\u231E",
    "llhard;":"\u296B",
    "lltri;":"\u25FA",
    "lmidot;":"\u0140",
    "lmoust;":"\u23B0",
    "lmoustache;":"\u23B0",
    "lnE;":"\u2268",
    "lnap;":"\u2A89",
    "lnapprox;":"\u2A89",
    "lne;":"\u2A87",
    "lneq;":"\u2A87",
    "lneqq;":"\u2268",
    "lnsim;":"\u22E6",
    "loang;":"\u27EC",
    "loarr;":"\u21FD",
    "lobrk;":"\u27E6",
    "longleftarrow;":"\u27F5",
    "longleftrightarrow;":"\u27F7",
    "longmapsto;":"\u27FC",
    "longrightarrow;":"\u27F6",
    "looparrowleft;":"\u21AB",
    "looparrowright;":"\u21AC",
    "lopar;":"\u2985",
    "lopf;":"\uD835\uDD5D",
    "loplus;":"\u2A2D",
    "lotimes;":"\u2A34",
    "lowast;":"\u2217",
    "lowbar;":"\u005F",
    "loz;":"\u25CA",
    "lozenge;":"\u25CA",
    "lozf;":"\u29EB",
    "lpar;":"\u0028",
    "lparlt;":"\u2993",
    "lrarr;":"\u21C6",
    "lrcorner;":"\u231F",
    "lrhar;":"\u21CB",
    "lrhard;":"\u296D",
    "lrm;":"\u200E",
    "lrtri;":"\u22BF",
    "lsaquo;":"\u2039",
    "lscr;":"\uD835\uDCC1",
    "lsh;":"\u21B0",
    "lsim;":"\u2272",
    "lsime;":"\u2A8D",
    "lsimg;":"\u2A8F",
    "lsqb;":"\u005B",
    "lsquo;":"\u2018",
    "lsquor;":"\u201A",
    "lstrok;":"\u0142",
    "lt":"\u003C",
    "lt;":"\u003C",
    "ltcc;":"\u2AA6",
    "ltcir;":"\u2A79",
    "ltdot;":"\u22D6",
    "lthree;":"\u22CB",
    "ltimes;":"\u22C9",
    "ltlarr;":"\u2976",
    "ltquest;":"\u2A7B",
    "ltrPar;":"\u2996",
    "ltri;":"\u25C3",
    "ltrie;":"\u22B4",
    "ltrif;":"\u25C2",
    "lurdshar;":"\u294A",
    "luruhar;":"\u2966",
    "lvertneqq;":"\u2268\uFE00",
    "lvnE;":"\u2268\uFE00",
    "mDDot;":"\u223A",
    "macr":"\u00AF",
    "macr;":"\u00AF",
    "male;":"\u2642",
    "malt;":"\u2720",
    "maltese;":"\u2720",
    "map;":"\u21A6",
    "mapsto;":"\u21A6",
    "mapstodown;":"\u21A7",
    "mapstoleft;":"\u21A4",
    "mapstoup;":"\u21A5",
    "marker;":"\u25AE",
    "mcomma;":"\u2A29",
    "mcy;":"\u043C",
    "mdash;":"\u2014",
    "measuredangle;":"\u2221",
    "mfr;":"\uD835\uDD2A",
    "mho;":"\u2127",
    "micro":"\u00B5",
    "micro;":"\u00B5",
    "mid;":"\u2223",
    "midast;":"\u002A",
    "midcir;":"\u2AF0",
    "middot":"\u00B7",
    "middot;":"\u00B7",
    "minus;":"\u2212",
    "minusb;":"\u229F",
    "minusd;":"\u2238",
    "minusdu;":"\u2A2A",
    "mlcp;":"\u2ADB",
    "mldr;":"\u2026",
    "mnplus;":"\u2213",
    "models;":"\u22A7",
    "mopf;":"\uD835\uDD5E",
    "mp;":"\u2213",
    "mscr;":"\uD835\uDCC2",
    "mstpos;":"\u223E",
    "mu;":"\u03BC",
    "multimap;":"\u22B8",
    "mumap;":"\u22B8",
    "nGg;":"\u22D9\u0338",
    "nGt;":"\u226B\u20D2",
    "nGtv;":"\u226B\u0338",
    "nLeftarrow;":"\u21CD",
    "nLeftrightarrow;":"\u21CE",
    "nLl;":"\u22D8\u0338",
    "nLt;":"\u226A\u20D2",
    "nLtv;":"\u226A\u0338",
    "nRightarrow;":"\u21CF",
    "nVDash;":"\u22AF",
    "nVdash;":"\u22AE",
    "nabla;":"\u2207",
    "nacute;":"\u0144",
    "nang;":"\u2220\u20D2",
    "nap;":"\u2249",
    "napE;":"\u2A70\u0338",
    "napid;":"\u224B\u0338",
    "napos;":"\u0149",
    "napprox;":"\u2249",
    "natur;":"\u266E",
    "natural;":"\u266E",
    "naturals;":"\u2115",
    "nbsp":"\u00A0",
    "nbsp;":"\u00A0",
    "nbump;":"\u224E\u0338",
    "nbumpe;":"\u224F\u0338",
    "ncap;":"\u2A43",
    "ncaron;":"\u0148",
    "ncedil;":"\u0146",
    "ncong;":"\u2247",
    "ncongdot;":"\u2A6D\u0338",
    "ncup;":"\u2A42",
    "ncy;":"\u043D",
    "ndash;":"\u2013",
    "ne;":"\u2260",
    "neArr;":"\u21D7",
    "nearhk;":"\u2924",
    "nearr;":"\u2197",
    "nearrow;":"\u2197",
    "nedot;":"\u2250\u0338",
    "nequiv;":"\u2262",
    "nesear;":"\u2928",
    "nesim;":"\u2242\u0338",
    "nexist;":"\u2204",
    "nexists;":"\u2204",
    "nfr;":"\uD835\uDD2B",
    "ngE;":"\u2267\u0338",
    "nge;":"\u2271",
    "ngeq;":"\u2271",
    "ngeqq;":"\u2267\u0338",
    "ngeqslant;":"\u2A7E\u0338",
    "nges;":"\u2A7E\u0338",
    "ngsim;":"\u2275",
    "ngt;":"\u226F",
    "ngtr;":"\u226F",
    "nhArr;":"\u21CE",
    "nharr;":"\u21AE",
    "nhpar;":"\u2AF2",
    "ni;":"\u220B",
    "nis;":"\u22FC",
    "nisd;":"\u22FA",
    "niv;":"\u220B",
    "njcy;":"\u045A",
    "nlArr;":"\u21CD",
    "nlE;":"\u2266\u0338",
    "nlarr;":"\u219A",
    "nldr;":"\u2025",
    "nle;":"\u2270",
    "nleftarrow;":"\u219A",
    "nleftrightarrow;":"\u21AE",
    "nleq;":"\u2270",
    "nleqq;":"\u2266\u0338",
    "nleqslant;":"\u2A7D\u0338",
    "nles;":"\u2A7D\u0338",
    "nless;":"\u226E",
    "nlsim;":"\u2274",
    "nlt;":"\u226E",
    "nltri;":"\u22EA",
    "nltrie;":"\u22EC",
    "nmid;":"\u2224",
    "nopf;":"\uD835\uDD5F",
    "not":"\u00AC",
    "not;":"\u00AC",
    "notin;":"\u2209",
    "notinE;":"\u22F9\u0338",
    "notindot;":"\u22F5\u0338",
    "notinva;":"\u2209",
    "notinvb;":"\u22F7",
    "notinvc;":"\u22F6",
    "notni;":"\u220C",
    "notniva;":"\u220C",
    "notnivb;":"\u22FE",
    "notnivc;":"\u22FD",
    "npar;":"\u2226",
    "nparallel;":"\u2226",
    "nparsl;":"\u2AFD\u20E5",
    "npart;":"\u2202\u0338",
    "npolint;":"\u2A14",
    "npr;":"\u2280",
    "nprcue;":"\u22E0",
    "npre;":"\u2AAF\u0338",
    "nprec;":"\u2280",
    "npreceq;":"\u2AAF\u0338",
    "nrArr;":"\u21CF",
    "nrarr;":"\u219B",
    "nrarrc;":"\u2933\u0338",
    "nrarrw;":"\u219D\u0338",
    "nrightarrow;":"\u219B",
    "nrtri;":"\u22EB",
    "nrtrie;":"\u22ED",
    "nsc;":"\u2281",
    "nsccue;":"\u22E1",
    "nsce;":"\u2AB0\u0338",
    "nscr;":"\uD835\uDCC3",
    "nshortmid;":"\u2224",
    "nshortparallel;":"\u2226",
    "nsim;":"\u2241",
    "nsime;":"\u2244",
    "nsimeq;":"\u2244",
    "nsmid;":"\u2224",
    "nspar;":"\u2226",
    "nsqsube;":"\u22E2",
    "nsqsupe;":"\u22E3",
    "nsub;":"\u2284",
    "nsubE;":"\u2AC5\u0338",
    "nsube;":"\u2288",
    "nsubset;":"\u2282\u20D2",
    "nsubseteq;":"\u2288",
    "nsubseteqq;":"\u2AC5\u0338",
    "nsucc;":"\u2281",
    "nsucceq;":"\u2AB0\u0338",
    "nsup;":"\u2285",
    "nsupE;":"\u2AC6\u0338",
    "nsupe;":"\u2289",
    "nsupset;":"\u2283\u20D2",
    "nsupseteq;":"\u2289",
    "nsupseteqq;":"\u2AC6\u0338",
    "ntgl;":"\u2279",
    "ntilde":"\u00F1",
    "ntilde;":"\u00F1",
    "ntlg;":"\u2278",
    "ntriangleleft;":"\u22EA",
    "ntrianglelefteq;":"\u22EC",
    "ntriangleright;":"\u22EB",
    "ntrianglerighteq;":"\u22ED",
    "nu;":"\u03BD",
    "num;":"\u0023",
    "numero;":"\u2116",
    "numsp;":"\u2007",
    "nvDash;":"\u22AD",
    "nvHarr;":"\u2904",
    "nvap;":"\u224D\u20D2",
    "nvdash;":"\u22AC",
    "nvge;":"\u2265\u20D2",
    "nvgt;":"\u003E\u20D2",
    "nvinfin;":"\u29DE",
    "nvlArr;":"\u2902",
    "nvle;":"\u2264\u20D2",
    "nvlt;":"\u003C\u20D2",
    "nvltrie;":"\u22B4\u20D2",
    "nvrArr;":"\u2903",
    "nvrtrie;":"\u22B5\u20D2",
    "nvsim;":"\u223C\u20D2",
    "nwArr;":"\u21D6",
    "nwarhk;":"\u2923",
    "nwarr;":"\u2196",
    "nwarrow;":"\u2196",
    "nwnear;":"\u2927",
    "oS;":"\u24C8",
    "oacute":"\u00F3",
    "oacute;":"\u00F3",
    "oast;":"\u229B",
    "ocir;":"\u229A",
    "ocirc":"\u00F4",
    "ocirc;":"\u00F4",
    "ocy;":"\u043E",
    "odash;":"\u229D",
    "odblac;":"\u0151",
    "odiv;":"\u2A38",
    "odot;":"\u2299",
    "odsold;":"\u29BC",
    "oelig;":"\u0153",
    "ofcir;":"\u29BF",
    "ofr;":"\uD835\uDD2C",
    "ogon;":"\u02DB",
    "ograve":"\u00F2",
    "ograve;":"\u00F2",
    "ogt;":"\u29C1",
    "ohbar;":"\u29B5",
    "ohm;":"\u03A9",
    "oint;":"\u222E",
    "olarr;":"\u21BA",
    "olcir;":"\u29BE",
    "olcross;":"\u29BB",
    "oline;":"\u203E",
    "olt;":"\u29C0",
    "omacr;":"\u014D",
    "omega;":"\u03C9",
    "omicron;":"\u03BF",
    "omid;":"\u29B6",
    "ominus;":"\u2296",
    "oopf;":"\uD835\uDD60",
    "opar;":"\u29B7",
    "operp;":"\u29B9",
    "oplus;":"\u2295",
    "or;":"\u2228",
    "orarr;":"\u21BB",
    "ord;":"\u2A5D",
    "order;":"\u2134",
    "orderof;":"\u2134",
    "ordf":"\u00AA",
    "ordf;":"\u00AA",
    "ordm":"\u00BA",
    "ordm;":"\u00BA",
    "origof;":"\u22B6",
    "oror;":"\u2A56",
    "orslope;":"\u2A57",
    "orv;":"\u2A5B",
    "oscr;":"\u2134",
    "oslash":"\u00F8",
    "oslash;":"\u00F8",
    "osol;":"\u2298",
    "otilde":"\u00F5",
    "otilde;":"\u00F5",
    "otimes;":"\u2297",
    "otimesas;":"\u2A36",
    "ouml":"\u00F6",
    "ouml;":"\u00F6",
    "ovbar;":"\u233D",
    "par;":"\u2225",
    "para":"\u00B6",
    "para;":"\u00B6",
    "parallel;":"\u2225",
    "parsim;":"\u2AF3",
    "parsl;":"\u2AFD",
    "part;":"\u2202",
    "pcy;":"\u043F",
    "percnt;":"\u0025",
    "period;":"\u002E",
    "permil;":"\u2030",
    "perp;":"\u22A5",
    "pertenk;":"\u2031",
    "pfr;":"\uD835\uDD2D",
    "phi;":"\u03C6",
    "phiv;":"\u03D5",
    "phmmat;":"\u2133",
    "phone;":"\u260E",
    "pi;":"\u03C0",
    "pitchfork;":"\u22D4",
    "piv;":"\u03D6",
    "planck;":"\u210F",
    "planckh;":"\u210E",
    "plankv;":"\u210F",
    "plus;":"\u002B",
    "plusacir;":"\u2A23",
    "plusb;":"\u229E",
    "pluscir;":"\u2A22",
    "plusdo;":"\u2214",
    "plusdu;":"\u2A25",
    "pluse;":"\u2A72",
    "plusmn":"\u00B1",
    "plusmn;":"\u00B1",
    "plussim;":"\u2A26",
    "plustwo;":"\u2A27",
    "pm;":"\u00B1",
    "pointint;":"\u2A15",
    "popf;":"\uD835\uDD61",
    "pound":"\u00A3",
    "pound;":"\u00A3",
    "pr;":"\u227A",
    "prE;":"\u2AB3",
    "prap;":"\u2AB7",
    "prcue;":"\u227C",
    "pre;":"\u2AAF",
    "prec;":"\u227A",
    "precapprox;":"\u2AB7",
    "preccurlyeq;":"\u227C",
    "preceq;":"\u2AAF",
    "precnapprox;":"\u2AB9",
    "precneqq;":"\u2AB5",
    "precnsim;":"\u22E8",
    "precsim;":"\u227E",
    "prime;":"\u2032",
    "primes;":"\u2119",
    "prnE;":"\u2AB5",
    "prnap;":"\u2AB9",
    "prnsim;":"\u22E8",
    "prod;":"\u220F",
    "profalar;":"\u232E",
    "profline;":"\u2312",
    "profsurf;":"\u2313",
    "prop;":"\u221D",
    "propto;":"\u221D",
    "prsim;":"\u227E",
    "prurel;":"\u22B0",
    "pscr;":"\uD835\uDCC5",
    "psi;":"\u03C8",
    "puncsp;":"\u2008",
    "qfr;":"\uD835\uDD2E",
    "qint;":"\u2A0C",
    "qopf;":"\uD835\uDD62",
    "qprime;":"\u2057",
    "qscr;":"\uD835\uDCC6",
    "quaternions;":"\u210D",
    "quatint;":"\u2A16",
    "quest;":"\u003F",
    "questeq;":"\u225F",
    "quot":"\u0022",
    "quot;":"\u0022",
    "rAarr;":"\u21DB",
    "rArr;":"\u21D2",
    "rAtail;":"\u291C",
    "rBarr;":"\u290F",
    "rHar;":"\u2964",
    "race;":"\u223D\u0331",
    "racute;":"\u0155",
    "radic;":"\u221A",
    "raemptyv;":"\u29B3",
    "rang;":"\u27E9",
    "rangd;":"\u2992",
    "range;":"\u29A5",
    "rangle;":"\u27E9",
    "raquo":"\u00BB",
    "raquo;":"\u00BB",
    "rarr;":"\u2192",
    "rarrap;":"\u2975",
    "rarrb;":"\u21E5",
    "rarrbfs;":"\u2920",
    "rarrc;":"\u2933",
    "rarrfs;":"\u291E",
    "rarrhk;":"\u21AA",
    "rarrlp;":"\u21AC",
    "rarrpl;":"\u2945",
    "rarrsim;":"\u2974",
    "rarrtl;":"\u21A3",
    "rarrw;":"\u219D",
    "ratail;":"\u291A",
    "ratio;":"\u2236",
    "rationals;":"\u211A",
    "rbarr;":"\u290D",
    "rbbrk;":"\u2773",
    "rbrace;":"\u007D",
    "rbrack;":"\u005D",
    "rbrke;":"\u298C",
    "rbrksld;":"\u298E",
    "rbrkslu;":"\u2990",
    "rcaron;":"\u0159",
    "rcedil;":"\u0157",
    "rceil;":"\u2309",
    "rcub;":"\u007D",
    "rcy;":"\u0440",
    "rdca;":"\u2937",
    "rdldhar;":"\u2969",
    "rdquo;":"\u201D",
    "rdquor;":"\u201D",
    "rdsh;":"\u21B3",
    "real;":"\u211C",
    "realine;":"\u211B",
    "realpart;":"\u211C",
    "reals;":"\u211D",
    "rect;":"\u25AD",
    "reg":"\u00AE",
    "reg;":"\u00AE",
    "rfisht;":"\u297D",
    "rfloor;":"\u230B",
    "rfr;":"\uD835\uDD2F",
    "rhard;":"\u21C1",
    "rharu;":"\u21C0",
    "rharul;":"\u296C",
    "rho;":"\u03C1",
    "rhov;":"\u03F1",
    "rightarrow;":"\u2192",
    "rightarrowtail;":"\u21A3",
    "rightharpoondown;":"\u21C1",
    "rightharpoonup;":"\u21C0",
    "rightleftarrows;":"\u21C4",
    "rightleftharpoons;":"\u21CC",
    "rightrightarrows;":"\u21C9",
    "rightsquigarrow;":"\u219D",
    "rightthreetimes;":"\u22CC",
    "ring;":"\u02DA",
    "risingdotseq;":"\u2253",
    "rlarr;":"\u21C4",
    "rlhar;":"\u21CC",
    "rlm;":"\u200F",
    "rmoust;":"\u23B1",
    "rmoustache;":"\u23B1",
    "rnmid;":"\u2AEE",
    "roang;":"\u27ED",
    "roarr;":"\u21FE",
    "robrk;":"\u27E7",
    "ropar;":"\u2986",
    "ropf;":"\uD835\uDD63",
    "roplus;":"\u2A2E",
    "rotimes;":"\u2A35",
    "rpar;":"\u0029",
    "rpargt;":"\u2994",
    "rppolint;":"\u2A12",
    "rrarr;":"\u21C9",
    "rsaquo;":"\u203A",
    "rscr;":"\uD835\uDCC7",
    "rsh;":"\u21B1",
    "rsqb;":"\u005D",
    "rsquo;":"\u2019",
    "rsquor;":"\u2019",
    "rthree;":"\u22CC",
    "rtimes;":"\u22CA",
    "rtri;":"\u25B9",
    "rtrie;":"\u22B5",
    "rtrif;":"\u25B8",
    "rtriltri;":"\u29CE",
    "ruluhar;":"\u2968",
    "rx;":"\u211E",
    "sacute;":"\u015B",
    "sbquo;":"\u201A",
    "sc;":"\u227B",
    "scE;":"\u2AB4",
    "scap;":"\u2AB8",
    "scaron;":"\u0161",
    "sccue;":"\u227D",
    "sce;":"\u2AB0",
    "scedil;":"\u015F",
    "scirc;":"\u015D",
    "scnE;":"\u2AB6",
    "scnap;":"\u2ABA",
    "scnsim;":"\u22E9",
    "scpolint;":"\u2A13",
    "scsim;":"\u227F",
    "scy;":"\u0441",
    "sdot;":"\u22C5",
    "sdotb;":"\u22A1",
    "sdote;":"\u2A66",
    "seArr;":"\u21D8",
    "searhk;":"\u2925",
    "searr;":"\u2198",
    "searrow;":"\u2198",
    "sect":"\u00A7",
    "sect;":"\u00A7",
    "semi;":"\u003B",
    "seswar;":"\u2929",
    "setminus;":"\u2216",
    "setmn;":"\u2216",
    "sext;":"\u2736",
    "sfr;":"\uD835\uDD30",
    "sfrown;":"\u2322",
    "sharp;":"\u266F",
    "shchcy;":"\u0449",
    "shcy;":"\u0448",
    "shortmid;":"\u2223",
    "shortparallel;":"\u2225",
    "shy":"\u00AD",
    "shy;":"\u00AD",
    "sigma;":"\u03C3",
    "sigmaf;":"\u03C2",
    "sigmav;":"\u03C2",
    "sim;":"\u223C",
    "simdot;":"\u2A6A",
    "sime;":"\u2243",
    "simeq;":"\u2243",
    "simg;":"\u2A9E",
    "simgE;":"\u2AA0",
    "siml;":"\u2A9D",
    "simlE;":"\u2A9F",
    "simne;":"\u2246",
    "simplus;":"\u2A24",
    "simrarr;":"\u2972",
    "slarr;":"\u2190",
    "smallsetminus;":"\u2216",
    "smashp;":"\u2A33",
    "smeparsl;":"\u29E4",
    "smid;":"\u2223",
    "smile;":"\u2323",
    "smt;":"\u2AAA",
    "smte;":"\u2AAC",
    "smtes;":"\u2AAC\uFE00",
    "softcy;":"\u044C",
    "sol;":"\u002F",
    "solb;":"\u29C4",
    "solbar;":"\u233F",
    "sopf;":"\uD835\uDD64",
    "spades;":"\u2660",
    "spadesuit;":"\u2660",
    "spar;":"\u2225",
    "sqcap;":"\u2293",
    "sqcaps;":"\u2293\uFE00",
    "sqcup;":"\u2294",
    "sqcups;":"\u2294\uFE00",
    "sqsub;":"\u228F",
    "sqsube;":"\u2291",
    "sqsubset;":"\u228F",
    "sqsubseteq;":"\u2291",
    "sqsup;":"\u2290",
    "sqsupe;":"\u2292",
    "sqsupset;":"\u2290",
    "sqsupseteq;":"\u2292",
    "squ;":"\u25A1",
    "square;":"\u25A1",
    "squarf;":"\u25AA",
    "squf;":"\u25AA",
    "srarr;":"\u2192",
    "sscr;":"\uD835\uDCC8",
    "ssetmn;":"\u2216",
    "ssmile;":"\u2323",
    "sstarf;":"\u22C6",
    "star;":"\u2606",
    "starf;":"\u2605",
    "straightepsilon;":"\u03F5",
    "straightphi;":"\u03D5",
    "strns;":"\u00AF",
    "sub;":"\u2282",
    "subE;":"\u2AC5",
    "subdot;":"\u2ABD",
    "sube;":"\u2286",
    "subedot;":"\u2AC3",
    "submult;":"\u2AC1",
    "subnE;":"\u2ACB",
    "subne;":"\u228A",
    "subplus;":"\u2ABF",
    "subrarr;":"\u2979",
    "subset;":"\u2282",
    "subseteq;":"\u2286",
    "subseteqq;":"\u2AC5",
    "subsetneq;":"\u228A",
    "subsetneqq;":"\u2ACB",
    "subsim;":"\u2AC7",
    "subsub;":"\u2AD5",
    "subsup;":"\u2AD3",
    "succ;":"\u227B",
    "succapprox;":"\u2AB8",
    "succcurlyeq;":"\u227D",
    "succeq;":"\u2AB0",
    "succnapprox;":"\u2ABA",
    "succneqq;":"\u2AB6",
    "succnsim;":"\u22E9",
    "succsim;":"\u227F",
    "sum;":"\u2211",
    "sung;":"\u266A",
    "sup1":"\u00B9",
    "sup1;":"\u00B9",
    "sup2":"\u00B2",
    "sup2;":"\u00B2",
    "sup3":"\u00B3",
    "sup3;":"\u00B3",
    "sup;":"\u2283",
    "supE;":"\u2AC6",
    "supdot;":"\u2ABE",
    "supdsub;":"\u2AD8",
    "supe;":"\u2287",
    "supedot;":"\u2AC4",
    "suphsol;":"\u27C9",
    "suphsub;":"\u2AD7",
    "suplarr;":"\u297B",
    "supmult;":"\u2AC2",
    "supnE;":"\u2ACC",
    "supne;":"\u228B",
    "supplus;":"\u2AC0",
    "supset;":"\u2283",
    "supseteq;":"\u2287",
    "supseteqq;":"\u2AC6",
    "supsetneq;":"\u228B",
    "supsetneqq;":"\u2ACC",
    "supsim;":"\u2AC8",
    "supsub;":"\u2AD4",
    "supsup;":"\u2AD6",
    "swArr;":"\u21D9",
    "swarhk;":"\u2926",
    "swarr;":"\u2199",
    "swarrow;":"\u2199",
    "swnwar;":"\u292A",
    "szlig":"\u00DF",
    "szlig;":"\u00DF",
    "target;":"\u2316",
    "tau;":"\u03C4",
    "tbrk;":"\u23B4",
    "tcaron;":"\u0165",
    "tcedil;":"\u0163",
    "tcy;":"\u0442",
    "tdot;":"\u20DB",
    "telrec;":"\u2315",
    "tfr;":"\uD835\uDD31",
    "there4;":"\u2234",
    "therefore;":"\u2234",
    "theta;":"\u03B8",
    "thetasym;":"\u03D1",
    "thetav;":"\u03D1",
    "thickapprox;":"\u2248",
    "thicksim;":"\u223C",
    "thinsp;":"\u2009",
    "thkap;":"\u2248",
    "thksim;":"\u223C",
    "thorn":"\u00FE",
    "thorn;":"\u00FE",
    "tilde;":"\u02DC",
    "times":"\u00D7",
    "times;":"\u00D7",
    "timesb;":"\u22A0",
    "timesbar;":"\u2A31",
    "timesd;":"\u2A30",
    "tint;":"\u222D",
    "toea;":"\u2928",
    "top;":"\u22A4",
    "topbot;":"\u2336",
    "topcir;":"\u2AF1",
    "topf;":"\uD835\uDD65",
    "topfork;":"\u2ADA",
    "tosa;":"\u2929",
    "tprime;":"\u2034",
    "trade;":"\u2122",
    "triangle;":"\u25B5",
    "triangledown;":"\u25BF",
    "triangleleft;":"\u25C3",
    "trianglelefteq;":"\u22B4",
    "triangleq;":"\u225C",
    "triangleright;":"\u25B9",
    "trianglerighteq;":"\u22B5",
    "tridot;":"\u25EC",
    "trie;":"\u225C",
    "triminus;":"\u2A3A",
    "triplus;":"\u2A39",
    "trisb;":"\u29CD",
    "tritime;":"\u2A3B",
    "trpezium;":"\u23E2",
    "tscr;":"\uD835\uDCC9",
    "tscy;":"\u0446",
    "tshcy;":"\u045B",
    "tstrok;":"\u0167",
    "twixt;":"\u226C",
    "twoheadleftarrow;":"\u219E",
    "twoheadrightarrow;":"\u21A0",
    "uArr;":"\u21D1",
    "uHar;":"\u2963",
    "uacute":"\u00FA",
    "uacute;":"\u00FA",
    "uarr;":"\u2191",
    "ubrcy;":"\u045E",
    "ubreve;":"\u016D",
    "ucirc":"\u00FB",
    "ucirc;":"\u00FB",
    "ucy;":"\u0443",
    "udarr;":"\u21C5",
    "udblac;":"\u0171",
    "udhar;":"\u296E",
    "ufisht;":"\u297E",
    "ufr;":"\uD835\uDD32",
    "ugrave":"\u00F9",
    "ugrave;":"\u00F9",
    "uharl;":"\u21BF",
    "uharr;":"\u21BE",
    "uhblk;":"\u2580",
    "ulcorn;":"\u231C",
    "ulcorner;":"\u231C",
    "ulcrop;":"\u230F",
    "ultri;":"\u25F8",
    "umacr;":"\u016B",
    "uml":"\u00A8",
    "uml;":"\u00A8",
    "uogon;":"\u0173",
    "uopf;":"\uD835\uDD66",
    "uparrow;":"\u2191",
    "updownarrow;":"\u2195",
    "upharpoonleft;":"\u21BF",
    "upharpoonright;":"\u21BE",
    "uplus;":"\u228E",
    "upsi;":"\u03C5",
    "upsih;":"\u03D2",
    "upsilon;":"\u03C5",
    "upuparrows;":"\u21C8",
    "urcorn;":"\u231D",
    "urcorner;":"\u231D",
    "urcrop;":"\u230E",
    "uring;":"\u016F",
    "urtri;":"\u25F9",
    "uscr;":"\uD835\uDCCA",
    "utdot;":"\u22F0",
    "utilde;":"\u0169",
    "utri;":"\u25B5",
    "utrif;":"\u25B4",
    "uuarr;":"\u21C8",
    "uuml":"\u00FC",
    "uuml;":"\u00FC",
    "uwangle;":"\u29A7",
    "vArr;":"\u21D5",
    "vBar;":"\u2AE8",
    "vBarv;":"\u2AE9",
    "vDash;":"\u22A8",
    "vangrt;":"\u299C",
    "varepsilon;":"\u03F5",
    "varkappa;":"\u03F0",
    "varnothing;":"\u2205",
    "varphi;":"\u03D5",
    "varpi;":"\u03D6",
    "varpropto;":"\u221D",
    "varr;":"\u2195",
    "varrho;":"\u03F1",
    "varsigma;":"\u03C2",
    "varsubsetneq;":"\u228A\uFE00",
    "varsubsetneqq;":"\u2ACB\uFE00",
    "varsupsetneq;":"\u228B\uFE00",
    "varsupsetneqq;":"\u2ACC\uFE00",
    "vartheta;":"\u03D1",
    "vartriangleleft;":"\u22B2",
    "vartriangleright;":"\u22B3",
    "vcy;":"\u0432",
    "vdash;":"\u22A2",
    "vee;":"\u2228",
    "veebar;":"\u22BB",
    "veeeq;":"\u225A",
    "vellip;":"\u22EE",
    "verbar;":"\u007C",
    "vert;":"\u007C",
    "vfr;":"\uD835\uDD33",
    "vltri;":"\u22B2",
    "vnsub;":"\u2282\u20D2",
    "vnsup;":"\u2283\u20D2",
    "vopf;":"\uD835\uDD67",
    "vprop;":"\u221D",
    "vrtri;":"\u22B3",
    "vscr;":"\uD835\uDCCB",
    "vsubnE;":"\u2ACB\uFE00",
    "vsubne;":"\u228A\uFE00",
    "vsupnE;":"\u2ACC\uFE00",
    "vsupne;":"\u228B\uFE00",
    "vzigzag;":"\u299A",
    "wcirc;":"\u0175",
    "wedbar;":"\u2A5F",
    "wedge;":"\u2227",
    "wedgeq;":"\u2259",
    "weierp;":"\u2118",
    "wfr;":"\uD835\uDD34",
    "wopf;":"\uD835\uDD68",
    "wp;":"\u2118",
    "wr;":"\u2240",
    "wreath;":"\u2240",
    "wscr;":"\uD835\uDCCC",
    "xcap;":"\u22C2",
    "xcirc;":"\u25EF",
    "xcup;":"\u22C3",
    "xdtri;":"\u25BD",
    "xfr;":"\uD835\uDD35",
    "xhArr;":"\u27FA",
    "xharr;":"\u27F7",
    "xi;":"\u03BE",
    "xlArr;":"\u27F8",
    "xlarr;":"\u27F5",
    "xmap;":"\u27FC",
    "xnis;":"\u22FB",
    "xodot;":"\u2A00",
    "xopf;":"\uD835\uDD69",
    "xoplus;":"\u2A01",
    "xotime;":"\u2A02",
    "xrArr;":"\u27F9",
    "xrarr;":"\u27F6",
    "xscr;":"\uD835\uDCCD",
    "xsqcup;":"\u2A06",
    "xuplus;":"\u2A04",
    "xutri;":"\u25B3",
    "xvee;":"\u22C1",
    "xwedge;":"\u22C0",
    "yacute":"\u00FD",
    "yacute;":"\u00FD",
    "yacy;":"\u044F",
    "ycirc;":"\u0177",
    "ycy;":"\u044B",
    "yen":"\u00A5",
    "yen;":"\u00A5",
    "yfr;":"\uD835\uDD36",
    "yicy;":"\u0457",
    "yopf;":"\uD835\uDD6A",
    "yscr;":"\uD835\uDCCE",
    "yucy;":"\u044E",
    "yuml":"\u00FF",
    "yuml;":"\u00FF",
    "zacute;":"\u017A",
    "zcaron;":"\u017E",
    "zcy;":"\u0437",
    "zdot;":"\u017C",
    "zeetrf;":"\u2128",
    "zeta;":"\u03B6",
    "zfr;":"\uD835\uDD37",
    "zhcy;":"\u0436",
    "zigrarr;":"\u21DD",
    "zopf;":"\uD835\uDD6B",
    "zscr;":"\uD835\uDCCF",
    "zwj;":"\u200D",
    "zwnj;":"\u200C"
  };
  // Doctype public ids that select quirks mode in package:html (InitialPhase.processDoctype). Only
  // quirks mode changes the tree: there a <table> does not close an open <p>. The second list only
  // counts when the doctype has no system id.
  var QUIRKS_PUBLIC_ID_PREFIXES = ["+//silmaril//dtd html pro v0r11 19970101//","-//advasoft ltd//dtd html 3.0 aswedit + extensions//","-//as//dtd html 3.0 aswedit + extensions//","-//ietf//dtd html 2.0 level 1//","-//ietf//dtd html 2.0 level 2//","-//ietf//dtd html 2.0 strict level 1//","-//ietf//dtd html 2.0 strict level 2//","-//ietf//dtd html 2.0 strict//","-//ietf//dtd html 2.0//","-//ietf//dtd html 2.1e//","-//ietf//dtd html 3.0//","-//ietf//dtd html 3.2 final//","-//ietf//dtd html 3.2//","-//ietf//dtd html 3//","-//ietf//dtd html level 0//","-//ietf//dtd html level 1//","-//ietf//dtd html level 2//","-//ietf//dtd html level 3//","-//ietf//dtd html strict level 0//","-//ietf//dtd html strict level 1//","-//ietf//dtd html strict level 2//","-//ietf//dtd html strict level 3//","-//ietf//dtd html strict//","-//ietf//dtd html//","-//metrius//dtd metrius presentational//","-//microsoft//dtd internet explorer 2.0 html strict//","-//microsoft//dtd internet explorer 2.0 html//","-//microsoft//dtd internet explorer 2.0 tables//","-//microsoft//dtd internet explorer 3.0 html strict//","-//microsoft//dtd internet explorer 3.0 html//","-//microsoft//dtd internet explorer 3.0 tables//","-//netscape comm. corp.//dtd html//","-//netscape comm. corp.//dtd strict html//","-//o'reilly and associates//dtd html 2.0//","-//o'reilly and associates//dtd html extended 1.0//","-//o'reilly and associates//dtd html extended relaxed 1.0//","-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//","-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//","-//spyglass//dtd html 2.0 extended//","-//sq//dtd html 2.0 hotmetal + extensions//","-//sun microsystems corp.//dtd hotjava html//","-//sun microsystems corp.//dtd hotjava strict html//","-//w3c//dtd html 3 1995-03-24//","-//w3c//dtd html 3.2 draft//","-//w3c//dtd html 3.2 final//","-//w3c//dtd html 3.2//","-//w3c//dtd html 3.2s draft//","-//w3c//dtd html 4.0 frameset//","-//w3c//dtd html 4.0 transitional//","-//w3c//dtd html experimental 19960712//","-//w3c//dtd html experimental 970421//","-//w3c//dtd w3 html//","-//w3o//dtd w3 html 3.0//","-//webtechs//dtd mozilla html 2.0//","-//webtechs//dtd mozilla html//"];
  var QUIRKS_PUBLIC_ID_EXACT = ["-//w3o//dtd w3 html strict 3.0//en//","-/w3c/dtd html 4.0 transitional/en","html"];
  var QUIRKS_401_PREFIXES = ["-//w3c//dtd html 4.01 frameset//","-//w3c//dtd html 4.01 transitional//"];
  // ----------------------------------------------------- HTML: text tools
  // Text nodes are only kept when they carry non-whitespace, so element text never has to be
  // trimmed and an element's children are all elements. "Whitespace" is what the HTML tokenizer
  // treats as such: space, tab, LF, FF, CR.

  function isHtmlSpace(character) {
    return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';
  }

  function isWhitespace(text) {
    for (var i = 0; i < text.length; i++) if (!isHtmlSpace(text.charAt(i))) return false;
    return text.length > 0;
  }

  function codePoint(value) {
    if (value > 0xffff) {
      value -= 0x10000;
      return String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
    }
    if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '�';
    return String.fromCharCode(value);
  }

  // Numeric references in the C1 range are the Windows-1252 characters, as browsers read them.
  var C1_REPLACEMENT = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

  function numericReference(value) {
    if (value >= 0x80 && value <= 0x9f) return String.fromCharCode(C1_REPLACEMENT[value - 0x80]);
    return codePoint(value);
  }

  // Character references as the HTML tokenizer reads them: "&#38;", "&#x26;", "&amp;", and the
  // legacy names that are valid without a semicolon ("&amp" in text). In an attribute value a
  // legacy name is only read when not followed by "=" or an alphanumeric character.
  var NUMBER_REFERENCE = /^&#(x[0-9a-f]+|[0-9]+);?/i;
  var NAMED_REFERENCE = /^&([a-zA-Z][a-zA-Z0-9]*);?/;
  var ALPHANUMERIC = /[a-zA-Z0-9]/;

  function decodeEntities(text, inAttribute) {
    if (text.indexOf('&') < 0) return text;
    var out = '';
    var i = 0;
    while (i < text.length) {
      var at = text.indexOf('&', i);
      if (at < 0) { out += text.slice(i); break; }
      out += text.slice(i, at);
      var match = NUMBER_REFERENCE.exec(text.slice(at));
      if (match) {
        var digits = match[1];
        out += numericReference(digits.charAt(0) === 'x' || digits.charAt(0) === 'X' ? parseInt(digits.slice(1), 16) : parseInt(digits, 10));
        i = at + match[0].length;
        continue;
      }
      match = NAMED_REFERENCE.exec(text.slice(at));
      if (match) {
        // Longest name wins: "&notin;" is one reference, "&notx" is "&not" + "x",
        // "&sub;" consumes its semicolon, "&order=" is not a reference at all.
        var name = match[1];
        var used = false;
        for (var size = name.length; size >= 1 && !used; size--) {
          var head = name.slice(0, size);
          if (text.charAt(at + 1 + size) === ';' && ENTITIES[head + ';'] !== undefined) {
            out += ENTITIES[head + ';'];
            i = at + size + 2;
            used = true;
          } else if (ENTITIES[head] !== undefined) {
            // Only the legacy names are stored without a semicolon.
            var next = text.charAt(at + 1 + size);
            if (!inAttribute || !(next === '=' || ALPHANUMERIC.test(next))) { out += ENTITIES[head]; i = at + size + 1; used = true; }
            else break;
          }
        }
        if (used) continue;
      }
      out += '&';
      i = at + 1;
    }
    return out;
  }

  // ------------------------------------------------------------ HTML tokenizer
  // The states of the HTML tokenizer that shape a tree: data, RAWTEXT (style, xmp, iframe,
  // noembed, noframes, noscript, plaintext), RCDATA (title, textarea) and script data with its
  // "<!--" escaped states. Comments and declarations are dropped. The tree builder calls setRaw()
  // right after it has inserted a raw-text element, so the tokenizer never guesses from the tag
  // name. next() returns one of
  //   { t: 'start', name, attrs, selfClosing } | { t: 'end', name } | { t: 'text', text, raw }
  //   { t: 'doctype', name, publicId, systemId, correct } | { t: 'eof' }.

  var START_TAG = /^<([a-zA-Z][^\s\/>]*)/;
  var END_TAG = /^<\/([a-zA-Z][^\s\/>]*)/;
  var DOCTYPE = /^<!doctype\s+([^\s>"']+)(?:\s+(?:(public|system)\s+(?:"([^"]*)"|'([^']*)')(?:\s+(?:"([^"]*)"|'([^']*)'))?)?)?/i;

  function createTokenizer(html) {
    var length = html.length;
    var at = 0;
    var raw = null;       // tag name while the content of a raw-text element is being read

    function readAttributes(isEndTag) {
      var attrs = {};
      var selfClosing = false;
      for (;;) {
        while (at < length && isHtmlSpace(html.charAt(at))) at++;
        if (at >= length) break;
        var c = html.charAt(at);
        if (c === '>') { at++; break; }
        if (c === '/') {
          if (html.charAt(at + 1) === '>') { selfClosing = true; at += 2; break; }
          at++;
          continue;
        }
        var start = at;
        while (at < length) {
          c = html.charAt(at);
          if (isHtmlSpace(c) || c === '=' || c === '>' || c === '/') break;
          at++;
        }
        var name = isEndTag ? '' : html.slice(start, at).toLowerCase();
        var value = '';
        var look = at;
        while (look < length && isHtmlSpace(html.charAt(look))) look++;
        if (html.charAt(look) === '=') {
          at = look + 1;
          while (at < length && isHtmlSpace(html.charAt(at))) at++;
          var quote = html.charAt(at);
          if (quote === '"' || quote === "'") {
            at++;
            var close = html.indexOf(quote, at);
            if (close < 0) close = length;
            value = html.slice(at, close);
            at = Math.min(close + 1, length);
          } else {
            var stop = at;
            while (stop < length && !isHtmlSpace(html.charAt(stop)) && html.charAt(stop) !== '>') stop++;
            value = html.slice(at, stop);
            at = stop;
          }
        } else {
          at = look;
        }
        // A repeated attribute keeps its first value.
        if (name && attrs[name] === undefined) attrs[name] = decodeEntities(value, true);
      }
      return { attrs: attrs, selfClosing: selfClosing };
    }

    // "</name" followed by whitespace, "/" or ">" ends a raw-text element; -1 when there is none.
    function rawEnd(name) {
      var probe = at;
      var lower = html.toLowerCase();
      while (probe < length) {
        var lt = lower.indexOf('</' + name, probe);
        if (lt < 0) return -1;
        var tail = html.charAt(lt + name.length + 2);
        if (tail === '>' || tail === '/' || isHtmlSpace(tail)) return lt;
        probe = lt + 2;
      }
      return -1;
    }

    // Script data: "<!--" opens an escaped run, "-->" closes it, "<script" inside an escaped run
    // opens a double-escaped run in which "</script" is text again.
    function scriptEnd() {
      var state = 0;
      var probe = at;
      for (;;) {
        var lt = html.indexOf('<', probe);
        if (lt < 0) return -1;
        if (html.slice(lt, lt + 4) === '<!--') {
          if (state === 0) state = 1;
          probe = lt + 4;
        } else if (html.slice(lt, lt + 8) === '</script') {
          var c = html.charAt(lt + 8);
          if (c === '>' || c === '/' || isHtmlSpace(c)) {
            if (state === 2) { state = 1; probe = lt + 8; continue; }
            return lt;
          }
          probe = lt + 8;
        } else if (html.slice(lt, lt + 7) === '<script') {
          var d = html.charAt(lt + 7);
          if ((d === '>' || d === '/' || isHtmlSpace(d)) && state === 1) state = 2;
          probe = lt + 7;
        } else {
          probe = lt + 1;
        }
      }
    }

    function next() {
      if (raw !== null) {
        var finish = raw === 'script' ? scriptEnd() : (raw === 'plaintext' ? -1 : rawEnd(raw));
        var text = html.slice(at, finish < 0 ? length : finish);
        at = finish < 0 ? length : finish;
        var isRaw = raw !== 'title' && raw !== 'textarea';
        raw = null;
        return { t: 'text', text: text, raw: isRaw };
      }
      if (at >= length) return { t: 'eof' };
      var lt = html.indexOf('<', at);
      if (lt !== at) {
        var text = lt < 0 ? html.slice(at) : html.slice(at, lt);
        at = lt < 0 ? length : lt;
        return { t: 'text', text: text, raw: false };
      }
      var match = DOCTYPE.exec(html.slice(at, at + 512));
      if (match) {
        at += match[0].length;
        var stop = html.indexOf('>', at);
        at = stop < 0 ? length : stop + 1;
        var correct = match[2] === undefined;
        return { t: 'doctype', name: match[1].toLowerCase(), publicId: match[3] === undefined ? null : match[3].toLowerCase(),
          systemId: match[5] === undefined ? null : match[5], correct: correct };
      }
      if (html.slice(at, at + 4) === '<!--') { at = html.indexOf('-->', at + 4); at = at < 0 ? length : at + 3; return next(); }
      if (html.slice(at, at + 2) === '<!' || html.slice(at, at + 2) === '<?') {
        var close = html.indexOf('>', at);
        at = close < 0 ? length : close + 1;
        return next();
      }
      match = START_TAG.exec(html.slice(at, at + 128));
      if (match) {
        at += match[0].length;
        var parsed = readAttributes(false);
        return { t: 'start', name: match[1].toLowerCase(), attrs: parsed.attrs, selfClosing: parsed.selfClosing };
      }
      match = END_TAG.exec(html.slice(at, at + 64));
      if (match) {
        at += match[0].length;
        readAttributes(true);
        return { t: 'end', name: match[1].toLowerCase() };
      }
      at++;
      return { t: 'text', text: '<', raw: false };
    }

    return { next: next, setRaw: function (name) { raw = name; } };
  }
  // ---------------------------------------------------------- HTML tree builder
  // The insertion modes of package:html 0.15.6, the parser Kazumi evaluates its rules with (itself
  // a port of html5lib), so an element sits at the same position in this tree as it does there —
  // which is what a rule's positional selectors ("//div[2]/div[3]/ul/li") depend on. Kept: implied
  // html/head/body, void elements, optional end tags, active formatting elements and the adoption
  // agency, implied tbody and foster parenting, quirks mode, raw-text elements, foreign content.
  // Not kept: comments, doctypes (only read for quirks mode), whitespace-only text.
  //
  // A node is { tag, attrs, ns, parent, kids, elems, next, prev, text }; text nodes have the tag
  // '#text'. The document node is the parent of the <html> element, which is its kids[0].

  var SPECIAL_ELEMENTS = {
    address: 1, applet: 1, area: 1, article: 1, aside: 1, base: 1, basefont: 1, bgsound: 1, blockquote: 1, body: 1, br: 1, button: 1,
    caption: 1, center: 1, col: 1, colgroup: 1, command: 1, dd: 1, details: 1, dir: 1, div: 1, dl: 1, dt: 1, embed: 1, fieldset: 1,
    figcaption: 1, figure: 1, footer: 1, form: 1, frame: 1, frameset: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, head: 1, header: 1,
    hr: 1, html: 1, iframe: 1, img: 1, input: 1, isindex: 1, li: 1, link: 1, listing: 1, marquee: 1, meta: 1, nav: 1, noembed: 1,
    noframes: 1, noscript: 1, object: 1, ol: 1, p: 1, param: 1, plaintext: 1, pre: 1, script: 1, section: 1, select: 1, style: 1,
    table: 1, tbody: 1, td: 1, textarea: 1, tfoot: 1, th: 1, thead: 1, title: 1, tr: 1, ul: 1, wbr: 1, xmp: 1,
  };
  var SCOPING = { 'html:applet': 1, 'html:caption': 1, 'html:html': 1, 'html:marquee': 1, 'html:object': 1, 'html:table': 1, 'html:td': 1,
    'html:th': 1, 'math:mi': 1, 'math:mo': 1, 'math:mn': 1, 'math:ms': 1, 'math:mtext': 1, 'math:annotation-xml': 1,
    'svg:foreignObject': 1, 'svg:desc': 1, 'svg:title': 1 };
  var FORMAT = { a: 1, b: 1, big: 1, code: 1, em: 1, font: 1, i: 1, nobr: 1, s: 1, small: 1, strike: 1, strong: 1, tt: 1, u: 1 };
  var TABLE_MODE = { table: 1, tbody: 1, tfoot: 1, thead: 1, tr: 1 };
  var TABLE_PARTS = { caption: 1, col: 1, colgroup: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1 };
  var TABLE_BODY_CONTEXT = { tbody: 1, tfoot: 1, thead: 1, html: 1 };
  var TABLE_ROW_CONTEXT = { tr: 1, html: 1 };
  var IMPLIED_END = { dd: 1, dt: 1, li: 1, option: 1, optgroup: 1, p: 1, rp: 1, rt: 1 };
  var HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  var FOREIGN_BREAKOUT = { b: 1, big: 1, blockquote: 1, body: 1, br: 1, center: 1, code: 1, dd: 1, div: 1, dl: 1, dt: 1, em: 1, embed: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, head: 1, hr: 1, i: 1, img: 1, li: 1, listing: 1, menu: 1, meta: 1, nobr: 1, ol: 1, p: 1,
    pre: 1, ruby: 1, s: 1, small: 1, span: 1, strike: 1, strong: 1, sub: 1, sup: 1, table: 1, tt: 1, u: 1, ul: 1, var: 1 };
  var MATHML_TEXT = { mi: 1, mo: 1, mn: 1, ms: 1, mtext: 1 };
  var SVG_TAGS = { altglyph: 'altGlyph', altglyphdef: 'altGlyphDef', altglyphitem: 'altGlyphItem', animatecolor: 'animateColor',
    animatemotion: 'animateMotion', animatetransform: 'animateTransform', clippath: 'clipPath', feblend: 'feBlend',
    fecolormatrix: 'feColorMatrix', fecomponenttransfer: 'feComponentTransfer', fecomposite: 'feComposite',
    feconvolvematrix: 'feConvolveMatrix', fediffuselighting: 'feDiffuseLighting', fedisplacementmap: 'feDisplacementMap',
    fedistantlight: 'feDistantLight', feflood: 'feFlood', fefunca: 'feFuncA', fefuncb: 'feFuncB', fefuncg: 'feFuncG',
    fefuncr: 'feFuncR', fegaussianblur: 'feGaussianBlur', feimage: 'feImage', femerge: 'feMerge', femergenode: 'feMergeNode',
    femorphology: 'feMorphology', feoffset: 'feOffset', fepointlight: 'fePointLight', fespecularlighting: 'feSpecularLighting',
    fespotlight: 'feSpotLight', fetile: 'feTile', feturbulence: 'feTurbulence', foreignobject: 'foreignObject', glyphref: 'glyphRef',
    lineargradient: 'linearGradient', radialgradient: 'radialGradient', textpath: 'textPath' };
  var SVG_ATTRIBUTES = { attributename: 'attributeName', attributetype: 'attributeType', basefrequency: 'baseFrequency',
    baseprofile: 'baseProfile', calcmode: 'calcMode', clippathunits: 'clipPathUnits', diffuseconstant: 'diffuseConstant',
    edgemode: 'edgeMode', filterunits: 'filterUnits', glyphref: 'glyphRef', gradienttransform: 'gradientTransform',
    gradientunits: 'gradientUnits', kernelmatrix: 'kernelMatrix', kernelunitlength: 'kernelUnitLength', keypoints: 'keyPoints',
    keysplines: 'keySplines', keytimes: 'keyTimes', lengthadjust: 'lengthAdjust', limitingconeangle: 'limitingConeAngle',
    markerheight: 'markerHeight', markerunits: 'markerUnits', markerwidth: 'markerWidth', maskcontentunits: 'maskContentUnits',
    maskunits: 'maskUnits', numoctaves: 'numOctaves', pathlength: 'pathLength', patterncontentunits: 'patternContentUnits',
    patterntransform: 'patternTransform', patternunits: 'patternUnits', preservealpha: 'preserveAlpha',
    preserveaspectratio: 'preserveAspectRatio', specularconstant: 'specularConstant', specularexponent: 'specularExponent',
    spreadmethod: 'spreadMethod', startoffset: 'startOffset', stddeviation: 'stdDeviation', stitchtiles: 'stitchTiles',
    surfacescale: 'surfaceScale', systemlanguage: 'systemLanguage', tablevalues: 'tableValues', targetx: 'targetX',
    targety: 'targetY', textlength: 'textLength', viewbox: 'viewBox', viewtarget: 'viewTarget',
    xchannelselector: 'xChannelSelector', ychannelselector: 'yChannelSelector', zoomandpan: 'zoomAndPan' };
  var MATHML_ATTRIBUTES = { definitionurl: 'definitionURL' };

  function parseHtml(source) {
    var document = { tag: '#document', attrs: null, ns: 'html', parent: null, kids: [] };
    var open = [document];
    var mode = 'initial';
    var originalMode = null;
    var framesetOk = true;
    var quirks = false;
    var headPointer = null;
    var formPointer = null;
    var afe = [];
    var insertFromTable = false;
    var tableText = null;      // buffered characters of the "in table text" state
    var dropNewline = false;
    var tokenizer = createTokenizer(source);

    function top() { return open[open.length - 1]; }
    function create(tag, attrs, ns) { return { tag: tag, attrs: attrs || {}, ns: ns || 'html', parent: null, kids: [] }; }
    function isSpecial(node) {
      return node.ns === 'html' ? SPECIAL_ELEMENTS[node.tag] === 1 : node.ns + ':' + node.tag === 'svg:foreignObject';
    }
    function isMathmlTextIntegrationPoint(node) { return node.ns === 'math' && MATHML_TEXT[node.tag] === 1; }
    function isHtmlIntegrationPoint(node) {
      return (node.ns === 'svg' && (node.tag === 'foreignObject' || node.tag === 'desc' || node.tag === 'title'))
        || (node.ns === 'math' && node.tag === 'annotation-xml'
          && /^(?:text\/html|application\/xhtml\+xml)$/i.test(node.attrs.encoding || ''));
    }

    // ---- inserting
    function insertNode(node) {
      var kids, at;
      if (insertFromTable && TABLE_MODE[top().tag]) {
        var position = fosterPosition();
        kids = position[0].kids;
        at = kids.indexOf(position[1]);
        if (at < 0) kids.push(node); else kids.splice(at, 0, node);
        node.parent = position[0];
      } else {
        kids = top().kids;
        node.parent = top();
        kids.push(node);
      }
    }
    // A node that may not go into the current table element is put just before the last open table.
    function fosterPosition() {
      var lastTable = null;
      for (var i = open.length - 1; i > 0; i--) if (open[i].tag === 'table') { lastTable = open[i]; break; }
      if (!lastTable) return [open[1], null];
      if (lastTable.parent) return [lastTable.parent, lastTable];
      return [open[open.indexOf(lastTable) - 1], null];
    }
    function insertElement(tag, attrs, ns) {
      var node = create(tag, attrs, ns);
      insertNode(node);
      open.push(node);
      return node;
    }
    function insertVoid(tag, attrs, ns) { insertElement(tag, attrs, ns); open.pop(); }
    function insertText(text) {
      var parent, before = null, kids, at, last;
      if (insertFromTable && TABLE_MODE[top().tag]) {
        var position = fosterPosition();
        parent = position[0];
        before = position[1];
      } else {
        parent = top();
      }
      kids = parent.kids;
      if (before) {
        at = kids.indexOf(before);
        last = at > 0 ? kids[at - 1] : null;
        if (last && last.tag === '#text') last.text += text;
        else kids.splice(at, 0, { tag: '#text', text: text, parent: parent });
      } else {
        last = kids.length ? kids[kids.length - 1] : null;
        if (last && last.tag === '#text') last.text += text;
        else kids.push({ tag: '#text', text: text, parent: parent });
      }
    }
    function popUntilNamed(name) {
      for (;;) {
        if (open.length <= 1) break;
        var node = open.pop();
        if (node.tag === name) break;
      }
    }
    function popUntilNode(node) { do { var popped = open.pop(); } while (popped !== node && open.length > 1); }
    function removeFromOpen(node) { var at = open.indexOf(node); if (at >= 0) open.splice(at, 1); }
    function removeFromParent(node) {
      if (!node.parent) return;
      var kids = node.parent.kids;
      var at = kids.indexOf(node);
      if (at >= 0) kids.splice(at, 1);
    }
    function generateImpliedEndTags(except) {
      while (open.length > 1 && IMPLIED_END[top().tag] && top().tag !== except) open.pop();
    }
    function clearBefore(context) { while (open.length > 1 && !context[top().tag]) open.pop(); }

    // ---- active formatting elements
    function elementInAfe(name) {
      for (var i = afe.length - 1; i >= 0; i--) {
        if (afe[i] === null) break;
        if (afe[i].tag === name) return afe[i];
      }
      return null;
    }
    function removeFromAfe(node) { var at = afe.indexOf(node); if (at >= 0) afe.splice(at, 1); }
    function clearAfe() {
      if (!afe.length) return;
      var entry = afe.pop();
      while (afe.length && entry !== null) entry = afe.pop();
    }
    function sameFormatting(a, b) {
      var i, keys;
      if (a.tag !== b.tag || a.ns !== b.ns) return false;
      keys = Object.keys(a.attrs);
      if (keys.length !== Object.keys(b.attrs).length) return false;
      for (i = 0; i < keys.length; i++) if (b.attrs[keys[i]] !== a.attrs[keys[i]]) return false;
      return true;
    }
    function addFormatting(node) {
      var equal = 0;
      for (var i = afe.length - 1; i >= 0; i--) {
        if (afe[i] === null) break;
        if (sameFormatting(afe[i], node)) { equal++; if (equal === 3) { afe.splice(i, 1); break; } }
      }
      afe.push(node);
    }
    function reconstructAfe() {
      if (!afe.length) return;
      var i = afe.length - 1;
      var entry = afe[i];
      if (entry === null || open.indexOf(entry) >= 0) return;
      while (entry !== null && open.indexOf(entry) < 0) {
        if (i === 0) { i = -1; break; }
        i--;
        entry = afe[i];
      }
      for (;;) {
        i++;
        entry = afe[i];
        afe[i] = insertElement(entry.tag, entry.attrs, entry.ns);
        if (i === afe.length - 1) break;
      }
    }

    function inScope(target, variant) {
      for (var i = open.length - 1; i >= 1; i--) {
        var node = open[i];
        if (typeof target === 'string' ? node.tag === target : node === target) return true;
        if (variant === 'select') { if (node.tag !== 'optgroup' && node.tag !== 'option') return false; }
        else if (variant === 'table') { if (node.tag === 'html' || node.tag === 'table') return false; }
        else if (SCOPING[node.ns + ':' + node.tag] || (variant === 'button' && node.tag === 'button')
            || (variant === 'list' && (node.tag === 'ol' || node.tag === 'ul'))) return false;
      }
      return false;
    }
    function resetInsertionMode() {
      for (var i = open.length - 1; i >= 1; i--) {
        if (open[i].ns !== 'html') continue;
        switch (open[i].tag) {
          case 'select': mode = 'inSelect'; return;
          case 'td': case 'th': mode = 'inCell'; return;
          case 'tr': mode = 'inRow'; return;
          case 'tbody': case 'thead': case 'tfoot': mode = 'inTableBody'; return;
          case 'caption': mode = 'inCaption'; return;
          case 'colgroup': mode = 'inColumnGroup'; return;
          case 'table': mode = 'inTable'; return;
          case 'head': case 'body': mode = 'inBody'; return;
          case 'frameset': mode = 'inFrameset'; return;
          default: break;
        }
      }
      mode = 'inBody';
    }

    // ---- "in body": character tokens
    function bodyCharacters(text) {
      if (text === '\u0000') return;
      reconstructAfe();
      insertText(text);
      if (framesetOk && !isWhitespace(text)) framesetOk = false;
    }

    // ---- "in body": start tags
    function mergeHtmlAttrs(token) {
      var html = open[1];
      if (!html || html.tag !== 'html') return;
      var keys = Object.keys(token.attrs);
      for (var i = 0; i < keys.length; i++) if (html.attrs[keys[i]] === undefined) html.attrs[keys[i]] = token.attrs[keys[i]];
    }
    function closeP() { if (inScope('p', 'button')) endTagP(); }
    function startTagCloseP(token) { closeP(); insertElement(token.name, token.attrs); }
    function startTagForm(token) {
      if (formPointer) return;
      closeP();
      insertElement('form', token.attrs);
      formPointer = top();
    }
    function endTagP() {
      if (!inScope('p', 'button')) insertElement('p', {});    // </p> with no open <p>: an empty one is implied, then closed
      generateImpliedEndTags('p');
      popUntilNamed('p');
    }
    function openText(token) {                   // generic raw text / RCDATA element parsing
      insertElement(token.name, token.attrs);
      originalMode = mode;
      mode = 'text';
      tokenizer.setRaw(token.name);
    }
    function startTagHeading(token) {
      closeP();
      if (top().ns === 'html' && HEADINGS.indexOf(top().tag) >= 0) open.pop();
      insertElement(token.name, token.attrs);
    }
    function startTagListItem(token) {
      framesetOk = false;
      var stops = token.name === 'li' ? ['li'] : ['dt', 'dd'];
      for (var i = open.length - 1; i >= 1; i--) {
        if (stops.indexOf(open[i].tag) >= 0) { endTagListItem({ name: open[i].tag }); break; }
        if (isSpecial(open[i]) && open[i].tag !== 'address' && open[i].tag !== 'div' && open[i].tag !== 'p') break;
      }
      closeP();
      insertElement(token.name, token.attrs);
    }
    function startTagA(token) {
      var found = elementInAfe('a');
      if (found) {
        endTagFormatting('a');
        removeFromOpen(found);
        removeFromAfe(found);
      }
      reconstructAfe();
      addFormatting(insertElement('a', token.attrs));
    }
    function startTagNobr(token) {
      reconstructAfe();
      if (inScope('nobr')) { endTagFormatting('nobr'); reconstructAfe(); }
      addFormatting(insertElement('nobr', token.attrs));
    }
    function startTagSelect(token) {
      reconstructAfe();
      insertElement('select', token.attrs);
      framesetOk = false;
      mode = (mode === 'inTable' || mode === 'inCaption' || mode === 'inColumnGroup' || mode === 'inTableBody' || mode === 'inRow' || mode === 'inCell')
        ? 'inSelectInTable' : 'inSelect';
    }
    function startTagIsIndex(token) {
      if (formPointer) return;
      var action = {};
      if (token.attrs.action !== undefined) action.action = token.attrs.action;
      startTagForm({ name: 'form', attrs: action });
      startTagHr({ name: 'hr', attrs: {} });
      insertElement('label', {});
      bodyCharacters('This is a searchable index. Enter search keywords: ');
      var attrs = {};
      var keys = Object.keys(token.attrs);
      for (var i = 0; i < keys.length; i++) if (keys[i] !== 'action' && keys[i] !== 'prompt') attrs[keys[i]] = token.attrs[keys[i]];
      attrs.name = 'isindex';
      startTagInput({ name: 'input', attrs: attrs, selfClosing: token.selfClosing });
      endTagBlock({ name: 'label' });
      startTagHr({ name: 'hr', attrs: {} });
      endTagForm({ name: 'form' });
    }
    function startTagHr(token) { closeP(); insertVoid('hr', token.attrs); framesetOk = false; }
    function startTagInput(token) {
      reconstructAfe();
      insertVoid(token.name, token.attrs);
      if ((token.attrs.type || '').toLowerCase() !== 'hidden') framesetOk = false;
    }

    // The adoption agency algorithm (package:html, InBodyPhase.endTagFormatting).
    function endTagFormatting(name) {
      for (var outer = 0; outer < 8; outer++) {
        var formattingElement = elementInAfe(name);
        if (!formattingElement || (open.indexOf(formattingElement) >= 0 && !inScope(name))) return;
        if (open.indexOf(formattingElement) < 0) { removeFromAfe(formattingElement); return; }
        var afeIndex = open.indexOf(formattingElement);
        var furthestBlock = null;
        for (var i = afeIndex; i < open.length; i++) if (isSpecial(open[i])) { furthestBlock = open[i]; break; }
        if (!furthestBlock) {
          popUntilNode(formattingElement);
          removeFromAfe(formattingElement);
          return;
        }
        var commonAncestor = open[afeIndex - 1];
        var bookmark = afe.indexOf(formattingElement);
        var lastNode = furthestBlock;
        var index = open.indexOf(lastNode);
        for (var inner = 0; inner < 3; inner++) {
          index--;
          if (index < 1) break;
          var node = open[index];
          if (afe.indexOf(node) < 0) { open.splice(index, 1); continue; }
          if (node === formattingElement) break;
          if (lastNode === furthestBlock) bookmark = afe.indexOf(node) + 1;
          var clone = create(node.tag, node.attrs, node.ns);
          afe[afe.indexOf(node)] = clone;
          open[index] = clone;
          removeFromParent(lastNode);
          clone.kids.push(lastNode);
          lastNode.parent = clone;
          lastNode = clone;
        }
        removeFromParent(lastNode);
        if (commonAncestor.ns === 'html' && TABLE_MODE[commonAncestor.tag]) {
          var position = fosterPosition();
          position[0].kids.splice(position[0].kids.indexOf(position[1]), 0, lastNode);
          lastNode.parent = position[0];
        } else {
          commonAncestor.kids.push(lastNode);
          lastNode.parent = commonAncestor;
        }
        var clone = create(formattingElement.tag, formattingElement.attrs, formattingElement.ns);
        clone.kids = furthestBlock.kids;
        for (i = 0; i < clone.kids.length; i++) clone.kids[i].parent = clone;
        furthestBlock.kids = [];
        furthestBlock.kids.push(clone);
        clone.parent = furthestBlock;
        removeFromAfe(formattingElement);
        afe.splice(Math.min(bookmark, afe.length), 0, clone);
        removeFromOpen(formattingElement);
        open.splice(open.indexOf(furthestBlock) + 1, 0, clone);
      }
    }

    function bodyStart(token) {
      var name = token.name;
      switch (name) {
        case 'html': mergeHtmlAttrs(token); return null;
        case 'base': case 'basefont': case 'bgsound': case 'command': case 'link': case 'meta': case 'noframes': case 'script':
        case 'style': case 'title':
          return headStart(token);
        case 'body': {
          // a second <body>: its attributes are merged into the first one
          var body = open.length > 2 && open[2].tag === 'body' ? open[2] : null;
          if (!body) return null;
          var keys = Object.keys(token.attrs);
          for (var i = 0; i < keys.length; i++) if (body.attrs[keys[i]] === undefined) body.attrs[keys[i]] = token.attrs[keys[i]];
          framesetOk = false;
          return null;
        }
        case 'frameset':
          if (!framesetOk || open.length < 3 || open[2].tag !== 'body') return null;
          removeFromParent(open[2]);
          while (open.length > 2) open.pop();
          insertElement('frameset', token.attrs);
          mode = 'inFrameset';
          return null;
        case 'address': case 'article': case 'aside': case 'blockquote': case 'center': case 'details': case 'dir': case 'div':
        case 'dl': case 'fieldset': case 'figcaption': case 'figure': case 'footer': case 'header': case 'hgroup': case 'main':
        case 'menu': case 'nav': case 'ol': case 'p': case 'section': case 'summary': case 'ul':
          startTagCloseP(token);
          return null;
        case 'pre': case 'listing':
          closeP();
          insertElement(name, token.attrs);
          framesetOk = false;
          dropNewline = true;
          return null;
        case 'form':
          if (formPointer) return null;
          closeP();
          insertElement('form', token.attrs);
          formPointer = top();
          return null;
        case 'li': case 'dd': case 'dt': startTagListItem(token); return null;
        case 'plaintext':
          closeP();
          insertElement('plaintext', token.attrs);
          tokenizer.setRaw('plaintext');
          return null;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': startTagHeading(token); return null;
        case 'select': startTagSelect(token); return null;
        case 'button':
          if (inScope('button')) { generateImpliedEndTags(); popUntilNamed('button'); return token; }
          reconstructAfe();
          insertElement('button', token.attrs);
          framesetOk = false;
          return null;
        case 'applet': case 'marquee': case 'object':
          reconstructAfe();
          insertElement(name, token.attrs);
          afe.push(null);
          framesetOk = false;
          return null;
        case 'b': case 'big': case 'code': case 'em': case 'font': case 'i': case 's': case 'small': case 'strike': case 'strong': case 'tt': case 'u':
          reconstructAfe();
          addFormatting(insertElement(name, token.attrs));
          return null;
        case 'a': startTagA(token); return null;
        case 'nobr': startTagNobr(token); return null;
        case 'xmp': closeP(); reconstructAfe(); framesetOk = false; openText(token); return null;
        case 'iframe': framesetOk = false; openText(token); return null;
        case 'noembed': case 'noscript': openText(token); return null;
        case 'textarea':
          insertElement('textarea', token.attrs);
          framesetOk = false;
          dropNewline = true;
          tokenizer.setRaw('textarea');
          return null;
        case 'table':
          if (!quirks) closeP();
          insertElement('table', token.attrs);
          framesetOk = false;
          mode = 'inTable';
          return null;
        case 'area': case 'br': case 'embed': case 'img': case 'keygen': case 'wbr':
          reconstructAfe();
          insertVoid(name, token.attrs);
          framesetOk = false;
          return null;
        case 'param': case 'source': case 'track': insertVoid(name, token.attrs); return null;
        case 'input': {
          var saved = framesetOk;
          reconstructAfe();
          insertVoid('input', token.attrs);
          if ((token.attrs.type || '').toLowerCase() === 'hidden') framesetOk = saved;
          return null;
        }
        case 'hr': closeP(); insertVoid('hr', token.attrs); framesetOk = false; return null;
        case 'image': return bodyStart({ name: 'img', attrs: token.attrs, selfClosing: token.selfClosing });
        case 'isindex': startTagIsIndex(token); return null;
        case 'math': case 'svg':
          reconstructAfe();
          if (name === 'svg') adjustSvg(token);
          adjustMathMl(token);
          insertElement(name, token.attrs, name);
          if (token.selfClosing) open.pop();
          return null;
        case 'caption': case 'col': case 'colgroup': case 'frame': case 'head': case 'tbody': case 'td': case 'tfoot': case 'th':
        case 'thead': case 'tr':
          return null;      // misplaced: ignored
        default: reconstructAfe(); insertElement(name, token.attrs); return null;
      }
    }

    // Case adjustments of foreign tag names (xlink:href & co. keep their names: a string lookup never finds them)
    function adjustSvg(token) {
      var replacement = SVG_TAGS[token.name];
      if (replacement) token.name = replacement;
      renameAttrs(token, SVG_ATTRIBUTES);
    }
    function adjustMathMl(token) { renameAttrs(token, MATHML_ATTRIBUTES); }
    function renameAttrs(token, table) {
      var keys = Object.keys(token.attrs);
      for (var i = 0; i < keys.length; i++) {
        var adjusted = table[keys[i]];
        if (adjusted && token.attrs[adjusted] === undefined) { token.attrs[adjusted] = token.attrs[keys[i]]; delete token.attrs[keys[i]]; }
      }
    }

    function bodyEnd(token) {
      switch (token.name) {
        case 'body': if (inScope('body')) mode = 'afterBody'; return null;
        case 'html': if (!inScope('body')) return null; mode = 'afterBody'; return token;
        case 'address': case 'article': case 'aside': case 'blockquote': case 'button': case 'center': case 'details': case 'dir':
        case 'div': case 'dl': case 'fieldset': case 'figcaption': case 'figure': case 'footer': case 'header': case 'hgroup':
        case 'listing': case 'menu': case 'nav': case 'ol': case 'pre': case 'section': case 'summary': case 'ul':
          endTagBlock(token); return null;
        case 'form': endTagForm(token); return null;
        case 'p': endTagP(); return null;
        case 'dd': case 'dt': case 'li': endTagListItem(token); return null;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': endTagHeading(); return null;
        case 'a': case 'b': case 'big': case 'code': case 'em': case 'font': case 'i': case 'nobr': case 's': case 'small':
        case 'strike': case 'strong': case 'tt': case 'u':
          endTagFormatting(token.name); return null;
        case 'applet': case 'marquee': case 'object': endTagApplet(token); return null;
        case 'br': reconstructAfe(); insertVoid('br', {}); return null;
        default: endTagOther(token); return null;
      }
    }

    function endTagBlock(token) {
      if (!inScope(token.name)) return;
      generateImpliedEndTags();
      popUntilNamed(token.name);
    }
    function endTagForm() {
      var node = formPointer;
      formPointer = null;
      if (!node || !inScope(node)) return;
      generateImpliedEndTags();
      removeFromOpen(node);       // the form is taken out of the stack; what was opened inside stays open
    }
    function endTagListItem(token) {
      if (!inScope(token.name, token.name === 'li' ? 'list' : null)) return;
      generateImpliedEndTags(token.name);
      popUntilNamed(token.name);
    }
    function endTagHeading() {
      var i;
      for (i = 0; i < 6; i++) if (inScope(HEADINGS[i])) { generateImpliedEndTags(); break; }
      for (i = 0; i < 6; i++) {
        if (!inScope(HEADINGS[i])) continue;
        for (;;) {
          if (open.length <= 1) return;
          if (HEADINGS.indexOf(open.pop().tag) >= 0) return;
        }
      }
    }
    function endTagApplet(token) {
      if (!inScope(token.name)) return;
      generateImpliedEndTags();
      popUntilNamed(token.name);
      clearAfe();
    }
    function endTagOther(token) {
      for (var i = open.length - 1; i >= 1; i--) {
        if (open[i].tag === token.name) {
          generateImpliedEndTags(token.name);
          popUntilNode(open[i]);
          return;
        }
        if (isSpecial(open[i])) return;
      }
    }

    // ---- "in head" (also used for head-like tags that appear in <body> or in a table)
    function headStart(token) {
      switch (token.name) {
        case 'html': return mergeHtmlAttrs(token);
        case 'base': case 'basefont': case 'bgsound': case 'command': case 'link': case 'meta': insertVoid(token.name, token.attrs); return null;
        case 'title': case 'noframes': case 'noscript': case 'style': openText(token); return null;
        case 'script':
          insertElement('script', token.attrs);
          originalMode = mode;
          mode = 'text';
          tokenizer.setRaw('script');
          return null;
        case 'head': return null;
        default:
          if (mode === 'inHead') open.pop();      // anything else closes the <head>
          mode = 'afterHead';
          return token;
      }
    }

    function insertHtml() { insertElement('html', {}); mode = 'beforeHead'; }
    function insertHead() { insertElement('head', {}); headPointer = top(); mode = 'inHead'; }
    function insertBody(attrs) { insertElement('body', attrs || {}); mode = 'inBody'; }

    function afterHeadStart(token) {
      switch (token.name) {
        case 'html': return mergeHtmlAttrs(token);
        case 'body': insertBody(token.attrs); framesetOk = false; return null;
        case 'frameset': insertElement('frameset', token.attrs); mode = 'inFrameset'; return null;
        case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta': case 'noframes': case 'script': case 'style': case 'title':
          // handled by the "in head" rules, but the element belongs to the <head>
          open.push(headPointer);
          var again = headStart(token);
          removeFromOpen(headPointer);
          return again;
        case 'head': return null;
        default: insertBody({}); framesetOk = true; return token;
      }
    }

    // ---- table modes
    function tableStart(token) {
      var name = token.name;
      switch (name) {
        case 'html': return mergeHtmlAttrs(token);
        case 'caption':
          clearBefore({ table: 1 });
          afe.push(null);
          insertElement('caption', token.attrs);
          mode = 'inCaption';
          return null;
        case 'colgroup':
          clearBefore({ table: 1 });
          insertElement('colgroup', token.attrs);
          mode = 'inColumnGroup';
          return null;
        case 'col':
          clearBefore({ table: 1 });
          insertElement('colgroup', {});
          mode = 'inColumnGroup';
          return token;
        case 'tbody': case 'tfoot': case 'thead':
          clearBefore({ table: 1 });
          insertElement(name, token.attrs);
          mode = 'inTableBody';
          return null;
        case 'td': case 'th': case 'tr':
          clearBefore({ table: 1 });
          insertElement('tbody', {});
          mode = 'inTableBody';
          return token;
        case 'table':
          endTagTable();
          return token;
        case 'style': case 'script': return headStart(token);
        case 'input':
          if ((token.attrs.type || '').toLowerCase() === 'hidden') insertVoid('input', token.attrs);
          else tableAnythingElse(token);
          return null;
        case 'form':
          if (formPointer) return null;
          insertElement('form', token.attrs);
          formPointer = top();
          open.pop();
          return null;
        default: tableAnythingElse(token); return null;
      }
    }
    function tableAnythingElse(token) {
      insertFromTable = true;
      bodyStart(token);
      insertFromTable = false;
    }
    function endTagTable() {
      if (inScope('table', 'table')) {
        generateImpliedEndTags();
        while (top().tag !== 'table' && open.length > 1) open.pop();
        if (open.length > 1) open.pop();
        resetInsertionMode();
      }
    }
    function tableEnd(token) {
      switch (token.name) {
        case 'table': endTagTable(); return null;
        case 'body': case 'caption': case 'col': case 'colgroup': case 'html': case 'tbody': case 'td': case 'tfoot': case 'th':
        case 'thead': case 'tr': return null;
        default: tableAnythingElse(token); return null;
      }
    }

    function columnGroupStart(token) {
      if (token.name === 'html') return mergeHtmlAttrs(token);
      if (token.name === 'col') { insertVoid('col', token.attrs); return null; }
      // the <colgroup> is still open: anything else closes it and is reprocessed
      open.pop();
      mode = 'inTable';
      return token;
    }
    function columnGroupEnd(token) {
      if (token.name === 'colgroup') { open.pop(); mode = 'inTable'; return null; }
      if (token.name === 'col') return null;
      open.pop();
      mode = 'inTable';
      return token;
    }

    function tableBodyStart(token) {
      var name = token.name;
      if (name === 'html') return mergeHtmlAttrs(token);
      if (name === 'tr') { clearBefore(TABLE_BODY_CONTEXT); insertElement('tr', token.attrs); mode = 'inRow'; return null; }
      if (name === 'td' || name === 'th') { clearBefore(TABLE_BODY_CONTEXT); insertElement('tr', {}); mode = 'inRow'; return token; }
      if (name === 'caption' || name === 'col' || name === 'colgroup' || name === 'tbody' || name === 'tfoot' || name === 'thead') return endTagTableInBody(token);
      return tableStart(token);
    }
    function endTagTableInBody(token) {
      if (inScope('tbody', 'table') || inScope('thead', 'table') || inScope('tfoot', 'table')) {
        clearBefore(TABLE_BODY_CONTEXT);
        open.pop();
        mode = 'inTable';
        return token;
      }
      return null;
    }
    function tableBodyEnd(token) {
      var name = token.name;
      if (name === 'tbody' || name === 'tfoot' || name === 'thead') { endTagRowGroup(name); return null; }
      if (name === 'table') return endTagTableInBody(token);
      if (name === 'body' || name === 'caption' || name === 'col' || name === 'colgroup' || name === 'html' || name === 'td' || name === 'th' || name === 'tr') return null;
      return tableEnd(token);
    }
    function endTagRowGroup(name) {
      if (!inScope(name, 'table')) return;
      clearBefore(TABLE_BODY_CONTEXT);
      open.pop();
      mode = 'inTable';
    }

    function rowStart(token) {
      var name = token.name;
      if (name === 'html') return mergeHtmlAttrs(token);
      if (name === 'td' || name === 'th') {
        clearBefore(TABLE_ROW_CONTEXT);
        insertElement(name, token.attrs);
        afe.push(null);
        mode = 'inCell';
        return null;
      }
      if (name === 'caption' || name === 'col' || name === 'colgroup' || name === 'tbody' || name === 'tfoot' || name === 'thead' || name === 'tr') {
        var ignore = !endTagTr();
        return ignore ? null : token;
      }
      return tableStart(token);
    }
    function rowEnd(token) {
      var name = token.name;
      if (name === 'tr') { endTagTr(); return null; }
      if (name === 'table') return endTagTr() ? token : null;
      if (name === 'tbody' || name === 'tfoot' || name === 'thead') {
        if (!inScope(name, 'table')) return null;
        endTagTr();
        return token;
      }
      if (name === 'body' || name === 'caption' || name === 'col' || name === 'colgroup' || name === 'html' || name === 'td' || name === 'th') return null;
      return tableEnd(token);
    }
    function endTagTr() {
      if (!inScope('tr', 'table')) return false;
      clearBefore(TABLE_ROW_CONTEXT);
      open.pop();
      mode = 'inTableBody';
      return true;
    }

    function cellStart(token) {
      if (token.name === 'html') return mergeHtmlAttrs(token);
      if (TABLE_PARTS[token.name]) {
        if (inScope('td', 'table') || inScope('th', 'table')) { closeCell(); return token; }
        return null;
      }
      return bodyStart(token);
    }
    function cellEnd(token) {
      var name = token.name;
      if (name === 'td' || name === 'th') { endTagTableCell(name); return null; }
      if (name === 'table' || name === 'tbody' || name === 'tfoot' || name === 'thead' || name === 'tr') {
        if (inScope('td', 'table') || inScope('th', 'table')) { closeCell(); return token; }
        return null;
      }
      if (name === 'body' || name === 'caption' || name === 'col' || name === 'colgroup' || name === 'html') return null;
      return bodyEnd(token);
    }
    function endTagTableCell(name) {
      if (!inScope(name, 'table')) return;
      generateImpliedEndTags(name);
      if (top().tag !== name) popUntilNamed(name); else open.pop();
      clearAfe();
      mode = 'inRow';
    }
    function closeCell() {
      if (inScope('td', 'table')) endTagTableCell('td');
      else if (inScope('th', 'table')) endTagTableCell('th');
    }

    function captionStart(token) {
      if (token.name === 'html') return mergeHtmlAttrs(token);
      if (TABLE_PARTS[token.name]) {
        var ignore = !inScope('caption', 'table');
        endTagCaption();
        return ignore ? null : token;
      }
      return bodyStart(token);
    }
    function captionEnd(token) {
      var name = token.name;
      if (name === 'caption') { endTagCaption(); return null; }
      if (name === 'table') { return endTagCaption() ? token : null; }
      if (name === 'body' || name === 'col' || name === 'colgroup' || name === 'html' || name === 'tbody' || name === 'td' || name === 'tfoot'
          || name === 'th' || name === 'thead' || name === 'tr') return null;
      return bodyEnd(token);
    }
    function endTagCaption() {
      if (!inScope('caption', 'table')) return false;
      generateImpliedEndTags();
      while (top().tag !== 'caption' && open.length > 1) open.pop();
      if (open.length > 1) open.pop();
      clearAfe();
      mode = 'inTable';
      return true;
    }

    function selectStart(token) {
      var name = token.name;
      switch (name) {
        case 'html': return mergeHtmlAttrs(token);
        case 'option':
          if (top().tag === 'option') open.pop();
          insertElement('option', token.attrs);
          return null;
        case 'optgroup':
          if (top().tag === 'option') open.pop();
          if (top().tag === 'optgroup') open.pop();
          insertElement('optgroup', token.attrs);
          return null;
        case 'select': endSelect(); return null;
        case 'input': case 'keygen': case 'textarea':
          if (inScope('select', 'select')) { endSelect(); return token; }
          return null;
        case 'script': case 'template': return headStart(token);
        case 'caption': case 'table': case 'tbody': case 'tfoot': case 'thead': case 'tr': case 'td': case 'th':
          if (mode === 'inSelectInTable') { endSelect(); return token; }
          return null;
        default: return null;
      }
    }
    function selectEnd(token) {
      var name = token.name;
      if (mode === 'inSelectInTable' && (name === 'caption' || name === 'table' || name === 'tbody' || name === 'tfoot' || name === 'thead'
          || name === 'tr' || name === 'td' || name === 'th')) {
        if (inScope(name, 'table')) { endSelect(); return token; }
        return null;
      }
      if (name === 'option') { if (top().tag === 'option') open.pop(); return null; }
      if (name === 'optgroup') {
        if (top().tag === 'option' && open.length > 1 && open[open.length - 2].tag === 'optgroup') open.pop();
        if (top().tag === 'optgroup') open.pop();
        return null;
      }
      if (name === 'select') endSelect();
      return null;
    }
    function endSelect() {
      if (!inScope('select', 'select')) return false;
      popUntilNamed('select');
      resetInsertionMode();
      return true;
    }

    function framesetStart(token) {
      switch (token.name) {
        case 'html': return mergeHtmlAttrs(token);
        case 'frameset': insertElement('frameset', token.attrs); return null;
        case 'frame': insertVoid('frame', token.attrs); return null;
        case 'noframes': return bodyStart(token);
        default: return null;
      }
    }
    function framesetEnd(token) {
      if (token.name !== 'frameset') return null;
      if (top().tag === 'html') return null;
      open.pop();
      if (top().tag !== 'frameset') mode = 'afterFrameset';
      return null;
    }

    // ---- foreign content (SVG, MathML): used while the current node is not an HTML element
    function useForeignRules(token) {
      var node = top();
      if (node.ns === 'html') return false;
      if (isMathmlTextIntegrationPoint(node)) {
        if (token.t === 'start' && token.name !== 'mglyph' && token.name !== 'malignmark') return false;
        if (token.t === 'text') return false;
      }
      if (node.tag === 'annotation-xml' && token.t === 'start' && token.name === 'svg') return false;
      if (isHtmlIntegrationPoint(node)) return false;
      return true;
    }
    function foreignToken(token) {
      if (token.t === 'text') { if (isWhitespace(token.text)) return null; insertText(token.text); return null; }
      if (token.t === 'end') {
        for (var i = open.length - 1; i >= 1; i--) {
          if (open[i].ns !== 'html') {
            if (open[i].tag === token.name) { popUntilNode(open[i]); return null; }
            continue;
          }
          return endTag(token);       // an HTML element is reached: its rules decide
        }
        return null;
      }
      var name = token.name;
      if (FOREIGN_BREAKOUT[name] || (name === 'font' && (token.attrs.color !== undefined || token.attrs.face !== undefined || token.attrs.size !== undefined))) {
        while (top().ns !== 'html' && !isHtmlIntegrationPoint(top()) && !isMathmlTextIntegrationPoint(top())) open.pop();
        return token;
      }
      var ns = top().ns;
      if (ns === 'svg') adjustSvg(token);
      else adjustMathMl(token);
      insertElement(token.name, token.attrs, ns);
      if (token.selfClosing) open.pop();
      return null;
    }

    // ---- characters. Returns true when the token has to be processed again after a mode change.
    function characters(text) {
      switch (mode) {
        case 'initial': quirks = true; mode = 'beforeHtml'; return true;
        case 'beforeHtml': insertHtml(); return true;
        case 'beforeHead': insertHead(); return true;
        case 'inHead': open.pop(); mode = 'afterHead'; return true;
        case 'afterHead': insertBody({}); framesetOk = true; return true;
        case 'inBody': bodyCharacters(text); return false;
        case 'inTable': case 'inTableBody': case 'inRow': startTableText(text); return false;
        case 'inColumnGroup': open.pop(); mode = 'inTable'; return true;
        case 'inCaption': case 'inCell': bodyCharacters(text); return false;
        case 'inSelect': case 'inSelectInTable': insertText(text); return false;
        case 'afterBody': case 'afterAfterBody': mode = 'inBody'; return true;
        default: return false;
      }
    }
    // Whitespace-only text is not kept; only the formatting elements it would reconstruct remain.
    function whitespace() {
      if (mode === 'inBody' || mode === 'inCaption' || mode === 'inCell' || mode === 'afterAfterBody') reconstructAfe();
      return null;
    }
    function startTableText(text) {
      if (!tableText) tableText = { data: '', mode: mode };
      tableText.data += text;
    }
    function flushTableText() {
      var buffered = tableText;
      tableText = null;
      if (!buffered || !buffered.data) return;
      mode = buffered.mode;
      if (isWhitespace(buffered.data)) return;
      insertFromTable = true;
      bodyCharacters(buffered.data);
      insertFromTable = false;
    }

    // ---- doctype
    function isQuirksDoctype(token) {
      if (!token.correct || token.name !== 'html') return true;
      var publicId = token.publicId || '';
      var i;
      for (i = 0; i < QUIRKS_PUBLIC_ID_PREFIXES.length; i++) if (publicId.indexOf(QUIRKS_PUBLIC_ID_PREFIXES[i]) === 0) return true;
      for (i = 0; i < QUIRKS_PUBLIC_ID_EXACT.length; i++) if (publicId === QUIRKS_PUBLIC_ID_EXACT[i]) return true;
      if (token.systemId === null) {
        for (i = 0; i < QUIRKS_401_PREFIXES.length; i++) if (publicId.indexOf(QUIRKS_401_PREFIXES[i]) === 0) return true;
      }
      return token.systemId !== null && token.systemId.toLowerCase() === 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd';
    }

    // ---- one token by insertion mode
    function startTag(token) {
      switch (mode) {
        case 'initial': quirks = true; mode = 'beforeHtml'; return token;
        case 'beforeHtml': insertHtml(); return token;
        case 'beforeHead': insertHead(); return token;
        case 'inHead': return headStart(token);
        case 'afterHead': return afterHeadStart(token);
        case 'inBody': return bodyStart(token);
        case 'inTable': return tableStart(token);
        case 'inCaption': return captionStart(token);
        case 'inColumnGroup': return columnGroupStart(token);
        case 'inTableBody': return tableBodyStart(token);
        case 'inRow': return rowStart(token);
        case 'inCell': return cellStart(token);
        case 'inSelect': case 'inSelectInTable': return selectStart(token);
        case 'inFrameset': return framesetStart(token);
        case 'afterFrameset':
          if (token.name === 'noframes') return bodyStart(token);
          return null;
        case 'afterBody': case 'afterAfterBody':
          if (token.name === 'html') return mergeHtmlAttrs(token);
          mode = 'inBody';
          return token;
        default: return null;      // "in table text" never sees a tag: its buffer is flushed first
      }
    }
    function endTag(token) {
      var name = token.name;
      var implied = name === 'head' || name === 'body' || name === 'html' || name === 'br';
      switch (mode) {
        case 'initial': quirks = true; mode = 'beforeHtml'; return token;
        case 'beforeHtml': if (implied) { insertHtml(); return token; } return null;
        case 'beforeHead': if (implied) { insertHead(); return token; } return null;
        case 'inHead':
          if (name === 'head') { open.pop(); mode = 'afterHead'; return null; }
          if (implied) { open.pop(); mode = 'afterHead'; return token; }
          return null;
        case 'afterHead':
          if (implied) { insertBody({}); framesetOk = true; return token; }
          return null;
        case 'inBody': return bodyEnd(token);
        case 'inTable': return tableEnd(token);
        case 'inCaption': return captionEnd(token);
        case 'inColumnGroup': return columnGroupEnd(token);
        case 'inTableBody': return tableBodyEnd(token);
        case 'inRow': return rowEnd(token);
        case 'inCell': return cellEnd(token);
        case 'inSelect': case 'inSelectInTable': return selectEnd(token);
        case 'inFrameset': framesetEnd(token); return null;
        case 'afterFrameset': if (name === 'html') mode = 'afterAfterFrameset'; return null;
        case 'afterBody':
          if (name === 'html') { mode = 'afterAfterBody'; return null; }
          mode = 'inBody';
          return token;
        case 'afterAfterBody': return bodyEnd(token);
        default: return null;
      }
    }

    // ---- one token; returns the token when it has to be processed again after a mode change
    function process(token) {
      if (tableText && token.t !== 'text') flushTableText();
      if (mode === 'text') {
        // Only the content, the matching end tag or EOF reach the tree builder in this mode.
        if (token.t === 'text') { insertText(token.raw ? token.text : decodeEntities(token.text, false)); return null; }
        open.pop();
        mode = originalMode;
        return null;
      }
      if (token.t === 'doctype') { if (mode === 'initial') quirks = isQuirksDoctype(token); return null; }
      if (token.t === 'text') {
        var text = token.raw ? token.text : decodeEntities(token.text, false);
        // RCDATA content of a <textarea>: its phase stays "in body" in package:html.
        if (token.raw) { bodyCharacters(text); return null; }
        if (isWhitespace(text)) return whitespace();
        return characters(text) ? token : null;
      }
      if (token.t === 'start' || token.t === 'end') {
        if (top().ns !== 'html' && useForeignRules(token)) return foreignToken(token);
      }
      return token.t === 'start' ? startTag(token) : endTag(token);
    }

    var token = tokenizer.next();
    var guard = 0;
    while (token.t !== 'eof') {
      var again = process(token);
      if (again) {
        token = again;
        if (++guard > 1000) throw fail('UPSTREAM_CHANGED', 'HTML 结构无法收敛');
      } else {
        token = tokenizer.next();
        guard = 0;
      }
    }
    if (tableText) flushTableText();
    finishStructure();
    return finishDocument(document);

    // "stop parsing": whatever was cut off, the document has its html, head and body.
    function finishStructure() {
      var end = mode === 'text' ? originalMode : mode;
      if (!open[1] || open[1].tag !== 'html') { insertHtml(); end = 'beforeHead'; }
      if (end === 'beforeHead') insertHead();
      if (end === 'beforeHead' || end === 'inHead') { popUntilNamed('head'); end = 'afterHead'; }
      if (end === 'afterHead') insertBody({});
    }
  }

  // Element children, sibling links and text, computed once the tree is complete.
  function finishDocument(document) {
    (function walk(node) {
      var elems = [];
      var text = '';
      for (var i = 0; i < node.kids.length; i++) {
        var kid = node.kids[i];
        if (kid.tag === '#text') { text += kid.text; continue; }
        elems.push(kid);
        text += walk(kid);
      }
      for (i = 0; i < elems.length; i++) { elems[i].prev = i > 0 ? elems[i - 1] : null; elems[i].next = i < elems.length - 1 ? elems[i + 1] : null; }
      node.elems = elems;
      node.text = text;
      return text;
    })(document);
    return document;
  }

  // ------------------------------------------------------- XPath: the dialect the rules are written in
  // NOT standard XPath. Kazumi evaluates its rules with package:xpath_selector 3.0.2
  // (lib/src/parser.dart, execute.dart, reg.dart, utils/op.dart), whose behaviour differs from
  // XPath 1.0 in ways the active rules depend on, so this is a line-by-line port of it:
  //   * a path is split on "|", then cut into steps by one regex; anything the regex cannot
  //     match is dropped in silence (the leading "." of ".//a", the whole of "//" and ".");
  //   * "//tag" is relative to the context node, and a single "/" is a step from the context
  //     node too (never from the document root);
  //   * "tag[2]" is the 2nd <tag> CHILD of each node, position counted after the name test;
  //   * predicates: [N], [last()], [last()-N], [position()<N], [@a='v'] with the CSS-like
  //     operators = != ~= *= ^= $=, text()='v', [child>1], and contains()/starts-with()/
  //     ends-with(); several predicates apply in sequence, " and "/" or " inside one;
  //   * axes: child (default), self, parent, ancestor, ancestor-or-self, descendant,
  //     descendant-or-self, following, following-sibling, preceding-sibling, attribute;
  //   * "text()" as a step keeps the matched elements themselves and reads their text;
  //   * children and siblings are elements only (text nodes are not in the tree).
  // An expression this does not understand throws, as the package does; the rule is then
  // reported as failed instead of returning a wrong selection.

  var XP_GROUP = /\/{0,2}@?[\w\*-]+:{0,2}[\*\w]*(?:\[.+?\])*(?:\(\))?/g;
  var XP_PREDICATE = /\[(.+?)\]/g;
  var XP_INT = /^\d+$/;
  var XP_LAST = /last\(\s*\)/;
  var XP_SINGLE_LAST = /last\(\s*\)/;
  var XP_SIMPLE_LAST = /last\(\s*\)\s*([+\-*]|\/%\^)\s*(\d+)/;
  var XP_SIMPLE_POSITION = /position\(\s*\)\s*(<=|>=|<|>)\s*(\d+)/g;
  var XP_CHILD = /(\w+)\s*(<=|>=|<|>)\s*(\d+)/g;
  var XP_EQUAL = /(not)?\s*\(?\s*(@?[\w-]+\(?\s*\)?)\s*(\|=|\$=|\^=|\*=|~=|!=|=)\s*(['"])(.+?)['"]\)?/g;
  var XP_FUNCTION = /(not)?\s*\(?\s*([\w-]{4,})\s*\(\s*(.+?)\s*,\s*(['"])(.+?)\s*['"]\s*\)?\)?/g;
  var XP_AXES = {
    ancestor: 1, 'ancestor-or-self': 1, child: 1, descendant: 1, 'descendant-or-self': 1, following: 1,
    'following-sibling': 1, parent: 1, 'preceding-sibling': 1, self: 1, attribute: 1,
  };

  function xpError(message) { throw fail('XPATH', message); }

  function xpIsElement(node) { return node.tag.charAt(0) !== '#'; }

  function xpElementFunction(node, name) {
    if (name.charAt(0) === '@') {
      var value = node.attrs[name.slice(1)];
      return value === undefined ? null : value;
    }
    switch (name) {
      case 'text()': case 'string()': return node.text;
      case 'name()': case 'qualified()': case 'local-name()': return node.tag;
      case 'namespace()': case 'prefix()': return '';
      default: xpError('Unsupported function: ' + name);
    }
  }

  function xpParseSimple(type, source) {
    var base = { type: type, axis: 'self', nodeTest: '*', predicate: [], attr: null, func: null };
    if (source.charAt(0) === '@') { base.attr = source.slice(1); return base; }
    if (source === '..') { base.axis = 'parent'; return base; }
    if (source === '.') return base;
    if (source === 'node()') { base.axis = 'child'; base.nodeTest = 'node()'; return base; }
    if (/^\w*\(\s*\)$/.test(source)) { base.func = source; return base; }
    return null;
  }

  function xpParseSelector(input) {
    var type, source;
    if (input.indexOf('//') === 0) { type = 'desc'; source = input.slice(2); }
    else if (input.charAt(0) === '/') { type = 'self'; source = input.slice(1); }
    else xpError("'" + input + "' is not a valid xpath query string");

    var simple = xpParseSimple(type, source);
    if (simple) return simple;

    var axis = null;
    var withoutAxis = source;
    if (source.indexOf('::') >= 0) {
      var pattern = source.split('::');
      if (pattern.length > 2) throw fail('XPATH', 'Not support multiple axis');
      axis = pattern[0].trim();
      if (!XP_AXES[axis]) throw fail('XPATH', 'not support axis: ' + axis);
      withoutAxis = pattern[pattern.length - 1].trim();
    }
    var predicates = [];
    var nodeTest = withoutAxis.replace(XP_PREDICATE, function (whole, inner) { predicates.push(inner); return ''; });
    if (nodeTest === '.') { axis = 'self'; nodeTest = '*'; }
    else if (nodeTest === '..') { axis = 'parent'; nodeTest = '*'; }
    return { type: type, axis: axis, nodeTest: nodeTest, predicate: predicates, attr: null, func: null };
  }

  function xpTop(node) { while (node.parent) node = node.parent; return node; }

  function xpFollowing(root, node) {
    var result = [];
    var found = false;
    (function dfs(parent) {
      var kids = parent.elems || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child === node) found = true;
        if (found) result.push(child);
        dfs(child);
      }
    })(root);
    return result;
  }

  function xpAxisNodes(selector, node) {
    var result = [];
    var i, current;
    switch (selector.axis) {
      case null: case 'child':
        result = (node.elems || []).slice();
        break;
      case 'ancestor':
        for (current = node.parent; current; current = current.parent) if (xpIsElement(current)) result.push(current);
        break;
      case 'ancestor-or-self':
        result.push(node);
        for (current = node.parent; current; current = current.parent) if (xpIsElement(current)) result.push(current);
        break;
      case 'descendant':
        (function walk(parent) { var kids = parent.elems || []; for (var k = 0; k < kids.length; k++) { result.push(kids[k]); walk(kids[k]); } })(node);
        break;
      case 'descendant-or-self':
        (function walk(parent) { result.push(parent); var kids = parent.elems || []; for (var k = 0; k < kids.length; k++) walk(kids[k]); })(node);
        break;
      case 'following':
        result = xpFollowing(xpTop(node), node);
        break;
      case 'parent':
        if (node.parent) result.push(node.parent);
        break;
      case 'following-sibling':
        for (current = node.next; current; current = current.next) result.push(current);
        break;
      case 'preceding-sibling':
        for (current = node.prev; current; current = current.prev) result.push(current);
        break;
      case 'attribute': case 'self':
        result.push(node);
        break;
      default:
        throw fail('XPATH', 'not support axis: ' + selector.axis);
    }
    return result;
  }

  function xpMatchNodeTest(selector, element) {
    if (selector.attr !== null) return true;
    if (selector.axis === 'attribute') return true;
    var nodeTest = selector.nodeTest;
    if (nodeTest !== 'node()') {
      if (!xpIsElement(element)) return false;
      if (nodeTest !== '*' && element.tag !== nodeTest) return false;
    }
    return true;
  }

  function xpOpNum(a, b, op) {
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return Math.floor(a / b);
    if (op === '%') return a % b;
    throw 'Unknown operator: ' + op;
  }

  function xpOpCompare(a, b, op) {
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '==' || op === '=') return a === b;
    if (op === '!=') return a !== b;
    throw 'Unknown operator: ' + op;
  }

  function xpOpString(attr, value, op) {
    if (op === '=') return attr === value;
    if (op === '!=') return attr !== value;
    if (op === '~=') return attr.split(' ').indexOf(value) >= 0;
    if (op === '*=') return attr.indexOf(value) >= 0;
    if (op === '^=') return attr.slice(0, value.length) === value;
    if (op === '$=') return value === '' || attr.slice(-value.length) === value;
    throw 'Unknown operator: ' + op;
  }

  function xpPositionMatch(position, match) {
    if (!match) return null;
    return xpOpCompare(position + 1, parseInt(match[2], 10) || 0, match[1]);
  }

  function xpEqualMatch(node, match) {
    if (!match) return null;
    var left = xpElementFunction(node, match[2].replace(/ /g, ''));
    if (left === null) return false;
    var same = xpOpString(left, match[5], match[3]);
    return match[1] ? !same : same;
  }

  function xpChildMatch(node, match) {
    if (!match) return null;
    var kids = node.elems || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tag === match[1]) {
        if (!/^\s*[+-]?\d+\s*$/.test(kids[i].text)) continue;   // int.tryParse: the whole text or nothing
        return xpOpCompare(parseInt(kids[i].text, 10), parseInt(match[3], 10) || 0, match[2]);
      }
    }
    return false;
  }

  function xpFunctionMatch(node, match) {
    if (!match) return null;
    var name = match[2].toLowerCase();
    var left = xpElementFunction(node, match[3].toLowerCase().trim());
    if (left === null) return false;
    var param = match[5];
    var hit;
    if (name === 'contains') hit = left.indexOf(param) >= 0;
    else if (name === 'starts-with') hit = left.slice(0, param.length) === param;
    else if (name === 'ends-with') hit = param === '' || left.slice(-param.length) === param;
    else throw fail('XPATH', 'UnSupport ' + name);
    return match[1] ? !hit : hit;
  }

  function xpSinglePosition(predicate, position, length) {
    var match = XP_SIMPLE_LAST.exec(predicate);
    if (match) return xpOpNum(length, parseInt(match[2], 10) || 0, match[1]) === position + 1;
    if (XP_SINGLE_LAST.test(predicate)) return length === position + 1;
    if (XP_INT.test(predicate)) return (parseInt(predicate, 10) || 0) === position + 1;
    throw fail('XPATH', 'Unsupported predicate: ' + predicate);
  }

  // "[a='1' and b='2']": every comparison becomes true/false and what is left is evaluated.
  function xpMultipleCompare(predicate, element, position, length) {
    var expression = predicate;
    var match;
    XP_SIMPLE_POSITION.lastIndex = 0;
    while ((match = XP_SIMPLE_POSITION.exec(predicate))) {
      expression = expression.split(match[0]).join(xpPositionMatch(position, match) ? 'true' : 'false');
    }
    XP_EQUAL.lastIndex = 0;
    while ((match = XP_EQUAL.exec(predicate))) {
      expression = expression.split(match[0]).join(xpEqualMatch(element, match) ? 'true' : 'false');
    }
    XP_CHILD.lastIndex = 0;
    while ((match = XP_CHILD.exec(predicate))) {
      expression = expression.split(match[0]).join(xpChildMatch(element, match) ? 'true' : 'false');
    }
    XP_FUNCTION.lastIndex = 0;
    while ((match = XP_FUNCTION.exec(predicate))) {
      expression = expression.split(match[0]).join(xpFunctionMatch(element, match) ? 'true' : 'false');
    }
    var tokens = expression.match(/&&|\|\||!|\(|\)|true|false/g) || [];
    var at = 0;
    function atom() {
      if (tokens[at] === '!') { at++; return !atom(); }
      if (tokens[at] === '(') { at++; var inner = or(); if (tokens[at] === ')') at++; return inner; }
      if (tokens[at] === 'true') { at++; return true; }
      if (tokens[at] === 'false') { at++; return false; }
      throw fail('XPATH', 'Expression parse error, raw: ' + predicate);
    }
    function and() { var value = atom(); while (tokens[at] === '&&') { at++; var next = atom(); value = value && next; } return value; }
    function or() { var value = and(); while (tokens[at] === '||') { at++; var next = and(); value = value || next; } return value; }
    if (tokens.join('') !== expression.replace(/\s+/g, '')) throw fail('XPATH', 'Expression parse error, raw: ' + predicate);
    return or();
  }

  function xpSingleCompare(predicate, element, position) {
    var match;
    XP_SIMPLE_POSITION.lastIndex = 0;
    var result = xpPositionMatch(position, XP_SIMPLE_POSITION.exec(predicate));
    if (result !== null) return result;
    XP_EQUAL.lastIndex = 0;
    result = xpEqualMatch(element, XP_EQUAL.exec(predicate));
    if (result !== null) return result;
    XP_CHILD.lastIndex = 0;
    result = xpChildMatch(element, XP_CHILD.exec(predicate));
    if (result !== null) return result;
    XP_FUNCTION.lastIndex = 0;
    result = xpFunctionMatch(element, XP_FUNCTION.exec(predicate));
    if (result !== null) return result;
    throw fail('XPATH', 'Unsupported predicate: ' + predicate);
  }

  function xpMatchPredicate(element, position, length, predicate) {
    predicate = predicate.split(' and ').join(' && ').split(' or ').join(' || ').split(' div ').join(' / ').split(' mod ').join(' % ');
    if (predicate.indexOf(' && ') >= 0 || predicate.indexOf(' || ') >= 0) return xpMultipleCompare(predicate, element, position, length);
    if (XP_LAST.test(predicate) || XP_INT.test(predicate)) return xpSinglePosition(predicate, position, length);
    return xpSingleCompare(predicate, element, position);
  }

  function xpExecute(selectors, root) {
    var current = [root];
    for (var s = 0; s < selectors.length; s++) {
      var selector = selectors[s];
      var rootMatch = [];
      var rootSeen = new Set();
      for (var c = 0; c < current.length; c++) {
        var context = current[c];
        var path = selector.type === 'desc' ? xpAxisNodes({ axis: 'descendant-or-self' }, context) : [context];
        var selectorMatch = [];
        var selectorSeen = new Set();
        for (var p = 0; p < path.length; p++) {
          var axisNodes = xpAxisNodes(selector, path[p]);
          var kept = [];
          var i;
          for (i = 0; i < axisNodes.length; i++) if (xpMatchNodeTest(selector, axisNodes[i])) kept.push(axisNodes[i]);
          for (var q = 0; q < selector.predicate.length; q++) {
            var next = [];
            for (i = 0; i < kept.length; i++) {
              if (xpMatchPredicate(kept[i], i, kept.length, selector.predicate[q])) next.push(kept[i]);
            }
            kept = next;
          }
          for (i = 0; i < kept.length; i++) {
            if (!selectorSeen.has(kept[i])) { selectorSeen.add(kept[i]); selectorMatch.push(kept[i]); }
          }
        }
        for (p = 0; p < selectorMatch.length; p++) {
          if (!rootSeen.has(selectorMatch[p])) { rootSeen.add(selectorMatch[p]); rootMatch.push(selectorMatch[p]); }
        }
      }
      current = rootMatch;
    }
    return current;
  }

  // The equivalent of XPathResult: all nodes in document order of the union, plus the strings of a
  // trailing @attr / text() step. A blank expression is an error, as in Kazumi's rule engine.
  function xpathQuery(root, expression) {
    if (!expression || !String(expression).trim()) throw fail('XPATH', 'XPath 不能为空');
    var result = [];
    var attrs = [];
    var branches = String(expression).split('|');
    for (var b = 0; b < branches.length; b++) {
      var path = branches[b].trim();
      var tokens = [];
      var match;
      XP_GROUP.lastIndex = 0;
      while ((match = XP_GROUP.exec(path))) tokens.push(match[0].trim());
      var selectors = [];
      for (var t = 0; t < tokens.length; t++) selectors.push(xpParseSelector(tokens[t]));
      var fresh = [];
      var nodes = xpExecute(selectors, root);
      for (var n = 0; n < nodes.length; n++) if (result.indexOf(nodes[n]) < 0) { result.push(nodes[n]); fresh.push(nodes[n]); }
      if (!selectors.length) continue;
      var last = selectors[selectors.length - 1];
      for (n = 0; n < fresh.length; n++) {
        if (last.attr !== null) {
          if (last.attr === '*') attrs.push.apply(attrs, Object.keys(fresh[n].attrs));
          else attrs.push(fresh[n].attrs[last.attr]);
        } else if (last.func !== null) {
          attrs.push(xpElementFunction(fresh[n], last.func));
        } else if (last.axis === 'attribute') {
          if (last.nodeTest === '*') attrs.push.apply(attrs, Object.keys(fresh[n].attrs));
          else attrs.push(fresh[n].attrs[last.nodeTest]);
        }
      }
    }
    return { nodes: result, attrs: attrs };
  }

  function xpathFirst(root, expression) {
    var result = xpathQuery(root, expression);
    return result.nodes.length ? result.nodes[0] : null;
  }

  // ------------------------------------------------------ JSONPath (Kazumi's restricted subset)
  // Kazumi refuses any JSONPath but "$" followed by ".name" (letters, digits, _ $ -), "[*]", "[3]"
  // and "['name']" / "["name"]" (RestrictedJsonPath.validate), then reads it with package:json_path:
  // ".name" is a member of an object, "[*]" the elements of an array or the values of an object.

  var JP_NAME = /[A-Za-z0-9_$-]/;

  function jpRuleError(message) { throw fail('RULE_INVALID', message); }

  function jpBracketEnd(expression, start) {
    var quote = null;
    var escaped = false;
    for (var i = start + 1; i < expression.length; i++) {
      var ch = expression.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === ']') return i;
    }
    jpRuleError('JSONPath 缺少 ]: ' + expression);
  }

  function jpString(literal) {
    return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, function (whole, code) {
      if (code.charAt(0) === 'u') return String.fromCharCode(parseInt(code.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[code] !== undefined ? ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[code] : code;
    });
  }

  function jpParse(expression) {
    if (!expression || expression.charAt(0) !== '$') jpRuleError('JSONPath 必须以 $ 开头: ' + expression);
    var steps = [];
    var i = 1;
    while (i < expression.length) {
      var ch = expression.charAt(i);
      if (ch === '.') {
        i++;
        var start = i;
        while (i < expression.length && JP_NAME.test(expression.charAt(i))) i++;
        if (i === start) jpRuleError('不支持的 JSONPath: ' + expression);
        steps.push({ name: expression.slice(start, i) });
        continue;
      }
      if (ch === '[') {
        var end = jpBracketEnd(expression, i);
        var content = expression.slice(i + 1, end).trim();
        if (/^\d+$/.test(content)) steps.push({ index: parseInt(content, 10) });
        else if (content === '*') steps.push({ all: true });
        else if (content.length >= 2 && ((content.charAt(0) === "'" && content.charAt(content.length - 1) === "'")
            || (content.charAt(0) === '"' && content.charAt(content.length - 1) === '"'))) steps.push({ name: jpString(content) });
        else jpRuleError('不支持的 JSONPath 片段: [' + content + ']');
        i = end + 1;
        continue;
      }
      jpRuleError('不支持的 JSONPath: ' + expression);
    }
    return steps;
  }

  function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

  function jpRead(document, expression) {
    var steps = jpParse(expression);
    var nodes = [document];
    for (var s = 0; s < steps.length; s++) {
      var step = steps[s];
      var next = [];
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (step.name !== undefined) {
          if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, step.name)) next.push(node[step.name]);
        } else if (step.all) {
          if (Array.isArray(node)) next.push.apply(next, node);
          else if (isPlainObject(node)) for (var key in node) if (Object.prototype.hasOwnProperty.call(node, key)) next.push(node[key]);
        } else {
          if (Array.isArray(node)) {
            var at = step.index < 0 ? node.length + step.index : step.index;
            if (at >= 0 && at < node.length) next.push(node[at]);
          }
        }
      }
      nodes = next;
    }
    return nodes;
  }

  function jpFirst(document, expression) {
    var nodes = jpRead(document, expression);
    return nodes.length ? nodes[0] : null;
  }

  // Kazumi's _stringValue: null is "", a string is trimmed, anything else is printed.
  function stringValue(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value.trim() : String(value);
  }

  // --------------------------------------------------------------- URL tools
  // Kazumi's template rendering and episode-URL normalisation, kept byte-for-byte where it
  // matters: a keyword is encoded with Uri.encodeComponent (what encodeURIComponent does) or
  // Uri.encodeQueryComponent (the same, with "+" for a space), and the request is sent as the
  // exact string built here.

  function encodeComponent(value) {
    try { return encodeURIComponent(String(value)); }
    catch (e) { return percentEncode(String(value), false); }     // a lone surrogate: the pure-JS way
  }

  function encodeQueryComponent(value) {
    return encodeComponent(value).replace(/%20/g, '+');
  }

  function decodeComponent(value) {
    try { return decodeURIComponent(String(value).replace(/\+/g, ' ')); }
    catch (e) { return String(value); }
  }

  var TEMPLATE_VARIABLE = /(^|[^A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)/g;

  function renderTemplate(template, variables, encode) {
    return String(template).replace(TEMPLATE_VARIABLE, function (whole, before, name) {
      if (!Object.prototype.hasOwnProperty.call(variables, name)) throw fail('RULE_INVALID', '缺少模板变量 @' + name);
      var value = variables[name] === null || variables[name] === undefined ? '' : String(variables[name]);
      return before + (encode ? encodeComponent(value) : value);
    });
  }

  function renderValue(value, variables) {
    var exact = /^@([A-Za-z_][A-Za-z0-9_]*)$/.exec(typeof value === 'string' ? value : '');
    if (exact) {
      if (!Object.prototype.hasOwnProperty.call(variables, exact[1])) throw fail('RULE_INVALID', '缺少模板变量 @' + exact[1]);
      return variables[exact[1]];
    }
    if (typeof value === 'string') return renderTemplate(value, variables, false);
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(renderValue(value[i], variables));
      return list;
    }
    if (isPlainObject(value)) {
      var copy = {};
      var keys = Object.keys(value);
      for (i = 0; i < keys.length; i++) copy[keys[i]] = renderValue(value[keys[i]], variables);
      return copy;
    }
    return value;
  }

  function renderMap(input, variables) {
    var out = {};
    var source = isPlainObject(input) ? input : {};
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) out[renderTemplate(keys[i], variables, false)] = renderValue(source[keys[i]], variables);
    return out;
  }

  var URL_PARTS = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/[^\/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/;

  function parseUrl(url) {
    var match = URL_PARTS.exec(url);
    if (!match) return null;
    var authority = match[2] ? match[2].slice(2) : '';
    var at = authority.indexOf('@');
    var hostPart = at >= 0 ? authority.slice(at + 1) : authority;
    var portAt = hostPart.lastIndexOf(':');
    var host = portAt > 0 ? hostPart.slice(0, portAt) : hostPart;
    var port = portAt > 0 ? hostPart.slice(portAt + 1) : '';
    return {
      scheme: (match[1] || '').slice(0, -1).toLowerCase(), userinfo: at >= 0 ? authority.slice(0, at) : '', host: host.toLowerCase(), port: port,
      hasAuthority: match[2] !== undefined, path: match[3] || '', query: match[4] || '', fragment: match[5] || '',
    };
  }

  function hasHost(parts) { return !!parts && !!parts.host; }

  // RFC 3985 §5.2: removeDotSegments.
  function removeDotSegments(path) {
    var out = '';
    var rest = path;
    var guard = 0;
    while (rest && guard++ < 10000) {
      if (rest.slice(0, 3) === '../') rest = rest.slice(3);
      else if (rest.slice(0, 2) === './') rest = rest.slice(2);
      else if (rest.slice(0, 3) === '/./') rest = '/' + rest.slice(3);
      else if (rest === '/.') rest = '/';
      else if (rest.slice(0, 4) === '/../') { rest = '/' + rest.slice(4); out = out.replace(/\/[^\/]*$/, ''); }
      else if (rest === '/..') { rest = '/'; out = out.replace(/\/[^\/]*$/, ''); }
      else if (rest === '.' || rest === '..') rest = '';
      else {
        var slash = rest.charAt(0) === '/' ? rest.indexOf('/', 1) : rest.indexOf('/');
        if (slash < 0) slash = rest.length;
        out += rest.slice(0, slash);
        rest = rest.slice(slash);
      }
    }
    return out;
  }

  function resolveUrlParts(base, reference) {
    if (reference.scheme) return reference;
    var out = { scheme: base.scheme, userinfo: '', host: '', port: '', hasAuthority: reference.hasAuthority, path: '', query: '', fragment: reference.fragment };
    if (reference.hasAuthority) {
      out.userinfo = reference.userinfo; out.host = reference.host; out.port = reference.port;
      out.path = removeDotSegments(reference.path);
      out.query = reference.query;
      return out;
    }
    out.userinfo = base.userinfo; out.host = base.host; out.port = base.port; out.hasAuthority = base.hasAuthority;
    if (reference.path === '') {
      out.path = base.path;
      out.query = reference.query;
    } else {
      if (reference.path.charAt(0) === '/') out.path = removeDotSegments(reference.path);
      else {
        var lastSlash = base.path.lastIndexOf('/');
        out.path = removeDotSegments((lastSlash >= 0 ? base.path.slice(0, lastSlash + 1) : '/') + reference.path);
      }
      out.query = reference.query;
    }
    return out;
  }

  function formatUrl(parts) {
    var out = '';
    if (parts.scheme) out += parts.scheme + ':';
    if (parts.hasAuthority) {
      out += '//';
      if (parts.userinfo) out += parts.userinfo + '@';
      out += parts.host;
      if (parts.port) out += ':' + parts.port;
    }
    out += parts.path;
    if (parts.query) out += parts.query;
    if (parts.fragment) out += parts.fragment;
    return out;
  }

  // Port of normalizeEpisodeUrl: absolute already, or resolved against the rule's baseURL; the
  // scheme of a same-host URL follows the baseURL; trailing slashes and an empty query are dropped.
  function normalizeEpisodeUrl(baseUrl, raw) {
    var trimmed = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!trimmed) return '';
    var base = parseUrl(String(baseUrl === null || baseUrl === undefined ? '' : baseUrl).trim());
    var validBase = !!base && !!base.scheme && hasHost(base);
    var ref = parseUrl(trimmed);
    var resolved = null;
    if (ref && ref.scheme && hasHost(ref)) resolved = ref;
    else if (validBase && ref) resolved = resolveUrlParts(base, ref);

    if (!resolved || !hasHost(resolved)) return trimmed;
    var baseIsHttp = validBase && (base.scheme === 'http' || base.scheme === 'https');
    var resolvedIsHttp = resolved.scheme === 'http' || resolved.scheme === 'https';
    // "resolved.hasPort == base.hasPort and the same port when written": defaults are not inferred.
    if (baseIsHttp && resolvedIsHttp && resolved.scheme !== base.scheme && resolved.host === base.host && base.port === resolved.port) {
      resolved.scheme = base.scheme;
    }
    var path = resolved.path;
    while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
    var query = resolved.query === '?' ? '' : resolved.query;
    var fragment = resolved.fragment === '#' ? '' : resolved.fragment;
    return formatUrl({ scheme: resolved.scheme, userinfo: resolved.userinfo, host: resolved.host, port: resolved.port, hasAuthority: resolved.hasAuthority, path: path, query: query, fragment: fragment });
  }

  function isHttpUrl(url) { return /^https?:\/\/[^\s\/?#]+/i.test(url); }

  // The plain base64 of the MacCMS player config, and JS unescape() ("%uXXXX" and "%XX"), in
  // pure JS: the engine's atob/unescape are not relied on.
  var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var BASE64_VALUES = {};
  for (var b64 = 0; b64 < BASE64_ALPHABET.length; b64++) BASE64_VALUES[BASE64_ALPHABET.charAt(b64)] = b64;

  function base64Decode(text) {
    // Padding is optional; a group of 1 character or an alien character means "not base64".
    var clean = String(text).replace(/\s+/g, '').replace(/=+$/, '');
    if (clean.length < 8 || clean.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(clean)) return '';
    if (!/^[A-Za-z0-9+\/]+$/.test(clean)) return '';
    var out = '';
    for (var i = 0; i < clean.length; i += 4) {
      var group = clean.slice(i, i + 4);
      var a = BASE64_VALUES[group.charAt(0)], b = BASE64_VALUES[group.charAt(1)];
      var c = BASE64_VALUES[group.charAt(2)], d = BASE64_VALUES[group.charAt(3)];
      out += String.fromCharCode((a << 2) | (b >> 4));
      if (c !== undefined) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
      if (d !== undefined) out += String.fromCharCode(((c & 3) << 6) | d);
    }
    return out;
  }

  // A base64 blob that sits inside a longer token ("...<base64>index.mp4"): the longest prefix that
  // decodes to text is returned, or "" when none does.
  function unescapeJs(text) {
    var value = String(text);
    if (value.indexOf('%') < 0) return value;
    return value.replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, function (whole, four, two) {
      return String.fromCharCode(parseInt(four || two, 16));
    });
  }

  function printable(text) {
    // a decoded value that is not text (a key, a binary blob) must never pass for a URL
    for (var i = 0; i < text.length; i++) { var code = text.charCodeAt(i); if (code < 32 && code !== 9) return false; }
    return true;
  }

  // ------------------------------------------------------ rule model and rule engine
  // What a rule file may describe, read the way Kazumi's Plugin.fromJson / ApiRuleConfig.fromJson read
  // it (lib/plugins/plugins.dart, lib/plugins/api_rule_config.dart), and the two strategies that
  // execute it (lib/services/plugin/xpath_rule_strategy.dart, api_rule_strategy.dart), ported so a rule
  // selects here what it selects in Kazumi. A rule is data: its XPaths, JSONPaths, URLs, separators
  // and request templates are read, never evaluated as code.

  function parseRequest(raw) {
    var source = isPlainObject(raw) ? raw : {};
    return {
      method: String(source.method === undefined ? 'GET' : source.method).toUpperCase(),
      url: String(source.url === undefined ? '' : source.url),
      headers: asStringMap(source.headers),
      query: asStringMap(source.query),
      bodyType: source.bodyType === 'json' ? 'json' : (source.bodyType === 'form' ? 'form' : 'none'),
      body: source.body,
    };
  }

  function parseSearchApi(raw) {
    var source = isPlainObject(raw) ? raw : {};
    return {
      request: parseRequest(source.request),
      listPath: String(source.listPath === undefined ? '$.data[*]' : source.listPath),
      namePath: String(source.namePath === undefined ? '$.name' : source.namePath),
      sourcePath: String(source.sourcePath === undefined ? '$.url' : source.sourcePath),
      sourceTemplate: String(source.sourceTemplate === undefined ? '' : source.sourceTemplate).trim(),
    };
  }

  function parseChapterApi(raw) {
    var source = isPlainObject(raw) ? raw : {};
    var page = isPlainObject(source.episodePage) ? {
      url: String(source.episodePage.url === undefined ? '' : source.episodePage.url),
      query: asStringMap(source.episodePage.query),
    } : null;
    return {
      request: parseRequest(source.request),
      format: source.format === 'delimited' ? 'delimited' : 'nested',
      roadsPath: String(source.roadsPath === undefined ? '$.data.roads[*]' : source.roadsPath),
      roadNamePath: String(source.roadNamePath === undefined ? '$.name' : source.roadNamePath),
      episodesPath: String(source.episodesPath === undefined ? '$.episodes[*]' : source.episodesPath),
      episodeNamePath: String(source.episodeNamePath === undefined ? '$.name' : source.episodeNamePath),
      episodeUrlPath: String(source.episodeUrlPath === undefined ? '$.url' : source.episodeUrlPath),
      roadNamesPath: String(source.roadNamesPath === undefined ? '' : source.roadNamesPath),
      roadEpisodesPath: String(source.roadEpisodesPath === undefined ? '' : source.roadEpisodesPath),
      roadSeparator: String(source.roadSeparator === undefined ? '$$$' : source.roadSeparator),
      episodeSeparator: String(source.episodeSeparator === undefined ? '#' : source.episodeSeparator),
      fieldSeparator: String(source.fieldSeparator === undefined ? '$' : source.fieldSeparator),
      episodePage: page,
    };
  }

  function text(value, fallback) { return value === undefined || value === null ? fallback : String(value); }

  function parseRule(raw) {
    if (!isPlainObject(raw)) throw fail('RULE_INVALID', '规则文件不是 JSON 对象');
    var name = stringValue(raw.name);
    if (!name) throw fail('RULE_INVALID', '规则缺少 name');
    var anti = isPlainObject(raw.antiCrawlerConfig) ? raw.antiCrawlerConfig : {};
    return {
      name: name,
      version: text(raw.version, ''),
      api: text(raw.api, '1'),
      deprecated: raw.deprecated === true,
      muliSources: raw.muliSources === undefined ? true : !!raw.muliSources,
      usePost: !!raw.usePost,
      useLegacyParser: !!raw.useLegacyParser,
      adBlocker: !!raw.adBlocker,
      userAgent: text(raw.userAgent, ''),
      baseURL: text(raw.baseURL, ''),
      searchURL: text(raw.searchURL, ''),
      searchList: text(raw.searchList, ''),
      searchName: text(raw.searchName, ''),
      searchResult: text(raw.searchResult, ''),
      chapterRoads: text(raw.chapterRoads, ''),
      chapterResult: text(raw.chapterResult, ''),
      referer: text(raw.referer, ''),
      searchMode: raw.searchMode === 'api' ? 'api' : 'xpath',
      chapterMode: raw.chapterMode === 'api' ? 'api' : 'xpath',
      searchApiConfig: parseSearchApi(raw.searchApiConfig),
      chapterApiConfig: parseChapterApi(raw.chapterApiConfig),
      antiCrawlerEnabled: anti.enabled === true,
      captchaDetectType: anti.captchaDetectType === undefined ? 1 : Number(anti.captchaDetectType),
      captchaDetectValue: text(anti.captchaDetectValue, ''),
      captchaImage: text(anti.captchaImage, ''),
      captchaButton: text(anti.captchaButton, ''),
    };
  }

  function ruleError(rule, message) { throw fail('RULE_INVALID', rule.name + ': ' + message); }

  // ---- requests

  // { method, url, headers, query, bodyType, body } the way ApiRuleStrategy.prepareRequest builds it.
  function prepareApiRequest(config, variables, rule) {
    var method = config.method;
    if (method !== 'GET' && method !== 'POST') ruleError(rule, '仅支持 GET/POST，当前为 ' + method);
    var url = renderTemplate(config.url.trim(), variables, true);
    if (!isHttpUrl(url)) ruleError(rule, 'API 请求 URL 无效: ' + url);
    var hasBody = method === 'POST' && config.bodyType !== 'none';
    return {
      method: method,
      url: url,
      headers: renderMap(config.headers, variables),
      query: renderMap(config.query, variables),
      bodyType: config.bodyType,
      body: hasBody ? renderValue(config.body, variables) : null,
    };
  }

  function prepareXpathSearch(rule, keyword) {
    var queryUrl = String(rule.searchURL).split('@keyword').join(encodeQueryComponent(keyword));
    if (!isHttpUrl(queryUrl)) ruleError(rule, '搜索 URL 无效: ' + queryUrl);
    var cut = queryUrl.indexOf('?');
    if (!rule.usePost || cut < 0) return { method: 'GET', url: queryUrl, headers: {}, query: {}, bodyType: 'none', body: null };
    return { method: 'POST', url: queryUrl.slice(0, cut), headers: {}, query: {}, bodyType: 'form', body: formQuery(queryUrl.slice(cut + 1)) };
  }

  function formQuery(query) {
    var out = {};
    var parts = query.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf('=');
      out[decodeComponent(eq < 0 ? parts[i] : parts[i].slice(0, eq))] = decodeComponent(eq < 0 ? '' : parts[i].slice(eq + 1));
    }
    return out;
  }

  function queryArgs(map) {
    var parts = [];
    var keys = Object.keys(map || {});
    for (var i = 0; i < keys.length; i++) {
      var value = map[keys[i]];
      if (value === undefined || value === null) continue;
      parts.push(encodeQueryComponent(keys[i]) + '=' + encodeQueryComponent(value === false ? 'false' : (value === true ? 'true' : String(value))));
    }
    return parts.join('&');
  }

  // The request Kazumi's RuleEngine sends: a random desktop UA, an Accept-Language, the rule site as
  // Referer, then the rule's own headers (names lower-cased so they cannot be sent twice).
  function ruleHeaders(rule, extra) {
    var headers = {
      'User-Agent': rule.userAgent || USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': rule.baseURL + '/',
    };
    var names = Object.keys(extra || {});
    for (var i = 0; i < names.length; i++) {
      var lower = names[i].toLowerCase();
      var kept = false;
      for (var own in headers) if (own.toLowerCase() === lower) { headers[own] = String(extra[names[i]]); kept = true; break; }
      if (!kept) headers[names[i]] = String(extra[names[i]]);
    }
    return headers;
  }

  async function sendRuleRequest(prepared, rule) {
    var url = prepared.url;
    var headers = ruleHeaders(rule, prepared.headers);
    var options = { method: prepared.method, headers: headers };
    if (prepared.method === 'GET') {
      var args = queryArgs(prepared.query);
      if (args) url += (url.indexOf('?') >= 0 ? '&' : '?') + args;
    } else if (prepared.bodyType === 'json') {
      options.body = JSON.stringify(prepared.body);
      setHeader(headers, 'content-type', 'application/json');
    } else if (prepared.bodyType === 'form') {
      options.body = queryArgs(prepared.body);
      setHeader(headers, 'content-type', 'application/x-www-form-urlencoded');
    }
    if (Date.now() > run.deadline) throw timeout('请求 ' + rule.name);
    var result = await rawFetch(url, options);
    if (looksTruncated(result.body)) throw fail('UPSTREAM_CHANGED', rule.name + ': 响应超过宿主单次抓取上限');
    return result;
  }

  function setHeader(headers, name, value) {
    for (var own in headers) if (own.toLowerCase() === name) { headers[own] = value; return; }
    headers[name] = value;
  }

  function ruleHttpResponse(result, rule, what) {
    if (result.status === 0) throw fail('NETWORK', rule.name + ' ' + what + '无法连接（' + result.statusText + '）');
    if (result.status === 403 || result.status === 429 || result.status === 503) {
      var page = result.body.toLowerCase();
      if (result.status === 403 && page.indexOf('captcha') >= 0 && rule.antiCrawlerEnabled) throw fail('CAPTCHA', rule.name + ' ' + what + '要求人机验证');
      if (page.indexOf('attention required') >= 0 && page.indexOf('cloudflare') >= 0) throw fail('BLOCKED', rule.name + ' ' + what + '被 Cloudflare 拦截（403）');
      throw fail('UPSTREAM_ERROR', rule.name + ' ' + what + '返回 ' + result.status);
    }
    if (result.status === 404) throw fail('NOT_FOUND', rule.name + ' ' + what + '返回 404');
    if (!result.ok) throw fail('UPSTREAM_ERROR', rule.name + ' ' + what + '返回 ' + result.status);
    return result.body;
  }

  // ---- search

  function parseApiSearch(raw, rule) {
    var config = rule.searchApiConfig;
    var document;
    try { document = JSON.parse(raw); } catch (e) { throw fail('UPSTREAM_CHANGED', rule.name + ': API 响应不是有效 JSON'); }
    var nodes = jpRead(document, config.listPath);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var name = stringValue(jpFirst(nodes[i], config.namePath));
      var source = stringValue(jpFirst(nodes[i], config.sourcePath));
      if (!name || !source) continue;
      // Plain replacement, so "@source" may follow a letter ("/GV@source").
      var src = config.sourceTemplate ? config.sourceTemplate.split('@source').join(encodeComponent(source)) : source;
      items.push({ name: name, src: src, raw: source, year: itemYear(nodes[i]) });
    }
    return items;
  }

  // Rules name no year field, but several api responses carry one. It is read when it is there
  // (a four-digit number in an obvious field) and used only to tell seasons apart.
  var YEAR_FIELDS = ['$.vod_year', '$.year', '$.air_year', '$.release_year', '$.pub_year'];
  function itemYear(node) {
    for (var i = 0; i < YEAR_FIELDS.length; i++) {
      var value = jpFirst(node, YEAR_FIELDS[i]);
      var year = yearOf(typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : ''));
      if (year) return year;
    }
    return null;
  }

  function parseDocument(raw, rule) {
    var document;
    try { document = parseHtml(raw); } catch (e) { throw fail('UPSTREAM_CHANGED', rule.name + ': HTML 解析失败'); }
    var root = document.elems.length ? document.elems[0] : null;
    if (!root) throw fail('UPSTREAM_CHANGED', rule.name + ': HTML 响应没有根节点');
    return root;
  }

  function xpathNodes(context, expression, rule, what) {
    if (!expression || !expression.trim()) ruleError(rule, what + ' XPath 不能为空');
    try {
      return xpathQuery(context, expression).nodes;
    } catch (e) {
      if (e && e.code === 'TIMEOUT') throw e;
      throw fail('RULE_INVALID', rule.name + ': ' + what + ' XPath 无效: ' + expression + ' (' + (e && e.message ? e.message : e) + ')');
    }
  }

  // Kazumi's detectsCaptchaChallenge: only for rules with an enabled antiCrawlerConfig.
  function looksLikeCaptcha(raw, rule, root) {
    if (!rule.antiCrawlerEnabled) return false;
    var detect = rule.captchaDetectValue.trim();
    if (detect) {
      if (rule.captchaDetectType === 2) return raw.indexOf(detect) >= 0;              // CaptchaDetectType.text
      if (rule.captchaDetectType === 3) { try { return new RegExp(detect, 'is').test(raw); } catch (e) { return false; } }   // .regex
      try { return xpathNodes(root, detect, rule, '验证页检测').length > 0; } catch (e) { return false; }
    }
    var probes = [rule.captchaImage, rule.captchaButton];
    for (var i = 0; i < probes.length; i++) {
      if (!probes[i].trim()) continue;
      try { if (xpathNodes(root, probes[i], rule, '验证页检测').length) return true; } catch (e) { /* next probe */ }
    }
    return false;
  }

  function parseXpathSearch(raw, rule) {
    var root = parseDocument(raw, rule);
    if (looksLikeCaptcha(raw, rule, root)) throw fail('CAPTCHA', rule.name + ' 搜索要求人机验证');
    var nodes = xpathNodes(root, rule.searchList, rule, '搜索结果列表');
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var nameNode = xpathNodes(nodes[i], rule.searchName, rule, '条目名称')[0];
      var linkNode = xpathNodes(nodes[i], rule.searchResult, rule, '条目链接')[0];
      var name = nameNode ? String(nameNode.text || '').trim() : '';
      var source = linkNode ? String(linkNode.attrs.href === undefined ? '' : linkNode.attrs.href).trim() : '';
      if (!name || !source) continue;
      items.push({ name: name, src: source, raw: source });
    }
    return items;
  }

  // ---- chapters
  // A road is one playable "line" of an entry: page URLs, their labels, and the raw value the rule
  // read before any episodePage template was applied (a direct media URL for some api rules).

  function parseApiChapters(raw, rule, source) {
    var config = rule.chapterApiConfig;
    var document;
    try { document = JSON.parse(raw); } catch (e) { throw fail('UPSTREAM_CHANGED', rule.name + ': 剧集 API 响应不是有效 JSON'); }
    if (config.format === 'delimited') return parseDelimited(document, config, rule, source);
    return parseNested(document, config, rule, source);
  }

  function resolveEpisodeUrl(config, rule, source, rawUrl, roadIndex, episodeIndex) {
    var page = config.episodePage;
    if (!page) return normalizeEpisodeUrl(rule.baseURL, rawUrl);
    if (!page.url.trim()) ruleError(rule, '播放页地址模板不能为空');
    // The template language has no arithmetic, so 0-based and 1-based indices are both provided.
    var variables = { source: source, episodeUrl: rawUrl, roadIndex: roadIndex, roadNumber: roadIndex + 1, episodeIndex: episodeIndex, episodeNumber: episodeIndex + 1 };
    var path = renderTemplate(page.url, variables, true);
    var rendered = renderMap(page.query, variables);
    var keys = Object.keys(rendered);
    var extra = [];
    for (var i = 0; i < keys.length; i++) extra.push(encodeQueryComponent(keys[i]) + '=' + encodeQueryComponent(rendered[keys[i]]));
    var cut = path.indexOf('?');
    var query = cut >= 0 ? path.slice(cut + 1) : '';
    path = cut >= 0 ? path.slice(0, cut) : path;
    if (extra.length) query = query ? query + '&' + extra.join('&') : extra.join('&');
    if (!isHttpUrl(path)) return normalizeEpisodeUrl(rule.baseURL, path);
    return normalizeEpisodeUrl(rule.baseURL, path + (query ? '?' + query : ''));
  }

  function parseNested(document, config, rule, source) {
    var hasRoads = config.roadsPath.trim() !== '';
    var roadNodes = hasRoads ? jpRead(document, config.roadsPath) : [document];
    var roads = [];
    for (var r = 0; r < roadNodes.length; r++) {
      var roadName = hasRoads && config.roadNamePath.trim() !== '' ? stringValue(jpFirst(roadNodes[r], config.roadNamePath)) : '';
      var episodeNodes = jpRead(roadNodes[r], config.episodesPath);
      var urls = [], names = [], raws = [];
      for (var e = 0; e < episodeNodes.length; e++) {
        var label = stringValue(jpFirst(episodeNodes[e], config.episodeNamePath));
        var rawUrl = config.episodeUrlPath.trim() === '' ? '' : stringValue(jpFirst(episodeNodes[e], config.episodeUrlPath));
        var pageUrl = resolveEpisodeUrl(config, rule, source, rawUrl, r, e);
        if (!pageUrl) continue;
        urls.push(pageUrl);
        names.push(label || '第' + (e + 1) + '集');
        raws.push(rawUrl);
      }
      if (urls.length) roads.push({ name: roadName || '播放线路' + (roads.length + 1), urls: urls, names: names, raws: raws });
    }
    return roads;
  }

  function parseDelimited(document, config, rule, source) {
    var namesValue = stringValue(jpFirst(document, config.roadNamesPath));
    var episodesValue = stringValue(jpFirst(document, config.roadEpisodesPath));
    var roads = [];
    if (!episodesValue) return roads;
    var roadNames = namesValue.split(config.roadSeparator);
    var groups = episodesValue.split(config.roadSeparator);
    for (var r = 0; r < groups.length; r++) {
      var urls = [], names = [], raws = [];
      var entries = groups[r].split(config.episodeSeparator);
      for (var e = 0; e < entries.length; e++) {
        var entry = entries[e].trim();
        if (!entry) continue;
        var separator = entry.indexOf(config.fieldSeparator);
        if (separator < 0) continue;
        var label = entry.slice(0, separator).trim();
        var rawUrl = entry.slice(separator + config.fieldSeparator.length).trim();
        var pageUrl = resolveEpisodeUrl(config, rule, source, rawUrl, r, e);
        if (!pageUrl) continue;
        urls.push(pageUrl);
        names.push(label || '第' + (e + 1) + '集');
        raws.push(rawUrl);
      }
      var configured = r < roadNames.length ? roadNames[r].trim() : '';
      if (urls.length) roads.push({ name: configured || '播放线路' + (roads.length + 1), urls: urls, names: names, raws: raws });
    }
    return roads;
  }

  function parseXpathChapters(raw, rule) {
    var root = parseDocument(raw, rule);
    var roadNodes = xpathNodes(root, rule.chapterRoads, rule, '播放线路列表');
    var roads = [];
    for (var r = 0; r < roadNodes.length; r++) {
      var episodeNodes = xpathNodes(roadNodes[r], rule.chapterResult, rule, '剧集列表');
      var urls = [], names = [], raws = [];
      for (var e = 0; e < episodeNodes.length; e++) {
        var source = String(episodeNodes[e].attrs.href === undefined ? '' : episodeNodes[e].attrs.href).trim();
        if (!source) continue;
        urls.push(normalizeEpisodeUrl(rule.baseURL, source));
        names.push(String(episodeNodes[e].text || '').replace(/\s+/g, ''));
        raws.push(source);
      }
      if (urls.length) roads.push({ name: '播放线路' + (roads.length + 1), urls: urls, names: names, raws: raws });
    }
    return roads;
  }

  async function ruleSearch(rule, keyword) {
    var prepared = rule.searchMode === 'api' ? prepareApiRequest(rule.searchApiConfig.request, { keyword: keyword }, rule)
      : prepareXpathSearch(rule, keyword);
    var result = await sendRuleRequest(prepared, rule);
    var raw = ruleHttpResponse(result, rule, '搜索');
    var items;
    try {
      items = rule.searchMode === 'api' ? parseApiSearch(raw, rule) : parseXpathSearch(raw, rule);
    } catch (e) {
      if (e.code === 'CAPTCHA' || e.code === 'RULE_INVALID' || e.code === 'UPSTREAM_CHANGED') throw e;
      throw fail('UPSTREAM_CHANGED', rule.name + ': 搜索结果解析失败（' + (e && e.message ? e.message : e) + '）');
    }
    return { items: items, status: result.status, url: result.url || prepared.url };
  }

  async function ruleChapters(rule, item) {
    var prepared;
    // Kazumi hands the chapter request the search item's src (the template-applied source).
    if (rule.chapterMode === 'api') prepared = prepareApiRequest(rule.chapterApiConfig.request, { source: item.src }, rule);
    else {
      var url = normalizeEpisodeUrl(rule.baseURL, item.src);
      if (!isHttpUrl(url)) throw fail('RULE_INVALID', rule.name + ': 章节 URL 无效: ' + url);
      prepared = { method: 'GET', url: url, headers: {}, query: {}, bodyType: 'none', body: null };
    }
    var result = await sendRuleRequest(prepared, rule);
    var raw = ruleHttpResponse(result, rule, '剧集');
    var roads;
    try {
      roads = rule.chapterMode === 'api' ? parseApiChapters(raw, rule, item.src) : parseXpathChapters(raw, rule);
    } catch (e) {
      if (e.code === 'RULE_INVALID' || e.code === 'UPSTREAM_CHANGED') throw e;
      throw fail('UPSTREAM_CHANGED', rule.name + ': 剧集解析失败（' + (e && e.message ? e.message : e) + '）');
    }
    if (!roads.length) throw fail('NOT_FOUND', rule.name + ': 该条目没有剧集');
    return roads;
  }

  // -------------------------------------------------------------------- TMDB
  // The host passes only a TMDB id. Titles come from the TMDB API with the key the host injects;
  // this file embeds no key. The gathering below is kanju.js's (tmdbGet, pushTitle, tmdbTitles):
  // the localized title and the original title rank 1, the zh TW/HK/SG, en US/GB, ja JP and ko KR
  // translations rank 2, alternative titles of a few regions rank 3. Could not be exercised live
  // while this was written (no TMDB key at hand): only long-standing fields are read.

  var TMDB_API = 'https://api.themoviedb.org/3';
  var TMDB_LANGUAGES = ['zh TW', 'zh HK', 'zh SG', 'en US', 'en GB', 'en', 'ja JP', 'ko KR'];
  var TMDB_REGIONS = /^(CN|HK|TW|SG|US|GB|JP|KR)$/;

  function hostTmdbKey() {
    return typeof TMDB_API_KEY === 'string' ? TMDB_API_KEY.trim() : '';
  }

  async function tmdbGet(key, path, query) {
    var headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    var params = {};
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i++) params[keys[i]] = query[keys[i]];
    if (/^eyJ[\w-]+\.[\w-]+\./.test(key)) headers.Authorization = 'Bearer ' + key;
    else params.api_key = key;

    var result = await httpText(TMDB_API + path + '?' + formEncode(params), headers, 2);
    if (result.status === 0) throw fail('NETWORK', '无法连接 TMDB（' + result.statusText + '）');
    if (result.status === 401) throw fail('HOST_UNSUPPORTED', '宿主提供的 TMDB_API_KEY 被 TMDB 拒绝');
    if (result.status === 404) throw fail('NOT_FOUND', 'TMDB 没有这个剧集 ID');
    if (!result.ok) throw fail('UPSTREAM_ERROR', 'TMDB 请求失败（' + result.status + '）');
    var data = parseJson(result.body);
    if (!data) throw fail('UPSTREAM_CHANGED', 'TMDB 返回了无法解析的数据');
    return data;
  }

  function pushTitle(list, seen, text, rank) {
    var value = String(text || '').trim();
    if (value.length < 2 || seen[value]) return;
    seen[value] = true;
    list.push({ text: value, rank: rank, index: list.length });
  }

  function tmdbTitles(data) {
    var titles = [];
    var seen = {};
    pushTitle(titles, seen, data.name, 1);
    pushTitle(titles, seen, data.original_name, 1);

    var translations = Array.isArray(data.translations && data.translations.translations) ? data.translations.translations : [];
    for (var l = 0; l < TMDB_LANGUAGES.length; l++) {
      var want = TMDB_LANGUAGES[l].split(' ');
      for (var t = 0; t < translations.length; t++) {
        var entry = translations[t];
        if (entry.iso_639_1 !== want[0]) continue;
        if (want[1] && entry.iso_3166_1 !== want[1]) continue;
        pushTitle(titles, seen, entry.data && (entry.data.title || entry.data.name), 2);
      }
    }

    var list = data.alternative_titles && (data.alternative_titles.titles || data.alternative_titles.results);
    list = Array.isArray(list) ? list : [];
    for (var i = 0; i < list.length; i++) {
      if (!TMDB_REGIONS.test(String(list[i].iso_3166_1 || ''))) continue;
      pushTitle(titles, seen, list[i].title, 3);
    }
    return titles;
  }


  // ------------------------------------------------------------ ani.zip 映射
  // 一次请求就能把 tracker id 换成：TMDB/TVDB id、多语言片名（含 zh-Hant）、以及每集的 S/E 坐标。
  // 这比「按名字去站点猜」稳：名字来自 id，不是来自搜索；集数坐标也不用按季累加去估。
  async function anizip(kind, id) {
    var query = ANIZIP_QUERY[kind];
    if (!query || !id) return null;
    var data = null;
    try {
      data = await getJson(ANIZIP_API + '?' + query + '=' + encodeURIComponent(String(id)), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      emit('warn', 'ani.zip 不可用: ' + (error.code ? error.code + ' ' : '') + error.message);
      return null;
    }
    if (!data) return null;
    var mappings = data.mappings || {};
    var titles = data.titles || {};
    var names = [];
    for (var i = 0; i < ANIZIP_TITLE_KEYS.length; i++) names.push(titles[ANIZIP_TITLE_KEYS[i]]);
    var map = {};
    var episodes = data.episodes || {};
    for (var key in episodes) {
      if (!Object.prototype.hasOwnProperty.call(episodes, key)) continue;
      var row = episodes[key];
      if (!row || row.seasonNumber == null || row.episodeNumber == null) continue;
      map[String(Number(key))] = { season: Number(row.seasonNumber), episode: Number(row.episodeNumber) };
    }
    return {
      titles: names,
      tmdbId: mappings.themoviedb_id ? String(mappings.themoviedb_id) : '',
      tvdbId: mappings.thetvdb_id ? String(mappings.thetvdb_id) : '',
      episodeMap: map,
    };
  }

  var ANIZIP_TITLE_KEYS = ['zh-Hant', 'zh-Hans', 'zh-TW', 'zh-HK', 'ja', 'x-jat', 'en'];

  // ---------------------------------------------------- 动画 tracker 的片名
  // Nuvio 的动画条目用 kitsu:/mal:/anilist: 前三段式 ID，季/集坐标不在里面，只有绝对集号。
  // 这里按站点各家的公开 API 把 ID 换成片名；anidb 没有公开 JSON，明确报错而不是猜。
  async function getJson(url, options) {
    var result = await rawFetch(url, options || { method: 'GET', headers: {} });
    if (!result.ok) {
      throw fail(result.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR',
        url.replace(/^https:\/\//, '').split('/')[0] + ' 返回 ' + result.status);
    }
    var data = parseJson(result.body);
    if (!data) throw fail('UPSTREAM_CHANGED', url.split('/')[2] + ' 返回了无法解析的数据');
    return data;
  }

  function trackerTitles(kind, id) {
    if (kind === 'kitsu') {
      return getJson('https://kitsu.io/api/edge/anime/' + id, {
        method: 'GET',
        headers: { Accept: 'application/vnd.api+json' },
      }).then(function (body) {
        var a = body && body.data && body.data.attributes;
        if (!a) return null;
        var names = [a.canonicalTitle];
        if (a.titles) {
          names.push(a.titles.en, a.titles.en_jp, a.titles.ja_jp, a.titles.en_us);
        }
        if (Array.isArray(a.abbreviatedTitles)) names = names.concat(a.abbreviatedTitles);
        return { names: names, year: yearOf(a.startDate) };
      });
    }
    if (kind === 'anilist') {
      var query = 'query($id:Int){Media(id:$id,type:ANIME){title{romaji english native}synonyms startDate{year}}}';
      return getJson('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: query, variables: { id: Number(id) } }),
      }).then(function (body) {
        var media = body && body.data && body.data.Media;
        if (!media) return null;
        var names = [media.title && media.title.native, media.title && media.title.romaji, media.title && media.title.english];
        if (Array.isArray(media.synonyms)) names = names.concat(media.synonyms);
        return { names: names, year: media.startDate && media.startDate.year };
      });
    }
    if (kind === 'mal') {
      return getJson('https://api.jikan.moe/v4/anime/' + id).then(function (body) {
        var a = body && body.data;
        if (!a) return null;
        var names = [a.title, a.title_english, a.title_japanese];
        if (Array.isArray(a.titles)) {
          for (var i = 0; i < a.titles.length; i++) names.push(a.titles[i] && a.titles[i].title);
        }
        if (Array.isArray(a.synonyms)) names = names.concat(a.synonyms);
        var year = a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year;
        return { names: names, year: year };
      });
    }
    return Promise.reject(fail('HOST_UNSUPPORTED', 'anidb ID 没有公开的片名接口，请改用 TMDB / kitsu / mal / anilist 条目'));
  }

  async function trackerInfo(args) {
    var titles = [];
    var seen = {};
    var episodes = {};
    var tmdbId = '';
    var year = null;

    // 1) ani.zip：按 id 拿片名 + 集数坐标（最稳，不依赖搜索）
    var zipped = await anizip(args.tracker.kind, args.tracker.id);
    if (zipped) {
      for (var z = 0; z < zipped.titles.length; z++) pushTitle(titles, seen, zipped.titles[z], 1);
      episodes = zipped.episodeMap;
      tmdbId = zipped.tmdbId;
      if (Object.keys(episodes).length) emit('log', 'ani.zip 给出 ' + Object.keys(episodes).length + ' 集的季集坐标');
    }

    // 2) tracker 自己的 API：补罗马字/英文/别名
    try {
      var data = await trackerTitles(args.tracker.kind, args.tracker.id);
      var list = data && Array.isArray(data.names) ? data.names : [];
      for (var i = 0; i < list.length; i++) pushTitle(titles, seen, list[i], 2);
      year = (data && data.year) || null;
    } catch (error) {
      if (!titles.length) throw error;
      emit('warn', args.tracker.kind + ' 补名失败: ' + error.message);
    }

    if (!titles.length) throw fail('NOT_FOUND', 'tracker 没有给出片名（' + args.tracker.kind + ':' + args.tracker.id + '）');

    var info = {
      titles: titles,
      titlesByKey: {},
      seasons: [],
      totalEpisodes: 0,
      hits: {},
      flat: true,                 // 默认没有 TMDB 分季数据：绝对集号按整部条目的位置
      episodeMap: episodes,
      firstYear: year,
    };

    // 3) 有 TMDB id 且宿主给了 key：把分季表也拿到，绝对集号就能按 TMDB 分季定位
    if (tmdbId && hostTmdbKey()) {
      try {
        var t = await tmdbInfo(tmdbId);
        for (var k = 0; k < t.titles.length; k++) pushTitle(titles, seen, t.titles[k].text, 2);
        if (t.seasons.length) { info.seasons = t.seasons; info.totalEpisodes = t.totalEpisodes; info.flat = false; }
        info.firstYear = info.firstYear || t.firstYear;
      } catch (error) {
        emit('warn', 'TMDB 分季表不可用: ' + error.message);
      }
    }
    return info;
  }

  // ------------------------------------------------- 中文名对齐（Bangumi 桥）
  // Nuvio 只给 TMDB id。TMDB 的 zh-CN / zh-TW 名未必等于中文站的写法（繁体 vs 简体、
  // 官方译名 vs 民间译名），所以再用 Bangumi 的 name_cn 与「别名」补一批候选。
  // Bangumi 的条目 id 只在这里内部使用：Nuvio 不读 Bangumi id，宿主只会传 TMDB。
  var BGM_API = 'https://api.bgm.tv';
  var BGM_UA = 'skfunghk-nuvio-plugin/1.0 (https://github.com/skfunghk/nuvio-plugins)';

  // 片名高频繁体 → 简体对照，用于「同片不同写法」的兜底比较；不是完整转换表。
  var TRAD_SIMP = [
    '\u64ca\u51fb','\u9032\u8fdb','\u9f8d\u9f99','\u528d\u5251','\u6230\u6218','\u5b78\u5b66','\u5712\u56ed',
    '\u8c93\u732b','\u6200\u604b','\u611b\u7231','\u6642\u65f6','\u9593\u95f4','\u982d\u5934','\u5011\u4eec',
    '\u8aac\u8bf4','\u5287\u5267','\u5834\u573a','\u9b25\u6597','\u9748\u7075','\u7378\u517d','\u5cf6\u5c9b',
    '\u5922\u68a6','\u846f\u836f','\u9280\u94f6','\u8eca\u8f66','\u8ecd\u519b','\u968a\u961f','\u9580\u95e8',
    '\u958b\u5f00','\u95dc\u5173','\u9ebc\u4e48','\u6a23\u6837','\u9019\u8fd9','\u4f86\u6765','\u5c0d\u5bf9',
    '\u7121\u65e0','\u8207\u4e0e','\u70ba\u4e3a','\u696d\u4e1a','\u6a02\u4e50','\u5f9e\u4ece','\u6703\u4f1a',
    '\u9084\u8fd8','\u8b93\u8ba9','\u8a18\u8bb0','\u61b6\u5fc6','\u98a8\u98ce','\u96f2\u4e91','\u96fb\u7535',
    '\u8a71\u8bdd','\u8ab0\u8c01','\u6bba\u6740','\u5fa9\u590d','\u8208\u5174','\u50b3\u4f20','\u8b80\u8bfb',
    '\u66f8\u4e66','\u5beb\u5199','\u9ad4\u4f53','\u9ede\u70b9','\u5169\u4e24','\u5e7e\u51e0','\u5167\u5185',
    '\u5225\u522b','\u5247\u5219','\u525b\u521a','\u52d5\u52a8','\u52dd\u80dc','\u52e2\u52bf','\u5340\u533a',
    '\u91ab\u533b','\u83ef\u534e','\u842c\u4e07','\u8449\u53f6','\u85dd\u827a','\u8655\u5904','\u865f\u53f7',
    '\u87f2\u866b','\u8853\u672f','\u88dc\u8865','\u88dd\u88c5','\u898b\u89c1','\u89c0\u89c2','\u898f\u89c4',
    '\u8996\u89c6','\u89ba\u89c9','\u8a02\u8ba2','\u8a08\u8ba1','\u8a0e\u8ba8','\u8a13\u8bad','\u8a2d\u8bbe',
    '\u8a66\u8bd5','\u8a69\u8bd7','\u8a72\u8be5','\u8a8d\u8ba4','\u8a9e\u8bed','\u8aa0\u8bda','\u8aa4\u8bef',
    '\u8acb\u8bf7','\u8ab8\u8bf8','\u8afe\u8bfa','\u8ab2\u8bfe','\u8abf\u8c03','\u8ac7\u8c08','\u8ad6\u8bba',
    '\u8b1c\u8c0d','\u8b49\u8bc1','\u8b77\u62a4','\u8b8a\u53d8','\u8b9a\u8d5e','\u8c9d\u8d1d','\u8ca0\u8d1f',
    '\u8ca1\u8d22','\u8ca8\u8d27','\u8ca9\u8d29','\u8cac\u8d23','\u8cb4\u8d35','\u8cb7\u4e70','\u8cbb\u8d39',
    '\u8cc7\u8d44','\u8cfd\u8d5b','\u8d95\u8d76','\u8e5f\u8f68','\u8f49\u8f6c','\u8f2a\u8f6e','\u8fb2\u519c',
    '\u9060\u8fdc','\u9078\u9009','\u907a\u9057','\u90f5\u90ae','\u9109\u4e61','\u91cb\u91ca','\u9c57\u9c9f',
    '\u9577\u957f','\u9583\u95ea','\u9589\u95ed','\u9592\u95f2','\u95a8\u95fa','\u963b\u963b','\u9663\u9635',
    '\u9670\u9634','\u9678\u9646','\u967d\u9633','\u96a8\u968f','\u96aa\u9669','\u96b1\u9690','\u96d9\u53cc',
    '\u96dc\u6742','\u96e3\u96be','\u9727\u96fe','\u975c\u9759','\u97ff\u54cd','\u9801\u9875','\u9802\u9876',
    '\u9805\u9879','\u9806\u987a','\u9808\u987b','\u9810\u9884','\u9813\u987f','\u9818\u9886','\u983b\u9891',
    '\u9846\u9897','\u984c\u9898','\u9858\u613f','\u985e\u7c7b','\u986f\u663e','\u98db\u98de','\u990a\u517b',
    '\u9918\u4f59','\u99ac\u9a6c','\u9a57\u9a8c','\u9aee\u53d1','\u9b5a\u9c7c','\u9ce5\u9e1f','\u9e97\u4e3d',
    '\u9ec3\u9ec4','\u9ee8\u515a','\u9f4a\u9f50','\u9f52\u9f7f','\u9f61\u9f84','\u9f8e\u9f98','\u9eb5\u9762',
    '\u9ede\u70b9','\u9854\u8138','\u9857\u98a0','\u9808\u987b','\u881f\u8721','\u5ee0\u5382','\u7522\u4ea7',
    '\u8fa6\u529e','\u5354\u534f','\u53c3\u53c2','\u9ede\u70b9','\u9a5a\u60ca','\u9aee\u53d1'
  ];
  var T2S = null;
  function toSimplified(text) {
    if (!T2S) {
      T2S = {};
      for (var i = 0; i < TRAD_SIMP.length; i++) {
        var pair = TRAD_SIMP[i];
        if (pair.length === 2) T2S[pair.charAt(0)] = pair.charAt(1);
      }
    }
    var value = String(text || '');
    var out = '';
    for (var j = 0; j < value.length; j++) {
      var ch = value.charAt(j);
      out += T2S[ch] || ch;
    }
    return out;
  }

  function hasIdeographs(text) { return /[一-鿿]/.test(text); }

  function similarity(a, b) {
    var x = compact(a), y = compact(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 0.8;
    return commonSubstring(x, y) / Math.max(1, Math.min(x.length, y.length));
  }

  async function bgmFetch(path, init) {
    var headers = {
      'User-Agent': BGM_UA,
      Accept: 'application/json',
    };
    var options = { method: 'GET', headers: headers };
    if (init && init.body) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = init.body;
    }
    var result = await rawFetch(BGM_API + path, options);
    if (!result.ok) return null;
    return parseJson(result.body);
  }

  /** Bangumi 的「别名」等字段既可能是字符串也可能是 {v} 数组。 */
  function infoValues(infobox, key) {
    var values = [];
    if (!Array.isArray(infobox)) return values;
    for (var i = 0; i < infobox.length; i++) {
      var row = infobox[i];
      if (!row || String(row.key || '').replace(/别名|別名/, '') !== '') { /* keep all keys, filter below */ }
      if (!row || !/^(别名|別名|中文名|英文名|日文名)$/.test(String(row.key || ''))) continue;
      var value = row.value;
      if (typeof value === 'string') values.push(value);
      else if (Array.isArray(value)) {
        for (var j = 0; j < value.length; j++) {
          var item = value[j];
          if (typeof item === 'string') values.push(item);
          else if (item && typeof item.v === 'string') values.push(item.v);
        }
      }
    }
    return values;
  }

  /** 用 TMDB 的中文名在 Bangumi 找同名条目，返回额外标题（name / name_cn / 别名）。 */
  async function bangumiTitles(info) {
    var keywords = [];
    for (var i = 0; i < info.titles.length && keywords.length < 2; i++) {
      var text = info.titles[i].text;
      if (hasIdeographs(text)) keywords.push(text);
    }
    for (var k = 0; k < keywords.length; k++) {
      if (Date.now() > run.deadline - BGM_BUDGET_MS) return [];
      var payload = JSON.stringify({ keyword: keywords[k], filter: { type: [2] } });
      var data = null;
      try { data = await bgmFetch('/v0/search/subjects', { body: payload }); }
      catch (e) { return []; }
      var list = data && Array.isArray(data.data) ? data.data : [];
      if (!list.length) continue;

      var best = null, bestScore = 0;
      for (var n = 0; n < list.length && n < 12; n++) {
        var row = list[n];
        if (!row || !row.id) continue;
        var score = 0;
        score = Math.max(score, similarity(row.name, keywords[k]), similarity(row.name_cn, keywords[k]));
        for (var t = 0; t < info.titles.length; t++) {
          score = Math.max(score, similarity(row.name, info.titles[t].text) * 0.95,
            similarity(row.name_cn, info.titles[t].text) * 0.95);
        }
        var year = yearOf(row.date);
        if (year && info.firstYear) {
          var gap = Math.abs(year - info.firstYear);
          if (gap === 0) score += 0.3; else if (gap <= 1) score += 0.1; else score -= 0.2;
        }
        if (score > bestScore) { bestScore = score; best = row; }
      }
      if (!best || bestScore < 0.55) continue;

      var out = [];
      if (best.name) out.push(best.name);
      if (best.name_cn) out.push(best.name_cn);
      var detail = null;
      try { detail = await bgmFetch('/v0/subjects/' + best.id); } catch (e) { detail = null; }
      if (detail) {
        if (detail.name) out.push(detail.name);
        if (detail.name_cn) out.push(detail.name_cn);
        var aliases = infoValues(detail.infobox, '别名');
        for (var a = 0; a < aliases.length; a++) out.push(aliases[a]);
        emit('log', 'Bangumi ' + best.id + ' 命中：' + String(best.name_cn || best.name || ''));
      }
      var cleaned = [];
      for (var q = 0; q < out.length; q++) {
        var value = String(out[q] || '').trim();
        if (value.length >= 2 && value.length <= 80) cleaned.push(value);
      }
      return cleaned;
    }
    return [];
  }


  // kanju.js tries its titles in rank order. Every Kazumi rule searches a Chinese site, so the
  // same ranked list is walked with the Chinese names first; within one call a title that has
  // already matched on another rule is tried first.
  function searchTitles(info) {
    var order = function (title) { return title.rank === 1 ? 0 : (hasIdeographs(title.text) ? 1 : 2); };
    return info.titles.slice().sort(function (a, b) {
      return (info.hits[b.text] || 0) - (info.hits[a.text] || 0) || order(a) - order(b) || a.rank - b.rank || a.index - b.index;
    });
  }

  async function tmdbInfo(tmdbId) {
    var key = hostTmdbKey();
    if (!key) throw fail('HOST_UNSUPPORTED', '宿主没有提供 TMDB_API_KEY，无法把 TMDB ID 换成片名');

    var path = '/tv/' + tmdbId;
    var data = null;
    try {
      data = await tmdbGet(key, path, { language: 'zh-CN', append_to_response: 'translations,alternative_titles' });
    } catch (error) {
      if (error.code !== 'UPSTREAM_CHANGED' && error.code !== 'UPSTREAM_ERROR') throw error;
    }
    if (!data) data = await tmdbGet(key, path, { language: 'zh-CN' });

    var titles = tmdbTitles(data);
    if (!titles.length) throw fail('NOT_FOUND', 'TMDB 没有这部剧集的片名');

    var info = { titles: titles, titlesByKey: {}, seasons: [], totalEpisodes: 0, hits: {}, firstYear: yearOf(data.first_air_date) };
    var seasons = Array.isArray(data.seasons) ? data.seasons : [];
    for (var i = 0; i < seasons.length; i++) {
      var number = Number(seasons[i].season_number);
      var count = Number(seasons[i].episode_count) || 0;
      if (!(number >= 1) || !count) continue;                 // specials (season 0) are not in an absolute numbering
      info.seasons.push({ number: number, name: String(seasons[i].name || ''), count: count, signature: nameSignature(String(seasons[i].name || '')), year: yearOf(seasons[i].air_date) });
      info.totalEpisodes += count;
    }
    return info;
  }

  // TMDB 名不够用时，用 Bangumi 补中文候选；失败一律静默，主流程照常。
  async function augmentTitles(info) {
    if (!Array.isArray(info.titles) || !info.titles.length) return;
    var extra = [];
    try {
      extra = await bangumiTitles(info);
    } catch (error) {
      emit('warn', 'Bangumi 补名失败: ' + (error && error.message ? error.message : String(error)));
      return;
    }
    if (!extra.length) return;
    var seen = {};
    for (var i = 0; i < info.titles.length; i++) seen[info.titles[i].text] = true;
    var added = 0;
    for (var j = 0; j < extra.length; j++) {
      if (seen[extra[j]]) continue;
      seen[extra[j]] = true;
      info.titles.push({ text: extra[j], rank: 2, index: info.titles.length });
      added++;
    }
    if (added) emit('log', 'Bangumi 补充 ' + added + ' 个中文候选名');
  }

  function indexTitles(info) {
    for (var t = 0; t < info.titles.length; t++) {
      var text = info.titles[t].text;
      var score = info.titles[t].rank === 1 ? 100 : (info.titles[t].rank === 2 ? 90 : 80);
      var keys = [compact(baseTitle(text))];
      var simplified = compact(baseTitle(toSimplified(text)));
      if (simplified && simplified !== keys[0]) keys.push(simplified);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key && (!info.titlesByKey[key] || info.titlesByKey[key] < score)) info.titlesByKey[key] = score;
      }
    }
  }

  // Episodes of the seasons before `season` on TMDB: where an absolute number starts in it.
  function seasonOffset(info, season) {
    var offset = 0;
    for (var i = 0; i < info.seasons.length; i++) if (info.seasons[i].number < season) offset += info.seasons[i].count;
    return offset;
  }

  // The (season, episode) an absolute number falls in on TMDB, or null when the counts do not cover it.
  function locateAbsolute(info, absolute) {
    var used = 0;
    for (var i = 0; i < info.seasons.length; i++) {
      var entry = info.seasons[i];
      if (absolute <= used + entry.count) return { season: entry.number, episode: absolute - used };
      used += entry.count;
    }
    return null;
  }

  // ------------------------------------------------------- naming a site entry
  // A site lists a show as "进击的巨人", "进击的巨人 第三季", "进击的巨人 最终季 Part.2", "进击的巨人OAD",
  // "进击的巨人 第四季国语版". A site entry is recognised by a known TMDB title at its start; what
  // follows tells the season, the part of a season, or that it is not the show proper (an OVA, a
  // compilation). Years are not compared: most search results carry none, and a long-running anime
  // is one entry with a decade of years.

  var SEASON_MARKERS = [
    /第\s*[0-9一二三四五六七八九十百零〇两]+\s*[季期]/g,
    /\bseason\s*[0-9]+\b/gi,
    /(?:^|[\s(\[])s[0-9]{1,2}\b/gi,
  ];
  var BRACKET_TAG = /[（(\[【〔][^）)\]】〕]*[）)\]】〕]/g;
  var LANGUAGE_TAG = /国语|国語|粤语|粵語|中配|国配|台配|中文配音|日语版|日語版|原声|原聲|双语|雙語|配音版|普通话|普通話|中字|国日双语/;
  var KIND_TAG_CJK = /剧场版|劇場版|电影版|電影版|特别篇|特別篇|特别版|特別版|外传|外傳|番外|总集篇|總集篇|总编集|合集|混剪|剪辑|解说|速看|真人|广播剧|廣播劇|预告|預告|主题曲|演唱会|演唱會|音乐会|音樂會|交响|交響|舞台剧|舞台劇|访谈|訪談|花絮|小剧场|小劇場|迷你动画|迷你動畫|动画短片|動畫短片|qv版|音频/;
  var KIND_TAG_LATIN = ['ova', 'oad', 'ona', 'movie', 'special', 'pv', 'cm', 'live', 'sp', 'dj', 'mad'];
  var PART_FIRST = /^(?:上|上部|上集|上篇|前篇|前传|前集|前編)$/;
  var PART_SECOND = /^(?:下|下部|下集|下篇|后篇|后传|后集|後編)$/;
  var TRAILING_NUMBER = /^([2-9]|[1-9][0-9])$/;

  function latinTag(text, tag) {
    var at = text.indexOf(tag);
    while (at >= 0) {
      var before = at === 0 || !/[a-z0-9]/.test(text.charAt(at - 1));
      var after = at + tag.length >= text.length || !/[a-z0-9]/.test(text.charAt(at + tag.length));
      if (before && after) return true;
      at = text.indexOf(tag, at + 1);
    }
    return false;
  }

  function partOf(text) {
    // { order, label }: where an entry sits inside one season; null when it is the whole season.
    var number = /part([0-9]+)/.exec(text) || /第([0-9]+)章/.exec(text) || /([0-9]+)章$/.exec(text);
    if (number) return { order: Number(number[1]), label: 'Part ' + Number(number[1]) };
    var final = /完结篇|完結篇|最终章|最終章|最终话|最終話|final/.test(text);
    var first = /前篇|前編|上篇|上巻|上卷/.test(text) || PART_FIRST.test(text);
    var second = /后篇|後篇|下篇|下巻|下卷/.test(text) || PART_SECOND.test(text);
    if (final) return { order: first ? 90 : (second ? 92 : 91), label: first ? '完结篇 前篇' : (second ? '完结篇 后篇' : '完结篇') };
    if (first) return { order: 1, label: '前篇' };
    if (second) return { order: 2, label: '后篇' };
    return null;
  }

  // A season name or a title suffix without its season marker: "第 3 季" is "", "最终季 Part 1" is "最终季".
  var PART_WORDS = /part[0-9]+|第[0-9]+章|[0-9]+章$|完结篇|完結篇|最终章|最終章|最终话|最終話|final|前篇|前編|上篇|上巻|上卷|后篇|後篇|下篇|下巻|下卷/g;

  function nameSignature(text) {
    var value = fold(text);
    for (var i = 0; i < SEASON_MARKERS.length; i++) value = value.replace(SEASON_MARKERS[i], ' ');
    var base = compact(value);
    var part = partOf(base);
    if (part) base = base.replace(PART_WORDS, '');
    return { base: base, part: part };
  }

  function commonSubstring(a, b) {
    var best = 0;
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        var run = 0;
        while (i + run < a.length && j + run < b.length && a.charAt(i + run) === b.charAt(j + run)) run++;
        if (run > best) best = run;
      }
    }
    return best;
  }

  // What a search result is, relative to the wanted season: { score, group, chain } or null.
  //   group 'season'  names the wanted season (marker or TMDB season name): chain = cumulative order
  //   group 'whole'   the bare title: every season in one entry, positions are absolute
  // A suffix that names no season known to TMDB is never used: on the sites it belongs to a
  // compilation film, a recap or another season, and a wrong episode is worse than none.
  // 站点常把片名换个写法（繁简、民间译名、日文原名），前缀匹配就认不出。
  // 退一步用 CJK 字重合度：至少 3 个汉字且重合 ≥ 0.85 才算同一个条目，避免「进击的巨人」吃到「进击的巨人中学」。
  function cjkOverlap(left, right) {
    var a = String(left || '').match(/[\u3400-\u9fff]/g) || [];
    var b = String(right || '').match(/[\u3400-\u9fff]/g) || [];
    if (!a.length || !b.length) return 0;
    var counts = {}, used = {}, inter = 0;
    for (var i = 0; i < b.length; i++) counts[b[i]] = (counts[b[i]] || 0) + 1;
    for (var j = 0; j < a.length; j++) {
      if ((counts[a[j]] || 0) > (used[a[j]] || 0)) { used[a[j]] = (used[a[j]] || 0) + 1; inter++; }
    }
    return inter / Math.min(a.length, b.length);
  }

  function overlapTitle(name, info) {
    var value = toSimplified(name);
    var cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    if (cjk < 3) return null;
    var best = null, bestRatio = 0;
    for (var i = 0; i < info.titles.length; i++) {
      var ratio = cjkOverlap(value, toSimplified(info.titles[i].text));
      if (ratio >= 0.85 && ratio > bestRatio) { bestRatio = ratio; best = info.titles[i]; }
    }
    return best ? best : null;
  }

  function describeEntry(item, info, want) {
    var key = compact(fold(item.name));
    var best = null;
    for (var known in info.titlesByKey) {
      if (!Object.prototype.hasOwnProperty.call(info.titlesByKey, known)) continue;
      if (key === known || key.slice(0, known.length) === known) {
        var base = info.titlesByKey[known] - (key === known ? 0 : 10);
        // 别名整名命中时 rest 会是空的，季号就被吞掉（「进击的巨人 最终季」整名是 Bangumi 的别名）。
        // 所以优先选「rest 里还留着季号」的已知片名；同分时选较短的已知名，让 rest 更长。
        var tail = key.slice(known.length);
        var marked = tail ? seasonFromTitle(tail) : null;
        var better = !best
          || (marked !== null && best.marked === null)
          || (marked === best.marked && (base > best.base || (base === best.base && known.length < best.known.length)));
        if (better) best = { base: base, known: known, marked: marked };
      }
    }
    if (!best || best.known.length < 2) {
      var loose = overlapTitle(item.name, info);
      if (!loose) return null;
      // 换成写法不同但字面高度重合的片名：当作同一个条目，后面的季号仍从标题里读。
      best = { base: 60, known: compact(baseTitle(loose.text)) };
      if (!best.known || best.known.length < 2) return null;
      var looseEntry = {
        item: item,
        key: key,
        rest: '',
        marker: seasonFromTitle(key),
        part: partOf(key),
        tagged: false,
        kind: null,
        score: 60,
        group: '',
        chain: 0,
      };
      if (want.absolute) return describeAbsolute(looseEntry);
      looseEntry.group = 'season';
      looseEntry.chain = 0;
      return looseEntry;
    }
    var rest = key.slice(best.known.length);
    var marker = rest ? seasonFromTitle(rest) : null;
    if (marker === null && rest && TRAILING_NUMBER.test(rest)) marker = Number(rest);
    var part = rest ? partOf(rest) : null;
    var tagged = LANGUAGE_TAG.test(rest);
    var kind = KIND_TAG_CJK.test(rest);
    for (var t = 0; !kind && t < KIND_TAG_LATIN.length; t++) kind = latinTag(rest, KIND_TAG_LATIN[t]);
    var entry = { item: item, key: key, rest: rest, marker: marker, part: part, tagged: tagged, kind: kind, score: best.base, group: '', chain: 0 };
    if (kind) return null;
    if (want.absolute) return describeAbsolute(entry);
    var season = wantedSeason(info, want);
    var signature = season ? season.signature : null;

    // The year, when the site's result carries one: a named entry two years or more away from the
    // season's is another season; the same year is a strong hint, one year off a weak one.
    if (item.year && season && season.year) {
      var years = Math.abs(item.year - season.year);
      if (rest && years >= 2) return null;
      if (rest || want.season === 1) entry.score += years === 0 ? 45 : (years === 1 ? 12 : 0);
    }

    if (marker !== null) {
      if (marker === want.season) { entry.group = 'season'; entry.chain = part ? part.order : 0; entry.score += 60; }
      // a later season continues this one only when TMDB counts more episodes than the site lists
      else if (marker > want.season) { entry.group = 'season'; entry.chain = 100 + (marker - want.season) * 10 + (part ? part.order : 0); entry.score += 2; }
      else return null;
    } else if (!rest) {
      entry.group = want.season === 1 ? 'season' : 'whole';
      entry.score += want.season === 1 ? 50 : 10;
    } else if (tagged && compact(rest.replace(new RegExp(LANGUAGE_TAG.source, 'g'), '')) === '') {
      entry.group = want.season === 1 ? 'season' : 'whole';
      entry.score += (want.season === 1 ? 50 : 10) - 8;
    } else if (signature && signature.base && (rest === signature.base || rest.slice(0, signature.base.length) === signature.base)) {
      // chain 0 is where the wanted season starts; a later part of it follows in part order; an
      // entry of an earlier part comes at 50, one of a later season at 100 and up.
      if (!part) entry.chain = signature.part && signature.part.order !== 1 ? 50 : 0;
      else entry.chain = !signature.part || signature.part.order === part.order ? 0 : (part.order > signature.part.order ? part.order : 50);
      entry.group = 'season';
      entry.score += entry.chain === 0 ? 55 : 4;
    } else if (signature && signature.base && commonSubstring(rest, signature.base) >= Math.max(2, signature.base.length / 2)) {
      entry.group = 'season';
      entry.chain = part ? part.order : 0;
      entry.score += 30;
    }
    return entry;
  }

  // Absolute numbering (season = null): the bare entry first, then the seasons in order.
  function describeAbsolute(entry) {
    if (entry.marker !== null) {
      entry.group = 'season';
      entry.chain = entry.marker * 10 + (entry.part ? entry.part.order : 0);
      entry.score += 20;
    } else if (!entry.rest) {
      entry.group = 'whole';
      entry.score += 50;
    } else if (entry.tagged && compact(entry.rest.replace(new RegExp(LANGUAGE_TAG.source, 'g'), '')) === '') {
      entry.group = 'whole';
      entry.score += 42;
    } else if (FINAL_SEASON.test(entry.rest)) {
      // 「最终季 / 完结篇 / Final Season」没有季号，但确实排在所有季之后：绝对集号累加时放在最后试。
      entry.group = 'season';
      entry.chain = 900 + (entry.part ? entry.part.order : 0);
      entry.score += 1;
    } else {
      return null;
    }
    return entry;
  }

  function rankEntries(items, info, want) {
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = describeEntry(items[i], info, want);
      if (entry) { entry.order = i; entries.push(entry); }
    }
    entries.sort(function (a, b) { return b.score - a.score || a.group.localeCompare(b.group) || a.chain - b.chain || a.order - b.order; });
    return entries;
  }

  // ---------------------------------------------------------- episode choice
  // Kazumi numbers an entry's episodes by position (roadData.data[episode - 1]). A road whose labels
  // are all numbered is read by number instead, because some sites list an entry newest first
  // (ezdmw: 12, 11, ..., 1) and some append SP episodes after the TV ones.

  function labelNumber(label) {
    var value = fold(String(label || '')).replace(/^[^a-z0-9一-鿿]+/, '');
    if (/^(sp|special|ova|oad|预告|pv|trailer|preview)/.test(value) || /^(2160|1080|720|480)p?$/.test(value)) return null;
    if (/[0-9]+-[0-9]+|[0-9]+~[0-9]+/.test(value)) return null;        // a range ("01-07")
    var match = /第\s*([0-9]+)\s*[话話集]/.exec(value) || /(?:^|[\s(\[])ep([0-9]{1,4})\b/i.exec(value);
    if (!match) {
      var runs = value.match(/[0-9]+/g);
      if (!runs || runs.length !== 1) return null;
      match = [null, runs[0]];
    }
    var number = Number(match[1]);
    return number >= 1 && number <= 5000 ? number : null;
  }

  function numberedRoad(road) {
    var numbers = [];
    var parsed = 0;
    for (var i = 0; i < road.names.length; i++) {
      var number = labelNumber(road.names[i]);
      numbers.push(number);
      if (number !== null) parsed++;
    }
    return parsed * 2 >= road.names.length ? numbers : null;
  }

  // The episode `position` (1-based) of a road, by label number when the road is numbered, else by position.
  function pickEpisode(road, position) {
    if (!(position >= 1)) return null;
    var numbers = numberedRoad(road);
    if (numbers) {
      var first = numbers.indexOf(position);
      // by label only when the number is there once: a list with two "第01集" is not a numbering
      if (first >= 0 && numbers.indexOf(position, first + 1) < 0) {
        return { url: road.urls[first], label: road.names[first], raw: road.raws[first], byLabel: true };
      }
    }
    if (position > road.urls.length) return null;
    return { url: road.urls[position - 1], label: road.names[position - 1], raw: road.raws[position - 1], byLabel: false };
  }

  // The road to read: the first that holds the wanted position, else the longest.
  function chooseRoad(roads, position) {
    var longest = null;
    for (var i = 0; i < roads.length; i++) {
      var usable = roads[i].urls.filter(isHttpUrl).length;
      if (usable >= position) return roads[i];
      if (usable && (!longest || usable > longest.count)) longest = { road: roads[i], count: usable };
    }
    return longest ? longest.road : null;
  }

  // ------------------------------------------------------------- video address
  // Kazumi loads the play page in a WebView and reports the first URL whose response starts with
  // "#EXTM3U", or the src of a <video>/<source> element (webview/video/impl/video_webview_android_impl.dart,
  // the default parser; the "legacy" parser reports iframe src attributes). Nothing here runs page
  // JavaScript. The page source is read instead, in this order:
  //   1. the player configuration MacCMS sites embed ("player_aaaa={...}"), decoded by its own
  //      "encrypt" field (0 plain, 1 URL-escaped, 2 base64 of a URL-escaped string);
  //   2. a media link that is in the source as text (.m3u8 / .mp4 / ...);
  //   3. the src of a <video> or <source> element that is in the markup;
  //   4. an <iframe>: an address carried in its src (a base64 blob), else the iframe page, fetched
  //      once and read by 1-3;
  //   5. a player address that is itself a page: fetched once and read by 1-3.
  // Each address found is then requested with a 2 KB range, with the headers a player would send
  // (none but a User-Agent): an address that answers 4xx/5xx is dropped, one that answers 2xx is
  // returned. A site whose video only exists after its JavaScript has run yields nothing here.

  var MEDIA_EXTENSION = /\.(m3u8|mp4|m4v|flv|mkv|webm)$/i;
  var MEDIA_URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>\\)）】，。；]+?\.(?:m3u8|mp4|m4v|flv|mkv|webm)(?:\?[^\s"'<>\\)）】，。；]*)?/gi;
  var AD_HINT = /googleads|googlesyndication|adtrafficquality|doubleclick|googletag|\/ad\/|\/ads\/|\/advertisement\/|prestrain|\/static\/ad/i;
  var PLAYER_CONFIG = /player_[a-z]+\s*=\s*\{/i;
  // Text a player could be given: visible characters or non-ASCII (percent-encoded later); never a
  // control character or a space, which is what an undecoded binary blob contains.
  var URL_TEXT = /^[\x21-\x7e\u0080-\uffff]*$/;
  // The file name a site appends after a base64 address. Only names that are a plain word or a
  // number are accepted: the base64 alphabet is alphanumeric too, and "…hg1a" + "tdex.mp4" decodes
  // just as plausibly as "…hg1a" + "index.mp4" when a stray byte happens to be printable.
  var CARRIER_TAIL = /^(?:(?:index|playlist|video|play|master|main|movie|media|stream|source|hd|[0-9]{1,4})?\.(?:m3u8|mp4|m4v|flv|mkv|webm))$/;

  // The extension has to be the end of the path: "…/embed?url=x.m3u8" is a page, not a playlist.
  function mediaKind(url) {
    var cut = url.search(/[?#]/);
    var match = MEDIA_EXTENSION.exec(cut >= 0 ? url.slice(0, cut) : url);
    return match ? (match[1].toLowerCase() === 'm3u8' ? 'hls' : 'mp4') : '';
  }

  function isMediaUrl(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s\/?#]+/i.test(url) && !!mediaKind(url) && url.indexOf(' ') < 0;
  }

  // An address that only carries the real one: ".../video/<base64 of the address>index.mp4". The
  // whole token is tried first; otherwise the longest head that is base64 of an address, followed
  // by a plain file name, wins.
  function decodeCarrier(token) {
    var whole = base64Decode(token);
    if (whole && isMediaUrl(whole) && URL_TEXT.test(whole) && !AD_HINT.test(whole)) return whole;
    var best = null;
    for (var cut = token.length; cut >= 8 && cut >= token.length - 16; cut--) {
      var tail = token.slice(cut);
      if (!CARRIER_TAIL.test(tail)) continue;
      var decoded = base64Decode(token.slice(0, cut));
      if (!decoded || decoded.slice(0, 4) !== 'http' || !URL_TEXT.test(decoded)) continue;
      var candidate = decoded + tail;
      if (!isMediaUrl(candidate) || AD_HINT.test(candidate)) continue;
      best = candidate;
      break;                                  // cuts are tried longest head first
    }
    return best || '';
  }

  function cleanUrl(url) {
    return String(url).replace(/&amp;/gi, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&#x2f;/gi, '/').trim();
  }

  // A player is given an address as text: anything outside the URL characters (a Chinese folder
  // name in an address, a space) is percent-encoded instead of being left to the player.
  var URL_CHARACTER = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]$/;
  function encodeUrl(url) {
    var value = String(url);
    var out = '';
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (URL_CHARACTER.test(ch) && !(ch === '%' && !/[0-9a-fA-F]{2}/.test(value.slice(i + 1, i + 3)))) out += ch;
      else out += percentEncode(ch, false).toUpperCase();          // uppercase hex, as encodeURIComponent writes it
    }
    return out;
  }

  function pushCandidate(list, seen, url, how) {
    url = cleanUrl(url);
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (!isMediaUrl(url) || AD_HINT.test(url) || seen[url]) return false;
    var query = url.indexOf('?');
    var path = query >= 0 ? url.slice(0, query) : url;
    var last = path.slice(path.lastIndexOf('/') + 1);
    // a segment that is mostly base64 is a carrier, not a media file
    var blob = /^(.*?)([A-Za-z0-9+/_-]{24,}=?=?)([^/]*\.[a-z0-9]+)$/i.exec(last);
    if (blob) {
      var inner = decodeCarrier(blob[2] + blob[3]);
      if (inner) { url = inner; how += '+base64'; if (seen[url]) return false; }
    }
    url = encodeUrl(url);
    if (seen[url]) return false;
    seen[url] = true;
    list.push({ url: url, kind: mediaKind(url), how: how });
    return true;
  }

  // The object is found by counting braces outside strings: its text may hold "<" and newlines.
  function jsonObjectAt(text, start) {
    var depth = 0;
    var quoted = false;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quoted) { if (ch === '\\') i++; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return '';
  }

  function playerConfigUrl(html) {
    var match = PLAYER_CONFIG.exec(html);
    if (!match) return '';
    var literal = jsonObjectAt(html, match.index + match[0].length - 1);
    if (!literal) return '';
    var config;
    try { config = JSON.parse(literal); } catch (e) { return ''; }
    if (!config || typeof config.url !== 'string') return '';
    var value = config.url.trim();
    var mode = String(config.encrypt === undefined ? '0' : config.encrypt);
    if (mode === '2') value = unescapeJs(base64Decode(decodeComponent(value)));
    else if (mode === '1') value = unescapeJs(decodeComponent(value));
    return URL_TEXT.test(value) ? value.trim() : '';
  }

  // Reads one page: what is in its source, plus the iframes it declares.
  function readPage(html, pageUrl) {
    var candidates = [];
    var seen = {};
    var fromConfig = playerConfigUrl(html);
    if (fromConfig && isMediaUrl(fromConfig)) pushCandidate(candidates, seen, fromConfig, 'player-config');
    var flat = cleanUrl(html);
    flat.replace(MEDIA_URL_IN_TEXT, function (whole) { pushCandidate(candidates, seen, whole, 'source'); return ''; });
    var iframes = [];
    var root;
    try { root = parseDocument(html, { name: '' }); } catch (e) { root = null; }
    if (root) {
      var videos = xpathQuery(root, '//video').nodes.concat(xpathQuery(root, '//source').nodes);
      for (var v = 0; v < videos.length; v++) pushCandidate(candidates, seen, videos[v].attrs.src || '', 'video-element');
      var frames = xpathQuery(root, '//iframe').nodes;
      for (var i = 0; i < frames.length; i++) {
        var src = cleanUrl(frames[i].attrs.src || frames[i].attrs['data-src'] || '');
        if (!src || !isHttpUrl(src) || AD_HINT.test(src)) continue;
        // "…?src=<base64>index.mp4": the address, or the carrier that holds it, is inside the src
        var before = candidates.length;
        if (isMediaUrl(src)) pushCandidate(candidates, seen, src, 'iframe-src');
        if (src.indexOf('?') >= 0) {
          var query = src.slice(src.indexOf('?') + 1).split('&');
          for (var q = 0; q < query.length; q++) {
            var eq = query[q].indexOf('=');
            if (eq < 0) continue;
            var value = decodeComponent(query[q].slice(eq + 1));
            if (isMediaUrl(value)) pushCandidate(candidates, seen, value, 'iframe-param');
          }
        }
        // a player page is read once, as written in the page, when its src gave no address itself
        if (candidates.length === before && !isMediaUrl(src) && iframes.length < 3) iframes.push(src);
      }
    }
    return { candidates: candidates, iframes: iframes, playerPage: fromConfig && !isMediaUrl(fromConfig) && isHttpUrl(fromConfig) ? fromConfig : '' };
  }

  // What a player can tell from the first bytes: an HLS playlist, or an ISO-BMFF file.
  function looksLikeMedia(type, head) {
    if (/text\/html|json|javascript|image\//i.test(type)) return '';    // an error page, whatever its bytes
    if (/^\s*<(!doctype|html)/i.test(head)) return '';
    if (/mpegurl/i.test(type)) return 'hls';
    if (/^\s*#EXTM3U/.test(head)) return 'hls';
    if (head.length > 12 && head.slice(4, 8) === 'ftyp') return 'mp4';
    if (/^(video|audio)\//i.test(type) || /^application\/(octet-stream|mp4)/i.test(type)) return 'mp4';
    return '';
  }

  // HEAD is refused by many of these servers; a 2 KB range is what a player asks for first.
  async function confirmMedia(url) {
    if (Date.now() > run.verifyUntil) return { state: 'unverified', detail: 'no time left' };
    var result = await rawFetch(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-2047', Accept: '*/*' } });
    if (result.status === 0) return { state: 'unverified', detail: result.statusText };
    if (result.status === 206 || result.status === 200) {
      var type = result.headers && typeof result.headers.get === 'function' ? String(result.headers.get('content-type') || '') : '';
      var kind = looksLikeMedia(type, result.body.slice(0, 64));
      if (kind) return { state: 'confirmed', kind: kind, type: type };
      return { state: 'rejected', detail: '2xx but not media (' + type + ')' };
    }
    return { state: 'rejected', detail: String(result.status) };
  }

  var MAX_PAGE_FETCHES = 2;      // the play page and one follow (iframe or player page)

  // From an entry's episode address to a playable media address.
  async function resolveVideo(rule, episode, pageUrl) {
    var found = [];
    var seen = {};
    var pages = 0;
    var page = pageUrl;
    var queue = [];

    // api rules often name the media file itself before the rule wraps it in a player page
    if (isMediaUrl(episode.raw)) {
      seen[episode.raw] = true;
      found.push({ url: encodeUrl(episode.raw), kind: mediaKind(episode.raw), how: 'rule-data', trusted: true });
    }
    if (isMediaUrl(pageUrl)) {
      if (!seen[pageUrl]) { seen[pageUrl] = true; found.push({ url: encodeUrl(pageUrl), kind: mediaKind(pageUrl), how: 'rule-data', trusted: true }); }
    } else if (isHttpUrl(pageUrl) && !found.length) {
      queue.push(pageUrl);        // a play page is only read when the rule did not name the media itself
    }

    while (queue.length && pages < MAX_PAGE_FETCHES && found.length < 4 && Date.now() < run.deadline) {
      page = queue.shift();
      pages++;
      var result = await rawFetch(page, { method: 'GET', headers: ruleHeaders(rule, rule.referer ? { Referer: rule.referer } : {}) });
      if (result.status !== 200) { emit('warn', rule.name + ': 播放页返回 ' + result.status); continue; }
      var read;
      try { read = readPage(result.body, result.url || page); } catch (e) { read = { candidates: [], iframes: [], playerPage: '' }; }
      for (var c = 0; c < read.candidates.length && found.length < 4; c++) {
        var candidate = read.candidates[c];
        if (seen[candidate.url]) continue;
        seen[candidate.url] = true;
        found.push({ url: candidate.url, kind: candidate.kind, how: candidate.how, trusted: false });
      }
      // the next page to read: the first iframe, else the player page of a player configuration
      if (read.iframes.length) queue.push(read.iframes[0]);
      else if (read.playerPage && !seen[read.playerPage]) queue.push(read.playerPage);
    }
    if (!found.length) throw fail('NOT_FOUND', rule.name + ': 播放页源码里没有可播放地址（需要执行页面脚本）');

    var confirmed = [];
    var unverified = [];
    for (var i = 0; i < found.length && i < MAX_VERIFICATIONS && Date.now() < run.deadline; i++) {
      var check = await confirmMedia(found[i].url);
      if (check.state === 'confirmed') confirmed.push(found[i]);
      else if (check.state === 'unverified') unverified.push(found[i]);
      else emit('warn', rule.name + ': 地址不可播放（' + check.detail + '）' + found[i].url.slice(0, 80));
      if (confirmed.length) break;
    }
    if (!confirmed.length && !unverified.length) throw fail('NOT_FOUND', rule.name + ': 找到的地址都无法播放');
    var pick = confirmed.length ? confirmed[0] : unverified[0];
    pick.verified = confirmed.length > 0;
    return pick;
  }

  // ---------------------------------------------------------------- rule sources
  // Rules are read at run time from the repository Kazumi itself uses (ApiEndpoints.pluginShop),
  // index.json first and then only the files of the rules that are tried. Nuvio has no storage, so
  // this happens on every call. A small snapshot of the rule files (verbatim, taken 2026-11-26) is
  // embedded below: the stable rules run from the snapshot first, so a GitHub outage, or a network
  // where raw.githubusercontent.com is unreachable, costs freshness only. The remote files are read
  // afterwards, for the rules that have not produced streams yet.

  var RULES_RAW = 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/';
  var SNAPSHOT_STAMP = '2026-11-26';

  // What the probes and tests of 2026-11-26 showed, rule by rule, for the rules index.json lists.
  //   stable        search, episodes and a playable address: confirmed end to end
  //   experimental  search and episodes parse and an address is read from the page source, but
  //                 the address did not play from here (403 / 404); off unless the entry id says so
  //   disabled      not convertible without a browser: a step needs page JavaScript, a captcha, or
  //                 the site did not answer
  // A rule that is not in this table is never tried, whichever mode it has.
  var RULE_STATUS = {
    giriGiriLove: { tier: 'stable', note: 'api/api: the episode list of the detail API names the media file itself' },
    akianime: { tier: 'experimental', note: 'xpath: player_aaaa.url is an .m3u8 in the page source; answered 404 from here' },
    MXdm: { tier: 'experimental', note: 'xpath: an .m3u8 in the page source; answered 403 from here' },
    ezdmw: { tier: 'experimental', note: 'xpath: the iframe src carries the .mp4 address in base64; answered 403 from here' },
    AGE: { tier: 'experimental', note: 'xpath: search verified on the saved page; episodes and video not verified (detail page timed out)' },
    '7sefun': { tier: 'disabled', note: 'xpath: the player address is a third-party player page (lmm85.com) that answers 404 and a JavaScript loader' },
    LMM: { tier: 'disabled', note: 'api search + xpath episodes work; the play page names a dpmp4 parse player' },
    mgnacg: { tier: 'disabled', note: 'api search + xpath episodes work; the player address is encrypted by site JavaScript' },
    TvTFun: { tier: 'disabled', note: 'api search + xpath episodes work; the play page is rendered by its scripts' },
    baimao: { tier: 'disabled', note: 'xpath: the iframe src is written by page JavaScript' },
    DM84: { tier: 'disabled', note: 'xpath: a third-party player with an encrypted parameter' },
    sorani: { tier: 'disabled', note: 'api/api: search and episode API work; the play page loads the stream by script (playUrl null)' },
    xfdmnext: { tier: 'disabled', note: 'api/api: the API did not answer (timeout, 2 of 2 attempts)' },
    dalvdm: { tier: 'disabled', note: 'Cloudflare refuses the search (403, "Attention Required!")' },
    mutefun: { tier: 'disabled', note: 'the search answers a captcha page (403); antiCrawlerConfig enabled' },
    aafun: { tier: 'disabled', note: 'moonci.com did not answer (timeout)' },
    moonci: { tier: 'disabled', note: 'moonci.com did not answer (timeout)' },
    xfdmneo: { tier: 'disabled', note: 'the search answers HTTP 500; useLegacyParser rule' },
  };
  var RULE_ORDER = [
    'giriGiriLove',
    'akianime', 'MXdm', 'ezdmw', 'AGE',
    '7sefun', 'LMM', 'mgnacg', 'TvTFun', 'baimao', 'DM84', 'sorani', 'xfdmnext', 'dalvdm', 'mutefun', 'aafun', 'moonci', 'xfdmneo',
  ];

  // ---- snapshot (generated from the rule files of the repository at the date above) ----
  var RULE_SNAPSHOT = {
    "giriGiriLove": {"api":"9","type":"anime","name":"giriGiriLove","version":"2.7","muliSources":true,"useWebview":true,"useNativePlayer":true,"usePost":false,"useLegacyParser":false,"adBlocker":false,"userAgent":"","baseURL":"https://ani.girigirilove.com","searchMode":"api","chapterMode":"api","searchApiConfig":{"request":{"method":"GET","url":"https://m3u8.girigirilove.com/api.php/Vod/get_list","query":{"vod_name":"@keyword","offset":"0","limit":"24"}},"listPath":"$.info.rows[*]","namePath":"$.vod_name","sourcePath":"$.vod_id","sourceTemplate":""},"chapterApiConfig":{"request":{"method":"GET","url":"https://m3u8.girigirilove.com/api.php/Vod/get_detail","query":{"vod_id":"@source"}},"format":"delimited","roadNamesPath":"$.info.vod_play_from","roadEpisodesPath":"$.info.vod_play_url","roadSeparator":"$$$","episodeSeparator":"#","fieldSeparator":"$","episodePage":{"url":"https://pl.girigirilove.com/addons/aplyer/atom.php","query":{"key":"0","url":"@episodeUrl"}}},"searchURL":"","searchList":"","searchName":"","searchResult":"","chapterRoads":"","chapterResult":"","referer":""},   // giriGiriLove.json v2.7
    "akianime": {"api":"4","type":"anime","name":"akianime","version":"1.4","muliSources":true,"useWebview":true,"useNativePlayer":true,"useLegacyParser":false,"userAgent":"","baseURL":"https://www.akianime.cc/","searchURL":"https://www.akianime.cc/bgmsearch/-------------.html?wd=@keyword","searchList":"//div[@class='vod-detail style-detail cor4 search-list']","searchName":"//div/div[2]/a/h3","searchResult":"//div/div[2]/div/div[1]/a","chapterRoads":"//ul[@class='anthology-list-play size']","chapterResult":"//li/a"},   // akianime.json v1.4
    "MXdm": {"api":"5","type":"anime","name":"MXdm","version":"2.4","muliSources":true,"useWebview":true,"useNativePlayer":true,"usePost":false,"useLegacyParser":false,"adBlocker":true,"userAgent":"","baseURL":"https://www.dcc3.com","searchURL":"https://www.dcc3.com/search/?wd=@keyword","searchList":"//div[contains(@class, 'search')]/ul/li","searchName":"//h3/a","searchResult":"//h3/a","chapterRoads":"//div[@class='playlist']/div[@class='row']/ul","chapterResult":"//li/a"},   // MXdm.json v2.4
    "ezdmw": {"api":"8","type":"anime","name":"ezdmw","version":"1.2","muliSources":true,"useWebview":true,"useNativePlayer":true,"usePost":false,"useLegacyParser":false,"adBlocker":false,"userAgent":"","baseURL":"https://m.ezdmw.org/","searchURL":"https://m.ezdmw.org/Index/search.html?searchText=@keyword","searchList":"//section[@id='some_drama']/div","searchName":"//p","searchResult":"//a","chapterRoads":"//section[@class='anthology'][1]/div[contains(@class,'line_button')]","chapterResult":"/self::*[@class='line_button_ban']/following-sibling::a[@class='circuit_switch_ban'] | /self::*[@class='line_button1']/following-sibling::a[@class='circuit_switch1'] | /self::*[@class='line_button3']/following-sibling::a[@class='circuit_switch3'] | /self::*[@class='line_button2']/following-sibling::a[@class='circuit_switch2']","referer":"https://m.ezdmw.org/","searchMode":"xpath","chapterMode":"xpath","antiCrawlerConfig":{"enabled":false}},   // ezdmw.json v1.2
    "AGE": {"api":"5","type":"anime","name":"AGE","version":"1.6","muliSources":true,"adBlocker":true,"useWebview":true,"useNativePlayer":true,"userAgent":"","baseURL":"https://www.agedm.io/","searchURL":"https://www.agedm.io/search?query=@keyword","searchList":"//div[2]/div/section/div/div/div/div","searchName":"//div/div[2]/h5/a","searchResult":"//div/div[2]/h5/a","chapterRoads":"//div[2]/div/section/div/div[2]/div[2]/div[2]/div","chapterResult":"//ul/li/a"}   // AGE.json v1.6
  };

  var RULE_PARSED = {};

  function ruleTier(name) {
    var status = RULE_STATUS[name];
    return status ? status.tier : 'unknown';
  }

  function entryConfig(scraperId) {
    // Nuvio builds the scraper id as "<repository>:<entry id>" on both hosts, so the manifest entry
    // this file is installed as is the suffix (the same switch kanju.js uses).
    var id = String(scraperId || '').toLowerCase().split(':').pop().split('/').pop();
    return { experimental: /(^|-)experimental(-|$)/.test(id) };
  }

  function ruleAllowed(name) {
    var tier = ruleTier(name);
    return tier === 'stable' || (run.experimental && tier === 'experimental');
  }

  function snapshotRule(name) {
    if (!Object.prototype.hasOwnProperty.call(RULE_SNAPSHOT, name)) return null;
    if (!RULE_PARSED[name]) RULE_PARSED[name] = parseRule(RULE_SNAPSHOT[name]);
    return RULE_PARSED[name];
  }

  async function fetchRemoteIndex() {
    var result = await httpText(RULES_RAW + 'index.json', { 'User-Agent': USER_AGENT, Accept: 'application/json' }, 0);
    if (result.status === 0) throw fail('NETWORK', '无法连接规则仓库（' + result.statusText + '）');
    if (!result.ok) throw fail('UPSTREAM_ERROR', '规则仓库 index.json 返回 ' + result.status);
    var list = parseJson(result.body);
    if (!Array.isArray(list)) throw fail('UPSTREAM_CHANGED', '规则仓库 index.json 无法解析');
    var names = {};
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name) names[String(list[i].name)] = true;
    return names;
  }

  async function fetchRemoteRule(name) {
    var result = await httpText(RULES_RAW + name + '.json', { 'User-Agent': USER_AGENT, Accept: 'application/json' }, 0);
    if (result.status === 0) throw fail('NETWORK', '无法连接规则仓库（' + result.statusText + '）');
    if (!result.ok) throw fail('UPSTREAM_ERROR', '规则文件 ' + name + '.json 返回 ' + result.status);
    var data = parseJson(result.body);
    if (!data) throw fail('UPSTREAM_CHANGED', '规则文件 ' + name + '.json 无法解析');
    var rule = parseRule(data);
    if (rule.name !== name) throw fail('UPSTREAM_CHANGED', '规则文件 ' + name + '.json 的 name 是 ' + rule.name);
    if (rule.deprecated) throw fail('DEPRECATED', '规则 ' + name + ' 已被标记为过时');
    return rule;
  }

  // ------------------------------------------------------------ one rule, end to end

  function makeWant(args, info) {
    // season = null: the absolute episode number of the whole show. TMDB's per-season counts say
    // which season it is in when they cover it; otherwise the number is used as it is.
    if (!args.absolute) return { season: args.season, episode: args.episode, absolute: false, mapped: false, absoluteEpisode: null };
    // ani.zip 的「第 N 集 → 季/集」最准：有就直接用站点的分季逻辑，不必按季累加去估
    var mapped = info.episodeMap && info.episodeMap[String(args.episode)];
    if (mapped) {
      return { season: mapped.season, episode: mapped.episode, absolute: false, mapped: true, absoluteEpisode: args.episode };
    }
    var place = locateAbsolute(info, args.episode);
    return place ? { season: place.season, episode: place.episode, absolute: false, mapped: true, absoluteEpisode: args.episode }
      : { season: null, episode: args.episode, absolute: true, mapped: false, absoluteEpisode: args.episode };
  }

  function wantedSeason(info, want) {
    for (var i = 0; i < info.seasons.length; i++) if (info.seasons[i].number === want.season) return info.seasons[i];
    return null;
  }

  function usableLength(road) { return road.urls.filter(isHttpUrl).length; }

  // Search results of one rule that name the show, best first: at most MAX_SEARCH_TITLES titles are
  // queried, and the first one that names the show ends the search.
  async function findEntries(rule, info, want) {
    var titles = searchTitles(info);
    var count = Math.min(titles.length, MAX_SEARCH_TITLES);
    var last = null;
    // tracker 条目（绝对集号）没有分季数据：一个片名的搜索结果常常只覆盖前几季，
    // 所以最多合并两个片名的结果，让后面几季的条目也进候选。
    var mergeLimit = info.flat ? 2 : 1;
    var merged = [];
    var mergedSeen = {};
    var accepted = 0;
    for (var t = 0; t < count; t++) {
      if (Date.now() > run.deadline) throw timeout('搜索 ' + rule.name);
      var found = await ruleSearch(rule, titles[t].text);
      var entries = rankEntries(found.items, info, want);
      last = { items: found.items, entries: entries, title: titles[t].text, status: found.status };
      if (entries.length) {
        accepted++;
        for (var m = 0; m < found.items.length; m++) {
          var key = String(found.items[m].src || found.items[m].name || m);
          if (mergedSeen[key]) continue;
          mergedSeen[key] = true;
          merged.push(found.items[m]);
        }
        if (accepted >= mergeLimit) break;
      } else if (accepted) {
        break;
      }
    }
    if (merged.length) {
      last = { items: merged, entries: rankEntries(merged, info, want), title: last ? last.title : '', status: last ? last.status : 200 };
    }
    if (!last || !last.entries.length) throw fail('NOT_FOUND', rule.name + ': 搜索结果里没有「' + (last ? last.title : '') + '」');
    info.hits[last.title] = (info.hits[last.title] || 0) + 1;
    return last;
  }

  // The entry, its road and the position in the road that hold the wanted episode.
  async function locateEpisode(rule, info, want, entries) {
    var cache = {};
    var fetches = 0;
    var season = wantedSeason(info, want);

    function roadsOf(entry) {
      var key = entry.item.src;
      if (Object.prototype.hasOwnProperty.call(cache, key)) return Promise.resolve(cache[key]);
      // tracker 条目按季拆成多个站点条目，逐条累加要读好几条剧集列表，预算放宽到 6 条。
      if (fetches >= (info.flat ? 6 : MAX_CHAPTER_FETCHES)) return Promise.resolve([]);
      if (Date.now() > run.deadline) return Promise.reject(timeout('剧集 ' + rule.name));
      fetches++;
      return ruleChapters(rule, entry.item).then(function (roads) { cache[key] = roads; return roads; }, function (error) {
        if (error.code === 'TIMEOUT') throw error;
        report(error);
        cache[key] = [];
        return [];
      });
    }
    function longest(roads) {
      var count = 0;
      for (var i = 0; i < roads.length; i++) count = Math.max(count, usableLength(roads[i]));
      return count;
    }
    // 只有一条线路、一个地址、标签里没有集号 —— 那是剧场版/合集/正片，不是某一集。
    // 剧集请求里命中它会把「第 1 集」换成一部剧场版（akianime 的「后篇自由之翼」就是这样来的）。
    function singleFeature(roads) {
      var total = 0, numbered = 0;
      for (var i = 0; i < roads.length; i++) {
        for (var j = 0; j < roads[i].names.length; j++) {
          total++;
          if (labelNumber(roads[i].names[j]) !== null) numbered++;
        }
      }
      return total > 0 && numbered === 0 && total <= 2;
    }

    function take(entry, position) {
      var roads = cache[entry.item.src];
      var road = chooseRoad(roads, position);
      if (!road) return null;
      var pick = pickEpisode(road, position);
      return pick ? { entry: entry, roads: roads, road: road, pick: pick, position: position } : null;
    }
    function byChain(a, b) { return a.chain - b.chain || a.order - b.order; }

    var heads = [], continuations = [], whole = [], others = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      // one head per season entry that starts the wanted season; its later parts and the later
      // seasons (chain >= 100) continue it
      if (entry.group === 'season' && entry.chain === 0) heads.push(entry);
      else if (entry.group === 'season') continuations.push(entry);
      else if (entry.group === 'whole') whole.push(entry);
      else others.push(entry);
    }
    continuations.sort(byChain);
    // a site that lists only "第三季 Part.2" and no plain "第三季": the lowest part starts the season
    if (!heads.length && continuations.length && continuations[0].chain < 50) heads.push(continuations.shift());
    others.sort(function (a, b) { return a.chain - b.chain || b.score - a.score || a.order - b.order; });

    // 0. tracker 条目（kitsu:/mal:/anilist:）没有 TMDB 分季数据。站点的动画往往按季拆成多个条目
    //    （进击的巨人 25 / 第二季 12 / 第三季 12 / 第三季 Part.2 10 / 最终季 16 …），绝对集号就是
    //    这些条目首尾相接的位置。所以按季号升序逐条累加，减到落点为止；季号解析不出来（「最终季」
    //    「完结篇」）的排在后面，用剩下的集号继续找。
    if (info.flat && entries.length) {
      // 季号排序：第 N 季按 N；裸标题当第一季；「最终季 / 完结篇 / Part.N」这类没有季号却排在后面的，
      // 用很大的 rank 让它们接在最后。
      var seasonRank = function (entry) {
        if (entry.marker !== null && entry.marker !== undefined) return entry.marker * 10 + entry.chain;
        var name = String(entry.item.name || '');
        if (/最终|終|完结篇|完結篇|final/i.test(name)) return 900 + entry.chain;
        return 10 + entry.chain;
      };
      var ordered = entries.slice().sort(function (a, b) {
        return seasonRank(a) - seasonRank(b) || b.score - a.score || a.order - b.order;
      });
      // ani.zip 已经说明是第几季时，只在该季的条目里累加；否则「只有第二季的站」会把第 1 集
      // 当成第二季第 1 集（akianime 的进击的巨人就是这样）。该季没有条目时才退回全表。
      if (want.season != null) {
        var nameOf = function (entry) { return String(entry.item.name || ''); };
        var sameSeason = ordered.filter(function (entry) {
          if (entry.marker != null) return entry.marker === want.season;
          // 没有季号的条目只有当「第一季」用；「最终季 / 完结篇」不算第一季
          return want.season === 1 && !FINAL_SEASON.test(nameOf(entry));
        });
        if (sameSeason.length) {
          ordered = sameSeason;
        } else {
          // 该季没有条目：整部条目只对第 1 季有意义，其余情况不猜（站点缺这一季）
          var wholeRow = ordered.filter(function (entry) {
            return entry.marker == null && !FINAL_SEASON.test(nameOf(entry));
          });
          ordered = want.season === 1 && wholeRow.length ? wholeRow : [];
          if (!ordered.length) {
            throw fail('NOT_FOUND', rule.name + ': 站点的条目里没有第 ' + want.season + ' 季');
          }
        }
      }
      var remaining = want.episode;
      var tried = 0;
      for (var f = 0; f < ordered.length && tried < 5 && Date.now() < run.deadline; f++) {
        var step = ordered[f];
        var flatRoads = await roadsOf(step);
        tried++;
        if (!flatRoads.length || singleFeature(flatRoads)) continue;
        var count = longest(flatRoads);
        if (!count) continue;
        // 站点有的条目自带连续编号（例如 29-38 接着上季），这时绝对集号就是条目标签本身，
        // 直接按标签取；只有从 1 开始编号的条目才用累加。
        var numbers = numberedRoad(flatRoads[0]);
        if (numbers && numbers.length && numbers[0] > 1 && numbers.indexOf(want.episode) >= 0) {
          var byLabel = take(step, want.episode);
          if (byLabel) {
            byLabel.whole = step.group === 'whole';
            emit('log', rule.name + ': 「' + step.item.name + '」按条目自带编号命中第 ' + want.episode + ' 项');
            return byLabel;
          }
        }
        if (remaining <= count) {
          var flatFound = take(step, remaining);
          if (flatFound) {
            flatFound.whole = step.group === 'whole';
            emit('log', rule.name + ': 绝对第 ' + want.episode + ' 集按季累加落在「' + step.item.name + '」第 ' + remaining + ' 项');
            return flatFound;
          }
          continue;                      // 这个条目点得进去但取不到地址，接着往后减
        }
        remaining -= count;
      }
    }

    // 1. the entries that name the wanted season, in the order of their parts; an entry of a later
    //    season continues the chain only while TMDB counts more episodes than were read so far.
    for (var h = 0; h < heads.length && h < 2; h++) {
      var chain = [heads[h]].concat(continuations);
      var before = 0;
      for (var c = 0; c < chain.length; c++) {
        var step = chain[c];
        if (c > 0 && step.marker !== null && step.marker > want.season && !(season && season.count > before)) break;
        var roads = await roadsOf(step);
        if (!roads.length || singleFeature(roads)) { if (c === 0) break; continue; }
        var position = want.episode - before;
        if (position >= 1) {
          var hit = take(step, position);
          if (hit) return hit;
        }
        if (c === 0 && position < 1) break;
        before += longest(roads);
      }
    }
    // 2. the bare title: one entry for every season, positions count from the first episode
    if (whole.length) {
      var offset = want.season ? seasonOffset(info, want.season) : 0;
      roads = await roadsOf(whole[0]);
      if (roads.length && !singleFeature(roads)) {
        var found = take(whole[0], want.episode + offset);
        if (found) { found.whole = true; return found; }
      }
    }
    // 3. an entry whose suffix names no season known to TMDB: the wanted number, as it is
    for (var o = 0; o < others.length && o < 2; o++) {
      roads = await roadsOf(others[o]);
      if (!roads.length || singleFeature(roads)) continue;
      var other = take(others[o], want.episode);
      if (other) return other;
    }
    throw fail('NOT_FOUND', rule.name + ': 没有第 ' + (want.absolute ? want.episode : want.season + ' 季第 ' + want.episode) + ' 集所在的条目');
  }

  function qualityOf(text) {
    var value = String(text || '');
    if (/4k|2160p/i.test(value)) return '4K';
    var match = /(\d{3,4})\s*p/i.exec(value);
    if (match) return match[1] + 'p';
    if (/高清|\bhd\b/i.test(value)) return 'HD';
    return '';
  }

  function languageOf(text) {
    var value = String(text || '');
    if (/国语|国語|中配|国配|普通话/.test(value)) return '国语';
    if (/粤语|粵語/.test(value)) return '粤语';
    return '';
  }

  function buildStream(rule, hit, media) {
    // Fields the hosts read: name, title, url, quality, language, headers. Empty values are left
    // out rather than shown blank by the host. The rule names the stream so the user sees its source.
    var label = String(hit.pick.label || '').trim() || '第' + hit.position + '集';
    var entryTitle = String(hit.entry.item.name || '');
    var stream = { name: rule.name + ' · ' + label, title: entryTitle + ' · ' + label, url: media.url };
    // 播放器要的请求头：来源站做 Referer（防盗链），站点发的 Cookie 一并带上。
    var headers = {};
    var agent = String(rule.userAgent || '').trim() || USER_AGENT;
    if (agent) headers['User-Agent'] = agent;
    var base = String(rule.baseURL || '').trim();
    if (base) headers.Referer = base;
    var cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (Object.keys(headers).length) stream.headers = headers;
    var quality = qualityOf(label) || qualityOf(hit.road.name);
    if (quality) stream.quality = quality;
    var language = languageOf(entryTitle);
    if (language) stream.language = language;
    return stream;
  }

  async function runRule(rule, info, want, wantFallback) {
    var found = await findEntries(rule, info, want);
    var best = found.entries[0];
    emit('log', rule.name + ': 搜索「' + found.title + '」得到 ' + found.items.length + ' 条，候选 ' + found.entries.length +
      '，首选「' + best.item.name + '」(' + best.group + ' ' + best.score + ')');
    var hit;
    try {
      hit = await locateEpisode(rule, info, want, found.entries);
    } catch (error) {
      if (error.code !== 'NOT_FOUND' || Date.now() > run.deadline) throw error;
      // 两条退路：① TMDB 的季集落在站点别的位置；② TMDB 的分季跟站点不一样（咒术回战 TMDB 把两季
      // 合成 S1=59，站点却是 24+23），这时按站点自己的条目顺序累加才对。
      var attempts = [];
      if (wantFallback) attempts.push({ want: wantFallback, info: info });
      if (want.absoluteEpisode) {
        var flatInfo = {};
        for (var own in info) if (Object.prototype.hasOwnProperty.call(info, own)) flatInfo[own] = info[own];
        flatInfo.flat = true;
        attempts.push({
          want: { season: null, episode: want.absoluteEpisode, absolute: true, mapped: false, absoluteEpisode: want.absoluteEpisode },
          info: flatInfo,
        });
      }
      var lastError = error;
      for (var a = 0; a < attempts.length && !hit; a++) {
        var plan = attempts[a];
        var again = rankEntries(found.items, plan.info, plan.want);
        if (!again.length) continue;
        try {
          hit = await locateEpisode(rule, plan.info, plan.want, again);
          emit('log', rule.name + ': 换用站点自己的分季顺序命中');
        } catch (retryError) {
          lastError = retryError;
          if (retryError.code !== 'NOT_FOUND') throw retryError;
        }
      }
      if (!hit) throw lastError;
    }
    emit('log', rule.name + ':「' + hit.entry.item.name + '」线路「' + hit.road.name + '」第 ' + hit.position + ' 项 =「' +
      hit.pick.label + '」' + (hit.pick.byLabel ? '(按集号)' : '(按位置)') + (hit.whole ? ' [整部条目]' : ''));

    // The same episode from the other roads of the entry is offered as well, while there is time.
    var roads = [hit.road];
    if (Date.now() < run.verifyUntil) {
      for (var r = 0; r < hit.roads.length && roads.length < MAX_ROADS_PER_ENTRY; r++) {
        if (hit.roads[r] !== hit.road && usableLength(hit.roads[r]) >= hit.position) roads.push(hit.roads[r]);
      }
    }
    var streams = [];
    for (var i = 0; i < roads.length; i++) {
      if (Date.now() > run.deadline) break;
      var pick = roads[i] === hit.road ? hit.pick : pickEpisode(roads[i], hit.position);
      if (!pick || !isHttpUrl(pick.url)) continue;
      var media;
      try { media = await resolveVideo(rule, pick, pick.url); }
      catch (error) { if (error.code === 'TIMEOUT') throw error; report(error); continue; }
      streams.push(buildStream(rule, { entry: hit.entry, road: roads[i], pick: pick, position: hit.position }, media));
      emit('log', rule.name + ': ' + media.how + ' → ' + (media.verified ? '已确认' : '未验证') + ' ' + media.kind + ' ' + media.url.slice(0, 110));
    }
    if (!streams.length) throw fail('NOT_FOUND', rule.name + ': 没有可播放的地址');
    return streams;
  }

  // -------------------------------------------------------------- entry point

  // Per-call state. Nuvio kills a provider after 60 s and one request may hang for the stack's
  // 30 s (NuvioTV), so nothing new starts after SOFT_DEADLINE_MS; a dropped connection is not
  // retried after RETRY_BUDGET_MS; an address is confirmed, and more roads are read, only while
  // VERIFY_UNTIL_MS lasts; the rule repository is only asked while REMOTE_UNTIL_MS lasts.
  var run = { deadline: 0, retryUntil: 0, verifyUntil: 0, remoteUntil: 0, experimental: false, jar: {} };

  function parseArgs(tmdbId, mediaType, season, episode) {
    var id = String(tmdbId === undefined || tmdbId === null ? '' : tmdbId).trim();
    var type = String(mediaType || '').toLowerCase();
    // 动画条目的 videoId 是 kitsu:/mal:/anilist:/anidb: 三段式（NuvioTV
    // PluginEpisodeRequestRules.kt）；转不到 TMDB 时宿主把它原样传进来，season = null、
    // episode = 绝对集号。这里照样接住，片名改由 tracker 的 API 提供。
    var tracker = TRACKER_ID.exec(id);
    if (tracker) {
      var trackerEpisode = tracker[3] ? Number(tracker[3]) : null;
      var absolute = Number(episode);
      if (!isFinite(absolute) || Math.floor(absolute) !== absolute || absolute < 1) {
        absolute = trackerEpisode;
      }
      if (!isFinite(absolute) || !absolute || absolute < 1) {
        throw fail('BAD_ARGUMENT', '需要集编号（收到 ' + (episode === undefined || episode === null ? '空' : episode) + '）');
      }
      if (type === 'movie') throw fail('BAD_ARGUMENT', 'Kazumi 规则只有动画剧集，没有电影');
      return {
        tmdbId: null,
        tracker: { kind: tracker[1].toLowerCase(), id: tracker[2] },
        episode: absolute,
        season: null,
        absolute: true,
      };
    }
    if (!/^\d+$/.test(id)) {
      throw fail('BAD_ARGUMENT', '只支持 TMDB 数字 ID 或 kitsu:/mal:/anilist: ID（收到 ' + (id || '空') + '）');
    }
    if (type === 'movie') throw fail('BAD_ARGUMENT', 'Kazumi 规则只有动画剧集，没有电影');
    if (type !== 'tv' && type !== 'series' && type !== 'show') throw fail('BAD_ARGUMENT', '不支持的媒体类型：' + (type || '空'));
    var e = Number(episode);
    if (episode === undefined || episode === null || !isFinite(e) || Math.floor(e) !== e || e < 1) {
      throw fail('BAD_ARGUMENT', '需要集编号（收到 ' + (episode === undefined || episode === null ? '空' : episode) + '）');
    }
    var args = { tmdbId: id, episode: e, season: null, absolute: true };
    if (season === undefined || season === null) return args;     // the absolute episode number
    var s = Number(season);
    if (!isFinite(s) || Math.floor(s) !== s) throw fail('BAD_ARGUMENT', '季编号不是整数：' + season);
    if (s === 0) throw fail('NOT_FOUND', '特别篇（第 0 季）不在规则的剧集列表里');
    if (s < 1) throw fail('BAD_ARGUMENT', '季编号从 1 开始');
    args.season = s;
    args.absolute = false;
    return args;
  }

  async function getStreams(tmdbId, mediaType, season, episode) {
    var started = Date.now();
    run.deadline = started + SOFT_DEADLINE_MS;
    run.retryUntil = started + RETRY_BUDGET_MS;
    run.verifyUntil = started + VERIFY_UNTIL_MS;
    run.remoteUntil = started + REMOTE_UNTIL_MS;
    var streams = [];
    var seen = {};
    var budget = { tried: 0, succeeded: 0 };
    var finished = {};
    try {
      var args = parseArgs(tmdbId, mediaType, season, episode);
      run.experimental = entryConfig(typeof SCRAPER_ID === 'string' ? SCRAPER_ID : '').experimental;
      emit('log', 'v' + VERSION + (run.experimental ? ' (+experimental)' : '') + ' id=' +
        (args.tracker ? args.tracker.kind + ':' + args.tracker.id : args.tmdbId) + ' ' +
        (args.absolute ? '绝对第 ' + args.episode + ' 集' : 'S' + args.season + 'E' + args.episode));

      var info = args.tracker ? await trackerInfo(args) : await tmdbInfo(args.tmdbId);
      await augmentTitles(info);
      indexTitles(info);
      var want = makeWant(args, info);
      var wantFallback = want.mapped ? { season: null, episode: args.episode, absolute: true, mapped: false } : null;
      if (args.absolute) emit('log', '绝对集号 ' + args.episode +
        (want.mapped ? ' 按 TMDB 分季 = S' + want.season + 'E' + want.episode : ' 没有分季信息，按整部条目的位置'));

      var attempt = async function (rule) {
        try {
          var produced = await runRule(rule, info, want, wantFallback);
          for (var s = 0; s < produced.length; s++) {
            if (seen[produced[s].url]) continue;
            seen[produced[s].url] = true;
            streams.push(produced[s]);
          }
          finished[rule.name] = true;
          budget.succeeded++;
        } catch (error) {
          // 一条规则卡住不该把整次调用拖死：还有预算就换下一条规则。
          if (error.code === 'TIMEOUT' && Date.now() < run.deadline - 2000) {
            report(error);
          } else {
            throw error;
          }
        }
      };
      var exhausted = function (limit) {
        return budget.tried >= limit || streams.length >= MAX_STREAMS || budget.succeeded >= MAX_RULES_WITH_STREAMS || Date.now() > run.deadline;
      };

      // Phase 1: the embedded definitions of the allowed rules, without touching GitHub.
      for (var i = 0; i < RULE_ORDER.length && !exhausted(MAX_RULES_TRIED); i++) {
        var name = RULE_ORDER[i];
        if (!ruleAllowed(name) || !snapshotRule(name) || finished[name]) continue;
        budget.tried++;
        await attempt(snapshotRule(name));
      }

      // Phase 2: index.json, then the repository's file of each remaining allowed rule. A rule that
      // index.json no longer lists was deprecated upstream and is skipped.
      var pending = RULE_ORDER.some(function (name) { return ruleAllowed(name) && !finished[name]; });
      if (pending && !exhausted(MAX_RULES_TRIED_TOTAL) && Date.now() < run.remoteUntil) {
        var index = null;
        try {
          index = await fetchRemoteIndex();
          emit('log', '规则仓库 index.json: ' + Object.keys(index).length + ' 条规则');
        } catch (error) {
          emit('warn', '规则仓库不可用，只用内置快照: ' + (error.code ? error.code : '') + ' ' + error.message);
        }
        // at most two rules are tried again with the repository's file: enough to recover from a
        // stale snapshot without repeating every failure of the first phase
        var refreshed = 0;
        for (i = 0; index && i < RULE_ORDER.length && refreshed < MAX_REMOTE_REFRESH && !exhausted(MAX_RULES_TRIED_TOTAL); i++) {
          name = RULE_ORDER[i];
          if (!ruleAllowed(name) || finished[name] || !index[name]) continue;
          refreshed++;
          var rule;
          try { rule = await fetchRemoteRule(name); }
          catch (error) { report(error); break; }        // the repository is not answering: stop asking
          budget.tried++;
          await attempt(rule);
        }
      }

      emit('log', '返回 ' + streams.length + ' 条线路，试了 ' + budget.tried + ' 次规则，用时 ' + (Date.now() - started) + ' ms');
      return streams;
    } catch (error) {
      report(error);
      return [];
    }
  }

  module.exports = { getStreams: getStreams };
  // Exposed only so test/ can exercise the pure helpers; the host never calls these.
  module.exports.internals = {
    version: VERSION,
    parseHtml: parseHtml,
    xpathQuery: xpathQuery,
    jpRead: jpRead,
    jpFirst: jpFirst,
    normalizeEpisodeUrl: normalizeEpisodeUrl,
    renderTemplate: renderTemplate,
    encodeQueryComponent: encodeQueryComponent,
    base64Decode: base64Decode,
    decodeCarrier: decodeCarrier,
    parseRule: parseRule,
    prepareApiRequest: prepareApiRequest,
    prepareXpathSearch: prepareXpathSearch,
    parseApiSearch: parseApiSearch,
    parseApiChapters: parseApiChapters,
    parseXpathSearch: parseXpathSearch,
    parseXpathChapters: parseXpathChapters,
    resolveEpisodeUrl: resolveEpisodeUrl,
    tmdbTitles: tmdbTitles,
    searchTitles: searchTitles,
    indexTitles: indexTitles,
    locateAbsolute: locateAbsolute,
    seasonOffset: seasonOffset,
    nameSignature: nameSignature,
    describeEntry: describeEntry,
    rankEntries: rankEntries,
    labelNumber: labelNumber,
    pickEpisode: pickEpisode,
    chooseRoad: chooseRoad,
    playerConfigUrl: playerConfigUrl,
    readPage: readPage,
    looksLikeMedia: looksLikeMedia,
    parseArgs: parseArgs,
    makeWant: makeWant,
    entryConfig: entryConfig,
    qualityOf: qualityOf,
    ruleStatus: RULE_STATUS,
    ruleOrder: RULE_ORDER,
    snapshot: RULE_SNAPSHOT,
  };
})();
