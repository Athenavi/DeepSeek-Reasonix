import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { IPC, type IpcResult, type ServiceState, type WindowBounds, type WindowTheme } from "../shared/ipc.js";
import { isAllowedCommand, type LoadedContract } from "./contract.js";
import { errorText, type Logger } from "./log.js";
import { finite } from "./params.js";
import { RpcError } from "./rpc.js";

export interface RendererWindowApi {
  isTrustedSender(sender: IpcMainEvent["sender"], frame: IpcMainEvent["senderFrame"]): boolean;
  minimise(): void;
  toggleMaximise(): void;
  isMaximised(): boolean;
  close(): void;
  bounds(): WindowBounds;
  setTheme(theme: WindowTheme): void;
  setBackgroundColour(r: number, g: number, b: number, a: number): void;
}

export interface RendererIpcDeps {
  ipcMain: IpcMain;
  contract: LoadedContract;
  window: RendererWindowApi;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  serviceState(): ServiceState;
  clipboard: { writeText(text: string): Promise<void> | void; readText(): Promise<string> | string };
  openExternal(url: string): Promise<void>;
  log: Logger;
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isOpenableExternalURL(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function registerRendererIpc(deps: RendererIpcDeps): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const ok = deps.window.isTrustedSender(event.sender, event.senderFrame);
    if (!ok) deps.log.warn(`rejected IPC from untrusted sender (webContents ${event.sender.id})`);
    return ok;
  };
  const handle = (channel: string, run: (...args: unknown[]) => Promise<unknown> | unknown) => {
    deps.ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult> => {
      if (!trusted(event)) return { ok: false, message: "untrusted sender" };
      try {
        return { ok: true, value: await run(...args) };
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
    });
  };

  deps.ipcMain.on(IPC.contract, (event) => {
    event.returnValue = trusted(event)
      ? { protocolVersion: deps.contract.protocolVersion, digest: deps.contract.digest, commands: [...deps.contract.commands] }
      : null;
  });

  handle(IPC.invoke, (method, args) => {
    if (!isAllowedCommand(deps.contract, method)) {
      throw new RpcError(-32601, `-32601 method not found: ${typeof method === "string" ? method : typeof method}`);
    }
    return deps.invoke(method, Array.isArray(args) ? args : []);
  });
  handle(IPC.serviceStateGet, () => deps.serviceState());
  handle(IPC.openExternal, (url) => {
    if (!isOpenableExternalURL(url)) throw new Error(`refusing to open ${typeof url === "string" ? url : typeof url}`);
    return deps.openExternal(url);
  });
  handle(IPC.clipboardWrite, async (text) => {
    await deps.clipboard.writeText(typeof text === "string" ? text : "");
    return true;
  });
  handle(IPC.clipboardRead, () => deps.clipboard.readText());
  handle(IPC.windowMinimise, () => deps.window.minimise());
  handle(IPC.windowToggleMaximise, () => deps.window.toggleMaximise());
  handle(IPC.windowIsMaximised, () => deps.window.isMaximised());
  handle(IPC.windowClose, () => deps.window.close());
  handle(IPC.windowGetBounds, () => deps.window.bounds());
  handle(IPC.windowSetTheme, (theme) => deps.window.setTheme(theme === "light" || theme === "dark" ? theme : "system"));
  handle(IPC.windowSetBackground, (r, g, b, a) => deps.window.setBackgroundColour(finite(r), finite(g), finite(b), finite(a, 255)));
}
