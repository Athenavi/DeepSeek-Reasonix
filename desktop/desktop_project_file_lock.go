package main

import (
	"context"
	"os"
	"path/filepath"
	"time"

	filelock "reasonix/internal/identitylock"
)

const desktopProjectsFileLockTimeout = 2 * time.Second

func acquireDesktopProjectsFileLock() (func(), error) {
	dir := desktopConfigDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopProjectsFileLockTimeout)
	defer cancel()
	return filelock.Acquire(ctx, filepath.Join(dir, desktopProjectsFile)+".lock")
}

// updateProjectsFileCrossProcessLocked requires desktopProjectsFileMu and the
// desktop-projects cross-process file lock.
func updateProjectsFileCrossProcessLocked(mutator func(*desktopProjectFile) (bool, error)) error {
	f := loadProjectsFile()
	previous := make([]string, 0, len(f.Projects))
	for _, project := range f.Projects {
		previous = append(previous, project.Root)
	}
	changed, err := mutator(&f)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if err := assignAddedProjectStateCollisions(previous, f.Projects); err != nil {
		return err
	}
	return saveProjectsFile(f)
}
