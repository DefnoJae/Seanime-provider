'use strict';

// Run with: node --test tests/provider.test.cjs
// The provider executes in an isolated, Goja-like realm. URL, AbortController,
// timers, process, require and Buffer are deliberately unavailable to it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const providerCode = fs.readFileSync(path.join(__dirname, '..', 'Provider.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function createHarness(route) {
  let elapsed = 0;
  const calls = [];
  const logs = [];
  const epoch = 1800000000000;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch + elapsed])); }
    static now() { return epoch + elapsed; }
  }
  const context = vm.createContext({
    Date: ClockDate,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    fetch: async (url, options = {}) => {
      const call = { url: String(url), options: plain(options) };
      calls.push(call);
      const parsed = new URL(call.url);
      let result = await route(parsed, call.options, {
        calls, advance: ms => { elapsed += ms; }, elapsed: () => elapsed,
      });
      if (result === undefined && ['video.example', 'cdn.example'].includes(parsed.hostname) && parsed.pathname.endsWith('.m3u8')) {
        result = { text: '#EXTM3U\n#EXTINF:6.0,\npart-0001.ts\n#EXT-X-ENDLIST\n' };
      }
      if (result === undefined) throw new Error('Unexpected fetch: ' + parsed.origin + parsed.pathname);
      const status = result.status === undefined ? 200 : result.status;
      const headers = Object.assign({}, result.headers || {});
      return {
        ok: status >= 200 && status < 300,
        status,
        url: result.url || call.url,
        headers,
        contentType: headers['Content-Type'] || headers['content-type'] || '',
        json: async () => result.json,
        text: async () => result.text === undefined ? JSON.stringify(result.json) : result.text,
      };
    },
  });
  vm.runInContext(providerCode + '\nthis.testProvider = new Provider();', context, { timeout: 1000 });
  return { provider: context.testProvider, calls, logs, elapsed: () => elapsed,
    newProvider: () => vm.runInContext('new Provider()', context) };
}

const sources = harness => harness.calls.filter(call => new URL(call.url).pathname.endsWith('/sources'));
const requestModes = harness => sources(harness).map(call => {
  const params = new URL(call.url).searchParams;
  return params.get('type') + ':' + params.get('providerId');
});
const isAPI = (url, name) => url.pathname === '/rest/api/' + name;
const stream = (url = 'https://video.example/stream.m3u8?token=working-token') => ({
  sources: [{ url, type: 'video/mpegurl', quality: 'auto' }],
});
const masterURL = 'https://hls.1embed.buzz/anime/master.m3u8?sig=master-token';
const variantURL = 'https://hls.1embed.buzz/anime/360/index.m3u8?sig=variant-token';
const segmentURL = 'https://hls.1embed.buzz/anime/360/part-0001.ts?sig=segment-token';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\n360/index.m3u8?sig=variant-token\n';
const variant = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\npart-0001.ts?sig=segment-token\n#EXT-X-ENDLIST\n';

function hlsResponse(url, options) {
  if (url.href === masterURL) return { text: master };
  if (url.href === variantURL) return { text: variant };
  if (url.href === segmentURL) {
    assert.equal(options.method, 'HEAD', 'segment probes must not download full video bodies');
    return { text: '', headers: { 'Content-Type': 'video/mp2t', 'Content-Length': '240000' } };
  }
}

test('search and episode enumeration retain separate sub/dub IDs and URLs', async () => {
  const h = createHarness(url => {
    if (url.pathname === '/graphql') return { json: { data: { searchAnime: { items: [{ id: 'some-anime', titleEnglish: 'Some &amp; Anime' }] } } } };
    if (isAPI(url, 'episodes')) return { json: [{ number: 1 }, { number: 7 }] };
  });
  for (const mode of ['sub', 'dub']) {
    const results = await h.provider.search({ query: 'Some Anime', dub: mode === 'dub' });
    assert.equal(results[0].id, 'some-anime$' + mode);
    assert.equal(results[0].subOrDub, mode);
    assert.equal(results[0].title, 'Some & Anime');
    const episodes = await h.provider.findEpisodes(results[0].id);
    assert.deepEqual(plain(episodes.map(item => item.id)), ['some-anime-episode-1$' + mode, 'some-anime-episode-7$' + mode]);
    assert.ok(episodes.every(item => item.url.endsWith('?audio=' + mode)));
  }
});

