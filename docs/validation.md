# AnimeX 1.0.20 — source-request stalls

Prepared on October 17, 2026 from current main `9426f97` (1.0.19). Provider and manifest changes belong to one atomic commit.

## Reported failure and cause

The supplied logs show Yuki DUB waiting from 12:48:11 until 12:48:34, followed by `Request time budget exhausted`. Refresh issued another request while the first was pending. Nero then also waited, and the player received `no source found for episode` after 23–28 seconds. The screenshot separately reports Nero SUB timing out for episode 2 of `saijo-no-osewa-...-5r98a`.

The source service can stall or return a gateway error. Additionally, Seanime's current fetch parser still accepts `o.Export().(int)` for timeout, whereas its Goja exports ordinary JS integers as `int64`. The requested 4-second timeout is consequently ignored on affected hosts. The old sequential resolver let a slow source consume the entire 12-second budget before another provider could be validated, and discarded otherwise usable late responses.

## Fix

- `raceProviders` orders only the current audio mode's advertised providers, removes briefly cached failures and starts at most four candidate pipelines together. It returns the first source that passes playback validation. A pending Yuki or Nero request therefore cannot block a healthy Loli, Yuki or other admitted candidate.
- `resolveCandidate` preserves the current API `type`, source URL, headers and source-specific subtitles. Late but valid source responses receive a fresh playback-probe budget instead of being discarded by the obsolete global deadline.
- `selectHealthyProvider` shares overlapping requests for the same anime, episode and mode inside a reused VM. The entry is removed on completion. Other VMs have independent caches.
- `probeHlsSource` checks the master, a variant and first media segment HEAD for every HLS backend. It excludes explicitly incompatible default audio and avoids video-body downloads. HEAD 405/501 remains an unsupported-method case after valid playlists; other segment errors reject the source. Cache successes require the identical URL and headers.
- `getSources` avoids redundant transient retries when alternatives already run. A lone Yuki DUB retains its bounded transient retry. Once a winner is chosen, late losing requests cannot initiate further probes/retries or poison the health cache.
- Manifest version is **1.0.20**.

Zuna SUB and Yuki SUB/DUB retain launch precedence when advertised. Actual readiness decides the winner, so a faster validated alternative may beat the preferred provider. Only one backend is returned to Seanime. New backend names require no title-specific changes. No opposite-mode providers, speculative proxy encodings, custom timer goroutines or Node APIs are introduced.

SUB retains selected-source WebVTT tracks and defaults to full English when supplied. DUB retains only explicitly forced/signs/songs English captions. No extra subtitle backend requests are made. Empty DUB discovery still produces no source requests, and `$sub`/`$dub` IDs and opposite-server rejection remain intact.

## Validation

`node --test tests/provider.test.cjs`: **33 tests passed**. They cover the two reported failures with unresolved primary fetches, a hung HLS probe, late valid responses, in-flight refresh sharing, first-segment failures, mode separation, captions, redirects, signed-URL preservation and capped candidate count. The hung-request regressions execute in a VM without timers or AbortController and return before the stalled fetch resolves.

From `tests/goja`, `go test -v .`: **3 tests passed** against the pinned real Goja engine. The new regression leaves Yuki's native promise unresolved, returns Nero 504, verifies Loli DUB is selected, then resolves late Yuki and verifies no new request starts. The timeout parser/loopback test reproduces the host int/int64 defect and verifies actual response-body cancellation at approximately 1 second when corrected. This is an engine/transport test, not an installed-app playback test.

Final live checks deliberately ignored every `fetch.timeout` value and used the affected host's 35-second HTTP cap. All selected streams passed master/variant/first-segment checks. All supplied selected English captions fetched as valid WebVTT. No video segment bodies were fetched.

| Title / episode | Mode | Selected | Resolution time | Captions returned |
| --- | --- | --- | --- | --- |
| The Yakuza's Guide to Babysitting / 9 | DUB | Loli | 1.18 s | None supplied |
| Screenshot title (`saijo-no-osewa-...-5r98a`) / 2 | SUB | Yuki | 1.25 s | 9; English default |
| Naruto / 1 | SUB | Yuki | 1.24 s | English |
| Naruto / 1 | DUB | Yuki | 1.27 s | No explicitly forced track |
| Hell Mode S2 / 7 | SUB | Yuki | 1.22 s | English |
| Hell Mode S2 / 7 | DUB | Yuki | 1.32 s | Forced English |
| Hajime no Ippo / 1 | SUB | Yuki | 1.15 s | Upstream tracks null |
| Hajime no Ippo / 1 | DUB | Yuki | 1.12 s | Upstream tracks null |
| Akira / 1 | SUB | Loli | 1.19 s | None supplied |
| Akira / 1 | DUB | Yuki | 1.37 s | No explicitly forced track |

Returned stream URLs were unchanged from their selected API responses in all ten cases. Earlier exploratory calls also observed intermittent upstream 500s, slow 10–19-second source responses and Sora segment 403s; the final success matrix does not establish that the service is always healthy.

## Runtime limits

The parallel fallback works on the affected runtime without rebuilding Seanime. The optional `seanime-fetch-timeout.patch` remains useful for genuine HTTP cancellation, but it is no longer required to prevent one stuck candidate from blocking another healthy candidate.

The extension cannot cancel in-flight HTTP requests on that host. Already-issued losing requests may finish at the host's native timeout; their results are ignored. If discovery itself stalls or every candidate is unavailable, this extension cannot guarantee a short wall-clock timeout or create a working upstream stream. Candidate count, retry count and playlist traversal remain finite. No elapsed-budget claim is presented as network cancellation.

Actual decoded audio, caption synchronization, burned-in subtitles and sustained playback in the installed player were not verified. A HEAD check is an availability check, not a throughput benchmark; mid-playback buffering cannot trigger an extension callback.

Primary runtime sources checked again on October 17:

- [Fetch timeout parsing, HEAD support and buffered bodies](https://github.com/5rahim/seanime/blob/main/internal/goja/goja_bindings/fetch.go)
- [Provider VM bindings and instance lifecycle](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_base.go)
- [Shared provider bindings](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja.go)
- [EpisodeServer and subtitle types](https://github.com/5rahim/seanime/blob/main/internal/extension/hibike/onlinestream/types.go)
