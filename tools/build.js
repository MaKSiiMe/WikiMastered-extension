// `npm run build` : fabrique dist/wikimastered-extension-<version>.zip, à installer dans Chrome (dézippé) ou Firefox.
// Un seul manifeste sert aux deux navigateurs : Chrome ignore `browser_specific_settings` (simple avertissement).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== version) throw new Error(`Versions différentes : manifest ${version}, package.json ${pkg.version}`);

const out = path.join(root, "dist", `wikimastered-extension-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync("zip", ["-qr", out, "manifest.json", "src", "icons", "LICENSE"], { cwd: root, stdio: "inherit" });
console.log(`Archive prête : ${path.relative(root, out)}`);
