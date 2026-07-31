"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

const packages = [
  "ws",
  "https-proxy-agent",
  "socks-proxy-agent",
  "agent-base",
  "debug",
  "socks",
  "smart-buffer",
];
for (const packageName of packages) {
  const source = fs.realpathSync(path.join(appDir, "node_modules", packageName));
  const destination = path.join(standaloneDir, "node_modules", packageName);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

console.log(`Prepared Codex Native standalone gateway in ${standaloneDir}`);
