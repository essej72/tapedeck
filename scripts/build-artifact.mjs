// The same site as one page for a claude.ai Artifact preview: the page without its document wrapper, its CSS
// inlined, with app.js and the data files published alongside.   node scripts/build-artifact.mjs  (after build)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(join(root, "docs/index.html"), "utf8");
const css = readFileSync(join(root, "docs/style.css"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
const page = [
  "<title>Tapedeck</title>",
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Michroma&display=swap">',
  `<style>${css}</style>`,
  body,
].join("");
mkdirSync(join(root, "artifact"), { recursive: true });
writeFileSync(join(root, "artifact/Tapedeck.html"), page);
console.log("artifact/Tapedeck.html", (page.length / 1024).toFixed(0), "KB");
