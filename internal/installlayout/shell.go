package installlayout

import "runtime"

// AppShellDirName is the tree member inside versions/<version>/ that holds the
// Electron shell bundle beside the Go desktop binary.
const AppShellDirName = "app"

// ShellExecutableName is the shell executable base name under app/.
func ShellExecutableName() string { return ShellExecutableNameFor(runtime.GOOS) }

// ShellExecutableNameFor returns the shell executable base name for goos.
func ShellExecutableNameFor(goos string) string {
	switch goos {
	case "windows":
		return "Reasonix.exe"
	case "darwin":
		return "Reasonix"
	default:
		return "reasonix"
	}
}
