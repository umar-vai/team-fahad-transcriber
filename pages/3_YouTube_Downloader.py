from __future__ import annotations

import re
import shutil
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import streamlit as st
import yt_dlp


APP_NAME = "YouTube Downloader"
MAX_OUTPUT_MB = 450
MAX_OUTPUT_BYTES = MAX_OUTPUT_MB * 1024 * 1024
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}


st.set_page_config(
    page_title=f"{APP_NAME} | Team Fahad",
    page_icon="⬇️",
    layout="wide",
)

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
    .yt-hero {
        padding: 1.45rem 1.6rem;
        border: 1px solid rgba(148,163,184,.18);
        border-radius: 22px;
        background: linear-gradient(135deg, rgba(15,23,42,.88), rgba(15,23,42,.58));
        box-shadow: 0 18px 50px rgba(0,0,0,.22);
        margin-bottom: 1.2rem;
    }
    .yt-hero h1 {margin:0; font-size:2rem; letter-spacing:-.03em;}
    .yt-hero p {margin:.45rem 0 0; color:#a9b7cc; font-size:1rem;}
    .yt-badge {
        display:inline-flex; align-items:center; gap:.4rem; padding:.28rem .65rem;
        border-radius:999px; border:1px solid rgba(96,165,250,.25);
        background:rgba(37,99,235,.10); color:#bfdbfe; font-size:.78rem; font-weight:700;
        margin-bottom:.65rem;
    }
    .yt-card {
        border:1px solid rgba(148,163,184,.16); border-radius:18px;
        padding:1rem 1.05rem; background:rgba(15,23,42,.58); margin:.6rem 0;
    }
    .yt-muted {color:#94a3b8; font-size:.9rem;}
    div[data-testid="stDownloadButton"] button,
    div[data-testid="stButton"] button {border-radius:12px; min-height:44px; font-weight:700;}
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(
    """
    <div class="yt-hero">
      <div class="yt-badge">TEAM FAHAD AI STUDIO</div>
      <h1>YouTube Audio & Video Downloader</h1>
      <p>Paste one YouTube link, choose audio or video quality, then prepare a downloadable file.</p>
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


@st.cache_data(ttl=1800, show_spinner=False)
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
        "id": info.get("id"),
        "title": str(info.get("title") or "YouTube video"),
        "channel": str(info.get("channel") or info.get("uploader") or ""),
        "duration": info.get("duration"),
        "thumbnail": str(info.get("thumbnail") or ""),
        "webpage_url": str(info.get("webpage_url") or url),
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
            status_box.caption("Download finished. Preparing the final file…")
    return hook


def find_final_file(folder: Path) -> Path:
    ignored = {".part", ".ytdl", ".temp", ".tmp"}
    files = [
        path for path in folder.rglob("*")
        if path.is_file() and path.suffix.lower() not in ignored
    ]
    if not files:
        raise RuntimeError("The downloader finished but no output file was created.")
    preferred = [p for p in files if p.suffix.lower() in {".mp3", ".m4a", ".mp4", ".webm", ".mkv", ".mov"}]
    candidates = preferred or files
    return max(candidates, key=lambda p: p.stat().st_mtime)


def download_youtube(
    url: str,
    mode: str,
    custom_name: str,
    audio_format: str,
    audio_bitrate: str,
    video_quality: str,
    progress_bar: Any,
    status_box: Any,
) -> tuple[bytes, str, str]:
    with tempfile.TemporaryDirectory(prefix="team_fahad_yt_") as tmp:
        folder = Path(tmp)
        outtmpl = str(folder / f"{custom_name}.%(ext)s")
        hook = make_progress_hook(progress_bar, status_box)

        common: dict[str, Any] = {
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "cachedir": False,
            "socket_timeout": 30,
            "retries": 3,
            "fragment_retries": 3,
            "concurrent_fragment_downloads": 4,
            "max_filesize": MAX_OUTPUT_BYTES,
            "progress_hooks": [hook],
            "overwrites": True,
        }

        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            common["ffmpeg_location"] = ffmpeg

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
            expected_mime = "audio/mpeg" if codec == "mp3" else "audio/mp4"
        else:
            if video_quality == "Best available":
                format_selector = (
                    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/"
                    "bv*+ba/b"
                )
            else:
                height = int(video_quality.rstrip("p"))
                format_selector = (
                    f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
                    f"b[height<={height}][ext=mp4]/"
                    f"bv*[height<={height}]+ba/b[height<={height}]"
                )
            common.update(
                {
                    "format": format_selector,
                    "merge_output_format": "mp4",
                }
            )
            expected_mime = "video/mp4"

        try:
            with yt_dlp.YoutubeDL(common) as ydl:
                ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as exc:
            message = str(exc).strip()
            if "File is larger than max-filesize" in message or "max-filesize" in message.lower():
                raise RuntimeError(
                    f"The selected output is larger than the current {MAX_OUTPUT_MB} MB app limit. "
                    "Choose a lower video quality or download audio instead."
                ) from exc
            raise RuntimeError(f"YouTube download failed: {message[:700]}") from exc

        output = find_final_file(folder)
        size = output.stat().st_size
        if size > MAX_OUTPUT_BYTES:
            raise RuntimeError(
                f"The prepared file is larger than {MAX_OUTPUT_MB} MB. Choose a lower quality."
            )

        payload = output.read_bytes()
        filename = output.name
        suffix = output.suffix.lower()
        mime = {
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".mp4": "video/mp4",
            ".webm": "video/webm",
        }.get(suffix, expected_mime)
        return payload, filename, mime


url = st.text_input(
    "YouTube URL",
    placeholder="https://www.youtube.com/watch?v=...",
    key="youtube_downloader_url",
)

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
        channel = info.get("channel") or "YouTube"
        st.caption(f"{channel}  •  {format_duration(info.get('duration'))}")
        if st.button("Use this link in Transcriber", use_container_width=True):
            st.session_state["single_media_link"] = url.strip()
            st.switch_page("app.py")

    st.markdown('<div class="yt-card">', unsafe_allow_html=True)
    mode = st.segmented_control(
        "Download type",
        ["Audio", "Video"],
        default="Audio",
        key="youtube_download_mode",
    ) or "Audio"

    custom_default = safe_filename(info["title"])
    custom_name = st.text_input(
        "Custom file name",
        value=custom_default,
        max_chars=120,
        help="The extension is added automatically.",
    )

    if mode == "Audio":
        c1, c2 = st.columns(2)
        with c1:
            audio_format = st.selectbox("Audio format", ["MP3", "M4A"], index=0)
        with c2:
            audio_bitrate = st.selectbox("Audio quality", ["128", "192", "256", "320"], index=1)
        video_quality = "Best available"
        st.caption(f"Audio bitrate: {audio_bitrate} kbps")
    else:
        audio_format = "MP3"
        audio_bitrate = "192"
        video_quality = st.selectbox(
            "Video quality",
            ["360p", "480p", "720p", "1080p", "Best available"],
            index=2,
        )
        st.caption("Video and audio streams are merged automatically into an MP4 when needed.")

    st.markdown('</div>', unsafe_allow_html=True)

    prepared = st.session_state.get("youtube_prepared_download")
    config_signature = (
        url.strip(), mode, safe_filename(custom_name, custom_default), audio_format, audio_bitrate, video_quality
    )
    if prepared and prepared.get("signature") != config_signature:
        st.session_state.pop("youtube_prepared_download", None)
        prepared = None

    if st.button(
        f"Prepare {mode} Download",
        type="primary",
        use_container_width=True,
        key="prepare_youtube_download",
    ):
        progress = st.progress(0.0)
        status = st.empty()
        try:
            payload, filename, mime = download_youtube(
                url=url.strip(),
                mode=mode,
                custom_name=safe_filename(custom_name, custom_default),
                audio_format=audio_format,
                audio_bitrate=audio_bitrate,
                video_quality=video_quality,
                progress_bar=progress,
                status_box=status,
            )
            st.session_state["youtube_prepared_download"] = {
                "signature": config_signature,
                "bytes": payload,
                "filename": filename,
                "mime": mime,
                "size": len(payload),
            }
            status.success("File is ready.")
            st.rerun()
        except Exception as exc:
            progress.empty()
            status.empty()
            st.error(str(exc))

    prepared = st.session_state.get("youtube_prepared_download")
    if prepared and prepared.get("signature") == config_signature:
        size_mb = prepared["size"] / (1024 * 1024)
        st.success(f"Ready: {prepared['filename']} • {size_mb:.1f} MB")
        st.download_button(
            "Download file",
            data=prepared["bytes"],
            file_name=prepared["filename"],
            mime=prepared["mime"],
            type="primary",
            use_container_width=True,
        )
        if st.button("Clear prepared file", use_container_width=True):
            st.session_state.pop("youtube_prepared_download", None)
            st.rerun()

st.divider()
st.caption(
    "Use this downloader only for content you own, public-domain material, or media you have permission to download. "
    "Private, DRM-protected, login-only, or otherwise restricted videos are not bypassed. "
    f"Current prepared-file limit: {MAX_OUTPUT_MB} MB."
)
