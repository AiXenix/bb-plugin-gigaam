"""Decoder tests use only the standard library; no Torch/model is imported."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from gigaam_server import AudioDecodeError, decode_pcm


class DecodeLifecycleTests(unittest.TestCase):
    def decoder_result(self, returncode=0, stdout=b"\x00\x00", stderr=b""):
        return subprocess.CompletedProcess([], returncode, stdout, stderr)

    def test_success_uses_private_seekable_file_and_cleans_it(self):
        paths = []

        def run(command, **kwargs):
            path = Path(command[command.index("-i") + 1])
            paths.append(path)
            self.assertEqual(path.read_bytes(), b"test-upload")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertNotIn("input", kwargs)
            # Odd trailing bytes are excluded; zero-valued PCM is valid silence.
            return self.decoder_result(stdout=b"\x00\x00\xff")

        with patch("gigaam_server.subprocess.run", side_effect=run):
            self.assertEqual(decode_pcm(b"test-upload", "ffmpeg"), b"\x00\x00")
        self.assertFalse(paths[0].exists())
        self.assertFalse(paths[0].parent.exists())

    def test_failure_is_publicly_actionable_and_temp_path_is_not_logged(self):
        paths = []

        def run(command, **kwargs):
            path = Path(command[command.index("-i") + 1])
            paths.append(path)
            return self.decoder_result(1, b"", (str(path) + ": invalid audio").encode())

        with patch("gigaam_server.subprocess.run", side_effect=run):
            with self.assertLogs("gigaam-server", level="WARNING") as logs:
                with self.assertRaises(AudioDecodeError) as caught:
                    decode_pcm(b"test-upload", "ffmpeg", "audio/mp4")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Запишите сообщение ещё раз", str(caught.exception))
        self.assertNotIn(str(paths[0]), " ".join(logs.output))
        self.assertNotIn("test-upload", " ".join(logs.output))
        self.assertNotIn("invalid audio", str(caught.exception))
        self.assertFalse(paths[0].parent.exists())

    def test_zero_exit_without_pcm_is_an_error(self):
        result = self.decoder_result(stdout=b"", stderr=b"partial file")
        with patch("gigaam_server.subprocess.run", return_value=result):
            with self.assertLogs("gigaam-server", level="WARNING") as logs:
                with self.assertRaises(AudioDecodeError) as caught:
                    decode_pcm(b"test-upload", "ffmpeg", "malicious-mime-value")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("reason=empty-pcm", " ".join(logs.output))
        self.assertIn("mime=unknown", " ".join(logs.output))
        self.assertNotIn("malicious-mime-value", " ".join(logs.output))

    def test_timeout_cleans_temp_file_and_returns_504(self):
        paths = []

        def run(command, **kwargs):
            paths.append(Path(command[command.index("-i") + 1]))
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])

        with patch("gigaam_server.subprocess.run", side_effect=run):
            with self.assertLogs("gigaam-server", level="WARNING"):
                with self.assertRaises(AudioDecodeError) as caught:
                    decode_pcm(b"test-upload", "ffmpeg")
        self.assertEqual(caught.exception.status_code, 504)
        self.assertFalse(paths[0].parent.exists())

    def test_unavailable_decoder_is_actionable_and_cleans_temp_file(self):
        paths = []

        def run(command, **kwargs):
            paths.append(Path(command[command.index("-i") + 1]))
            raise FileNotFoundError("private/path/ffmpeg")

        with patch("gigaam_server.subprocess.run", side_effect=run):
            with self.assertLogs("gigaam-server", level="ERROR"):
                with self.assertRaises(AudioDecodeError) as caught:
                    decode_pcm(b"test-upload", "missing-ffmpeg")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private/path", str(caught.exception))
        self.assertFalse(paths[0].parent.exists())

    def test_empty_upload_never_starts_ffmpeg(self):
        with patch("gigaam_server.subprocess.run") as run:
            with self.assertRaises(AudioDecodeError):
                decode_pcm(b"", "ffmpeg")
        run.assert_not_called()


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is needed for real container regressions")
class RealContainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="gigaam-decode-tests-")
        cls.root = Path(cls.directory.name)
        cls.ffmpeg = shutil.which("ffmpeg")
        fixtures = [
            ("tail.m4a", "8", ["-c:a", "aac", "-b:a", "128k"]),
            ("complete-fragmented.mp4", "0.4", ["-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov"]),
            ("recording.webm", "0.4", ["-c:a", "libopus"]),
            ("silence.wav", "0.4", ["-c:a", "pcm_s16le"]),
        ]
        for name, duration, options in fixtures:
            source = "anullsrc=sample_rate=48000" if name == "silence.wav" else "anoisesrc=color=pink:sample_rate=48000:seed=123"
            subprocess.run(
                [cls.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, "-t", duration, "-ac", "1", *options, str(cls.root / name)],
                capture_output=True, check=True, timeout=30,
            )

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_valid_moov_at_end_m4a_fails_pipe_but_decodes_seekably(self):
        data = (self.root / "tail.m4a").read_bytes()
        self.assertGreater(len(data), 100_000)
        self.assertGreater(data.index(b"moov"), data.index(b"mdat"))
        pipe = subprocess.run(
            [self.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "pipe:1"],
            input=data, capture_output=True, timeout=30,
        )
        self.assertEqual(pipe.stdout, b"")
        self.assertIn(b"partial file", pipe.stderr)
        self.assertAlmostEqual(len(decode_pcm(data, self.ffmpeg, "audio/mp4")) / 32000, 8, delta=0.1)

    def test_complete_fragmented_mp4_and_webm_decode(self):
        for name, mime in [("complete-fragmented.mp4", "audio/mp4"), ("recording.webm", "audio/webm")]:
            with self.subTest(name=name):
                pcm = decode_pcm((self.root / name).read_bytes(), self.ffmpeg, mime)
                self.assertAlmostEqual(len(pcm) / 32000, 0.4, delta=0.1)

    def test_valid_silence_is_nonempty_zero_pcm(self):
        pcm = decode_pcm((self.root / "silence.wav").read_bytes(), self.ffmpeg, "audio/wav")
        self.assertGreater(len(pcm), 0)
        self.assertFalse(any(pcm))

    def test_fragment_without_initialization_and_malformed_upload_fail(self):
        fragment = (self.root / "complete-fragmented.mp4").read_bytes()
        fragment = fragment[fragment.index(b"moof") - 4:]
        for data in [fragment, b"invalid audio upload"]:
            with self.subTest(size=len(data)):
                with self.assertLogs("gigaam-server", level="WARNING"):
                    with self.assertRaises(AudioDecodeError) as caught:
                        decode_pcm(data, self.ffmpeg, "audio/mp4")
                self.assertEqual(caught.exception.status_code, 400)
                self.assertIn("Запишите сообщение ещё раз", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
