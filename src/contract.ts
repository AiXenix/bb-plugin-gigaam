// Shared by server.ts and host.ts: the host RPC contract, the model list, and
// the OpenAI-compatible transcription call both sides make.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MODELS = ["v3_e2e_rnnt", "v3_e2e_ctc", "v3_rnnt", "v3_ctc"] as const;
export type GigaamModel = (typeof MODELS)[number];

export const MODEL_LABELS: Readonly<Record<GigaamModel, string>> = {
  v3_e2e_rnnt: "e2e RNN-T (best)",
  v3_e2e_ctc: "e2e CTC (faster)",
  v3_rnnt: "RNN-T (no punctuation)",
  v3_ctc: "CTC (no punctuation)",
};

/** Base64 grows audio by a third; host RPC input is capped at 32 MiB. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const phaseSchema = z.enum([
  "idle",
  "installing",
  "starting",
  "ready",
  "failed",
  "unsupported",
]);
export type Phase = z.infer<typeof phaseSchema>;

export const hostStateSchema = z
  .object({
    phase: phaseSchema,
    /** What the host is doing now, or why it stopped. */
    message: z.string(),
    model: z.string().nullable(),
    threads: z.number().int().nullable(),
    port: z.number().int().nullable(),
    dataDir: z.string(),
    platform: z.string(),
  })
  .strict();
export type HostState = z.infer<typeof hostStateSchema>;

export const desiredSchema = z
  .object({
    model: z.enum(MODELS),
    /** 0 lets the server use half the CPU cores, at most 8. */
    threads: z.number().int().min(0).max(64),
  })
  .strict();
export type Desired = z.infer<typeof desiredSchema>;

export const hostContract = defineRpcContract({
  "gigaam.ensure": {
    experimental_description:
      "Install GigaAM if needed and keep its server running with this configuration; returns the current state without waiting.",
    input: desiredSchema
      .extend({ action: z.enum(["ensure", "restart", "reinstall"]) })
      .strict(),
    output: hostStateSchema,
  },
  "gigaam.transcribe": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        filename: z.string().min(1).max(200),
        mimeType: z.string().max(200),
      })
      .strict(),
    output: z.object({ text: z.string() }).strict(),
  },
  "gigaam.logs": {
    input: z.object({ lines: z.number().int().min(1).max(500) }).strict(),
    output: z.object({ text: z.string() }).strict(),
  },
});

/** POST one recording to an OpenAI-compatible /v1/audio/transcriptions endpoint. */
export async function requestTranscription(
  baseUrl: string,
  audio: Blob,
  filename: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", "gigaam");
  form.append("response_format", "json");
  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GigaAM server returned ${response.status}: ${detail}`);
  }
  const body: unknown = await response.json();
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("GigaAM server returned no text");
  return text;
}
