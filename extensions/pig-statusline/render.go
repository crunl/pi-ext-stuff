package pig_statusline

import (
	"fmt"
	"strings"
)

// usageSample is the seam between the SDK's BranchEntry and the pure
// fold: render.go never imports the SDK, so every rule here is testable
// without a host. extension.go maps entries onto samples at the seam.
type usageSample struct {
	kind                  string // message | branch_summary | compaction | ...
	role                  string // assistant | toolResult | ...
	hasUsage              bool
	input, output         int
	cacheRead, cacheWrite int
}

type totals struct {
	input, output, cacheRead, cacheWrite int
	hitRate                              *float64 // latest computable assistant-message cache hit rate
}

// foldTotals mirrors Pi's computeUsageTotals: it sums assistant messages,
// toolResult messages and branch_summary/compaction entries. hitRate tracks
// only the latest computable assistant message; an assistant message
// without usage (interrupt, error) must not blank the last known rate.
func foldTotals(samples []usageSample) totals {
	var t totals
	for _, s := range samples {
		switch {
		case s.kind == "message" && s.role == "assistant" && s.hasUsage:
			t.input += s.input
			t.output += s.output
			t.cacheRead += s.cacheRead
			t.cacheWrite += s.cacheWrite
			if prompt := s.input + s.cacheRead + s.cacheWrite; prompt > 0 {
				rate := float64(s.cacheRead) / float64(prompt) * 100
				t.hitRate = &rate
			}
		case s.kind == "message" && s.role == "toolResult" && s.hasUsage,
			(s.kind == "branch_summary" || s.kind == "compaction") && s.hasUsage:
			t.input += s.input
			t.output += s.output
			t.cacheRead += s.cacheRead
			t.cacheWrite += s.cacheWrite
		}
	}
	return t
}

// snapshot is one atomic footer state: gathered impurely in extension.go,
// rendered purely here.
type snapshot struct {
	light      bool // host theme appearance
	model      string
	effort     string // thinking level, "" hides the segment
	folder     string // leaf only, like Pi
	branch     string // "" hides the segment
	cacheRead  int
	cacheWrite int
	hitRate    *float64
	ctxPct     *float64 // nil hides the usage block
	ctxTokens  *int     // nil renders "?"
	ctxWindow  int
	statuses   []string // other extensions' status lines, sorted
}

// Nerd Font icons, same codepoints as Pi's statusline.
const (
	iconModel  = "󰍛"
	iconEffort = "󰧑"
	iconFolder = "󰉋"
	iconBranch = "󰁁"
	iconGauge  = ""
	iconCache  = ""
)

// Powerline caps and separator.
const (
	plLeft  = ""
	plRight = ""
	plSep   = ""
)

type rgb struct{ r, g, b int }

