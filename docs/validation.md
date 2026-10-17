# AnimeX 1.0.21 — HLS proxy compatibility

Prepared October 17, 2026 from main `1f2540a` (1.0.20). Provider and manifest changes are published atomically.

## Root cause shown by the new playback logs

The 1.0.20 concurrency change resolved the upstream source stall: the logs show an episode-source response in 0.65–1.09 seconds. However, Loli's fast playlists won the race even though Seanime could not proxy them correctly. The player then requested `/cdn/<token>` on Seanime itself and received a local 404.

Fresh upstream inspection confirmed that both Loli's master and variant return valid `#EXTM3U` bodies with **Content-Type: image/jpeg** and extensionless `/cdn/<token>` URL paths. The master query contains `t.m3u8&v.m3u8`; this does not make its URL path end in `.m3u8`.

Seanime's actual `videoProxy.isHLSPlaylist` only recognizes upstream `mpegurl` Content-Type or a requested URL path ending in `.m3u8`. An unrecognized playlist is streamed verbatim, leaving root-relative `/cdn/...` children pointed at the local application. The API source's `type: application/vnd.apple.mpegurl` field does not override that HTTP proxy behavior.

The previous upstream body and HEAD checks did not test this compatibility condition. They were insufficient to establish player compatibility.

## Fix and preserved behavior

`probeHlsSource` now requires Seanime-compatible playlist detection at **every** fetched playlist level, before accepting the stream. It checks the actual upstream Content-Type and requested URL path, matching the proxy's detection rule. Incompatible masters or variants reject that candidate; the existing concurrent resolver can choose another advertised provider in the same audio mode.

This is a generic format check, not a Loli/title/hostname ban. Extensionless playlists served with a genuine HLS MIME type remain supported. Media segments served as JPEG remain supported too; this check applies to playlists, not segments. Valid Yuki URLs and headers remain unchanged. No guessed proxy URL encoding is added.

The 1.0.20 behavior is retained: at most four advertised same-mode providers run concurrently, one validated backend is returned, losing requests cannot start more work after selection, and overlapping same-VM refreshes share pending work. Source responses arriving after an ignored HTTP timeout receive a fresh probe budget. SUB/DUB-tagged IDs, empty DUB discovery, selected-source English SUB captions and forced-only English DUB captions remain intact.

Changed files: `Provider.js` (`probeHlsSource`), `Manifest.json` (1.0.21), JavaScript/Goja regression tests and this report.

## Verification

- `node --test tests/provider.test.cjs`: **36 passed**. Three new tests cover an extensionless JPEG master containing `.m3u8` only in its query, an incompatible extensionless variant of a valid master, and a supported extensionless HLS-MIME playlist with JPEG media segments.
- From `tests/goja`, `go test -count=1 -v .`: **4 passed**, uncached. The new real-Goja regression reproduces the Loli response despite its API `source.type=mpegurl`, confirms rejection, and selects Yuki. Other tests retain hung-request fallback and native-timeout-parser coverage.
- Current Seanime proxy source and real upstream playlist headers/body were inspected together. The incompatible Loli master and variant each returned HTTP 200 with image/jpeg and extensionless paths, reproducing the exact reason that the local `/cdn` 404 occurs.
- Live public-method checks used a Seanime-shaped adapter that deliberately ignores numeric fetch timeout values. Every selected result passed master, variant and segment HEAD checks, retained the API stream URL, and used the requested audio type:

| Title / episode | Mode | Selected | Resolution | Captions |
| --- | --- | --- | --- | --- |
| The Yakuza's Guide to Babysitting / 9 | DUB | Yuki | 1.50 s | None explicitly forced |
| Screenshot title (`saijo-no-osewa-...-5r98a`) / 2 | SUB | Yuki | 1.53 s | 9; English default |
| Naruto / 1 | DUB | Yuki | 1.13 s | None explicitly forced |
| Hell Mode S2 / 7 | SUB | Yuki | 1.53 s | English default |
| Akira / 1 | SUB | Yuki | 1.39 s | English default |

All selected English subtitle files fetched successfully as WebVTT. No video segment bodies were downloaded. No Seanime process was available in this execution environment, so the installed player's decoded audio, caption synchronization and sustained playback were not directly verified.

## Runtime limits

Affected Seanime hosts still ignore numeric fetch timeouts due to Go int/int64 conversion. The concurrent fallback does not require a host rebuild when another admitted provider is healthy. The optional companion timeout patch remains available for real HTTP cancellation. Already-issued losing HTTP requests finish or reach the host timeout; the provider ignores their results. If discovery or every upstream provider is unavailable, the extension cannot manufacture a working stream or promise a short wall-clock timeout. HEAD availability is not a sustained-throughput benchmark.

Primary source checks:

- [Seanime proxy playlist detection and rewriting](https://github.com/5rahim/seanime/blob/main/internal/handlers/proxy.go)
- [Fetch timeout parsing and buffered bodies](https://github.com/5rahim/seanime/blob/main/internal/goja/goja_bindings/fetch.go)
- [Provider VM lifecycle](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_base.go)
- [EpisodeServer/subtitle schema](https://github.com/5rahim/seanime/blob/main/internal/extension/hibike/onlinestream/types.go)
