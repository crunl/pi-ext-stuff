package pig_herdr

import (
	"reflect"
	"testing"
)

func TestResumeArgv(t *testing.T) {
	cases := []struct {
		id    string
		want  []string
		valid bool
	}{
		{"abc123", []string{"pig", "--session", "abc123"}, true},
		{"sess-1_2.3", []string{"pig", "--session", "sess-1_2.3"}, true},
		{"", nil, false},
		{"has space", nil, false},
		{"semi;colon", nil, false},
		{"dol$lar", nil, false},
		{"back`tick", nil, false},
		{"quote'here", nil, false},
		{"new\nline", nil, false},
		{"ctrl\x00byte", nil, false},
		{"../escape", nil, false},
		{string(make([]byte, 129)), nil, false},
	}
	for _, c := range cases {
		got, ok := resumeArgv(c.id)
		if ok != c.valid || (ok && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("resumeArgv(%q) = (%v, %v), want (%v, %v)",
				c.id, got, ok, c.want, c.valid)
		}
		if ok && len(got) != 3 {
			t.Errorf("resumeArgv(%q) must stay a 3-element argv, got %d", c.id, len(got))
		}
	}
}
