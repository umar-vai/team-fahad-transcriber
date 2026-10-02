"""Client-ready Streamlit app for video/audio transcription by Team Fahad."""

from __future__ import annotations

import hashlib
import io
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import streamlit as st
import streamlit.components.v1 as components
from docx import Document
from google import genai
from google.genai import errors
from moviepy import AudioFileClip, VideoFileClip
import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe
import gdown


APP_TITLE = "Video/Audio Transcriber by Team Fahad"
TRANSCRIBE_MODEL = "gemini-3.5-transcribe"
CONTENT_MODEL = "gemini-3.8-flash"
MAX_UPLOAD_MB = 500
MAX_LINK_MB = 2048
MAX_ANALYSIS_CHARS = 120_000
MAX_BULK_URLS = 50

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv"}
AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/m4a",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}

LANGUAGES = {
    "Auto detect / mixed language": [],
    "Bangla (Bangladesh)": ["bn-BD"],
    "English (US)": ["en-US"],
    "English (UK)": ["en-GB"],
    "Arabic": ["ar-EG"],
    "Hindi": ["hi-IN"],
}

TRANSLATION_LANGUAGES = [
    "Bangla",
    "English",
    "Arabic",
    "Hindi",
]


@dataclass
class WordInfo:
    text: str
    speaker: str | None
    start: float | None
    end: float | None


@dataclass
class LocalMediaSource:
    path: Path
    name: str
    size: int


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str | None = None


class APIKeyPoolExhausted(RuntimeError):
    """Raised when every configured API key is temporarily rate-limited."""


def secret_or_env(name: str) -> Any | None:
    """Read a secret from Streamlit first, then from environment variables."""
    try:
        value = st.secrets.get(name)
        if value not in (None, "", []):
            return value
    except Exception:
        pass
    value = os.getenv(name)
    return value if value else None


def normalize_key_list(value: Any | None) -> list[str]:
    """Normalize TOML arrays, single secrets, or comma/newline-separated env values."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        raw = [str(item).strip() for item in value]
    else:
        raw = [item.strip() for item in re.split(r"[,;\n]+", str(value))]

    keys: list[str] = []
    seen: set[str] = set()
    for key in raw:
        if key and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def load_api_key_pool(scope: str | None = None) -> list[str]:
    """Load a scoped Gemini key pool, falling back to the shared key pool."""
    scoped_names: list[str] = []
    if scope:
        prefix = scope.upper()
        scoped_names = [f"{prefix}_GEMINI_API_KEYS", f"{prefix}_GEMINI_API_KEY"]

    for name in scoped_names + ["GEMINI_API_KEYS", "GEMINI_API_KEY"]:
        keys = normalize_key_list(secret_or_env(name))
        if keys:
            return keys
    return []


def api_key_id(api_key: str) -> str:
    """Create a non-secret identifier used only for in-session cooldown tracking."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def api_error_code(exc: Exception) -> int | None:
    try:
        return int(getattr(exc, "code", None))
    except (TypeError, ValueError):
        return None


def api_error_text(exc: Exception) -> str:
    return str(getattr(exc, "message", "") or str(exc)).lower()


def rate_limit_cooldown_seconds(exc: Exception) -> int:
    """Use a long cooldown for daily limits and a short cooldown for burst limits."""
    message = api_error_text(exc)
    daily_markers = ("per day", "daily", "requests per day", "rpd")
    return 12 * 60 * 60 if any(marker in message for marker in daily_markers) else 90


def mark_key_rate_limited(api_key: str, exc: Exception) -> None:
    cooldowns = st.session_state.setdefault("_api_key_cooldowns", {})
    cooldowns[api_key_id(api_key)] = time.time() + rate_limit_cooldown_seconds(exc)


def key_is_available(api_key: str) -> bool:
    cooldowns = st.session_state.setdefault("_api_key_cooldowns", {})
    until = float(cooldowns.get(api_key_id(api_key), 0) or 0)
    if until <= time.time():
        cooldowns.pop(api_key_id(api_key), None)
        return True
    return False


def run_with_api_failover(api_keys: list[str], operation: Any, purpose: str) -> Any:
    """Run an API operation and move to the next configured key after HTTP 429."""
    if not api_keys:
        raise RuntimeError("No Gemini API key is configured for this feature.")

    available = [(index, key) for index, key in enumerate(api_keys) if key_is_available(key)]
    if not available:
        raise APIKeyPoolExhausted(
            "All configured Gemini API slots are temporarily rate-limited. "
            "Please try again later, add fresh capacity in Streamlit Secrets, or use a higher Gemini API tier."
        )

    last_rate_error: Exception | None = None
    for attempt_position, (index, api_key) in enumerate(available):
        try:
            return operation(api_key)
        except errors.APIError as exc:
            if api_error_code(exc) != 429:
                raise

            last_rate_error = exc
            mark_key_rate_limited(api_key, exc)
            backups_left = len(available) - attempt_position - 1
            if backups_left > 0:
                st.info(
                    f"{purpose}: API slot {index + 1} reached its limit. "
                    f"Switching automatically to a backup ({backups_left} remaining)…"
                )
                continue
            break

    raise APIKeyPoolExhausted(
        "All configured Gemini API slots have reached their current rate limit. "
        "Please try again later, add another authorized API key/project in Streamlit Secrets, "
        "or upgrade your Gemini API tier."
    ) from last_rate_error


def render_copy_button(text: str, label: str = "Copy TXT", height: int = 42, top_offset: int = 0) -> None:
    """Render a compact browser-side copy button."""
    payload = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    components.html(
        f"""
        <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    width:100%; height:{height}px; display:flex; align-items:stretch;">
          <button id="copy-btn" style="
            width:100%; height:100%; box-sizing:border-box; padding:0 16px; border-radius:12px;
            border:1px solid rgba(148,163,184,.28); background:rgba(15,23,42,.55);
            color:#f8fafc; font-weight:750; font-size:14px; cursor:pointer;
            position:relative; top:{top_offset}px;
            transition:background .2s ease, border-color .2s ease, transform .2s ease;
          ">{label}</button>
          <textarea id="copy-source" style="position:absolute;left:-9999px;top:-9999px;">{payload}</textarea>
          <script>
            const btn = document.getElementById("copy-btn");
            const source = document.getElementById("copy-source");
            btn.addEventListener("click", async () => {{
              const value = source.value;
              try {{
                await navigator.clipboard.writeText(value);
              }} catch (e) {{
                source.focus();
                source.select();
                document.execCommand("copy");
              }}
              const original = btn.textContent;
              btn.textContent = "Copied ✓";
              setTimeout(() => btn.textContent = original, 1600);
            }});
          </script>
        </div>
        """,
        height=height,
        scrolling=False,
    )


