const ANIMEX = "https://animex.one";
const API = "https://pp.animex.one";

function cleanText(value = "") {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`AnimeX request failed: HTTP ${response.status}`);
  }

  return response.text();
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`AnimeX API request failed: HTTP ${response.status}`);
  }

  return response.json();
}

function getAnimeLinks(html) {
  const results = [];
  const seen = new Set();

  const regex =
    /<a[^>]+href=["'](?:https?:\/\/animex\.one)?\/anime\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const slug = match[1];

    if (!slug || seen.has(slug)) {
      continue;
    }

    const block = match[2];

    let title = "";

    const imgAlt = block.match(/alt=["']([^"']+)["']/i);

    if (imgAlt) {
      title = cleanText(imgAlt[1]);
    }

    if (!title) {
      title = cleanText(block);
    }

    if (!title) {
      continue;
    }

    seen.add(slug);

    results.push({
      id: slug,
      title,
      url: `${ANIMEX}/anime/${slug}`,
      subOrDub: "both",
    });
  }

  return results;
}

async function search(query) {
  if (!query || !query.trim()) {
    return [];
  }

  const url =
    `${ANIMEX}/catalog?search=${encodeURIComponent(query.trim())}`;

  const html = await getText(url);

  return getAnimeLinks(html);
}

function findEpisodeCount(html) {
  const patterns = [
    /["']episodes["']\s*:\s*(\d+)/i,
    /(\d+)\s+Episodes?/i,
    /Episodes?[^0-9]{0,30}(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      const count = Number(match[1]);

      if (Number.isFinite(count) && count > 0) {
        return count;
      }
    }
  }

  return 0;
}

async function findEpisodes(id) {
  const animeUrl = `${ANIMEX}/anime/${id}`;
  const html = await getText(animeUrl);

  let episodeCount = findEpisodeCount(html);

  /*
   * Fallback:
   * look for episode links already present in the page.
   */
  const episodeNumbers = new Set();

  const episodeRegex =
    new RegExp(
      `/watch/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-episode-(\\d+)`,
      "gi"
    );

  let match;

  while ((match = episodeRegex.exec(html)) !== null) {
    episodeNumbers.add(Number(match[1]));
  }

  if (!episodeCount && episodeNumbers.size) {
    episodeCount = Math.max(...episodeNumbers);
  }

  if (!episodeCount) {
    throw new Error(
      `AnimeX could not determine the episode count for "${id}".`
    );
  }

  const episodes = [];

  for (let number = 1; number <= episodeCount; number++) {
    episodes.push({
      id: `${id}-episode-${number}`,
      title: `Episode ${number}`,
      number,
      url: `${ANIMEX}/watch/${id}-episode-${number}`,
    });
  }

  return episodes;
}

function extractPlayerData(html) {
  /*
   * AnimeX embeds its player using:
   *
   * https://plyr.animex.one/e/<internal-id>/<episode>
   */

  const patterns = [
    /https?:\/\/plyr\.animex\.one\/e\/([^/"'?]+)\/(\d+)/i,
    /\/\/plyr\.animex\.one\/e\/([^/"'?]+)\/(\d+)/i,
    /plyr\.animex\.one\\?\/e\\?\/([^\\/"'?]+)\\?\/(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      return {
        id: match[1],
        episode: Number(match[2]),
      };
    }
  }

  /*
   * Fallback for AnimeX's serialized page data.
   */
  const accessId =
    html.match(/["']access_id["']\s*:\s*["']([^"']+)["']/i) ||
    html.match(/access_id\\?["']?\s*:\s*\\?["']([^"'\\]+)["']/i);

  if (accessId) {
    return {
      id: accessId[1],
      episode: null,
    };
  }

  throw new Error("AnimeX player ID could not be found.");
}

async function getSources(id, episode, type, provider) {
  const url =
    `${API}/rest/api/sources` +
    `?id=${encodeURIComponent(id)}` +
    `&epNum=${encodeURIComponent(episode)}` +
    `&type=${encodeURIComponent(type)}` +
    `&providerId=${encodeURIComponent(provider)}`;

  return getJSON(url);
}

function normalizeServer(server) {
  if (!server) {
    return null;
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

  return null;
}

async function findEpisodeServer(episode, server) {
  const html = await getText(episode.url);

  const player = extractPlayerData(html);

  const episodeNumber =
    player.episode ||
    Number(episode.number) ||
    Number(String(episode.id).match(/episode-(\d+)/i)?.[1]);

  if (!episodeNumber) {
    throw new Error("AnimeX episode number could not be determined.");
  }

  /*
   * AnimeX providers discovered from its player:
   *
   * SUB:
   * beep, yuki, neko, zuna, loli, sora
   *
   * DUB:
   * yuki, neko, loli, sora
   */

  const requestedServer = normalizeServer(server);

  let type = "sub";

  if (
    requestedServer &&
    (requestedServer.includes("dub") ||
      requestedServer === "yuki-dub" ||
      requestedServer === "neko-dub" ||
      requestedServer === "loli-dub" ||
      requestedServer === "sora-dub")
  ) {
    type = "dub";
  }

  let provider = requestedServer;

  if (provider) {
    provider = provider
      .replace("-sub", "")
      .replace("-dub", "");
  }

  const subProviders = [
    "beep",
    "yuki",
    "neko",
    "zuna",
    "loli",
    "sora",
  ];

  const dubProviders = [
    "yuki",
    "neko",
    "loli",
    "sora",
  ];

  const providers =
    type === "dub" ? dubProviders : subProviders;

  if (provider && providers.includes(provider)) {
    providers.splice(providers.indexOf(provider), 1);
    providers.unshift(provider);
  }

  let data = null;
  let usedProvider = null;

  /*
   * Same basic behavior as the AnimeX player:
   * try providers until one returns a playable source.
   */
  for (const providerId of providers) {
    try {
      const result = await getSources(
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
    } catch (_) {
      // Try the next AnimeX provider.
    }
  }

  if (!data) {
    throw new Error(
      `AnimeX returned no playable ${type.toUpperCase()} sources.`
    );
  }

  const headers = data.headers || {};

  const videoSources = data.sources.map((source) => ({
    url: source.url,
    quality: source.quality || "auto",
    type:
      source.type === "video/mpegurl" ||
      source.url.includes(".m3u8")
        ? "hls"
        : source.type || "hls",
  }));

  const subtitles = Array.isArray(data.tracks)
    ? data.tracks
        .filter(
          (track) =>
            track.url &&
            (track.kind === "captions" ||
              track.kind === "subtitles")
        )
        .map((track) => ({
          url: track.url,
          language: track.lang || "English",
          label: track.label || track.lang || "English",
          default: Boolean(track.default),
        }))
    : [];

  return {
    server: usedProvider,
    headers,
    videoSources,
    subtitles,
  };
}
