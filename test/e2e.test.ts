// Real install + transcription. Downloads about 1.5 GB on the first run, so it
// only runs with GIGAAM_E2E=1. Set GIGAAM_E2E_DIR to reuse an install.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Supervisor } from "../src/supervisor.js";

const SAMPLE_URL = "https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/example.wav";

async function waitFor(supervisor: Supervisor, phase: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const state = await supervisor.ensure({ model: "v3_e2e_rnnt", threads: 0 }, "ensure");
    if (`${state.phase}: ${state.message}` !== last) {
      last = `${state.phase}: ${state.message}`;
      console.log(new Date().toISOString(), last);
    }
    if (state.phase === phase) return state;
    if (state.phase === "failed") throw new Error(state.message);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${phase}; last state ${last}`);
}

describe.runIf(process.env.GIGAAM_E2E === "1")("end to end", () => {
  it("installs GigaAM, transcribes Russian speech, and restarts", async () => {
    const dataDir = process.env.GIGAAM_E2E_DIR ?? path.join(tmpdir(), "gigaam-e2e");
    await mkdir(dataDir, { recursive: true });
    const samplePath = path.join(dataDir, "example.wav");
    const sample = await readFile(samplePath).catch(async () => {
      const response = await fetch(SAMPLE_URL);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(samplePath, bytes);
      return bytes;
    });
    const supervisor = new Supervisor(dataDir);
    try {
      const started = Date.now();
      const ready = await waitFor(supervisor, "ready", 30 * 60_000);
      console.log(`ready after ${Math.round((Date.now() - started) / 1000)} s on port ${ready.port}`);
      const text = await supervisor.transcribe(sample, "example.wav", "audio/wav", AbortSignal.timeout(60_000));
      console.log(text);
      expect(text).toContain("лукоморья");

      const restarted = await supervisor.ensure({ model: "v3_e2e_rnnt", threads: 2 }, "ensure");
      expect(restarted.phase).toBe("starting");
      expect(restarted.threads).toBe(2);
    } finally {
      await supervisor.dispose();
    }
  }, 40 * 60_000);
});
