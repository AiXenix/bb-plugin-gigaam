# Changelog

## 0.1.0

- First release: the GigaAM v3 voice input service for bb.
- Self-managed install on first load: uv 0.13.0, Python 3.12, torch 2.14.1 (CPU), and GigaAM `7447938`.
- Loopback FastAPI server with an OpenAI-compatible `/v1/audio/transcriptions` endpoint. It splits long recordings at pauses.
- Settings for `model`, `threads`, and an external `serverUrl`.
- `bb gigaam status | logs | restart | reinstall`.
