import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { HostState } from "../src/contract.js";
import plugin from "../server.js";

function hostState(overrides: Partial<HostState> = {}): HostState {
  return {
    phase: "ready",
    message: "Serving v3_e2e_rnnt",
    model: "v3_e2e_rnnt",
    threads: 0,
    port: 40000,
    dataDir: "/data/gigaam",
    platform: "linux-x64",
    ...overrides,
  };
}

async function load(options: {
  state?: HostState;
  settings?: Record<string, string | number | boolean>;
  primaryHostId?: string | null;
}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gigaam",
    settings: options.settings,
    sdk: {
      system: {
        config: async () =>
          ({ primaryHostId: options.primaryHostId === undefined ? "host-1" : options.primaryHostId }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "gigaam.ensure") return options.state ?? hostState();
      if (method === "gigaam.transcribe") {
        const { audioBase64 } = input as { audioBase64: string };
        return { text: `heard ${Buffer.from(audioBase64, "base64").toString()}` };
      }
      if (method === "gigaam.logs") return { text: "log tail" };
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(bb);
  const [service] = harness.inspection.registrations.aiServiceRegistrations;
  if (service === undefined) throw new Error("no AI service registered");
  return { harness, service };
}

let external: Server | null = null;
afterEach(async () => {
  await new Promise((resolve) => (external ? external.close(resolve) : resolve(undefined)));
  external = null;
});

describe("GigaAM AI service", () => {
  it("registers a voice-only service", async () => {
    const { service } = await load({});
    expect(service.id).toBe("gigaam");
    expect(service.transcribe).toBeTypeOf("function");
    expect(service.complete).toBeUndefined();
  });

  it("is ready only when the host serves the model", async () => {
    expect(await (await load({})).service.status?.()).toEqual({ ready: true });
    const installing = await load({
      state: hostState({ phase: "installing", message: "Installing PyTorch for CPU (about 200 MB)", port: null }),
    });
    expect(await installing.service.status?.()).toEqual({
      ready: false,
      message: "Installing GigaAM: Installing PyTorch for CPU (about 200 MB). The first install takes a few minutes",
    });
  });

  it("is not ready without a primary machine", async () => {
    const { service } = await load({ primaryHostId: null });
    const status = await service.status?.();
    expect(status?.ready).toBe(false);
  });

  it("sends the recording to the host with the configured model", async () => {
    const { harness, service } = await load({ settings: { model: "v3_e2e_ctc", threads: 4 } });
    const audio = new File(["sound"], "voice.webm", { type: "audio/webm" });
    const text = await service.transcribe?.(audio, { signal: new AbortController().signal, hint: null });
    expect(text).toBe("heard sound");
    await service.status?.();
    const ensure = harness.inspection.experimental_hostRpcCalls.find((call) => call.method === "gigaam.ensure");
    expect(ensure?.input).toEqual({ model: "v3_e2e_ctc", threads: 4, action: "ensure" });
  });

  it("uses an external OpenAI-compatible server when configured", async () => {
    external = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") return response.end(JSON.stringify({ ready: true }));
      request.resume();
      request.on("end", () => response.end(JSON.stringify({ text: "external text" })));
    });
    await new Promise<void>((resolve) => external!.listen(0, "127.0.0.1", resolve));
    const { port } = external.address() as AddressInfo;
    const { harness, service } = await load({ settings: { serverUrl: `http://127.0.0.1:${port}/` } });
    expect(await service.status?.()).toEqual({ ready: true });
    const audio = new File(["sound"], "voice.webm", { type: "audio/webm" });
    expect(await service.transcribe?.(audio, { signal: new AbortController().signal, hint: null })).toBe(
      "external text",
    );
    expect(harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });
});

describe("bb gigaam", () => {
  it("prints the host status", async () => {
    const { harness } = await load({});
    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status:    ready (Serving v3_e2e_rnnt)");
    expect(result.stdout).toContain("Server:    http://127.0.0.1:40000");
  });

  it("asks the host to reinstall", async () => {
    const { harness } = await load({ state: hostState({ phase: "installing", message: "Installing Python 3.12" }) });
    const result = await harness.behavior.runCli(["reinstall"]);
    expect(result.exitCode).toBe(0);
    const calls = harness.inspection.experimental_hostRpcCalls.map((call) => call.input);
    expect(calls).toContainEqual({ model: "v3_e2e_rnnt", threads: 0, action: "reinstall" });
  });

  it("refuses to manage an external server", async () => {
    const { harness } = await load({ settings: { serverUrl: "http://gpu-box:8765" } });
    const result = await harness.behavior.runCli(["restart"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("external server");
  });
});
