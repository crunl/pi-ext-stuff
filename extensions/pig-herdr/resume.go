package pig_herdr

// resumeArgv builds the herdr restart command for a pig session. The return
// is an argv array, never a shell string, so no quoting surface exists.
// Validation mirrors the server rules (bare argv0, no apostrophe or control
// characters, bounded length); a rejected id means "report presence without
// resume", never "guess".
func resumeArgv(sessionID string) ([]string, bool) {
	if sessionID == "" || len(sessionID) > 128 {
		return nil, false
	}
	for _, r := range sessionID {
		ok := r == '-' || r == '_' || r == '.' ||
			(r >= '0' && r <= '9') ||
			(r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z')
		if !ok {
			return nil, false
		}
	}
	return []string{"pig", "--session", sessionID}, true
}
