class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
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
      .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, function (_, hex, dec) {
        return String.fromCharCode(parseInt(hex || dec, hex ? 16 : 10));
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  async getText(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new Error("AnimeX request failed: HTTP " + response.status);
    return await response.text();
  }

  async getJSON(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("AnimeX API request failed: HTTP " + response.status);
    return await response.json();
  }

  extractSearchResults(html) {
    const results = [];
    const seen = {};
    const add = (href, title, block) => {
      if (!href) return;
      href = String(href)
        .replace(/&amp;/gi, "&")
        .replace(/\\\//g, "/");
      const match = href.match(/(?:https?:\/\/[^/]+)?\/anime\/([^/?#"'<>]+)/i);
      if (!match) return;
      const slug = decodeURIComponent(match[1]);
      if (!slug || seen[slug]) return;

      let cleanTitle = this.cleanText(title);
      if (!cleanTitle && block) {
        const titleMatch = String(block).match(/(?:title|data-title|alt)=['"]([^'"]+)['"]/i);
        cleanTitle = titleMatch ? this.cleanText(titleMatch[1]) : this.cleanText(block);
      }
      if (!cleanTitle || /^(watch|play|episode|anime)$/i.test(cleanTitle)) return;

      seen[slug] = true;
      results.push({
        id: slug,
        title: cleanTitle,
        url: this.ANIMEX + "/anime/" + slug,
        subOrDub: "both",
      });
    };

    // The catalog markup has changed several times. Do not require the
    // title/image to have a particular position inside the anchor.
    const anchorRegex = /<a\b([^>]*\bhref\s*=\s*["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const attrs = match[1];
      const block = match[2];
      const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const titleMatch = attrs.match(/(?:title|data-title)=\s*["']([^"']+)["']/i);
      const altMatch = block.match(/\balt\s*=\s*["']([^"']+)["']/i);
      add(hrefMatch[1], titleMatch && titleMatch[1] || altMatch && altMatch[1] || block, block);
    }

    // Also support result data embedded by the client-side catalog.
    const dataRegex = /["'](?:url|href)["']\s*:\s*["']((?:https?:\\?\/\\?\/[^"']+)?\\?\/anime\\?\/[^"']+)["'][\s\S]{0,500}?["'](?:title|name)["']\s*:\s*["']([^"']+)["']/gi;
    while ((match = dataRegex.exec(html)) !== null) add(match[1], match[2], "");
    return results;
  }

  async search(input) {
    let query = typeof input === "string" ? input : input && typeof input === "object"
      ? input.query || input.title || input.search || input.keyword || input.name || ""
      : "";
    query = String(query).trim();
    if (!query) return [];

    // Keep the existing endpoint first, then use the current search endpoint
    // when AnimeX serves an empty catalog page for the legacy URL.
    const paths = [
      "/catalog?search=" + encodeURIComponent(query),
      "/search?keyword=" + encodeURIComponent(query),
      "/search?query=" + encodeURIComponent(query),
    ];
    for (let i = 0; i < paths.length; i++) {
      try {
        const results = this.extractSearchResults(await this.getText(this.ANIMEX + paths[i]));
        if (results.length) return results;
      } catch (error) {
        // Try the next AnimeX search format.
      }
    }
    return [];
  }

  findEpisodeCount(html) {
    const patterns = [
      /["']episodes["']\s*:\s*["']?(\d+)/i,
      /["']episodeCount["']\s*:\s*["']?(\d+)/i,
      /(\d+)\s+Episodes?/i,
      /Episodes?[^0-9]{0,30}(\d+)/i,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const match = html.match(patterns[i]);
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }
    return 0;
  }

  async findEpisodes(id) {
    let animeId = id && typeof id === "object" ? id.id || id.animeId || id.mediaId || id.url || "" : id;
    animeId = String(animeId || "");
    const pathMatch = animeId.match(/\/anime\/([^?#/]+)/i);
    if (pathMatch) animeId = pathMatch[1];
    animeId = animeId.replace(/^\/+|\/+$/g, "");
    const html = await this.getText(this.ANIMEX + "/anime/" + animeId);
    let count = this.findEpisodeCount(html);
    const escaped = animeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numbers = [];
    const regex = new RegExp("/watch/" + escaped + "-episode-(\\d+)", "gi");
    let match;
    while ((match = regex.exec(html)) !== null) {
      const number = Number(match[1]);
      if (numbers.indexOf(number) === -1) numbers.push(number);
    }
    if (!count && numbers.length) count = Math.max.apply(null, numbers);
    if (!count) throw new Error('AnimeX could not determine episode count for "' + animeId + '".');
    const episodes = [];
    for (let number = 1; number <= count; number++) {
      episodes.push({
        id: animeId + "-episode-" + number,
        title: "Episode " + number,
        number: number,
        url: this.ANIMEX + "/watch/" + animeId + "-episode-" + number,
      });
    }
    return episodes;
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
    const url = this.API + "/rest/api/sources?id=" + encodeURIComponent(id) +
      "&epNum=" + encodeURIComponent(episodeNumber) + "&type=" + encodeURIComponent(type) +
      "&providerId=" + encodeURIComponent(providerId);
    return await this.getJSON(url);
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
      const numberMatch = String(item.id || "").match(/episode-(\d+)/i);
      if (numberMatch) episodeNumber = Number(numberMatch[1]);
    }
    if (!episodeNumber) throw new Error("AnimeX episode number could not be determined.");

    const requested = this.normalizeServer(server);
    const type = requested.indexOf("dub") !== -1 ? "dub" : "sub";
    let providers = type === "dub" ? ["yuki", "neko", "loli", "sora"] : ["beep", "yuki", "neko", "zuna", "loli", "sora"];
    const requestedProvider = requested.replace(/-(?:sub|dub)/g, "");
    if (providers.indexOf(requestedProvider) !== -1) providers = [requestedProvider].concat(providers.filter(p => p !== requestedProvider));

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

    const videoSources = data.sources.filter(s => s && s.url).map(s => ({
      url: s.url,
      quality: s.quality || "auto",
      type: s.type === "video/mpegurl" || s.url.indexOf(".m3u8") !== -1 ? "hls" : (s.type || "hls"),
    }));
    const subtitles = Array.isArray(data.tracks) ? data.tracks.filter(t => t && t.url && (t.kind === "captions" || t.kind === "subtitles")).map(t => ({
      url: t.url,
      language: t.lang || "English",
      label: t.label || t.lang || "English",
      default: Boolean(t.default),
    })) : [];
    return { server: usedProvider, headers: data.headers || {}, videoSources: videoSources, subtitles: subtitles };
  }
}
