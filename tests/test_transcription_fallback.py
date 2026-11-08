"""Regression tests for unavailable dedicated Gemini Transcribe models.

The tests isolate the transcription function from Streamlit UI startup and
mock the Gemini client; no credentials or network calls are required.
"""

from __future__ import annotations

import ast
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


class FakeAPIError(Exception):
    def __init__(self, code: int):
        self.code = code
        self.message = "Model gemini-3.5-transcribe not found"
        super().__init__(self.message)


class TestTranscriptionFallback(unittest.TestCase):
    def make_runner(self, prefer_dedicated: bool):
        app_file = Path(__file__).resolve().parents[1] / "app.py"
        tree = ast.parse(app_file.read_text(encoding="utf-8"))
        function = next(
            item
            for item in tree.body
            if isinstance(item, ast.FunctionDef)
            and item.name == "_transcribe_media_once"
        )

        calls = {"interactions": 0, "flash": 0, "uploaded": 0, "deleted": 0}

        class FakeFiles:
            def upload(self, **kwargs):
                calls["uploaded"] += 1
                return SimpleNamespace(
                    uri="files/fixture-audio",
                    name="files/fixture-audio",
                    mime_type="audio/mpeg",
                )

            def delete(self, **kwargs):
                calls["deleted"] += 1

        class FakeInteractions:
            def create(self, **kwargs):
                calls["interactions"] += 1
                raise FakeAPIError(404)

        client = SimpleNamespace(
            files=FakeFiles(),
            interactions=FakeInteractions(),
            close=lambda: None,
        )

        def flash_fallback(**kwargs):
            calls["flash"] += 1
            return {
                "transcript": "This is the complete transcript.",
                "words": [],
                "segments": [],
                "speaker_transcript": "",
                "srt": "",
                "vtt": "",
                "compatibility_notice": "Processed with Gemini Flash.",
            }

        class FakeLocalMediaSource:
            pass

        namespace = {
            "Any": object,
            "Path": Path,
            "VIDEO_EXTENSIONS": {".mp4"},
            "AUDIO_MIME_TYPES": {".mp3": "audio/mpeg"},
            "MAX_UPLOAD_MB": 500,
            "MAX_GEMINI_FILE_MB": 2048,
            "LocalMediaSource": FakeLocalMediaSource,
            "genai": SimpleNamespace(Client=lambda **kwargs: client),
            "errors": SimpleNamespace(APIError=FakeAPIError),
            "tempfile": tempfile,
            "shutil": shutil,
            "prepare_audio": lambda source, extension, folder: (
                source,
                "audio/mpeg",
                12.0,
            ),
            "wait_for_file": lambda client, file: file,
            "secret_or_env": lambda name: (
                "true" if prefer_dedicated and name == "PREFER_DEDICATED_TRANSCRIBE"
                else None
            ),
            "flash_audio_transcription_fallback": flash_fallback,
            "LANGUAGES": {"Bangla (Bangladesh)": ["bn-BD"]},
            "api_error_code": lambda error: error.code,
            "api_error_text": lambda error: str(error).lower(),
        }
        isolated = ast.fix_missing_locations(
            ast.Module(body=[function], type_ignores=[])
        )
        exec(compile(isolated, str(app_file), "exec"), namespace)

        uploaded = io.BytesIO(b"fake-mp3-bytes")
        uploaded.name = "test.mp3"
        uploaded.size = len(uploaded.getvalue())
        return namespace["_transcribe_media_once"], uploaded, calls

    def test_default_mode_never_calls_unavailable_transcribe_model(self):
        runner, uploaded, calls = self.make_runner(prefer_dedicated=False)
        result = runner(uploaded, "fake-key", ["bn-BD"], "Smart clean transcript", [])
        self.assertEqual(result["transcript"], "This is the complete transcript.")
        self.assertEqual(result["mode"], "Smart clean transcript")
        self.assertEqual(result["language"], "Bangla (Bangladesh)")
        self.assertEqual(calls["interactions"], 0)
        self.assertEqual(calls["flash"], 1)
        self.assertEqual(calls["uploaded"], 1)
        self.assertEqual(calls["deleted"], 1)

    def test_explicit_dedicated_404_falls_back_to_flash(self):
        runner, uploaded, calls = self.make_runner(prefer_dedicated=True)
        result = runner(uploaded, "fake-key", ["bn-BD"], "Smart clean transcript", [])
        self.assertEqual(result["transcript"], "This is the complete transcript.")
        self.assertEqual(calls["interactions"], 1)
        self.assertEqual(calls["flash"], 1)
        self.assertEqual(calls["deleted"], 1)


if __name__ == "__main__":
    unittest.main()
