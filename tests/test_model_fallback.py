"""Tests for moving between Gemini Flash models when one is unavailable.

The function under test is loaded on its own from app.py, so Streamlit does
not start and no API key or network access is needed.
"""

from __future__ import annotations

import ast
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


class FakeAPIError(Exception):
    def __init__(self, code: int, message: str = "error"):
        self.code = code
        self.message = message
        super().__init__(message)


def load_function(name: str, generate):
    app_file = Path(__file__).resolve().parents[1] / "app.py"
    tree = ast.parse(app_file.read_text(encoding="utf-8"))
    function = next(
        item for item in tree.body
        if isinstance(item, ast.FunctionDef) and item.name == name
    )
    calls: list[str] = []

    def generate_content(**kwargs):
        calls.append(kwargs["model"])
        return generate(kwargs["model"])

    client = SimpleNamespace(models=SimpleNamespace(generate_content=generate_content))
    namespace = {
        "Any": object,
        "genai": SimpleNamespace(Client=object),
        "errors": SimpleNamespace(APIError=FakeAPIError),
        "types": SimpleNamespace(
            Part=SimpleNamespace(from_uri=lambda **kwargs: "audio"),
            GenerateContentConfig=lambda **kwargs: kwargs,
        ),
        "CONTENT_MODEL": "model-a",
        "api_error_code": lambda error: error.code,
        "api_error_text": lambda error: str(error).lower(),
        "time": SimpleNamespace(sleep=lambda seconds: None, monotonic=time.monotonic),
    }
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    exec(compile(module, str(app_file), "exec"), namespace)
    item = {"uri": "files/1", "mime_type": "audio/mpeg"}
    return (lambda: namespace[name](client, item, "prompt")), calls


class TestFlashModelFallback(unittest.TestCase):
    def test_rate_limited_model_moves_to_next_model(self):
        def generate(model):
            if model == "model-a":
                raise FakeAPIError(429, "quota exceeded, limit: 0")
            return SimpleNamespace(text="hello")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        response, model = run()
        self.assertEqual(response.text, "hello")
        self.assertEqual(calls[0], "model-a")
        self.assertNotEqual(model, "model-a")

    def test_overloaded_and_missing_models_are_skipped(self):
        def generate(model):
            if model == "model-a":
                raise FakeAPIError(503, "overloaded")
            if model == "gemini-flash-latest":
                raise FakeAPIError(404, "not found")
            return SimpleNamespace(text="ok")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        _, model = run()
        self.assertEqual(calls[:3], ["model-a", "model-a", "gemini-flash-latest"])
        self.assertEqual(model, calls[-1])

    def test_all_models_rate_limited_raises_429_for_key_failover(self):
        def generate(model):
            raise FakeAPIError(429, "quota exceeded")

        run, _ = load_function("_generate_audio_with_compatible_flash", generate)
        with self.assertRaises(FakeAPIError) as caught:
            run()
        self.assertEqual(caught.exception.code, 429)

    def test_invalid_key_stops_immediately(self):
        def generate(model):
            raise FakeAPIError(400, "API key not valid. Please pass a valid API key.")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        with self.assertRaises(FakeAPIError):
            run()
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
