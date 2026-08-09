"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { copyRuntimePackages } = require("./copy-runtime-packages.cjs");

async function main() {
  const appDir = path.resolve(__dirname, "..");
  const distDir = path.join(appDir, process.env.NEXT_DIST_DIR || ".next");
  const standaloneRoot = path.join(distDir, "standalone");
  const packageName = path.basename(appDir);
  const standaloneDir = fs.existsSync(path.join(standaloneRoot, "server.js"))
    ? standaloneRoot
    : path.join(standaloneRoot, packageName);

  if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
    throw new Error(`Next standalone server was not found under ${standaloneRoot}`);
  }

  fs.copyFileSync(
    path.join(appDir, "custom-server.js"),
    path.join(standaloneDir, "custom-server.js")
  );
  fs.cpSync(path.join(appDir, "server"), path.join(standaloneDir, "server"), {
    recursive: true,
    dereference: true,
  });

  copyRuntimePackages(
    ["ws", "https-proxy-agent", "socks-proxy-agent"],
    path.join(standaloneDir, "node_modules"),
    {
      searchPaths: [appDir],
      storeDirs: [path.join(appDir, "node_modules", ".pnpm")],
    }
  );

  // Standalone output leaves .next/static and public/ at the project root;
  // copy them so the packaged server (native-server.cjs / PM2 / Docker) can
  // serve JS/CSS/fonts and dashboard assets without the project tree.
  const { copyStandaloneAssets } = await import("./copy-standalone-assets.mjs");
  copyStandaloneAssets();

  console.log(`Prepared Codex Native standalone gateway in ${standaloneDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