test('opposite episode-server mode is rejected before any network access', async () => {
  const h = createHarness(() => { throw new Error('Network must not be called'); });
  await assert.rejects(() => h.provider.findEpisodeServer({ id: 'some-anime-episode-1$sub' }, 'AnimeX Dub'));
  await assert.rejects(() => h.provider.findEpisodeServer({ id: 'some-anime-episode-1$dub' }, 'AnimeX Sub'));
  assert.equal(h.calls.length, 0);
});

for (const servers of [
  { subProviders: ['zuna', 'yuki'], dubProviders: [] },
  { subProviders: ['zuna', 'yuki'] },
  { subProviders: ['zuna'], dubProviders: [], providers: ['zuna'] },
  { data: { subProviders: ['zuna'], dubProviders: [] } },
]) {
  test('successful discovery never manufactures a dub: ' + JSON.stringify(servers), async () => {
    const h = createHarness(url => {
      if (isAPI(url, 'servers')) return { json: servers };
      if (isAPI(url, 'sources')) return { json: stream() };
    });
    await assert.rejects(() => h.provider.findEpisodeServer({ id: 'sub-only-episode-1$dub' }, 'AnimeX Dub'));
    assert.equal(sources(h).length, 0);
  });
}

test('Hell Mode can select Yuki independently in both modes without fabricating Zuna or Neko', async () => {
  for (const mode of ['sub', 'dub']) {
    const h = createHarness(url => {
      if (isAPI(url, 'servers')) return { json: { subProviders: ['yuki', 'sora'], dubProviders: ['yuki'] } };
      if (isAPI(url, 'sources')) return { json: stream('https://video.example/' + url.searchParams.get('type') + '.m3u8') };
    });
    const result = await h.provider.findEpisodeServer({ id: 'hell-mode-season-2-episode-7$' + mode }, 'AnimeX ' + mode);
    assert.equal(result.server, 'yuki');
    assert.equal(result.videoSources[0].url, 'https://video.example/' + mode + '.m3u8');
    assert.deepEqual(requestModes(h), [mode + ':yuki']);
  }
});

test('healthy Zuna remains preferred and probes master, variant and segment with playback headers', async () => {
  const h = createHarness((url, options) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['sora', 'yuki', 'zuna'], dubProviders: ['yuki'] } };
    if (isAPI(url, 'sources')) return { json: Object.assign(stream(masterURL), { headers: { 'X-Playback': 'test-value' } }) };
    return hlsResponse(url, options);
  });
  const result = await h.provider.findEpisodeServer({ id: 'naruto-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(result.server, 'zuna');
  assert.deepEqual(requestModes(h), ['sub:zuna']);
  const probes = h.calls.filter(call => new URL(call.url).hostname === 'hls.1embed.buzz');
  assert.deepEqual(probes.map(call => call.url), [masterURL, variantURL, segmentURL]);
  for (const probe of probes) assert.deepEqual(probe.options.headers, plain(result.headers));
  assert.equal(result.headers.Referer, 'https://zokoanime.video/');
  assert.equal(result.headers.Origin, 'https://zokoanime.video');
  assert.equal(result.headers['X-Playback'], 'test-value');
  assert.equal(result.videoSources[0].url, masterURL);
});

