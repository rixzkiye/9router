import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(() => Buffer.from(JSON.stringify({
    "headroom-ai": "0.26.0",
    "tree-sitter": "0.25.0",
  }))),
  realpathSync: vi.fn((value) => value),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
}));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal()),
  realpathSync: mocks.realpathSync,
}));

import { findPython310, getHeadroomStatus, getInstalledHeadroomExtras, isLoopbackHeadroomUrl } from "../../src/lib/headroom/detect.js";

afterEach(() => {
  vi.clearAllMocks();
  mocks.realpathSync.mockImplementation((value) => value);
});

describe("headroom detect", () => {
  it("detects installed headroom version and extras from pip list", () => {
    const result = getInstalledHeadroomExtras("python3");

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "python3",
      ["-c", expect.stringContaining("importlib.metadata")],
      expect.objectContaining({ windowsHide: true, timeout: 8000 }),
    );
    expect(result).toEqual({
      installed: true,
      version: "0.26.0",
      extras: { code: true, ml: false },
    });
  });

  it("normalizes Python package separators when detecting extras", () => {
    mocks.execFileSync.mockReturnValue(Buffer.from(JSON.stringify({
      "headroom_ai": "0.32.1",
      "huggingface_hub": "1.0.0",
    })));

    expect(getInstalledHeadroomExtras("python3")).toEqual({
      installed: true,
      version: "0.32.1",
      extras: { code: false, ml: true },
    });
  });

  it("prefers the interpreter that actually has headroom-ai installed", () => {
    // headroom binary lives in a bin dir; the python next to it has headroom-ai.
    const binPython = "/opt/hr/bin/python3";
    mocks.execFileSync.mockImplementation((command, args) => {
      if (command === "which") return Buffer.from("/opt/hr/bin/headroom\n");
      if (command === binPython && args[0] === "--version") return Buffer.from("Python 3.13.0\n");
      if (command === binPython && args[0] === "-c" && args[1].includes("version('headroom-ai')")) {
        return Buffer.from("0.26.0\n");
      }
      throw new Error(`unexpected execFileSync: ${command} ${args.join(" ")}`);
    });

    expect(findPython310()).toBe(binPython);
  });

  it("follows a uv-tool headroom symlink to its owning interpreter", () => {
    const shim = "/home/me/.local/bin/headroom";
    const realBinary = "/home/me/.local/share/uv/tools/headroom-ai/bin/headroom";
    const toolPython = "/home/me/.local/share/uv/tools/headroom-ai/bin/python3";
    mocks.realpathSync.mockImplementation((value) => value === shim ? realBinary : value);
    mocks.execFileSync.mockImplementation((command, args) => {
      if (command === "which") return Buffer.from(`${shim}\n`);
      if (command === toolPython && args[0] === "--version") return Buffer.from("Python 3.13.0\n");
      if (command === toolPython && args[0] === "-c" && args[1].includes("version('headroom-ai')")) {
        return Buffer.from("0.32.1\n");
      }
      throw new Error("not installed");
    });

    expect(findPython310()).toBe(toolPython);
  });

  it("keeps top-level installed flag true when extras are readable", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    mocks.execFileSync.mockImplementation((command, args) => {
      if (command === "which") return Buffer.from("/usr/local/bin/headroom\n");
      if (command === "python3" && args[0] === "--version") return Buffer.from("Python 3.13.0\n");
      if (command === "python" && args[0] === "--version") return Buffer.from("Python 3.13.0\n");
      if (args[0] === "-c" && args[1].includes("version('headroom-ai')")) {
        if (command === "python3") throw new Error("not installed in python3");
        if (command === "python") return Buffer.from("0.26.0\n");
      }
      if (command === "python" && args[0] === "-c" && args[1].includes("distributions()")) {
        return Buffer.from(JSON.stringify({ "headroom-ai": "0.26.0", "tree-sitter": "0.25.0" }));
      }
      throw new Error(`unexpected execFileSync: ${command} ${args.join(" ")}`);
    });

    const status = await getHeadroomStatus("http://localhost:8787");

    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.26.0");
    expect(status.extras).toEqual({ code: true, ml: false });
  });

  it("treats a reachable external proxy as running without local CLI", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    mocks.execFileSync.mockImplementation(() => { throw new Error("not found"); });

    const status = await getHeadroomStatus("http://headroom:8787");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(true);
    expect(status.localUrl).toBe(false);
    expect(status.canStart).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/health", expect.any(Object));
  });

  it("recognizes loopback URLs for managed local mode", () => {
    expect(isLoopbackHeadroomUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://headroom:8787")).toBe(false);
    expect(isLoopbackHeadroomUrl("not-a-url")).toBe(false);
  });
});
