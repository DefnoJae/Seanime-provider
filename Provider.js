class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
    this.GRAPHQL = "https://graphql.animex.one/graphql";
    this.UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
    this.SERVER_TIMEOUT_MS = 3000;
    this.SOURCE_TIMEOUT_MS = 4000;
    this.PROBE_TIMEOUT_MS = 3000;
    this.SELECTION_TIMEOUT_MS = 12000;
    // Seanime constructs a Provider for each call but reuses the VM/class.
    if (!Provider.healthCache) Provider.healthCache = Object.create(null);
    this.healthCache = Provider.healthCache;
    Object.keys(this.healthCache).forEach(function (key) {
      if (this.healthCache[key].expires <= Date.now()) delete this.healthCache[key];
    }, this);
    if (Object.keys(this.healthCache).length > 100) {
      Provider.healthCache = Object.create(null);
      this.healthCache = Provider.healthCache;
    }
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

    const response = await this.fetchBefore(url, Object.assign({}, config, {
      method: config.method || "GET",
      headers: headers,
    }), config.deadline || Date.now() + 10000);

    if (!response.ok) {
      throw new Error("AnimeX API request failed: HTTP " + response.status);
    }

    const json = await response.json();
    if (json && Array.isArray(json.errors) && json.errors.length) {
      throw new Error("AnimeX GraphQL request failed: " + (json.errors[0].message || "unknown error"));
    }
    return json;
  }

  async fetchBefore(url, options, deadline) {
    // Seanime's documented timeout is in whole SECONDS. Affected host builds
    // ignore JS numbers (Go int/int64 mismatch); see docs/validation.md and the
    // companion host patch. On those builds an in-flight request can take 35s.
    // The elapsed checks still prevent starting more work after the budget.
    const timeout = Math.floor((deadline - Date.now()) / 1000);
    if (timeout < 1) throw new Error("Request time budget exhausted");
    const config = Object.assign({}, options || {}, { timeout: timeout });
    delete config.deadline;
    let response;
    try {
      response = await fetch(url, config);
    } catch (error) {
      // Native errors can contain signed URLs. Keep logs token-free.
      throw new Error("Network request failed or timed out");
    }
    if (Date.now() >= deadline) throw new Error("Request time budget exhausted");
    return response;
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

  async getServers(animeId, episodeNumber, deadline) {
    const data = await this.getJSON(
      this.API + "/rest/api/servers?id=" + encodeURIComponent(animeId) +
      "&epNum=" + encodeURIComponent(episodeNumber),
      { deadline: deadline || Date.now() + this.SERVER_TIMEOUT_MS }
    );
    return data || {};
  }

  async getSources(id, episodeNumber, type, providerId, deadline) {
    const url = this.API + "/rest/api/sources?id=" + encodeURIComponent(id) +
      "&epNum=" + encodeURIComponent(episodeNumber) +
      "&type=" + encodeURIComponent(type) +
      "&providerId=" + encodeURIComponent(providerId);

    const maxAttempts = providerId === "yuki" && type === "dub" ? 2 : 1;
    let lastError = null;
    const expires = deadline || Date.now() + this.SOURCE_TIMEOUT_MS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.getJSON(url, { deadline: expires });
      } catch (error) {
        lastError = error;
        const message = String(error && error.message || error);
        const transient = /HTTP\s+(502|503|504)\b/.test(message);
        if (!transient || attempt >= maxAttempts) throw error;

        console.log(
          "[AnimeX] Retrying Yuki dub after transient failure" +
          " attempt=" + attempt + " episode=" + episodeNumber
        );
      }
    }

    throw lastError || new Error("AnimeX source request failed.");
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

  serverProviders(servers, type, depth) {
    // Only a list explicitly scoped to this audio mode is authoritative.
    // In particular, [] must not fall through into the opposite mode's list.
    if (!servers || typeof servers !== "object" || (depth || 0) > 4) return [];
    const keys = Object.keys(servers);
    const modeKeys = [type + "providers", type + "provider", type + "s", type];
    for (let i = 0; i < modeKeys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        if (keys[j].toLowerCase() === modeKeys[i]) return this.providerIds(servers[keys[j]]);
      }
    }
    const wrappers = ["data", "result", "servers", "providers"];
    for (let i = 0; i < wrappers.length; i++) {
      if (servers[wrappers[i]] && typeof servers[wrappers[i]] === "object") {
        const ids = this.serverProviders(servers[wrappers[i]], type, (depth || 0) + 1);
        if (ids.length) return ids;
      }
    }
    return [];
  }

  orderProviders(discovered, type) {
    const preferred = type === "dub" ? ["yuki"] : ["zuna", "yuki"];
    return preferred.filter(function (id) { return discovered.indexOf(id) !== -1; })
      .concat(discovered.filter(function (id) { return preferred.indexOf(id) === -1; }));
  }

  sourcePayload(result) {
    if (!result || typeof result !== "object") return { sources: [], tracks: [], headers: {} };
    const containers = [result, result.data, result.result].filter(function (value) {
      return value && typeof value === "object";
    });
    let sources = [];
    let tracks = [];
    let headers = {};
    for (let i = 0; i < containers.length; i++) {
      const value = containers[i];
      let list = value.sources;
      if (list && Array.isArray(list.items)) list = list.items;
      if (list && typeof list === "object" && !Array.isArray(list)) {
        list = Object.keys(list).map(function (key) { return list[key]; });
      }
      if (!sources.length && Array.isArray(list)) sources = list;
      if (Array.isArray(value.tracks)) tracks = tracks.concat(value.tracks);
      if (Array.isArray(value.subtitles)) tracks = tracks.concat(value.subtitles);
      if (value.headers && typeof value.headers === "object") headers = Object.assign({}, value.headers, headers);
    }
    return { sources: sources, tracks: tracks, headers: headers };
  }

  absoluteUrl(value, base) {
    const url = String(value || "").trim();
    if (!url || /[\s\\]/.test(url)) return "";
    if (/^https?:\/\/[^/]+/i.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return "";
    const match = String(base || "").match(/^(https?:)\/\/([^/?#]+)([^?#]*)/i);
    if (!match) return "";
    if (url.indexOf("//") === 0) return match[1] + url;
    const origin = match[1] + "//" + match[2];
    if (url[0] === "?") return origin + (match[3] || "/") + url;
    if (url[0] === "#") return "";
    const path = url[0] === "/" ? url : (match[3] || "/").replace(/[^/]*$/, "") + url;
    const suffixAt = path.search(/[?#]/);
    const suffix = suffixAt < 0 ? "" : path.slice(suffixAt);
    const parts = (suffixAt < 0 ? path : path.slice(0, suffixAt)).split("/");
    const out = [];
    parts.forEach(function (part) {
      if (part === "..") { if (out.length > 1) out.pop(); }
      else if (part !== ".") out.push(part);
    });
    return origin + out.join("/") + suffix;
  }

  normalizeSubtitleTracks(tracks, type, base) {
    const seen = Object.create(null);
    const normalized = [];
    (Array.isArray(tracks) ? tracks : []).forEach(function (track) {
      if (!track || typeof track !== "object") return;
      const label = String(track.label || track.name || track.language || track.lang || track.srclang || "").trim();
      const lang = String(track.srclang || track.lang || track.language || label).trim();
      const kind = String(track.kind || "").toLowerCase();
      const raw = String(track.file || track.url || track.src || "").trim();
      const format = String(track.type || track.format || track.mimeType || "").toLowerCase();
      if (kind && kind !== "subtitles" && kind !== "captions" && kind !== "subtitle") return;
      if (/thumbnail|sprite|chapter|metadata/i.test(label + " " + format + " " + raw) ||
          /#xywh|\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(raw)) return;
      // Seanime's player parses WebVTT directly; do not mislabel SRT/ASS as VTT.
      if (!/\.vtt(?:[?#]|$)/i.test(raw) && !/^(?:vtt|text\/vtt)$/.test(format)) return;
      if (/\.(?:srt|ass|ssa)(?:[?#]|$)/i.test(raw)) return;
      const url = this.absoluteUrl(raw, base);
      if (!url || seen[url]) return;
      const english = /^(?:en|eng)(?:[-_ ]|$)|english/i.test(lang) || /\benglish\b/i.test(label);
      const forced = track.forced === true || track.isForced === true ||
        /\bforced\b|\bsigns?\b|\bsongs?\b/i.test(label);
      if (type === "dub" && (!english || !forced)) return;
      seen[url] = true;
      normalized.push({
        id: "subtitle-" + normalized.length,
        url: url,
        language: english ? "en" : (lang || "und"),
        isDefault: false,
        english: english,
        forced: forced,
        preferred: track.default === true || track.isDefault === true,
      });
    }, this);
    let index = normalized.findIndex(function (track) { return track.english && !track.forced; });
    if (index < 0) index = normalized.findIndex(function (track) { return track.english; });
    if (index < 0) index = normalized.findIndex(function (track) { return track.preferred; });
    if (index < 0 && normalized.length) index = 0;
    return normalized.map(function (track, i) {
      return { id: track.id, url: track.url, language: track.language, isDefault: i === index };
    });
  }

  buildPlaybackHeaders(payload, source, provider) {
    const headers = {};
    const canonical = { referer: "Referer", origin: "Origin", accept: "Accept", "user-agent": "User-Agent" };
    [payload.headers, source.headers].forEach(function (value) {
      Object.keys(value || {}).forEach(function (key) {
        if (typeof value[key] === "string") headers[canonical[key.toLowerCase()] || key] = value[key];
      });
    });
    const url = String(source.url || source.file || source.link || "");
    if (provider === "zuna" && /^https?:\/\/hls\.1embed\.buzz(?::\d+)?\//i.test(url)) {
      if (!headers.Referer) headers.Referer = "https://zokoanime.video/";
      if (!headers.Origin) headers.Origin = "https://zokoanime.video";
      if (!headers.Accept) headers.Accept = "*/*";
      if (!headers["User-Agent"]) headers["User-Agent"] = this.UA;
    }
    return headers;
  }

  isHlsSource(source) {
    return /\.m3u8(?:[?#]|$)/i.test(String(source.url || source.file || source.link || "")) ||
      /^(?:hls|m3u8|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|video\/mpegurl)$/i
        .test(String(source.type || source.mimeType || source.format || ""));
  }

  async probeHlsSource(url, headers, deadline, checkSegment, type) {
    let current = url;
    // Some backends nest master playlists. Bound traversal and reject cycles.
    const visited = Object.create(null);
    for (let depth = 0; depth < 3; depth++) {
      if (visited[current]) throw new Error("HLS playlist cycle");
      visited[current] = true;
      const response = await this.fetchBefore(current, { headers: headers }, deadline);
      if (!response.ok) throw new Error("HLS playlist HTTP " + response.status);
      const body = String(await response.text()).replace(/^\uFEFF/, "").trim();
      if (!/^#EXTM3U(?:\s|$)/.test(body)) throw new Error("Invalid HLS playlist");
      const base = response.url || current;
      const lines = body.split(/\r?\n/).map(function (line) { return line.trim(); });
      // Seanime cannot force an HLS audio rendition through EpisodeServer.
      // Reject explicitly wrong/ambiguous defaults instead of mislabeling audio.
      const audio = lines.filter(function (line) {
        return /^#EXT-X-MEDIA:/.test(line) && /(?:[:,])TYPE=AUDIO(?:,|$)/.test(line);
      });
      if (audio.length) {
        const defaults = audio.filter(function (line) { return /(?:[:,])DEFAULT=YES(?:,|$)/.test(line); });
        const choices = defaults.length ? defaults : audio;
        const desired = type === "dub" ? /^(?:en|eng|english)(?:[-_ ]|$)/i : /^(?:ja|jpn|japanese)(?:[-_ ]|$)/i;
        if (!choices.every(function (line) {
          const language = line.match(/(?:[:,])LANGUAGE="([^"]+)"/);
          const name = line.match(/(?:[:,])NAME="([^"]+)"/);
          return desired.test(language ? language[1] : (name ? name[1] : ""));
        })) throw new Error("HLS default audio does not match " + type);
      }
      const variants = [];
      let bandwidth = null;
      let segment = "";
      let media = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
          const match = line.match(/(?:^|[:,])BANDWIDTH=(\d+)/);
          bandwidth = match ? Number(match[1]) : 0;
        } else if (line.indexOf("#EXTINF:") === 0) {
          media = true;
        } else if (line && line[0] !== "#") {
          if (bandwidth !== null) { variants.push({ uri: line, bandwidth: bandwidth }); bandwidth = null; }
          else if (media && !segment) segment = line;
        }
      }
      if (variants.length) {
        variants.sort(function (a, b) { return a.bandwidth - b.bandwidth; });
        current = this.absoluteUrl(variants[0].uri, base);
        if (!current) throw new Error("Invalid HLS variant URL");
        continue;
      }
      if (!media || !segment) throw new Error("HLS playlist has no media segments");
      const segmentUrl = this.absoluteUrl(segment, base);
      if (!segmentUrl) throw new Error("Invalid HLS segment URL");
      if (checkSegment) {
        // Goja buffers fetch bodies. HEAD avoids a full segment download even
        // when a CDN ignores Range; never retry this probe with GET.
        const head = await this.fetchBefore(segmentUrl, { method: "HEAD", headers: headers }, deadline);
        if (!head.ok && head.status !== 405 && head.status !== 501) {
          throw new Error("HLS segment HTTP " + head.status);
        }
        if (head.ok && /text\/html|application\/json/i.test(String(head.contentType ||
            (head.headers && (head.headers["Content-Type"] || head.headers["content-type"])) || ""))) {
          throw new Error("HLS segment returned a non-media response");
        }
      }
      return;
    }
    throw new Error("HLS playlist nesting limit reached");
  }

  async selectHealthyProvider(animeId, episodeNumber, type) {
    const deadline = Date.now() + this.SELECTION_TIMEOUT_MS;
    let discovered = [];
    let discoveryFailed = false;
    try {
      const servers = await this.getServers(animeId, episodeNumber, Math.min(deadline, Date.now() + this.SERVER_TIMEOUT_MS));
      discovered = this.serverProviders(servers, type);
    } catch (error) {
      discoveryFailed = true;
      console.log("[AnimeX] server discovery failed; using limited " + type + " fallback");
    }
    const candidates = this.orderProviders(discoveryFailed ?
      (type === "dub" ? ["yuki", "sora"] : ["zuna", "yuki"]) : discovered, type);
    console.log("[AnimeX] mode=" + type + " advertised=" + discovered.join(","));
    console.log("[AnimeX] candidates=" + candidates.join(","));
    for (let i = 0; i < candidates.length && Date.now() < deadline - 1000; i++) {
      const provider = candidates[i];
      const key = [animeId, episodeNumber, type, provider].join("|");
      const cached = this.healthCache[key];
      if (cached && cached.expires > Date.now() && !cached.healthy) continue;
      try {
        console.log("[AnimeX] trying type=" + type + " provider=" + provider + " episode=" + episodeNumber);
        const started = Date.now();
        const result = await this.getSources(animeId, episodeNumber, type, provider,
          Math.min(deadline, started + this.SOURCE_TIMEOUT_MS));
        console.log("[AnimeX] " + provider + " source API resolved in " + (Date.now() - started) + "ms");
        const payload = this.sourcePayload(result);
        const probeStarted = Date.now();
        const probeDeadline = Math.min(deadline, probeStarted + this.PROBE_TIMEOUT_MS);
        let selected = null;
        for (let j = 0; j < payload.sources.length && j < 3; j++) {
          const source = payload.sources[j];
          if (!source || typeof source !== "object") continue;
          const url = this.absoluteUrl(source.url || source.file || source.link);
          if (!url) continue;
          const headers = this.buildPlaybackHeaders(payload, source, provider);
          const hls = this.isHlsSource(source);
          try {
            // Cache is tied to the precise URL and headers; a new signed URL
            // never inherits the previous URL's successful playback decision.
            const fingerprint = url + JSON.stringify(headers);
            if (!cached || cached.expires <= Date.now() || !cached.healthy || cached.fingerprint !== fingerprint) {
              if (hls) await this.probeHlsSource(url, headers, probeDeadline, provider === "zuna", type);
              else {
                const response = await this.fetchBefore(url, { method: "HEAD", headers: headers }, probeDeadline);
                if (!response.ok) throw new Error("Video probe HTTP " + response.status);
              }
            }
            const tracks = payload.tracks.concat(Array.isArray(source.tracks) ? source.tracks : [],
              Array.isArray(source.subtitles) ? source.subtitles : []);
            const subtitles = this.normalizeSubtitleTracks(tracks, type, url);
            const video = { url: url, quality: source.quality || source.qualityLabel || source.label || "auto",
              type: hls ? "m3u8" : "mp4", subtitles: subtitles };
            selected = { server: provider, headers: headers, videoSources: [video] };
            this.healthCache[key] = { healthy: true, expires: Date.now() + 30000, fingerprint: fingerprint };
            break;
          } catch (error) {
            console.log("[AnimeX] " + provider + " playback probe failed after " + (Date.now() - probeStarted) +
              "ms: " + String(error && error.message || "invalid stream"));
          }
        }
        if (selected) {
          console.log("[AnimeX] selected type=" + type + " provider=" + provider +
            " subtitles=" + selected.videoSources[0].subtitles.length);
          return selected;
        }
        throw new Error("No healthy video source");
      } catch (error) {
        this.healthCache[key] = { healthy: false, expires: Date.now() + 10000 };
        console.log("[AnimeX] " + provider + " failed type=" + type + ": " + String(error && error.message || "request failed"));
        if (i + 1 < candidates.length) console.log("[AnimeX] falling back to " + candidates[i + 1]);
      }
    }
    throw new Error("AnimeX returned no playable " + type.toUpperCase() + " sources for episode " + episodeNumber + ".");
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
    return await this.selectHealthyProvider(animeId, episodeNumber, type);
  }
}
