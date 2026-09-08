package agent

import (
	"context"
	"fmt"

	"reasonix/internal/imageinput"
	"reasonix/internal/provider"
)

func newImageInput(cfg *imageinput.Config) *imageinput.Service {
	if cfg == nil {
		return nil
	}
	return imageinput.New(*cfg)
}
func (a *Agent) ImageInput() *imageinput.Service { return a.imageInput }
func (a *Agent) processToolImages(ctx context.Context, text string, images []string) (string, *provider.VisionSummary) {
	if len(images) == 0 {
		return text, nil
	}
	if a.nativeImages {
		return text, nil
	}
	summary, err := a.imageInput.Understand(ctx, a.modelRef, images, a.Session().Snapshot, a.svc.sink)
	if err != nil {
		return text + fmt.Sprintf("\n[Image understanding unavailable: %v. The tool already executed; its text result remains valid. Do not claim to have seen the image or repeat the original action to retry image understanding.]", err), nil
	}
	return imageinput.AppendSummary(text, summary), summary
}

func supportsNativeImages(p provider.Provider) bool {
	info, ok := p.(provider.ModelInfoProvider)
	return ok && info.ModelInfo().SupportsInput(provider.ModalityImage)
}

// outcomeRunState preserves explicit execution evidence before image enrichment.
// The fallback covers older and synthetic outcomes that have no image prepass.
func outcomeRunState(o toolOutcome) provider.ToolRunState {
	if o.runState != "" {
		return o.runState
	}
	if !o.executed {
		return provider.ToolRunNotStarted
	}
	return provider.ToolResultRunState(provider.Message{Content: o.output + "\n" + o.errMsg})
}
