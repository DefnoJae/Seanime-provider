class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
    this.API_MIRROR = "https://chad.anidap.lol";
    this.GRAPHQL = "https://graphql.animex.one/graphql";
    this.CDN_PROXY = "https://cdnx.aniwatchtv.site";
    this.UWU_KEY = "10b06cdc1ca48c9fb0b94af97cc040cf";
    this.UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
  }

  getSettings() {
    return {
      episodeServers: ["AnimeX Sub", "AnimeX Dub"],
      supportsDub: true,
    };
  }

  async getJSON(url, options) {
    const config = options || {};
    const headers = Object.assign({
      Accept: "application/json",
      "User-Agent": this.UA,
      Origin: this.ANIMEX,
      Referer: this.ANIMEX + "/",
    }, config.headers || {});

    const response = await fetch(url, Object.assign({}, config, {
      method: config.method || "GET",
      headers: headers,
    }));

    if (!response.ok) {
      throw new Error("AnimeX API request failed: HTTP " + response.status);
    }

    const json = await response.json();
    if (json && Array.isArray(json.errors) && json.errors.length) {
      throw new Error("AnimeX GraphQL request failed: " + (json.errors[0].message || "unknown error"));
    }
    return json;
  }

  async graphql(query, variables) {
    return await this.getJSON(this.GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    });
  }

  cleanText(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&quot;|&#x22;/gi, '"')
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  async search(input) {
    let query = input;
    let dubbed = false;
    if (input && typeof input === "object") {
      query = input.query || input.title || input.search || input.keyword || input.name || "";
      dubbed = Boolean(input.dub);
    }
    query = String(query || "").trim();
    if (!query) return [];

    // Do not scrape /catalog. It is a client-side shell and returns no cards.
    // The valid AnimeX operation is searchAnime, not catalogAnime.
    const searchQuery = "query($query: String!, $limit: Int) { searchAnime(query: $query, limit: $limit) { items { id anilistId malId titleEnglish titleRomaji format status episodeCount } } }";
    const response = await this.graphql(searchQuery, { query: query, limit: 25 });
    const items = response && response.data && response.data.searchAnime && response.data.searchAnime.items;
    if (!Array.isArray(items)) return [];

    return items.filter(function (item) {
      return item && item.id;
    }).map(function (item) {
      const title = item.titleEnglish || item.titleRomaji || String(item.id);
      return {
        // Keep Seanime's requested audio mode in the match ID. Seanime calls
        // search with input.dub=true after "Switch to dubs", so this lets the
        // episode list and server resolver stay strictly SUB or strictly DUB.
        id: String(item.id) + "$" + (dubbed ? "dub" : "sub"),
        title: this.cleanText(title),
        url: this.ANIMEX + "/anime/" + encodeURIComponent(String(item.id)),
        subOrDub: dubbed ? "dub" : "sub",
      };
    }, this);
  }

  async findEpisodes(id) {
    let animeId = id;
    if (id && typeof id === "object") {
      animeId = id.animeId || id.internalId || id.id || id.mediaId || "";
    }

    animeId = String(animeId || "");
    let audioMode = "sub";

    const modeMatch = animeId.match(/\$(sub|dub)$/i);
    if (modeMatch) {
      audioMode = modeMatch[1].toLowerCase();
      animeId = animeId.slice(0, -modeMatch[0].length);
    }

    const pathMatch = animeId.match(/\/anime\/([^?#/]+)/i);
    if (pathMatch) animeId = pathMatch[1];
    animeId = decodeURIComponent(animeId.replace(/^\/+|\/+$/g, ""));

    console.log("[AnimeX] Episode list mode=" + audioMode + " animeId=" + animeId);

    const data = await this.getJSON(
      this.API + "/rest/api/episodes?id=" + encodeURIComponent(animeId)
    );
    const list = Array.isArray(data) ? data : data && (data.episodes || data.results || data.data);
    if (!Array.isArray(list) || !list.length) {
      throw new Error('AnimeX returned no episodes for "' + animeId + '".');
    }

    return list.map(function (item, index) {
      const number = Number(item.number || item.episode || item.epNum || item.ep || index + 1);
      return {
        // Encode the selected audio mode in the episode ID. Extra object fields
        // are not guaranteed to survive Seanime's Go struct conversion, but ID does.
        id: animeId + "-episode-" + number + "$" + audioMode,
        animeId: animeId,
        title: item.title || "Episode " + number,
        number: number,
        url: this.ANIMEX + "/watch/" + animeId + "-episode-" + number + "?audio=" + audioMode,
      };
    }, this);
  }

  async getServers(animeId, episodeNumber) {
    const data = await this.getJSON(
      this.API + "/rest/api/servers?id=" + encodeURIComponent(animeId) +
      "&epNum=" + encodeURIComponent(episodeNumber)
    );
    return data || {};
  }

  async getSources(id, episodeNumber, type, providerId) {
    const path = "/rest/api/sources?id=" + encodeURIComponent(id) +
      "&epNum=" + encodeURIComponent(episodeNumber) +
      "&type=" + encodeURIComponent(type) +
      "&providerId=" + encodeURIComponent(providerId);

    try {
      return await this.getJSON(this.API + path);
    } catch (error) {
      const message = String(error && error.message || error);
      const transient = /HTTP\s+(502|503|504)\b/.test(message);

      // Yuki dub occasionally times out on pp.animex.one even though the same
      // source is available from the maintained AnimeX/Anidap REST mirror.
      if (providerId === "yuki" && type === "dub" && transient) {
        console.log(
          "[AnimeX] Primary Yuki dub source timed out; trying REST mirror" +
          " episode=" + episodeNumber
        );
        return await this.getJSON(this.API_MIRROR + path);
      }

      throw error;
    }
  }

  normalizeServer(server) {
    if (!server) return "";
    if (typeof server === "string") return server.toLowerCase();
    return String(server.id || server.name || server.serverName || "").toLowerCase();
  }

  normalizeProviderId(provider) {
    if (!provider) return "";
    const raw = typeof provider === "string"
      ? provider
      : String(provider && (provider.id || provider.serverName || provider.name || provider.slug || provider.key) || "");
    return raw.toLowerCase().replace(/-(?:sub|dub)$/i, "").replace(/\s+/g, "");
  }

  providerIds(value) {
    if (!value) return [];

    let items = value;
    if (typeof items === "string") {
      items = items.split(",");
    } else if (items && typeof items === "object" && !Array.isArray(items)) {
      if (Array.isArray(items.providers)) {
        items = items.providers;
      } else if (Array.isArray(items.items)) {
        items = items.items;
      } else {
        items = Object.keys(items).map(function (key) {
          return items[key];
        });
      }
    }

    if (!Array.isArray(items)) return [];

    const seen = {};
    return items.map(function (provider) {
      const id = this.normalizeProviderId(provider);
      if (!id || seen[id]) return null;
      seen[id] = true;
      return id;
    }, this).filter(Boolean);
  }

  serverProviders(servers, type) {
    if (!servers || typeof servers !== "object") return [];

    const matchKeys = [type + "Providers", type + "Provider", type + "s", type, "providers", "servers", "data"];
    for (let i = 0; i < matchKeys.length; i++) {
      const key = matchKeys[i];
      const value = servers[key];
      if (value !== undefined) {
        const ids = this.providerIds(value);
        if (ids.length) return ids;
      }
    }

    const candidateKeys = Object.keys(servers);
    for (let i = 0; i < candidateKeys.length; i++) {
      const key = candidateKeys[i].toLowerCase();
      if (key === type || key === type + "providers" || key === type + "provider" || key === type + "s") {
        const ids = this.providerIds(servers[candidateKeys[i]]);
        if (ids.length) return ids;
      }
    }

    const values = Object.keys(servers).reduce(function (result, key) {
      const value = servers[key];
      if (value && typeof value === "object") {
        result.push(value);
      }
      return result;
    }, []);
    for (let i = 0; i < values.length; i++) {
      const ids = this.providerIds(values[i]);
      if (ids.length) return ids;
    }

    return [];
  }

  sourcePayload(result) {
    if (!result || typeof result !== "object") {
      return { sources: [], tracks: [], headers: {} };
    }

    const root = result;
    const data = root.data && typeof root.data === "object" ? root.data : root;

    let sources = Array.isArray(root.sources) ? root.sources : data.sources;
    if (!Array.isArray(sources) && root.data && root.data.sources) {
      sources = root.data.sources;
    }
    if (!Array.isArray(sources) && root.result && Array.isArray(root.result.sources)) {
      sources = root.result.sources;
    }
    if (!Array.isArray(sources) && sources && Array.isArray(sources.items)) {
      sources = sources.items;
    }
    if (!Array.isArray(sources) && typeof sources === "object") {
      sources = Object.keys(sources).map(function (key) {
        return sources[key];
      });
    }

    let tracks = Array.isArray(root.tracks) ? root.tracks : data.tracks;
    if (!Array.isArray(tracks) && root.data && root.data.tracks) {
      tracks = root.data.tracks;
    }
    if (!Array.isArray(tracks) && root.result && Array.isArray(root.result.tracks)) {
      tracks = root.result.tracks;
    }
    if (!Array.isArray(tracks) && data.subtitles) {
      tracks = data.subtitles;
    }

    return {
      sources: Array.isArray(sources) ? sources : [],
      tracks: Array.isArray(tracks) ? tracks : [],
      headers: root.headers || data.headers || {},
    };
  }

  async getSignsAndSongsSubtitles(animeId, episodeNumber, existingResult) {
    try {
      // AnimeX's neko dub response exposes the forced English track used for
      // translated signs and songs. It is independent of the selected video source.
      const result = existingResult || await this.getSources(animeId, episodeNumber, "dub", "neko");
      const tracks = this.sourcePayload(result).tracks;

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (!track || typeof track !== "object") continue;

        const label = String(track.label || track.language || track.lang || track.srclang || "")
          .toLowerCase()
          .trim();
        const kind = String(track.kind || "").toLowerCase().trim();
        const isEnglish = label === "english" || label === "eng" || label === "en" ||
          label.indexOf("english (") === 0;
        const isCaption = !kind || kind === "captions" || kind === "subtitles";
        const url = String(track.file || track.url || track.src || "").trim();

        if (isEnglish && isCaption && /^https?:\/\/\S+\.vtt(?:[?#]\S*)?$/i.test(url)) {
          return [{
            id: "signs-songs-en",
            url: url,
            language: "en",
            isDefault: true,
          }];
        }
      }
    } catch (error) {
      // Subtitle augmentation is best-effort and must never block playback.
    }

    return [];
  }

  utf8Bytes(value) {
    const text = String(value || "");
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6));
        out.push(0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(++i);
        const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(0xf0 | (cp >> 18));
        out.push(0x80 | ((cp >> 12) & 0x3f));
        out.push(0x80 | ((cp >> 6) & 0x3f));
        out.push(0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (code >> 12));
        out.push(0x80 | ((code >> 6) & 0x3f));
        out.push(0x80 | (code & 0x3f));
      }
    }
    return out;
  }

  base64Url(bytes) {
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const has1 = i + 1 < bytes.length;
      const has2 = i + 2 < bytes.length;
      const b1 = has1 ? bytes[i + 1] : 0;
      const b2 = has2 ? bytes[i + 2] : 0;

      out += table[b0 >> 2];
      out += table[((b0 & 3) << 4) | (b1 >> 4)];
      out += has1 ? table[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      out += has2 ? table[b2 & 63] : "=";
    }
    return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  animeXProxyUrl(rawUrl, referer, userAgent) {
    if (!rawUrl || String(rawUrl).indexOf("/uwu/") !== -1) return rawUrl;

    let payload = this.utf8Bytes(rawUrl);
    payload.push(0);
    payload = payload.concat(this.utf8Bytes(referer || ""));

    if (userAgent) {
      payload.push(0);
      payload = payload.concat(this.utf8Bytes(userAgent));
    }

    const key = this.utf8Bytes(this.UWU_KEY);
    const encoded = payload.map(function (value, index) {
      return value ^ key[index % key.length];
    });

    return this.CDN_PROXY + "/uwu/" + this.base64Url(encoded);
  }

  transformSourceUrl(rawUrl, providerId, headers) {
    let url = String(rawUrl || "");
    const provider = String(providerId || "").toLowerCase();
    const h = headers || {};
    const apiReferer = h.Referer || h.referer || "";
    const apiUserAgent = h["User-Agent"] || h["user-agent"] || "";

    // AnimeX's web player wraps these hosts through its CDN proxy. Returning
    // their raw URLs directly is what caused Zuna buffering/timeouts and Yuki/
    // Sora 403s in Seanime.
    if (provider === "yuki") {
      return this.animeXProxyUrl(url, apiReferer || "https://megaplay.buzz/", apiUserAgent);
    }
    if (provider === "sora") {
      return this.animeXProxyUrl(url, apiReferer || "https://krussdomi.com/", apiUserAgent);
    }
    if (provider === "zuna") {
      return this.animeXProxyUrl(url, apiReferer || "https://zokoanime.video/", apiUserAgent || this.UA);
    }

    return url;
  }

  async findEpisodeServer(episode, server) {
    const item = episode && typeof episode === "object"
      ? episode
      : { id: String(episode || "") };

    let animeId = item.animeId || item.internalId || item.mediaId || "";
    let episodeNumber = Number(item.number || item.episode || 0);
    const idText = String(item.id || "");
    let episodeMode = "";

    const modeMatch = idText.match(/\$(sub|dub)$/i);
    if (modeMatch) episodeMode = modeMatch[1].toLowerCase();

    const cleanIdText = idText.replace(/\$(sub|dub)$/i, "");
    if (!animeId) {
      const episodeMatch = cleanIdText.match(/^(.*)-episode-(\d+)$/i);
      if (episodeMatch) {
        animeId = episodeMatch[1];
        if (!episodeNumber) episodeNumber = Number(episodeMatch[2]);
      }
    }

    if (!episodeMode && item.url) {
      const audioMatch = String(item.url).match(/[?&]audio=(sub|dub)/i);
      if (audioMatch) episodeMode = audioMatch[1].toLowerCase();
    }

    if (!animeId && item.url) {
      const urlMatch = String(item.url).match(/\/watch\/([^/?#]+)-episode-(\d+)/i);
      if (urlMatch) {
        animeId = urlMatch[1];
        if (!episodeNumber) episodeNumber = Number(urlMatch[2]);
      }
    }

    if (!animeId || !episodeNumber) {
      throw new Error("AnimeX episode ID or episode number is missing.");
    }

    const requested = this.normalizeServer(server);
    const requestedType = requested.indexOf("dub") !== -1 ? "dub" : "sub";
    const type = episodeMode || requestedType;

    // Seanime asks every configured episode server for the current episode.
    // Return only the server matching the mode encoded by search/findEpisodes,
    // otherwise SUB and DUB appear together in the dropdown.
    if (episodeMode && requestedType !== episodeMode) {
      throw new Error("AnimeX skipping " + requestedType + " server while in " + episodeMode + " mode.");
    }
    let servers = {};

    try {
      servers = await this.getServers(animeId, episodeNumber);
    } catch (error) {
      // Older API versions do not expose /servers; use the known IDs below.
    }

    const discoveredProviders = this.serverProviders(servers, type);
    const primaryProvider = type === "dub" ? "yuki" : "zuna";
    const fallbackOrder = type === "dub"
      ? ["mimi", "uwu", "kiwi", "miku", "neko", "shiro"]
      : ["beep", "mimi", "kiwi", "uwu", "miku", "mochi", "vee", "neko", "shiro", "yuki"];

    let providers = [];

    // Match the player behavior deliberately:
    //   SUB -> Zuna
    //   DUB -> Yuki
    // If that primary provider is advertised for the episode, do not expose
    // other AnimeX backends as competing servers for the same audio mode.
    if (discoveredProviders.indexOf(primaryProvider) !== -1) {
      providers = [primaryProvider];
    } else if (discoveredProviders.length) {
      providers = discoveredProviders.slice().sort(function (a, b) {
        const ai = fallbackOrder.indexOf(a);
        const bi = fallbackOrder.indexOf(b);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    } else {
      providers = [primaryProvider].concat(fallbackOrder);
    }

    console.log(
      "[AnimeX] mode=" + type +
      " primary=" + primaryProvider +
      " providers=" + providers.join(",")
    );

    const requestedProvider = requested
      .replace(/-(?:sub|dub)/g, "")
      .replace(/\s+/g, "");
    if (providers.indexOf(requestedProvider) !== -1) {
      providers = [requestedProvider].concat(providers.filter(function (id) {
        return id !== requestedProvider;
      }));
    }

    let data = null;
    let usedProvider = null;
    for (let i = 0; i < providers.length; i++) {
      try {
        console.log(
          "[AnimeX] Trying " + type + " provider=" + providers[i] +
          " episode=" + episodeNumber
        );
        const result = await this.getSources(animeId, episodeNumber, type, providers[i]);
        const payload = this.sourcePayload(result);
        const playableSources = payload.sources.filter(function (source) {
          return source && (source.url || source.file || source.link);
        });

        // Raw Yuki/Sora/Zuna URLs are rewritten through AnimeX's CDN proxy
        // before playback, so the API returning a source is enough here.
        const hasUsableSource = playableSources.length > 0;

        if (hasUsableSource) {
          data = result;
          usedProvider = providers[i];
          break;
        }
        console.log(
          "[AnimeX] " + providers[i] + " returned no playable " + type +
          " source for episode " + episodeNumber
        );
      } catch (error) {
        console.log(
          "[AnimeX] " + providers[i] + " failed for " + type +
          " episode=" + episodeNumber + ": " + String(error && error.message || error)
        );
        // Try the next provider.
      }
    }

    if (!data) {
      throw new Error("AnimeX returned no playable " + type.toUpperCase() + " sources for episode " + episodeNumber + ".");
    }

    const responseData = this.sourcePayload(data);
    const signsAndSongsSubtitles = type === "dub"
      ? await this.getSignsAndSongsSubtitles(
        animeId,
        episodeNumber,
        usedProvider === "neko" ? data : null
      )
      : [];
    const videoSources = responseData.sources.filter(function (source) {
      return source && (source.url || source.file || source.link);
    }).map(function (source) {
      const rawUrl = source.url || source.file || source.link;
      const url = this.transformSourceUrl(rawUrl, usedProvider, responseData.headers);
      const isHls = source.type === "video/mpegurl" || String(rawUrl).indexOf(".m3u8") !== -1 || source.format === "hls";
      const videoSource = {
        url: url,
        quality: source.quality || source.qualityLabel || source.label || "auto",
        type: isHls ? "m3u8" : (source.type || source.mimeType || "mp4"),
      };
      if (signsAndSongsSubtitles.length) {
        videoSource.subtitles = signsAndSongsSubtitles;
      }
      return videoSource;
    }, this);

    // The upstream referer/user-agent are encoded into AnimeX's /uwu/ proxy URL.
    // Only send a normal browser UA to the proxy itself.
    const usesAnimeXProxy = videoSources.some(function (source) {
      return String(source && source.url || "").indexOf("/uwu/") !== -1;
    });
    const playbackHeaders = usesAnimeXProxy
      ? { "User-Agent": this.UA }
      : Object.assign({}, responseData.headers || {});

    return {
      server: usedProvider,
      headers: playbackHeaders,
      videoSources: videoSources,
    };
  }
}
