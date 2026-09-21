class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
    this.GRAPHQL = "https://graphql.animex.one/graphql";
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
    if (input && typeof input === "object") {
      query = input.query || input.title || input.search || input.keyword || input.name || "";
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
        // This is AnimeX's internal ID. Do not replace it with the AniList ID.
        id: String(item.id),
        title: this.cleanText(title),
        url: this.ANIMEX + "/anime/" + encodeURIComponent(String(item.id)),
        subOrDub: "both",
      };
    }, this);
  }

  async findEpisodes(id) {
    let animeId = id;
    if (id && typeof id === "object") {
      animeId = id.animeId || id.internalId || id.id || id.mediaId || "";
    }

    animeId = String(animeId || "");
    const pathMatch = animeId.match(/\/anime\/([^?#/]+)/i);
    if (pathMatch) animeId = pathMatch[1];
    animeId = decodeURIComponent(animeId.replace(/^\/+|\/+$/g, ""));

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
        // Keep the internal AnimeX ID available for findEpisodeServer.
        id: animeId + "-episode-" + number,
        animeId: animeId,
        title: item.title || "Episode " + number,
        number: number,
        // This URL is informational only. findEpisodeServer does not scrape it.
        url: this.ANIMEX + "/watch/" + animeId + "-episode-" + number,
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
    return await this.getJSON(
      this.API + "/rest/api/sources?id=" + encodeURIComponent(id) +
      "&epNum=" + encodeURIComponent(episodeNumber) +
      "&type=" + encodeURIComponent(type) +
      "&providerId=" + encodeURIComponent(providerId)
    );
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

  async findEpisodeServer(episode, server) {
    const item = episode && typeof episode === "object"
      ? episode
      : { id: String(episode || "") };

    let animeId = item.animeId || item.internalId || item.mediaId || "";
    let episodeNumber = Number(item.number || item.episode || 0);
    const idText = String(item.id || "");

    if (!animeId) {
      const episodeMatch = idText.match(/^(.*)-episode-(\d+)$/i);
      if (episodeMatch) {
        animeId = episodeMatch[1];
        if (!episodeNumber) episodeNumber = Number(episodeMatch[2]);
      }
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
    const type = requested.indexOf("dub") !== -1 ? "dub" : "sub";
    let servers = {};

    try {
      servers = await this.getServers(animeId, episodeNumber);
    } catch (error) {
      // Older API versions do not expose /servers; use the known IDs below.
    }

    let providers = this.serverProviders(servers, type);
    if (!providers.length) {
      providers = type === "dub"
        ? ["yuki", "neko"]
        : ["beep", "yuki"];
    }

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
        const result = await this.getSources(animeId, episodeNumber, type, providers[i]);
        const payload = this.sourcePayload(result);
        if (payload.sources.some(function (source) {
          return source && (source.url || source.file || source.link);
        })) {
          data = result;
          usedProvider = providers[i];
          break;
        }
      } catch (error) {
        // Try the next provider returned by AnimeX.
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
      const url = source.url || source.file || source.link;
      const isHls = source.type === "video/mpegurl" || String(url).indexOf(".m3u8") !== -1 || source.format === "hls";
      const videoSource = {
        url: url,
        quality: source.quality || source.qualityLabel || source.label || "auto",
        type: isHls ? "m3u8" : (source.type || source.mimeType || "mp4"),
      };
      if (signsAndSongsSubtitles.length) {
        videoSource.subtitles = signsAndSongsSubtitles;
      }
      return videoSource;
    });

    return {
      server: usedProvider,
      headers: responseData.headers || {},
      videoSources: videoSources,
    };
  }
}
