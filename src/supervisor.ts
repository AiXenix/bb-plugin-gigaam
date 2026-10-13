// Host-side lifecycle of the GigaAM server: install a private Python
// environment with uv, start gigaam_server.py on a free loopback port, keep it
// running, and restart it when the configuration changes or it crashes.
// Everything lives in the plugin's host data directory; nothing touches the
// system Python or needs root.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  requestTranscription,
  type Desired,
  type HostState,
  type Phase,
} from "./contract.js";
import { GIGAAM_SERVER_PY } from "./generated/gigaam-server-py.js";
import {
  INSTALL_SPEC_ID,
  PYTHON_VERSION,
  SERVER_PACKAGES,
  TORCH_PACKAGES,
  platformSupport,
  type PlatformSupport,
} from "./platform.js";

const HEALTH_POLL_MS = 1_000;
/** First start downloads the checkpoint (~450 MB); allow slow links. */
const STARTUP_TIMEOUT_MS = 30 * 60_000;
const STOP_GRACE_MS = 3_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
/** Output lines quoted in a failure message; the full output is in the logs. */
const OUTPUT_TAIL_LINES = 3;

interface Paths {
  readonly root: string;
  readonly bin: string;
  readonly uv: string;
  readonly venv: string;
  readonly python: string;
  readonly pythonInstalls: string;
  readonly cache: string;
  readonly models: string;
  readonly logs: string;
  readonly installLog: string;
  readonly serverLog: string;
  readonly serverScript: string;
  readonly marker: string;
}

function pathsFor(root: string): Paths {
  const venv = path.join(root, "venv");
  const logs = path.join(root, "logs");
  return {
    root,
    bin: path.join(root, "bin"),
    uv: path.join(root, "bin", "uv"),
    venv,
    python: path.join(venv, "bin", "python"),
    pythonInstalls: path.join(root, "python"),
    cache: path.join(root, "cache"),
    models: path.join(root, "models"),
    logs,
    installLog: path.join(logs, "install.log"),
    serverLog: path.join(logs, "server.log"),
    serverScript: path.join(root, "gigaam_server.py"),
    marker: path.join(root, "install.json"),
  };
}

type Action = "ensure" | "restart" | "reinstall";

