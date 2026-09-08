// desktopHost is the only module allowed to touch the shell globals: Electron's
// window.reasonixDesktop (preload) and Wails' window.go / window.runtime.
// scripts/check-desktop-host-boundary.mjs enforces that boundary.
import type { AppBindings } from "./bridge";
import type { DesktopBrowserHost } from "./browserHost";
import { dataTransferLooksLikeFileDrag, installWailsNonFileDragErrorSuppression } from "./wailsDragErrors";

export type DesktopHostKind = "electron" | "wails" | "none";
export type WindowTheme = "system" | "light" | "dark";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximised: boolean;
}

export interface ServiceState {
  phase: "starting" | "ready" | "restarting" | "failed" | "exited";
  generation: string;
  error?: string;
}

// Mirrors docs/DESKTOP_HOST_PROTOCOL.md "Renderer preload API".
export interface ReasonixDesktopHost {
  readonly kind: "electron";
  readonly contract: { protocolVersion: number; digest: string; commands: readonly string[] };
  readonly platform: { os: "darwin" | "windows" | "linux"; arch: string; versions: Record<string, string> };
  invoke(method: string, args: unknown[]): Promise<unknown>;
  on(name: string, cb: (...args: unknown[]) => void): () => void;
  native: {
    openExternal(url: string): Promise<void>;
    clipboard: { writeText(text: string): Promise<boolean>; readText(): Promise<string> };
    window: {
      setTheme(theme: WindowTheme): void;
      setBackgroundColour(r: number, g: number, b: number, a: number): void;
      getBounds(): Promise<WindowBounds>;
      isMaximised(): Promise<boolean>;
      minimise(): void;
      toggleMaximise(): void;
      close(): void;
    };
    getPathForFile(file: File): string;
    onServiceState(cb: (state: ServiceState) => void): () => void;
  };
  browser: DesktopBrowserHost;
}

interface WailsRuntime {
  EventsOn(name: string, cb: (...data: unknown[]) => void): () => void;
  BrowserOpenURL(url: string): void;
  WindowSetSystemDefaultTheme?(): void;
  WindowSetLightTheme?(): void;
  WindowSetDarkTheme?(): void;
  WindowSetBackgroundColour?(r: number, g: number, b: number, a: number): void;
  WindowGetSize?(): Promise<{ w: number; h: number }>;
  WindowGetPosition?(): Promise<{ x: number; y: number }>;
  WindowIsMaximised?(): Promise<boolean>;
  ClipboardSetText?(text: string): Promise<boolean>;
  ClipboardGetText?(): Promise<string>;
  OnFileDrop?(cb: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
  OnFileDropOff?(): void;
}

declare global {
  interface Window {
    runtime?: WailsRuntime;
    go?: { main?: { App?: AppBindings } };
    reasonixDesktop?: ReasonixDesktopHost;
  }
}

export interface DesktopHost {
  kind: DesktopHostKind;
  app: AppBindings | undefined;
  events: { on(name: string, cb: (...args: unknown[]) => void): () => void };
  native: {
    openExternal(url: string): void;
    clipboardWriteText(text: string): Promise<boolean>;
    clipboardReadText(): Promise<string>;
    setWindowTheme(theme: WindowTheme): void;
    setWindowBackground(r: number, g: number, b: number, a: number): void;
    getWindowBounds(): Promise<WindowBounds> | undefined;
    onFilesDropped(cb: (paths: string[]) => void): () => void;
    getPathForFile?(file: File): string;
    onServiceState(cb: (state: ServiceState) => void): () => void;
  };
  /** Native website views; only the Electron shell provides them. */
  browser?: DesktopBrowserHost;
}

const noop = () => {};
const win = () => (typeof window === "undefined" ? undefined : window);
const wailsRuntime = () => win()?.runtime;

// One object serves the Wails shell and the bare browser: every runtime call
// degrades to a no-op when window.runtime is absent, and a bound App without
// its runtime is the test seam (real commands, mocked events and native calls).
const wailsLikeHost = (kind: "wails" | "none"): DesktopHost => ({
  kind,
  get app() {
    return win()?.go?.main?.App;
  },
  events: { on: (name, cb) => wailsRuntime()?.EventsOn(name, cb) ?? noop },
  native: {
    openExternal: (url) => {
      const rt = wailsRuntime();
      if (rt?.BrowserOpenURL) rt.BrowserOpenURL(url);
      else win()?.open(url, "_blank", "noopener");
    },
    clipboardWriteText: async (text) => (await wailsRuntime()?.ClipboardSetText?.(text)) === true,
    clipboardReadText: async () => (await wailsRuntime()?.ClipboardGetText?.()) ?? "",
    setWindowTheme: (theme) => {
      const rt = wailsRuntime();
      if (theme === "system") rt?.WindowSetSystemDefaultTheme?.();
      else if (theme === "light") rt?.WindowSetLightTheme?.();
      else rt?.WindowSetDarkTheme?.();
    },
    setWindowBackground: (r, g, b, a) => wailsRuntime()?.WindowSetBackgroundColour?.(r, g, b, a),
    getWindowBounds: () => {
      const rt = wailsRuntime();
      if (!rt?.WindowGetSize || !rt.WindowGetPosition || !rt.WindowIsMaximised) return undefined;
      return Promise.all([rt.WindowGetSize(), rt.WindowGetPosition(), rt.WindowIsMaximised()])
        .then(([size, pos, maximised]) => ({ x: pos.x, y: pos.y, width: size.w, height: size.h, maximised }));
    },
    onFilesDropped: (cb) => {
      const rt = wailsRuntime();
      if (!rt?.OnFileDrop) return noop;
      // Wails' ResolveFilePaths throws on non-file drags (e.g. the window icon);
      // the suppression keeps that from surfacing as an app crash.
      const uninstall = installWailsNonFileDragErrorSuppression();
      rt.OnFileDrop((_x, _y, paths) => {
        if (Array.isArray(paths) && paths.length > 0) cb(paths);
      }, true);
      return () => {
        rt.OnFileDropOff?.();
        uninstall();
      };
    },
    onServiceState: () => noop,
  },
});

const serverHost = wailsLikeHost("none");
const wailsHost = wailsLikeHost("wails");
let electronHost: DesktopHost | undefined;
let electronHostFor: ReasonixDesktopHost | undefined;
const dropListeners = new Set<(paths: string[]) => void>();
let dropHandlersInstalled = false;

const insideDropTarget = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-native-drop-target]") !== null;

