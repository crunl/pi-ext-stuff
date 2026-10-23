package pig_statusline

import (
	"math"
	"strings"
	"testing"
)

func fptr(f float64) *float64 { return &f }
func iptr(i int) *int         { return &i }

func nan() float64 { return math.NaN() }
func inf(sign int) float64 {
	if sign < 0 {
		return math.Inf(-1)
	}
	return math.Inf(1)
}

func TestFoldTotalsSumsAllRoles(t *testing.T) {
	samples := []usageSample{
		{kind: "message", role: "assistant", hasUsage: true, input: 100, output: 50, cacheRead: 900, cacheWrite: 10},
		{kind: "message", role: "toolResult", hasUsage: true, input: 20, output: 5},
		{kind: "compaction", hasUsage: true, input: 1000, output: 200, cacheRead: 3000},
		{kind: "branch_summary", hasUsage: true, input: 10},
		{kind: "message", role: "assistant"},                         // no usage: sums nothing, blanks nothing
		{kind: "message", role: "user", hasUsage: true, input: 9999}, // ignored role
	}
	got := foldTotals(samples)
	if got.input != 1130 || got.output != 255 || got.cacheRead != 3900 || got.cacheWrite != 10 {
		t.Fatalf("sums = %+v", got)
	}
	if got.hitRate == nil {
		t.Fatal("hitRate should track the first computable assistant message")
	}
	want := 900.0 / 1010.0 * 100
	if *got.hitRate < want-0.01 || *got.hitRate > want+0.01 {
		t.Fatalf("hitRate = %.2f, want %.2f", *got.hitRate, want)
	}
}

func TestFoldTotalsInterruptKeepsHitRate(t *testing.T) {
	got := foldTotals([]usageSample{
		{kind: "message", role: "assistant", hasUsage: true, input: 100, cacheRead: 900},
		{kind: "message", role: "assistant"}, // interrupt: no usage
	})
	if got.hitRate == nil || *got.hitRate < 89.9 || *got.hitRate > 90.1 {
		t.Fatalf("interrupt blanked hitRate: %+v", got.hitRate)
	}
}

