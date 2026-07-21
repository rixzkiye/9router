import fs from "fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DATA_DIR = "/tmp/9router-headroom-process-test";
const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  getInstalledHeadroomExtras: vi.fn(() => ({
    installed: true,
    version: "0.32.1",
    extras: { code: true, ml: false },
  })),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));
vi.mock("../../src/lib/dataDir.js", () => ({ DATA_DIR: "/tmp/9router-headroom-process-test" }));
vi.mock("../../src/lib/headroom/detect.js", () => ({
  EXTRA_MARKERS: {
    code: ["tree-sitter", "tree-sitter-language-pack"],
    ml: ["torch", "huggingface-hub"],
  },
  HEADROOM_COMPRESSION_EXTRAS: ["code", "ml"],
  findHeadroomBinary: () => "/home/me/.local/bin/headroom",
  findPython310: () => "/home/me/.local/share/uv/tools/headroom-ai/bin/python3",
  getInstalledHeadroomExtras: mocks.getInstalledHeadroomExtras,
}));

import { installHeadroomExtras, uninstallHeadroomExtras } from "../../src/lib/headroom/process.js";

function successfulChild() {
  const handlers = {};
  const child = {
    once(event, handler) {
      handlers[event] = handler;
      return child;
    },
  };
  queueMicrotask(() => handlers.exit?.(0));
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execFileSync.mockImplementation(() => { throw new Error("No module named pip"); });
  mocks.spawn.mockImplementation(successfulChild);
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("headroom extras package manager", () => {
  it("installs into a uv-tool environment when pip is absent", async () => {
    await installHeadroomExtras(["code"]);

    expect(mocks.spawn).toHaveBeenCalledWith(
      "uv",
      [
        "pip",
        "install",
        "--python",
        "/home/me/.local/share/uv/tools/headroom-ai/bin/python3",
        "--upgrade",
        "headroom-ai[proxy,code]",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("uninstalls markers from the same uv-tool environment", async () => {
    await uninstallHeadroomExtras(["code"]);

    expect(mocks.spawn).toHaveBeenCalledWith(
      "uv",
      [
        "pip",
        "uninstall",
        "--python",
        "/home/me/.local/share/uv/tools/headroom-ai/bin/python3",
        "-y",
        "tree-sitter",
        "tree-sitter-language-pack",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
