/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.anilist = "https://graphql.anilist.co";

    // Backend URL referenced by Miruro's official repository.
    this.api = "https://public-miruro-consumet-api.vercel.app";
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
      throw new Error(`No anime found for "${searchQuery}"`);
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
      throw new Error(`Invalid AniList ID received: ${id}`);
    }

    /*
      Miruro's frontend uses:

      meta/anilist/episodes/{animeId}
        ?provider=gogoanime
        &dub=false
    */

    const url =
      `${this.api}/meta/anilist/episodes/` +
      `${encodeURIComponent(anilistId)}` +
      `?provider=gogoanime&dub=false`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(
        `Miruro episode request failed: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json();

    /*
      Be tolerant of a few possible response wrappers.
    */
    let rawEpisodes = [];

    if (Array.isArray(data)) {
      rawEpisodes = data;
    } else if (Array.isArray(data?.episodes)) {
      rawEpisodes = data.episodes;
    } else if (Array.isArray(data?.results)) {
      rawEpisodes = data.results;
    } else if (Array.isArray(data?.data?.episodes)) {
      rawEpisodes = data.data.episodes;
    } else if (Array.isArray(data?.data)) {
      rawEpisodes = data.data;
    }

    if (!rawEpisodes.length) {
      throw new Error(
        `Miruro returned no episodes for AniList ID ${anilistId}`
      );
    }

    return rawEpisodes.map((ep, index) => {
      const episodeNumber =
        Number(
          ep?.number ??
          ep?.episodeNumber ??
          ep?.episode ??
          index + 1
        ) || index + 1;

      const episodeId =
        ep?.id ??
        ep?.episodeId ??
        ep?.url;

      if (!episodeId) {
        throw new Error(
          `Miruro episode ${episodeNumber} has no episode ID`
        );
      }

      return {
        id: String(episodeId),

        title:
          ep?.title ||
          `Episode ${episodeNumber}`,

        number: episodeNumber,

        url: String(episodeId),

        thumbnail:
          ep?.image ||
          ep?.thumbnail ||
          "",
      };
    });
  }

  async findEpisodeServer(episode, server) {
    /*
      Diagnostic stage.

      If we reach this function, then:
        Seanime -> AniList -> Miruro -> episode list

      is working.
    */

    throw new Error(
      `Miruro episode list works. Reached ${server} stream resolver for episode ${episode?.number || "?"}.`
    );
  }
}
