/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.base = "https://www.miruro.tv";
    this.anilist = "https://graphql.anilist.co";
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
        "Accept": "application/json"
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: {
          search: searchQuery.trim()
        }
      })
    });

    if (!res.ok) {
      throw new Error(
        `AniList search failed: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json();

    if (data.errors?.length) {
      throw new Error(data.errors[0].message || "AniList search failed");
    }

    const media = data?.data?.Page?.media || [];

    if (!media.length) {
      throw new Error(`No anime found for "${searchQuery}"`);
    }

    return media.map((anime) => ({
      id: String(anime.id),

      title:
        anime.title?.english ||
        anime.title?.romaji ||
        `AniList ${anime.id}`,

      url: `https://anilist.co/anime/${anime.id}`,

      subOrDub: "sub"
    }));
  }

  async findEpisodes(id) {
    /*
      IMPORTANT:

      "id" is now the real AniList ID.

      Example:
          Naruto -> 20

      Miruro uses this AniList ID to retrieve its episode
      information.

      We are intentionally stopping here until we confirm
      which Miruro episode endpoint can be accessed normally
      from Seanime without bypassing Cloudflare.
    */

    throw new Error(
      `Miruro episode lookup reached successfully. AniList ID: ${id}`
    );
  }

  async findEpisodeServer(episode, server) {
    throw new Error(
      "Miruro stream resolver not implemented yet"
    );
  }
}
