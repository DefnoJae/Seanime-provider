/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.base = "https://www.miruro.tv";
  }

  getSettings() {
    return {
      episodeServers: ["SUB", "DUB"],
      supportsDub: true,
    };
  }

async search(query) {
  const searchQuery =
    typeof query === "string"
      ? query
      : query?.query || query?.title || "";

  if (!searchQuery.trim()) {
    throw new Error("Search query is empty");
  }

  const url =
    `${this.base}/browse?search=${encodeURIComponent(searchQuery.trim())}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `Miruro search failed: ${res.status} ${res.statusText}`
    );
  }

  const html = await res.text();

  const results = [];
  const seen = new Set();

  const animeRegex =
    /href=["'](\/anime\/[^"'?#]+)["'][^>]*?(?:title=["']([^"']+)["'])?/gi;

  let match;

  while ((match = animeRegex.exec(html)) !== null) {
    const path = match[1];

    if (seen.has(path)) continue;
    seen.add(path);

    let title = match[2] || path.split("/").filter(Boolean).pop();

    title = decodeURIComponent(title)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      id: path,
      title: title,
      url: `${this.base}${path}`,
      subOrDub: "sub",
    });
  }

  if (!results.length) {
    throw new Error(`No Miruro results found for "${searchQuery}"`);
  }

  return results;
}

  async findEpisodes(id) {
    throw new Error("Miruro episode lookup not implemented yet");
  }

  async findEpisodeServer(episode, server) {
    throw new Error("Miruro stream resolver not implemented yet");
  }
}
