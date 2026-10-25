package pig_herdr

import (
	"testing"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestEventToState(t *testing.T) {
	cases := []struct {
		event string
		want  State
		ok    bool
	}{
		{sdk.EventTurnStart, StateWorking, true},
		{sdk.EventAgentStart, StateWorking, true},
		{sdk.EventToolCall, StateWorking, true},
		{sdk.EventTurnEnd, StateIdle, true},
		{sdk.EventAgentSettled, StateIdle, true},
		{sdk.EventToolResult, "", false},
		{sdk.EventModelSelect, "", false},
		{sdk.EventSessionCompact, "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := eventToState(c.event)
		if got != c.want || ok != c.ok {
			t.Errorf("eventToState(%q) = (%q, %v), want (%q, %v)",
				c.event, got, ok, c.want, c.ok)
		}
	}
}
