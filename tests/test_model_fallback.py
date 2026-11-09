"""Tests for moving between Gemini Flash models when one is unavailable.

The function under test is loaded on its own from app.py, so Streamlit does
not start and no API key or network access is needed.
"""

from __future__ import annotations

import ast
import hashlib
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


class FakeAPIError(Exception):
    def __init__(self, code: int, message: str = "error"):
        self.code = code
        self.message = message
        super().__init__(message)


def load_function(name: str, generate, listed=None):
    app_file = Path(__file__).resolve().parents[1] / "app.py"
    tree = ast.parse(app_file.read_text(encoding="utf-8"))
    helper_functions = {
        "_key_cache_id",
        "available_generate_models",
        "audio_model_candidates",
        "_fast_thinking_config",
        name,
    }
    helper_names = {
        "FLASH_AUDIO_MODEL_PREFERENCE",
        "_MODEL_CACHE_LOCK",
        "_AVAILABLE_MODELS_CACHE",
        "_WORKING_AUDIO_MODEL",
        "_BAD_AUDIO_MODELS",
        "_NO_THINKING_CONFIG_MODELS",
    }
    body = []
    for item in tree.body:
        if isinstance(item, ast.FunctionDef) and item.name in helper_functions:
            body.append(item)
        elif isinstance(item, (ast.Assign, ast.AnnAssign)):
            targets = item.targets if isinstance(item, ast.Assign) else [item.target]
            if any(isinstance(t, ast.Name) and t.id in helper_names for t in targets):
                body.append(item)
    calls: list[str] = []
    configs: list[dict] = []

    def generate_content(**kwargs):
        calls.append(kwargs["model"])
        configs.append(kwargs.get("config") or {})
        return generate(kwargs["model"], kwargs.get("config") or {})

    def list_models(**kwargs):
        if listed is None:
            raise RuntimeError("listing unavailable")
        return [SimpleNamespace(name=f"models/{m}", supported_actions=["generateContent"]) for m in listed]

    client = SimpleNamespace(
        models=SimpleNamespace(generate_content=generate_content, list=list_models),
        _api_client=SimpleNamespace(api_key="test-key"),
    )
    namespace = {
        "Any": object,
        "genai": SimpleNamespace(Client=object),
        "errors": SimpleNamespace(APIError=FakeAPIError),
        "types": SimpleNamespace(
            Part=SimpleNamespace(from_uri=lambda **kwargs: "audio"),
            GenerateContentConfig=lambda **kwargs: kwargs,
            ThinkingConfig=lambda **kwargs: kwargs,
        ),
        "CONTENT_MODEL": "model-a",
        "LOGGER": SimpleNamespace(info=lambda *args: None),
        "hashlib": hashlib,
        "threading": threading,
        "api_error_code": lambda error: error.code,
        "api_error_text": lambda error: str(error).lower(),
        "time": SimpleNamespace(sleep=lambda seconds: None, monotonic=time.monotonic, time=time.time),
    }
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    exec(compile(module, str(app_file), "exec"), namespace)
    item = {"uri": "files/1", "mime_type": "audio/mpeg"}
    runner = lambda: namespace[name](client, item, "prompt")
    runner.configs = configs
    return runner, calls


class TestFlashModelFallback(unittest.TestCase):
    def test_rate_limited_model_moves_to_next_model(self):
        def generate(model, config):
            if model == "model-a":
                raise FakeAPIError(429, "quota exceeded, limit: 0")
            return SimpleNamespace(text="hello")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        response, model = run()
        self.assertEqual(response.text, "hello")
        self.assertEqual(calls[0], "model-a")
        self.assertNotEqual(model, "model-a")

    def test_overloaded_and_missing_models_are_skipped(self):
        def generate(model, config):
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
        def generate(model, config):
            raise FakeAPIError(429, "quota exceeded")

        run, _ = load_function("_generate_audio_with_compatible_flash", generate)
        with self.assertRaises(FakeAPIError) as caught:
            run()
        self.assertEqual(caught.exception.code, 429)

    def test_invalid_key_stops_immediately(self):
        def generate(model, config):
            raise FakeAPIError(400, "API key not valid. Please pass a valid API key.")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        with self.assertRaises(FakeAPIError):
            run()
        self.assertEqual(len(calls), 1)

    def test_retired_models_are_skipped_using_the_model_list(self):
        retired = "This model models/gemini-2.5-flash-lite is no longer available to new users."

        def generate(model, config):
            if model == "gemini-3.5-flash-lite":
                return SimpleNamespace(text="hello")
            raise FakeAPIError(404, retired)

        run, calls = load_function(
            "_generate_audio_with_compatible_flash",
            generate,
            listed=["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "text-embedding-004"],
        )
        _, model = run()
        self.assertEqual(model, "gemini-3.5-flash-lite")
        self.assertEqual(calls, ["gemini-3.5-flash-lite"])

    def test_working_model_is_remembered(self):
        def generate(model, config):
            if model == "model-a":
                raise FakeAPIError(404, "not found")
            return SimpleNamespace(text="ok")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        _, first = run()
        calls.clear()
        _, second = run()
        self.assertEqual(first, second)
        self.assertEqual(calls, [first])

    def test_fast_thinking_setting_is_dropped_when_rejected(self):
        def generate(model, config):
            if "thinking_config" in config:
                raise FakeAPIError(400, "Thinking level is not supported for this model.")
            return SimpleNamespace(text="ok")

        run, calls = load_function("_generate_audio_with_compatible_flash", generate)
        _, model = run()
        self.assertEqual(model, "model-a")
        self.assertEqual(calls, ["model-a", "model-a"])
        self.assertIn("thinking_config", run.configs[0])
        self.assertNotIn("thinking_config", run.configs[1])


if __name__ == "__main__":
    unittest.main()
