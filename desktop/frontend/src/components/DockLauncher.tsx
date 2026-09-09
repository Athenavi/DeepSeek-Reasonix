// DockLauncher is the floating card shown over the transcript's top-right
// corner while the right dock is collapsed. It lists the dock's entry points
// (overview / files / changed); clicking one expands the dock to that tab.
// Once the dock is open the card is replaced by it, so the menu only ever
// appears in the collapsed state.
//
// The interaction logic lives in lib/ hooks — useDockLauncherSpace (space
// yield), useWorkspaceDiffStats (changed-row totals) and useBranchSwitcher
// (branch row, list, checkout, create) — leaving this file as the view.
// The branch row opens a switcher modelled on the ChatGPT reference: a search
// input filters the branch list, and a pinned bottom action creates and checks
// out a new branch from whatever is typed.

import { useRef } from "react";
import { Activity, Check, ChevronRight, FileDiff, FileText, GitBranch, Plus, Search } from "lucide-react";
import type { ComponentType } from "react";
import { useT } from "../lib/i18n";
import { availableDockEntries } from "../lib/dockEntries";
import { desktopHost } from "../lib/desktopHost";
import type { SpaceMode } from "../lib/launcherCardState";
import { useBranchSwitcher } from "../lib/useBranchSwitcher";
import { useDockLauncherSpace } from "../lib/useDockLauncherSpace";
import { useWorkspaceDiffStats } from "../lib/useWorkspaceDiffStats";
import type { TabType } from "../store/activityBar";

const ENTRY_ICONS: Record<TabType, ComponentType<{ size?: number | string; className?: string }>> = {
  file: FileText,
  changed: FileDiff,
  context: Activity,
  remote: FileText,
  browser: FileText,
};

interface DockLauncherProps {
  onSelect: (entryId: string) => void;
  /** Current git branch for the active workspace; omitted when unknown. */
  gitBranch?: string;
  /** Reports the space-yield mode whenever it changes, so the App-level
   *  launcher toggle can mirror whether the card is actually on screen. */
  onSpaceModeChange?: (mode: SpaceMode) => void;
}

