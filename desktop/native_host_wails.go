package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// wailsNativeHost adapts nativeHost onto the Wails v2 runtime. It is the only
// business-code importer of that package; the Electron shell replaces it with
// an IPC-backed implementation.
type wailsNativeHost struct{}

var _ nativeHost = wailsNativeHost{}

func (wailsNativeHost) ShowWindow(ctx context.Context)           { runtime.WindowShow(ctx) }
func (wailsNativeHost) ShowApplication(ctx context.Context)      { runtime.Show(ctx) }
func (wailsNativeHost) HideWindow(ctx context.Context)           { runtime.WindowHide(ctx) }
func (wailsNativeHost) HideApplication(ctx context.Context)      { runtime.Hide(ctx) }
func (wailsNativeHost) MaximiseWindow(ctx context.Context)       { runtime.WindowMaximise(ctx) }
func (wailsNativeHost) UnmaximiseWindow(ctx context.Context)     { runtime.WindowUnmaximise(ctx) }
func (wailsNativeHost) MinimiseWindow(ctx context.Context)       { runtime.WindowMinimise(ctx) }
func (wailsNativeHost) UnminimiseWindow(ctx context.Context)     { runtime.WindowUnminimise(ctx) }
func (wailsNativeHost) ToggleMaximiseWindow(ctx context.Context) { runtime.WindowToggleMaximise(ctx) }
func (wailsNativeHost) CenterWindow(ctx context.Context)         { runtime.WindowCenter(ctx) }
func (wailsNativeHost) WindowIsMaximised(ctx context.Context) bool {
	return runtime.WindowIsMaximised(ctx)
}
func (wailsNativeHost) WindowIsMinimised(ctx context.Context) bool {
	return runtime.WindowIsMinimised(ctx)
}
func (wailsNativeHost) SetWindowPosition(ctx context.Context, x, y int) {
	runtime.WindowSetPosition(ctx, x, y)
}
func (wailsNativeHost) SetWindowTitle(ctx context.Context, title string) {
	runtime.WindowSetTitle(ctx, title)
}
func (wailsNativeHost) OpenExternal(ctx context.Context, url string) {
	runtime.BrowserOpenURL(ctx, url)
}
func (wailsNativeHost) Quit(ctx context.Context) { runtime.Quit(ctx) }

func (wailsNativeHost) Screens(ctx context.Context) ([]nativeScreen, error) {
	screens, err := runtime.ScreenGetAll(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]nativeScreen, 0, len(screens))
	for _, sc := range screens {
		out = append(out, nativeScreen{
			Width:   sc.Size.Width,
			Height:  sc.Size.Height,
			Primary: sc.IsPrimary,
			Scale:   wailsScreenScale(sc),
		})
	}
	return out, nil
}

// Wails exposes logical and physical sizes but no scale factor; derive it so
// the host/screen.list shape stays complete.
func wailsScreenScale(sc runtime.Screen) float64 {
	if sc.Size.Width <= 0 || sc.PhysicalSize.Width <= 0 {
		return 1
	}
	return float64(sc.PhysicalSize.Width) / float64(sc.Size.Width)
}

func (wailsNativeHost) OpenDirectoryDialog(ctx context.Context, opts nativeDialogOptions) (string, error) {
	return runtime.OpenDirectoryDialog(ctx, wailsOpenDialogOptions(opts))
}

func (wailsNativeHost) OpenFileDialog(ctx context.Context, opts nativeDialogOptions) (string, error) {
	return runtime.OpenFileDialog(ctx, wailsOpenDialogOptions(opts))
}

func (wailsNativeHost) SaveFileDialog(ctx context.Context, opts nativeDialogOptions) (string, error) {
	return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{
		Title:                opts.Title,
		DefaultDirectory:     opts.DefaultDirectory,
		DefaultFilename:      opts.DefaultFilename,
		Filters:              wailsFileFilters(opts.Filters),
		CanCreateDirectories: opts.CanCreateDirectories,
	})
}

func (wailsNativeHost) MessageDialog(ctx context.Context, opts nativeMessageOptions) (string, error) {
	return runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          wailsDialogType(opts.Type),
		Title:         opts.Title,
		Message:       opts.Message,
		Buttons:       opts.Buttons,
		DefaultButton: opts.DefaultButton,
		CancelButton:  opts.CancelButton,
	})
}

// OpenDevTools is a WebKit message-handler hop: Wails has no runtime call for
// the inspector.
func (wailsNativeHost) OpenDevTools(ctx context.Context) {
	runtime.WindowExecJS(ctx, `window.webkit.messageHandlers.external.postMessage("wails:openInspector");`)
}

func (wailsNativeHost) NavigateRemoteWindow(ctx context.Context, url string) {
	if js, err := remoteWindowNavigationJS(url); err == nil {
		runtime.WindowExecJS(ctx, js)
	}
}

func wailsOpenDialogOptions(opts nativeDialogOptions) runtime.OpenDialogOptions {
	return runtime.OpenDialogOptions{
		Title:                opts.Title,
		DefaultDirectory:     opts.DefaultDirectory,
		DefaultFilename:      opts.DefaultFilename,
		Filters:              wailsFileFilters(opts.Filters),
		CanCreateDirectories: opts.CanCreateDirectories,
	}
}

func wailsFileFilters(filters []nativeFileFilter) []runtime.FileFilter {
	if len(filters) == 0 {
		return nil
	}
	out := make([]runtime.FileFilter, 0, len(filters))
	for _, f := range filters {
		out = append(out, runtime.FileFilter{DisplayName: f.DisplayName, Pattern: f.Pattern})
	}
	return out
}

func wailsDialogType(t nativeDialogType) runtime.DialogType {
	switch t {
	case nativeDialogInfo:
		return runtime.InfoDialog
	case nativeDialogWarning:
		return runtime.WarningDialog
	case nativeDialogError:
		return runtime.ErrorDialog
	default:
		return runtime.QuestionDialog
	}
}
