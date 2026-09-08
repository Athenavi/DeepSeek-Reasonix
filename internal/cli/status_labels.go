package cli

import (
	"fmt"
	"path/filepath"
	"strings"

	"reasonix/internal/event"
	"reasonix/internal/i18n"
)

// readStatusLabelText renders the host's structured read status for the live
// status line; an inactive or unnamed frame clears it.
func readStatusLabelText(rs *event.ReadStatusPayload) string {
	if rs == nil || !rs.Active || strings.TrimSpace(rs.Path) == "" {
		return ""
	}
	file := filepath.Base(rs.Path)
	covered := ""
	if len(rs.Covered) > 0 {
		covered = fmt.Sprintf("%d-%d", rs.Covered[0][0], rs.Covered[len(rs.Covered)-1][1])
	}
	switch {
	case rs.State == "blocked" || rs.State == "needs_scope":
		return fmt.Sprintf(i18n.M.ReadStatusPausedFmt, file)
	case rs.HasMore && covered != "":
		return fmt.Sprintf(i18n.M.ReadStatusCoveredFmt, file, covered)
	case rs.HasMore:
		return fmt.Sprintf(i18n.M.ReadStatusReadingFmt, file)
	case covered != "":
		return fmt.Sprintf(i18n.M.ReadStatusDoneFmt, file, covered)
	default:
		return fmt.Sprintf(i18n.M.ReadStatusReadingFmt, file)
	}
}
