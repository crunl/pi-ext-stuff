package pig_herdr

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// serveOne accepts a single connection, reads one frame, and replies with
// a minimal ack. It mirrors the only server behavior the client relies on:
// any response bytes mean delivery.
func serveOne(t *testing.T, sock string, ack string) chan []byte {
	t.Helper()
	got := make(chan []byte, 1)
	go func() {
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Error(err)
			return
		}
		defer l.Close()
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 8192)
		n, _ := conn.Read(buf)
		got <- append([]byte(nil), buf[:n]...)
		_, _ = conn.Write([]byte(ack))
	}()
	return got
}

func TestSendOnceDeliversAndAcks(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s.sock")
	got := serveOne(t, sock, `{"id":"x","result":{}}`)
	frame := encodeReport("w1:p1", StateWorking, "", "s", []string{"pig", "--session", "s"}, 1)
	if !sendOnce(sock, frame, 2*time.Second) {
		t.Fatal("sendOnce against a live listener must succeed")
	}
	select {
	case b := <-got:
		if string(b) != string(frame) {
			t.Fatalf("server got %q, want %q", b, frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server never received the frame")
	}
}

func TestSendOnceMissingSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "nope.sock")
	before := time.Now()
	if sendOnce(sock, []byte("{}\n"), 300*time.Millisecond) {
		t.Fatal("missing socket must fail, not hang or succeed")
	}
	if time.Since(before) > 2*time.Second {
		t.Fatal("missing socket must fail fast")
	}
}

func TestSendOnceSilentPeerTripsDeadline(t *testing.T) {
	// TCP loopback, not a unix socket: t.TempDir() paths can exceed the
	// unix bind length limit, while the deadline path under test is
	// transport-agnostic.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 8192)
		_, _ = conn.Read(buf)
		// Never reply: hold the connection open past the deadline.
		time.Sleep(2 * time.Second)
	}()
	old := dialConn
	dialConn = func(_ string, timeout time.Duration) (net.Conn, error) {
		return net.DialTimeout("tcp", l.Addr().String(), timeout)
	}
	defer func() { dialConn = old }()
	if sendOnce("ignored", []byte("{}\n"), 200*time.Millisecond) {
		t.Fatal("a peer that never replies must trip the deadline")
	}
}

func TestPublishDedupesIdenticalState(t *testing.T) {
	var mu sync.Mutex
	var frames [][]byte
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		mu.Lock()
		frames = append(frames, append([]byte(nil), f...))
		mu.Unlock()
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 100}
	r.publishState(StateWorking, "s1")
	r.publishState(StateWorking, "s1")
	r.publishState(StateWorking, "s1")
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(frames)
		mu.Unlock()
		if n >= 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(frames) != 1 {
		t.Fatalf("three identical publishes must send exactly one frame, sent %d", len(frames))
	}
}

func TestPublishResendsOnChange(t *testing.T) {
	release := make(chan []byte, 4)
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		release <- append([]byte(nil), f...)
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 200}
	// One frame per publish: wait for each send before the next publish,
	// because rapid successive publishes coalesce by design (latest wins).
	r.publishState(StateWorking, "s1")
	<-release
	r.publishState(StateIdle, "s1")
	<-release
	r.disable()
	select {
	case <-release:
	case <-time.After(2 * time.Second):
		t.Fatal("release frame never arrived")
	}
}

func TestDisableReleasesAtomicallyAndSeals(t *testing.T) {
	var mu sync.Mutex
	var frames [][]byte
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		mu.Lock()
		frames = append(frames, append([]byte(nil), f...))
		mu.Unlock()
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 400}
	r.publishState(StateWorking, "s1")
	waitForFrames(t, &mu, &frames, 1)
	r.disable()
	waitForFrames(t, &mu, &frames, 2)
	// A racing publish after disable must drop, not resurrect or
	// clobber the queued release.
	r.publishState(StateWorking, "s1")
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(frames) != 2 {
		t.Fatalf("disable must send state+release and seal, sent %d", len(frames))
	}
	if !isRelease(frames[1]) {
		t.Fatalf("second frame must be the release, got %s", frames[1])
	}
}

