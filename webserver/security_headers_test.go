package webserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/YanaDevOps/owly/group"
)

func TestCSPHeader(t *testing.T) {
	recorder := httptest.NewRecorder()

	cspHeader(recorder, "https://media.example.test")

	if got := recorder.Header().Get("Content-Security-Policy"); got == "" {
		t.Fatalf("expected Content-Security-Policy header to be set")
	}
	if got := recorder.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("unexpected Referrer-Policy: %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("unexpected X-Content-Type-Options: %q", got)
	}
}

func TestCheckOriginAllowsConfiguredOrigin(t *testing.T) {
	dir := t.TempDir()
	group.DataDirectory = dir
	err := os.WriteFile(
		filepath.Join(dir, "config.json"),
		[]byte(`{"allowOrigin":["https://allowed.example"]}`),
		0o600,
	)
	if err != nil {
		t.Fatalf("Write config: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://server.test/group/smoke/", nil)
	req.Host = "server.test"
	req.Header.Set("Origin", "https://allowed.example")
	recorder := httptest.NewRecorder()

	if !CheckOrigin(recorder, req, false) {
		t.Fatalf("expected allowed origin to pass")
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://allowed.example" {
		t.Fatalf("unexpected Access-Control-Allow-Origin: %q", got)
	}
}

func TestCheckOriginRejectsUnexpectedOrigin(t *testing.T) {
	dir := t.TempDir()
	group.DataDirectory = dir
	err := os.WriteFile(
		filepath.Join(dir, "config.json"),
		[]byte(`{"allowOrigin":["https://allowed.example"]}`),
		0o600,
	)
	if err != nil {
		t.Fatalf("Write config: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://server.test/group/smoke/", nil)
	req.Host = "server.test"
	req.Header.Set("Origin", "https://blocked.example")

	if CheckOrigin(nil, req, false) {
		t.Fatalf("expected blocked origin to be rejected")
	}
}
