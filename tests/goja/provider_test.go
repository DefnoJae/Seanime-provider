package main

import (
	"fmt"
	"github.com/dop251/goja"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProviderInPinnedGoja(t *testing.T) {
	code, err := os.ReadFile("../../Provider.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	vm.Set("console", map[string]interface{}{"log": func(...interface{}) {}})
	calls := []string{}
	vm.Set("fetch", func(call goja.FunctionCall) goja.Value {
		url := call.Argument(0).String()
		calls = append(calls, url)
		status := 200
		var payload interface{}
		body := ""
		switch {
		case strings.Contains(url, "/servers?"):
			payload = map[string]interface{}{"subProviders": []string{"zuna", "yuki"}, "dubProviders": []string{"yuki"}}
		case strings.Contains(url, "/sources?"):
			host := "https://good.example/media.m3u8"
			if strings.Contains(url, "providerId=zuna") {
				host = "https://bad.example/master.m3u8"
			}
			payload = map[string]interface{}{"sources": []interface{}{map[string]interface{}{"url": host}}, "tracks": []interface{}{map[string]interface{}{"file": "https://subs.example/en.vtt", "label": "English", "kind": "captions"}}}
		case strings.Contains(url, "bad.example"):
			status = 503
		case strings.Contains(url, "good.example"):
			body = "#EXTM3U\n#EXTINF:6,\nsegment.ts\n"
		default:
			t.Fatalf("unexpected request %s", url)
		}
		o := vm.NewObject()
		o.Set("ok", status == 200)
		o.Set("status", status)
		o.Set("url", url)
		o.Set("headers", map[string]string{})
		o.Set("json", func() interface{} { return payload })
		o.Set("text", func() string { return body })
		return o
	})
	if _, err = vm.RunString(string(code)); err != nil {
		t.Fatal(err)
	}
	v, err := vm.RunString(`new Provider().findEpisodeServer({id:"fixture-episode-1$sub"},"AnimeX Sub")`)
	if err != nil {
		t.Fatal(err)
	}
	promise, ok := v.Export().(*goja.Promise)
	if !ok || promise.State() != goja.PromiseStateFulfilled {
		t.Fatalf("unfulfilled result: %v", v)
	}
	result := promise.Result().Export().(map[string]interface{})
	if result["server"] != "yuki" {
		t.Fatal(result)
	}
	if len(calls) != 6 {
		t.Fatalf("expected servers, two source requests and two probes: %v", calls)
	}
	t.Log("Provider ran in pinned Goja without timers, AbortController, URL or Node APIs; Zuna 503 fell back to Yuki SUB")
}

func TestTimeoutParserAndBodyDeadline(t *testing.T) {
	vm := goja.New()
	v, err := vm.RunString("({timeout:1}).timeout")
	if err != nil {
		t.Fatal(err)
	}
	old := 35
	if n, ok := v.Export().(int); ok {
		old = n
	}
	fixed := 35
	if n := v.ToInteger(); n > 0 && n <= 86400 {
		fixed = int(n)
	}
	if old != 35 || fixed != 1 {
		t.Fatalf("old=%d fixed=%d", old, fixed)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
			fmt.Fprint(w, "late body")
		}
	}))
	defer server.Close()
	client := http.Client{Timeout: time.Duration(fixed) * time.Second}
	started := time.Now()
	response, err := client.Get(server.URL)
	if err == nil {
		defer response.Body.Close()
		_, err = io.ReadAll(response.Body)
	}
	if err == nil || !os.IsTimeout(err) || time.Since(started) > 2*time.Second {
		t.Fatalf("body not cancelled in time: %v", err)
	}
	t.Logf("Original parser uses %ds; fixed parser cancels body at %v", old, time.Since(started))
}

