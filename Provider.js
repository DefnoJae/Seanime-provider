class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
    this.GRAPHQL = "https://graphql.animex.one/graphql";
  }

  getSettings() { return {}; }

  cleanText(value) {
    return String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&quot;|&#x22;/gi, '"')
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  async getText(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error("AnimeX request failed: HTTP " + response.status);
    return await response.text();
  }

  async getJSON(url, options) {
    const response = await fetch(url, Object.assign({
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
        Origin: this.ANIMEX,
        Referer: this.ANIMEX + "/",
      },
    }, options || {}));
    if (!response.ok) throw new Error("AnimeX API request failed: HTTP " + response.status);
    return await response.json();
  }

  async graphql(query, variables) {
    return await this.getJSON(this.GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: this.ANIMEX,
        Referer: this.ANIMEX + "/",
      },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    });
  }

  async search(input) {
    let query = typeof input === "string" ? input : input && typeof input === "object"
      ? input.query || input.title || input.search || input.keyword || input.name || ""
      : "";
    query = String(query).trim();
    if (!query) return [];

    // AnimeX moved catalog search to GraphQL. The old HTML endpoints return
    // HTTP 200 with an empty application shell, which caused zero results.
    const gql = "query FastSearch($query: String, $limit: Int, $includeAdult: Boolean) { catalogAnime(filter: { query: $query, includeAdult: $includeAdult }, limit: $limit) { items { id anilistId titleRomaji titleEnglish title { romaji english userPreferred } } } }";
    try {
      const response = await this.graphql(gql, {
        query: query,
        limit: 25,
        includeAdult: false,
      });
      const items = response && response.data && response.data.catalogAnime && response.data.catalogAnime.items;
      if (Array.isArray(items)) {
        return items.filter(function (item) { return item && (item.id || item.anilistId); }).map(function (item) {
          const titleObject = item.title || {};
          const title = item.titleEnglish || titleObject.english || item.titleRomaji || titleObject.romaji || titleObject.userPreferred || String(item.id);
          return {
            id: String(item.id || item.anilistId),
            title: title,
            url: this.ANIMEX + "/anime/" + encodeURIComponent(String(item.id || item.anilistId)),
            subOrDub: "both",
          };
        }, this);
      }
    } catch (error) {
      // Fall through for older AnimeX installations.
    }

    return [];
  }

  async findEpisodes(id) {
    let animeId = id && typeof id === "object" ? id.id || id.animeId || id.mediaId || id.url || "" : id;
    animeId = String(animeId || "");
    const pathMatch = animeId.match(/\/anime\/([^?#/]+)/i);
    if (pathMatch) animeId = pathMatch[1];
    animeId = decodeURIComponent(animeId.replace(/^\/+|\/+$/g, ""));

    // Use the stable REST endpoint instead of guessing episode count from HTML.
    try {
      const data = await this.getJSON(this.API + "/rest/api/episodes?id=" + encodeURIComponent(animeId));
      const list = Array.isArray(data) ? data : data && (data.episodes || data.results || data.data);
      if (Array.isArray(list) && list.length) {
        return list.map(function (item, index) {
          const number = Number(item.number || item.episode || item.epNum || item.ep || index + 1);
          return {
            id: String(item.id || (animeId + "-episode-" + number)),
            title: item.title || "Episode " + number,
            number: number,
            url: item.url || item.link || this.ANIMEX + "/watch/" + animeId + "-episode-" + number,
          };
        }, this);
      }
    } catch (error) {
      // Use the page parser below when the REST endpoint is unavailable.
    }

    const html = await this.getText(this.ANIMEX + "/anime/" + animeId);
    const numbers = [];
    const regex = new RegExp("/watch/" + animeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-episode-(\\d+)", "gi");
    let match;
    while ((match = regex.exec(html)) !== null) {
      const number = Number(match[1]);
      if (numbers.indexOf(number) === -1) numbers.push(number);
    }
    if (!numbers.length) throw new Error('AnimeX returned no episodes for "' + animeId + '".');
    numbers.sort(function (a, b) { return a - b; });
    return numbers.map(function (number) {
      return {
        id: animeId + "-episode-" + number,
        title: "Episode " + number,
        number: number,
        url: this.ANIMEX + "/watch/" + animeId + "-episode-" + number,
      };
    }, this);
  }

  extractPlayerData(html) {
    const player = html.match(/(?:https?:)?\/\/plyr\.animex\.one\/e\/([^/"'?]+)\/(\d+)/i);
    if (player) return { id: player[1], episode: Number(player[2]) };
    const match = html.match(/["'](?:access_id|embedId)["']\s*:\s*["']([^"']+)["']/i) ||
      html.match(/\\?["']embedId\\?["']\s*:\s*\\?["']([^"']+)\\?["']/i);
    if (match) return { id: match[1], episode: null };
    throw new Error("AnimeX player ID could not be found.");
  }

  async getSources(id, episodeNumber, type, providerId) {
    return await this.getJSON(this.API + "/rest/api/sources?id=" + encodeURIComponent(id) +
      "&epNum=" + encodeURIComponent(episodeNumber) + "&type=" + encodeURIComponent(type) +
      "&providerId=" + encodeURIComponent(providerId));
  }

  normalizeServer(server) {
    if (!server) return "";
    if (typeof server === "string") return server.toLowerCase();
    return String(server.id || server.name || "").toLowerCase();
  }

  async findEpisodeServer(episode, server) {
    const item = episode && typeof episode === "object" ? episode : { id: String(episode || ""), url: String(episode || "") };
    let episodeUrl = item.url || "";
    if (episodeUrl && episodeUrl.indexOf("http") !== 0) episodeUrl = this.ANIMEX + (episodeUrl.charAt(0) === "/" ? episodeUrl : "/" + episodeUrl);
    if (!episodeUrl) throw new Error("AnimeX episode URL is missing.");

    const player = this.extractPlayerData(await this.getText(episodeUrl));
    let episodeNumber = player.episode || Number(item.number || 0);
    if (!episodeNumber) {
      const match = String(item.id || "").match(/episode-(\d+)/i);
      if (match) episodeNumber = Number(match[1]);
    }
    if (!episodeNumber) throw new Error("AnimeX episode number could not be determined.");

    const requested = this.normalizeServer(server);
    const type = requested.indexOf("dub") !== -1 ? "dub" : "sub";
    let providers = type === "dub" ? ["beep", "mimi", "vee", "yuki", "neko", "mochi", "uwu", "zuna", "loli", "sora"] : ["beep", "mimi", "vee", "mochi", "uwu", "yuki", "neko", "zuna", "loli", "sora"];
    const requestedProvider = requested.replace(/-(?:sub|dub)/g, "");
    if (providers.indexOf(requestedProvider) !== -1) providers = [requestedProvider].concat(providers.filter(function (p) { return p !== requestedProvider; }));

    let data = null;
    let usedProvider = null;
    for (let i = 0; i < providers.length; i++) {
      try {
        const result = await this.getSources(player.id, episodeNumber, type, providers[i]);
        if (result && Array.isArray(result.sources) && result.sources.length) {
          data = result;
          usedProvider = providers[i];
          break;
        }
      } catch (error) {}
    }
    if (!data) throw new Error("AnimeX returned no playable " + type.toUpperCase() + " sources.");

    const videoSources = data.sources.filter(function (s) { return s && s.url; }).map(function (s) {
      return { url: s.url, quality: s.quality || "auto", type: s.type === "video/mpegurl" || s.url.indexOf(".m3u8") !== -1 ? "hls" : (s.type || "hls") };
    });
    const subtitles = Array.isArray(data.tracks) ? data.tracks.filter(function (t) { return t && t.url && (t.kind === "captions" || t.kind === "subtitles"); }).map(function (t) {
      return { url: t.url, language: t.lang || "English", label: t.label || t.lang || "English", default: Boolean(t.default) };
    }) : [];
    return { server: usedProvider, headers: data.headers || {}, videoSources: videoSources, subtitles: subtitles };
  }
}
