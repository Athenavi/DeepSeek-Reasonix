package provider

import "context"

type auxiliaryObserverKey struct{}

type AuxiliaryProgress struct {
	OutputBytes int
	ToolCalls   int
}

// WithAuxiliaryOutputObserver observes content-free output/tool activity before
// buffering. Tool activity is not model-output progress. The callback must
// return promptly and must not reenter transport or storage.
// Transport observers remain attached independently on the same context.
func WithAuxiliaryOutputObserver(ctx context.Context, observe func(AuxiliaryProgress)) context.Context {
	return context.WithValue(ctx, auxiliaryObserverKey{}, observe)
}

func observeAuxiliaryOutput(ctx context.Context, c Chunk) {
	value := AuxiliaryProgress{}
	switch c.Type {
	case ChunkText, ChunkReasoning:
		value.OutputBytes = len(c.Text)
	case ChunkToolCallStart, ChunkToolCall:
		value.ToolCalls = 1
	}
	if value == (AuxiliaryProgress{}) {
		return
	}
	if observe, ok := ctx.Value(auxiliaryObserverKey{}).(func(AuxiliaryProgress)); ok {
		observe(value)
	}
}
