// TabBar is the dock's header row. It keeps the upstream workbench-dock
// chrome (a draggable tools strip + the rounded tab capsule) so the header
// height and tab styling match the original; the only addition is a per-tab
// close button and a + button that opens the add-tab menu.
//
// File tabs mirror the workspace panel's current preview: a single tab whose
// label shows the open file's name (or 文件 while no file is selected). Every
// tab carries a leading type icon so the view kind is recognizable at a
// glance.
//
// File tabs also get a context menu (VS Code style): open with the default
// app or a listed opener, save as, copy path / content, reveal in Finder,
// plus close / close-others / close-to-right. The file operations go through
// the workspace-scoped bridge methods, so they need the active session tab id.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, FileDiff, FileText, Plus, X } from "lucide-react";
import type { ComponentType, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { WorkspaceFileIcon } from "../WorkspaceFileIcon";
import { app } from "../../lib/bridge";
import { writeClipboardText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { useToast } from "../../lib/toast";
import type { ExternalOpenersView } from "../../lib/types";
import type { TabItem } from "../../store/activityBar";
import { ContextMenu, contextMenuPointFromEvent, type ContextMenuItem, type ContextMenuPoint } from "../ContextMenu";
import { useDockTabDrag } from "../../lib/useDockTabDrag";
import { TabOverviewMenu } from "./TabOverviewMenu";

// Type icon map: every tab type gets a leading icon so the tab kind is
// identifiable (mirrors the launcher's icon assignment).
const TAB_TYPE_ICONS: Record<string, ComponentType<{ size?: number | string }>> = {
  file: FileText,
  changed: FileDiff,
  context: Activity,
  remote: FileText,
  browser: FileText,
};

function localPathErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onMoveTab: (fromId: string, toId: string, side: "left" | "right") => void;
  onAdd: () => void;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  /** Active session tab id — required for workspace-scoped file operations. */
  workspaceTabId?: string;
}

export function TabBar({ tabs, activeTabId, onActivate, onClose, onMoveTab, onAdd, addButtonRef, workspaceTabId }: TabBarProps) {
  const t = useT();
  const { showToast } = useToast();
  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [menuPoint, setMenuPoint] = useState<ContextMenuPoint | null>(null);
  const [openers, setOpeners] = useState<ExternalOpenersView>({ openers: [], preferred: "" });
  const {
    draggingTabId, dragElRefs, floatingRef, tabsRef, tabsOverflow, suppressClickRef, startTabDrag, clearDragState, ghost, slotWidthFor,
  } = useDockTabDrag({ tabs, onActivate, onMoveTab });

  const openerRequestRef = useRef(0);
  const mountedRef = useRef(true);

  // React StrictMode replays mount effects in development; reset the guard so
  // the replayed mount can still accept opener discoveries.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openerRequestRef.current += 1;
    };
  }, []);

  const closeMenu = useCallback(() => {
    setMenuTabId(null);
    setMenuPoint(null);
  }, []);

  const refreshOpeners = useCallback(() => {
    if (!workspaceTabId) return;
    const request = ++openerRequestRef.current;
    void app.ExternalOpenersForTab(workspaceTabId).then((next) => {
      if (!mountedRef.current || request !== openerRequestRef.current) return;
      setOpeners({
        openers: Array.isArray(next.openers) ? next.openers : [],
        preferred: next.preferred ?? "",
      });
    }).catch(() => {});
  }, [workspaceTabId]);

  const openFileTabMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>, tab: TabItem) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuTabId(tab.id);
    setMenuPoint(contextMenuPointFromEvent(event));
    refreshOpeners();
  }, [refreshOpeners]);

  const menuTabIndex = menuTabId ? tabs.findIndex((tab) => tab.id === menuTabId) : -1;  const menuTab = menuTabId ? tabs.find((tab) => tab.id === menuTabId) ?? null : null;
  const menuPath = typeof menuTab?.meta?.path === "string" ? menuTab.meta.path : null;

  const closeThen = useCallback((action: () => void) => {
    closeMenu();
    action();
  }, [closeMenu]);

  const openWith = useCallback((openerId: string, openerName: string) => {
    if (!workspaceTabId || !menuPath) return;
    closeThen(() => {
      void app.OpenWorkspaceInExternalOpenerForTab(workspaceTabId, openerId).catch((error) => {
        showToast(t("externalOpener.failed", { name: openerName, error: localPathErrorText(error) }), "error");
      });
    });
  }, [closeThen, menuPath, showToast, t, workspaceTabId]);

  const menuItems = useCallback((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (menuPath && workspaceTabId) {
      const openerItems: ContextMenuItem[] = openers.openers.filter((opener) => opener.kind !== "file-manager").map((opener) => ({
        key: `open-with-${opener.id}`,
        label: t("externalOpener.openIn", { name: opener.name }),
        onSelect: () => openWith(opener.id, opener.name),
      }));
      items.push(
        {
          key: "open-default",
          label: t("externalOpener.openDefault"),
          onSelect: () => closeThen(() => {
            void app.OpenWorkspacePathForTab(workspaceTabId, menuPath).catch((error) => {
              showToast(t("externalOpener.failed", { name: t("externalOpener.openDefault"), error: localPathErrorText(error) }), "error");
            });
          }),
        },
        ...(openerItems.length > 0
          ? [{
              key: "open-with",
              label: t("externalOpener.openWith"),
              children: openerItems,
            }]
          : []),
        { type: "separator" as const, key: "file-actions-separator" },
        {
          key: "reveal",
          label: t("workspace.revealInFileManager"),
          onSelect: () => closeThen(() => {
            void app.RevealWorkspacePathForTab(workspaceTabId, menuPath).catch((error) => {
              showToast(t("externalOpener.failed", { name: t("workspace.revealInFileManager"), error: localPathErrorText(error) }), "error");
            });
          }),
        },
        {
          key: "save-as",
          label: t("externalOpener.saveAs"),
          onSelect: () => closeThen(() => {
            void app.ResolveWorkspacePathForTab(workspaceTabId, menuPath)
              .then((absolutePath) => app.SaveLocalPathAs(absolutePath))
              .then((savedPath) => {
                if (savedPath) showToast(t("externalOpener.saved", { path: savedPath }), "info");
              })
              .catch((error) => {
                showToast(t("externalOpener.failed", { name: t("externalOpener.saveAs"), error: localPathErrorText(error) }), "error");
              });
          }),
        },
        {
          key: "copy-relative-path",
          label: t("workspace.copyRelativePath"),
          onSelect: () => closeThen(() => { void writeClipboardText(menuPath); }),
        },
        {
          key: "copy-absolute-path",
          label: t("workspace.copyAbsolutePath"),
          onSelect: () => closeThen(() => {
            void app.ResolveWorkspacePathForTab(workspaceTabId, menuPath).then((absolutePath) => {
              if (absolutePath) void writeClipboardText(absolutePath);
            }).catch(() => {});
          }),
        },
        {
          key: "copy-content",
          label: t("workspace.copyFileContent"),
          onSelect: () => closeThen(() => {
            void app.ReadFileForTab(workspaceTabId, menuPath).then((preview) => {
              if (preview?.body) {
                void writeClipboardText(preview.body);
                showToast(t("workspace.fileContentCopied"), "info");
              }
            }).catch((error) => {
              showToast(t("externalOpener.failed", { name: t("workspace.copyFileContent"), error: localPathErrorText(error) }), "error");
            });
          }),
        },
        { type: "separator" as const, key: "tab-actions-separator" },
      );
    }
    items.push(
      {
        key: "close-current",
        label: t("tabBar.closeTab"),
        disabled: tabs.length <= 1,
        onSelect: () => closeThen(() => { if (menuTabId) onClose(menuTabId); }),
      },
      {
        key: "close-others",
        label: t("tabBar.closeOtherTabs"),
        disabled: tabs.length <= 1,
        onSelect: () => closeThen(() => {
          if (!menuTabId) return;
          tabs.filter((tab) => tab.id !== menuTabId).forEach((tab) => onClose(tab.id));
          onActivate(menuTabId);
        }),
      },
      {
        key: "close-right",
        label: t("tabBar.closeTabsToRight"),
        disabled: menuTabIndex < 0 || menuTabIndex >= tabs.length - 1,
        onSelect: () => closeThen(() => {
          if (menuTabIndex < 0) return;
          tabs.slice(menuTabIndex + 1).forEach((tab) => onClose(tab.id));
          onActivate(menuTabId ?? tabs[menuTabIndex].id);
        }),
      },
    );
    return items;
  }, [closeThen, menuPath, menuTabId, menuTabIndex, onActivate, onClose, openWith, openers.openers, showToast, t, tabs, workspaceTabId]);

  return (
    <div className="workbench-dock__tools">
      <TabOverviewMenu />
      <div
        ref={tabsRef}
        className={["workbench-dock__tabs", tabsOverflow ? "workbench-dock__tabs--overflow" : ""].filter(Boolean).join(" ")}
        role="tablist"
        aria-label={t("rightDock.views")}
      >
        {/* Tabs render in store order (insertion order), so a newly added file
            tab appears at the end. File tabs carry the context menu; file
            tabs with a preview path show the file name, ones without show
            文件 (the file-list view awaiting a selection). */}
        {tabs.map((tab) => {
          const TabIcon = TAB_TYPE_ICONS[tab.type] ?? FileText;
          const active = tab.id === activeTabId;
          const dragging = draggingTabId === tab.id;
          if (dragging) {
            const slotWidth = slotWidthFor(tab.id);
            return (
              <div
                key={tab.id}
                className="workbench-dock__tab-slot"
                style={{ width: slotWidth }}
                aria-hidden="true"
              />
            );
          }
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) dragElRefs.current.set(tab.id, node);
                else dragElRefs.current.delete(tab.id);
              }}
              role="tab"
              aria-selected={active}
              aria-label={tab.label}
              className={[
                "workbench-dock__tab",
                active ? "workbench-dock__tab--active" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onActivate(tab.id);
              }}
              onContextMenu={tab.type === "file" ? (event) => openFileTabMenu(event, tab) : undefined}
              onPointerDown={(event) => startTabDrag(event, tab.id)}
            >
              {tab.type === "file" ? (
                <WorkspaceFileIcon fileName={tab.label} />
              ) : (
                <TabIcon size={13} />
              )}
              <span className="workbench-dock__tab-label">{tab.label}</span>
              <button
                type="button"
                className="workbench-dock__tab-close"
                aria-label={t("rightDock.closeTab")}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        ref={addButtonRef}
        type="button"
        className="workbench-dock__tab-add"
        aria-label={t("rightDock.addTab")}
        onClick={onAdd}
      >
        <Plus size={14} />
      </button>
      {draggingTabId !== null && (() => {
        const draggedTab = tabs.find((tab) => tab.id === draggingTabId);
        if (!draggedTab) return null;
        const FloatIcon = TAB_TYPE_ICONS[draggedTab.type] ?? FileText;
        return createPortal(
          <div
            ref={floatingRef}
            className={[
              "workbench-dock__tab",
              "workbench-dock__tab--floating",
              draggedTab.id === activeTabId ? "workbench-dock__tab--active" : "",
            ].filter(Boolean).join(" ")}
            role="presentation"
            style={{ left: ghost.left, top: ghost.top, width: ghost.width }}
          >
            {draggedTab.type === "file" ? (
              <WorkspaceFileIcon fileName={draggedTab.label} />
            ) : (
              <FloatIcon size={13} />
            )}
            <span className="workbench-dock__tab-label">{draggedTab.label}</span>
            {/* Keep the whole tab (including its close button) in the drag
                ghost so it looks like the tab itself is being dragged. */}
            <button
              type="button"
              className="workbench-dock__tab-close"
              aria-label={t("rightDock.closeTab")}
              onClick={(event) => {
                event.stopPropagation();
                clearDragState();
                onClose(draggedTab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>,
          document.body,
        );
      })()}
      <ContextMenu
        open={menuPoint !== null}
        point={menuPoint}
        items={menuItems()}
        onClose={closeMenu}
        ariaLabel={t("rightDock.fileTabMenu")}
      />
    </div>
  );
}
