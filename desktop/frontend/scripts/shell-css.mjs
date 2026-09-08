// The stylesheet marks OS drag regions once, with the Wails custom property.
// Chromium ignores var() for -webkit-app-region, so the Electron build rewrites
// the declaration at bundle time instead of carrying both forms in the source
// and the Wails bundle.
const DRAG_PROPERTY = /--wails-draggable\s*:/g;

export function shellFromEnv(env = process.env) {
  const shell = (env.REASONIX_SHELL ?? "").trim().toLowerCase();
  if (shell === "" || shell === "wails") return "wails";
  if (shell === "electron") return "electron";
  throw new Error(`REASONIX_SHELL must be "wails" or "electron", got ${JSON.stringify(shell)}`);
}

export function rewriteDragRegions(css, shell) {
  if (shell !== "electron") return css;
  return css.replace(DRAG_PROPERTY, "-webkit-app-region:");
}
