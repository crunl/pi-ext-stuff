package pig_herdr

import (
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// Retry cadence mirrors the official pi integration: one fast attempt,
// one patient attempt, then silence. Reports are advisory; herdr clears
// stale presence on idle-shell detection, so a dropped frame degrades to
// a briefly outdated sidebar, never to a stuck agent.
const (
	firstTimeout  = 500 * time.Millisecond
	retryTimeout  = 1500 * time.Millisecond
	maxFrameBytes = 8192
)

// sendFrame is a seam for tests: production dials the herdr socket,
// tests capture frames without any socket.
var sendFrame = sendWithRetry

func sendWithRetry(socketPath string, frame []byte) bool {
	if len(frame) == 0 || len(frame) > maxFrameBytes {
		return false
	}
	if sendOnce(socketPath, frame, firstTimeout) {
		return true
	}
	return sendOnce(socketPath, frame, retryTimeout)
}

// sendOnce dials, writes one newline-terminated frame, and waits for any
// response bytes. Any data is delivery (the pi client does not parse the
// body); EOF with no data, errors, and timeouts are failure.
func sendOnce(socketPath string, frame []byte, timeout time.Duration) bool {
	conn, err := dialConn(socketPath, timeout)
	if err != nil {
		return false
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return false
	}
	if _, err := conn.Write(frame); err != nil {
		return false
	}
	buf := make([]byte, 4096)
	n, _ := conn.Read(buf)
	return n > 0
}

// Windows named pipes are ladder L2: stdlib cannot dial them without an
// external package, and v1 targets the unix socket on darwin/linux.
func dialHerdr(socketPath string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", socketPath, timeout)
}

// reporter owns the single mutable bit: the last published signature,
// the monotonic seq, and the one in-flight send. Frames are published by
// copying bytes out from under the mutex; the socket is never touched
// while the lock is held.
type reporter struct {
	mu         sync.Mutex
	socketPath string
	paneID     string
	enabled    bool
	// sealed is terminal for the current hold: once a release frame is
	// queued or sent, racing publishState calls must drop instead of
	// clobbering it. Only enable() re-arms.
	sealed   bool
	seq      uint64
	lastSig  string
	inFlight bool
	queued   []byte
}

func newReporterFromEnv() (*reporter, bool) {
	if os.Getenv("HERDR_ENV") != "1" {
		return nil, false
	}
	socketPath := os.Getenv("HERDR_SOCKET_PATH")
	paneID := os.Getenv("HERDR_PANE_ID")
	if socketPath == "" || paneID == "" {
		return nil, false
	}
	return &reporter{
		socketPath: socketPath,
		paneID:     paneID,
		enabled:    true,
		seq:        uint64(time.Now().UnixNano() / 1000),
	}, true
}

// publishState sends state unless the visible tuple is unchanged. The
// resume command rides along whenever the session id validates; a missing
// resume still reports presence (presence without restore beats silence).
// An id that fails validation is omitted from both the session ref and the
// resume argv, never half-reported.
func (r *reporter) publishState(state State, sessionID string) {
	resume, ok := resumeArgv(sessionID)
	if !ok {
		sessionID, resume = "", nil
	}
	r.mu.Lock()
	if !r.enabled || r.sealed {
		r.mu.Unlock()
		return
	}
	sig := string(state) + "\x00" + sessionID + "\x00" + strings.Join(resume, "\x00")
	if sig == r.lastSig {
		r.mu.Unlock()
		return
	}
	r.lastSig = sig
	r.seq++
	frame := encodeReport(r.paneID, state, "", sessionID, resume, r.seq)
	r.enqueueLocked(frame)
	r.mu.Unlock()
}

// disable releases the pane hold and stops reporting atomically. The
// release frame is built under the same lock that flips enabled, so a
// concurrent publishState can neither slip in after the release nor
// resurrect reporting before the flag drops. Nothing held, nothing
// sent: a toggle before the first publish stays silent.
func (r *reporter) disable() {
	r.mu.Lock()
	if !r.enabled {
		r.mu.Unlock()
		return
	}
	r.enabled = false
	r.sealed = true
	held := r.lastSig
	r.lastSig = ""
	r.seq++
	frame := encodeRelease(r.paneID, r.seq)
	if held == "" {
		r.mu.Unlock()
		return
	}
	r.enqueueLocked(frame)
	r.mu.Unlock()
}

// enable re-arms reporting after disable. The next publishState differs
// from the cleared signature and sends.
func (r *reporter) enable() {
	r.mu.Lock()
	r.enabled = true
	r.sealed = false
	r.mu.Unlock()
}

// releaseSync is the shutdown path: it sends inline instead of
// enqueueing, because the host may terminate the extension process as
// soon as the shutdown handler returns. Bounded by the send timeouts
// (fast path first, patient retry), swallowed like every other report.
// No ctx is consulted here, so a torn-down session cannot panic the
// shutdown. A frame queued by disable() but not yet sent is superseded
// rather than lost: the new release carries a higher seq, and herdr
// silently ignores anything older — so toggle-off-then-exit still
// releases, and nothing held still sends nothing.
func (r *reporter) releaseSync() {
	r.mu.Lock()
	if r.queued == nil && (!r.enabled || r.lastSig == "") {
		r.mu.Unlock()
		return
	}
	r.enabled = false
	r.sealed = true
	r.lastSig = ""
	r.queued = nil
	r.seq++
	frame := encodeRelease(r.paneID, r.seq)
	socketPath := r.socketPath
	r.mu.Unlock()
	sendFrame(socketPath, frame)
}

func (r *reporter) isEnabled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.enabled
}

// enqueueLocked queues the latest frame; the caller must hold mu.
// Queueing under the same lock that assigns seq and checks sealed
// closes the unlock-then-enqueue window where a racing publish could
// overwrite a release with an older report. If several states queue
// while one report is in flight, the older ones are dropped — safe
// because only the highest seq matters: herdr silently ignores any
// report whose seq is not higher than the last one it applied.
// Spawning the drain goroutine under the lock is safe (go never blocks).
func (r *reporter) enqueueLocked(frame []byte) {
	r.queued = frame
	if r.inFlight {
		return
	}
	r.inFlight = true
	go r.drain()
}

func (r *reporter) drain() {
	for {
		r.mu.Lock()
		frame := r.queued
		r.queued = nil
		if frame == nil {
			r.inFlight = false
			r.mu.Unlock()
			return
		}
		socketPath := r.socketPath
		r.mu.Unlock()
		sendFrame(socketPath, frame)
	}
}

// dialConn is a seam for tests: production dials the herdr unix socket,
// tests point it at a silent TCP peer to trip the deadline path without
// depending on unix socket path-length limits inside t.TempDir().
var dialConn = dialHerdr
