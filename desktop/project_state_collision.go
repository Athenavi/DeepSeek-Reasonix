package main

import "reasonix/internal/config"

// assignAddedProjectStateCollisions records a distinct path only for a newly
// registered project whose historical slug is already used by a recorded
// project. Roots already in the file keep their old directory, even when an
// older release let them overlap there.
func assignAddedProjectStateCollisions(previous []string, projects []desktopProject) error {
	known := append([]string(nil), previous...)
	for _, project := range projects {
		root := normalizeProjectRoot(project.Root)
		if root == "" {
			continue
		}
		alreadyKnown := false
		collision := false
		for _, prior := range known {
			if sameProjectRoot(prior, root) {
				alreadyKnown = true
				break
			}
			if config.WorkspaceSlug(prior) == config.WorkspaceSlug(root) {
				collision = true
			}
		}
		if alreadyKnown {
			continue
		}
		if collision {
			if err := config.AssignProjectStateCollision(config.MemoryUserDir(), root); err != nil {
				return err
			}
		}
		known = append(known, root)
	}
	return nil
}
