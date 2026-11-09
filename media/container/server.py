"""Media helper for the Cloudflare version of Team Fahad Transcriber.

Each container instance handles one job. It downloads a link (or receives an
uploaded file), converts it to small 16 kHz mono MP3, and splits it into
5 minute parts that the Worker sends to Gemini in parallel.

The link download logic (YouTube, Google Drive, Facebook, Frame.io, generic
yt-dlp sites) is loaded from the original app.py so both apps share it.
"""

from __future__ import annotations

import ast
import json
import re
import shutil
import subprocess
import sys
import threading
import traceback
import types
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PART_SECONDS = 300
WORK = Path("/work")
APP_SOURCE = Path("/app/app.py")
STATE_LOCK = threading.Lock()
STATE: dict = {"status": "idle"}
REQUIRED_TOOLS = ("download_media_from_link", "LocalMediaSource", "download_google_drive_media", "download_facebook_public_fallback", "download_frameio_media", "download_youtube_media")


def load_link_tools() -> dict:
    """Load imports, constants, classes and functions from app.py, skipping UI code."""
    sys.path.insert(0, "/app/stub")
    tree = ast.parse(APP_SOURCE.read_text(encoding="utf-8"))
    # A real module object is needed so @dataclass classes can be created.
    module_obj = types.ModuleType("app_link_tools")
    sys.modules["app_link_tools"] = module_obj
    namespace: dict = module_obj.__dict__
    keep = (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign)
    for node in tree.body:
        if not isinstance(node, keep):
            continue
        module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
        try:
            exec(compile(module, str(APP_SOURCE), "exec"), namespace)
        except Exception as exc:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)):
                print(f"Could not load {getattr(node, 'name', type(node).__name__)} from app.py: {exc}", flush=True)
    missing = [n for n in REQUIRED_TOOLS if n not in namespace]
    if missing:
        raise RuntimeError(f"app.py is missing link tools: {missing}")
    return namespace


TOOLS = load_link_tools()


def ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def probe_duration(path: Path) -> float:
    result = subprocess.run([ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        return 0.0
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def set_state(**values) -> None:
    with STATE_LOCK:
        STATE.clear()
        STATE.update(values)


def prepare_parts(source: Path, title: str) -> None:
    """Convert to 16 kHz mono MP3 and split into parts."""
    set_state(status="converting", title=title)
    out_dir = WORK / "parts"
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    normalized = WORK / "normalized.mp3"
    convert = subprocess.run(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn",
         "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "48k", str(normalized)],
        capture_output=True, text=True,
    )
    if convert.returncode != 0 or not normalized.exists() or normalized.stat().st_size == 0:
        detail = (convert.stderr or "").strip()[-300:]
        if "does not contain any stream" in detail or "Output file does not contain" in detail:
            raise RuntimeError("This file has no audio track.")
        raise RuntimeError(f"Could not read the audio in this file. {detail}")
    split = subprocess.run(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(normalized),
         "-f", "segment", "-segment_time", str(PART_SECONDS), "-reset_timestamps", "1",
         "-c", "copy", str(out_dir / "part_%03d.mp3")],
        capture_output=True, text=True,
    )
    if split.returncode != 0:
        raise RuntimeError(f"Could not split the audio. {(split.stderr or '')[-300:]}")
    parts = []
    offset = 0.0
    for path in sorted(out_dir.glob("part_*.mp3")):
        if path.stat().st_size == 0:
            continue
        duration = probe_duration(path) or float(PART_SECONDS)
        parts.append({"index": len(parts), "offset": round(offset, 3), "duration": round(duration, 3), "file": path.name})
        offset += duration
    if not parts:
        raise RuntimeError("No audio was found in this media.")
    set_state(status="ready", title=title, duration=round(offset, 3), parts=parts)


def run_link_job(url: str) -> None:
    try:
        set_state(status="downloading")
        folder = WORK / "download"
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
        media = TOOLS["download_media_from_link"](url, folder)
        title = Path(str(getattr(media, "name", "") or "linked_media")).stem
        prepare_parts(Path(media.path), title)
    except Exception as exc:
        traceback.print_exc()
        set_state(status="error", error=str(exc)[:600] or "Could not download this link.")


def run_upload_job(source: Path, title: str) -> None:
    try:
        prepare_parts(source, title)
    except Exception as exc:
        traceback.print_exc()
        set_state(status="error", error=str(exc)[:600])


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        sys.stderr.write("%s\n" % (format % args))

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def public_state(self) -> dict:
        with STATE_LOCK:
            state = dict(STATE)
        if "parts" in state:
            state["parts"] = [{k: v for k, v in p.items() if k != "file"} for p in state["parts"]]
        return state

    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/ping"):
            return self.send_json({"ok": True})
        if path == "/status":
            return self.send_json(self.public_state())
        match = re.fullmatch(r"/part/(\d+)", path)
        if match:
            with STATE_LOCK:
                parts = list(STATE.get("parts") or [])
            index = int(match.group(1))
            if index >= len(parts):
                return self.send_json({"error": "Part not found."}, 404)
            data = (WORK / "parts" / parts[index]["file"]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        return self.send_json({"error": "Not found"}, 404)

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/link":
            payload = json.loads(self.read_body() or b"{}")
            url = str(payload.get("url") or "").strip()
            if not url:
                return self.send_json({"error": "Missing url"}, 400)
            WORK.mkdir(parents=True, exist_ok=True)
            threading.Thread(target=run_link_job, args=(url,), daemon=True).start()
            return self.send_json({"status": "downloading"})
        if parsed.path == "/upload":
            # Large uploads arrive in pieces; append them in order.
            part = int((query.get("part") or ["0"])[0])
            final = (query.get("final") or ["0"])[0] == "1"
            name = (query.get("name") or ["upload.bin"])[0]
            suffix = Path(name).suffix.lower()[:8] or ".bin"
            WORK.mkdir(parents=True, exist_ok=True)
            target = WORK / f"upload{suffix}"
            if part == 0:
                target.unlink(missing_ok=True)
                set_state(status="uploading")
            with target.open("ab") as handle:
                remaining = int(self.headers.get("Content-Length") or 0)
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            if final:
                set_state(status="converting")
                threading.Thread(target=run_upload_job, args=(target, Path(name).stem), daemon=True).start()
            return self.send_json({"ok": True})
        return self.send_json({"error": "Not found"}, 404)


if __name__ == "__main__":
    WORK.mkdir(parents=True, exist_ok=True)
    print("Media helper listening on 8080", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
