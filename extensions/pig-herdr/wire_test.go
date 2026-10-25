package pig_herdr

import (
	"encoding/json"
	"strings"
	"testing"
)

func decode(t *testing.T, b []byte) (string, map[string]any) {
	t.Helper()
	if len(b) == 0 || b[len(b)-1] != '\n' {
		t.Fatalf("frame must be newline-terminated, got %q", b)
	}
	var f struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(b[:len(b)-1], &f); err != nil {
		t.Fatalf("frame is not valid JSON: %v", err)
	}
	return f.Method, f.Params
}

func TestEncodeReportGolden(t *testing.T) {
	b := encodeReport("w1:p1", StateWorking, "", "sess_9", []string{"pig", "--session", "sess_9"}, 1710000000000001)
	method, p := decode(t, b)
	if method != "pane.report_agent" {
		t.Fatalf("method = %q", method)
	}
	want := map[string]any{
		"pane_id":          "w1:p1",
		"source":           "pig-herdr",
		"agent":            "pig",
		"state":            "working",
		"seq":              float64(1710000000000001),
		"agent_session_id": "sess_9",
		"resume_argv":      []any{"pig", "--session", "sess_9"},
	}
	for k, v := range want {
		got, found := p[k]
		if !found {
			t.Errorf("missing param %q", k)
			continue
		}
		if !jsonEqual(got, v) {
			t.Errorf("param %q = %v, want %v", k, got, v)
		}
	}
	if _, found := p["message"]; found {
		t.Errorf("empty message must be omitted, params = %v", p)
	}
}

func TestEncodeReportNoResume(t *testing.T) {
	b := encodeReport("w1:p1", StateIdle, "", "", nil, 42)
	_, p := decode(t, b)
	if _, found := p["agent_session_id"]; found {
		t.Errorf("empty session id must be omitted, params = %v", p)
	}
	if _, found := p["resume_argv"]; found {
		t.Errorf("nil resume must be omitted, params = %v", p)
	}
	if p["state"] != "idle" {
		t.Errorf("state = %v", p["state"])
	}
}

func TestEncodeRelease(t *testing.T) {
	b := encodeRelease("w1:p1", 7)
	method, p := decode(t, b)
	if method != "pane.release_agent" {
		t.Fatalf("method = %q", method)
	}
	if p["pane_id"] != "w1:p1" || p["source"] != "pig-herdr" || p["agent"] != "pig" {
		t.Errorf("identity params = %v", p)
	}
	for _, k := range []string{"state", "message", "agent_session_id", "resume_argv"} {
		if _, found := p[k]; found {
			t.Errorf("release must not carry %q", k)
		}
	}
}

func TestFrameFieldOrder(t *testing.T) {
	b := string(encodeReport("w1:p1", StateIdle, "", "", nil, 1))
	for _, k := range []string{`"pane_id"`, `"source"`, `"agent"`, `"state"`, `"seq"`} {
		if !strings.Contains(b, k) {
			t.Errorf("frame missing %s: %s", k, b)
		}
	}
	id := strings.Index(b, `"id"`)
	method := strings.Index(b, `"method"`)
	params := strings.Index(b, `"params"`)
	if !(id < method && method < params) {
		t.Errorf("envelope order id<method<params violated: %s", b)
	}
}

func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}
