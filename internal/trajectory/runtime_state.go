package trajectory

import "reasonix/internal/event"

func (s *Recorder) RuntimeStateChanged(snapshot event.RuntimeStateSnapshot) {
	if s != nil { event.PublishRuntimeState(s.inner, snapshot) }
}
