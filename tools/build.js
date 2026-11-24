// `npm run build` : fabrique dans dist/ une archive par navigateur, chacune avec son manifeste.
//   - wikimastered-extension-<version>-chrome.zip : Chrome, Brave, Edge, Opera, et le Chrome Web Store ;
//   - wikimastered-extension-<version>-firefox.zip : Firefox, et addons.mozilla.org (AMO).
// Le manifeste du dépôt sert aux deux (chargement dézippé pour le développement) ; chaque archive n'en garde que ce
// que son navigateur comprend, pour que les boutiques n'affichent aucun avertissement.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== manifest.version) throw new Error(`Versions différentes : manifest ${manifest.version}, package.json ${pkg.version}`);

const TARGETS = {
  // Chrome : panneau par side_panel (permission sidePanel), arrière-plan en service worker.
  chrome: (m) => {
    const out = structuredClone(m);
    delete out.browser_specific_settings;
    delete out.sidebar_action;
    out.background = { service_worker: m.background.service_worker };
    return out;
  },
  // Firefox : panneau par sidebar_action, arrière-plan en scripts ; pas de side_panel ni de permission sidePanel.
  firefox: (m) => {
    const out = structuredClone(m);
    delete out.side_panel;
    out.permissions = m.permissions.filter((p) => p !== "sidePanel");
    out.background = { scripts: m.background.scripts };
    return out;
  },
};

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
for (const [target, transform] of Object.entries(TARGETS)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wme-${target}-`));
  try {
    for (const entry of ["src", "icons", "LICENSE"]) fs.cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(transform(manifest), null, 2) + "\n");
    const out = path.join(root, "dist", `wikimastered-extension-${manifest.version}-${target}.zip`);
    fs.rmSync(out, { force: true });
    execFileSync("zip", ["-qr", out, "manifest.json", "src", "icons", "LICENSE"], { cwd: dir, stdio: "inherit" });
    console.log(`Archive prête : ${path.relative(root, out)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
