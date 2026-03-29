package webserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/YanaDevOps/owly/diskwriter"
	"github.com/YanaDevOps/owly/group"
)

func stringPointer(v string) *string {
	return &v
}

func writeGroupDescription(t *testing.T, name string, desc *group.Description) {
	t.Helper()

	data, err := json.Marshal(desc)
	if err != nil {
		t.Fatalf("Marshal description: %v", err)
	}
	filename := filepath.Join(group.Directory, name+".json")
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		t.Fatalf("MkdirAll description dir: %v", err)
	}
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatalf("Write description: %v", err)
	}
}

func TestServeGroupRecordingsEscapesFileNamesAndSetsSecurityHeaders(t *testing.T) {
	recordingsDir := filepath.Join(t.TempDir(), "room")
	if err := os.MkdirAll(recordingsDir, 0o700); err != nil {
		t.Fatalf("MkdirAll recordings dir: %v", err)
	}

	filename := `x"><svg onload=alert(1)>.webm`
	if err := os.WriteFile(filepath.Join(recordingsDir, filename), []byte("demo"), 0o600); err != nil {
		t.Fatalf("Write recording: %v", err)
	}

	f, err := os.Open(recordingsDir)
	if err != nil {
		t.Fatalf("Open recordings dir: %v", err)
	}
	defer f.Close()

	req := httptest.NewRequest(http.MethodGet, "http://server.test/recordings/room/", nil)
	rec := httptest.NewRecorder()

	serveGroupRecordings(rec, req, f, "room")

	body := rec.Body.String()
	if strings.Contains(body, `x"><svg onload=alert(1)>.webm`) {
		t.Fatalf("recordings page rendered raw filename: %q", body)
	}
	if !strings.Contains(body, `x&#34;&gt;&lt;svg onload=alert(1)&gt;.webm`) {
		t.Fatalf("expected escaped filename in HTML, got %q", body)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got == "" {
		t.Fatalf("expected CSP header to be set")
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("unexpected referrer policy: %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("unexpected content type options: %q", got)
	}
}

func TestHandleGroupActionRejectsCrossOriginDelete(t *testing.T) {
	if err := setupTest(t.TempDir(), t.TempDir()); err != nil {
		t.Fatalf("setupTest: %v", err)
	}

	form := url.Values{
		"q":        {"delete"},
		"filename": {"demo.webm"},
	}
	req := httptest.NewRequest(
		http.MethodPost,
		"http://server.test/recordings/room/",
		strings.NewReader(form.Encode()),
	)
	req.Host = "server.test"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://evil.example")

	rec := httptest.NewRecorder()
	handleGroupAction(rec, req, "room")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected cross-origin delete to be rejected, got %d", rec.Code)
	}
}

func TestPasswordHandlerRejectsCrossOriginStateChange(t *testing.T) {
	if err := setupTest(t.TempDir(), t.TempDir()); err != nil {
		t.Fatalf("setupTest: %v", err)
	}

	writeGroupDescription(t, "room", &group.Description{
		Users: map[string]group.UserDescription{
			"alice": {
				Password:    group.Password{Type: "plain", Key: stringPointer("pw")},
				Permissions: group.Permissions{},
			},
		},
	})

	req := httptest.NewRequest(
		http.MethodPost,
		"http://server.test/owly-api/v0/.groups/room/.users/alice/.password",
		strings.NewReader("new-password"),
	)
	req.Host = "server.test"
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Origin", "https://evil.example")
	req.SetBasicAuth("root", "pw")

	rec := httptest.NewRecorder()
	passwordHandler(rec, req, "room", "alice", false)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected cross-origin password change to be rejected, got %d", rec.Code)
	}
}

func TestCheckGroupPermissionsLoadsPrivateGroupFromDisk(t *testing.T) {
	groupDir := t.TempDir()
	dataDir := t.TempDir()
	if err := setupTest(groupDir, dataDir); err != nil {
		t.Fatalf("setupTest: %v", err)
	}
	diskwriter.Directory = t.TempDir()
	group.Delete("room")
	opPermissions, err := group.NewPermissions("op")
	if err != nil {
		t.Fatalf("NewPermissions: %v", err)
	}

	writeGroupDescription(t, "room", &group.Description{
		AllowRecording: true,
		Users: map[string]group.UserDescription{
			"alice": {
				Password:    group.Password{Type: "plain", Key: stringPointer("pw")},
				Permissions: opPermissions,
			},
		},
	})

	req := httptest.NewRequest(http.MethodGet, "http://server.test/recordings/room/", nil)
	req.SetBasicAuth("alice", "pw")

	if !checkGroupPermissions(httptest.NewRecorder(), req, "room") {
		t.Fatalf("expected recordings auth to lazy-load private group from disk")
	}
	if group.Get("room") == nil {
		t.Fatalf("expected private group to be loaded into memory")
	}
}