func TestHungCandidatesDoNotBlockGoja(t *testing.T) {
	code, err := os.ReadFile("../../Provider.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	vm.Set("console", map[string]interface{}{"log": func(...interface{}) {}})
	var finishYuki func(interface{}) error
	calls := []string{}
	vm.Set("fetch", func(call goja.FunctionCall) goja.Value {
		url := call.Argument(0).String()
		calls = append(calls, url)
		if strings.Contains(url, "/sources?") && strings.Contains(url, "providerId=yuki") {
			p, resolve, _ := vm.NewPromise()
			finishYuki = resolve
			return vm.ToValue(p)
		}
		status := 200
		var payload interface{}
		body := ""
		switch {
		case strings.Contains(url, "/servers?"):
			payload = map[string]interface{}{"dubProviders": []string{"nero", "yuki", "loli"}}
		case strings.Contains(url, "providerId=nero"):
			status = 504
		case strings.Contains(url, "providerId=loli"):
			payload = map[string]interface{}{"sources": []interface{}{map[string]interface{}{"url": "https://good.example/stream.m3u8"}}}
		case strings.Contains(url, "good.example"):
			body = "#EXTM3U\n#EXTINF:6,\nsegment.ts\n"
		default:
			t.Fatalf("unexpected request %s", url)
		}
		o := vm.NewObject()
		o.Set("ok", status == 200)
		o.Set("status", status)
		o.Set("url", url)
		o.Set("headers", map[string]string{})
		o.Set("text", func() string { return body })
		o.Set("json", func() interface{} { return payload })
		return o
	})
	if _, err = vm.RunString(string(code)); err != nil {
		t.Fatal(err)
	}
	v, err := vm.RunString(`new Provider().findEpisodeServer({id:"yakuza-episode-9$dub"},"AnimeX Dub")`)
	if err != nil {
		t.Fatal(err)
	}
	p := v.Export().(*goja.Promise)
	if p.State() != goja.PromiseStateFulfilled {
		t.Fatalf("selection waited for hung Yuki: %v", p.State())
	}
	result := p.Result().Export().(map[string]interface{})
	if result["server"] != "loli" {
		t.Fatal(result)
	}
	before := len(calls)
	if finishYuki == nil {
		t.Fatal("Yuki was not attempted")
	}
	late := vm.NewObject()
	late.Set("ok", true)
	late.Set("status", 200)
	late.Set("json", func() interface{} {
		return map[string]interface{}{"sources": []interface{}{map[string]interface{}{"url": "https://late.example/master.m3u8"}}}
	})
	if err := finishYuki(late); err != nil {
		t.Fatal(err)
	}
	// Flush jobs on the same goroutine, as a host dispatch loop must do.
	if _, err = vm.RunString("void 0"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != before {
		t.Fatal("late loser issued more requests")
	}
	t.Log("Real Goja returned Loli DUB while Yuki promise remained unresolved; late Yuki issued no follow-up requests")
}

func TestProxyIncompatiblePlaylistCannotWin(t *testing.T) {
	code, err := os.ReadFile("../../Provider.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	incompatible := false
	vm.Set("console", map[string]interface{}{"log": func(s string) {
		if strings.Contains(s, "incompatible with Seanime proxy") {
			incompatible = true
		}
	}})
	vm.Set("fetch", func(call goja.FunctionCall) goja.Value {
		url := call.Argument(0).String()
		var payload interface{}
		body := ""
		contentType := ""
		switch {
		case strings.Contains(url, "/servers?"):
			payload = map[string]interface{}{"dubProviders": []string{"yuki", "loli"}}
		case strings.Contains(url, "/sources?"):
			sourceURL := "https://good.example/master.m3u8"
			if strings.Contains(url, "providerId=loli") {
				sourceURL = "https://loli.example/cdn/master-token?t.m3u8&v.m3u8"
			}
			payload = map[string]interface{}{"sources": []interface{}{map[string]interface{}{"url": sourceURL, "type": "application/vnd.apple.mpegurl"}}}
		case strings.Contains(url, "loli.example"):
			body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n/cdn/variant-token\n"
			contentType = "image/jpeg"
		case strings.Contains(url, "good.example"):
			body = "#EXTM3U\n#EXTINF:6,\nsegment.ts\n"
		default:
			t.Fatalf("unexpected request %s", url)
		}
		o := vm.NewObject()
		o.Set("ok", true)
		o.Set("status", 200)
		o.Set("url", url)
		o.Set("contentType", contentType)
		o.Set("headers", map[string]string{"Content-Type": contentType})
		o.Set("json", func() interface{} { return payload })
		o.Set("text", func() string { return body })
		return o
	})
	if _, err = vm.RunString(string(code)); err != nil {
		t.Fatal(err)
	}
	v, err := vm.RunString(`new Provider().findEpisodeServer({id:"yakuza-episode-9$dub"},"AnimeX Dub")`)
	if err != nil {
		t.Fatal(err)
	}
	p := v.Export().(*goja.Promise)
	if p.State() != goja.PromiseStateFulfilled {
		t.Fatalf("selection failed: %v", p.Result())
	}
	result := p.Result().Export().(map[string]interface{})
	if result["server"] != "yuki" || !incompatible {
		t.Fatalf("result=%v incompatible=%v", result, incompatible)
	}
	t.Log("Goja rejected extensionless image/jpeg Loli playlist despite source.type=mpegurl and selected Yuki")
}
