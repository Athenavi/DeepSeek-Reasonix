package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBrowserUploadStagesOnlyOwnedFiles(t *testing.T) {
	root, other, scratch := t.TempDir(), t.TempDir(), t.TempDir()
	owned := filepath.Join(root, "report.csv")
	foreign := filepath.Join(other, "secret.csv")
	if err := os.WriteFile(owned, []byte("owned bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(foreign, []byte("foreign bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape.csv")
	if err := os.Symlink(foreign, link); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{foreign, link, root, "relative.csv"} {
		if _, err := stageOwnedBrowserFile([]string{root}, scratch, file); err == nil {
			t.Fatalf("unowned/non-file path accepted: %s", file)
		}
	}
	staged, err := stageOwnedBrowserFile([]string{root}, scratch, owned)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(staged) != "report.csv" {
		t.Fatalf("filename changed: %s", staged)
	}
	if err := os.WriteFile(owned, []byte("later bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(staged)
	if err != nil || string(got) != "owned bytes" {
		t.Fatalf("staged file did not retain approved bytes: %q %v", got, err)
	}
}