// Chromium hands the renderer real File objects; paths come from the preload.
const installElectronDropHandlers = (host: ReasonixDesktopHost) => {
  if (dropHandlersInstalled) return;
  dropHandlersInstalled = true;
  document.addEventListener("dragover", (e) => {
    if (!dataTransferLooksLikeFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (!insideDropTarget(e.target) && e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  document.addEventListener("drop", (e) => {
    if (!dataTransferLooksLikeFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (!insideDropTarget(e.target) || !e.dataTransfer) return;
    const paths = Array.from(e.dataTransfer.files).map((file) => host.native.getPathForFile(file)).filter((path) => path !== "");
    if (paths.length > 0) for (const cb of [...dropListeners]) cb(paths);
  });
};

const electronHostFrom = (host: ReasonixDesktopHost): DesktopHost => {
  if (electronHost && electronHostFor === host) return electronHost;
  const commands = new Set(host.contract.commands);
  electronHostFor = host;
  electronHost = {
    kind: "electron",
    app: new Proxy({} as AppBindings, {
      get: (_target, prop) =>
        typeof prop === "string" && commands.has(prop) ? (...args: unknown[]) => host.invoke(prop, args) : undefined,
    }),
    events: { on: (name, cb) => host.on(name, cb) },
    native: {
      openExternal: (url) => void host.native.openExternal(url).catch((err: unknown) => console.warn("openExternal failed", err)),
      clipboardWriteText: (text) => host.native.clipboard.writeText(text),
      clipboardReadText: () => host.native.clipboard.readText(),
      setWindowTheme: (theme) => host.native.window.setTheme(theme),
      setWindowBackground: (r, g, b, a) => host.native.window.setBackgroundColour(r, g, b, a),
      getWindowBounds: () => host.native.window.getBounds(),
      onFilesDropped: (cb) => {
        installElectronDropHandlers(host);
        dropListeners.add(cb);
        return () => {
          dropListeners.delete(cb);
        };
      },
      getPathForFile: (file) => host.native.getPathForFile(file),
      onServiceState: (cb) => host.native.onServiceState(cb),
    },
    browser: host.browser,
  };
  return electronHost;
};

// Resolved at call time, never cached by callers: Wails can inject window.go
// after this module first evaluates, and the browser dev mock must only win
// when no shell is present.
export function desktopHost(): DesktopHost {
  if (typeof window === "undefined") return serverHost;
  const electron = window.reasonixDesktop;
  if (electron) return electronHostFrom(electron);
  return window.go?.main?.App && window.runtime ? wailsHost : serverHost;
}
