/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.anilist = "https://graphql.anilist.co";

    // MiruroAPI base URL.
    // Change this if you host MiruroAPI somewhere else.
    this.api = "http://127.0.0.1:3000";
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

    const graphqlQuery = `
      query ($search: String) {
        Page(page: 1, perPage: 20) {
          media(search: $search, type: ANIME) {
            id
            title {
              romaji
              english
            }
          }
        }
      }
    `;

    const res = await fetch(this.anilist, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: {
          search: searchQuery.trim(),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `AniList search failed: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json();

    if (data.errors?.length) {
      throw new Error(
        data.errors[0]?.message || "AniList search failed"
      );
    }

    const media = data?.data?.Page?.media || [];

    if (!media.length) {
      throw new Error(
        `No anime found for "${searchQuery}"`
      );
    }

    return media.map((anime) => ({
      id: String(anime.id),

      title:
        anime.title?.english ||
        anime.title?.romaji ||
        `AniList ${anime.id}`,

      url: `https://anilist.co/anime/${anime.id}`,

      subOrDub: "sub",
    }));
  }

  async findEpisodes(id) {
    const anilistId = String(id)
      .replace("https://anilist.co/anime/", "")
      .split("/")[0]
      .trim();

    if (!anilistId || !/^\d+$/.test(anilistId)) {
      throw new Error(
        `Invalid AniList ID received: ${id}`
      );
    }

    const url =
      `${this.api}/api/episodes/${encodeURIComponent(anilistId)}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(
        `MiruroAPI episode request failed: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json();

    const providers =
      data?.results?.providers ||
      data?.providers ||
      {};

    if (!providers || typeof providers !== "object") {
      throw new Error(
        "MiruroAPI returned no provider data"
      );
    }

    /*
      Pick the first provider that contains
      usable SUB episodes.
    */

    let selectedProvider = null;
    let selectedEpisodes = [];

    for (const [providerName, providerData] of Object.entries(providers)) {
      const episodes = providerData?.episodes;

      if (!episodes) {
        continue;
      }

      let list = [];

      if (Array.isArray(episodes?.sub)) {
        list = episodes.sub;
      } else if (Array.isArray(episodes)) {
        list = episodes;
      }

      if (list.length > 0) {
        selectedProvider = providerName;
        selectedEpisodes = list;
        break;
      }
    }

    if (!selectedProvider || !selectedEpisodes.length) {
      throw new Error(
        `No SUB episodes found for AniList ID ${anilistId}`
      );
    }

    return selectedEpisodes.map((ep, index) => {
      const episodeNumber =
        Number(ep?.number) || index + 1;

      const episodeId =
        ep?.id ||
        `watch/${selectedProvider}/${anilistId}/sub/${episodeNumber}`;

      return {
        id: String(episodeId),

        title:
          ep?.title ||
          `Episode ${episodeNumber}`,

        number: episodeNumber,

        url: String(episodeId),

        thumbnail:
          ep?.image || "",

        metadata: {
          provider: selectedProvider,
          anilistId: anilistId,
          category: "sub",
        },
      };
    });
  }

  async findEpisodeServer(episode, server) {
    /*
      Episode listing is implemented.

      Stream resolution is intentionally
      left disabled for this test.
    */

    throw new Error(
      `Episode lookup works. Episode ${episode?.number || "?"} reached findEpisodeServer().`
    );
  }
}
