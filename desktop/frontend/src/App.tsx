import { useLayoutEffect, useMemo, useRef, useState, lazy, type CSSProperties } from "react";
import { useCommittedCommand } from "./lib/useCommittedCommand";
import { openExternal } from "./lib/bridge";
import { useT, useI18n, type Translator } from "./lib/i18n";
import { useToast } from "./lib/toast";
import { useGoalActionHandler } from "./lib/goalAction";
import { useActiveRemoteSession, type RemoteSessionApi } from "./lib/useRemoteSession";
import { useWarmTerminalPanel } from "./lib/useWarmTerminalPanel";
import { setReasoningDisplayPending } from "./lib/reasoningDisplayPreference";
import { type RestorableToolApprovalMode } from "./lib/toolApprovalMode";
import { type ComposerProfile, type UserPlanModeIntents } from "./lib/composerProfile";
import { type TabMeta } from "./lib/types";
import { type HistoryViewState } from "./app-runtime/historyViewProjection";
import { useNavigationSurface } from "./lib/useNavigationSurface";
import { projectNavigationSurfaceTarget } from "./app-runtime/conversationProjection";
import { useSessionOperations } from "./app-runtime/useSessionOperations";
import { createSessionSurfaceFence, sessionIdentityKey } from "./app-runtime/sessionTarget";
import { commitAppRenderToken, createAppRenderToken } from "./app-runtime/appLifecycleProbe";
import { useAppRuntimeAdapter } from "./app-runtime/useAppRuntimeAdapter";
import { useAppShellStores } from "./app-runtime/useAppShellStores";
import { useAppSessionComposition } from "./app-runtime/useAppSessionComposition";
import { useAppNavigationComposition } from "./app-runtime/useAppNavigationComposition";
import { useTopicTimeFilter, type TopicTimeFilter } from "./app-runtime/useLocalUiLifecycles";
import { ShellExpandProvider } from "./lib/shellExpand";
import { RemoteNavigationContext } from "./lib/remoteNavigationCommands";
import { UpdaterProvider } from "./lib/useUpdater";
import { type State } from "./lib/useController";
import { ShellHotkeys, TextSizeHotkeys } from "./app-shell/HotkeyRegistrations";
import { WindowChromeLifecycle } from "./app-runtime/WindowChromeLifecycle";
import { StartupGateLifecycle } from "./app-runtime/StartupGateLifecycle";
import { AppRuntimeEffects } from "./app-runtime/AppRuntimeEffects";
import { ThemeBackground } from "./components/ThemeBackground";
import { AppChrome } from "./components/AppChrome";
import { SidebarRegion } from "./app-shell/SidebarRegion";
import { TopicbarRegion } from "./app-shell/TopicbarRegion";
import { buildTopicbarView, TopicbarActionsStack } from "./app-shell/TopicbarActionsStack";
import { DockToggleButton } from "./app-shell/DockToggleButton";
import { SessionStatusBanners } from "./app-shell/SessionStatusBanners";
import { ChatPaneRegion } from "./app-shell/ChatPaneRegion";
import { DecisionFooterRegion } from "./app-shell/DecisionFooterRegion";
import { WorkspaceDockRegion } from "./app-shell/WorkspaceDockRegion";
import { AppBottomRegions } from "./app-shell/AppBottomRegions";
import { AppOverlayHost } from "./app-shell/AppOverlayHost";
import { buildAppShellClassNames, buildSessionStatusBannerProps, buildSidebarRegionProps } from "./app-shell/chromeRegionBuilders";
import { buildBottomRegionsProps, buildWorkspaceDockProps } from "./app-shell/dockRegionBuilders";
import { buildOverlayHostProps } from "./app-shell/overlayBuilders";
import { buildComposerSurface, buildDecisionFooterSurface, buildFooterTodo, buildFooterUndo } from "./app-shell/decisionFooterBuilders";


// Hold reasoning UI until the authoritative desktop startup settings arrive;
// this prevents a hidden preference from flashing content during first paint.
setReasoningDisplayPending();


/**
 * Composition root: owns the controller adapter, the session identity/fence,
 * the navigation surface and every store-backed state, then delegates all
 * command domains to the session/navigation compositions and the tree to the
 * shell view. Wiring only — no domain logic lives here.
 */
