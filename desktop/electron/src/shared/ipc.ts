export const IPC = {
  contract: "reasonix:contract",
  invoke: "reasonix:invoke",
  event: "reasonix:event",
  serviceState: "reasonix:service-state",
  serviceStateGet: "reasonix:service-state:get",
  openExternal: "reasonix:native:open-external",
  clipboardWrite: "reasonix:native:clipboard-write",
  clipboardRead: "reasonix:native:clipboard-read",
  windowMinimise: "reasonix:native:window-minimise",
  windowToggleMaximise: "reasonix:native:window-toggle-maximise",
  windowIsMaximised: "reasonix:native:window-is-maximised",
  windowClose: "reasonix:native:window-close",
  windowGetBounds: "reasonix:native:window-get-bounds",
  windowSetTheme: "reasonix:native:window-set-theme",
  windowSetBackground: "reasonix:native:window-set-background",
} as const;

export type ServicePhase = "starting" | "ready" | "restarting" | "failed" | "exited";

export interface ServiceState {
  phase: ServicePhase;
  generation: string;
  error?: string;
}

export interface ContractInfo {
  protocolVersion: number;
  digest: string;
  commands: readonly string[];
}

export interface EventFrame {
  seq: number;
  generation: string;
  name: string;
  args: unknown[];
}

export type IpcResult = { ok: true; value: unknown } | { ok: false; message: string };

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximised: boolean;
}

export type WindowTheme = "system" | "light" | "dark";

export type HostOS = "darwin" | "windows" | "linux";

export function hostOS(platform: string): HostOS {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  return "linux";
}