func TestReleaseSyncSealsAgainstRacingPublish(t *testing.T) {
	sent := make(chan []byte, 8)
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		sent <- append([]byte(nil), f...)
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 500}
	r.publishState(StateWorking, "s1")
	<-sent
	r.releaseSync()
	// Anything racing past the seal drops: the release stays last.
	r.publishState(StateIdle, "s1")
	select {
	case b := <-sent:
		if !isRelease(b) {
			t.Fatalf("frame after release must be the release, got %s", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("release frame never arrived")
	}
	select {
	case b := <-sent:
		t.Fatalf("sealed reporter must not send again, got %s", b)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestReleaseSyncSendsInline(t *testing.T) {
	sent := make(chan []byte, 4)
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		sent <- append([]byte(nil), f...)
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 600}
	r.publishState(StateWorking, "s1") // hold something so release has work
	r.releaseSync()                    // inline; must not depend on drain
	// The queued state may already have been taken by drain, or it may
	// still be queued and superseded: either way exactly one release
	// goes out with the highest seq, which is what the server converges
	// on. Afterwards no drain goroutine is left to leak into the next
	// test's fake.
	var frames [][]byte
	deadline := time.Now().Add(10 * time.Second)
collect:
	for {
		select {
		case b := <-sent:
			frames = append(frames, b)
		case <-time.After(300 * time.Millisecond):
			break collect
		}
		if time.Now().After(deadline) {
			t.Fatal("drain never quiesced")
		}
	}
	releases := 0
	var relSeq uint64
	for _, b := range frames {
		if isRelease(b) {
			releases++
			relSeq = seqOf(t, b)
		}
	}
	if releases != 1 {
		t.Fatalf("releaseSync must send exactly one release, sent %d of %d frames", releases, len(frames))
	}
	for _, b := range frames {
		if !isRelease(b) && seqOf(t, b) >= relSeq {
			t.Fatalf("state frame seq must precede the release seq: %s", b)
		}
	}
	if r.isEnabled() {
		t.Fatal("releaseSync must leave the reporter off")
	}
}

func TestReporterInertWhenDisabled(t *testing.T) {
	called := false
	old := sendFrame
	sendFrame = func(_ string, _ []byte) bool { called = true; return true }
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: false, seq: 300}
	r.publishState(StateWorking, "s1")
	r.releaseSync()
	time.Sleep(100 * time.Millisecond)
	if called {
		t.Fatal("disabled reporter must not touch the socket")
	}
}

func TestSilentWhenNothingHeld(t *testing.T) {
	var called atomic.Bool
	old := sendFrame
	sendFrame = func(_ string, _ []byte) bool { called.Store(true); return true }
	defer func() { sendFrame = old }()

	// Toggle off before the first publish: no hold, no frame.
	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 700}
	r.disable()
	// Shutdown with nothing published (e.g. headless session): silent.
	s := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 701}
	s.releaseSync()
	time.Sleep(100 * time.Millisecond)
	if called.Load() {
		t.Fatal("release with nothing held must not send")
	}
}

func TestEnvGate(t *testing.T) {
	t.Setenv("HERDR_ENV", "1")
	t.Setenv("HERDR_SOCKET_PATH", "/tmp/x.sock")
	t.Setenv("HERDR_PANE_ID", "w1:p9")
	r, ok := newReporterFromEnv()
	if !ok || r.paneID != "w1:p9" {
		t.Fatalf("full env must construct a reporter, got %+v %v", r, ok)
	}

	t.Setenv("HERDR_ENV", "0")
	if _, ok := newReporterFromEnv(); ok {
		t.Fatal("HERDR_ENV=0 must stay inert")
	}

	t.Setenv("HERDR_ENV", "1")
	t.Setenv("HERDR_PANE_ID", "")
	if _, ok := newReporterFromEnv(); ok {
		t.Fatal("missing pane id must stay inert")
	}

	os.Unsetenv("HERDR_SOCKET_PATH")
	if _, ok := newReporterFromEnv(); ok {
		t.Fatal("missing socket path must stay inert")
	}
}