for (const failedStage of ['master', 'malformed-master', 'variant', 'segment']) {
  test('Zuna ' + failedStage + ' failure automatically falls back to advertised Yuki SUB', async () => {
    const h = createHarness((url, options) => {
      if (isAPI(url, 'servers')) return { json: { subProviders: ['sora', 'zuna', 'yuki'], dubProviders: ['neko'] } };
      if (isAPI(url, 'sources')) return { json: url.searchParams.get('providerId') === 'zuna' ? stream(masterURL) : {
        ...stream(), tracks: [{ file: 'https://subs.example/yuki-en.vtt', label: 'English', kind: 'captions' }],
      } };
      if ((failedStage === 'master' && url.href === masterURL) ||
          (failedStage === 'variant' && url.href === variantURL) ||
          (failedStage === 'segment' && url.href === segmentURL)) return { status: 503, text: '' };
      if (failedStage === 'malformed-master' && url.href === masterURL) return { text: '<html>Access denied</html>' };
      return hlsResponse(url, options);
    });
    const result = await h.provider.findEpisodeServer({ id: 'hajime-no-ippo-episode-1$sub' }, 'AnimeX Sub');
    assert.equal(result.server, 'yuki');
    assert.deepEqual(requestModes(h), ['sub:zuna', 'sub:yuki']);
    assert.equal(result.videoSources[0].subtitles[0].url, 'https://subs.example/yuki-en.vtt');
  });
}

test('Zuna source API failure retains the remaining advertised sub candidates', async () => {
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'yuki'], dubProviders: ['sora'] } };
    if (isAPI(url, 'sources')) return url.searchParams.get('providerId') === 'zuna' ? { status: 503 } : { json: stream() };
  });
  const result = await h.provider.findEpisodeServer({ id: 'akira-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(result.server, 'yuki');
  assert.deepEqual(requestModes(h), ['sub:zuna', 'sub:yuki']);
});

test('Naruto Yuki DUB preserves the signed source URL and response playback headers', async () => {
  const workingURL = 'https://cdn.example/naruto/master.m3u8?token=AbC%2Fdef%2Bghi&expires=1900000000';
  const workingHeaders = { Referer: 'https://working-player.example/embed/one', Origin: 'https://working-player.example', 'X-Token': 'header-token' };
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna'], dubProviders: ['sora', 'yuki'] } };
    if (isAPI(url, 'sources')) return { json: { ...stream(workingURL), headers: workingHeaders } };
  });
  const result = await h.provider.findEpisodeServer({ id: 'naruto-episode-1$dub' }, 'AnimeX Dub');
  assert.equal(result.server, 'yuki');
  assert.equal(result.videoSources[0].url, workingURL);
  assert.equal(result.videoSources[0].type, 'm3u8');
  assert.deepEqual(plain(result.headers), workingHeaders);
  assert.deepEqual(requestModes(h), ['dub:yuki']);
  assert.ok(!h.calls.some(call => call.url.includes('/uwu/') || call.url.includes('cdnx.aniwatchtv.site')));
});

test('failed Yuki DUB uses another advertised DUB provider, never the SUB list', async () => {
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'neko'], dubProviders: ['yuki', 'sora'] } };
    if (isAPI(url, 'sources')) return url.searchParams.get('providerId') === 'yuki' ? { status: 503 } : { json: stream() };
  });
  const result = await h.provider.findEpisodeServer({ id: 'hajime-no-ippo-episode-1$dub' }, 'AnimeX Dub');
  assert.equal(result.server, 'sora');
  assert.ok(requestModes(h).length >= 2);
  assert.ok(requestModes(h).every(value => value === 'dub:yuki' || value === 'dub:sora'));
  assert.equal(requestModes(h).at(-1), 'dub:sora');
});