export function DockLauncher({ onSelect, gitBranch, onSpaceModeChange }: DockLauncherProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const spaceMode = useDockLauncherSpace(rootRef, onSpaceModeChange);
  const { diffStats, reloadDiffStats } = useWorkspaceDiffStats(gitBranch);
  const branch = useBranchSwitcher({ gitBranch, rootRef, onBranchChanged: reloadDiffStats });

  // The changed entry is git-derived (git status / diff), so it is only shown
  // when the active workspace is a git repo; the branch row below is gated the
  // same way via activeBranch.
  const isGitProject = Boolean(gitBranch);
  const entries = availableDockEntries(desktopHost().browser !== undefined)
    .filter((entry) => entry.id !== "changed" || isGitProject);
  const showDiffStats = (diffStats?.added ?? 0) + (diffStats?.removed ?? 0) > 0;

  if (spaceMode === "hidden") return null;

  return (
    <div
      ref={rootRef}
      className="dock-launcher"
      role="toolbar"
      aria-label={t("rightDock.launcher")}
    >
      <div className="dock-launcher__header">{t("rightDock.launcherTitle")}</div>
      {entries.map((entry) => {
        const Icon = ENTRY_ICONS[entry.defaultTab];
        const isChanged = entry.id === "changed";
        return (
          <button
            key={entry.id}
            type="button"
            className="dock-launcher__entry"
            aria-label={t(entry.labelKey as never)}
            onClick={() => onSelect(entry.id)}
          >
            <Icon size={16} />
            <span className="dock-launcher__entry-label">{t(entry.labelKey as never)}</span>
            {isChanged && diffStats && showDiffStats ? (
              <span className="dock-launcher__entry-stats">
                <span className="dock-launcher__entry-stats-added">+{diffStats.added.toLocaleString()}</span>
                <span className="dock-launcher__entry-stats-removed">-{diffStats.removed.toLocaleString()}</span>
              </span>
            ) : null}
            <ChevronRight size={14} className="dock-launcher__entry-chevron" />
          </button>
        );
      })}
      {branch.activeBranch ? (
        <div className="dock-launcher__branch-wrap">
          <button
            type="button"
            className={`dock-launcher__entry${branch.branchMenuOpen ? " dock-launcher__entry--open" : ""}`}
            aria-label={`${t("status.gitBranchTitle")}: ${branch.activeBranch}`}
            aria-expanded={branch.branchMenuOpen}
            title={`${t("status.gitBranchTitle")}: ${branch.activeBranch}`}
            onClick={branch.toggleBranchMenu}
          >
            <GitBranch size={16} />
            <span className="dock-launcher__entry-label">{branch.activeBranch}</span>
            <ChevronRight size={14} className="dock-launcher__entry-chevron dock-launcher__entry-chevron--down" />
          </button>
          {branch.branchMenuOpen ? (
            <div className="dock-launcher__branch-menu" role="menu" aria-label={t("rightDock.switchBranch")}>
              <div className="dock-launcher__branch-search">
                <Search size={13} />
                <input
                  ref={branch.branchSearchRef}
                  type="text"
                  value={branch.branchQuery}
                  placeholder={t("rightDock.branchSearchPlaceholder")}
                  onChange={(event) => {
                    branch.setBranchQuery(event.target.value);
                    branch.setBranchSwitchErr("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    if (branch.exactMatch) void branch.checkoutBranch(branch.trimmedQuery);
                    else if (branch.canCreate) void branch.createBranch(branch.trimmedQuery);
                  }}
                />
              </div>
              <div className="dock-launcher__branch-section">{t("rightDock.branchSection")}</div>
              <div className="dock-launcher__branch-list">
                {branch.branchesLoading ? <div className="dock-launcher__branch-menu-note">{t("rightDock.branchMenuLoading")}</div> : null}
                {!branch.branchesLoading && branch.branchesErr ? <div className="dock-launcher__branch-menu-note dock-launcher__branch-menu-note--err">{branch.branchesErr}</div> : null}
                {!branch.branchesLoading && !branch.branchesErr && branch.filteredBranches.length === 0 ? (
                  <div className="dock-launcher__branch-menu-note">{t("rightDock.branchNoMatch")}</div>
                ) : null}
                {branch.filteredBranches.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="menuitem"
                    className={`dock-launcher__branch-item${name === branch.activeBranch ? " dock-launcher__branch-item--active" : ""}`}
                    title={name}
                    disabled={branch.switchingBranch !== ""}
                    onClick={() => void branch.checkoutBranch(name)}
                  >
                    <GitBranch size={14} />
                    <span className="dock-launcher__branch-item-name">{name}</span>
                    {branch.switchingBranch === name ? (
                      <span className="dock-launcher__branch-menu-spinner" aria-hidden="true" />
                    ) : name === branch.activeBranch ? (
                      <Check size={14} />
                    ) : null}
                  </button>
                ))}
              </div>
              {branch.branchSwitchErr ? <div className="dock-launcher__branch-menu-note dock-launcher__branch-menu-note--err">{branch.branchSwitchErr}</div> : null}
              <div className="dock-launcher__branch-create">
                <button
                  type="button"
                  role="menuitem"
                  className="dock-launcher__branch-item dock-launcher__branch-item--create"
                  disabled={!branch.canCreate || branch.switchingBranch !== ""}
                  title={branch.canCreate ? branch.trimmedQuery : undefined}
                  onClick={() => void branch.createBranch(branch.trimmedQuery)}
                >
                  {branch.switchingBranch === branch.trimmedQuery ? (
                    <span className="dock-launcher__branch-menu-spinner" aria-hidden="true" />
                  ) : (
                    <Plus size={14} />
                  )}
                  <span className="dock-launcher__branch-item-name">
                    {t("rightDock.branchCreate")}
                    {branch.trimmedQuery ? ` ${branch.trimmedQuery}` : ""}
                  </span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
