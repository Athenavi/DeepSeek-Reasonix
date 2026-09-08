import { contextBridge, ipcRenderer, webUtils } from "electron";
import { hostOS, IPC, type ContractInfo, type EventFrame, type IpcResult, type ServiceState, type WindowTheme } from "../shared/ipc.js";

type Listener = (...args: unknown[]) => void;

function isResult(value: unknown): value is IpcResult {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean";
}

function unwrap(value: unknown): unknown {
  if (!isResult(value)) throw new Error("malformed reply from the desktop shell");
  if (value.ok) return value.value;
  throw new Error(value.message);
}

async function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return unwrap(await ipcRenderer.invoke(channel, ...args));
}

function fire(channel: string, ...args: unknown[]): void {
  void call(channel, ...args).catch((error: unknown) => console.warn(`[reasonixDesktop] ${channel} failed`, error));
}

function readContract(): ContractInfo {
  const raw = ipcRenderer.sendSync(IPC.contract) as unknown;
  if (typeof raw !== "object" || raw === null) return { protocolVersion: 1, digest: "", commands: Object.freeze([]) };
  const record = raw as { protocolVersion?: unknown; digest?: unknown; commands?: unknown };
  const commands = Array.isArray(record.commands) ? record.commands.filter((name): name is string => typeof name === "string") : [];
  return Object.freeze({
    protocolVersion: typeof record.protocolVersion === "number" ? record.protocolVersion : 1,
    digest: typeof record.digest === "string" ? record.digest : "",
    commands: Object.freeze(commands),
  });
}

const listeners = new Map<string, Set<Listener>>();
let eventsBound = false;

function bindEvents(): void {
  if (eventsBound) return;
  eventsBound = true;
  ipcRenderer.on(IPC.event, (_event, frame: unknown) => {
    const { name, args } = (frame ?? {}) as Partial<EventFrame>;
    if (typeof name !== "string") return;
    const set = listeners.get(name);
    if (!set) return;
    const payload = Array.isArray(args) ? args : [];
    for (const listener of [...set]) {
      try {
        listener(...payload);
      } catch (error) {
        console.error(`[reasonixDesktop] listener for ${name} failed`, error);
      }
    }
  });
}

function on(name: string, listener: Listener): () => void {
  bindEvents();
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(name);
  };
}

let lastServiceState: ServiceState | null = null;
const serviceStateListeners = new Set<(state: ServiceState) => void>();
ipcRenderer.on(IPC.serviceState, (_event, state: ServiceState) => {
  lastServiceState = state;
  for (const listener of [...serviceStateListeners]) listener(state);
});

// A renderer that mounts after the service became ready never saw the push;
// the first subscriber pulls the current state so nobody waits on a past event.
function onServiceState(listener: (state: ServiceState) => void): () => void {
  serviceStateListeners.add(listener);
  if (lastServiceState) listener(lastServiceState);
  else {
    void call(IPC.serviceStateGet).then((state) => {
      if (lastServiceState || !serviceStateListeners.has(listener)) return;
      lastServiceState = state as ServiceState;
      listener(lastServiceState);
    }).catch(() => undefined);
  }
  return () => {
    serviceStateListeners.delete(listener);
  };
}

contextBridge.exposeInMainWorld("reasonixDesktop", {
  kind: "electron",
  contract: readContract(),
  platform: {
    os: hostOS(process.platform),
    arch: process.arch,
    versions: { electron: process.versions.electron ?? "", chrome: process.versions.chrome ?? "", node: process.versions.node ?? "" },
  },
  invoke: (method: string, args: unknown[]) => call(IPC.invoke, method, Array.isArray(args) ? args : []),
  on,
  native: {
    openExternal: (url: string) => call(IPC.openExternal, url).then(() => undefined),
    clipboard: {
      writeText: (text: string) => call(IPC.clipboardWrite, text).then((ok) => ok === true),
      readText: () => call(IPC.clipboardRead).then((text) => (typeof text === "string" ? text : "")),
    },
    window: {
      setTheme: (theme: WindowTheme) => fire(IPC.windowSetTheme, theme),
      setBackgroundColour: (r: number, g: number, b: number, a: number) => fire(IPC.windowSetBackground, r, g, b, a),
      getBounds: () => call(IPC.windowGetBounds),
      isMaximised: () => call(IPC.windowIsMaximised).then((value) => value === true),
      minimise: () => fire(IPC.windowMinimise),
      toggleMaximise: () => fire(IPC.windowToggleMaximise),
      close: () => fire(IPC.windowClose),
    },
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    onServiceState,
  },
});