export default function App() {
  const appRenderToken = createAppRenderToken();
  useLayoutEffect(() => commitAppRenderToken(appRenderToken));
  const runtime = useAppRuntimeAdapter();
  const { state, liveStore, activeTabId, notice } = runtime.snapshot;
  const t = useT();
  const { locale } = useI18n();
  const { showToast } = useToast();
  const { runGoalAction, handleGoalActionError } = useGoalActionHandler();
  const [composerProfilesByTab, setComposerProfilesByTab] = useState<Record<string, ComposerProfile>>({});
  const yoloRestoreToolApprovalModesRef = useRef<Record<string, RestorableToolApprovalMode>>({});
  const userPlanModeByTabRef = useRef<UserPlanModeIntents>({});
  const [tabMetas, setTabMetas] = useState<TabMeta[]>([]);
  const [tabOrderIds, setTabOrderIds] = useState<string[]>([]);
  const activeTab = useMemo(
    () => tabMetas.find((tab) => tab.id === activeTabId) ?? tabMetas.find((tab) => tab.active),
    [activeTabId, tabMetas],
  );
  const { active: remoteSurfaceActive, session: remoteSession, ready: remoteComposerReady, onSend: remoteSend, onCancel: remoteCancel } = useActiveRemoteSession(activeTab, showToast);
  const activeSessionIdentity = sessionIdentityKey({
    tabId: activeTabId,
    sessionPath: activeTab?.sessionPath ?? state.meta?.sessionPath,
    sessionGeneration: activeTab?.sessionGeneration ?? state.meta?.sessionGeneration ?? state.sessionGen,
    scope: activeTab?.scope,
    workspaceRoot: activeTab?.workspaceRoot ?? state.meta?.cwd,
    topicId: activeTab?.topicId,
  });
  const sessionSurfaceFenceRef = useRef<ReturnType<typeof createSessionSurfaceFence> | null>(null);
  if (!sessionSurfaceFenceRef.current) sessionSurfaceFenceRef.current = createSessionSurfaceFence();
  const sessionSurfaceFence = sessionSurfaceFenceRef.current;
  const sessionOperations = useSessionOperations({
    visible: { tabId: activeTabId ?? "", sessionKey: activeSessionIdentity },
    resources: [
      { tabId: activeTabId ?? "", sessionKey: activeSessionIdentity },
      ...tabMetas.filter(tab => tab.id !== activeTabId).map(tab => ({
        tabId: tab.id,
        sessionKey: sessionIdentityKey({ tabId: tab.id, sessionPath: tab.sessionPath,
          sessionGeneration: tab.sessionGeneration, scope: tab.scope, workspaceRoot: tab.workspaceRoot, topicId: tab.topicId }),
      })),
    ],
  });
  useLayoutEffect(() => {
    sessionSurfaceFence.commit(activeTabId, activeSessionIdentity);
    return () => sessionSurfaceFence.dispose();
  }, [activeSessionIdentity, activeTabId, sessionSurfaceFence]);
  const navigationSurface = useNavigationSurface(projectNavigationSurfaceTarget({
    activeTabId, sessionKey: activeSessionIdentity, local: state, remote: remoteSurfaceActive ? remoteSession : undefined,
  }));
  const shell = useAppShellStores();
  const [tabRevealSignal, setTabRevealSignal] = useState(0);
  const [transcriptRevealSignal, setTranscriptRevealSignal] = useState(0);
  const [histView, setHistView] = useState<HistoryViewState | null>(null);
  const [sidebarImDetailConnectionId, setSidebarImDetailConnectionId] = useState("");
  const [topicTimeFilter, setTopicTimeFilter] = useTopicTimeFilter();
  const [tasksOpen, setTasksOpen] = useState<false | "session" | "all">(false);
  const workspaceScopeActiveTabRef = useRef(activeTabId);
  const [workspaceControllerEpoch, setWorkspaceControllerEpoch] = useState(0);
  workspaceScopeActiveTabRef.current = activeTabId;
  const { mounted: terminalContentVisible, fitEnabled: terminalFitEnabled, prefetch: prefetchTerminalPanel } = useWarmTerminalPanel(shell.terminalPanelOpen, shell.terminalResizing, !shell.managementActive);
  const [dockRefreshKey, setDockRefreshKey] = useState(0);
  const [fileRefRefreshKey, setFileRefRefreshKey] = useState(0);
  const refreshComposerFileRefs = useCommittedCommand(() => setFileRefRefreshKey((value) => value + 1));
  const composerFileRefRefreshKey = `${dockRefreshKey}:${fileRefRefreshKey}`;
  const [projectRevision, setProjectRevision] = useState(0);

  const session = useAppSessionComposition({
    runtime,
    t,
    showToast,
    shell,
    core: {
      state, liveStore, activeTabId, notice, activeTab, remoteSurfaceActive, remoteSession, remoteComposerReady,
      remoteSend, remoteCancel, activeSessionIdentity, sessionSurfaceFence, sessionOperations,
    },
    surface: navigationSurface,
    stores: {
      composerProfilesByTab, setComposerProfilesByTab, tabMetas, setTabMetas, tabOrderIds, setTabOrderIds,
      yoloRestoreToolApprovalModesRef, userPlanModeByTabRef,
    },
    local: {
      setHistView, setTabRevealSignal, setTranscriptRevealSignal,
      sidebarImDetailConnectionId, setSidebarImDetailConnectionId,
      workspaceScopeActiveTabRef, workspaceControllerEpoch, setWorkspaceControllerEpoch,
      dockRefreshKey, setDockRefreshKey, fileRefRefreshKey, setFileRefRefreshKey, projectRevision, setProjectRevision,
    },
    goal: { runGoalAction, handleGoalActionError },
  });
  const navigation = useAppNavigationComposition({
    runtime,
    t,
    notice,
    showToast,
    shell,
    state,
    activeTab,
    activeTabId,
    activeSessionIdentity,
    remoteSurfaceActive,
    surface: navigationSurface,
    local: {
      setHistView, setProjectRevision,
      setSidebarImDetailConnectionId, setTasksOpen,
    },
    session,
  });

  return (
    <AppRuntimeView
      core={{
        state, activeTab, activeTabId, liveStore, remoteSurfaceActive, remoteSession, remoteComposerReady,
        remoteCancel, surface: navigationSurface, t, locale, onOpenLink: openExternal,
      }}
      shell={shell}
      session={session}
      navigation={navigation}
      runtime={runtime}
      local={{
        tasksOpen, setTasksOpen, topicTimeFilter, setTopicTimeFilter,
        sidebarImDetailConnectionId, setSidebarImDetailConnectionId,
        tabRevealSignal, transcriptRevealSignal, histView,
        projectRevision, dockRefreshKey, composerFileRefRefreshKey, refreshComposerFileRefs,
        terminalContentVisible, terminalFitEnabled, prefetchTerminalPanel,
      }}
    />
  );
}


