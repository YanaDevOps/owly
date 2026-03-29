package group

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/YanaDevOps/owly/conn"
)

type testClient struct {
	group       *Group
	id          string
	username    string
	resumeToken string
	permissions []string
	data        map[string]interface{}
	closed      bool
	pushKinds   []string
	joinedKinds []string
}

func (c *testClient) Group() *Group                     { return c.group }
func (c *testClient) Addr() net.Addr                    { return nil }
func (c *testClient) Id() string                        { return c.id }
func (c *testClient) Username() string                  { return c.username }
func (c *testClient) SetUsername(username string)       { c.username = username }
func (c *testClient) ResumeToken() string               { return c.resumeToken }
func (c *testClient) SetResumeToken(resumeToken string) { c.resumeToken = resumeToken }
func (c *testClient) Permissions() []string             { return c.permissions }
func (c *testClient) SetPermissions(perms []string)     { c.permissions = perms }
func (c *testClient) Data() map[string]interface{} {
	if c.data == nil {
		c.data = map[string]interface{}{}
	}
	return c.data
}
func (c *testClient) Close() error {
	c.closed = true
	return nil
}
func (c *testClient) PushConn(_ *Group, _ string, _ conn.Up, _ []conn.UpTrack, _ string) error {
	return nil
}
func (c *testClient) RequestConns(_ Client, _ *Group, _ string) error { return nil }
func (c *testClient) Joined(_ string, kind string) error {
	c.joinedKinds = append(c.joinedKinds, kind)
	return nil
}
func (c *testClient) PushClient(_ string, kind, _ string, _ string, _ []string, _ map[string]interface{}) error {
	c.pushKinds = append(c.pushKinds, kind)
	return nil
}
func (c *testClient) Kick(_ string, _ *string, _ string) error { return nil }

func setupReplacementGroup(t *testing.T, desc *Description) {
	t.Helper()

	groups.groups = nil
	if err := setupTest(t.TempDir(), t.TempDir(), false); err != nil {
		t.Fatalf("setupTest: %v", err)
	}

	filename := filepath.Join(Directory, "room.json")
	data, err := json.Marshal(desc)
	if err != nil {
		t.Fatalf("Marshal description: %v", err)
	}
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatalf("Write group description: %v", err)
	}
}

func TestAddClientRequiresResumeTokenToReplaceExistingSession(t *testing.T) {
	desc := &Description{
		Users: map[string]UserDescription{
			"alice": {
				Password:    Password{Type: "plain", Key: stringPointer("pw")},
				Permissions: Permissions{name: "present"},
			},
		},
	}
	setupReplacementGroup(t, desc)

	first := &testClient{id: "same-client"}
	g, err := AddClient("room", first, ClientCredentials{
		Username: stringPointer("alice"),
		Password: "pw",
	})
	if err != nil {
		t.Fatalf("first AddClient: %v", err)
	}
	first.group = g
	if first.ResumeToken() == "" {
		t.Fatalf("expected first client to receive resume token")
	}

	second := &testClient{id: "same-client"}
	_, err = AddClient("room", second, ClientCredentials{
		Username: stringPointer("alice"),
		Password: "pw",
	})
	if err == nil {
		t.Fatalf("expected duplicate client id without resume token to be rejected")
	}
}

func TestAddClientReplacesExistingSessionWithValidResumeToken(t *testing.T) {
	desc := &Description{
		Users: map[string]UserDescription{
			"alice": {
				Password:    Password{Type: "plain", Key: stringPointer("pw")},
				Permissions: Permissions{name: "present"},
			},
		},
	}
	setupReplacementGroup(t, desc)

	first := &testClient{id: "same-client"}
	g, err := AddClient("room", first, ClientCredentials{
		Username: stringPointer("alice"),
		Password: "pw",
	})
	if err != nil {
		t.Fatalf("first AddClient: %v", err)
	}
	first.group = g

	second := &testClient{id: "same-client"}
	g, err = AddClient("room", second, ClientCredentials{
		Username:    stringPointer("alice"),
		Password:    "pw",
		ResumeToken: first.ResumeToken(),
	})
	if err != nil {
		t.Fatalf("second AddClient: %v", err)
	}
	second.group = g

	if !first.closed {
		t.Fatalf("expected first client to be closed after replacement")
	}
	if got := g.clients["same-client"]; got != second {
		t.Fatalf("expected replacement client to remain in group, got %#v", got)
	}
	if second.ResumeToken() != first.ResumeToken() {
		t.Fatalf("expected replacement client to inherit resume token")
	}
	if len(second.joinedKinds) == 0 || second.joinedKinds[0] != "join" {
		t.Fatalf("expected replacement client to receive join bootstrap, got %v", second.joinedKinds)
	}
}

func TestAddClientRejectsDuplicateIdWithDifferentIdentity(t *testing.T) {
	desc := &Description{
		Users: map[string]UserDescription{
			"alice": {
				Password:    Password{Type: "plain", Key: stringPointer("alice-pw")},
				Permissions: Permissions{name: "present"},
			},
			"bob": {
				Password:    Password{Type: "plain", Key: stringPointer("bob-pw")},
				Permissions: Permissions{name: "present"},
			},
		},
	}
	setupReplacementGroup(t, desc)

	first := &testClient{id: "same-client"}
	if _, err := AddClient("room", first, ClientCredentials{
		Username: stringPointer("alice"),
		Password: "alice-pw",
	}); err != nil {
		t.Fatalf("first AddClient: %v", err)
	}

	second := &testClient{id: "same-client"}
	_, err := AddClient("room", second, ClientCredentials{
		Username:    stringPointer("bob"),
		Password:    "bob-pw",
		ResumeToken: first.ResumeToken(),
	})
	if err == nil {
		t.Fatalf("expected duplicate client id to be rejected for different username")
	}
}

func TestAddClientRejectsDuplicateIdWithWrongResumeToken(t *testing.T) {
	desc := &Description{
		Users: map[string]UserDescription{
			"alice": {
				Password:    Password{Type: "plain", Key: stringPointer("pw")},
				Permissions: Permissions{name: "present"},
			},
		},
	}
	setupReplacementGroup(t, desc)

	first := &testClient{id: "same-client"}
	if _, err := AddClient("room", first, ClientCredentials{
		Username: stringPointer("alice"),
		Password: "pw",
	}); err != nil {
		t.Fatalf("first AddClient: %v", err)
	}

	second := &testClient{id: "same-client"}
	_, err := AddClient("room", second, ClientCredentials{
		Username:    stringPointer("alice"),
		Password:    "pw",
		ResumeToken: "wrong-token",
	})
	if err == nil {
		t.Fatalf("expected duplicate client id with wrong resume token to be rejected")
	}
}

func stringPointer(v string) *string {
	return &v
}