test('SUB attaches legitimate selected-provider subtitle tracks to every video source with English default', async () => {
  const tracks = [
    { file: 'https://subs.example/es.vtt', label: 'Spanish', language: 'es', kind: 'subtitles', default: true },
    { url: 'https://subs.example/en.vtt?token=en-token', label: 'English', kind: 'captions' },
    { src: 'https://subs.example/fr.vtt', label: 'French', srclang: 'fr', kind: 'subtitles' },
    { file: 'https://subs.example/thumbs.vtt', label: 'Thumbnails', kind: 'thumbnails' },
    { file: 'https://subs.example/chapters.vtt', label: 'Chapters', kind: 'chapters' },
    { file: 'https://subs.example/metadata.vtt', label: 'Metadata', kind: 'metadata' },
    { file: 'https://subs.example/sprite.jpg', label: 'English', kind: 'captions' },
    { file: 'https://subs.example/sprite.png', label: 'English', kind: 'captions' },
    { file: 'https://subs.example/sprite.webp', label: 'English', kind: 'captions' },
    { file: 'https://subs.example/cues.vtt#xywh=0,0,120,80', label: 'English', kind: 'captions' },
    { file: 'javascript:alert(1)', label: 'English', kind: 'captions' },
  ];
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['yuki'], dubProviders: ['neko'] } };
    if (isAPI(url, 'sources')) return { json: { data: { sources: [
      { file: 'https://video.example/720.m3u8', type: 'video/mpegurl' },
      { url: 'https://video.example/1080.m3u8', format: 'hls' },
    ], subtitles: tracks } } };
  });
  const result = await h.provider.findEpisodeServer({ id: 'hell-mode-season-2-episode-7$sub' }, 'AnimeX Sub');
  assert.ok(result.videoSources.length >= 1);
  for (const source of result.videoSources) {
    const subtitles = plain(source.subtitles || []);
    assert.equal(subtitles.length, 3);
    assert.deepEqual(subtitles.map(track => track.url).sort(), [tracks[0].file, tracks[1].url, tracks[2].src].sort());
    assert.ok(subtitles.every(track => typeof track.id === 'string' && typeof track.language === 'string' && typeof track.isDefault === 'boolean'));
    const defaults = subtitles.filter(track => track.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].language, 'en');
    assert.equal(defaults[0].url, tracks[1].url);
  }
  assert.deepEqual(requestModes(h), ['sub:yuki']);
});

test('DUB keeps explicitly forced English tracks and excludes full dialogue subtitles', async () => {
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna'], dubProviders: ['yuki'] } };
    if (isAPI(url, 'sources')) return { json: { ...stream(), tracks: [
      { file: 'https://subs.example/full-en.vtt', label: 'English', kind: 'captions', default: true },
      { file: 'https://subs.example/forced-en.vtt', label: 'English (Signs & Songs)', kind: 'captions' },
      { file: 'https://subs.example/es.vtt', label: 'Spanish', kind: 'captions' },
      { file: 'https://subs.example/thumbnails.vtt', label: 'English (Forced)', kind: 'thumbnails' },
    ] } };
  });
  const result = await h.provider.findEpisodeServer({ id: 'naruto-episode-1$dub' }, 'AnimeX Dub');
  const subtitles = plain(result.videoSources[0].subtitles || []);
  assert.equal(subtitles.length, 1);
  assert.equal(subtitles[0].url, 'https://subs.example/forced-en.vtt');
  assert.equal(subtitles[0].language, 'en');
  assert.deepEqual(requestModes(h), ['dub:yuki']);
});

test('Yuki SUB and DUB source URLs are never rewritten into the reverted uwu proxy', async () => {
  const url = 'https://video.example/stream/master.m3u8?signature=unaltered';
  for (const mode of ['sub', 'dub']) {
    const h = createHarness(request => {
      if (isAPI(request, 'servers')) return { json: { subProviders: ['yuki'], dubProviders: ['yuki'] } };
      if (isAPI(request, 'sources')) return { json: stream(url) };
      if (request.href === url) return { text: variant };
      if (request.hostname === 'video.example') return { text: '' };
    });
    const result = await h.provider.findEpisodeServer({ id: 'some-title-episode-1$' + mode }, 'AnimeX ' + mode);
    assert.equal(result.videoSources[0].url, url);
    assert.ok(!h.calls.some(call => call.url.includes('/uwu/') || call.url.includes('cdnx.aniwatchtv.site')));
  }
});

