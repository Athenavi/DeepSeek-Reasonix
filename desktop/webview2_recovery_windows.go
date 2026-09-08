//go:build windows

package main

import "context"

func showWindowsWebView2RecoveryGuidance(ctx context.Context, host nativeHost) {
	_, _ = host.MessageDialog(ctx, nativeMessageOptions{
		Type:  nativeDialogWarning,
		Title: "Reasonix WebView2 recovery / WebView2 恢复",
		Message: "Reasonix stopped automatic recovery because WebView2 failed again within five minutes. " +
			"Repair or update Microsoft Edge WebView2 Runtime, update the graphics driver, then restart Reasonix.\n\n" +
			"WebView2 在五分钟内再次失败，Reasonix 已停止自动重启以避免循环。" +
			"请修复或更新 Microsoft Edge WebView2 Runtime 和显卡驱动，然后重新启动 Reasonix。",
		Buttons:       []string{"OK"},
		DefaultButton: "OK",
	})
}
