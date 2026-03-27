package webserver

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/YanaDevOps/owly/group"
)

func TestParseGroupName(t *testing.T) {
	a := []struct{ p, g string }{
		{"", ""},
		{"/foo", ""},
		{"foo", ""},
		{"group/foo", ""},
		{"/group", ""},
		{"/group/..", ""},
		{"/group/foo/../bar", "bar"},
		{"/group/foo", "foo"},
		{"/group/foo/", "foo"},
		{"/group/foo/bar", "foo/bar"},
		{"/group/foo/bar/", "foo/bar"},
	}

	for _, pg := range a {
		g := parseGroupName("/group/", pg.p)
		if g != pg.g {
			t.Errorf("Path %v, got %v, expected %v",
				pg.p, g, pg.g)
		}
	}
}

func TestBase(t *testing.T) {
	a := []struct {
		p      string
		t      bool
		h, res string
	}{
		{"", true, "a.org", "https://a.org"},
		{"", false, "a.org", "http://a.org"},
		{"/base", true, "a.org", "https://a.org/base"},
		{"/base", false, "a.org", "http://a.org/base"},
		{"http:", true, "a.org", "http://a.org"},
		{"https:", false, "a.org", "https://a.org"},
		{"http:/base", true, "a.org", "http://a.org/base"},
		{"https:/base", false, "a.org", "https://a.org/base"},
		{"https://b.org", true, "a.org", "https://b.org"},
		{"https://b.org", false, "a.org", "https://b.org"},
		{"http://b.org", true, "a.org", "http://b.org"},
		{"http://b.org", false, "a.org", "http://b.org"},
	}

	dir := t.TempDir()
	group.DataDirectory = dir

	for _, v := range a {
		conf := group.Configuration{
			ProxyURL: v.p,
		}
		c, err := json.Marshal(conf)
		if err != nil {
			t.Errorf("Marshal: %v", err)
			continue
		}
		err = os.WriteFile(
			filepath.Join(dir, "config.json"),
			c,
			0600,
		)
		if err != nil {
			t.Errorf("Write: %v", err)
			continue
		}
		var tcs *tls.ConnectionState
		if v.t {
			tcs = &tls.ConnectionState{}
		}
		base, err := baseURL(&http.Request{
			TLS:  tcs,
			Host: v.h,
		})
		if err != nil || base.String() != v.res {
			t.Errorf("Expected %v, got %v (%v)",
				v.res, base.String(), err,
			)
		}
	}
}

