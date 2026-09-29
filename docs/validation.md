# AnimeX 1.0.19 validation and remaining runtime dependency

Prepared from current main `b586c09` (1.0.18). Provider changes and manifest bump are atomic in this revision.

## Release blocker: Seanime ignores numeric fetch timeouts

The provider requests a 3-second discovery limit, 4-second source limit (including the existing Yuki dub transient retry), a 3-second playback-probe budget, and a shared 12-second selection budget. **These are enforceable only when the host honors fetch.timeout.**

Seanime's inspected fetch implementation checks `o.Export().(int)`. Its pinned Goja exports JavaScript integers as `int64`. The option therefore silently leaves the default 35-second HTTP timeout in place. The same defect exists in v3.10.3. Provider VMs do not bind setTimeout, AbortController or AbortContext. An unsafe goroutine or a promise race without a timer/cancellation is not a sound substitute.

`seanime-fetch-timeout.patch` is a small companion fix for the Seanime source tree, not an extension payload. It must be applied to a matching Seanime checkout and the host rebuilt to guarantee the requested short timeouts. It has not been installed in the user's app. Provider-only installation on an affected host can still wait up to the host timeout for an in-flight request and exhaust the selection budget before a fallback. Do not advertise this draft as a complete slow-start fix on an unpatched host.

Primary sources inspected at Seanime commit `2da73d9eb59af15b004ef4e9018ac9db6fff213a`:

- [Fetch timeout parser and buffered response body](https://github.com/5rahim/seanime/blob/2da73d9eb59af15b004ef4e9018ac9db6fff213a/internal/goja/goja_bindings/fetch.go)
- [Provider VM initialization](https://github.com/5rahim/seanime/blob/2da73d9eb59af15b004ef4e9018ac9db6fff213a/internal/extension_repo/goja_base.go)
- [Shared provider bindings](https://github.com/5rahim/seanime/blob/2da73d9eb59af15b004ef4e9018ac9db6fff213a/internal/extension_repo/goja.go)
- [EpisodeServer / VideoSubtitle schema](https://github.com/5rahim/seanime/blob/2da73d9eb59af15b004ef4e9018ac9db6fff213a/internal/extension/hibike/onlinestream/types.go)

## Root causes fixed in Provider.js

- `serverProviders` previously fell through into unrelated/opposite-mode lists. It now accepts only explicitly mode-scoped lists. A successful empty/missing dub list never causes guessed source requests.
- Selecting a preferred provider previously discarded its fallback candidates. `orderProviders` and `selectHealthyProvider` retain all advertised providers in the same mode, stopping at one validated source.
- Sources were accepted merely for containing a URL. `probeHlsSource` now checks playlist HTTP status, M3U8 content, a variant and a media segment URI; Zuna additionally gets a segment HEAD. Failed or over-budget probes advance to the next candidate when budget remains.
- SUB captions were never attached. `sourcePayload` and `normalizeSubtitleTracks` combine tracks/subtitles from supported response containers and the selected source. Valid WebVTT captions use `{id,url,language,isDefault}`; full English takes default precedence. Thumbnail/sprite/chapter/metadata/image tracks are excluded.
- DUB previously fetched unadvertised Neko and assumed its first English track meant forced captions. DUB now attaches only explicitly forced/signs/songs English tracks from its selected response, with no extra request or subtitle startup delay.
- Live Sora Naruto SUB/DUB returned the same HLS master with Japanese default audio. The playlist probe rejects explicitly incompatible or ambiguous multi-audio defaults instead of silently labeling Japanese as dub. No proxy URL encoding is introduced.

`buildPlaybackHeaders` keeps source-supplied context and adds existing Zuna/1embed defaults when absent. Probes and returned playback headers match. `absoluteUrl` resolves relative playlist URIs against the final redirected URL without altering the returned signed master URL. Cache decisions are short-lived, mode-separated and bounded per reused VM; successful entries additionally require the identical URL and headers.

## Selection behavior

SUB: advertised Zuna, then advertised Yuki, then the remaining advertised SUB providers. DUB: advertised Yuki, then remaining advertised DUB providers. Every request preserves the current `type`; provider names never set audio mode. Only if discovery throws is a two-provider emergency list used. Successful discovery never fabricates providers. Existing `$sub`/`$dub` search and episode IDs and opposite-server rejection remain intact.

Each returned EpisodeServer contains one selected backend and its validated video source with selected-source subtitles. HEAD 405/501 is treated as unsupported after valid playlists; it is never retried with a video GET. A startup probe is not a throughput benchmark and cannot switch providers during later playback because the extension has no playback telemetry/callback.

## Verification

- `node --test tests/provider.test.cjs`: 27 regression tests passed, covering mode separation, no-dub titles, source/master/variant/segment failures, automatic fallback, captions, forced-only dub captions, redirects, header preservation, mode-separated caching across fresh instances, mixed-audio rejection and elapsed budgets. Timeout simulations assume a corrected host; an additional test explicitly reproduces the unpatched host's 35-second failure.
- Pinned real Goja: Provider compiled and executed without timers, URL, AbortController or Node APIs; mocked Zuna 503 correctly fell back to Yuki SUB. A Goja parser regression reproduced original 35-second versus fixed 1-second settings; a local HTTP response-body test confirmed cancellation at approximately 1 second with the corrected value. This is not a full Seanime application test.
- Live API survey: 18 advertised source calls; 14 successful responses and four Sora HTTP 500 responses. All 14 successful masters and first variants were valid HLS. All 11 Yuki/Zuna first-segment HEAD requests returned 200; three Sora segment HEADs returned 403. Available English subtitle URLs returned valid WebVTT. No video segment bodies were downloaded.
- Live public-method execution used a buffered Seanime-shaped Node adapter that actually enforces the requested timeout. All eight cases resolved; returned stream URLs matched selected API responses exactly:

| Title / episode | Mode | Selected | Approx. time | Attached captions |
| --- | --- | --- | --- | --- |
| Naruto / 1 | SUB | Yuki after Zuna probe timeout | 5.1 s | English |
| Naruto / 1 | DUB | Yuki | 2.0 s | None explicitly forced |
| Hell Mode S2 / 7 | SUB | Yuki; Zuna not advertised | 2.1 s | English |
| Hell Mode S2 / 7 | DUB | Yuki | 2.2 s | Forced English |
| Hajime no Ippo / 1 | SUB | Yuki after Zuna probe timeout | 5.6 s | Upstream tracks null |
| Hajime no Ippo / 1 | DUB | Yuki | 2.1 s | Upstream tracks null |
| Akira / 1 | SUB | Yuki after Zuna probe timeout | 6.2 s | English |
| Akira / 1 | DUB | Yuki | 2.2 s | None explicitly forced |

Naruto Yuki DUB retains its API audio type, URL and playback headers. Hell Mode Yuki SUB/DUB use different API requests and stream URLs. Actual audible language, visual subtitle synchronization, sustained playback and burned-in Ippo captions were not verified in the installed Seanime player. The provider cannot manufacture subtitle files when AnimeX returns none.
