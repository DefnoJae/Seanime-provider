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
    throw new Error("Miruro search not implemented yet");
  }

  async findEpisodes(id) {
    throw new Error("Miruro episode lookup not implemented yet");
  }

  async findEpisodeServer(episode, server) {
    throw new Error("Miruro stream resolver not implemented yet");
  }
}
