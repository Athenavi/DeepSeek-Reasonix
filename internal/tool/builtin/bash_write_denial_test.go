package builtin

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"reasonix/internal/sandbox"
)

func TestSandboxWriteDenialClassifierRejectsOrdinaryFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
		err  error
	}{
		{name: "python key error", out: "Traceback\nKeyError: 'observation_time'", err: errors.New("exit status 1")},
		{name: "http failure", out: "HTTP 403: permission denied", err: errors.New("exit status 22")},
		{name: "timeout", out: "curl: (28) operation timed out", err: errors.New("exit status 28")},
		{name: "sandbox startup", out: "", err: errors.New("sandbox helper failed to start")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if looksLikeSandboxWriteDenial(tc.out, tc.err) {
				t.Fatal("ordinary failure was classified as a sandbox write denial")
			}
		})
	}
}

func TestSandboxWriteDenialClassifierAcceptsFilesystemFailures(t *testing.T) {
	for _, out := range []string{
		"touch: /outside/file: Permission denied",
		"bash: /outside/file: Permission denied",
		"mkdir: cannot create directory '/outside': Read-only file system",
		"open /outside/file: operation not permitted",
		"PermissionError: [Errno 13] Permission denied: '/outside/file'",
	} {
		if !looksLikeSandboxWriteDenial(out, errors.New("exit status 1")) {
			t.Fatalf("filesystem failure was not recognized: %q", out)
		}
	}
}

func TestSandboxWriteHintNamesGitWorktreeMetadata(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	main := filepath.Join(root, "main")
	worktree := filepath.Join(root, "linked")
	if err := os.Mkdir(main, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", main}, {"-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"}, {"-C", main, "worktree", "add", "-b", "linked", worktree}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	subdir := filepath.Join(worktree, "subdir")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitDir := filepath.Join(main, ".git", "worktrees", "linked")
	denial := "fatal: Unable to create '" + filepath.Join(gitDir, "index.lock") + "': Operation not permitted"
	hint := appendSandboxWriteHint(denial, errors.New("exit status 128"), bashParams{Command: "git add ."}, sandbox.Spec{Mode: "enforce", WriteRoots: []string{worktree}}, "", subdir)
	if !strings.Contains(hint, filepath.Join(main, ".git")) || !strings.Contains(hint, "additional_write_dirs") {
		t.Fatalf("missing actionable worktree metadata hint: %s", hint)
	}
	if got := gitWorktreeWriteDirs(subdir, "touch: /outside: Operation not permitted", []string{worktree}); len(got) != 0 {
		t.Fatalf("unrelated denial must not suggest Git metadata: %v", got)
	}
	if got := gitWorktreeWriteDirs(subdir, denial, []string{worktree, filepath.Join(main, ".git")}); len(got) != 0 {
		t.Fatalf("already writable metadata must not be suggested: %v", got)
	}
	commonDenial := "fatal: cannot lock ref 'refs/heads/linked': Unable to create '" + filepath.Join(main, ".git", "refs", "heads", "linked.lock") + "': Operation not permitted"
	if got := gitWorktreeWriteDirs(subdir, commonDenial, []string{worktree, gitDir}); len(got) != 1 || got[0] != filepath.Join(main, ".git") {
		t.Fatalf("common metadata still needs approval after a narrow gitdir grant: %v", got)
	}
	if runtime.GOOS != "darwin" {
		return
	}
	if _, err := exec.LookPath("sandbox-exec"); err != nil {
		t.Skip("macOS Seatbelt is unavailable")
	}
	if err := os.WriteFile(filepath.Join(worktree, "note.txt"), []byte("change\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	profile := fmt.Sprintf("(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\") (subpath %q))", worktree)
	blocked, err := exec.Command("sandbox-exec", "-p", profile, "git", "-C", worktree, "add", "note.txt").CombinedOutput()
	if err == nil || !strings.Contains(string(blocked), "index.lock") {
		t.Fatalf("git add must fail at external worktree metadata: %v: %s", err, blocked)
	}
	if hint := appendSandboxWriteHint(string(blocked), err, bashParams{Command: "git add note.txt"}, sandbox.Spec{Mode: "enforce", WriteRoots: []string{worktree}}, "", worktree); !strings.Contains(hint, filepath.Join(main, ".git")) {
		t.Fatalf("actual Seatbelt denial did not name the needed directory: %s", hint)
	}
	profile = fmt.Sprintf("(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\") (subpath %q) (subpath %q))", worktree, filepath.Join(main, ".git"))
	if out, err := exec.Command("sandbox-exec", "-p", profile, "git", "-C", worktree, "add", "note.txt").CombinedOutput(); err != nil {
		t.Fatalf("approved metadata must permit git add: %v: %s", err, out)
	}
}
