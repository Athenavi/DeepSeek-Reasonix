import { Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuDeps {
  platform: NodeJS.Platform;
  openSettings(): void;
  toggleDevTools(): void;
  showWindow(): void;
  quit(): void;
}

export function applicationMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  return [
    ...(deps.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => deps.openSettings() },
        { label: "Toggle Developer Tools", accelerator: "CmdOrCtrl+I", click: () => deps.toggleDevTools() },
        { label: "Show Reasonix", click: () => deps.showWindow() },
        { type: "separator" },
        { label: "Quit Reasonix", accelerator: "CmdOrCtrl+Q", click: () => deps.quit() },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}

export function installApplicationMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(deps)));
}