const WindowsWindowControls = lazy(() => import("./app-shell/WindowsWindowControls").then((module) => ({ default: module.WindowsWindowControls })));


const WORKSPACE_RESIZER_WIDTH = 8;

const SHOW_CONTEXT_DOCK = true;


type Runtime = ReturnType<typeof useAppRuntimeAdapter>;

type Shell = ReturnType<typeof useAppShellStores>;

type SessionComposition = ReturnType<typeof useAppSessionComposition>;

type NavigationComposition = ReturnType<typeof useAppNavigationComposition>;

type LiveStore = Runtime["snapshot"]["liveStore"];


export type AppRuntimeViewProps = {
  core: {
    state: State;
    activeTab: TabMeta | undefined;
    activeTabId: string | undefined;
    liveStore: LiveStore;
    remoteSurfaceActive: boolean;
    remoteSession: RemoteSessionApi;
    remoteComposerReady: boolean;
    remoteCancel: (queuedItemIDs?: string[]) => Promise<import("./lib/inboxCancel").CancelOutcome>;
    surface: ReturnType<typeof useNavigationSurface>;
    t: Translator;
    locale: string;
    onOpenLink: (url: string) => void;
  };
  shell: Shell;
  session: SessionComposition;
  navigation: NavigationComposition;
  runtime: Runtime;
  local: {
    tasksOpen: false | "session" | "all";
    setTasksOpen: React.Dispatch<React.SetStateAction<false | "session" | "all">>;
    topicTimeFilter: TopicTimeFilter;
    setTopicTimeFilter: (value: TopicTimeFilter) => void;
    sidebarImDetailConnectionId: string;
    setSidebarImDetailConnectionId: React.Dispatch<React.SetStateAction<string>>;
    tabRevealSignal: number;
    transcriptRevealSignal: number;
    histView: HistoryViewState | null;
    projectRevision: number;
    dockRefreshKey: number;
    composerFileRefRefreshKey: string;
    refreshComposerFileRefs: () => void;
    terminalContentVisible: boolean;
    terminalFitEnabled: boolean;
    prefetchTerminalPanel: () => void;
  };
};


/**
 * Pure assembly of the App shell tree: every region receives its props from
 * the session/navigation composition bags and the caller's stores. No hooks
 * beyond value memoization live here; ownership stays in the compositions.
 */