test('a short Zuna probe timeout leaves time to try Yuki SUB', async () => {
  const h = createHarness((url, options, clock) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'yuki'], dubProviders: [] } };
    if (isAPI(url, 'sources')) return { json: url.searchParams.get('providerId') === 'zuna' ? stream(masterURL) : stream() };
    if (url.href === masterURL) {
      clock.advance(Number.isFinite(options.timeout) ? options.timeout * 1000 : 35000);
      throw new Error('request timeout');
    }
  });
  const result = await h.provider.findEpisodeServer({ id: 'naruto-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(result.server, 'yuki');
  assert.deepEqual(requestModes(h), ['sub:zuna', 'sub:yuki']);
  assert.ok(h.elapsed() <= 3000);
  const probe = h.calls.find(call => call.url === masterURL);
  assert.ok(probe && Number.isFinite(probe.options.timeout) && probe.options.timeout > 0 && probe.options.timeout <= 3,
    'Goja fetch requires a short native timeout in seconds');
});

test('selection is bounded by a shared deadline instead of sequentially timing out every provider', async () => {
  const advertised = ['zuna', 'yuki', 'sora', 'neko', 'kiwi', 'mimi', 'miku', 'uwu', 'shiro', 'mochi'];
  const h = createHarness((url, options, clock) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: advertised, dubProviders: [] } };
    if (isAPI(url, 'sources')) {
      clock.advance(Number.isFinite(options.timeout) ? options.timeout * 1000 : 35000);
      throw new Error('request timeout');
    }
  });
  await assert.rejects(() => h.provider.findEpisodeServer({ id: 'some-title-episode-1$sub' }, 'AnimeX Sub'));
  assert.ok(sources(h).length > 0, 'must attempt advertised candidates before rejecting');
  assert.ok(h.elapsed() <= 12000, 'total simulated network wait was ' + h.elapsed() + 'ms');
  assert.ok(sources(h).length < advertised.length, 'must stop trying candidates when the shared budget expires');
  assert.ok(requestModes(h).every(value => value.startsWith('sub:')));
  for (const call of h.calls) {
    assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0 && call.options.timeout <= 4,
      'selection fetches must use the native Goja timeout in seconds');
  }
});

test('redirected Zuna masters resolve relative variant and segment URLs against the final URL', async () => {
  const redirectedMaster = 'https://redirect.example/hls/title/master.m3u8?sig=redirected';
  const redirectedVariant = 'https://redirect.example/hls/low/index.m3u8?sig=low';
  const redirectedSegment = 'https://redirect.example/hls/segments/one.ts?sig=segment';
  const h = createHarness((url, options) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'yuki'], dubProviders: [] } };
    if (isAPI(url, 'sources')) return { json: stream(masterURL) };
    if (url.href === masterURL) return { url: redirectedMaster, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\n../low/index.m3u8?sig=low\n' };
    if (url.href === redirectedVariant) return { text: '#EXTM3U\n#EXTINF:5,\n../segments/one.ts?sig=segment\n' };
    if (url.href === redirectedSegment) return { text: '', headers: { 'Content-Type': 'video/mp2t' } };
  });
  const result = await h.provider.findEpisodeServer({ id: 'some-title-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(result.server, 'zuna');
  const probes = h.calls.filter(call => !call.url.startsWith('https://pp.animex.one/'));
  assert.deepEqual(probes.map(call => call.url), [masterURL, redirectedVariant, redirectedSegment]);
  assert.equal(probes[2].options.method, 'HEAD');
  for (const call of probes) assert.deepEqual(call.options.headers, plain(result.headers));
});