export class Supervisor {
  private readonly paths: Paths;
  private readonly support: PlatformSupport;
  private phase: Phase = "idle";
  private message = "Waiting for the first request from bb";
  private desired: Desired | null = null;
  /** Configuration of the running (or starting) server process. */
  private active: Desired | null = null;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private run: { controller: AbortController; done: Promise<void> } | null = null;
  private failures = 0;
  private retryAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch,
  ) {
    this.paths = pathsFor(dataDir);
    this.support = platformSupport(platform, arch);
    if (!this.support.supported) {
      this.phase = "unsupported";
      this.message = this.support.reason;
    }
  }

  state(): HostState {
    return {
      phase: this.phase,
      message: this.message,
      model: this.active?.model ?? this.desired?.model ?? null,
      threads: this.active?.threads ?? this.desired?.threads ?? null,
      port: this.phase === "ready" ? this.port : null,
      dataDir: this.paths.root,
      platform: `${this.platform}-${this.arch}`,
    };
  }

  /**
   * Converge on `desired` without waiting for the install or startup.
   * Calls are serialized: status polls and setting changes can overlap, and
   * two interleaved restarts would otherwise launch two servers.
   */
  ensure(desired: Desired, action: Action): Promise<HostState> {
    const next = this.queue.then(() => this.ensureNow(desired, action));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureNow(desired: Desired, action: Action): Promise<HostState> {
    if (this.disposed || !this.support.supported) return this.state();
    this.desired = desired;
    const changed =
      this.active !== null &&
      (this.active.model !== desired.model || this.active.threads !== desired.threads);
    if (action === "reinstall" || action === "restart" || changed) {
      await this.cancelRun();
      await this.stopChild();
      this.failures = 0;
      this.retryAt = 0;
      if (action === "reinstall") {
        this.setPhase("installing", "Removing the previous Python environment");
        await fs.rm(this.paths.venv, { recursive: true, force: true });
        await fs.rm(this.paths.marker, { force: true });
      }
    }
    if (this.run !== null || this.child !== null) return this.state();
    if (this.phase === "failed" && Date.now() < this.retryAt) return this.state();
    this.startRun(desired);
    return this.state();
  }

  async transcribe(
    audio: Buffer,
    filename: string,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.phase !== "ready" || this.port === null) {
      throw new Error(`GigaAM is not ready: ${this.message}`);
    }
    const blob = new Blob([new Uint8Array(audio)], {
      type: mimeType || "application/octet-stream",
    });
    return requestTranscription(`http://127.0.0.1:${this.port}`, blob, filename, signal);
  }

  async logs(lines: number): Promise<string> {
    const sections: string[] = [];
    for (const [title, file] of [
      ["install.log", this.paths.installLog],
      ["server.log", this.paths.serverLog],
    ] as const) {
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      const tail = text.trimEnd().split("\n").slice(-lines).join("\n");
      sections.push(`== ${file} (last ${lines} lines)\n${tail}`);
    }
    return sections.length > 0 ? sections.join("\n\n") : "No logs yet.";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelRun();
    await this.stopChild();
  }

  // ── run: install, then start the server ──────────────────────────────

  private startRun(desired: Desired): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.setPhase("starting", "Preparing GigaAM");
    const controller = new AbortController();
    const done = this.installAndStart(desired, controller.signal)
      .then(() => {
        this.failures = 0;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.failures += 1;
        const delay = Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** (this.failures - 1));
        this.retryAt = Date.now() + delay;
        this.setPhase("failed", errorMessage(error));
      })
      .finally(() => {
        if (this.run?.controller === controller) this.run = null;
      });
    this.run = { controller, done };
  }

  private async cancelRun(): Promise<void> {
    const run = this.run;
    if (run === null) return;
    run.controller.abort();
    await run.done;
  }

  private async installAndStart(desired: Desired, signal: AbortSignal): Promise<void> {
    await fs.mkdir(this.paths.logs, { recursive: true });
    if (!(await this.installed())) await this.install(signal);
    signal.throwIfAborted();
    await this.start(desired, signal);
  }

  private async installed(): Promise<boolean> {
    const marker = await fs.readFile(this.paths.marker, "utf8").catch(() => null);
    if (marker === null || !existsSync(this.paths.python)) return false;
    try {
      return (JSON.parse(marker) as { spec?: unknown }).spec === INSTALL_SPEC_ID;
    } catch {
      return false;
    }
  }

  private async install(signal: AbortSignal): Promise<void> {
    if (!this.support.supported) throw new Error(this.support.reason);
    const log = await openLog(this.paths.installLog);
    try {
      log.write(`\n=== install ${INSTALL_SPEC_ID} at ${new Date().toISOString()}\n`);
      const uv = await this.ensureUv(log, signal);
      const env = {
        ...process.env,
        UV_CACHE_DIR: this.paths.cache,
        UV_PYTHON_INSTALL_DIR: this.paths.pythonInstalls,
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_NO_PROGRESS: "1",
      };
      await fs.rm(this.paths.venv, { recursive: true, force: true });
      this.setPhase("installing", `Installing Python ${PYTHON_VERSION}`);
      await runLogged(uv, ["venv", "--python", PYTHON_VERSION, this.paths.venv], env, log, signal);
      this.setPhase("installing", "Installing PyTorch for CPU (about 200 MB)");
      await runLogged(
        uv,
        ["pip", "install", "--python", this.paths.python, ...this.support.torchIndexArgs, ...TORCH_PACKAGES],
        env,
        log,
        signal,
      );
      this.setPhase("installing", "Installing GigaAM and its server");
      await runLogged(
        uv,
        ["pip", "install", "--python", this.paths.python, ...SERVER_PACKAGES],
        env,
        log,
        signal,
      );
      await fs.writeFile(
        this.paths.marker,
        JSON.stringify({ spec: INSTALL_SPEC_ID, installedAt: new Date().toISOString() }),
      );
      log.write("=== install complete\n");
    } finally {
      await closeLog(log);
    }
  }

  private async ensureUv(log: WriteStream, signal: AbortSignal): Promise<string> {
    if (!this.support.supported) throw new Error(this.support.reason);
    if (existsSync(this.paths.uv)) return this.paths.uv;
    const { url, sha256, target } = this.support.uv;
    this.setPhase("installing", "Downloading the uv package manager");
    log.write(`downloading ${url}\n`);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Downloading uv failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== sha256) {
      throw new Error(`uv download checksum mismatch: expected ${sha256}, got ${actual}`);
    }
    const staging = path.join(this.paths.root, "uv-download");
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const archivePath = path.join(staging, "uv.tar.gz");
    await fs.writeFile(archivePath, archive);
    await runLogged("tar", ["-xzf", archivePath, "-C", staging], process.env, log, signal);
    await fs.mkdir(this.paths.bin, { recursive: true });
    await fs.rename(path.join(staging, `uv-${target}`, "uv"), this.paths.uv);
    await fs.chmod(this.paths.uv, 0o755);
    await fs.rm(staging, { recursive: true, force: true });
    return this.paths.uv;
  }

  // ── server process ───────────────────────────────────────────────────

  private async start(desired: Desired, signal: AbortSignal): Promise<void> {
    const current = await fs.readFile(this.paths.serverScript, "utf8").catch(() => null);
    if (current !== GIGAAM_SERVER_PY) {
      await fs.writeFile(this.paths.serverScript, GIGAAM_SERVER_PY);
    }
    const cached = existsSync(path.join(this.paths.models, `${desired.model}.ckpt`));
    this.setPhase(
      "starting",
      cached
        ? `Loading the ${desired.model} model`
        : `Downloading the ${desired.model} model (about 450 MB) and loading it`,
    );
    await rotate(this.paths.serverLog);
    const log = await openLog(this.paths.serverLog);
    log.write(`\n=== start ${desired.model} at ${new Date().toISOString()}\n`);
    const port = await freePort();
    const child = spawn(
      this.paths.python,
      [
        this.paths.serverScript,
        "--host", "127.0.0.1",
        "--port", String(port),
        "--model", desired.model,
        "--threads", String(desired.threads),
        "--models-dir", this.paths.models,
        "--parent-pid", String(process.pid),
      ],
      {
        cwd: this.paths.root,
        // TQDM_DISABLE keeps the checkpoint download bar out of the log.
        env: { ...process.env, PYTHONUNBUFFERED: "1", TQDM_DISABLE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    this.child = child;
    this.port = port;
    this.active = desired;
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code, signal) =>
        resolve(signal === null ? `code ${code}` : `signal ${signal}`),
      );
      child.once("error", (error) => resolve(`error: ${error.message}`));
    });
    void exited.then((how) => {
      log.write(`=== exited with ${how}\n`);
      void closeLog(log);
      this.onChildExit(child, how);
    });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (this.child !== child) {
        throw new Error(
          "The GigaAM server exited during startup; run `bb gigaam logs` for details",
        );
      }
      if (await healthy(port, signal)) {
        this.setPhase("ready", `Serving ${desired.model}`);
        return;
      }
      await sleep(HEALTH_POLL_MS, signal);
    }
    await this.stopChild();
    throw new Error("GigaAM server did not become ready in 30 minutes");
  }

  private onChildExit(child: ChildProcess, how: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.port = null;
    this.active = null;
    if (this.disposed || this.phase !== "ready" || this.desired === null) return;
    // Crashed after it was serving: start again after a short pause.
    this.failures += 1;
    const delay = Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** (this.failures - 1));
    this.setPhase("starting", `Restarting after the server exited with ${how}`);
    const desired = this.desired;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed && this.run === null && this.child === null) this.startRun(desired);
    }, delay);
  }

  private async stopChild(): Promise<void> {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.port = null;
    this.active = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  private setPhase(phase: Phase, message: string): void {
    this.phase = phase;
    this.message = message;
  }
}

// ── helpers ────────────────────────────────────────────────────────────

async function openLog(file: string): Promise<WriteStream> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  return createWriteStream(file, { flags: "a" });
}

function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve) => log.end(resolve));
}

async function rotate(file: string): Promise<void> {
  const stat = await fs.stat(file).catch(() => null);
  if (stat !== null && stat.size > LOG_ROTATE_BYTES) {
    await fs.rename(file, `${file}.1`);
  }
}

/** Run a command, appending its output to `log`; reject with the output tail. */
function runLogged(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: WriteStream,
  signal: AbortSignal,
): Promise<void> {
  log.write(`$ ${command} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, signal, stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    const collect = (chunk: Buffer) => {
      log.write(chunk);
      tail.push(...chunk.toString("utf8").split("\n").filter((line) => line.trim() !== ""));
      tail.splice(0, Math.max(0, tail.length - OUTPUT_TAIL_LINES));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args[0]} failed (exit ${code}): ${tail.join("\n")}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("Could not reserve a loopback port")),
      );
    });
  });
}

async function healthy(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
