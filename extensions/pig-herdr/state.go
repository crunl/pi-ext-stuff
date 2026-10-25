package pig_herdr

import (
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// State is the herdr lifecycle vocabulary. Blocked is carried so the wire
// format is forward-compatible, but v1 has no producer for it: the pig SDK
// exposes no approval/permission-request event, and a guessed blocked is
// worse than an honest working (cry-wolf on the one state where the human
// is the actuator).
type State string

const (
	StateIdle    State = "idle"
	StateWorking State = "working"
	StateBlocked State = "blocked"
)

// eventToState maps pig SDK event names onto herdr states. The second
// return reports whether the event carries any lifecycle meaning at all.
// Transitions into working are event-driven and immediate; transitions
// into idle are event-driven too (turn_end/agent_settled), never inferred
// from silence, so no quiet-period timer exists in v1.
func eventToState(event string) (State, bool) {
	switch event {
	case sdk.EventTurnStart, sdk.EventAgentStart, sdk.EventToolCall:
		return StateWorking, true
	case sdk.EventTurnEnd, sdk.EventAgentSettled:
		return StateIdle, true
	default:
		return "", false
	}
}
