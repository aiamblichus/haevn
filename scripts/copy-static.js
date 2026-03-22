import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

// manifest
copyFileSync("src/manifest.json", "dist/manifest.json");

// popup.html -> use the compiled popup.js + popup.css
// (Either change the source to point to popup.js, or do a tiny replace here.)
let html = await (
  await import("node:fs/promises")
).readFile("src/popup/popup.html", "utf8");
// ensure it loads dist artifacts
html = html
  .replace("popup.ts", "popup.js") // script
  .replace('href="popup.css"', 'href="popup.css"'); // keep as-is (we output dist/popup.css)
await (
  await import("node:fs/promises")
).writeFile("dist/popup.html", html, "utf8");

// options.html -> compiled options.js, reuse popup.css for Tailwind
if (existsSync("src/options/options.html")) {
  let optHtml = await (
    await import("node:fs/promises")
  ).readFile("src/options/options.html", "utf8");
  optHtml = optHtml
    .replace("options.ts", "options.js")
    .replace('href="popup.css"', 'href="popup.css"');
  await (
    await import("node:fs/promises")
  ).writeFile("dist/options.html", optHtml, "utf8");
}

// viewer.html -> compiled viewer.js, separate viewer.css
if (existsSync("src/viewer/viewer.html")) {
  let viewerHtml = await (
    await import("node:fs/promises")
  ).readFile("src/viewer/viewer.html", "utf8");
  viewerHtml = viewerHtml
    .replace("viewer.ts", "viewer.js")
    .replace('href="viewer.css"', 'href="viewer.css"');
  await (
    await import("node:fs/promises")
  ).writeFile("dist/viewer.html", viewerHtml, "utf8");
}

// offscreen.html -> compiled offscreen.js
if (existsSync("src/offscreen/offscreen.html")) {
  let offscreenHtml = await (
    await import("node:fs/promises")
  ).readFile("src/offscreen/offscreen.html", "utf8");
  offscreenHtml = offscreenHtml.replace("offscreen.ts", "offscreen.js");
  await (
    await import("node:fs/promises")
  ).writeFile("dist/offscreen.html", offscreenHtml, "utf8");
}

// logs.html -> compiled logs-viewer.js, separate logs-viewer.css
if (existsSync("src/logs/logs.html")) {
  let logsHtml = await (
    await import("node:fs/promises")
  ).readFile("src/logs/logs.html", "utf8");
  logsHtml = logsHtml
    .replace("logs-viewer.ts", "logs-viewer.js")
    .replace('href="logs-viewer.css"', 'href="logs-viewer.css"');
  await (
    await import("node:fs/promises")
  ).writeFile("dist/logs.html", logsHtml, "utf8");

  // Copy logs-viewer.css (plain CSS, no processing needed)
  if (existsSync("src/logs/logs-viewer.css")) {
    copyFileSync("src/logs/logs-viewer.css", "dist/logs-viewer.css");
  }
}

// icons (if present)
if (existsSync("src/icons")) {
  mkdirSync("dist/icons", { recursive: true });
  cpSync("src/icons", "dist/icons", { recursive: true });
}
