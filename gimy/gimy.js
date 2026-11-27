/**
 * Nuvio plugin for Gimy TV (gimytv.io).
 *
 * getStreams(tmdbId, "movie"|"tv", season, episode) → m3u8 / mp4.
 *
 * The site is server-rendered, no Cloudflare challenge, and every step is plain HTML:
 *
 *   search   GET  https://gimytv.io/search?q=<title>        (301 → gimytw.cc, host follows)
 *   detail   GET  /voddetail2/{id}.html                     → ul#con_playlist_1 a[href="/eps/{id}-{n}.html"]
 *   episode  GET  /eps/{id}-{n}.html                        → iframe src="/_watch/{token}"
 *   player   GET  /_watch/{token}                           → an .m3u8 in the page source
 *
 * Titles come from TMDB with the key the host injects (never embedded here). When a title is
 * unknown to TMDB the plugin falls back to ani.zip's mapping, which also gives the season/episode
 * coordinates for anime-style absolute numbering.
 *
 * Promise chains only: older Nuvio builds reject asynchronous functions in dynamically loaded code.
 */
(function () {
  var VERSION = '1.1.0';
  var TAG = '[gimy]';
  var SITE = 'https://gimytv.io';
  var TMDB_API = 'https://api.themoviedb.org/3';
  var ANIZIP_API = 'https://api.ani.zip/mappings';
  var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  var TMDB_LANGUAGES = ['zh TW', 'zh HK', 'zh CN', 'ja JP', 'ko KR', 'en US'];
  var TMDB_REGIONS = /^(CN|HK|TW|SG|US|GB|JP|KR)$/;
  var MAX_TITLES = 4;
  var DEADLINE_MS = 34000;

  function emit(level, message) {
    var line = TAG + ' ' + message;
    try {
      if (typeof console[level] === 'function') console[level](line);
      else console.log(line);
    } catch (e) { /* nothing else we can do */ }
  }

  function fail(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  function tmdbKey() {
    return typeof TMDB_API_KEY === 'string' ? TMDB_API_KEY.trim() : '';
  }

  function httpText(url, headers) {
    return fetch(url, { headers: headers || {}, redirect: 'follow' }).then(function (response) {
      return response.text().then(function (body) {
        return { ok: !!response.ok, status: Number(response.status) || 0, body: body || '', url: String(response.url || url) };
      });
    }).catch(function (error) {
      return { ok: false, status: 0, body: '', url: url, error: error };
    });
  }

  function httpJson(url, headers) {
    return httpText(url, headers).then(function (result) {
      if (!result.ok) throw fail(result.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', url.split('/')[2] + ' 返回 ' + result.status);
      try {
        return JSON.parse(result.body);
      } catch (e) {
        throw fail('UPSTREAM_CHANGED', url.split('/')[2] + ' 返回了无法解析的数据');
      }
    });
  }

  function formQuery(map) {
    var parts = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      if (map[key] === undefined || map[key] === null || map[key] === '') continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(map[key]));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function tmdb(path, query) {
    return httpJson(TMDB_API + path + formQuery(query) + (String(TMDB_API + path + formQuery(query)).indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(tmdbKey()));
  }

  // ------------------------------------------------------------------ 片名
  function pushTitle(list, seen, value, rank) {
    var text = String(value || '').trim();
    if (text.length < 2 || seen[text]) return;
    seen[text] = true;
    list.push({ text: text, rank: rank });
  }

  function tmdbTitles(data, isMovie) {
    var titles = [], seen = {};
    pushTitle(titles, seen, isMovie ? data.title : data.name, 1);
    pushTitle(titles, seen, isMovie ? data.original_title : data.original_name, 1);
    var translations = (data.translations && data.translations.translations) || [];
    for (var i = 0; i < TMDB_LANGUAGES.length; i++) {
      var want = TMDB_LANGUAGES[i].split(' ');
      for (var t = 0; t < translations.length; t++) {
        var entry = translations[t];
        if (entry.iso_639_1 !== want[0]) continue;
        if (want[1] && entry.iso_3166_1 !== want[1]) continue;
        pushTitle(titles, seen, entry.data && (entry.data.title || entry.data.name), 2);
      }
    }
    var alts = (data.alternative_titles && (data.alternative_titles.titles || data.alternative_titles.results)) || [];
    for (var a = 0; a < alts.length; a++) {
      if (TMDB_REGIONS.test(String(alts[a].iso_3166_1 || ''))) pushTitle(titles, seen, alts[a].title, 3);
    }
    return titles;
  }

  function yearOf(value) {
    var m = /^((?:19|20)\d{2})/.exec(String(value || ''));
    return m ? Number(m[1]) : null;
  }

  // ------------------------------------------------------------------ 站点
  function seasonOf(title) {
    var text = String(title || '');
    var m = /第\s*(\d+)\s*[季期部]/.exec(text);
    if (m) return Number(m[1]);
    m = /第\s*([一二三四五六七八九十]+)\s*[季期部]/.exec(text);
    if (m) {
      var digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      var parts = m[1].split('十');
      var number = parts.length === 2 ? (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0) : digits[m[1]];
      if (number) return number;
    }
    m = /\bS\s*0*(\d{1,2})\b/i.exec(text) || /Season\s*(\d{1,2})/i.exec(text);
    return m ? Number(m[1]) : null;
  }


  // 繁→简 + 常见异体字，只用于比较片名（祕/秘、裏/里 这类会直接让片名对不上）。
  var VARIANT_PAIRS = ["擊击", "進进", "龍龙", "劍剑", "戰战", "學学", "園园", "貓猫", "戀恋", "愛爱", "時时", "間间", "頭头", "們们", "說说", "劇剧", "場场", "鬥斗", "靈灵", "獸兽", "島岛", "夢梦", "藥药", "銀银", "車车", "軍军", "隊队", "門门", "開开", "關关", "麼么", "樣样", "這这", "來来", "對对", "無无", "與与", "為为", "業业", "樂乐", "從从", "會会", "還还", "讓让", "記记", "憶忆", "風风", "雲云", "電电", "話话", "誰谁", "殺杀", "復复", "興兴", "傳传", "讀读", "書书", "寫写", "體体", "點点", "兩两", "幾几", "內内", "別别", "則则", "剛刚", "動动", "勝胜", "勢势", "區区", "醫医", "華华", "萬万", "葉叶", "藝艺", "處处", "號号", "蟲虫", "術术", "補补", "裝装", "見见", "觀观", "規规", "視视", "覺觉", "訂订", "計计", "訓训", "設设", "試试", "詩诗", "該该", "認认", "語语", "誠诚", "誤误", "請请", "諾诺", "課课", "調调", "談谈", "論论", "證证", "護护", "變变", "贊赞", "貝贝", "負负", "財财", "貨货", "販贩", "責责", "貴贵", "買买", "費费", "資资", "賽赛", "趕赶", "軌轨", "轉转", "輪轮", "農农", "遠远", "選选", "遺遗", "郵邮", "鄉乡", "釋释", "鑑鉴", "長长", "閃闪", "閉闭", "閒闲", "問问", "間间", "閨闺", "陣阵", "陰阴", "陸陆", "陽阳", "隨随", "險险", "隱隐", "雙双", "雜杂", "難难", "霧雾", "靜静", "響响", "頁页", "頂顶", "項项", "順顺", "須须", "預预", "頓顿", "領领", "頻频", "顆颗", "題题", "願愿", "類类", "顯显", "飛飞", "養养", "餘余", "馬马", "驗验", "髮发", "魚鱼", "鳥鸟", "麗丽", "黃黄", "齊齐", "齒齿", "齡龄", "麵面", "祕秘", "裡里", "裏里", "週周", "臺台", "佈布", "佔占", "傢家", "峯峰", "綫线", "鷄鸡", "敎教", "於于", "祇只", "牠它", "啟启", "兇凶", "嚮向", "囪囱", "喫吃", "夥伙", "衆众", "跡迹", "鵰雕"];
  var VARIANT_MAP = null;
  function fold(text) {
    if (!VARIANT_MAP) {
      VARIANT_MAP = {};
      for (var i = 0; i < VARIANT_PAIRS.length; i++) {
        var pair = VARIANT_PAIRS[i];
        if (pair.length === 2) VARIANT_MAP[pair.charAt(0)] = pair.charAt(1);
      }
    }
    var value = String(text || ''), out = '';
    for (var j = 0; j < value.length; j++) {
      var ch = value.charAt(j);
      out += VARIANT_MAP[ch] || ch;
    }
    return out;
  }

  function norm(value) {
    return fold(String(value || '')).toLowerCase().replace(/[\s\u3000]+/g, '')
      .replace(/[：:·・,，.。!！?？'"“”‘’\-—_()（）\[\]【】/]/g, '');
  }

  function baseTitle(name) {
    return String(name || '')
      .replace(/第\s*[0-9一二三四五六七八九十]+\s*[季期部]/g, ' ')
      .replace(/\bS\s*\d{1,2}\b/gi, ' ')
      .replace(/Season\s*\d{1,2}/gi, ' ')
      .replace(/[\[【(（][^\]】)）]{0,20}[\]】)）]/g, ' ');
  }

  function scoreTitle(name, titles) {
    var key = norm(name);
    var base = norm(baseTitle(name));
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var q = norm(titles[i].text);
      var qb = norm(baseTitle(titles[i].text));
      if (!q || !key) continue;
      if (base && qb && base === qb) { best = Math.max(best, 95); continue; }
      if (key === q || (base && base === q)) { best = Math.max(best, 100); continue; }
      if (key.indexOf(q) !== -1 || q.indexOf(key) !== -1) best = Math.max(best, 70);
    }
    return best;
  }

  /** 列表卡片：a.video-pic[data-original][href="/eps/{id}-{ep}.html"] + h5 a[href="/voddetail2/{id}.html"] */
  function cardsFrom(html) {
    var out = [], seen = {};
    var re = /<li[^>]*>([\s\S]*?)<\/li>/gi, block;
    while ((block = re.exec(html))) {
      var chunk = block[1];
      var link = /href="\/voddetail2\/(\d+)\.html"/i.exec(chunk);
      if (!link || seen[link[1]]) continue;
      var titleMatch = />([^<]{2,80})<\/a>/i.exec(chunk);
      var title = titleMatch ? titleMatch[1].trim() : '';
      if (!title) continue;
      seen[link[1]] = true;
      var pic = /data-original="([^"]+)"/i.exec(chunk);
      var note = /class="note[^"]*"[^>]*>([^<]{0,20})</i.exec(chunk);
      out.push({
        id: link[1],
        name: title,
        cover: pic ? pic[1] : '',
        remark: note ? note[1].trim() : '',
      });
    }
    return out;
  }

  function searchSite(title) {
    return httpText(SITE + '/search' + formQuery({ q: title }), { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' })
      .then(function (result) {
        if (!result.ok) throw fail('UPSTREAM_ERROR', '搜索返回 ' + result.status);
        return cardsFrom(result.body);
      });
  }

  function episodeLinks(html, id) {
    var re = new RegExp('href="/eps/' + id + '-(\\d+)\\.html"[^>]*>([^<]{0,24})<', 'g');
    var out = [], seen = {}, m;
    while ((m = re.exec(html))) {
      if (seen[m[1]]) continue;
      seen[m[1]] = true;
      var label = String(m[2] || '').trim();
      var num = /(\d+(?:\.\d+)?)/.exec(label);
      out.push({ id: m[1], label: label || ('第' + m[1] + '集'), number: num ? Number(num[1]) : null });
    }
    out.sort(function (a, b) {
      var na = a.number == null ? Number(a.id) : a.number;
      var nb = b.number == null ? Number(b.id) : b.number;
      return na - nb;
    });
    return out;
  }

  function detail(id, titles) {
    return httpText(SITE + '/voddetail2/' + id + '.html', { 'User-Agent': UA, 'Referer': SITE + '/' })
      .then(function (result) {
        if (!result.ok) throw fail('UPSTREAM_ERROR', '详情返回 ' + result.status);
        var h1 = /<h1[^>]*>([\s\S]{0,120}?)<\/h1>/i.exec(result.body);
        var name = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : '';
        var episodes = episodeLinks(result.body, id);
        if (!name) throw fail('UPSTREAM_CHANGED', '详情页没有片名');
        if (!episodes.length) throw fail('CONTENT_LOCKED', '详情页没有可播集数');
        return { id: id, name: name, episodes: episodes, score: titles ? scoreTitle(name, titles) : 0 };
      });
  }

  /** 选择条目：base 名必须精确相等（「進擊的巨人 LOST GIRLS」「劇場版…」都不算同一部），季要能对上 */
  function pickEntry(candidates, titles, wantedSeason) {
    if (!candidates.length) return null;
    var wanted = titles.map(function (t) { return norm(baseTitle(t.text)); }).filter(function (v) { return v.length >= 2; });
    var scored = candidates.map(function (card) {
      return { card: card, score: scoreTitle(card.name, titles), base: norm(baseTitle(card.name)) };
    }).filter(function (row) {
      if (!row.base || wanted.indexOf(row.base) === -1) return false;
      return row.score >= 65;
    });
    if (!scored.length) return null;
    scored.sort(function (a, b) {
      var sa = seasonOf(a.card.name), sb = seasonOf(b.card.name);
      var wantA = wantedSeason == null ? 0 : (sa === wantedSeason ? 2 : (sa == null && wantedSeason === 1 ? 1 : 0));
      var wantB = wantedSeason == null ? 0 : (sb === wantedSeason ? 2 : (sb == null && wantedSeason === 1 ? 1 : 0));
      return wantB - wantA || b.score - a.score || a.card.name.length - b.card.name.length;
    });
    return scored[0].card;
  }

  /** ani.zip：TMDB id → 片名（含 zh-Hant）与「第几季第几集 → 绝对第几集」的反查表 */
  function anizipByTmdb(id) {
    var url = ANIZIP_API + '?themoviedb_id=' + encodeURIComponent(id);
    return httpText(url, { 'User-Agent': UA, Accept: 'application/json' }).then(function (result) {
      if (!result.ok) return null;
      var data = null;
      try { data = JSON.parse(result.body); } catch (e) { return null; }
      if (!data) return null;
      var titles = [];
      var map = data.titles || {};
      ['zh-Hant', 'zh-Hans', 'zh-TW', 'ja', 'x-jat'].forEach(function (key) {
        if (map[key]) titles.push({ text: String(map[key]), rank: 2 });
      });
      var absolute = {};
      var episodes = data.episodes || {};
      for (var key in episodes) {
        if (!Object.prototype.hasOwnProperty.call(episodes, key)) continue;
        var row = episodes[key];
        if (!row || row.seasonNumber == null || row.episodeNumber == null) continue;
        absolute[row.seasonNumber + ':' + row.episodeNumber] = Number(key);
      }
      return { titles: titles, absolute: absolute };
    }).catch(function () { return null; });
  }

  function absoluteNumber(seasons, season, episode) {
    var sum = 0;
    for (var i = 0; i < (seasons || []).length; i++) {
      var row = seasons[i];
      var n = Number(row.season_number);
      if (n >= 1 && n < Number(season || 1)) sum += Number(row.episode_count) || 0;
    }
    return sum + Number(episode || 1);
  }

  function pickEpisode(episodes, wanted, episodeNumber) {
    if (!episodes.length) return null;
    var byNumber = episodes.filter(function (ep) { return ep.number === wanted; });
    if (byNumber.length === 1) return byNumber[0];
    var index = Number(wanted) - 1;
    if (index >= 0 && index < episodes.length) return episodes[index];
    if (episodeNumber) {
      var fallback = episodes.filter(function (ep) { return ep.number === episodeNumber; });
      if (fallback.length === 1) return fallback[0];
    }
    return null;
  }

  function resolveStream(mediaId, episodeId) {
    return httpText(SITE + '/eps/' + mediaId + '-' + episodeId + '.html', { 'User-Agent': UA, 'Referer': SITE + '/voddetail2/' + mediaId + '.html' })
      .then(function (result) {
        if (!result.ok) throw fail('UPSTREAM_ERROR', '分集页返回 ' + result.status);
        var watch = /\/_watch\/(\d+)/.exec(result.body);
        if (!watch) throw fail('UPSTREAM_CHANGED', '分集页没有播放器入口');
        return httpText(SITE + '/_watch/' + watch[1], { 'User-Agent': UA, 'Referer': SITE + '/' }).then(function (page) {
          if (!page.ok) throw fail('UPSTREAM_ERROR', '播放页返回 ' + page.status);
          var stream = /https?:\/\/[^"'<> ]+\.m3u8[^"'<> ]*/i.exec(page.body);
          if (!stream) throw fail('CONTENT_LOCKED', '播放页没有 m3u8 地址');
          return stream[0];
        });
      });
  }

  // ------------------------------------------------------------------ 入口
  function getStreams(tmdbId, mediaType, season, episode) {
    var started = Date.now();
    var id = String(tmdbId == null ? '' : tmdbId).trim().replace(/^(tmdb|movie|series):/i, '').split(':')[0];
    var type = String(mediaType || '').toLowerCase();
    var isMovie = type === 'movie';
    if (!/^\d+$/.test(id)) {
      emit('warn', '只支持数字 TMDB ID（收到 ' + (id || '空') + '）');
      return Promise.resolve([]);
    }
    if (!tmdbKey()) {
      emit('warn', 'HOST_UNSUPPORTED 宿主没有提供 TMDB_API_KEY');
      return Promise.resolve([]);
    }
    var path = (isMovie ? '/movie/' : '/tv/') + id;
    var wantedSeason = isMovie ? null : (Number(season) >= 1 ? Number(season) : 1);
    var wantedEpisode = isMovie ? 1 : (Number(episode) >= 1 ? Number(episode) : 1);

    return tmdb(path, { language: 'zh-CN', append_to_response: 'translations,alternative_titles' })
      .catch(function (error) {
        if (error.code === 'NOT_FOUND') throw error;
        return tmdb(path, { language: 'zh-CN' });
      })
      .then(function (data) {
        var titles = tmdbTitles(data, isMovie);
        if (!titles.length) throw fail('NOT_FOUND', 'TMDB 没有这部电影/剧集的片名');
        // ani.zip 补两样：zh-Hant 片名（站点常写繁体）与「第几季第几集 → 绝对第几集」的坐标
        var zip = isMovie ? Promise.resolve(null) : anizipByTmdb(id);
        return zip.then(function (extra) {
          if (extra && extra.titles.length) {
            var seen = {};
            titles.forEach(function (t) { seen[t.text] = true; });
            extra.titles.forEach(function (t) { if (!seen[t.text]) { seen[t.text] = true; titles.push(t); } });
          }
          var mapped = extra && extra.absolute ? extra.absolute[wantedSeason + ':' + wantedEpisode] : null;
          var absolute = isMovie ? 1 : (mapped != null ? mapped : absoluteNumber(data.seasons, wantedSeason, wantedEpisode));
        emit('log', 'v' + VERSION + ' id=' + id + ' ' + (isMovie ? 'movie' : 'S' + wantedSeason + 'E' + wantedEpisode + '（绝对 ' + absolute + '）') + ' 片名 ' + titles.slice(0, 3).map(function (t) { return t.text; }).join(' / '));

        var queue = titles.slice(0, MAX_TITLES);
        var step = function (index) {
          if (index >= queue.length) return Promise.resolve(null);
          if (Date.now() - started > DEADLINE_MS) return Promise.resolve(null);
          return searchSite(queue[index].text).then(function (cards) {
            if (!cards.length) return step(index + 1);
            var card = pickEntry(cards, titles, wantedSeason);
            if (!card) return step(index + 1);
            return detail(card.id, titles).then(function (info) {
              var wanted = isMovie ? 1 : absolute;
              var picked = pickEpisode(info.episodes, wanted, wantedEpisode);
              if (!picked) {
                emit('warn', '「' + info.name + '」有 ' + info.episodes.length + ' 集，没有第 ' + wanted + ' 集');
                return step(index + 1);
              }
              return resolveStream(info.id, picked.id).then(function (url) {
                emit('log', '命中「' + info.name + '」' + picked.label + ' → ' + url.slice(0, 80));
                return {
                  name: 'Gimy · ' + picked.label,
                  title: info.name + ' · ' + picked.label,
                  url: url,
                  quality: 'HD',
                  type: 'm3u8',
                  language: 'zh',
                  headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
                };
              });
            });
          }).catch(function (error) {
            emit('warn', queue[index].text + ': ' + (error.code || '') + ' ' + error.message);
            return step(index + 1);
          });
        };

        return step(0).then(function (stream) {
          if (!stream) {
            emit('warn', '没有匹配到可播放的条目');
            return [];
          }
          return [stream];
        });
        });
      })
      .catch(function (error) {
        emit('error', error.code + ': ' + error.message);
        return [];
      });
  }

  module.exports = { getStreams: getStreams };
  module.exports.internals = { version: VERSION, tmdbTitles: tmdbTitles, cardsFrom: cardsFrom, seasonOf: seasonOf, episodeLinks: episodeLinks, absoluteNumber: absoluteNumber, pickEpisode: pickEpisode, pickEntry: pickEntry };
})();
