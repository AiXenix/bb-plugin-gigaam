import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM helper without type declarations
import { generatedPath, renderEmbeddedPython, sourcePath } from "../scripts/embed-python.mjs";
import { platformSupport } from "../src/platform.js";

describe("platformSupport", () => {
  it("uses CPU-only PyTorch wheels on Linux", () => {
    const support = platformSupport("linux", "x64");
    expect(support.supported).toBe(true);
    if (!support.supported) return;
    expect(support.uv.url).toMatch(/uv-x86_64-unknown-linux-musl\.tar\.gz$/);
    expect(support.torchIndexArgs).toEqual(["--index-url", "https://download.pytorch.org/whl/cpu"]);
  });

  it("uses the default index on Apple silicon", () => {
    const support = platformSupport("darwin", "arm64");
    expect(support.supported && support.torchIndexArgs).toEqual([]);
  });

  it("explains unsupported platforms", () => {
    const intel = platformSupport("darwin", "x64");
    expect(intel.supported).toBe(false);
    expect(!intel.supported && intel.reason).toMatch(/Intel Macs/);
    const windows = platformSupport("win32", "x64");
    expect(!windows.supported && windows.reason).toMatch(/GigaAM server URL/);
  });
});

describe("embedded server", () => {
  it("matches python/gigaam_server.py (run `npm run embed`)", () => {
    const expected = renderEmbeddedPython(readFileSync(sourcePath, "utf8"));
    expect(readFileSync(generatedPath, "utf8")).toBe(expected);
  });
});