test('a successful segment HEAD returning HTML is unhealthy and selects Yuki instead', async () => {
  const h = createHarness((url, options) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'yuki'], dubProviders: [] } };
    if (isAPI(url, 'sources')) return { json: url.searchParams.get('providerId') === 'zuna' ? stream(masterURL) : stream() };
    if (url.href === segmentURL) return { text: '', headers: { 'Content-Type': 'text/html; charset=utf-8' } };
    return hlsResponse(url, options);
  });
  const result = await h.provider.findEpisodeServer({ id: 'some-title-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(result.server, 'yuki');
  assert.deepEqual(requestModes(h), ['sub:zuna', 'sub:yuki']);
});

test('DUB rejects a mislabeled source whose HLS master explicitly defaults to Japanese audio', async () => {
  const multiURL = 'https://multi.example/master.m3u8';
  const mixedMaster = '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,AUTOSELECT=YES,URI="ja.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="en.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="audio"\nvideo.m3u8\n';
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna'], dubProviders: ['sora', 'mimi'] } };
    if (isAPI(url, 'sources')) return { json: stream(url.searchParams.get('providerId') === 'sora' ? multiURL : undefined) };
    if (url.href === multiURL) return { text: mixedMaster };
    if (url.hostname === 'multi.example') return { text: variant };
  });
  const result = await h.provider.findEpisodeServer({ id: 'some-title-episode-1$dub' }, 'AnimeX Dub');
  assert.equal(result.server, 'mimi');
  assert.deepEqual(requestModes(h), ['dub:sora', 'dub:mimi']);
});

test('a successful health cache avoids repeated probes but never shares SUB and DUB decisions', async () => {
  const h = createHarness((url, options) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna'], dubProviders: ['zuna'] } };
    if (isAPI(url, 'sources')) return { json: stream(masterURL) };
    return hlsResponse(url, options);
  });
  await h.provider.findEpisodeServer({ id: 'some-title-episode-1$sub' }, 'AnimeX Sub');
  await h.provider.findEpisodeServer({ id: 'some-title-episode-1$sub' }, 'AnimeX Sub');
  const subProbes = h.calls.filter(call => call.url === masterURL).length;
  assert.equal(subProbes, 1);
  await h.provider.findEpisodeServer({ id: 'some-title-episode-1$dub' }, 'AnimeX Dub');
  assert.equal(h.calls.filter(call => call.url === masterURL).length, 2);
});

test('discovery transport failure uses only the conservative same-mode fallback', async () => {
  const h = createHarness(url => {
    if (isAPI(url, 'servers')) return { status: 503 };
    if (isAPI(url, 'sources')) return { json: stream() };
  });
  const result = await h.provider.findEpisodeServer({ id: 'fixture-episode-1$dub' }, 'AnimeX Dub');
  assert.equal(result.server, 'yuki');
  assert.deepEqual(requestModes(h), ['dub:yuki']);
});

test('health cache survives the fresh Provider instances created by Seanime', async () => {
  const h = createHarness((url, options) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna'] } };
    if (isAPI(url, 'sources')) return { json: stream(masterURL) };
    return hlsResponse(url, options);
  });
  await h.provider.findEpisodeServer({ id: 'fixture-episode-1$sub' }, 'AnimeX Sub');
  await h.newProvider().findEpisodeServer({ id: 'fixture-episode-1$sub' }, 'AnimeX Sub');
  assert.equal(h.calls.filter(call => call.url === masterURL).length, 1);
});

test('documents host timeout defect: a 35-second in-flight fetch cannot be bounded by elapsed checks', async () => {
  const h = createHarness((url, options, clock) => {
    if (isAPI(url, 'servers')) return { json: { subProviders: ['zuna', 'yuki'] } };
    if (isAPI(url, 'sources')) {
      assert.ok(options.timeout <= 4);
      clock.advance(35000); // Actual affected Goja host ignores this JS option.
      throw new Error('host HTTP timeout');
    }
  });
  await assert.rejects(() => h.provider.findEpisodeServer({ id: 'fixture-episode-1$sub' }, 'AnimeX Sub'));
  assert.equal(h.elapsed(), 35000);
  assert.deepEqual(requestModes(h), ['sub:zuna']);
});
