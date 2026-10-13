// bb-plugin-gigaam host entry: runs on the machine that does the recognition
// (the bb server's own machine) and owns the GigaAM install and process.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./src/contract.js";
import { Supervisor } from "./src/supervisor.js";

let supervisor: Supervisor | null = null;
/** Keeps the worker (and so the loaded model) alive between voice inputs. */
let lease: { dispose(): Promise<void> } | null = null;

function supervisorFor(dataDir: string): Supervisor {
  supervisor ??= new Supervisor(dataDir);
  return supervisor;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "gigaam.ensure": async ({ action, model, threads }, context) => {
      lease ??= context.experimental_retainWorker();
      return supervisorFor(context.experimental_paths.dataDir).ensure(
        { model, threads },
        action,
      );
    },
    "gigaam.transcribe": async ({ audioBase64, filename, mimeType }, context) => {
      const text = await supervisorFor(context.experimental_paths.dataDir).transcribe(
        Buffer.from(audioBase64, "base64"),
        filename,
        mimeType,
        context.signal,
      );
      return { text };
    },
    "gigaam.logs": async ({ lines }, context) => ({
      text: await supervisorFor(context.experimental_paths.dataDir).logs(lines),
    }),
  },
  dispose: async () => {
    await supervisor?.dispose();
    await lease?.dispose();
  },
});
