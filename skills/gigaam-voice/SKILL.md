---
name: gigaam-voice
description: Check, configure, or troubleshoot bb voice input served by the GigaAM v3 plugin (bb gigaam), including its self-managed install and server.
---

# GigaAM voice input

The `gigaam` plugin registers the **GigaAM v3** voice input service. Its host
entry installs GigaAM into the plugin's host data directory on the bb server's
machine (uv, Python 3.12, CPU PyTorch, model checkpoints). It runs the model
as a loopback HTTP server and restarts that server when needed.

## Check and operate

```sh
bb gigaam status            # phase: installing | starting | ready | failed | unsupported
bb gigaam logs --lines 80   # install.log and server.log tails
bb gigaam restart           # reload the model
bb gigaam reinstall         # rebuild the Python environment (takes minutes)
bb settings ai-services show
bb settings ai-services set voice gigaam
bb voice transcribe <audio-file>   # end-to-end test through bb
```

`restart` and `reinstall` return at once. Poll `bb gigaam status` until it
reports `ready` or `failed`.

## Settings

`bb plugin config gigaam set <key> <value>`:

- `model`: `v3_e2e_rnnt` (default, punctuation), `v3_e2e_ctc` (faster), or
  `v3_rnnt` / `v3_ctc` (no punctuation). A new model downloads about 450 MB
  on first use.
- `threads`: CPU threads; `0` uses half the cores, at most 8.
- `serverUrl`: an external OpenAI-compatible `/v1/audio/transcriptions`
  server. When set, the plugin stops managing a local install, and
  `restart` / `reinstall` refuse to run.

## Constraints

- The model recognizes Russian only. bb's vocabulary hint is ignored.
- The managed server needs Linux (x64 or arm64) or macOS on Apple silicon,
  about 2 GB of disk, and 1.5 GB of RAM.
- Recordings must be 20 MB or smaller. Audio over 20 s is split at pauses.
  Recognition takes about 7 s of CPU time per minute of audio.
- A failed install retries on its own with backoff, up to one hour.
  `bb gigaam reinstall` retries at once.
- `bb plugin remove gigaam` does not delete the downloaded environment.
  Delete the `Data dir` from `bb gigaam status` to free the space.
