import { afterEach, describe, expect, it, vi } from "vitest";
import { requestTranscription } from "../src/contract.js";

afterEach(() => vi.unstubAllGlobals());

describe("transcription errors", () => {
  const audio = new Blob(["test recording"], { type: "audio/mp4" });
  const call = () => requestTranscription("http://127.0.0.1:1234", audio, "voice.mp4", new AbortController().signal);

  it("replaces old decoder JSON and process addresses with recording guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Could not decode audio: [in#0 @ 0x1234] Invalid data found when processing input" }), { status: 400 })));
    const error = await call().catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Запишите сообщение заново");
    expect((error as Error).message).not.toMatch(/0x1234|\{"detail"/);
  });

  it("shows the new managed server's readable detail without raw JSON", async () => {
    const message = "Запись повреждена или не завершена. Запишите сообщение заново.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: message }), { status: 400 })));
    await expect(call()).rejects.toThrow(message);
  });

  it("does not expose arbitrary HTML from an external server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>internal upstream details</html>", { status: 502 })));
    const error = await call().catch(value => value as Error);
    expect((error as Error).message).toContain("HTTP 502");
    expect((error as Error).message).not.toContain("internal upstream");
  });

  it("explains upload limits and decoder timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("too big", { status: 413 })));
    await expect(call()).rejects.toThrow("более короткое сообщение");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("timeout", { status: 504 })));
    await expect(call()).rejects.toThrow("слишком много времени");
  });
});
