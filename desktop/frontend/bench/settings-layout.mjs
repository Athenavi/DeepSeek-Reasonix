#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPreviewServer } from "./vite-preview-server.mjs";
import { chooseAppLayout } from "./app-page-actions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = !process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === ".pw-browsers"
  ? path.join(root, ".pw-browsers") : process.env.PLAYWRIGHT_BROWSERS_PATH;
const engines = await import("playwright");
const port = Number(process.env.REASONIX_SETTINGS_PORT ?? 4679);
const preview = await startPreviewServer(root, port);
const themes = ["graphite", "aurora", "slate", "carbon", "nocturne", "amber"];
const sizes = [1600, 1100, 900, 700, 400];
const assignmentRows = 5;
let cases = 0;

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function geometry() {
  const rect = el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const group = document.querySelector(".model-preferences");
  const head = group?.querySelector(".model-assignment-head");
  const general = document.querySelector(".settings-page--general");
  return {
    pageWidth: general?.clientWidth,
    generalContainer: general && getComputedStyle(general).containerName,
    soundColumns: general && [...general.querySelectorAll(".settings-sound-row")].map(row => getComputedStyle(row).gridTemplateColumns.split(" ").length),
    statusColumns: general && getComputedStyle(general.querySelector(".status-bar-items-setting")).gridTemplateColumns.split(" ").length,
    width: group?.clientWidth,
    headVisible: head && getComputedStyle(head).display !== "none",
    headers: head && [...head.children].map(rect),
    rows: group && [...group.querySelectorAll(".model-assignment-row")].map(row => ({
      bounds: rect(row),
      label: rect(row.querySelector(".settings-field__copy")),
      picker: rect(row.querySelector(".settings-model-picker")),
      connection: rect(row.querySelector(".model-assignment-connection")),
      columns: getComputedStyle(row).gridTemplateColumns.split(" ").length,
    })),
  };
}

try {
  for (const engineName of (process.env.REASONIX_SETTINGS_BROWSERS ?? "chromium").split(",")) {
    const browser = await engines[engineName].launch({ headless: true });
    try {
      const page = await browser.newPage({ locale: "en-US", viewport: { width: 1600, height: 1100 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?mock=deepseek_upgrade&bench=1`, { waitUntil: "domcontentloaded" });
      await page.locator("textarea.composer__input:not([aria-hidden=true])").waitFor();
      for (const layout of [["Creation", "app--creation"], ["Workbench", "app--workbench"]]) {
        await page.setViewportSize({ width: 1600, height: 1100 });
        await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
        await chooseAppLayout(page, ...layout);
        await page.locator('button:has(svg.lucide-settings)').last().click();
        await page.locator(".settings-page--general").waitFor();
        await page.getByRole("button", { name: "Expand sound settings", exact: true }).click();
        for (const width of sizes) {
          await page.setViewportSize({ width, height: 1100 });
          await settle(page);
          const g = await page.evaluate(geometry);
          assert.equal(g.generalContainer, "settings-general", "general page retains its responsive container");
          if (g.pageWidth <= 440) {
            assert.ok(g.soundColumns.length > 0, "sound controls are present");
            assert.ok(g.soundColumns.every(columns => columns === 1), "narrow sound controls stack within the general page");
          }
          assert.equal(g.statusColumns, 1, `status bar editor owns one full-width column at ${width}px`);
        }
        console.log(`PASS ${engineName}/${layout[0]} general settings`);
        await page.setViewportSize({ width: 1600, height: 1100 });
        await page.getByRole("button", { name: "Model preferences", exact: true }).click();
        await page.locator(".model-assignment-row").first().waitFor();
        for (const theme of themes) {
          for (const zoom of [1, 1.5]) {
            await page.evaluate(({ theme, zoom }) => {
              document.documentElement.dataset.themeStyle = theme;
              document.documentElement.style.zoom = String(zoom);
            }, { theme, zoom });
            for (const width of sizes) {
              await page.setViewportSize({ width, height: 1100 });
              await settle(page);
              const g = await page.evaluate(geometry);
              const context = `${engineName}/${layout[0]}/${theme}/${width}px/${zoom}x`;
              assert.equal(g.rows.length, assignmentRows, `${context}: all assignments remain visible`);
              const columns = g.width > 780 ? 3 : g.width > 440 ? 2 : 1;
              assert.equal(g.headVisible, columns === 3, `${context}: header follows content width`);
              for (const row of g.rows) {
                assert.equal(row.columns, columns, `${context}: assignment owns its columns`);
                assert.ok(row.picker.left >= row.bounds.left - 1 && row.picker.right <= row.bounds.right + 1, `${context}: picker stays within row`);
                assert.ok(row.connection.right <= row.bounds.right + 1, `${context}: connection stays within row`);
                if (columns === 3) {
                  assert.ok(Math.abs(row.picker.left - g.headers[1].left) < 2, `${context}: model aligns with header`);
                  assert.ok(Math.abs(row.connection.left - g.headers[2].left) < 2, `${context}: connection aligns with header`);
                  assert.ok(row.connection.top < row.picker.bottom && row.connection.bottom > row.picker.top, `${context}: connection stays on same row`);
                } else {
                  assert.ok(row.connection.top >= row.picker.bottom - 1, `${context}: connection follows its model`);
                  assert.ok(Math.abs(row.connection.left - row.picker.left) < 2, `${context}: stacked connection aligns with model`);
                }
              }
              cases++;
            }
          }
        }
        await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
        await page.setViewportSize({ width: 1600, height: 1100 });
        const picker = page.getByRole("button", { name: "Default model", exact: true });
        await picker.click();
        await page.getByRole("listbox", { name: "Default model", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("listbox", { name: "Default model", exact: true }).waitFor({ state: "detached" });
        console.log(`PASS ${engineName}/${layout[0]} assignments and picker`);
        await page.locator(".settings-screen .management-screen__back").click();
      }
      assert.deepEqual(errors, [], `${engineName}: no runtime errors`);
    } finally { await browser.close(); }
  }
  console.log(`PASS settings layout: ${cases} real-page theme/layout/width/zoom cases plus general settings and picker interaction`);
} finally { await new Promise((resolve, reject) => preview.httpServer.close(error => error ? reject(error) : resolve())); }