func waitForFrames(t *testing.T, mu *sync.Mutex, frames *[][]byte, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := len(*frames)
		mu.Unlock()
		if count >= n || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*frames) != n {
		t.Fatalf("want %d frames, got %d", n, len(*frames))
	}
}

func isRelease(b []byte) bool {
	return strings.Contains(string(b), `"method":"pane.release_agent"`)
}

func seqOf(t *testing.T, b []byte) uint64 {
	t.Helper()
	var f struct {
		Params struct {
			Seq uint64 `json:"seq"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSuffix(string(b), "\n")), &f); err != nil {
		t.Fatalf("frame is not JSON: %v", err)
	}
	return f.Params.Seq
}

func TestEnableRoundTrip(t *testing.T) {
	var mu sync.Mutex
	var frames [][]byte
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		mu.Lock()
		frames = append(frames, append([]byte(nil), f...))
		mu.Unlock()
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 900}
	r.publishState(StateWorking, "s1")
	waitForFrames(t, &mu, &frames, 1)
	r.disable()
	waitForFrames(t, &mu, &frames, 2)
	// Re-arming must resume state reporting: the cleared signature
	// differs, so the same tuple sends again.
	r.enable()
	r.publishState(StateIdle, "s1")
	waitForFrames(t, &mu, &frames, 3)
	mu.Lock()
	defer mu.Unlock()
	if len(frames) != 3 {
		t.Fatalf("round trip must send state+release+state, sent %d", len(frames))
	}
	if !isRelease(frames[1]) {
		t.Fatalf("second frame must be the release, got %s", frames[1])
	}
	if isRelease(frames[2]) {
		t.Fatal("re-enable must resume state reporting, not re-release")
	}
}

func TestDisableVsConcurrentPublish(t *testing.T) {
	sent := make(chan []byte, 8192)
	old := sendFrame
	sendFrame = func(_ string, f []byte) bool {
		sent <- append([]byte(nil), f...)
		return true
	}
	defer func() { sendFrame = old }()

	r := &reporter{socketPath: "x", paneID: "w1:p1", enabled: true, seq: 800}
	var stop atomic.Bool
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				// Alternate so dedupe never swallows the publish.
				r.publishState(StateWorking, "s")
				r.publishState(StateIdle, "s")
			}
		}()
	}
	// Hammer, then disable mid-flight: with unlock-then-enqueue a
	// publish could land after the release and clobber it; with
	// enqueueLocked the release always wins.
	time.Sleep(50 * time.Millisecond)
	r.disable()
	stop.Store(true)
	wg.Wait()

	var frames [][]byte
	deadline := time.Now().Add(10 * time.Second)
collect:
	for {
		select {
		case b := <-sent:
			frames = append(frames, b)
		case <-time.After(300 * time.Millisecond):
			break collect
		}
		if time.Now().After(deadline) {
			t.Fatal("drain never quiesced")
		}
	}
	if len(frames) == 0 {
		t.Fatal("no frames sent at all")
	}
	// All sends flow through the single serial drain, so the release
	// enqueued last under the lock must arrive last.
	if !isRelease(frames[len(frames)-1]) {
		t.Fatalf("last frame must be the release, got %s", frames[len(frames)-1])
	}
	releases := 0
	var relSeq uint64
	for _, b := range frames {
		if isRelease(b) {
			releases++
			relSeq = seqOf(t, b)
		}
	}
	if releases != 1 {
		t.Fatalf("disable must send exactly one release, sent %d", releases)
	}
	// seq is assigned under the same lock: any sent state frame is
	// older than the release, so the server can never prefer it.
	for _, b := range frames {
		if !isRelease(b) && seqOf(t, b) >= relSeq {
			t.Fatalf("state frame seq must precede the release seq: %s", b)
		}
	}
}
