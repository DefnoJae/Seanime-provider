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
	if len(calls) != 5 {
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
	if err == nil || time.Since(started) > 2*time.Second {
		t.Fatalf("body not cancelled in time: %v", err)
	}
	t.Logf("Original parser uses %ds; fixed parser cancels body at %v", old, time.Since(started))
}
