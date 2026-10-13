// bb-plugin-gigaam — Russian voice input for bb through GigaAM v3.
//
// By default the host entry (host.ts) installs GigaAM on the bb server's own
// machine and keeps it running; this file registers the voice service, keeps
// the host in the configured state, and adds the `bb gigaam` command. With
// the "GigaAM server URL" setting, recordings go to that server instead.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MAX_AUDIO_BYTES,
  MODELS,
  MODEL_LABELS,
  hostContract,
  requestTranscription,
  type Desired,
  type HostState,
} from "./src/contract.js";

const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_RETRY_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
/** bb waits up to 70 s for a transcript. */
const TRANSCRIBE_TIMEOUT_MS = 65_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "select",
      label: "Model",
      description:
        "GigaAM v3 checkpoint. e2e models add punctuation and normalize numbers; e2e CTC is about 1.5x faster than e2e RNN-T. A new model downloads (about 450 MB) on first use.",
      options: [...MODELS],
      experimental_optionLabels: { ...MODEL_LABELS },
      default: "v3_e2e_rnnt",
    },
    threads: {
      type: "number",
      label: "CPU threads",
      description: "Threads for recognition. 0 uses half the CPU cores, at most 8.",
      experimental_schema: z.number().int().min(0).max(64),
      default: 0,
    },
    serverUrl: {
      type: "string",
      label: "GigaAM server URL",
      description:
        "Leave empty to install and run GigaAM on the bb server's machine. Set an OpenAI-compatible server (it must serve /v1/audio/transcriptions) to use it instead, for example GigaAM on a GPU machine.",
      experimental_schema: z
        .string()
        .refine(
          (value) => value.trim() === "" || /^https?:\/\/\S+$/.test(value.trim()),
          "Use an http:// or https:// URL, or leave it empty",
        ),
      default: "",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function config(): Promise<{ desired: Desired; serverUrl: string | null }> {
    const values = await settings.get();
    const serverUrl = values.serverUrl.trim().replace(/\/+$/, "");
    return {
      desired: { model: values.model as Desired["model"], threads: values.threads },
      serverUrl: serverUrl === "" ? null : serverUrl,
    };
  }

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  async function ensure(
    action: "ensure" | "restart" | "reinstall",
    signal?: AbortSignal,
    timeoutMs = STATUS_TIMEOUT_MS,
  ): Promise<HostState> {
    const hostId = await primaryHostId();
    if (hostId === null) throw new Error("No primary machine is connected to bb");
    const { desired } = await config();
    return host.call("gigaam.ensure", { ...desired, action }, { hostId, signal, timeoutMs });
  }

  bb.experimental_aiServices.register({
    id: "gigaam",
    displayName: "GigaAM v3",
    async transcribe(audio, { signal }) {
      if (audio.size > MAX_AUDIO_BYTES) {
        throw new Error("Recordings over 20 MB are too large for GigaAM");
      }
      const filename = audio.name || "voice-input.webm";
      const { serverUrl } = await config();
      if (serverUrl !== null) {
        return requestTranscription(serverUrl, audio, filename, signal);
      }
      const hostId = await primaryHostId();
      if (hostId === null) throw new Error("No primary machine is connected to bb");
      const { text } = await host.call(
        "gigaam.transcribe",
        {
          audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
          filename,
          mimeType: audio.type,
        },
        { hostId, signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
      );
      return text;
    },
    async status() {
      const { serverUrl } = await config();
      if (serverUrl !== null) {
        return (await externalHealthy(serverUrl))
          ? { ready: true }
          : { ready: false, message: `GigaAM server at ${serverUrl} is not reachable` };
      }
      try {
        const state = await ensure("ensure");
        return state.phase === "ready"
          ? { ready: true }
          : { ready: false, message: describe(state) };
      } catch (error) {
        return { ready: false, message: `GigaAM host is unavailable: ${errorMessage(error)}` };
      }
    },
  });

  // Keep the host converged on the settings: install on first load, apply a
  // model change, and recover after the host worker or machine restarts.
  let wake: (() => void) | null = null;
  const wakeReconcile = () => wake?.();
  settings.onChange(wakeReconcile);
  host.experimental_onWorkerExit(wakeReconcile);
  let lastProblem: string | null = null;
  bb.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        let delay = RECONCILE_INTERVAL_MS;
        try {
          if ((await config()).serverUrl === null) {
            const state = await ensure("ensure", signal);
            const problem = state.phase === "failed" || state.phase === "unsupported"
              ? describe(state)
              : null;
            if (problem !== null && problem !== lastProblem) bb.log.warn(problem);
            lastProblem = problem;
          }
        } catch (error) {
          if (signal.aborted) break;
          const problem = `Could not reach the GigaAM host: ${errorMessage(error)}`;
          if (problem !== lastProblem) bb.log.warn(problem);
          lastProblem = problem;
          delay = RECONCILE_RETRY_MS;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          wake = done;
          signal.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = null;
            resolve();
          }
        });
      }
    },
  });

  bb.cli.register(
    defineCli({
      name: "gigaam",
      summary: "Check and manage GigaAM v3 voice input",
      commands: {
        status: cliCommand({
          summary: "Show whether GigaAM is installed, running, and ready",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const { desired, serverUrl } = await config();
            if (serverUrl !== null) {
              const ready = await externalHealthy(serverUrl);
              const result = { mode: "external", serverUrl, ready };
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(result)
                  : `External GigaAM server ${serverUrl}: ${ready ? "ready" : "not reachable"}`,
              };
            }
            const state = await ensure("ensure");
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ mode: "managed", ...state }) };
            }
            return {
              exitCode: 0,
              stdout: [
                `Status:    ${state.phase} (${state.message})`,
                `Model:     ${state.model ?? desired.model}`,
                `Threads:   ${desired.threads === 0 ? "auto" : desired.threads}`,
                `Platform:  ${state.platform}`,
                `Data dir:  ${state.dataDir}`,
                state.port === null ? null : `Server:    http://127.0.0.1:${state.port}`,
              ]
                .filter((line) => line !== null)
                .join("\n"),
            };
          },
        }),
        restart: cliCommand({
          summary: "Restart the GigaAM server (reloads the model)",
          async run() {
            const state = await requireManaged(() => ensure("restart"));
            return { exitCode: 0, stdout: `${describe(state)}\nFollow progress with: bb gigaam status` };
          },
        }),
        reinstall: cliCommand({
          summary: "Rebuild the Python environment from scratch, then start GigaAM",
          async run() {
            const state = await requireManaged(() => ensure("reinstall", undefined, 30_000));
            return {
              exitCode: 0,
              stdout: `${describe(state)}\nThis takes a few minutes. Follow progress with: bb gigaam status`,
            };
          },
        }),
        logs: cliCommand({
          summary: "Print the tail of the install and server logs",
          options: {
            lines: {
              type: "integer",
              min: 1,
              max: 500,
              default: 40,
              aliases: ["tail"],
              description: "Lines per log, 1-500",
            },
          },
          async run(input) {
            const lines = input.options.lines;
            const hostId = await primaryHostId();
            if (hostId === null) {
              throw new PluginCliError("No primary machine is connected to bb", {
                code: "no_primary_host",
              });
            }
            const { text } = await host.call("gigaam.logs", { lines }, { hostId, timeoutMs: STATUS_TIMEOUT_MS });
            return { exitCode: 0, stdout: text };
          },
        }),
      },
    }),
  );

  async function requireManaged(run: () => Promise<HostState>): Promise<HostState> {
    if ((await config()).serverUrl !== null) {
      throw new PluginCliError("GigaAM runs on an external server, so this plugin does not manage it", {
        code: "external_server",
        hint: "Clear it with: bb plugin config gigaam set serverUrl ''",
      });
    }
    return run();
  }
}

function describe(state: HostState): string {
  switch (state.phase) {
    case "ready":
      return `GigaAM is ready (${state.message})`;
    case "installing":
      return `Installing GigaAM: ${state.message}. The first install takes a few minutes`;
    case "starting":
      return `Starting GigaAM: ${state.message}`;
    case "failed":
      return `GigaAM setup failed: ${state.message}. Retry with: bb gigaam reinstall`;
    case "unsupported":
      return `GigaAM cannot run on this machine: ${state.message}`;
    case "idle":
      return "GigaAM has not started yet";
  }
}

/** Any HTTP answer counts: other OpenAI-compatible servers may lack /health. */
async function externalHealthy(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
