package pig_herdr

import (
	"encoding/json"
	"fmt"
)

// source is the reporter identity. It must not start with "herdr:",
// which is reserved for herdr's own integrations.
const source = "pig-herdr"

// agent is the display name users see in the sidebar and agent list.
const agent = "pig"

type stateParams struct {
	PaneID         string   `json:"pane_id"`
	Source         string   `json:"source"`
	Agent          string   `json:"agent"`
	State          State    `json:"state"`
	Message        string   `json:"message,omitempty"`
	Seq            uint64   `json:"seq"`
	AgentSessionID string   `json:"agent_session_id,omitempty"`
	ResumeArgv     []string `json:"resume_argv,omitempty"`
}

type releaseParams struct {
	PaneID string `json:"pane_id"`
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Seq    uint64 `json:"seq"`
}

type frame struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

// encodeReport renders one pane.report_agent frame. Everything rides on
// the state method: herdr accepts resume_argv on either method, and the
// state report is the hold that makes resume acceptable.
func encodeReport(paneID string, state State, message, sessionID string, resume []string, seq uint64) []byte {
	f := frame{
		ID:     fmt.Sprintf("%s:%d", source, seq),
		Method: "pane.report_agent",
		Params: stateParams{
			PaneID:         paneID,
			Source:         source,
			Agent:          agent,
			State:          state,
			Message:        message,
			Seq:            seq,
			AgentSessionID: sessionID,
			ResumeArgv:     resume,
		},
	}
	return append(mustJSON(f), '\n')
}

// encodeRelease renders one pane.release_agent frame. Release clears the
// name, state, and resume command; forgetting it is survivable (herdr
// clears on idle-shell detection) but slow, so exit always releases.
func encodeRelease(paneID string, seq uint64) []byte {
	f := frame{
		ID:     fmt.Sprintf("%s:%d", source, seq),
		Method: "pane.release_agent",
		Params: releaseParams{
			PaneID: paneID,
			Source: source,
			Agent:  agent,
			Seq:    seq,
		},
	}
	return append(mustJSON(f), '\n')
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Unreachable for these structs of strings/ints/uint64s; the
		// fallback parses but matches no herdr method, so a failure
		// would degrade to a server-ignored frame rather than a
		// corrupt one.
		return []byte("{}")
	}
	return b
}
