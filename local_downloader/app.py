from __future__ import annotations

import os
import re
import urllib.parse
from pathlib import Path
from typing import Any

import streamlit as st
import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe

APP_NAME = "Team Fahad Local YouTube Downloader"
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}

DOWNLOAD_DIR = Path.home() / "Downloads" / "Team Fahad YouTube"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

st.set_page_config(page_title=APP_NAME, page_icon="⬇️", layout="wide")

st.markdown(
    """
    <style>
    .stApp {
        background:
            radial-gradient(circle at 12% 0%, rgba(44, 92, 255, .10), transparent 28%),
            radial-gradient(circle at 88% 10%, rgba(124, 58, 237, .10), transparent 30%),
            #07101f;
    }
    .block-container {max-width: 1120px; padding-top: 2.2rem; padding-bottom: 4rem;}
    .hero {
        padding: 1.45rem 1.6rem;
        border: 1px solid rgba(148,163,184,.18);
        border-radius: 22px;
        background: linear-gradient(135deg, rgba(15,23,42,.88), rgba(15,23,42,.58));
        box-shadow: 0 18px 50px rgba(0,0,0,.22);
        margin-bottom: 1.2rem;
    }
    .hero h1 {margin:0; font-size:2rem; letter-spacing:-.03em;}
    .hero p {margin:.45rem 0 0; color:#a9b7cc; font-size:1rem;}
    .badge {
        display:inline-flex; align-items:center; gap:.4rem; padding:.28rem .65rem;
        border-radius:999px; border:1px solid rgba(96,165,250,.25);
        background:rgba(37,99,235,.10); color:#bfdbfe; font-size:.78rem; font-weight:700;
        margin-bottom:.65rem;
    }
    .card {
        border:1px solid rgba(148,163,184,.16); border-radius:18px;
        padding:1rem 1.05rem; background:rgba(15,23,42,.58); margin:.6rem 0;
    }
    div[data-testid="stButton"] button {border-radius:12px; min-height:44px; font-weight:700;}
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(
    """
    <div class="hero">
      <div class="badge">TEAM FAHAD AI STUDIO · LOCAL MODE</div>
      <h1>Local YouTube Audio & Video Downloader</h1>
      <p>Runs on your own computer and saves files directly to your Downloads folder.</p>
    </div>
    """,
    unsafe_allow_html=True,
)


def is_youtube_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(value.strip())
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and (parsed.hostname or "").lower() in YOUTUBE_HOSTS


def safe_filename(value: str, fallback: str = "youtube_download") -> str:
    text = str(value or "").strip()
    text = re.sub(r"\.(mp3|m4a|mp4|webm|mkv|mov)$", "", text, flags=re.I)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return (text[:120] or fallback).strip()


def format_duration(seconds: Any) -> str:
    try:
        total = max(0, int(seconds or 0))
    except (TypeError, ValueError):
        return "—"
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


@st.cache_data(ttl=900, show_spinner=False)
def get_video_info(url: str) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "cachedir": False,
        "socket_timeout": 30,
        "retries": 2,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise RuntimeError("YouTube did not return video information.")
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        if not entries:
            raise RuntimeError("No video was found in that URL.")
        info = entries[0]
    return {
        "title": str(info.get("title") or "YouTube video"),
        "channel": str(info.get("channel") or info.get("uploader") or ""),
        "duration": info.get("duration"),
        "thumbnail": str(info.get("thumbnail") or ""),
    }


def make_progress_hook(progress_bar: Any, status_box: Any):
    def hook(data: dict[str, Any]) -> None:
        status = data.get("status")
        if status == "downloading":
            downloaded = int(data.get("downloaded_bytes") or 0)
            total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
            if total > 0:
                ratio = min(1.0, downloaded / total)
                progress_bar.progress(ratio)
                status_box.caption(f"Downloading… {ratio * 100:.1f}%")
            else:
                status_box.caption("Downloading from YouTube…")
        elif status == "finished":
            progress_bar.progress(1.0)
            status_box.caption("Download finished. Finalizing the file…")
    return hook


def download_youtube(
    url: str,
    mode: str,
    custom_name: str,
    audio_format: str,
    audio_bitrate: str,
    video_quality: str,
    progress_bar: Any,
    status_box: Any,
) -> Path:
    ffmpeg = get_ffmpeg_exe()
    outtmpl = str(DOWNLOAD_DIR / f"{custom_name}.%(ext)s")

    common: dict[str, Any] = {
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "cachedir": False,
        "socket_timeout": 30,
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
        "progress_hooks": [make_progress_hook(progress_bar, status_box)],
        "overwrites": True,
        "ffmpeg_location": ffmpeg,
    }

    if mode == "Audio":
        codec = audio_format.lower()
        common.update(
            {
                "format": "bestaudio[ext=m4a]/bestaudio/best",
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": codec,
                        "preferredquality": audio_bitrate,
                    }
                ],
            }
        )
        expected_exts = [f".{codec}"]
    else:
        if video_quality == "Best available":
            selector = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
        else:
            height = int(video_quality.rstrip("p"))
            selector = (
                f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
                f"b[height<={height}][ext=mp4]/"
                f"bv*[height<={height}]+ba/b[height<={height}]"
            )
        common.update({"format": selector, "merge_output_format": "mp4"})
        expected_exts = [".mp4", ".mkv", ".webm"]

    before = {p.resolve() for p in DOWNLOAD_DIR.glob(f"{custom_name}.*") if p.is_file()}

    try:
        with yt_dlp.YoutubeDL(common) as ydl:
            ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        message = str(exc).strip()
        lower = message.lower()
        if "sign in to confirm" in lower or "not a bot" in lower:
            raise RuntimeError(
                "YouTube asked this local session to sign in or confirm it is not a bot. "
                "Try again later or use YouTube's own download option for content you own."
            ) from exc
        if "private video" in lower or "members-only" in lower or "login" in lower:
            raise RuntimeError("This video requires account access and cannot be downloaded in public mode.") from exc
        raise RuntimeError(f"YouTube download failed: {message[:700]}") from exc

    candidates = [
        p for p in DOWNLOAD_DIR.glob(f"{custom_name}.*")
        if p.is_file() and p.resolve() not in before and p.suffix.lower() not in {".part", ".ytdl", ".tmp"}
    ]
    if not candidates:
        candidates = [
            p for p in DOWNLOAD_DIR.glob(f"{custom_name}.*")
            if p.is_file() and p.suffix.lower() in expected_exts
        ]
    if not candidates:
        raise RuntimeError("The download finished, but the final output file could not be found.")
    return max(candidates, key=lambda p: p.stat().st_mtime)


url = st.text_input("YouTube URL", placeholder="https://www.youtube.com/watch?v=...")

info: dict[str, Any] | None = None
if url.strip():
    if not is_youtube_url(url):
        st.error("Please paste a valid YouTube or youtu.be URL.")
    else:
        try:
            with st.spinner("Reading YouTube video information…"):
                info = get_video_info(url.strip())
        except Exception as exc:
            st.error(str(exc))

if info:
    left, right = st.columns([1, 2.2], gap="large")
    with left:
        if info.get("thumbnail"):
            st.image(info["thumbnail"], use_container_width=True)
    with right:
        st.subheader(info["title"])
        st.caption(f"{info.get('channel') or 'YouTube'} • {format_duration(info.get('duration'))}")

    st.markdown('<div class="card">', unsafe_allow_html=True)
    mode = st.segmented_control("Download type", ["Audio", "Video"], default="Audio") or "Audio"
    custom_default = safe_filename(info["title"])
    custom_name = safe_filename(
        st.text_input("Custom file name", value=custom_default, max_chars=120),
        custom_default,
    )

    if mode == "Audio":
        c1, c2 = st.columns(2)
        with c1:
            audio_format = st.selectbox("Audio format", ["MP3", "M4A"], index=0)
        with c2:
            audio_bitrate = st.selectbox("Audio quality", ["128", "192", "256", "320"], index=1)
        video_quality = "Best available"
    else:
        audio_format = "MP3"
        audio_bitrate = "192"
        video_quality = st.selectbox(
            "Video quality",
            ["360p", "480p", "720p", "1080p", "Best available"],
            index=2,
        )
    st.markdown('</div>', unsafe_allow_html=True)

    if st.button(f"Download {mode}", type="primary", use_container_width=True):
        progress = st.progress(0.0)
        status = st.empty()
        try:
            output = download_youtube(
                url=url.strip(),
                mode=mode,
                custom_name=custom_name,
                audio_format=audio_format,
                audio_bitrate=audio_bitrate,
                video_quality=video_quality,
                progress_bar=progress,
                status_box=status,
            )
            size_mb = output.stat().st_size / (1024 * 1024)
            status.success(f"Saved: {output.name} • {size_mb:.1f} MB")
            st.session_state["local_yt_last_file"] = str(output)
        except Exception as exc:
            progress.empty()
            status.empty()
            st.error(str(exc))

last_file = st.session_state.get("local_yt_last_file")
if last_file:
    path = Path(last_file)
    if path.exists():
        st.success(f"Last file: {path}")
        if os.name == "nt":
            if st.button("Open download folder", use_container_width=True):
                os.startfile(str(path.parent))

st.divider()
st.caption(f"Files are saved to: {DOWNLOAD_DIR}")
st.caption(
    "Use this tool only for content you own, public-domain material, or media you have permission to download. "
    "The app does not bypass private, DRM-protected, login-only, or other access restrictions."
)
