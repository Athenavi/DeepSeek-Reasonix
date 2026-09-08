package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"reasonix/internal/remote/sftpfs"
	"reasonix/internal/store"
)

// browserRelayMaxBytes bounds one staged capture; screenshots and downloads
// the shell writes are far smaller, and the HTTP wire already caps replies.
const browserRelayMaxBytes = 32 << 20

// FileRelay stages a desktop-side capture file (screenshot, download) onto
// the remote host through the existing SFTP channel, so the remote serve's
// tools read a path local to them. A desktop path is never handed to the
// remote as-is.
type FileRelay interface {
	// Stage copies localPath into the workspace's remote scratch directory
	// and returns the remote path of the copy.
	Stage(ctx context.Context, workspace, localPath string) (remotePath string, err error)
}

// sftpConn is the slice of an SSH client the relay needs; desktopSSHClient
// satisfies it and tests fake it.
type sftpConn interface {
	SFTP() (*sftpfs.FS, error)
}

// sftpFileRelay is the FileRelay over one SSH connection generation.
type sftpFileRelay struct {
	conn sftpConn
}

func (r sftpFileRelay) Stage(ctx context.Context, workspace, localPath string) (string, error) {
	info, err := os.Stat(localPath)
	if err != nil {
		return "", fmt.Errorf("browser relay: stat %s: %w", localPath, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("browser relay: %s is not a regular file", localPath)
	}
	if info.Size() > browserRelayMaxBytes {
		return "", fmt.Errorf("browser relay: %s exceeds %d bytes", localPath, browserRelayMaxBytes)
	}
	fs, err := r.conn.SFTP()
	if err != nil {
		return "", fmt.Errorf("browser relay: sftp: %w", err)
	}
	home, err := fs.RealPath(ctx, "~")
	if err != nil {
		return "", fmt.Errorf("browser relay: resolve remote home: %w", err)
	}
	dir := path.Join(home, ".reasonix", "browser-relay", store.RemoteWorkspaceSlug(workspace))
	if err := fs.MkdirAll(ctx, dir); err != nil {
		return "", fmt.Errorf("browser relay: remote scratch dir: %w", err)
	}
	f, err := os.Open(localPath)
	if err != nil {
		return "", fmt.Errorf("browser relay: open %s: %w", localPath, err)
	}
	defer f.Close()
	remote := path.Join(dir, relayFileName(localPath))
	if _, err := fs.UploadAtomic(ctx, remote, io.LimitReader(f, browserRelayMaxBytes), 0o600); err != nil {
		return "", fmt.Errorf("browser relay: upload %s: %w", localPath, err)
	}
	return remote, nil
}

// relayFileName prefixes the capture's base name with randomness so repeated
// captures of the same tab never overwrite a file a tool call still reads.
func relayFileName(localPath string) string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	base := filepath.Base(localPath)
	base = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == 0 {
			return '-'
		}
		return r
	}, base)
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "capture"
	}
	return hex.EncodeToString(buf) + "-" + base
}