// hexRGB parses six-digit hex. Literals only: all callers pass constants,
// so the Sscanf error is unreachable by construction.
func hexRGB(h string) rgb {
	var n int
	fmt.Sscanf(h, "#%06x", &n)
	return rgb{(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff}
}

func fg(c rgb, text string) string {
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s", c.r, c.g, c.b, text)
}

func bg(c rgb, text string) string {
	return fmt.Sprintf("\x1b[48;2;%d;%d;%dm%s", c.r, c.g, c.b, text)
}

// contrastText mirrors Pi's contrastTextFor: YIQ luma picks pill text.
func contrastText(c rgb) string {
	luma := (299*c.r + 587*c.g + 114*c.b) / 1000
	if luma >= 128 {
		return "\x1b[30m"
	}
	return "\x1b[97m"
}

func sgrReset() string { return "\x1b[39m\x1b[49m" }

// stripSGR removes ANSI SGR sequences so width math sees visible cells.
// Known limit: only CSI-[...m is stripped (no OSC-8 hyperlinks), and
// ambiguous-width runes (█ ░) count 1 — terminals with ambiguous-width=double
// will under-measure the bar. Accepted: the ladder keeps ≥1 cell of slack.
func stripSGR(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && ((s[j] < 'A' || s[j] > 'Z') && (s[j] < 'a' || s[j] > 'z')) {
				j++
			}
			if j < len(s) {
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func visLen(s string) int { return len([]rune(stripSGR(s))) }

// Catppuccin palettes ported from Pi's statusline: hue = identity,
// lightness = adaptation. Dark = Frappe, Light = Latte pressed darker.
var (
	modelDark   = hexRGB("#ca9ee6")
	folderDark  = hexRGB("#99d1db")
	gitDark     = hexRGB("#e5c890")
	modelLight  = hexRGB("#8839ef")
	folderLight = hexRGB("#00787f")
	gitLight    = hexRGB("#a25c00")
)

var effortDark = map[string]rgb{
	"minimal": hexRGB("#a6d189"),
	"low":     hexRGB("#8caaee"),
	"medium":  hexRGB("#f2d5cf"),
	"high":    hexRGB("#eebebe"),
	"xhigh":   hexRGB("#ef9f76"),
	"max":     hexRGB("#f4b8e4"),
}

var effortLight = map[string]rgb{
	"minimal": hexRGB("#148002"),
	"low":     hexRGB("#0761ef"),
	"medium":  hexRGB("#4564d5"),
	"high":    hexRGB("#ae4f51"),
	"xhigh":   hexRGB("#ca3700"),
	"max":     hexRGB("#b03f95"),
}

func effortRGB(level string, light bool) rgb {
	m := effortDark
	if light {
		m = effortLight
	}
	if c, ok := m[level]; ok {
		return c
	}
	return m["medium"]
}

var (
	meterOK   = hexRGB("#a6d189")
	meterWarn = hexRGB("#e5c890")
	meterBad  = hexRGB("#e78284")
	meterDim  = hexRGB("#6c6f85")
)

// meterCells mirrors Pi's format: ceil(clamped/100*cells).
// The !(percent > 0) form also catches NaN (all NaN comparisons are false),
// which the host can produce as tokens/window with window 0. Without it,
// int(NaN) is implementation-defined and strings.Repeat panics below.
func meterCells(percent float64, cells int) int {
	if !(percent > 0) {
		percent = 0
	} else if percent > 100 {
		percent = 100
	}
	frac := percent / 100 * float64(cells)
	n := int(frac)
	if float64(n) < frac {
		n++
	}
	return n
}

func meterColor(percent float64) rgb {
	if percent >= 75 {
		return meterBad
	}
	if percent >= 50 {
		return meterWarn
	}
	return meterOK
}

type plSeg struct {
	icon string
	text string
	rgb  rgb
}

func capGlyph(g string, c rgb) string { return fg(c, g) + "\x1b[39m" }

func segBody(icon, text string, c rgb) string {
	return bg(c, contrastText(c)+icon+" "+text+" ") + sgrReset()
}

// sep draws the arrowhead in the left segment's color over the right
// segment's background.
func sep(left, right rgb) string {
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm%s%s",
		left.r, left.g, left.b, right.r, right.g, right.b, plSep, sgrReset())
}

// powerlineChain mirrors Pi's powerlineChain: caps + bodies + separators.
func powerlineChain(segs []plSeg) string {
	if len(segs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(capGlyph(plLeft, segs[0].rgb))
	b.WriteString(segBody(segs[0].icon, segs[0].text, segs[0].rgb))
	for i := 1; i < len(segs); i++ {
		b.WriteString(sep(segs[i-1].rgb, segs[i].rgb))
		b.WriteString(segBody(segs[i].icon, segs[i].text, segs[i].rgb))
	}
	b.WriteString(capGlyph(plRight, segs[len(segs)-1].rgb))
	return b.String()
}

// asciiChain is the narrow-width twin of powerlineChain: same segments,
// same colors (zero-width), but no Nerd Font glyphs — plain text joined
// with │. Content is fully preserved; only style degrades.
func asciiChain(segs []plSeg) string {
	texts := make([]string, 0, len(segs))
	for _, s := range segs {
		texts = append(texts, fg(s.rgb, s.text))
	}
	return strings.Join(texts, fg(meterDim, " │ "))
}

// hasNerdFont reports whether s uses private-use glyphs (powerline caps,
// separators, or statusline icons).
func hasNerdFont(s string) bool {
	for _, r := range s {
		if (r >= 0xE000 && r <= 0xF8FF) || (r >= 0xF0000 && r <= 0xFFFFF) {
			return true
		}
	}
	return false
}

// formatTokens mirrors Pi's formatTokens.
func formatTokens(n int) string {
	if n <= 0 {
		return "0"
	}
	if n < 1000 {
		return fmt.Sprintf("%d", n)
	}
	if n < 1000000 {
		k := float64(n) / 1000
		if k >= 100 {
			return fmt.Sprintf("%dk", int(k+0.5))
		}
		return fmt.Sprintf("%.1fk", k)
	}
	m := float64(n) / 1000000
	if m >= 100 {
		return fmt.Sprintf("%dM", int(m+0.5))
	}
	return fmt.Sprintf("%.1fM", m)
}

// rightBlock renders the cache + usage tail. cells<=0 drops the meter bar,
// showTokens=false drops the tokens. A nil ctxPct drops only the bar:
// Pi still shows gauge + ?/window when the percent is unknown. The whole
// usage block hides only when stepping the degrade ladder past it.
// Order: cache, gauge, bar, tokens — Pi's order.
func rightBlock(snap snapshot, cells int, showTokens bool, accent rgb, plain bool) string {
	var parts []string
	cacheIcon, gaugeIcon := iconCache+" ", iconGauge+" "
	if plain {
		cacheIcon, gaugeIcon = "", ""
	}
	if (snap.cacheRead > 0 || snap.cacheWrite > 0) && snap.hitRate != nil {
		parts = append(parts, fg(meterDim, cacheIcon)+fg(meterDim, fmt.Sprintf("CH%.1f%%", *snap.hitRate)))
	}
	if cells >= 0 && (snap.ctxPct != nil || snap.ctxWindow > 0) {
		color := meterOK
		if snap.ctxPct != nil {
			color = meterColor(*snap.ctxPct)
		}
		ub := fg(accent, gaugeIcon)
		if snap.ctxPct != nil && cells > 0 {
			filled := meterCells(*snap.ctxPct, cells)
			ub += fg(color, strings.Repeat("█", filled)) + fg(meterDim, strings.Repeat("░", cells-filled)) + " "
		}
		if showTokens {
			toks := formatTokens(snap.ctxWindow)
			if snap.ctxTokens != nil {
				toks = formatTokens(*snap.ctxTokens) + "/" + toks
			} else {
				toks = "?/" + toks
			}
			ub += fg(color, toks)
		} else {
			ub = strings.TrimRight(ub, " ")
		}
		parts = append(parts, ub)
	}
	return strings.Join(parts, "  ")
}

// composeLine left-aligns the pill and right-aligns the tail.
func composeLine(left, right string, width int) string {
	if right == "" {
		return left
	}
	if left == "" {
		return right
	}
	pad := width - visLen(left) - visLen(right)
	if pad < 1 {
		pad = 1
	}
	return left + strings.Repeat(" ", pad) + right
}

// render lays out the footer at width. Pure: (snapshot, width) -> lines.
// Width math is SGR-aware, so painted rows measure as the host sees them.
//
// Line 1: powerline pill (model effort folder branch) + cache block +
// gauge + meter bar + tokens/window. Line 2: other extensions' statuses.
// Degrade ladder: line2 -> ASCII (same content, no Nerd Font glyphs) ->
// meter cells 10->5 -> tokens -> usage block -> pill segments
// right-to-left (model survives) -> hard truncate.
func render(snap snapshot, width int) [2]string {
	modelC, folderC, gitC := modelDark, folderDark, gitDark
	if snap.light {
		modelC, folderC, gitC = modelLight, folderLight, gitLight
	}
	segs := []plSeg{{icon: iconModel, text: snap.model, rgb: modelC}}
	if snap.effort != "" {
		segs = append(segs, plSeg{icon: iconEffort, text: snap.effort, rgb: effortRGB(snap.effort, snap.light)})
	}
	segs = append(segs, plSeg{icon: iconFolder, text: snap.folder, rgb: folderC})
	if snap.branch != "" {
		segs = append(segs, plSeg{icon: iconBranch, text: snap.branch, rgb: gitC})
	}

	pillKept := len(segs)
	cells := 10
	showTokens := true
	showUsage := true
	showLine2 := true
	plain := false
	for step := 0; ; step++ {
		pill := powerlineChain(segs[:pillKept])
		if plain {
			pill = asciiChain(segs[:pillKept])
		}
		usageCells := cells
		if !showUsage {
			usageCells = -1
		}
		right := rightBlock(snap, usageCells, showTokens, folderC, plain)
		l1 := composeLine(pill, right, width)
		l2 := ""
		if showLine2 && len(snap.statuses) > 0 {
			l2 = strings.Join(snap.statuses, " ")
		}
		if visLen(l1) <= width && visLen(l2) <= width {
			return [2]string{l1, l2}
		}
		switch step {
		case 0:
			showLine2 = false
		case 1:
			plain = true
		case 2:
			cells = 5
		case 3:
			showTokens = false
		case 4:
			showUsage = false
		case 5, 6, 7:
			if pillKept > 1 {
				pillKept--
			}
		default:
			return [2]string{fitTail(l1, width), fitTail(l2, width)}
		}
	}
}

// fitTail truncates from the right, keeping the identifying head.
// SGR is dropped on this path: it only runs below the irreducible core.
func fitTail(s string, width int) string {
	if width <= 0 {
		return ""
	}
	plain := stripSGR(s)
	if len([]rune(plain)) <= width {
		return s
	}
	runes := []rune(plain)
	if width <= 1 {
		return string(runes[:1])
	}
	return string(runes[:width-1]) + "…"
}
