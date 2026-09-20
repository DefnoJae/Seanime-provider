const BASE_URL = "https://aniwaves.ru";

function decodeHtml(str = "") {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function stripTags(str = "") {
    return decodeHtml(str.replace(/<[^>]*>/g, "").trim());
}

function absoluteUrl(path = "") {
    if (path.startsWith("http://") || path.startsWith("https://")) {
        return path;
    }

    return BASE_URL + (path.startsWith("/") ? path : "/" + path);
}

class Provider {
    constructor() {
        this.name = "Ani-Waves";
        this.baseUrl = BASE_URL;
    }

    async search(query) {
        if (!query) return [];

        const url =
            `${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;

        const response = await fetch(url, {
            headers: {
                Accept: "text/html,application/xhtml+xml"
            }
        });

        if (!response.ok) {
            throw new Error(
                `Ani-Waves search failed: HTTP ${response.status}`
            );
        }

        const html = await response.text();

        const results = [];
        const seen = new Set();

        /*
         * Ani-Waves titles use URLs such as:
         *
         * /watch/naruto-76396
         *
         * We collect those links and extract their visible titles.
         */
        const regex =
            /<a[^>]+href=["'](\/watch\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

        let match;

        while ((match = regex.exec(html)) !== null) {
            const path = match[1];

            // Episode URLs are handled by findEpisodes().
            if (/\/(?:episode|ep)\/?\d+/i.test(path)) {
                continue;
            }

            const idMatch = path.match(/-(\d+)\/?$/);

            if (!idMatch) continue;

            const id = idMatch[1];

            if (seen.has(id)) continue;

            let title = "";

            const titleMatch = match[2].match(
                /class=["'][^"']*(?:d-title|title)[^"']*["'][^>]*>([\s\S]*?)<\//
            );

            if (titleMatch) {
                title = stripTags(titleMatch[1]);
            }

            if (!title) {
                const imgAlt = match[2].match(
                    /<img[^>]+alt=["']([^"']+)["']/i
                );

                if (imgAlt) {
                    title = decodeHtml(imgAlt[1].trim());
                }
            }

            if (!title) continue;

            seen.add(id);

            results.push({
                id: id,
                title: title,
                url: absoluteUrl(path),
                subOrDub: "both"
            });
        }

        return results;
    }

    async findEpisodes(id) {
        if (!id) {
            throw new Error("Ani-Waves anime ID is missing.");
        }

        /*
         * Seanime normally receives the ID returned by search().
         *
         * Ani-Waves' HTML tells us the series ID and episode count.
         * For example Naruto uses ID 76396 and reports 220 episodes.
         */

        const searchUrl = `${BASE_URL}/watch/${id}`;

        let response = await fetch(searchUrl, {
            headers: {
                Accept: "text/html,application/xhtml+xml"
            }
        });

        /*
         * Some Ani-Waves pages require the slug as well as the numeric ID.
         * If Seanime passed a complete /watch/... path, support that too.
         */
        if (!response.ok && String(id).includes("-")) {
            response = await fetch(
                `${BASE_URL}/watch/${id}`,
                {
                    headers: {
                        Accept: "text/html,application/xhtml+xml"
                    }
                }
            );
        }

        if (!response.ok) {
            throw new Error(
                `Ani-Waves anime page failed: HTTP ${response.status}`
            );
        }

        const html = await response.text();

        const canonical =
            html.match(
                /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
            ) ||
            html.match(
                /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i
            );

        let seriesUrl = canonical ? canonical[1] : response.url;

        seriesUrl = seriesUrl
            .replace(/\/episode\/\d+.*$/i, "")
            .replace(/\/ep-\d+.*$/i, "");

        /*
         * Ani-Waves exposes numberOfEpisodes in its JSON-LD.
         */
        const countMatch = html.match(
            /"numberOfEpisodes"\s*:\s*(\d+)/i
        );

        if (!countMatch) {
            throw new Error(
                "Could not determine the Ani-Waves episode count."
            );
        }

        const episodeCount = Number(countMatch[1]);

        const episodes = [];

        for (let number = 1; number <= episodeCount; number++) {
            const episodeUrl =
                `${seriesUrl}/episode/${number}`;

            episodes.push({
                id: episodeUrl,
                title: `Episode ${number}`,
                number: number,
                url: episodeUrl
            });
        }

        return episodes;
    }

    async findEpisodeServer(episode, server) {
        /*
         * Ani-Waves loads #w-servers dynamically with JavaScript.
         *
         * We have intentionally NOT guessed the private request used here.
         * Once the Ani-Waves main.js request format is known, source
         * resolution goes in this method.
         */

        throw new Error(
            "Ani-Waves source resolution is not implemented yet."
        );
    }
}

module.exports = Provider;
