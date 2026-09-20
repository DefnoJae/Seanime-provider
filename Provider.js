class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
    this.GRAPHQL = "https://graphql.animex.one/graphql";
    this.UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
  }

  getSettings() {
    return {};
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

  providerIds(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (provider) {
      return typeof provider === "string"
        ? provider.toLowerCase()
        : String(provider && (provider.id || provider.serverName || provider.name) || "").toLowerCase();
    }).filter(Boolean);
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

    let providers = this.providerIds(type === "dub" ? servers.dubProviders : servers.subProviders);
    if (!providers.length) {
      providers = type === "dub"
        ? ["beep", "mimi", "vee", "yuki", "neko", "mochi", "uwu", "zuna", "loli", "sora"]
        : ["beep", "mimi", "vee", "mochi", "uwu", "yuki", "neko", "zuna", "loli", "sora"];
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
        if (result && Array.isArray(result.sources) && result.sources.some(function (source) {
          return source && source.url;
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

    const videoSources = data.sources.filter(function (source) {
      return source && source.url;
    }).map(function (source) {
      const isHls = source.type === "video/mpegurl" || String(source.url).indexOf(".m3u8") !== -1;
      return {
        url: source.url,
        quality: source.quality || "auto",
        type: isHls ? "hls" : (source.type || "mp4"),
      };
    });

    const subtitles = Array.isArray(data.tracks)
      ? data.tracks.filter(function (track) {
          return track && track.url && (track.kind === "captions" || track.kind === "subtitles");
        }).map(function (track) {
          return {
            url: track.url,
            language: track.lang || "English",
            label: track.label || track.lang || "English",
            default: Boolean(track.default),
          };
        })
      : [];

    return {
      server: usedProvider,
      headers: data.headers || {},
      videoSources: videoSources,
      subtitles: subtitles,
    };
  }
}