export function AppRuntimeView(props: AppRuntimeViewProps) {
  const { core, shell, session, navigation, runtime, local } = props;
  const { state, activeTab, activeTabId, t, locale } = core;
  const { sidebarWorkbench, sidebarCreation, windowsFramelessChrome, managementActive, mainWindowMaximised } = shell;
  const {
    conversationView, visibleRuntimeState, sidebarImDetailConnection,
    surfaceWorkspacePanelRenderable, surfaceWorkspacePanelGridOpen, surfaceWorkspacePanelOverlay, terminalSurfaceOpen,
    controllerReady, decisionSurface, visibleDecisionSurface, composerSurfaceHidden,
    shellGeometry, appRef, layoutRef, footerHeight, footerRef,
  } = session;
  const { chromeCommands, navigationCommands } = navigation;
  const runtimeTransitioning = core.surface.transitioning;
  const browserPreviewChrome = navigation.browserPreviewChrome;

  // Creation keeps the classic sidebar/chat structure while gating chrome tweaks
  // behind its own style flag so classic/workbench remain unchanged.
  const appChromeHidden = sidebarWorkbench || sidebarCreation;
  const workbenchChromeHidden = sidebarWorkbench;
  const sidebarClassName = [
    "sidebar",
    shell.sidebarCollapsed ? "sidebar--collapsed" : "",
    sidebarWorkbench ? "sidebar--workbench" : "",
  ].filter(Boolean).join(" ");
  const startupSplashHold = !activeTabId && state.meta?.ready !== true && !state.meta?.startupErr;

  const layoutStyle = useMemo(
    () =>
      ({
        "--sidebar-expanded-width": `${shellGeometry.sidebarRenderWidth}px`,
        "--chat-min-width": `${shellGeometry.chatReservedWidth}px`,
        "--workspace-width": `${shellGeometry.workspacePanelRenderWidth}px`,
        "--workspace-resizer-width": `${WORKSPACE_RESIZER_WIDTH}px`,
        "--terminal-height": `${terminalSurfaceOpen ? shell.liveTerminalHeight ?? shellGeometry.terminalRenderHeight : 0}px`,
      }) as CSSProperties,
    [shellGeometry.chatReservedWidth, shell.liveTerminalHeight, shellGeometry.sidebarRenderWidth, shellGeometry.terminalRenderHeight, terminalSurfaceOpen, shellGeometry.workspacePanelRenderWidth],
  );

  const shellClassNames = buildAppShellClassNames({
    platform: shell.desktopPlatform,
    windowsFrameless: windowsFramelessChrome,
    browserPreview: browserPreviewChrome,
    workbench: sidebarWorkbench,
    creation: sidebarCreation,
    imDetailActive: Boolean(sidebarImDetailConnection),
    sidebarCollapsed: shell.sidebarCollapsed,
    sidebarResizing: shell.sidebarResizing,
    dockGridOpen: surfaceWorkspacePanelGridOpen,
    dockOverlay: surfaceWorkspacePanelOverlay,
    terminalOpen: terminalSurfaceOpen,
    terminalResizing: shell.terminalResizing,
    dockOpen: shell.workspacePanelOpen,
    dockMaximized: shell.workspacePanelMaximized,
    dockResizing: shell.workspacePanelResizing,
  });
  const footerTodo = buildFooterTodo({
    show: session.todoPanel.showTodos,
    identity: session.todoPanel.scopedTodoBatch,
    todos: session.todoPanel.todos,
    running: visibleRuntimeState.running,
    pendingPrompt: visibleRuntimeState.pendingPrompt,
    continueReady: Boolean(activeTabId && !activeTab?.readOnly && (core.remoteSurfaceActive ? core.remoteComposerReady : controllerReady)),
    onContinue: session.todoPanel.handleTodoContinue,
    onDismiss: session.todoPanel.dismissTodos,
  });
  const footerUndo = buildFooterUndo({ rewindState: session.sessionUndo.rewindState, activeTabId, onUndo: session.sessionUndo.handleUndoRewind });
  const decisionFooterSurface = buildDecisionFooterSurface({
    view: {
      surface: visibleDecisionSurface,
      activeTabId,
      cwd: state.meta?.cwd,
      workspaceScopeKey: session.workspaceScopeKey,
      approval: state.approval,
      ask: state.ask,
      mcpInteraction: state.mcpInteraction,
      extensionForm: state.extensionForm,
      workspaceConflict: session.workspaceConflict,
      toolApprovalMode: session.profileProjection.toolApprovalMode,
      insertRequest: session.insertCommands.activePlanRevisionInsertRequest,
    },
    prompts: session.promptCommands,
    extension: session.extensionSurface,
    tabs: session.tabBarCommands,
    clear: session.clearCommands,
    onStop: () => void session.controlCommands.handleCancelActive(),
    cancelWorkspaceConflict: session.controlCommands.cancelWorkspaceConflict,
    onOpenLink: core.onOpenLink,
    onRevisionActiveChange: session.insertCommands.handleRevisionActiveChange,
    t,
  });

  return (
    <ShellExpandProvider>
    <RemoteNavigationContext.Provider value={session.desktopNavigation.openRemoteProject}>
    <UpdaterProvider>
    <ShellHotkeys />
    <TextSizeHotkeys />
    <WindowChromeLifecycle />
    <StartupGateLifecycle />
    <AppRuntimeEffects
      running={state.running}
      onEvent={session.runtimeEventCommands.handleRuntimeEvent}
      onReady={session.runtimeEventCommands.handleRuntimeReady}
      onRebuilt={session.runtimeEventCommands.handleRuntimeRebuilt}
      onRemoteStatus={session.runtimeEventCommands.handleRemoteStatus}
      onRemoteForwards={session.runtimeEventCommands.handleRemoteForwards}
      onRemoteServer={session.runtimeEventCommands.handleRemoteServer}
      onInitialRemoteHosts={session.runtimeEventCommands.handleInitialRemoteHosts}
      onInitialRemoteStatuses={session.runtimeEventCommands.handleInitialRemoteStatuses}
    />
      <div
        ref={appRef}
        onDoubleClickCapture={chromeCommands.handleChromeTitlebarDoubleClick}
        className={shellClassNames.app}
    >
      <ThemeBackground />
      {sidebarWorkbench && <div className="app__dock-toggle" inert={managementActive}><DockToggleButton renderable={surfaceWorkspacePanelRenderable} t={t} onToggle={session.workspacePanelCommands.toggleWorkspacePanel} /></div>}
      <div
        ref={layoutRef}
        className={shellClassNames.layout}
        style={layoutStyle}
      >
        {!appChromeHidden && (
          <AppChrome
            platform={shell.desktopPlatform}
            browserPreviewChrome={browserPreviewChrome}
            workbenchChrome={sidebarWorkbench}
            tabs={session.visibleTabs}
            activeTabId={session.visibleTabId}
            revealActiveSignal={local.tabRevealSignal}
            commandCompact={true}
            sidebarTogglePressed={shell.sidebarTogglePressed}
            sidebarExpandBlocked={navigation.sidebarExpandBlocked}
            sidebarCollapsed={shell.sidebarCollapsed}
            sidebarToggleTitle={navigation.sidebarToggleTitle}
            workspacePanelMaximized={shell.workspacePanelMaximized}
            workspacePanelRenderable={surfaceWorkspacePanelRenderable}
            workspacePanelLabel={surfaceWorkspacePanelRenderable ? t("rightDock.collapse") : t("rightDock.expand")}
            onToggleSidebar={shellGeometry.toggleSidebar}
            onToggleWorkspacePanel={session.workspacePanelCommands.toggleWorkspacePanel}
            onTabChange={(id) => void session.tabBarCommands.handleTabChange(id)}
            onTabClose={(id) => void session.tabBarCommands.handleTabClose(id)}
            onTabsClose={(ids, nextActiveTabId) => void session.tabBarCommands.handleTabsClose(ids, nextActiveTabId)}
            onTabsReorder={(ids) => void session.tabBarCommands.handleTabsReorder(ids)}
            onNewTab={() => void navigationCommands.handleNewTab()}
            onOpenPalette={() => void navigation.paletteCommands.openPalette()}
          />
        )}
        <a className="skip-to-composer" href="#composer-input">
          {t("shortcuts.skipToComposer")}
        </a>

        <SidebarRegion {...buildSidebarRegionProps({
          automation: shell.page.kind === "automation",
          className: sidebarClassName,
          toggleTitle: navigation.sidebarToggleTitle,
          shell,
          t,
          geometry: shellGeometry,
          projectTree: {
            activeTab, imTopicSources: shell.preferences.imTopicSources, refreshSignal: local.projectRevision,
            timeFilter: local.topicTimeFilter, onTimeFilterChange: local.setTopicTimeFilter,
            searchExpanded: !sidebarCreation || shell.sidebarSearchOpen, searchFocusSignal: shell.sidebarSearchFocusSignal,
            showShortcutBadges: navigation.topicShortcuts.showTopicBadges, shortcutPlatform: shell.desktopPlatform,
            onVisibleTopicsChange: navigation.topicShortcuts.handleVisibleTopicsChange,
          },
          topics: navigation.projectTopicCommands,
          commands: {
            onNewSession: () => void navigationCommands.handleNewTab(),
            onOpenTrash: () => void navigation.historyCommands.openTrash(),
            onOpenAutomation: () => shell.openPage({ kind: "automation" }),
            onOpenSettings: chromeCommands.openSidebarSettings,
            onToggleSearch: chromeCommands.toggleSidebarSearch,
            onToggle: shellGeometry.toggleSidebar,
            onOpenTopic: navigationCommands.handleOpenTopic,
          },
        })} />

        <section className={`chat-pane${session.transcript.creationEmptyHero ? " chat-pane--creation-empty" : ""}`}>
          <TopicbarRegion view={buildTopicbarView({
            t, locale, activeTab, cwd: state.meta?.cwd, imDetail: sidebarImDetailConnection, imTopicSources: shell.preferences.imTopicSources,
            creation: sidebarCreation, chromeHidden: workbenchChromeHidden, automationReturn: shell.automationReturn,
            sidebar: { title: navigation.sidebarToggleTitle, blocked: navigation.sidebarExpandBlocked, pressed: shell.sidebarTogglePressed, collapsed: shell.sidebarCollapsed },
            rename: { editing: navigation.projectTopicCommands.topicbarEditing, draft: navigation.projectTopicCommands.topicTitleDraft },
          })} commands={{
            openAutomation: () => shell.openPage({ kind: "automation" }), toggleSidebar: shellGeometry.toggleSidebar,
            setTitleDraft: navigation.projectTopicCommands.setTopicTitleDraft, commitRename: navigation.projectTopicCommands.commitActiveTopicRename, cancelRename: navigation.projectTopicCommands.cancelActiveTopicRename,
            startRename: navigation.projectTopicCommands.startActiveTopicRename, openWorktree: navigation.worktreeMergeCommands.openWorktreeMerge,
          }}>
            <TopicbarActionsStack
              t={t}
              paletteShortcut={navigation.commandPaletteShortcut}
              onOpenPalette={() => void navigation.paletteCommands.openPalette()}
              activeTab={activeTab}
              activeTabId={activeTabId}
              imDetailActive={Boolean(sidebarImDetailConnection)}
              dismissSignal={shell.transientOverlayDismissSignal}
              sessionHasContent={session.sessionHasContent}
              exportCommands={session.sessionExportCommands}
              terminal={{ toggle: session.terminalPanelCommands.toggleTerminalPanel, enabled: !core.remoteSurfaceActive, open: shell.terminalPanelOpen && !core.remoteSurfaceActive, prefetch: local.prefetchTerminalPanel }}
              tasksOpen={local.tasksOpen}
              setTasksOpen={local.setTasksOpen}
              onCloseTasks={() => local.setTasksOpen(false)}
              onOpenTaskSession={navigationCommands.openTaskMonitorSession}
              creation={sidebarCreation}
              dockToggle={<DockToggleButton renderable={surfaceWorkspacePanelRenderable} t={t} onToggle={session.workspacePanelCommands.toggleWorkspacePanel} />}
            />
          </TopicbarRegion>

          <SessionStatusBanners {...buildSessionStatusBannerProps({
            t,
            activeTab,
            leaseBlocked: session.leaseBlockedTab ? { tabId: session.leaseBlockedTab.id, message: session.leaseBlockedTab.runtime!.issue!.message } : null,
            meta: state.meta,
            configWarnings: shell.preferences.configLoadWarnings,
            dismissConfigWarnings: shell.preferences.dismissConfigWarnings,
            updateChecksEnabled: shell.preferences.startupUpdateChecksEnabled === true,
            shell,
            banners: session.bannerCommands,
            onboarding: navigation.onboardingCommands,
          })} />

          <ChatPaneRegion
            transitioning={runtimeTransitioning}
            t={t}
            imDetail={sidebarImDetailConnection ? {
              connection: sidebarImDetailConnection,
              onClose: () => local.setSidebarImDetailConnectionId(""),
              onOpenSettings: chromeCommands.openBotSettings,
              onManageAllowlist: chromeCommands.openBotAllowlistSettings,
              onOpenSession: (connection) => void navigationCommands.openSidebarImConnectionSession(connection),
            } : null}
            remote={activeTab?.remote ? { tab: activeTab, session: core.remoteSession } : undefined}
            transcript={{
              state,
              items: session.transcript.visibleTranscriptItems,
              tabId: session.transcript.visibleTranscriptTabId,
              geometrySessionKey: session.transcript.visibleTranscriptGeometryKey,
              footerHeight,
              revealSignal: local.transcriptRevealSignal,
              invocationMetadata: session.transcript.visibleTranscriptTabId ? session.invocation.invocationMetadataByTab[session.transcript.visibleTranscriptTabId] : undefined,
              surfaceCommitToken: core.surface.surfaceCommitToken,
              liveStore: core.liveStore,
              transcriptHydrating: session.transcript.transcriptHydrating,
              navigationDataReady: core.surface.dataReady,
              readOnly: Boolean(activeTab?.readOnly),
              controllerReady,
              hydratePlaceholderActive: session.hydratePlaceholderActive,
              clearContextPending: session.clearCommands.clearContextPending,
              creation: sidebarCreation,
              rewind: { stateActive: session.sessionUndo.rewindState != null, committing: session.sessionUndo.rewindCommitting, signal: session.sessionUndo.rewindSignal },
            }}
            onRetryHistory={() => void runtime.sessionActions.retrySessionHistory(activeTabId)}
            commands={{
              onPrompt: session.transcript.handleTranscriptPrompt,
              onDeliveryContinue: () => void session.delivery.handleDeliveryContinue(),
              onAcceptDelivery: session.controlCommands.handleAcceptDelivery,
              onOpenChanges: () => session.workspacePanelCommands.openRightDockMode("changed"),
              onOpenVerification: session.turnVerificationCommands.openTurnVerification,
              onEditPrompt: session.sessionUndo.handleEditPrompt,
              onRewind: session.sessionUndo.handleMessageAction,
              onLoadOlderHistory: session.transcript.handleLoadOlderHistory,
              onSurfacePaintReady: session.transcript.handleSurfacePaintReady,
            }}
          />

          <DecisionFooterRegion
            hidden={Boolean(sidebarImDetailConnection)}
            className={["footer", terminalSurfaceOpen && !sidebarCreation ? "footer--compact" : "", visibleDecisionSurface ? "footer--decision" : "", runtimeTransitioning ? "footer--navigation-hidden" : ""].filter(Boolean).join(" ")}
            footerRef={footerRef}
            style={core.surface.surface?.phase === "source-retained" && footerHeight > 0 ? { height: footerHeight, minHeight: footerHeight, boxSizing: "border-box" } : undefined}
            todo={footerTodo}
            undo={footerUndo}
            decision={decisionFooterSurface}
            composer={buildComposerSurface({
              view: {
                hidden: composerSurfaceHidden,
                inert: runtimeTransitioning,
                hero: session.transcript.creationEmptyHero,
                headline: t("welcome.creation.title"),
                remote: core.remoteSurfaceActive,
                rewindCommitting: session.sessionUndo.rewindCommitting,
                messageActionPending: state.messageAction != null,
                decisionActive: Boolean(decisionSurface),
                runtimeTransitioning,
                controllerReady,
                showContextWindowRing: sidebarCreation,
              },
              base: conversationView.composer,
              tab: activeTab,
              tabId: activeTabId,
              profile: session.profileProjection,
              router: session.routerCommands,
              modes: session.modeActions,
              goals: session.goalCommands,
              remoteGoal: session.remoteGoalActions,
              modelSwitch: session.controllerProfileCommands,
              inserts: session.insertCommands,
              control: session.controlCommands,
              remoteComposer: {
                send: session.remoteComposerSend,
                cancel: core.remoteCancel,
                ready: core.remoteComposerReady,
                profileReady: session.profileProjection.remoteComposerProfileReady,
                liveStore: core.remoteSession.liveStore,
              },
              localLiveStore: core.liveStore,
              onInvocationMetadataChange: session.invocation.handleInvocationMetadataChange,
              onCycleMode: session.cycleMode,
              transientDismissSignal: shell.transientOverlayDismissSignal,
              sessionKey: session.composerSessionKey,
              workspaceScopeKey: session.workspaceScopeKey,
              fileRefRefreshKey: local.composerFileRefRefreshKey,
              guidance: session.transcript.latestGuidanceConsumed,
              guidanceQueuePreviewItems: navigation.guidanceQueueMockItems,
            })}
          />
        </section>

        <WorkspaceDockRegion {...buildWorkspaceDockProps({
          surface: { renderable: surfaceWorkspacePanelRenderable, overlay: surfaceWorkspacePanelOverlay, gridOpen: surfaceWorkspacePanelGridOpen },
          creation: sidebarCreation,
          remoteAvailable: shell.remoteHosts.length > 0,
          showContext: SHOW_CONTEXT_DOCK,
          remote: core.remoteSurfaceActive,
          t,
          context: conversationView.context,
          sessionTurns: session.sessionTurns,
          contextRefreshKey: local.dockRefreshKey + visibleRuntimeState.contextPanelSeq,
          workspaceKey: session.workspaceTreeMemoryKey,
          workspaceScopeKey: session.workspaceScopeKey,
          mode: shell.rightDockMode,
          meta: state.meta,
          tabId: activeTabId,
          completionSummary: state.completionSummary,
          turnStartAt: state.turnStartAt,
          layout: { treeWidth: shell.rightDockTreeWidth, previewWidth: shell.rightDockPreviewWidth, maximized: shell.workspacePanelMaximized },
          geometry: shellGeometry,
          panels: session.workspacePanelCommands,
          inserts: session.insertCommands,
          verification: session.turnVerificationCommands,
          qualityFloor: session.profileProjection.composerProfile.qualityFloor,
          onFileTreeRefresh: local.refreshComposerFileRefs,
          onSessionRevertCommitted: session.sessionUndo.handleSessionRevertCommitted,
          onOpenInTerminal: core.remoteSurfaceActive ? undefined : session.terminalPanelCommands.openTerminalForPath,
        })} />
        <AppBottomRegions {...buildBottomRegionsProps({
          t,
          chatSurfaceVisible: session.chatSurfaceVisible,
          surfaceOpen: terminalSurfaceOpen,
          contentVisible: local.terminalContentVisible,
          remote: core.remoteSurfaceActive,
          readOnly: Boolean(activeTab?.readOnly),
          tabId: activeTabId,
          meta: state.meta,
          fitEnabled: local.terminalFitEnabled,
          liveTerminalHeight: shell.liveTerminalHeight,
          geometry: shellGeometry,
          terminal: {
            onClose: session.terminalPanelCommands.closeTerminalPanel,
            onAddOutput: (sessionId) => void session.insertCommands.addTerminalOutputToComposer(sessionId),
            onAddToChat: session.insertCommands.addTerminalSelectionToComposer,
          },
          status: !session.statusBarVisible ? undefined : {
            base: conversationView.status,
            rewindCommitting: session.sessionUndo.rewindCommitting,
            sessionTurns: session.sessionTurns,
            labelStyle: shell.preferences.statusBarStyle,
            items: shell.preferences.statusBarItems,
            extensionStatuses: session.extensionStatusList,
            remoteHosts: shell.remoteHosts,
            remoteStatuses: shell.remoteStatuses,
            onCancelJob: core.remoteSurfaceActive ? core.remoteSession.cancelJob : runtime.composer.cancelJob,
            onCancelRuntimeJob: session.controlCommands.cancelRuntimeJob,
            onRevealRuntime: session.tabBarCommands.revealBackgroundRuntime,
            onConnectRemote: session.remoteWorkspaceCommands.connectAndOpenRemoteWorkspace,
            onDisconnectRemote: session.controlCommands.handleDisconnectRemote,
            onManageRemote: () => shell.setSettingsTarget("remote"),
            onOpenRemote: shell.requestRemoteExplorer,
            onOpenRemoteWorkspace: session.remoteWorkspaceCommands.openRemoteWorkspaceFromStatus,
          },
        })} />
      </div>

      <AppOverlayHost {...buildOverlayHostProps({
        t,
        running: state.running,
        histView: local.histView,
        pageKind: shell.page.kind,
        activeTab,
        activeTabId,
        cwd: state.meta?.cwd,
        paletteItems: navigation.paletteCommands.paletteItems,
        startupSplashHold,
        selectionEnabled: Boolean(activeTabId && !activeTab?.readOnly && !decisionSurface && !sidebarImDetailConnection && !session.hydratePlaceholderActive),
        automationTopic: session.automation.openAutomationTopic,
        shell,
        history: navigation.historyCommands,
        navigation: navigationCommands,
        chrome: chromeCommands,
        onboarding: navigation.onboardingCommands,
        worktree: navigation.worktreeMergeCommands,
        onAddSelectedText: session.insertCommands.addSelectedTextToComposer,
        prefillSubagentCommand: session.insertCommands.prefillSubagentCommand,
        sessionActions: {
          previewSession: runtime.sessionActions.previewSession,
          listTrashedSessions: runtime.sessionActions.listTrashedSessions,
          restoreSession: runtime.sessionActions.restoreSession,
          purgeTrashedSession: runtime.sessionActions.purgeTrashedSession,
        },
        setSettingsTarget: shell.setSettingsTarget,
      })} />
      {windowsFramelessChrome && (
        <WindowsWindowControls
          maximised={mainWindowMaximised}
          onMinimize={chromeCommands.minimizeMainWindow}
          onToggleMaximize={chromeCommands.toggleMainWindowMaximized}
          onClose={chromeCommands.closeMainWindow}
        />
      )}
    </div>
    </UpdaterProvider>
    </RemoteNavigationContext.Provider>
    </ShellExpandProvider>
  );
}