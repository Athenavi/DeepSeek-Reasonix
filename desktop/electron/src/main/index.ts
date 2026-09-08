import { app, clipboard, dialog, ipcMain, net, protocol, screen, session, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { IPC } from "../shared/ipc.js";
import { emptyContract, loadContract, type LoadedContract } from "./contract.js";
import { DialogHost } from "./dialogs.js";
import { renderFailurePage, type ShellAction } from "./failurePage.js";
import { buildHelloParams, describeHandshakeFailure, validateHelloResult, type HelloResult } from "./handshake.js";
import { reasonixHome } from "./home.js";
import { buildHostCallTable, dispatchHostCall, type ScreenInfo } from "./hostCalls.js";
import { firstExisting, iconCandidates } from "./icons.js";
import { registerRendererIpc } from "./ipc.js";
import { QuitSequencer } from "./lifecycle.js";
import { createLogger, errorText, RotatingFile } from "./log.js";
import { installApplicationMenu } from "./menu.js";
import { record } from "./params.js";
import { APP_INDEX_URL, APP_SCHEME, registerAppProtocol, resolveDistRoot } from "./protocol.js";
import { RemoteWindowHost } from "./remoteWindows.js";
import { ServiceSupervisor } from "./service.js";
import { TrayHost } from "./tray.js";
import { DEFAULT_GEOMETRY, MainWindow } from "./window.js";

const MAIN_WINDOW_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications"]);

app.setName("Reasonix");
const dev = (process.env.REASONIX_DEV ?? "").trim() !== "";
const home = reasonixHome({ env: process.env, platform: process.platform, homedir, cwd: () => process.cwd() });
if (home === "") {
  console.error("reasonix-desktop-shell: cannot resolve the Reasonix data home (set REASONIX_HOME)");
  app.exit(1);
} else if (!dev && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap(home);
}

function bootstrap(dataHome: string): void {
  app.setPath("userData", join(dataHome, "desktop-shell"));
  const logsDir = join(app.getPath("userData"), "logs");
  const log = createLogger(new RotatingFile(join(logsDir, "shell.log")), !app.isPackaged);
  const serviceLog = new RotatingFile(join(logsDir, "service.log"));
  process.on("uncaughtException", (error) => log.error(`uncaught exception: ${errorText(error)}`));
  process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${errorText(reason)}`));

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
  ]);

  const contractPath = join(__dirname, "desktopContract.json");
  let contract: LoadedContract;
  try {
    contract = loadContract(contractPath);
  } catch (error) {
    log.warn(`desktop contract unavailable (${errorText(error)}); every desktop/invoke will be rejected`);
    contract = emptyContract();
  }
  const distRoot = resolveDistRoot({ env: process.env, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  const devURL = (process.env.REASONIX_ELECTRON_DEV_URL ?? "").trim();
  const appURL = devURL !== "" ? devURL : APP_INDEX_URL;
  const icons = iconCandidates({ platform: process.platform, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  const windowIcon = process.platform === "darwin" ? undefined : (firstExisting(icons.window) ?? undefined);
  const serviceBinary = (process.env.REASONIX_DESKTOP_SERVICE ?? "").trim()
    || join(process.resourcesPath, "service", process.platform === "win32" ? "reasonix-desktop.exe" : "reasonix-desktop");

  let domReadyGeneration = "";

  const mainWindow = new MainWindow({
    preloadPath: join(__dirname, "preload.cjs"),
    appURL,
    platform: process.platform,
    icon: windowIcon,
    log,
    onAppDomReady: (rendererGeneration) => {
      const generation = service.generation;
      if (generation === "") return;
      const attach = () => service.request("desktop/rendererAttached", { rendererGeneration }).catch((error: unknown) => {
        log.warn(`rendererAttached failed: ${errorText(error)}`);
      });
      if (domReadyGeneration === generation) {
        void attach();
        return;
      }
      domReadyGeneration = generation;
      void service.request("desktop/domReady", {})
        .catch((error: unknown) => log.warn(`domReady failed: ${errorText(error)}`))
        .then(attach);
    },
    onCloseRequested: async () => record(await service.request("desktop/beforeClose", { reason: "window" })).prevent === true,
    onCloseAllowed: () => lifecycle.approve(),
    onShellAction: (action: ShellAction) => {
      if (action === "open-logs") void shell.openPath(logsDir);
      else if (action === "restart") void service.restart().catch(() => undefined);
      else lifecycle.approve();
    },
  });

  const remote = new RemoteWindowHost({
    platform: process.platform,
    icon: windowIcon,
    log,
    onClosed: (hostKey) => void service.hostEvent("remoteWindow.closed", { hostKey }),
  });
  const tray = new TrayHost({
    platform: process.platform,
    iconPath: firstExisting(icons.tray),
    onOpen: () => {
      mainWindow.show("tray");
      void service.hostEvent("tray.open", {});
    },
    onQuit: () => void service.hostEvent("tray.quit", {}),
    log,
  });
  const dialogs = new DialogHost(dialog, () => mainWindow.browserWindow ?? undefined);

  const lifecycle = new QuitSequencer({
    service: {
      beforeClose: async (reason) => record(await service.request("desktop/beforeClose", { reason })).prevent === true,
      shutdown: () => service.shutdown(),
    },
    app: { quit: () => app.quit(), relaunch: (args) => app.relaunch({ args }) },
    onCloseAllowed: () => {
      mainWindow.allowClose();
      remote.closeAll();
      tray.destroy();
    },
    log,
  });

  const hostCalls = buildHostCallTable({
    window: mainWindow,
    dialogs,
    tray,
    remote,
    lifecycle,
    openExternal: (url) => {
      new URL(url);
      return shell.openExternal(url);
    },
    hideApp: () => {
      if (process.platform === "darwin") app.hide();
      else mainWindow.hide();
    },
    screens: (): ScreenInfo[] => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((display) => ({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        scale: display.scaleFactor,
        primary: display.id === primary,
      }));
    },
  });

  const service = new ServiceSupervisor(
    {
      binary: serviceBinary,
      args: ["--host-rpc"],
      env: process.env,
      onStderr: (chunk) => {
        serviceLog.write(chunk);
        if (!app.isPackaged) process.stderr.write(chunk);
      },
      log,
    },
    {
      hello: async (client) => validateHelloResult(await client.request("desktop/hello", buildHelloParams({
        contractDigest: contract.digest,
        version: app.isPackaged ? app.getVersion() : "dev",
        channel: process.env.REASONIX_CHANNEL || "dev",
        commit: process.env.REASONIX_COMMIT || "dev",
        hostVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        home: dataHome,
        dev,
      }), 10_000)),
      onRequest: (method, params) => dispatchHostCall(hostCalls, method, params),
      onEvent: (frame) => mainWindow.send(IPC.event, frame),
      onState: (state) => mainWindow.send(IPC.serviceState, state),
      onReady: (hello: HelloResult) => {
        log.info(`desktop service ready: generation ${hello.runtimeGeneration}, pid ${hello.service.pid}`);
        if (!mainWindow.browserWindow) mainWindow.create(hello.window);
        void mainWindow.loadApp();
      },
      onFailed: (error) => {
        const failure = describeHandshakeFailure(error);
        log.error(`desktop service failed: ${failure.name}: ${failure.detail}`);
        if (!mainWindow.browserWindow) mainWindow.create(DEFAULT_GEOMETRY);
        void mainWindow.showFailure(renderFailurePage(failure, logsDir));
      },
    },
  );

  // Session end and scripted shutdowns deliver SIGTERM; quit through the same
  // sequence as the menu so Go snapshots sessions before the process ends.
  process.on("SIGTERM", () => lifecycle.requestQuit());
  app.on("second-instance", (_event, argv) => {
    mainWindow.focusForSecondInstance();
    void service.hostEvent("secondInstance", { argv });
  });
  app.on("activate", () => mainWindow.show("activate"));
  app.on("before-quit", (event) => {
    if (!lifecycle.onBeforeQuit()) event.preventDefault();
  });
  app.on("window-all-closed", () => {
    // Go decides when the process ends; a hidden main window keeps running.
  });

  void app.whenReady().then(() => {
    registerAppProtocol({
      protocol,
      fetch: (input, init) => net.fetch(input, init),
      distRoot,
      resources: () => service.helloResult?.resources ?? null,
      log,
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(mainWindow.isTrustedSender(contents, contents.mainFrame) && MAIN_WINDOW_PERMISSIONS.has(permission));
    });
    registerRendererIpc({
      ipcMain,
      contract,
      window: mainWindow,
      invoke: (method, args) => service.invoke(method, args),
      serviceState: () => service.current,
      clipboard,
      openExternal: (url) => shell.openExternal(url),
      log,
    });
    installApplicationMenu({
      platform: process.platform,
      openSettings: () => mainWindow.sendShellEvent("app:open-settings", service.generation),
      toggleDevTools: () => mainWindow.toggleDevTools(),
      showWindow: () => mainWindow.show("menu"),
      quit: () => lifecycle.requestQuit(),
    });
    log.info(`shell starting: service ${serviceBinary}, ui ${appURL}, dist ${distRoot}, home ${dataHome}`);
    return service.start().catch(() => undefined);
  }).catch((error: unknown) => {
    log.error(`shell bootstrap failed: ${errorText(error)}`);
    app.exit(1);
  });
}