def safe_name(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[^\w\-]+", "_", stem, flags=re.UNICODE).strip("_")
    return stem[:80] or "transcript"


def parse_offset(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("s"):
        text = text[:-1]
    try:
        return float(text)
    except ValueError:
        return None


def format_clock(seconds: float) -> str:
    seconds = max(0.0, seconds)
    total = int(seconds)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_srt_time(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    h, remainder = divmod(millis, 3_600_000)
    m, remainder = divmod(remainder, 60_000)
    s, ms = divmod(remainder, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_vtt_time(seconds: float) -> str:
    return format_srt_time(seconds).replace(",", ".")


def smart_join(tokens: list[str]) -> str:
    """Join token-like words while avoiding spaces before punctuation."""
    text = ""
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        if not text:
            text = token
        elif re.match(r"^[,.;:!?%\)\]\}।]", token):
            text += token
        elif text.endswith(("(", "[", "{", "“", '"', "'")):
            text += token
        else:
            text += " " + token
    return text.strip()


def wait_for_file(client: genai.Client, uploaded_file: Any, timeout_seconds: int = 180) -> Any:
    """Wait for an uploaded Gemini file to become usable when state is exposed."""
    state_obj = getattr(uploaded_file, "state", None)
    if state_obj is None:
        return uploaded_file

    deadline = time.monotonic() + timeout_seconds
    current = uploaded_file
    while True:
        state = getattr(getattr(current, "state", None), "name", str(getattr(current, "state", "")))
        state = state.upper()
        if state in {"ACTIVE", "STATE_ACTIVE", ""}:
            return current
        if "FAILED" in state:
            raise RuntimeError("Gemini could not process the uploaded media file.")
        if time.monotonic() >= deadline:
            raise TimeoutError("Gemini did not finish preparing the uploaded file in time.")
        time.sleep(2)
        current = client.files.get(name=current.name)


def extract_word_annotations(interaction: Any) -> list[WordInfo]:
    words: list[WordInfo] = []
    for step in getattr(interaction, "steps", []) or []:
        for content in getattr(step, "content", []) or []:
            for annotation in getattr(content, "annotations", []) or []:
                if getattr(annotation, "type", None) != "word_info":
                    continue
                words.append(
                    WordInfo(
                        text=str(getattr(annotation, "text", "") or "").strip(),
                        speaker=(str(getattr(annotation, "speaker", "") or "").strip() or None),
                        start=parse_offset(getattr(annotation, "start_offset", None)),
                        end=parse_offset(getattr(annotation, "end_offset", None)),
                    )
                )
    return [w for w in words if w.text]


def make_segments(words: list[WordInfo], max_duration: float = 7.0, max_chars: int = 88) -> list[Segment]:
    """Turn word annotations into readable subtitle-sized segments."""
    timed = [w for w in words if w.start is not None and w.end is not None]
    if not timed:
        return []

    segments: list[Segment] = []
    current: list[WordInfo] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        segments.append(
            Segment(
                start=current[0].start or 0.0,
                end=current[-1].end or current[0].start or 0.0,
                text=smart_join([w.text for w in current]),
                speaker=current[0].speaker,
            )
        )
        current = []

    for word in timed:
        if not current:
            current.append(word)
            continue

        current_start = current[0].start or 0.0
        duration = (word.end or current_start) - current_start
        speaker_changed = bool(word.speaker and current[0].speaker and word.speaker != current[0].speaker)
        prospective = smart_join([w.text for w in current] + [word.text])
        sentence_end = bool(re.search(r"[.!?।][\"'”’)]?$", current[-1].text))

        if speaker_changed or duration > max_duration or len(prospective) > max_chars:
            flush()
        elif sentence_end and duration >= 2.0:
            flush()

        current.append(word)

    flush()
    return [s for s in segments if s.text]


def speaker_transcript(segments: list[Segment]) -> str:
    if not segments:
        return ""
    lines = []
    for segment in segments:
        speaker = segment.speaker or "Speaker"
        speaker = speaker.replace("spk_", "Speaker ").replace("SPK_", "Speaker ")
        lines.append(f"[{format_clock(segment.start)}] {speaker}: {segment.text}")
    return "\n".join(lines)


def segments_to_srt(segments: list[Segment]) -> str:
    blocks = []
    for idx, segment in enumerate(segments, start=1):
        speaker = ""
        if segment.speaker:
            label = segment.speaker.replace("spk_", "Speaker ").replace("SPK_", "Speaker ")
            speaker = f"{label}: "
        blocks.append(
            f"{idx}\n{format_srt_time(segment.start)} --> {format_srt_time(segment.end)}\n"
            f"{speaker}{segment.text}\n"
        )
    return "\n".join(blocks)


def segments_to_vtt(segments: list[Segment]) -> str:
    blocks = ["WEBVTT\n"]
    for segment in segments:
        speaker = ""
        if segment.speaker:
            label = segment.speaker.replace("spk_", "Speaker ").replace("SPK_", "Speaker ")
            speaker = f"{label}: "
        blocks.append(
            f"{format_vtt_time(segment.start)} --> {format_vtt_time(segment.end)}\n"
            f"{speaker}{segment.text}\n"
        )
    return "\n".join(blocks)


def validate_public_media_url(url: str) -> str:
    """Validate an HTTP(S) URL and reject obvious private/loopback targets."""
    cleaned = str(url or "").strip()
    if len(cleaned) > 2048:
        raise ValueError("That link is too long. Please provide a shorter media URL.")

    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Please enter a complete HTTP or HTTPS media link.")

    hostname = parsed.hostname.strip().lower().rstrip(".")
    if hostname in {"localhost", "localhost.localdomain", "0.0.0.0", "::1"} or hostname.endswith(".local"):
        raise ValueError("Private/local network links are not supported.")

    try:
        addresses = {
            info[4][0]
            for info in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise ValueError("The link's host could not be resolved.") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address)
        if any((ip.is_private, ip.is_loopback, ip.is_link_local, ip.is_multicast, ip.is_unspecified, ip.is_reserved)):
            raise ValueError("For security, links to private or local network addresses are not supported.")

    return cleaned


def ffmpeg_executable() -> str:
    """Use system FFmpeg when available, otherwise imageio-ffmpeg's bundled binary."""
    return shutil.which("ffmpeg") or get_ffmpeg_exe()


def normalize_link_media_to_mp3(source: Path, destination: Path) -> Path:
    """Normalize any linked audio/video file into a Gemini-friendly MP3."""
    command = [
        ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=600)
    except FileNotFoundError as exc:
        raise RuntimeError("FFmpeg is not available on the server.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Media conversion timed out. Please use a shorter recording.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        raise RuntimeError(f"The linked media could not be converted into audio. {detail[:400]}") from exc

    if not destination.exists() or destination.stat().st_size == 0:
        raise RuntimeError("No usable audio was produced from that link.")
    return destination


def google_drive_file_id(url: str) -> str | None:
    """Extract a Google Drive file ID from common share/view/download URLs."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if host not in {"drive.google.com", "www.drive.google.com", "docs.google.com"}:
        return None

    match = re.search(r"/file/d/([a-zA-Z0-9_-]+)", parsed.path)
    if match:
        return match.group(1)

    query_id = urllib.parse.parse_qs(parsed.query).get("id", [None])[0]
    if query_id and re.fullmatch(r"[a-zA-Z0-9_-]+", query_id):
        return query_id

    return None


def download_google_drive_media(url: str, folder: Path) -> LocalMediaSource:
    """Download a shared Google Drive file without routing it through yt-dlp."""
    file_id = google_drive_file_id(url)
    if not file_id:
        raise ValueError(
            "This looks like a Google Drive link, but no file ID could be detected. "
            "Please use the Drive file's Share link."
        )

    download_dir = folder / "google_drive_download"
    download_dir.mkdir(parents=True, exist_ok=True)
    output = download_dir / "google_drive_source"

    try:
        result = gdown.download(
            id=file_id,
            output=str(output),
            quiet=True,
            fuzzy=True,
            resume=True,
            retries=3,
        )
    except UnicodeEncodeError as exc:
        # Some hosted environments use an ASCII locale. Keep all downloader
        # filenames/logging ASCII-only so Bangla/Unicode Drive titles cannot
        # crash the request before the file is downloaded.
        raise RuntimeError(
            "Google Drive download hit a server text-encoding issue. "
            "The app is configured to use an ASCII-safe temporary filename; "
            "please retry once after the latest deployment finishes."
        ) from exc
    except Exception as exc:
        raise RuntimeError(
            f"Could not download the Google Drive file. "
            f"Make sure the file is shared as 'Anyone with the link' → 'Viewer'. "
            f"If it is already public, Google may be throttling/quota-limiting the file. "
            f"{str(exc)[:450]}"
        ) from exc

    downloaded = Path(result) if result else output
    if not downloaded.exists() or downloaded.stat().st_size == 0:
        raise RuntimeError(
            "Google Drive did not return a downloadable file. "
            "Check that the file is shared publicly and that the link points to a file, not a folder."
        )

    max_bytes = MAX_LINK_MB * 1024 * 1024
    if downloaded.stat().st_size > max_bytes:
        raise ValueError(
            f"Linked media is larger than the {MAX_LINK_MB} MB link limit. "
            "Please use a smaller file."
        )

    normalized = folder / "google_drive_media.mp3"
    normalize_link_media_to_mp3(downloaded, normalized)

    return LocalMediaSource(
        path=normalized,
        name="google_drive_media.mp3",
        size=normalized.stat().st_size,
    )


def download_media_from_link(url: str, folder: Path) -> LocalMediaSource:
    """Download one public media URL with yt-dlp, then normalize it to MP3."""
    url = validate_public_media_url(url)

    if google_drive_file_id(url):
        return download_google_drive_media(url, folder)

    download_dir = folder / "link_download"
    download_dir.mkdir(parents=True, exist_ok=True)
    max_bytes = MAX_LINK_MB * 1024 * 1024

    def progress_hook(data: dict[str, Any]) -> None:
        if int(data.get("downloaded_bytes") or 0) > max_bytes:
            raise yt_dlp.utils.DownloadError(
                f"Linked media exceeds the {MAX_LINK_MB} MB limit."
            )

    ydl_opts: dict[str, Any] = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "outtmpl": str(download_dir / "source.%(ext)s"),
        "noplaylist": True,
        "max_filesize": max_bytes,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "progress_hooks": [progress_hook],
        "cachedir": False,
        "logger": type(
            "QuietUnicodeLogger",
            (),
            {
                "debug": staticmethod(lambda msg: None),
                "warning": staticmethod(lambda msg: None),
                "error": staticmethod(lambda msg: None),
            },
        )(),
    }
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        ydl_opts["ffmpeg_location"] = ffmpeg

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        message = str(exc).strip()
        if "No supported JavaScript runtime" in message:
            raise RuntimeError(
                "This platform needs a supported JavaScript runtime for link extraction. "
                "Try a direct MP4/MP3/M4A link or another supported public media URL."
            ) from exc
        raise RuntimeError(f"Could not download media from that link. {message[:500]}") from exc
    except Exception as exc:
        raise RuntimeError(f"Could not process that media link: {exc}") from exc

    candidates = [
        p for p in download_dir.iterdir()
        if p.is_file() and p.suffix.lower() not in {".part", ".ytdl"}
    ]
    if not candidates:
        raise RuntimeError(
            "No downloadable audio/video file was found. Use a direct media URL or a supported platform link."
        )

    source = max(candidates, key=lambda p: p.stat().st_size)
    if source.stat().st_size > max_bytes:
        raise ValueError(f"Linked media is larger than the {MAX_UPLOAD_MB} MB limit.")

    title = str((info or {}).get("title") or source.stem or "linked_media").strip()
    safe_title = safe_name(title)[:100] or "linked_media"
    normalized = folder / f"{safe_title}.mp3"
    normalize_link_media_to_mp3(source, normalized)

    return LocalMediaSource(
        path=normalized,
        name=f"{safe_title}.mp3",
        size=normalized.stat().st_size,
    )


def media_duration(path: Path, is_video: bool) -> float | None:
    try:
        if is_video:
            with VideoFileClip(str(path)) as clip:
                return float(clip.duration or 0.0)
        with AudioFileClip(str(path)) as clip:
            return float(clip.duration or 0.0)
    except Exception:
        return None


def prepare_audio(source: Path, extension: str, folder: Path) -> tuple[Path, str, float | None]:
    """Return (audio_path, mime_type, duration_seconds)."""
    if extension in VIDEO_EXTENSIONS:
        duration = media_duration(source, is_video=True)
        audio_path = folder / "extracted_audio.mp3"
        try:
            with VideoFileClip(str(source)) as video:
                if video.audio is None:
                    raise ValueError("This video does not contain an audio track.")
                video.audio.write_audiofile(str(audio_path), codec="libmp3lame", logger=None)
        except ValueError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Could not extract audio from this video: {exc}") from exc
        return audio_path, "audio/mpeg", duration

    duration = media_duration(source, is_video=False)
    return source, AUDIO_MIME_TYPES[extension], duration


def _transcribe_media_once(
    uploaded: Any,
    api_key: str,
    language_codes: list[str],
    mode: str,
    custom_vocabulary: list[str],
) -> dict[str, Any]:
    extension = Path(uploaded.name).suffix.lower()
    if extension not in VIDEO_EXTENSIONS and extension not in AUDIO_MIME_TYPES:
        raise ValueError("Unsupported file format.")

    upload_size_mb = (
        uploaded.size if isinstance(uploaded, LocalMediaSource)
        else getattr(uploaded, "size", 0)
    ) / (1024 * 1024)
    if upload_size_mb > MAX_UPLOAD_MB:
        raise ValueError(f"File is too large. Maximum allowed size is {MAX_UPLOAD_MB} MB.")

    client = genai.Client(api_key=api_key)
    remote_file = None

    try:
        with tempfile.TemporaryDirectory(prefix="team_fahad_transcriber_") as temp_dir:
            folder = Path(temp_dir)
            if isinstance(uploaded, LocalMediaSource):
                source = uploaded.path
                extension = source.suffix.lower()
                if not source.exists() or source.stat().st_size == 0:
                    raise ValueError("The downloaded media file is empty or unavailable.")
            else:
                source = folder / f"source{extension}"
                with source.open("wb") as destination:
                    uploaded.seek(0)
                    shutil.copyfileobj(uploaded, destination)

                if source.stat().st_size == 0:
                    raise ValueError("The uploaded file is empty.")

            audio_path, mime_type, duration = prepare_audio(source, extension, folder)

            detailed = mode == "Detailed subtitles + speakers"
            duration_limit = 30 * 60 if detailed else 60 * 60
            if duration and duration > duration_limit + 1:
                minutes = duration_limit // 60
                raise ValueError(
                    f"This mode supports up to about {minutes} minutes per file. "
                    "Please split the media into smaller parts and try again."
                )

            remote_file = client.files.upload(file=str(audio_path), config={"mime_type": mime_type})
            remote_file = wait_for_file(client, remote_file)

            transcription_config: dict[str, Any] = {"language_codes": language_codes}
            if mode == "Smart clean transcript":
                transcription_config["mode"] = "smart"
            elif mode == "Detailed subtitles + speakers":
                transcription_config["mode"] = {
                    "type": "verbatim",
                    "diarization_mode": "speaker",
                    "timestamp_granularities": ["word"],
                }
            else:
                transcription_config["mode"] = {"type": "verbatim"}

            if custom_vocabulary and mode != "Detailed subtitles + speakers":
                transcription_config["custom_vocabulary"] = custom_vocabulary[:100]

            input_item = {
                "type": "audio",
                "uri": remote_file.uri,
                "mime_type": getattr(remote_file, "mime_type", mime_type) or mime_type,
            }

            last_error: Exception | None = None
            interaction = None
            for attempt in range(2):
                try:
                    interaction = client.interactions.create(
                        model=TRANSCRIBE_MODEL,
                        input=[input_item],
                        generation_config={"transcription_config": transcription_config},
                    )
                    break
                except errors.APIError as exc:
                    last_error = exc
                    code = getattr(exc, "code", None)
                    if code != 503 or attempt == 1:
                        raise
                    time.sleep(5)

            if interaction is None:
                raise RuntimeError(f"Transcription request failed: {last_error}")

            transcript = str(getattr(interaction, "output_text", "") or "").strip()
            if not transcript:
                raise RuntimeError("Gemini returned an empty transcription.")

            words = extract_word_annotations(interaction)
            segments = make_segments(words)

            return {
                "transcript": transcript,
                "words": words,
                "segments": segments,
                "speaker_transcript": speaker_transcript(segments),
                "srt": segments_to_srt(segments),
                "vtt": segments_to_vtt(segments),
                "duration": duration,
                "mode": mode,
                "language": next((name for name, codes in LANGUAGES.items() if codes == language_codes), "Auto detect"),
            }
    finally:
        if remote_file is not None:
            try:
                client.files.delete(name=remote_file.name)
            except Exception:
                pass
        try:
            client.close()
        except Exception:
            pass


def transcribe_media(
    uploaded: Any,
    api_keys: list[str],
    language_codes: list[str],
    mode: str,
    custom_vocabulary: list[str],
) -> dict[str, Any]:
    """Transcribe using the first available key and fail over automatically on HTTP 429."""
    return run_with_api_failover(
        api_keys,
        lambda api_key: _transcribe_media_once(
            uploaded=uploaded,
            api_key=api_key,
            language_codes=language_codes,
            mode=mode,
            custom_vocabulary=custom_vocabulary,
        ),
        "Transcription",
    )


def _ai_text_once(api_key: str, prompt: str) -> str:
    client = genai.Client(api_key=api_key)
    try:
        result = client.interactions.create(model=CONTENT_MODEL, input=prompt)
        text = str(getattr(result, "output_text", "") or "").strip()
        if not text:
            raise RuntimeError("Gemini returned an empty result.")
        return text
    finally:
        try:
            client.close()
        except Exception:
            pass


def ai_text(api_keys: list[str], prompt: str, purpose: str = "AI tool") -> str:
    """Generate text using automatic key failover when a configured key returns HTTP 429."""
    return run_with_api_failover(
        api_keys,
        lambda api_key: _ai_text_once(api_key, prompt),
        purpose,
    )


def transcript_for_analysis(result: dict[str, Any]) -> str:
    detailed = result.get("speaker_transcript") or ""
    base = detailed if detailed else result.get("transcript", "")
    if len(base) > MAX_ANALYSIS_CHARS:
        base = base[:MAX_ANALYSIS_CHARS] + "\n\n[Transcript truncated for this AI add-on.]"
    return base


def generate_summary(api_keys: list[str], result: dict[str, Any]) -> str:
    transcript = transcript_for_analysis(result)
    return ai_text(
        api_keys,
        """Summarize the following transcript for a client. Keep the summary accurate and useful.
Use the same main language as the transcript. Include:
1) a short executive summary,
2) 5-10 key points,
3) action items or decisions only if they are actually present.
Do not invent facts.\n\nTRANSCRIPT:\n""" + transcript,
        purpose="Summary",
    )


def generate_translation(api_keys: list[str], result: dict[str, Any], target: str) -> str:
    transcript = transcript_for_analysis(result)
    return ai_text(
        api_keys,
        f"""Translate the transcript below into {target}. Preserve meaning, names, numbers, and paragraph structure.
If timestamp/speaker labels are present, preserve them. Do not summarize.\n\nTRANSCRIPT:\n{transcript}""",
        purpose=f"Translation to {target}",
    )


def generate_content_pack(api_keys: list[str], result: dict[str, Any]) -> str:
    transcript = transcript_for_analysis(result)
    timestamp_note = (
        "The transcript includes timestamps, so create accurate YouTube chapter suggestions from them."
        if result.get("speaker_transcript")
        else "The transcript has no reliable timestamps, so do not invent chapter times."
    )
    return ai_text(
        api_keys,
        f"""Turn this transcript into a practical creator/client content pack. Use the transcript's main language unless English is clearly better for a field.
{timestamp_note}
Return these sections:
- 10 strong title ideas
- Short description
- Full SEO-friendly description
- Key takeaways
- 5 short hooks for reels/shorts
- Suggested social caption
- Relevant tags/keywords/hashtags
- YouTube chapters only when reliable timestamps are present
- One clear CTA
Do not invent claims that are not in the transcript.\n\nTRANSCRIPT:\n{transcript}""",
        purpose="Creator content pack",
    )


def make_docx_bytes(title: str, sections: list[tuple[str, str]]) -> bytes:
    doc = Document()
    doc.add_heading(title, level=0)
    for heading, body in sections:
        if not body:
            continue
        doc.add_heading(heading, level=1)
        for paragraph in body.split("\n"):
            doc.add_paragraph(paragraph)
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def make_zip_bytes(base_name: str, result: dict[str, Any], extras: dict[str, str]) -> bytes:
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{base_name}_transcript.txt", result.get("transcript", ""))
        if result.get("speaker_transcript"):
            zf.writestr(f"{base_name}_speaker_transcript.txt", result["speaker_transcript"])
        if result.get("srt"):
            zf.writestr(f"{base_name}.srt", result["srt"])
        if result.get("vtt"):
            zf.writestr(f"{base_name}.vtt", result["vtt"])
        for key, value in extras.items():
            if value:
                zf.writestr(f"{base_name}_{key}.txt", value)
        docx_sections = [("Transcript", result.get("transcript", ""))]
        if result.get("speaker_transcript"):
            docx_sections.append(("Speaker Transcript", result["speaker_transcript"]))
        docx_sections.extend((key.replace("_", " ").title(), value) for key, value in extras.items() if value)
        zf.writestr(f"{base_name}_complete.docx", make_docx_bytes(APP_TITLE, docx_sections))
    return memory.getvalue()


def sanitize_bulk_output_name(raw_name: str, index: int) -> str:
    """Create a safe, human-readable VTT basename from the user's custom name."""
    name = str(raw_name or "").strip()
    if name.lower().endswith(".vtt"):
        name = name[:-4]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name[:120].strip(" .") or f"Video {index:02d}")


def unique_bulk_output_name(raw_name: str, index: int, used: set[str]) -> str:
    """Keep ZIP filenames unique while preserving the requested custom name."""
    base = sanitize_bulk_output_name(raw_name, index)
    candidate = base
    counter = 2
    while candidate.lower() in used:
        candidate = f"{base} ({counter})"
        counter += 1
    used.add(candidate.lower())
    return candidate


def make_bulk_vtt_zip_bytes(items: list[dict[str, Any]]) -> bytes:
    """Create one ZIP containing one VTT file per successful URL."""
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in items:
            filename = str(item.get("filename") or "Video").strip()
            vtt = str(item.get("vtt") or "")
            if vtt:
                zf.writestr(f"{filename}.vtt", vtt)
    return memory.getvalue()


def init_bulk_url_state() -> None:
    """Initialize stable IDs for dynamically added URL/name rows."""
    if "bulk_url_rows" not in st.session_state:
        st.session_state["bulk_url_rows"] = [1]
    if "bulk_url_next_id" not in st.session_state:
        st.session_state["bulk_url_next_id"] = 2


def add_bulk_url_row() -> None:
    rows = st.session_state.setdefault("bulk_url_rows", [1])
    if len(rows) >= MAX_BULK_URLS:
        return
    next_id = int(st.session_state.get("bulk_url_next_id", 2))
    rows.append(next_id)
    st.session_state["bulk_url_next_id"] = next_id + 1


def remove_bulk_url_row(row_id: int) -> None:
    rows = st.session_state.setdefault("bulk_url_rows", [1])
    if len(rows) <= 1:
        return
    if row_id in rows:
        rows.remove(row_id)
    st.session_state.pop(f"bulk_url_{row_id}", None)
    st.session_state.pop(f"bulk_name_{row_id}", None)


def clear_bulk_url_rows() -> None:
    for row_id in list(st.session_state.get("bulk_url_rows", [])):
        st.session_state.pop(f"bulk_url_{row_id}", None)
        st.session_state.pop(f"bulk_name_{row_id}", None)
    st.session_state["bulk_url_rows"] = [1]
    st.session_state["bulk_url_next_id"] = 2
    st.session_state.pop("bulk_results", None)
    st.session_state.pop("bulk_vtt_zip", None)
    st.session_state.pop("bulk_zip_name", None)


def reset_outputs() -> None:
    for key in [
        "result",
        "summary",
        "translation",
        "content_pack",
        "translation_target",
        "translation_target_selector",
        "summary_output",
        "translation_output",
        "content_pack_output",
        "source_name",
        "bulk_results",
        "bulk_vtt_zip",
        "bulk_zip_name",
    ]:
        st.session_state.pop(key, None)
    st.session_state["workspace_instance"] = st.session_state.get("workspace_instance", 0) + 1


def render_access_gate() -> bool:
    access_code = secret_or_env("APP_ACCESS_CODE")
    if not access_code:
        return True
    if st.session_state.get("access_granted"):
        return True
    st.title(APP_TITLE)
    st.caption("Private client preview")
    entered = st.text_input("Access code", type="password")
    if st.button("Open app", type="primary"):
        if entered == access_code:
            st.session_state.access_granted = True
            st.rerun()
        else:
            st.error("Incorrect access code.")
    return False


st.set_page_config(page_title=APP_TITLE, page_icon="🎙️", layout="wide")


@st.fragment(key="ai_client_tools")
def render_ai_client_tools(result: dict[str, Any], content_api_keys: list[str]) -> None:
    """Render AI client tools in an isolated fragment so AI actions don't rerun the whole app."""
    st.subheader("Turn the transcript into client-ready deliverables")
    st.caption("These are generated only when you click a button, so you control extra API usage.")

    col_a, col_b = st.columns(2)
    with col_a:
        if st.button(
            "Generate summary + key points",
            use_container_width=True,
            disabled=not bool(content_api_keys),
            key="generate_summary",
        ):
            with st.spinner("Creating summary…"):
                try:
                    st.session_state.summary = generate_summary(content_api_keys, result)
                except Exception as exc:
                    st.error(f"Summary failed: {exc}")

    with col_b:
        if st.button(
            "Generate creator content pack",
            use_container_width=True,
            disabled=not bool(content_api_keys),
            key="generate_content_pack",
        ):
            with st.spinner("Creating creator content pack…"):
                try:
                    st.session_state.content_pack = generate_content_pack(content_api_keys, result)
                except Exception as exc:
                    st.error(f"Creator content pack failed: {exc}")

    target = st.selectbox(
        "Translation target",
        TRANSLATION_LANGUAGES,
        key="translation_target_selector",
    )
    if st.button(
        f"Translate full transcript to {target}",
        use_container_width=True,
        disabled=not bool(content_api_keys),
        key="translate_transcript",
    ):
        with st.spinner(f"Translating to {target}…"):
            try:
                st.session_state.translation = generate_translation(content_api_keys, result, target)
                st.session_state.translation_target = target
            except Exception as exc:
                st.error(f"Translation failed: {exc}")

    if st.session_state.get("summary"):
        st.markdown("### Summary & key points")
        st.text_area(
            "Summary",
            st.session_state.summary,
            height=300,
            key="summary_output",
        )
        render_copy_button(st.session_state.summary, "Copy TXT")

    if st.session_state.get("translation"):
        label = st.session_state.get("translation_target", "Translation")
        st.markdown(f"### {label} translation")
        st.text_area(
            "Translated transcript",
            st.session_state.translation,
            height=360,
            key="translation_output",
        )
        render_copy_button(st.session_state.translation, "Copy TXT")

    if st.session_state.get("content_pack"):
        st.markdown("### Creator content pack")
        st.text_area(
            "Content pack",
            st.session_state.content_pack,
            height=430,
            key="content_pack_output",
        )
        render_copy_button(st.session_state.content_pack, "Copy TXT")


THEMES = {
    "Midnight Neon": {
        "bg": "#07111f", "panel": "#0d1728", "panel2": "#101d31", "text": "#f7fbff",
        "muted": "#93a4bc", "accent": "#7c5cff", "accent2": "#00d7ff", "border": "rgba(148,163,184,.18)",
        "hero1": "#161d46", "hero2": "#0d2944", "glow": "rgba(124,92,255,.30)",
    },
    "Ocean Glass": {
        "bg": "#06151d", "panel": "#0a202b", "panel2": "#0d2835", "text": "#effcff",
        "muted": "#99bcc7", "accent": "#11b5e4", "accent2": "#35f0c1", "border": "rgba(125,211,252,.18)",
        "hero1": "#0b2d3c", "hero2": "#0a3b47", "glow": "rgba(17,181,228,.26)",
    },
    "Emerald Studio": {
        "bg": "#071611", "panel": "#0b2019", "panel2": "#0f2a21", "text": "#f3fff9",
        "muted": "#9ab9aa", "accent": "#28d17c", "accent2": "#8df3b9", "border": "rgba(134,239,172,.18)",
        "hero1": "#123526", "hero2": "#0c2c28", "glow": "rgba(40,209,124,.26)",
    },
    "Retro Wave": {
        "bg": "#120817", "panel": "#1a0d25", "panel2": "#241135", "text": "#fff4df",
        "muted": "#d2a8c9", "accent": "#ff4fd8", "accent2": "#00e6ff", "border": "rgba(255,118,194,.18)",
        "hero1": "#3b165d", "hero2": "#241357", "glow": "rgba(255,79,216,.28)",
    },
}

# Theme is intentionally stored in session state so switching it reruns the app instantly.
if "ui_theme" not in st.session_state:
    st.session_state.ui_theme = "Midnight Neon"

with st.sidebar:
    st.markdown("<div class='side-kicker'>APPEARANCE</div>", unsafe_allow_html=True)
    selected_theme = st.selectbox(
        "Dashboard theme",
        list(THEMES.keys()),
        index=list(THEMES.keys()).index(st.session_state.ui_theme),
        key="theme_picker",
    )
    st.session_state.ui_theme = selected_theme

t = THEMES[st.session_state.ui_theme]

st.markdown(
    f"""
<style>
:root {{
  --tf-bg:{t['bg']}; --tf-panel:{t['panel']}; --tf-panel2:{t['panel2']}; --tf-text:{t['text']};
  --tf-muted:{t['muted']}; --tf-accent:{t['accent']}; --tf-accent2:{t['accent2']};
  --tf-border:{t['border']}; --tf-hero1:{t['hero1']}; --tf-hero2:{t['hero2']}; --tf-glow:{t['glow']};
}}

html, body, [data-testid="stAppViewContainer"], [data-testid="stApp"] {{
  background: var(--tf-bg) !important;
  color: var(--tf-text) !important;
}}
[data-testid="stHeader"] {{background: transparent !important;}}
[data-testid="stToolbar"] {{right: 1rem;}}
[data-testid="stSidebar"] {{
  background: linear-gradient(180deg, var(--tf-panel), var(--tf-bg)) !important;
  border-right: 1px solid var(--tf-border);
}}
[data-testid="stSidebar"] * {{color: var(--tf-text);}}

.block-container {{max-width: 1180px; padding-top: 1.45rem; padding-bottom: 4rem;}}

.hero {{
  position: relative; overflow: hidden; padding: 1.8rem 1.9rem; border: 1px solid var(--tf-border);
  border-radius: 26px; margin-bottom: 1.25rem;
  background: linear-gradient(135deg, var(--tf-hero1), var(--tf-hero2));
  box-shadow: 0 24px 70px var(--tf-glow);
}}
.hero:after {{
  content: ""; position:absolute; width:260px; height:260px; border-radius:50%; right:-95px; top:-125px;
  background: radial-gradient(circle, var(--tf-accent2) 0%, transparent 67%); opacity:.22; filter: blur(8px);
}}
.hero-top {{display:flex; align-items:center; gap:.65rem; margin-bottom:.7rem; position:relative; z-index:1;}}
.brand-dot {{width:10px; height:10px; border-radius:50%; background:var(--tf-accent2); box-shadow:0 0 18px var(--tf-accent2);}}
.brand-chip {{font-size:.75rem; letter-spacing:.12em; text-transform:uppercase; color:var(--tf-muted); font-weight:800;}}
.hero h1 {{margin: 0; font-size: clamp(2rem, 4vw, 3.35rem); line-height:1.03; letter-spacing:-.04em; position:relative; z-index:1;}}
.hero p {{margin: .85rem 0 0 0; color:var(--tf-muted); max-width:780px; font-size:1.02rem; line-height:1.7; position:relative; z-index:1;}}
.hero-badges {{display:flex; flex-wrap:wrap; gap:.55rem; margin-top:1.1rem; position:relative; z-index:1;}}
.hero-badge {{padding:.42rem .72rem; border:1px solid var(--tf-border); border-radius:999px; background:rgba(255,255,255,.04); font-size:.8rem; font-weight:700;}}

.side-kicker {{font-size:.68rem; letter-spacing:.16em; font-weight:800; color:var(--tf-muted); margin:.15rem 0 .4rem;}}
.section-label {{font-size:.72rem; text-transform:uppercase; letter-spacing:.14em; color:var(--tf-muted); font-weight:800; margin-bottom:.25rem;}}
.empty-card {{padding:1.4rem; border:1px dashed var(--tf-border); border-radius:20px; background:var(--tf-panel); color:var(--tf-muted); margin-top:.8rem;}}
.empty-card strong {{color:var(--tf-text);}}

/* Cards / containers */
[data-testid="stMetric"] {{
  background: var(--tf-panel); border:1px solid var(--tf-border); border-radius:18px; padding: .9rem 1rem;
  box-shadow: 0 10px 30px rgba(0,0,0,.10);
}}
[data-testid="stMetricLabel"] {{color:var(--tf-muted) !important;}}
[data-testid="stMetricValue"] {{color:var(--tf-text) !important; font-size:1.15rem !important;}}
[data-testid="stFileUploader"] {{
  background:var(--tf-panel); border:1px solid var(--tf-border); border-radius:20px; padding:.35rem .65rem;
}}
[data-testid="stFileUploaderDropzone"] {{
  border:1px dashed var(--tf-border) !important; background:var(--tf-panel2) !important; border-radius:16px !important;
}}

/* Inputs */
.stTextInput input, .stTextArea textarea, [data-baseweb="select"] > div {{
  background:var(--tf-panel2) !important; color:var(--tf-text) !important; border-color:var(--tf-border) !important;
}}
.stTextArea textarea {{border-radius:14px !important;}}

/* Buttons */
.stButton > button, .stDownloadButton > button {{
  border-radius:13px !important; border:1px solid var(--tf-border) !important;
  background:var(--tf-panel2) !important; color:var(--tf-text) !important; font-weight:750 !important;
  transition:transform .16s ease, border-color .16s ease, box-shadow .16s ease;
}}
.stButton > button:hover, .stDownloadButton > button:hover {{
  transform:translateY(-1px); border-color:var(--tf-accent) !important; box-shadow:0 10px 26px var(--tf-glow);
}}
.stButton > button[kind="primary"] {{
  background:linear-gradient(90deg, var(--tf-accent), var(--tf-accent2)) !important;
  color:white !important; border:0 !important; min-height:3rem;
}}

/* Calm native workspace tabs */
.stTabs {{
  margin: .35rem 0 1.1rem 0;
}}
.stTabs [data-baseweb="tab-list"] {{
  gap: 0 !important;
  padding: 3px !important;
  border: 1px solid var(--tf-border) !important;
  border-radius: 14px !important;
  background: var(--tf-panel) !important;
  overflow: hidden !important;
}}
.stTabs [data-baseweb="tab"] {{
  min-height: 2.65rem !important;
  padding: .55rem .95rem !important;
  border-radius: 10px !important;
  color: var(--tf-muted) !important;
  font-weight: 750 !important;
  transition:
    color .28s ease,
    background-color .28s ease,
    transform .24s cubic-bezier(.22,1,.36,1) !important;
}}
.stTabs [data-baseweb="tab"]:hover {{
  color: var(--tf-text) !important;
  background: rgba(255,255,255,.035) !important;
  transform: translateY(-1px);
}}
.stTabs [data-baseweb="tab"][aria-selected="true"] {{
  color: var(--tf-text) !important;
  background: linear-gradient(135deg, var(--tf-accent), var(--tf-accent2)) !important;
  box-shadow: 0 8px 24px var(--tf-glow);
}}
.stTabs [data-baseweb="tab-highlight"] {{
  display: none !important;
}}
.stTabs [data-baseweb="tab-border"] {{
  display: none !important;
}}
.stTabs [role="tabpanel"] {{
  animation: tfNativeTabEnter .28s ease-out both;
  transform-origin: top center;
}}
@keyframes tfNativeTabEnter {{
  from {{
    opacity: 0;
    transform: translate3d(0, 8px, 0);
  }}
  to {{
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }}
}}
@media (prefers-reduced-motion: reduce) {{
  .stTabs [data-baseweb="tab"],
  .stTabs [role="tabpanel"] {{
    animation: none !important;
    transition: none !important;
  }}
}}

/* Media source tabs */
.stTabs [data-baseweb="tab-list"] {{
  background: var(--tf-panel) !important;
}}
.stTabs [data-baseweb="tab"] {{
  transition: color .24s ease, background-color .24s ease, transform .22s ease !important;
}}
.stTabs [data-baseweb="tab"]:hover {{
  transform: translateY(-1px);
}}
.stTabs [data-baseweb="tab"][aria-selected="true"] {{
  color: var(--tf-text) !important;
  background: linear-gradient(135deg, var(--tf-accent), var(--tf-accent2)) !important;
  border-radius: 10px !important;
}}

/* Bulk URL input */
.bulk-url-head {{
  display:grid;
  grid-template-columns:minmax(0, 2fr) minmax(180px, 1fr);
  gap:1rem;
  padding:.75rem .9rem .35rem;
  color:var(--tf-text);
}}
.bulk-url-head div {{
  display:flex;
  flex-direction:column;
  gap:.15rem;
}}
.bulk-url-head span {{
  color:var(--tf-muted);
  font-size:.72rem;
}}
@media (max-width: 720px) {{
  .bulk-url-head {{display:none;}}
}}

/* Status / alerts */
[data-testid="stAlert"] {{border-radius:14px !important; border:1px solid var(--tf-border) !important;}}
[data-testid="stStatusWidget"] {{border-radius:16px !important; border:1px solid var(--tf-border) !important; background:var(--tf-panel) !important;}}
hr {{border-color:var(--tf-border) !important;}}

.small-muted {{color:var(--tf-muted); font-size:.9rem;}}
.output-card {{border:1px solid var(--tf-border); border-radius:16px; padding:1rem; background:var(--tf-panel);}}
.copy-control {{margin: 0 0 .35rem 0;}}

.dev-card {{
  margin-top: 1.1rem;
  padding: .9rem 1rem;
  border: 1px solid var(--tf-border);
  border-radius: 16px;
  background: var(--tf-panel2);
}}
.dev-card .dev-label {{
  font-size: .67rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--tf-muted);
  font-weight: 800;
  margin-bottom: .28rem;
}}
.dev-card a {{
  color: var(--tf-text) !important;
  text-decoration: none !important;
  font-weight: 800;
}}
.dev-card a:hover {{
  color: var(--tf-accent2) !important;
}}
.dev-card .dev-sub {{
  color: var(--tf-muted);
  font-size: .78rem;
  margin-top: .2rem;
}}

/* Streamlit text colors */
p, label, .stMarkdown, .stCaption, [data-testid="stWidgetLabel"] {{color:var(--tf-text);}}
.stCaption, small {{color:var(--tf-muted) !important;}}

@media (max-width: 800px) {{
  .block-container {{padding-left:1rem; padding-right:1rem;}}
  .hero {{padding:1.35rem; border-radius:20px;}}
  .hero h1 {{font-size:2rem;}}
}}
</style>
""",
    unsafe_allow_html=True,
)

if not render_access_gate():
    st.stop()

st.markdown(
    f"""
<div class="hero">
  <div class="hero-top"><span class="brand-dot"></span><span class="brand-chip">Team Fahad AI Studio</span></div>
  <h1>Turn media into usable content.</h1>
  <p>Upload a file or paste multiple media links. Get polished transcripts, speaker-aware subtitles, VTT files and client-ready deliverables from one clean workspace.</p>
  <div class="hero-badges">
    <span class="hero-badge">Audio + Video</span>
    <span class="hero-badge">Speaker Detection</span>
    <span class="hero-badge">SRT / VTT</span>
    <span class="hero-badge">AI Summary</span>
    <span class="hero-badge">Translation</span>
  </div>
</div>
""",
    unsafe_allow_html=True,
)

transcription_api_keys = load_api_key_pool("TRANSCRIBE")
content_api_keys = load_api_key_pool("CONTENT")

if not transcription_api_keys and not content_api_keys:
    st.warning(
        "Developer setup: no Gemini API key was found. Add GEMINI_API_KEY or GEMINI_API_KEYS "
        "in Streamlit Secrets/environment variables."
    )
    local_api_key = st.text_input("Gemini API key for this local session", type="password")
    if local_api_key:
        transcription_api_keys = [local_api_key]
        content_api_keys = [local_api_key]

# If only one specialized pool exists, let the other feature group use it too.
if not transcription_api_keys and content_api_keys:
    transcription_api_keys = content_api_keys
if not content_api_keys and transcription_api_keys:
    content_api_keys = transcription_api_keys

with st.sidebar:
    st.markdown("<div class='side-kicker' style='margin-top:1.2rem'>TRANSCRIPTION</div>", unsafe_allow_html=True)
    st.subheader("Settings")
    language_name = st.selectbox("Spoken language", list(LANGUAGES.keys()), index=0)
    mode = st.radio(
        "Output mode",
        ["Smart clean transcript", "Detailed subtitles + speakers", "Exact verbatim transcript"],
        help=(
            "Smart cleans filler words and formatting. Detailed enables speaker labels and word timestamps. "
            "Exact verbatim preserves what was spoken."
        ),
    )

    custom_vocab_text = ""
    if mode != "Detailed subtitles + speakers":
        custom_vocab_text = st.text_area(
            "Custom vocabulary (optional)",
            placeholder="Tamrin Institute, Team Fahad, product names...",
            help="One term per line or comma-separated. Best for uncommon names and technical words.",
        )
    else:
        st.caption("Custom vocabulary is disabled in detailed speaker/timestamp mode.")

    st.divider()
    st.caption("Privacy: temporary local files are deleted after processing, and the Gemini Files API copy is deleted after the request.")
    st.caption(
        f"API failover: {len(transcription_api_keys)} transcription slot(s) · "
        f"{len(content_api_keys)} AI-tool slot(s). HTTP 429 automatically moves to the next available slot."
    )

    st.markdown(
        '''
        <div class="dev-card">
          <div class="dev-label">Developer</div>
          <a href="https://github.com/umar-vai" target="_blank">Umar Vai ↗</a>
          <div class="dev-sub">github.com/umar-vai</div>
        </div>
        ''',
        unsafe_allow_html=True,
    )

st.markdown("<div class='section-label'>01 · Upload & process</div>", unsafe_allow_html=True)
st.markdown("### Start with your media")

vocab = [item.strip() for item in re.split(r"[,\n]", custom_vocab_text) if item.strip()]

init_bulk_url_state()

source_tabs = st.tabs(
    ["Upload file", "Paste link"],
    key="source_input_tabs",
    on_change="rerun",
)

uploaded = None
bulk_link_rows: list[dict[str, str | int]] = []

with source_tabs[0]:
    st.caption("Upload an audio or video file. Your selected transcription mode and language settings are applied automatically.")
    uploaded = st.file_uploader(
        "Upload audio or video",
        type=["mp3", "wav", "m4a", "aac", "ogg", "flac", "mp4", "mov", "mkv"],
        help=f"Maximum local upload size: {MAX_UPLOAD_MB} MB. Linked media can be up to {MAX_LINK_MB} MB.",
        key="media_file_uploader",
        max_upload_size=MAX_UPLOAD_MB,
    )

with source_tabs[1]:
    st.caption(
        "Paste one or more public media URLs. Each URL can have its own custom name, "
        "and all successful VTT files can be downloaded together as one ZIP."
    )

    st.markdown(
        """
        <div class="bulk-url-head">
          <div><strong>Media URL</strong><span>Google Drive, direct media, YouTube and other supported links • up to {MAX_LINK_MB} MB</span></div>
          <div><strong>Custom name</strong><span>This becomes the VTT filename</span></div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    for position, row_id in enumerate(st.session_state["bulk_url_rows"], start=1):
        url_key = f"bulk_url_{row_id}"
        name_key = f"bulk_name_{row_id}"
        if name_key not in st.session_state:
            st.session_state[name_key] = f"Video {position:02d}"

        url_col, name_col, remove_col = st.columns(
            [5.2, 2.5, 0.55],
            vertical_alignment="bottom",
            gap="small",
        )
        with url_col:
            url_value = st.text_input(
                f"Media URL {position}",
                placeholder="https://drive.google.com/file/d/... or https://youtube.com/watch?v=...",
                key=url_key,
                label_visibility="collapsed",
                type="url",
                on_change="ignore",
            )
        with name_col:
            name_value = st.text_input(
                f"Custom name {position}",
                placeholder=f"Video {position:02d}",
                key=name_key,
                label_visibility="collapsed",
                max_chars=120,
                on_change="ignore",
            )
        with remove_col:
            st.button(
                "×",
                key=f"remove_bulk_url_{row_id}",
                help="Remove this URL",
                disabled=len(st.session_state["bulk_url_rows"]) <= 1,
                on_click=remove_bulk_url_row,
                args=(row_id,),
            )

        bulk_link_rows.append(
            {
                "id": row_id,
                "url": str(url_value or "").strip(),
                "name": str(name_value or "").strip(),
            }
        )

    add_col, clear_col, count_col = st.columns([1.35, 1.0, 1.65], vertical_alignment="center")
    with add_col:
        st.button(
            "Add More URL",
            icon=":material/add_link:",
            on_click=add_bulk_url_row,
            disabled=len(st.session_state["bulk_url_rows"]) >= MAX_BULK_URLS,
            width="stretch",
        )
    with clear_col:
        st.button(
            "Clear URLs",
            on_click=clear_bulk_url_rows,
            width="stretch",
        )
    with count_col:
        count_text = f"{len(st.session_state['bulk_url_rows'])} URL slot"
        if len(st.session_state["bulk_url_rows"]) != 1:
            count_text += "s"
        st.caption(f"{count_text} • up to {MAX_BULK_URLS} per batch")

    active_rows = [row for row in bulk_link_rows if row["url"]]
    if active_rows:
        st.info(
            "Bulk URL processing always uses Detailed subtitles + speakers so every successful item "
            "has reliable timestamped VTT output. Processing runs sequentially to reduce API spikes."
        )

        button_label = (
            "Transcribe URL"
            if len(active_rows) == 1
            else f"Transcribe {len(active_rows)} URLs"
        )

        if st.button(
            button_label,
            type="primary",
            disabled=not bool(transcription_api_keys),
            use_container_width=True,
            key="transcribe_bulk_links",
        ):
            reset_outputs()

            prepared_items: list[dict[str, str | int]] = []
            used_names: set[str] = set()
            validation_errors: list[str] = []

            for position, row in enumerate(active_rows, start=1):
                url = str(row["url"])
                custom_name = str(row["name"])
                try:
                    validate_public_media_url(url)
                except Exception as exc:
                    validation_errors.append(f"{position}. {exc}")
                    continue

                filename = unique_bulk_output_name(custom_name, position, used_names)
                prepared_items.append(
                    {
                        "position": position,
                        "url": url,
                        "filename": filename,
                    }
                )

            if validation_errors:
                for message in validation_errors:
                    st.error(message)

            if prepared_items:
                batch_results: list[dict[str, Any]] = []
                progress = st.progress(
                    0,
                    text=f"Preparing {len(prepared_items)} URL{'s' if len(prepared_items) != 1 else ''}…",
                )

                with st.status(
                    f"Processing {len(prepared_items)} URL{'s' if len(prepared_items) != 1 else ''}…",
                    expanded=True,
                    type="step",
                ) as batch_status:
                    for completed_index, item in enumerate(prepared_items, start=1):
                        filename = str(item["filename"])
                        batch_status.write(
                            f"Processing {completed_index}/{len(prepared_items)} — {filename}"
                        )

                        try:
                            with tempfile.TemporaryDirectory(prefix="team_fahad_bulk_") as link_dir:
                                folder = Path(link_dir)
                                linked_source = download_media_from_link(str(item["url"]), folder)
                                result = transcribe_media(
                                    uploaded=linked_source,
                                    api_keys=transcription_api_keys,
                                    language_codes=LANGUAGES[language_name],
                                    mode="Detailed subtitles + speakers",
                                    custom_vocabulary=[],
                                )
                                vtt = str(result.get("vtt") or "")
                                if not vtt:
                                    raise RuntimeError(
                                        "Transcription completed but no timestamped VTT was returned."
                                    )

                                batch_results.append(
                                    {
                                        "filename": filename,
                                        "vtt": vtt,
                                        "duration": result.get("duration"),
                                        "status": "Completed",
                                    }
                                )
                                batch_status.write(
                                    f"Completed — {filename}"
                                )
                        except errors.APIError as exc:
                            code = getattr(exc, "code", "API")
                            message = getattr(exc, "message", str(exc))
                            batch_results.append(
                                {
                                    "filename": filename,
                                    "status": "Failed",
                                    "error": f"Gemini request failed ({code}): {message}",
                                }
                            )
                            batch_status.write(f"Failed — {filename}: Gemini request error")
                        except Exception as exc:
                            batch_results.append(
                                {
                                    "filename": filename,
                                    "status": "Failed",
                                    "error": str(exc),
                                }
                            )
                            batch_status.write(f"Failed — {filename}: {str(exc)[:220]}")

                        progress_value = completed_index / len(prepared_items)
                        progress.progress(
                            progress_value,
                            text=f"Processed {completed_index} of {len(prepared_items)}",
                        )

                    successful = [item for item in batch_results if item.get("status") == "Completed"]
                    failed = [item for item in batch_results if item.get("status") == "Failed"]

                    st.session_state["bulk_results"] = batch_results
                    if successful:
                        st.session_state["bulk_vtt_zip"] = make_bulk_vtt_zip_bytes(successful)
                        st.session_state["bulk_zip_name"] = "Team-Fahad-Bulk-VTT.zip"

                    if failed:
                        batch_status.update(
                            label=f"Batch finished • {len(successful)} completed • {len(failed)} failed",
                            state="error" if not successful else "complete",
                            expanded=False,
                        )
                    else:
                        batch_status.update(
                            label=f"Batch finished • {len(successful)} completed",
                            state="complete",
                            expanded=False,
                        )

                progress.progress(
                    1.0,
                    text=f"Finished • {len(successful)} of {len(prepared_items)} completed",
                )

    if st.session_state.get("bulk_results"):
        results = st.session_state["bulk_results"]
        completed_count = sum(item.get("status") == "Completed" for item in results)
        failed_count = len(results) - completed_count

        st.markdown("### Bulk transcription results")
        summary_cols = st.columns(2)
        summary_cols[0].metric("Completed", completed_count)
        summary_cols[1].metric("Failed", failed_count)

        for index, item in enumerate(results, start=1):
            if item.get("status") == "Completed":
                duration = item.get("duration")
                duration_text = f" • {format_clock(float(duration))}" if duration else ""
                st.success(f"{item.get('filename')}.vtt — Completed{duration_text}")
            else:
                st.error(f"{item.get('filename')}.vtt — Failed: {item.get('error', 'Unknown error')}")

        if st.session_state.get("bulk_vtt_zip"):
            st.download_button(
                "Download all VTT files as ZIP",
                data=st.session_state["bulk_vtt_zip"],
                file_name=st.session_state.get("bulk_zip_name", "Team-Fahad-Bulk-VTT.zip"),
                mime="application/zip",
                type="primary",
                use_container_width=True,
                on_click="ignore",
                key="download_bulk_vtt_zip",
            )

if uploaded is not None:
    size_mb = getattr(uploaded, "size", 0) / (1024 * 1024)
    c1, c2, c3 = st.columns(3)
    c1.metric("File", uploaded.name)
    c2.metric("Size", f"{size_mb:.1f} MB")
    c3.metric("Mode", "Detailed" if mode.startswith("Detailed") else "Standard")

    if len(vocab) > 100:
        st.info("Only the first 100 custom vocabulary terms will be sent for best results.")

    if mode == "Detailed subtitles + speakers":
        st.info("Detailed mode is intended for recordings up to about 30 minutes. Standard modes support up to about 60 minutes per request.")

    if st.button("Transcribe file", type="primary", disabled=not bool(transcription_api_keys), use_container_width=True, key="transcribe_uploaded_file"):
        reset_outputs()
        st.session_state["source_kind"] = "file"
        if size_mb > MAX_UPLOAD_MB:
            st.error(f"Please upload a file smaller than {MAX_UPLOAD_MB} MB.")
        else:
            status = st.status("Preparing media…", expanded=True)
            try:
                status.write("Reading audio/video…")
                status.write("Uploading securely for transcription…")
                status.write("Running speech-to-text…")
                result = transcribe_media(
                    uploaded=uploaded,
                    api_keys=transcription_api_keys,
                    language_codes=LANGUAGES[language_name],
                    mode=mode,
                    custom_vocabulary=vocab,
                )
                st.session_state.result = result
                st.session_state.source_name = uploaded.name
                status.update(label="Transcription complete", state="complete", expanded=False)
            except errors.APIError as exc:
                status.update(label="Transcription failed", state="error")
                code = getattr(exc, "code", "API")
                message = getattr(exc, "message", str(exc))
                st.error(f"Gemini request failed ({code}): {message}")
            except Exception as exc:
                status.update(label="Transcription failed", state="error")
                st.error(str(exc))

result = st.session_state.get("result")
if result:
    source_name = st.session_state.get("source_name", "transcript")
    base_name = safe_name(source_name)

    if result.get("duration"):
        st.success(f"Completed • Media duration: {format_clock(result['duration'])}")
    else:
        st.success("Completed")

    st.markdown("<div class='section-label' style='margin-top:1.2rem'>02 · Workspace</div>", unsafe_allow_html=True)
    st.markdown("### Your transcription workspace")

    workspace_tabs_key = f"workspace_tabs_{st.session_state.get('workspace_instance', 0)}"
    tab_transcript, tab_subtitles, tab_ai, tab_downloads = st.tabs(
        ["Transcript", "Speakers & subtitles", "AI client tools", "Downloads"],
        default="Transcript",
        key=workspace_tabs_key,
        on_change="ignore",
    )

    with tab_transcript:
        st.subheader("Transcript")
        transcript_text = result.get("transcript", "")
        st.text_area("Transcript text", transcript_text, height=430)
        copy_col, _ = st.columns([0.28, 0.72])
        with copy_col:
            render_copy_button(transcript_text, "Copy TXT")

    with tab_subtitles:
        if result.get("segments"):
            st.subheader("Speaker transcript")
            speaker_text = result.get("speaker_transcript", "")
            st.text_area("Speaker + timestamp transcript", speaker_text, height=330)
            d1, d2, d3 = st.columns(3)
            with d1:
                render_copy_button(result.get("speaker_transcript", ""), "Copy TXT", height=42, top_offset=-8)
            d2.download_button(
                "Download SRT",
                result.get("srt", ""),
                file_name=f"{base_name}.srt",
                mime="application/x-subrip",
                use_container_width=True,
            )
            d3.download_button(
                "Download VTT",
                result.get("vtt", ""),
                file_name=f"{base_name}.vtt",
                mime="text/vtt",
                use_container_width=True,
            )
            st.caption(f"Subtitle segments: {len(result.get('segments', []))}")
        else:
            st.info("Speaker labels and subtitle files are created when you use “Detailed subtitles + speakers” mode.")

    with tab_ai:
        render_ai_client_tools(result, content_api_keys)

    with tab_downloads:
        extras = {
            "summary": st.session_state.get("summary", ""),
            f"translation_{str(st.session_state.get('translation_target', '')).lower()}": st.session_state.get("translation", ""),
            "content_pack": st.session_state.get("content_pack", ""),
        }
        sections = [("Transcript", result.get("transcript", ""))]
        if result.get("speaker_transcript"):
            sections.append(("Speaker Transcript", result.get("speaker_transcript", "")))
        if st.session_state.get("summary"):
            sections.append(("Summary & Key Points", st.session_state.summary))
        if st.session_state.get("translation"):
            sections.append((f"Translation - {st.session_state.get('translation_target', '')}", st.session_state.translation))
        if st.session_state.get("content_pack"):
            sections.append(("Creator Content Pack", st.session_state.content_pack))

        docx_data = make_docx_bytes(APP_TITLE, sections)
        zip_data = make_zip_bytes(base_name, result, extras)

        if st.session_state.get("bulk_vtt_zip"):
            st.markdown("### Bulk URL VTT pack")
            st.caption("The ZIP contains one VTT file per successful URL, using each URL's custom name.")
            st.download_button(
                "Download bulk VTT ZIP",
                data=st.session_state["bulk_vtt_zip"],
                file_name=st.session_state.get("bulk_zip_name", "Team-Fahad-Bulk-VTT.zip"),
                mime="application/zip",
                type="primary",
                width="stretch",
                on_click="ignore",
                key="download_bulk_vtt_zip_workspace",
            )

        st.write("Download a polished document or one ZIP containing every output currently generated.")
        dl1, dl2 = st.columns(2)
        dl1.download_button(
            "Download complete DOCX",
            docx_data,
            file_name=f"{base_name}_complete.docx",
            mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            use_container_width=True,
        )
        dl2.download_button(
            "Download everything as ZIP",
            zip_data,
            file_name=f"{base_name}_team_fahad_pack.zip",
            mime="application/zip",
            use_container_width=True,
        )


st.divider()
st.markdown(
    '''
    <div class="small-muted" style="text-align:center;padding:.4rem 0 1rem">
      Team Fahad AI Studio · Client-ready transcription workflow
      <br>
      Developed by <a href="https://github.com/umar-vai" target="_blank" style="color:var(--tf-accent2);text-decoration:none;font-weight:800;">Umar Vai</a>
    </div>
    ''',
    unsafe_allow_html=True,
)
