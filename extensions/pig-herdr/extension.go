package pig_herdr

import (
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Extension reports pig session lifecycle to herdr: sidebar presence,
// idle/working state, and the restart-resume command. Outside herdr
// (HERDR_ENV unset, or socket/pane id missing) the extension loads but
// stays inert: no subscriptions, no sockets, no failures to swallow.
func Extension() *sdk.Extension {
	e := sdk.New("pig-herdr")
	r, ok := newReporterFromEnv()
	if !ok {
		return e
	}

	sessionID := func(ctx sdk.Context) string {
		id, err := ctx.GetSessionID()
		if err != nil {
			return ""
		}
		return id
	}
	// tui reports only the interactive session. Headless runs (rpc/json/
	// print) have no herdr-visible pane lifecycle, mirroring the pi
	// integration's ctx.mode gate; each handler checks its own ctx, so
	// no shared flag can race across event goroutines.
	tui := func(ctx sdk.Context) bool { return ctx.Mode() == "tui" }
	// onEvent routes every lifecycle event through the single pure
	// mapping in state.go, so the table test there covers the wiring.
	onEvent := func(event string) sdk.EventFunc {
		return func(ctx sdk.Context, _ map[string]any) (any, error) {
			if !tui(ctx) {
				return nil, nil
			}
			if state, ok := eventToState(event); ok {
				r.publishState(state, sessionID(ctx))
			}
			return nil, nil
		}
	}

	e.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		if !tui(ctx) {
			return nil, nil
		}
		// A reload can replace this extension mid-turn: report working
		// when the agent is already busy instead of a false idle.
		// Transport failure reports idle, mirroring pi's strict check.
		if idle, err := ctx.IsIdle(); err != nil || idle {
			r.publishState(StateIdle, sessionID(ctx))
			return nil, nil
		}
		r.publishState(StateWorking, sessionID(ctx))
		return nil, nil
	})
	e.OnEvent(sdk.EventTurnStart, onEvent(sdk.EventTurnStart))
	e.OnEvent(sdk.EventAgentStart, onEvent(sdk.EventAgentStart))
	e.OnEvent(sdk.EventToolCall, onEvent(sdk.EventToolCall))
	e.OnEvent(sdk.EventTurnEnd, onEvent(sdk.EventTurnEnd))
	e.OnEvent(sdk.EventAgentSettled, onEvent(sdk.EventAgentSettled))
	// Synchronous: the host may terminate this process once the
	// shutdown handler returns, so the release must be on the wire
	// before we return.
	e.OnSessionShutdown(func(_ sdk.Context, _ map[string]any) (any, error) {
		r.releaseSync()
		return nil, nil
	})

	e.Command("pig-herdr", "Toggle herdr presence reporting.", func(ctx sdk.Context, _ string) error {
		if r.isEnabled() {
			r.disable()
			return nil
		}
		// Resolve the session before flipping the flag: a host failure
		// here must leave the reporter off, not half-applied.
		sid := sessionID(ctx)
		r.enable()
		r.publishState(StateIdle, sid)
		return nil
	})

	return e
}
