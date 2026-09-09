package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"reasonix/internal/installlayout"
	"testing"
)

func linuxShellArchive(t *testing.T, extra *tar.Header, omit string) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	names := append([]string{"reasonix-desktop", "reasonix", "reasonix-launcher", "reasonix-guard"}, installlayout.ShellRequiredNames("linux")...)
	names = append(names, "app/chrome-sandbox", "app/locales/en-US.pak")
	for _, name := range names {
		if name == omit {
			continue
		}
		data := []byte("new-" + name)
		h := &tar.Header{Name: name, Mode: 0755, Size: int64(len(data)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if extra != nil {
		if err := tw.WriteHeader(extra); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestLinuxShellUpdateAtomicallyPublishesResourcesAndLauncher(t *testing.T) {
	root := t.TempDir()
	archive := linuxShellArchive(t, nil, "")
	for _, version := range []string{"v1.39.0", "v1.39.1"} {
		if err := activateLinuxShellRelease(archive, version, root); err != nil {
			t.Fatal(err)
		}
	}
	ptr, err := installlayout.ReadCurrent(root)
	if err != nil || ptr.ActiveVersion != "v1.39.1" {
		t.Fatalf("pointer=%+v %v", ptr, err)
	}
	for _, name := range append(installlayout.ShellRequiredNames("linux"), "app/locales/en-US.pak", "reasonix-desktop", "reasonix") {
		p := filepath.Join(root, "versions", ptr.ActiveVersion, filepath.FromSlash(name))
		data, err := os.ReadFile(p)
		if err != nil || string(data) != "new-"+name {
			t.Errorf("bad %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "reasonix-launcher")); err != nil {
		t.Fatal(err)
	}
}

func TestLinuxShellUpdateRejectsPartialOrUnsafeTreeWithoutMovingPointer(t *testing.T) {
	cases := map[string]struct {
		header *tar.Header
		omit   string
	}{
		"missing renderer": {nil, "app/resources/app.asar"},
		"traversal":        {&tar.Header{Name: "app/../outside", Typeflag: tar.TypeReg}, ""},
		"symlink":          {&tar.Header{Name: "app/link", Linkname: "/tmp", Typeflag: tar.TypeSymlink}, ""},
		"duplicate":        {&tar.Header{Name: "app/Reasonix", Typeflag: tar.TypeReg}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := activateLinuxShellRelease(linuxShellArchive(t, nil, ""), "v1.39.0", root); err != nil {
				t.Fatal(err)
			}
			if err := activateLinuxShellRelease(linuxShellArchive(t, tc.header, tc.omit), "v1.39.1", root); err == nil {
				t.Fatal("accepted invalid release")
			}
			ptr, err := installlayout.ReadCurrent(root)
			if err != nil || ptr.ActiveVersion != "v1.39.0" {
				t.Fatalf("changed old pointer: %+v %v", ptr, err)
			}
		})
	}
}
