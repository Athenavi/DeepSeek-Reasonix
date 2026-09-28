package provider

import (
	"context"
	"testing"
)

type observedAuxiliaryProvider struct {
	reached chan struct{}
	release chan struct{}
}

func (*observedAuxiliaryProvider) Name() string { return "observation-fixture" }
func (p *observedAuxiliaryProvider) Stream(ctx context.Context, _ Request) (<-chan Chunk, error) {
	ch := make(chan Chunk)
	go func() {
		defer close(ch)
		for _, chunk := range []Chunk{{Type: ChunkText}, {Type: ChunkUsage}, {Type: ChunkReasoning, Text: "hidden"}, {Type: ChunkText, Text: "digest"}} {
			select {
			case ch <- chunk:
			case <-ctx.Done():
				return
			}
		}
		close(p.reached)
		select {
		case <-p.release:
		case <-ctx.Done():
			return
		}
		select {
		case ch <- Chunk{Type: ChunkDone}:
		case <-ctx.Done():
		}
	}()
	return ch, nil
}

func TestAuxiliaryObservationPrecedesBufferDeliveryWithoutContent(t *testing.T) {
	p := &observedAuxiliaryProvider{reached: make(chan struct{}), release: make(chan struct{})}
	observed := make(chan int, 4)
	ctx := WithAuxiliaryOutputObserver(t.Context(), func(value AuxiliaryProgress) { observed <- value.OutputBytes })
	ch, err := StreamAuxiliary(ctx, p, Request{})
	if err != nil {
		t.Fatal(err)
	}
	<-p.reached
	if first, second := <-observed, <-observed; first != 6 || second != 6 {
		t.Fatalf("counts = %d,%d", first, second)
	}
	select {
	case <-observed:
		t.Fatal("empty/usage chunk counted as progress")
	default:
	}
	select {
	case <-ch:
		t.Fatal("partial response escaped buffering")
	default:
	}
	close(p.release)
	for range ch {
	}
}

func TestAuxiliaryToolActivityAndTransportObserversRemainSeparate(t *testing.T) {
	var progress []AuxiliaryProgress
	ctx := WithAuxiliaryOutputObserver(t.Context(), func(value AuxiliaryProgress) { progress = append(progress, value) })
	for _, value := range []Chunk{{Type: ChunkUsage}, {Type: ChunkText}, {Type: ChunkToolCallStart}, {Type: ChunkReasoning, Text: "private"}} {
		observeAuxiliaryOutput(ctx, value)
	}
	if len(progress) != 2 || progress[0].ToolCalls != 1 || progress[0].OutputBytes != 0 || progress[1].OutputBytes != 7 {
		t.Fatalf("progress=%+v", progress)
	}
	var first, second int
	ctx = WithRequestObserver(ctx, func(RequestObservation) { first++ })
	ctx = WithAdditionalRequestObserver(ctx, func(RequestObservation) { second++ })
	_, observation := observeRequest(ctx)
	observation.finish(nil, "finished")
	if first != 2 || second != 2 {
		t.Fatalf("original=%d added=%d", first, second)
	}
}
