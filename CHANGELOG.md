# Changelog

## 0.1.2

- Meetings moved to its own repository, [AiXenix/bb-plugin-meetings](https://github.com/AiXenix/bb-plugin-meetings), together with its `meeting-bb-aixenix` skill.
- This plugin ships the `gigaam-voice` skill again.

## 0.1.1

- The agent skill is now **`meeting-bb-aixenix`**. It replaces `gigaam-voice` and covers both GigaAM voice input and the Meetings notetaker.
- The repository now also hosts the **Meetings** plugin in `plugins/meetings`, released with `meetings/vX.Y.Z` tags. Install it with `--subdirectory plugins/meetings --tag-prefix meetings/`.

## 0.1.0

- First release: the GigaAM v3 voice input service for bb.
- Self-managed install on first load: uv 0.13.0, Python 3.12, torch 2.14.1 (CPU), and GigaAM `7447938`.
- Loopback FastAPI server with an OpenAI-compatible `/v1/audio/transcriptions` endpoint. It splits long recordings at pauses.
- Settings for `model`, `threads`, and an external `serverUrl`.
- `bb gigaam status | logs | restart | reinstall`.
