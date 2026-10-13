import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { Supervisor } from "../src/supervisor.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gigaam-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Supervisor", () => {
  it("reports an unsupported platform without installing anything", async () => {
    const supervisor = new Supervisor(await tempDir(), "win32", "x64");
    const state = await supervisor.ensure({ model: "v3_e2e_rnnt", threads: 0 }, "ensure");
    expect(state.phase).toBe("unsupported");
    expect(state.platform).toBe("win32-x64");
    await expect(
      supervisor.transcribe(Buffer.from("x"), "a.webm", "audio/webm", new AbortController().signal),
    ).rejects.toThrow(/not ready/);
    await supervisor.dispose();
  });
});

describe("host entry", () => {
  it("returns an empty log before the first install", async () => {
    const dataDir = await tempDir();
    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: { dataDir, tempDir: await tempDir() },
    });
    expect(await harness.experimental_call("gigaam.logs", { lines: 10 })).toEqual({ text: "No logs yet." });
    await expect(
      harness.experimental_call("gigaam.transcribe", {
        audioBase64: Buffer.from("x").toString("base64"),
        filename: "a.webm",
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/not ready/);
    await harness.experimental_dispose();
  });
});

describe("Supervisor.ensure", () => {
  it("serializes overlapping calls so only one run starts", async () => {
    const supervisor = new Supervisor(await tempDir(), "linux", "x64");
    const starts: string[] = [];
    // Count runs instead of installing anything.
    (supervisor as unknown as { installAndStart: () => Promise<void> }).installAndStart = () => {
      starts.push("run");
      return new Promise(() => {});
    };
    const desired = { model: "v3_e2e_rnnt", threads: 0 } as const;
    const states = await Promise.all([
      supervisor.ensure(desired, "ensure"),
      supervisor.ensure(desired, "ensure"),
      supervisor.ensure(desired, "ensure"),
    ]);
    expect(starts).toEqual(["run"]);
    expect(states.map((state) => state.phase)).toEqual(["starting", "starting", "starting"]);
  });
});

