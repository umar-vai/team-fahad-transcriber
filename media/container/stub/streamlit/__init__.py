"""Tiny stand-in for Streamlit so the link download code in app.py can run headless."""

from __future__ import annotations

import os
from typing import Any


class _State(dict):
    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


class _Secrets:
    def get(self, name: str, default: Any = None) -> Any:
        return os.environ.get(name, default)

    def __getitem__(self, name: str) -> Any:
        return os.environ[name]

    def __contains__(self, name: str) -> bool:
        return name in os.environ


session_state = _State()
secrets = _Secrets()
query_params = _State()


def _noop(*args: Any, **kwargs: Any) -> Any:
    return None


def cache_data(*args: Any, **kwargs: Any) -> Any:
    if args and callable(args[0]) and not kwargs:
        return args[0]
    return lambda function: function


cache_resource = cache_data


def __getattr__(name: str) -> Any:
    return _noop