func TestBaseForwardedHeaders(t *testing.T) {
	dir := t.TempDir()
	group.DataDirectory = dir

	c, err := json.Marshal(group.Configuration{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	err = os.WriteFile(
		filepath.Join(dir, "config.json"),
		c,
		0600,
	)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	t.Run("proto and host", func(t *testing.T) {
		req := &http.Request{
			Host: "owly.internal:8443",
			Header: http.Header{
				"X-Forwarded-Proto": []string{"https"},
				"X-Forwarded-Host":  []string{"owly.example.com"},
			},
		}
		base, err := baseURL(req)
		if err != nil {
			t.Fatalf("baseURL: %v", err)
		}
		if got := base.String(); got != "https://owly.example.com" {
			t.Fatalf("unexpected base url: %q", got)
		}
	})

	t.Run("prefix", func(t *testing.T) {
		req := &http.Request{
			Host: "owly.internal:8443",
			Header: http.Header{
				"X-Forwarded-Proto":  []string{"https"},
				"X-Forwarded-Host":   []string{"owly.example.com"},
				"X-Forwarded-Prefix": []string{"/app"},
			},
		}
		base, err := baseURL(req)
		if err != nil {
			t.Fatalf("baseURL: %v", err)
		}
		if got := base.String(); got != "https://owly.example.com/app" {
			t.Fatalf("unexpected base url: %q", got)
		}
	})

	t.Run("proxy url overrides forwarded", func(t *testing.T) {
		c, err := json.Marshal(group.Configuration{
			ProxyURL: "https://proxy.example.com/base",
		})
		if err != nil {
			t.Fatalf("Marshal with proxy: %v", err)
		}
		err = os.WriteFile(
			filepath.Join(dir, "config.json"),
			c,
			0600,
		)
		if err != nil {
			t.Fatalf("Write with proxy: %v", err)
		}

		req := &http.Request{
			Host: "owly.internal:8443",
			Header: http.Header{
				"X-Forwarded-Proto": []string{"http"},
				"X-Forwarded-Host":  []string{"wrong.example.com"},
			},
		}
		base, err := baseURL(req)
		if err != nil {
			t.Fatalf("baseURL: %v", err)
		}
		if got := base.String(); got != "https://proxy.example.com/base" {
			t.Fatalf("unexpected base url: %q", got)
		}
	})
}

func TestHealthHandler(t *testing.T) {
	t.Run("GET", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		recorder := httptest.NewRecorder()

		healthHandler(recorder, req)

		if recorder.Code != http.StatusOK {
			t.Fatalf("unexpected status code: %v", recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); got != "application/json" {
			t.Fatalf("unexpected content type: %q", got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("unexpected cache control: %q", got)
		}
		if body := recorder.Body.String(); body != "{\"status\":\"ok\"}\n" {
			t.Fatalf("unexpected body: %q", body)
		}
	})

	t.Run("HEAD", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodHead, "/api/health", nil)
		recorder := httptest.NewRecorder()

		healthHandler(recorder, req)

		if recorder.Code != http.StatusOK {
			t.Fatalf("unexpected status code: %v", recorder.Code)
		}
		if body := recorder.Body.String(); body != "" {
			t.Fatalf("unexpected body for HEAD: %q", body)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/health", nil)
		recorder := httptest.NewRecorder()

		healthHandler(recorder, req)

		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("unexpected status code: %v", recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != "OPTIONS, HEAD, GET" {
			t.Fatalf("unexpected allow header: %q", got)
		}
	})
}

func TestParseSplit(t *testing.T) {
	a := []struct{ p, a, b, c string }{
		{"", "", "", ""},
		{"/a", "/a", "", ""},
		{"/.a", "", ".a", ""},
		{"/.a/", "", ".a", "/"},
		{"/.a/b", "", ".a", "/b"},
		{"/.a/b/", "", ".a", "/b/"},
		{"/.a/b/c", "", ".a", "/b/c"},
		{"/.a/b/c", "", ".a", "/b/c"},
		{"/.a/b/.c/", "", ".a", "/b/.c/"},
		{"/a/.b", "/a", ".b", ""},
		{"/a/.b/", "/a", ".b", "/"},
		{"/a/.b/c", "/a", ".b", "/c"},
		{"/a/.b/c/", "/a", ".b", "/c/"},
		{"/a/.b/c/d", "/a", ".b", "/c/d"},
		{"/a/.b/c/d/", "/a", ".b", "/c/d/"},
		{"/a/.b/c/.d/", "/a", ".b", "/c/.d/"},
	}

	for _, pabc := range a {
		a, b, c := splitPath(pabc.p)
		if pabc.a != a || pabc.b != b || pabc.c != c {
			t.Errorf("Path %v, got %v, %v, %v, expected %v, %v, %v",
				pabc.p, a, b, c, pabc.a, pabc.b, pabc.c,
			)
		}
	}
}

func TestParseBearerToken(t *testing.T) {
	a := []struct{ a, b string }{
		{"", ""},
		{"foo", ""},
		{"foo bar", ""},
		{" foo bar", ""},
		{"foo bar ", ""},
		{"Bearer", ""},
		{"Bearer ", ""},
		{"Bearer foo", "foo"},
		{"bearer foo", "foo"},
		{" Bearer foo", "foo"},
		{"Bearer foo ", "foo"},
		{" Bearer foo ", "foo"},
		{"Bearer foo bar", ""},
	}

	for _, ab := range a {
		b := parseBearerToken(ab.a)
		if b != ab.b {
			t.Errorf("Bearer token %v, got %v, expected %v",
				ab.a, b, ab.b,
			)
		}
	}
}

func TestFormatICEServer(t *testing.T) {
	a := []struct {
		s webrtc.ICEServer
		v string
	}{
		{
			webrtc.ICEServer{
				URLs: []string{"stun:stun.example.org:3478"},
			}, "<stun:stun.example.org:3478>; rel=\"ice-server\"",
		},
		{
			webrtc.ICEServer{
				URLs:           []string{"turn:turn.example.org:3478"},
				Username:       "toto",
				Credential:     "titi",
				CredentialType: webrtc.ICECredentialTypePassword,
			}, "<turn:turn.example.org:3478>; rel=\"ice-server\"; " +
				"username=\"toto\"; credential=\"titi\"; " +
				"credential-type=\"password\"",
		},
		{
			webrtc.ICEServer{
				URLs:           []string{"turns:turn.example.org:5349"},
				Username:       "toto",
				Credential:     "titi",
				CredentialType: webrtc.ICECredentialTypePassword,
			}, "<turns:turn.example.org:5349>; rel=\"ice-server\"; " +
				"username=\"toto\"; credential=\"titi\"; " +
				"credential-type=\"password\"",
		},
		{
			webrtc.ICEServer{
				URLs: []string{"https://stun.example.org"},
			}, "",
		},
	}

	for _, sv := range a {
		t.Run(sv.s.URLs[0], func(t *testing.T) {
			v := formatICEServer(sv.s, sv.s.URLs[0])
			if v != sv.v {
				t.Errorf("Got %v, expected %v", v, sv.v)
			}
		})
	}
}

func TestMatchAdmin(t *testing.T) {
	d := t.TempDir()
	group.DataDirectory = d

	filename := filepath.Join(d, "config.json")
	f, err := os.Create(filename)
	if err != nil {
		t.Fatalf("Create %v: %v", filename, err)
	}
	f.Write([]byte(`{
	    "users": {
		"root": {"password": "pwd", "permissions": "admin"},
		"notroot": {"password": "pwd"}
	    }
	}`))
	f.Close()

	ok, err := adminMatch("jch", "pwd")
	if ok || err != nil {
		t.Errorf("jch: %v %v", ok, err)
	}

	ok, err = adminMatch("root", "pwd")
	if !ok || err != nil {
		t.Errorf("root: %v %v", ok, err)
	}

	ok, err = adminMatch("root", "notpwd")
	if ok || err != nil {
		t.Errorf("root: %v %v", ok, err)
	}

	ok, err = adminMatch("root", "")
	if ok || err != nil {
		t.Errorf("root: %v %v", ok, err)
	}

	ok, err = adminMatch("notroot", "pwd")
	if ok || err != nil {
		t.Errorf("notroot: %v %v", ok, err)
	}

	ok, err = adminMatch("notroot", "notpwd")
	if ok || err != nil {
		t.Errorf("notroot: %v %v", ok, err)
	}
}

func TestObfuscate(t *testing.T) {
	id := newId()
	obfuscated, err := obfuscate(id)
	if err != nil {
		t.Fatalf("obfuscate: %v", err)
	}
	id2, err := deobfuscate(obfuscated)
	if err != nil {
		t.Fatalf("deobfuscate: %v", err)
	}
	if id != id2 {
		t.Errorf("not equal: %v, %v", id, id2)
	}

	_, err = obfuscate("toto")
	if err == nil {
		t.Errorf("obfuscate: no errror")
	}
}
