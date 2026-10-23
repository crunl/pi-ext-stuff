package pig_statusline

import (
	"os"
	"sort"
	"strings"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// statusline owns the single mutable bit: whether the custom footer is on.
// Snapshots are immutable values captured by each installed render closure,
// so refreshes never share mutable render state.
type statusline struct {
	mu         sync.Mutex
	enabled    bool
	unsubTheme func()
}

func (s *statusline) isEnabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enabled
}

// replaceThemeUnsub tears down the previous theme subscription, if any.
// Unsubscribe handlers never re-enter this mutex.
func (s *statusline) replaceThemeUnsub(next func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unsubTheme != nil {
		s.unsubTheme()
	}
	s.unsubTheme = next
}

func Extension() *sdk.Extension {
	e := sdk.New("pig-statusline")
	s := &statusline{enabled: true}

	// install re-renders now: the renderer only re-fires on width and
	// footer-data (branch) changes, so model/usage/tool/theme events must
	// re-install to be seen. GetBranch is a local mirror read, not IPC.
	install := func(ctx sdk.Context) error {
		if !s.isEnabled() {
			return nil
		}
		snap := gather(ctx)
		return ctx.SetFooterRenderer(func(width int) []string {
			lines := render(snap, width)
			return lines[:]
		})
	}

	refresh := func(ctx sdk.Context, _ map[string]any) (any, error) {
		return nil, install(ctx)
	}

	e.OnSessionStart(func(ctx sdk.Context, data map[string]any) (any, error) {
		// Theme switches don't touch footer data, so subscribe explicitly.
		// Re-subscribing leaks the stale-ctx callback on resume/fork, so
		// the previous subscription is torn down first.
		unsub, err := ctx.OnThemeChange(func(ctx sdk.Context, _ sdk.UITheme) {
			// Best-effort: the handler signature has no error channel,
			// and refresh already repaints on the next event either way.
			_ = install(ctx)
		})
		if err != nil {
			return nil, err
		}
		s.replaceThemeUnsub(unsub)
		return refresh(ctx, data)
	})
	e.OnToolResult(refresh)
	e.OnEvent(sdk.EventModelSelect, refresh)
	e.OnEvent(sdk.EventThinkingLevelSelect, refresh)
	e.OnEvent(sdk.EventSessionCompact, refresh)

	e.Command("pig-statusline", "Toggle the custom statusline footer.", func(ctx sdk.Context, args string) error {
		s.mu.Lock()
		s.enabled = !s.enabled
		on := s.enabled
		s.mu.Unlock()
		if !on {
			// nil render restores the built-in footer.
			return ctx.SetFooterRenderer(nil)
		}
		install(ctx)
		return nil
	})

	return e
}

// gather is the only impure seam: every host call lives here, and a failed
// gather keeps the previous rows instead of painting partial state.
func gather(ctx sdk.Context) snapshot {
	var s snapshot
	s.light = ctx.UITheme().Appearance() == "light"
	if cwd := ctx.Cwd(); cwd != "" {
		s.folder = leaf(cwd)
	}
	if branch, ok := ctx.FooterData().GitBranch(); ok {
		s.branch = branch
	}
	for _, st := range sortedStatuses(ctx.FooterData().ExtensionStatuses()) {
		s.statuses = append(s.statuses, st)
	}
	if entries, err := ctx.GetBranch(); err == nil {
		samples := make([]usageSample, 0, len(entries))
		for _, e := range entries {
			sample := usageSample{kind: e.Type, role: e.Role}
			if e.Usage != nil {
				sample.hasUsage = true
				sample.input = e.Usage.Input
				sample.output = e.Usage.Output
				sample.cacheRead = e.Usage.CacheRead
				sample.cacheWrite = e.Usage.CacheWrite
			}
			samples = append(samples, sample)
		}
		t := foldTotals(samples)
		s.cacheRead, s.cacheWrite = t.cacheRead, t.cacheWrite
		s.hitRate = t.hitRate
	}
	if mi, err := ctx.GetModelInfo(); err == nil && mi != nil {
		s.model = mi.Name
		if s.model == "" {
			s.model = mi.ID
		}
	}
	if thinking, err := ctx.GetThinkingLevel(); err == nil {
		s.effort = thinking
	}
	if cu, err := ctx.GetContextUsage(); err == nil && cu != nil {
		s.ctxPct = cu.Percent
		s.ctxTokens = cu.Tokens
		s.ctxWindow = cu.ContextWindow
	}
	return s
}

// leaf mirrors Pi's formatCwd: the home directory stays "~", anything
// else shows only the last segment. A trailing separator is trimmed first
// so "/a/b/" yields "b", not the full path.
func leaf(path string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if path == home {
			return "~"
		}
	}
	path = strings.TrimRight(path, "/\\")
	if i := strings.LastIndexAny(path, "/\\"); i >= 0 {
		if rest := path[i+1:]; rest != "" {
			return rest
		}
	}
	return path
}

// sortedStatuses mirrors Pi's line 2: hidden-extension filtering aside,
// statuses sort by key and fold whitespace so one bad actor can't split
// the single footer line.
func sortedStatuses(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		text := strings.Join(strings.Fields(m[k]), " ")
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}
