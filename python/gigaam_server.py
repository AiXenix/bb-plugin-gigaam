"""GigaAM v3 speech-to-text server used by bb-plugin-gigaam.

The plugin's host entry installs this file into its data directory and runs it
with the plugin-managed Python environment. It can also run on its own:

    python gigaam_server.py --port 8765 --model v3_e2e_rnnt

Endpoints:
  GET  /health                     -> {"ready": true, "model": "...", ...}
  POST /v1/audio/transcriptions    -> {"text": "..."} (OpenAI-compatible multipart)

GigaAM's own `transcribe` accepts at most 25 s of audio, so longer recordings
are split at the quietest point near each 20 s boundary and decoded as one
batch.
"""

import argparse
import logging
import os
import shutil
import subprocess
import sys
import threading
import time

SAMPLE_RATE = 16000
MAX_CHUNK_S = 20.0
MIN_CHUNK_S = 12.0
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
FFMPEG_TIMEOUT_S = 120

log = logging.getLogger("gigaam-server")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="v3_e2e_rnnt")
    parser.add_argument("--threads", type=int, default=0, help="0 = half the CPU cores")
    parser.add_argument("--models-dir", default=None, help="GigaAM checkpoint cache")
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="Exit when this process is gone (set by the bb plugin)",
    )
    return parser.parse_args()


def default_threads() -> int:
    return max(1, min(8, (os.cpu_count() or 2) // 2))


def find_ffmpeg() -> str:
    system = shutil.which("ffmpeg")
    if system:
        return system
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def watch_parent(parent_pid: int) -> None:
    """Exit if the bb host worker that started us disappears."""

    def loop() -> None:
        while True:
            time.sleep(2)
            if os.getppid() != parent_pid:
                log.warning("parent process %d is gone; exiting", parent_pid)
                os._exit(0)

    threading.Thread(target=loop, name="parent-watch", daemon=True).start()


def build_app(args: argparse.Namespace):
    import torch
    import torch.nn.functional as F
    from fastapi import FastAPI, File, Form, HTTPException, UploadFile
    from fastapi.responses import PlainTextResponse

    import gigaam

    threads = args.threads if args.threads > 0 else default_threads()
    torch.set_num_threads(threads)
    ffmpeg = find_ffmpeg()
    log.info("loading %s with %d threads (ffmpeg: %s)", args.model, threads, ffmpeg)
    started = time.monotonic()
    model = gigaam.load_model(args.model, device="cpu", download_root=args.models_dir)
    log.info("model loaded in %.1fs", time.monotonic() - started)
    lock = threading.Lock()
    app = FastAPI(title="GigaAM v3", docs_url=None, redoc_url=None)

    def decode_audio(data: bytes) -> "torch.Tensor":
        cmd = [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", str(SAMPLE_RATE),
            "pipe:1",
        ]
        proc = subprocess.run(cmd, input=data, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
        if proc.returncode != 0:
            detail = proc.stderr.decode(errors="replace").strip()[-300:]
            raise HTTPException(400, f"Could not decode audio: {detail or 'ffmpeg failed'}")
        pcm = bytearray(proc.stdout)
        pcm = pcm[: len(pcm) - len(pcm) % 2]
        if not pcm:
            return torch.zeros(0)
        return torch.frombuffer(pcm, dtype=torch.int16).float() / 32768.0

    def split_points(wav: "torch.Tensor") -> list:
        """Cut audio into <= MAX_CHUNK_S pieces at the quietest 10 ms frame."""
        total = wav.numel()
        max_len = int(MAX_CHUNK_S * SAMPLE_RATE)
        if total <= max_len:
            return [(0, total)]
        hop = SAMPLE_RATE // 100
        frames = wav[: total - total % hop].view(-1, hop)
        energy = frames.pow(2).mean(dim=1)
        # Smooth over ~200 ms so a cut lands inside a pause, not mid-syllable.
        energy = F.avg_pool1d(energy.view(1, 1, -1), 21, stride=1, padding=10).view(-1)
        chunks, start = [], 0
        while total - start > max_len:
            lo = (start + int(MIN_CHUNK_S * SAMPLE_RATE)) // hop
            hi = (start + max_len) // hop
            cut = (lo + int(torch.argmin(energy[lo:hi]))) * hop
            chunks.append((start, cut))
            start = cut
        chunks.append((start, total))
        return chunks

    @torch.inference_mode()
    def transcribe_wav(wav: "torch.Tensor") -> str:
        if wav.numel() < SAMPLE_RATE // 10:
            return ""
        pieces = [wav[a:b] for a, b in split_points(wav)]
        lengths = torch.tensor([p.numel() for p in pieces])
        batch = torch.zeros(len(pieces), int(lengths.max()))
        for i, piece in enumerate(pieces):
            batch[i, : piece.numel()] = piece
        with lock:
            encoded, encoded_len = model.forward(batch, lengths)
            decoded = model._decode(encoded, encoded_len, lengths)
        return " ".join(text.strip() for text, _ in decoded if text.strip())

    @app.get("/health")
    def health() -> dict:
        return {"ready": True, "model": args.model, "threads": threads}

    @app.post("/v1/audio/transcriptions")
    def transcriptions(
        file: UploadFile = File(...),
        response_format: str = Form("json"),
    ):
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio exceeds 25 MB")
        if not data:
            raise HTTPException(400, "Audio file is empty")
        started = time.monotonic()
        wav = decode_audio(data)
        text = transcribe_wav(wav)
        log.info(
            "transcribed %.1fs of audio in %.2fs (%d chars)",
            wav.numel() / SAMPLE_RATE, time.monotonic() - started, len(text),
        )
        if response_format == "text":
            return PlainTextResponse(text)
        return {"text": text}

    return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    args = parse_args()
    if args.parent_pid:
        watch_parent(args.parent_pid)
    app = build_app(args)

    import uvicorn

    log.info("listening on http://%s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
