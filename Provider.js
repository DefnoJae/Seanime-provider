class Provider {
  constructor() {
    this.ANIMEX = "https://animex.one";
    this.API = "https://pp.animex.one";
  }

  cleanText(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  async getText(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(
        "AnimeX request failed: HTTP " + response.status
      );
    }

    return await response.text();
  }

  async getJSON(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        "AnimeX API request failed: HTTP " + response.status
      );
    }

    return await response.json();
  }

  async search(query) {
    if (!query || !String(query).trim()) {
      return [];
    }

    const url =
      this.ANIMEX +
      "/catalog?search=" +
      encodeURIComponent(String(query).trim());

    const html = await this.getText(url);

    const results = [];
    const seen = {};

    const regex =
      /<a[^>]+href=["'](?:https?:\/\/animex\.one)?\/anime\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
      const slug = match[1];

      if (!slug || seen[slug]) {
        continue;
      }

      const block = match[2];

      let title = "";

      const altMatch = block.match(/alt=["']([^"']+)["']/i);

      if (altMatch) {
        title = this.cleanText(altMatch[1]);
      }

      if (!title) {
        title = this.cleanText(block);
      }

      if (!title) {
        continue;
      }

      seen[slug] = true;

      results.push({
        id: slug,
        title: title,
        url: this.ANIMEX + "/anime/" + slug,
        subOrDub: "both",
      });
    }

    return results;
  }

  findEpisodeCount(html) {
    const patterns = [
      /["']episodes["']\s*:\s*(\d+)/i,
      /(\d+)\s+Episodes?/i,
      /Episodes?[^0-9]{0,30}(\d+)/i,
    ];

    for (let i = 0; i < patterns.length; i++) {
      const match = html.match(patterns[i]);

      if (match) {
        const count = Number(match[1]);

        if (Number.isFinite(count) && count > 0) {
          return count;
        }
      }
    }

    return 0;
  }

  async findEpisodes(id) {
    const animeUrl = this.ANIMEX + "/anime/" + id;

    const html = await this.getText(animeUrl);

    let episodeCount = this.findEpisodeCount(html);

    const episodeNumbers = [];

    const escapedId = String(id).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    const episodeRegex = new RegExp(
      "/watch/" + escapedId + "-episode-(\\d+)",
      "gi"
    );

    let match;

    while ((match = episodeRegex.exec(html)) !== null) {
      const number = Number(match[1]);

      if (episodeNumbers.indexOf(number) === -1) {
        episodeNumbers.push(number);
      }
    }

    if (!episodeCount && episodeNumbers.length > 0) {
      episodeCount = Math.max.apply(null, episodeNumbers);
    }

    if (!episodeCount) {
      throw new Error(
        'AnimeX could not determine episode count for "' +
          id +
          '".'
      );
    }

    const episodes = [];

    for (let number = 1; number <= episodeCount; number++) {
      episodes.push({
        id: id + "-episode-" + number,
        title: "Episode " + number,
        number: number,
        url:
          this.ANIMEX +
          "/watch/" +
          id +
          "-episode-" +
          number,
      });
    }

    return episodes;
  }

  extractPlayerData(html) {
    const patterns = [
      /https?:\/\/plyr\.animex\.one\/e\/([^/"'?]+)\/(\d+)/i,
      /\/\/plyr\.animex\.one\/e\/([^/"'?]+)\/(\d+)/i,
    ];

    for (let i = 0; i < patterns.length; i++) {
      const match = html.match(patterns[i]);

      if (match) {
        return {
          id: match[1],
          episode: Number(match[2]),
        };
      }
    }

    /*
     * AnimeX page data can also expose the internal player
     * identifier as access_id or embedId.
     */
    let match = html.match(
      /["']access_id["']\s*:\s*["']([^"']+)["']/i
    );

    if (!match) {
      match = html.match(
        /["']embedId["']\s*:\s*["']([^"']+)["']/i
      );
    }

    if (!match) {
      match = html.match(
        /\\?"embedId\\?"\s*:\s*\\?"([^"\\]+)\\?"/i
      );
    }

    if (match) {
      return {
        id: match[1],
        episode: null,
      };
    }

    throw new Error("AnimeX player ID could not be found.");
  }

  async getSources(id, episodeNumber, type, providerId) {
    const url =
      this.API +
      "/rest/api/sources" +
      "?id=" +
      encodeURIComponent(id) +
      "&epNum=" +
      encodeURIComponent(episodeNumber) +
      "&type=" +
      encodeURIComponent(type) +
      "&providerId=" +
      encodeURIComponent(providerId);

    return await this.getJSON(url);
  }

  normalizeServer(server) {
    if (!server) {
      return "";
    }

    if (typeof server === "string") {
      return server.toLowerCase();
    }

    if (server.id) {
      return String(server.id).toLowerCase();
    }

    if (server.name) {
      return String(server.name).toLowerCase();
    }

    return "";
  }

  async findEpisodeServer(episode, server) {
    const html = await this.getText(episode.url);

    const player = this.extractPlayerData(html);

    let episodeNumber = player.episode;

    if (!episodeNumber && episode.number) {
      episodeNumber = Number(episode.number);
    }

    if (!episodeNumber && episode.id) {
      const match = String(episode.id).match(
        /episode-(\d+)/i
      );

      if (match) {
        episodeNumber = Number(match[1]);
      }
    }

    if (!episodeNumber) {
      throw new Error(
        "AnimeX episode number could not be determined."
      );
    }

    const requestedServer =
      this.normalizeServer(server);

    let type = "sub";

    if (
      requestedServer.indexOf("dub") !== -1
    ) {
      type = "dub";
    }

    let requestedProvider = requestedServer
      .replace("-sub", "")
      .replace("-dub", "");

    let providers;

    if (type === "dub") {
      providers = [
        "yuki",
        "neko",
        "loli",
        "sora",
      ];
    } else {
      providers = [
        "beep",
        "yuki",
        "neko",
        "zuna",
        "loli",
        "sora",
      ];
    }

    if (
      requestedProvider &&
      providers.indexOf(requestedProvider) !== -1
    ) {
      providers = providers.filter(function (p) {
        return p !== requestedProvider;
      });

      providers.unshift(requestedProvider);
    }

    let data = null;
    let usedProvider = null;

    for (let i = 0; i < providers.length; i++) {
      const providerId = providers[i];

      try {
        const result = await this.getSources(
          player.id,
          episodeNumber,
          type,
          providerId
        );

        if (
          result &&
          Array.isArray(result.sources) &&
          result.sources.length > 0
        ) {
          data = result;
          usedProvider = providerId;
          break;
        }
      } catch (error) {
        // Try next AnimeX provider.
      }
    }

    if (!data) {
      throw new Error(
        "AnimeX returned no playable " +
          type.toUpperCase() +
          " sources."
      );
    }

    const videoSources = [];

    for (let i = 0; i < data.sources.length; i++) {
      const source = data.sources[i];

      if (!source || !source.url) {
        continue;
      }

      let sourceType = source.type || "hls";

      if (
        sourceType === "video/mpegurl" ||
        source.url.indexOf(".m3u8") !== -1
      ) {
        sourceType = "hls";
      }

      videoSources.push({
        url: source.url,
        quality: source.quality || "auto",
        type: sourceType,
      });
    }

    const subtitles = [];

    if (Array.isArray(data.tracks)) {
      for (let i = 0; i < data.tracks.length; i++) {
        const track = data.tracks[i];

        if (!track || !track.url) {
          continue;
        }

        if (
          track.kind !== "captions" &&
          track.kind !== "subtitles"
        ) {
          continue;
        }

        subtitles.push({
          url: track.url,
          language: track.lang || "English",
          label:
            track.label ||
            track.lang ||
            "English",
          default: Boolean(track.default),
        });
      }
    }

    return {
      server: usedProvider,
      headers: data.headers || {},
      videoSources: videoSources,
      subtitles: subtitles,
    };
  }
}