func TestFormatTokens(t *testing.T) {
	cases := map[int]string{0: "0", 999: "999", 1000: "1.0k", 12300: "12.3k", 100000: "100k", 1500000: "1.5M", 3400000: "3.4M"}
	for n, want := range cases {
		if got := formatTokens(n); got != want {
			t.Errorf("formatTokens(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestMeterCells(t *testing.T) {
	if got := meterCells(47.8, 10); got != 5 {
		t.Errorf("meterCells(47.8, 10) = %d, want 5", got)
	}
	if got := meterCells(100, 10); got != 10 {
		t.Errorf("meterCells(100, 10) = %d, want 10", got)
	}
	if got := meterCells(0, 10); got != 0 {
		t.Errorf("meterCells(0, 10) = %d, want 0", got)
	}
	if got := meterCells(150, 5); got != 5 {
		t.Errorf("clamp failed: %d", got)
	}
	// Non-finite input must not escape as a negative Repeat count.
	for _, bad := range []float64{nan(), inf(1), inf(-1)} {
		if got := meterCells(bad, 10); got != 0 && !(bad > 100 && got == 10) {
			t.Errorf("meterCells(%v, 10) = %d", bad, got)
		}
	}
	if lines := render(fullSnapshot(), 0); lines != [2]string{"", ""} {
		t.Errorf("zero width should render empty: %q", lines)
	}
	if lines := render(fullSnapshot(), -5); lines != [2]string{"", ""} {
		t.Errorf("negative width should render empty: %q", lines)
	}
}

func TestStripSGR(t *testing.T) {
	painted := fg(hexRGB("#ca9ee6"), "model") + " plain"
	if got := stripSGR(painted); got != "model plain" {
		t.Errorf("stripSGR = %q", got)
	}
	if got := visLen(painted); got != len([]rune("model plain")) {
		t.Errorf("visLen = %d", got)
	}
}

func fullSnapshot() snapshot {
	return snapshot{
		model: "muse-spark", effort: "xhigh", folder: "pi-ext-stuff", branch: "main",
		cacheRead: 3400000, hitRate: fptr(98.8),
		ctxPct: fptr(47.8), ctxTokens: iptr(1000), ctxWindow: 192000,
		statuses: []string{"ext-a ok", "ext-b ok"},
	}
}

func plain(lines [2]string) [2]string {
	return [2]string{stripSGR(lines[0]), stripSGR(lines[1])}
}

func TestRenderPowerline(t *testing.T) {
	lines := render(fullSnapshot(), 160)
	p := plain(lines)
	// pill order: model effort folder branch
	for _, want := range []string{"muse-spark", "xhigh", "pi-ext-stuff", "main"} {
		if !strings.Contains(p[0], want) {
			t.Errorf("line1 = %q, missing %q", p[0], want)
		}
	}
	idx := func(s, sub string) int { return strings.Index(s, sub) }
	if !(idx(p[0], "muse-spark") < idx(p[0], "xhigh") && idx(p[0], "xhigh") < idx(p[0], "pi-ext-stuff") && idx(p[0], "pi-ext-stuff") < idx(p[0], "main")) {
		t.Errorf("pill order broken: %q", p[0])
	}
	// right side: CH, meter bar, tokens/window
	for _, want := range []string{"CH98.8%", "1.0k/192k", iconGauge, iconCache} {
		if !strings.Contains(p[0], want) {
			t.Errorf("line1 = %q, missing %q", p[0], want)
		}
	}
	if !strings.Contains(lines[0], "\x1b[38;2;") {
		t.Error("pill should paint truecolor SGR")
	}
	// powerline caps present
	if !strings.Contains(lines[0], plLeft) || !strings.Contains(lines[0], plRight) || !strings.Contains(lines[0], plSep) {
		t.Error("powerline caps/separator missing")
	}
	// line 2: statuses
	if !strings.Contains(p[1], "ext-a ok") || !strings.Contains(p[1], "ext-b ok") {
		t.Errorf("line2 = %q", p[1])
	}
	// every painted line fits the width as the host measures it
	if visLen(lines[0]) > 160 || visLen(lines[1]) > 160 {
		t.Errorf("overflow: %d / %d", visLen(lines[0]), visLen(lines[1]))
	}
}

func barCells(line string) int {
	n := 0
	for _, r := range line {
		if r == '█' || r == '░' {
			n++
		}
	}
	return n
}

func TestRenderDegradeLadder(t *testing.T) {
	full := plain(render(fullSnapshot(), 200))
	has := func(line, sub string) bool { return strings.Contains(line, sub) }
	seenNoLine2, seenASCII, seenCompactMeter, seenNoTokens, seenNoUsage, seenMinPill := false, false, false, false, false, false
	for w := 199; w > 10; w-- {
		lines := render(fullSnapshot(), w)
		p := plain(lines)
		if full[1] != "" && p[1] == "" {
			seenNoLine2 = true
		}
		if !hasNerdFont(lines[0]) && has(p[0], "muse-spark") && has(p[0], "main") {
			seenASCII = true // same content, no private-use glyphs
		}
		if n := barCells(p[0]); n > 0 && n <= 5 {
			seenCompactMeter = true // 10-cell bar shrank, not vanished
		}
		if !has(p[0], "/") && has(full[0], "/") {
			seenNoTokens = true
		}
		if barCells(p[0]) == 0 && has(p[0], "muse-spark") {
			seenNoUsage = true
		}
		if has(p[0], "muse-spark") && !has(p[0], "pi-ext-stuff") && !has(p[0], "main") {
			seenMinPill = true
		}
		// order invariant: tokens imply a bar; model survives till truncate
		if has(p[0], "/") && barCells(p[0]) == 0 && has(p[0], iconGauge) {
			t.Fatalf("w=%d: tokens without bar: %q", w, p[0])
		}
		if !has(p[0], "muse-spark") && w > 20 {
			t.Fatalf("w=%d: model dropped too early: %q", w, p[0])
		}
	}
	for name, seen := range map[string]bool{"line2": seenNoLine2, "ascii": seenASCII, "compact-meter": seenCompactMeter, "no-tokens": seenNoTokens, "no-usage": seenNoUsage, "min-pill": seenMinPill} {
		if !seen {
			t.Errorf("degrade stage never observed: %s", name)
		}
	}
	_ = full
}

func TestRenderNils(t *testing.T) {
	snap := fullSnapshot()
	snap.hitRate, snap.ctxPct, snap.ctxTokens = nil, nil, nil
	snap.branch, snap.effort = "", ""
	snap.statuses = nil
	p := plain(render(snap, 160))
	if strings.Contains(p[0], "CH") {
		t.Errorf("no hit rate should mean no CH block: %q", p[0])
	}
	if !strings.Contains(p[0], "?/") {
		t.Errorf("nil usage should render ?/window: %q", p[0])
	}
	if strings.Contains(p[0], "main") {
		t.Errorf("empty branch should hide the segment: %q", p[0])
	}
}
