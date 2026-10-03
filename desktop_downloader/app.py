from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Any

import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe

APP_NAME = "Team Fahad YouTube Downloader"
DOWNLOAD_DIR = Path.home() / "Downloads" / "Team Fahad YouTube"
YOUTUBE_RE = re.compile(r"^https?://(?:(?:www\.|m\.|music\.)?youtube\.com|youtu\.be)/", re.I)


def safe_filename(value: str, fallback: str = "youtube_download") -> str:
    text = (value or "").strip()
    text = re.sub(r"\.(mp3|m4a|mp4|webm|mkv|mov)$", "", text, flags=re.I)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return (text[:140] or fallback).strip()


class DownloaderApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_NAME)
        self.geometry("900x620")
        self.minsize(820, 560)
        self.configure(bg="#08111f")

        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.current_info: dict[str, Any] | None = None

        self.url_var = tk.StringVar()
        self.name_var = tk.StringVar()
        self.mode_var = tk.StringVar(value="Video")
        self.video_quality_var = tk.StringVar(value="720p")
        self.audio_format_var = tk.StringVar(value="MP3")
        self.audio_quality_var = tk.StringVar(value="192")
        self.status_var = tk.StringVar(value="Ready")
        self.progress_var = tk.DoubleVar(value=0.0)

        self._configure_styles()
        self._build_ui()
        self.after(120, self._drain_events)

    def _configure_styles(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TFrame", background="#08111f")
        style.configure("Card.TFrame", background="#0f1b2d")
        style.configure("TLabel", background="#08111f", foreground="#e7eefc", font=("Segoe UI", 10))
        style.configure("Title.TLabel", background="#08111f", foreground="#ffffff", font=("Segoe UI Semibold", 23))
        style.configure("Muted.TLabel", background="#08111f", foreground="#93a4bb", font=("Segoe UI", 10))
        style.configure("Card.TLabel", background="#0f1b2d", foreground="#e7eefc", font=("Segoe UI", 10))
        style.configure("TButton", font=("Segoe UI Semibold", 10), padding=10)
        style.configure("Accent.TButton", font=("Segoe UI Semibold", 11), padding=12)
        style.configure("TRadiobutton", background="#08111f", foreground="#e7eefc", font=("Segoe UI", 10))
        style.map("TRadiobutton", background=[("active", "#08111f")], foreground=[("active", "#ffffff")])
        style.configure("Horizontal.TProgressbar", troughcolor="#1a2638", background="#35a7ff", bordercolor="#1a2638")

    def _build_ui(self) -> None:
        outer = ttk.Frame(self, padding=(28, 24))
        outer.pack(fill="both", expand=True)

        ttk.Label(outer, text=APP_NAME, style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            outer,
            text="Download audio or video on this PC. Files are saved in your Downloads folder.",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(4, 20))

        ttk.Label(outer, text="YouTube URL").pack(anchor="w")
        url_row = ttk.Frame(outer)
        url_row.pack(fill="x", pady=(6, 16))
        self.url_entry = ttk.Entry(url_row, textvariable=self.url_var, font=("Segoe UI", 11))
        self.url_entry.pack(side="left", fill="x", expand=True)
        ttk.Button(url_row, text="Read video", command=self.read_video).pack(side="left", padx=(10, 0))

        card = ttk.Frame(outer, style="Card.TFrame", padding=18)
        card.pack(fill="x", pady=(0, 16))

        ttk.Label(card, text="Custom file name", style="Card.TLabel").grid(row=0, column=0, sticky="w", columnspan=4)
        ttk.Entry(card, textvariable=self.name_var, font=("Segoe UI", 10)).grid(
            row=1, column=0, columnspan=4, sticky="ew", pady=(6, 16)
        )

        ttk.Label(card, text="Download type", style="Card.TLabel").grid(row=2, column=0, sticky="w")
        mode_row = ttk.Frame(card, style="Card.TFrame")
        mode_row.grid(row=3, column=0, sticky="w", pady=(6, 0))
        ttk.Radiobutton(mode_row, text="Video", value="Video", variable=self.mode_var, command=self._sync_mode).pack(side="left")
        ttk.Radiobutton(mode_row, text="Audio", value="Audio", variable=self.mode_var, command=self._sync_mode).pack(side="left", padx=(12, 0))

        ttk.Label(card, text="Video quality", style="Card.TLabel").grid(row=2, column=1, sticky="w", padx=(18, 0))
        self.video_quality = ttk.Combobox(
            card,
            textvariable=self.video_quality_var,
            values=["360p", "480p", "720p", "1080p", "Best available"],
            state="readonly",
            width=18,
        )
        self.video_quality.grid(row=3, column=1, sticky="w", padx=(18, 0), pady=(6, 0))

        ttk.Label(card, text="Audio format", style="Card.TLabel").grid(row=2, column=2, sticky="w", padx=(18, 0))
        self.audio_format = ttk.Combobox(card, textvariable=self.audio_format_var, values=["MP3", "M4A"], state="readonly", width=10)
        self.audio_format.grid(row=3, column=2, sticky="w", padx=(18, 0), pady=(6, 0))

        ttk.Label(card, text="Audio kbps", style="Card.TLabel").grid(row=2, column=3, sticky="w", padx=(18, 0))
        self.audio_quality = ttk.Combobox(
            card,
            textvariable=self.audio_quality_var,
            values=["128", "192", "256", "320"],
            state="readonly",
            width=8,
        )
        self.audio_quality.grid(row=3, column=3, sticky="w", padx=(18, 0), pady=(6, 0))

        card.columnconfigure(0, weight=1)

        self.download_button = ttk.Button(outer, text="Download", style="Accent.TButton", command=self.download)
        self.download_button.pack(fill="x", pady=(2, 14))

        ttk.Progressbar(outer, variable=self.progress_var, maximum=100).pack(fill="x")
        ttk.Label(outer, textvariable=self.status_var, style="Muted.TLabel").pack(anchor="w", pady=(8, 14))

        actions = ttk.Frame(outer)
        actions.pack(fill="x")
        ttk.Button(actions, text="Open download folder", command=self.open_download_folder).pack(side="left")
        ttk.Button(actions, text="Clear", command=self.clear_form).pack(side="left", padx=(10, 0))

        ttk.Label(
            outer,
            text=f"Save location: {DOWNLOAD_DIR}",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(22, 0))
        ttk.Label(
            outer,
            text="Use only for content you own or have permission to download.",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(4, 0))

        self._sync_mode()

    def _sync_mode(self) -> None:
        is_video = self.mode_var.get() == "Video"
        self.video_quality.configure(state="readonly" if is_video else "disabled")
        self.audio_format.configure(state="disabled" if is_video else "readonly")
        self.audio_quality.configure(state="disabled" if is_video else "readonly")

    def read_video(self) -> None:
        url = self.url_var.get().strip()
        if not YOUTUBE_RE.match(url):
            messagebox.showerror(APP_NAME, "Please paste a valid YouTube or youtu.be URL.")
            return
        self.status_var.set("Reading video information…")
        self.download_button.configure(state="disabled")
        threading.Thread(target=self._read_video_worker, args=(url,), daemon=True).start()

    def _read_video_worker(self, url: str) -> None:
        try:
            opts = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "noplaylist": True,
                "cachedir": False,
                "socket_timeout": 30,
                "retries": 2,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False) or {}
            title = str(info.get("title") or "YouTube video")
            self.events.put(("info", {"title": title, "info": info}))
        except Exception as exc:
            self.events.put(("error", f"Could not read this YouTube link.\n\n{exc}"))

    def download(self) -> None:
        url = self.url_var.get().strip()
        if not YOUTUBE_RE.match(url):
            messagebox.showerror(APP_NAME, "Please paste a valid YouTube or youtu.be URL.")
            return
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        name = safe_filename(self.name_var.get(), "youtube_download")
        mode = self.mode_var.get()
        self.progress_var.set(0)
        self.status_var.set("Starting download…")
        self.download_button.configure(state="disabled")
        threading.Thread(
            target=self._download_worker,
            args=(url, mode, name),
            daemon=True,
        ).start()

    def _download_worker(self, url: str, mode: str, name: str) -> None:
        def hook(data: dict[str, Any]) -> None:
            status = data.get("status")
            if status == "downloading":
                downloaded = int(data.get("downloaded_bytes") or 0)
                total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
                percent = (downloaded / total * 100.0) if total else 0.0
                self.events.put(("progress", percent))
            elif status == "finished":
                self.events.put(("status", "Download finished. Finalizing file…"))

        outtmpl = str(DOWNLOAD_DIR / f"{name}.%(ext)s")
        ffmpeg_path = get_ffmpeg_exe()
        opts: dict[str, Any] = {
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "cachedir": False,
            "socket_timeout": 30,
            "retries": 3,
            "fragment_retries": 3,
            "concurrent_fragment_downloads": 4,
            "progress_hooks": [hook],
            "overwrites": True,
            "ffmpeg_location": ffmpeg_path,
        }

        if mode == "Audio":
            codec = self.audio_format_var.get().lower()
            bitrate = self.audio_quality_var.get()
            opts["format"] = "bestaudio[ext=m4a]/bestaudio/best"
            opts["postprocessors"] = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": codec,
                    "preferredquality": bitrate,
                }
            ]
        else:
            quality = self.video_quality_var.get()
            if quality == "Best available":
                opts["format"] = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
            else:
                height = int(quality.rstrip("p"))
                opts["format"] = (
                    f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
                    f"b[height<={height}][ext=mp4]/"
                    f"bv*[height<={height}]+ba/b[height<={height}]"
                )
            opts["merge_output_format"] = "mp4"

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True) or {}
                requested = info.get("requested_downloads") or []
                final_path: Path | None = None
                if requested:
                    path_value = requested[0].get("filepath")
                    if path_value:
                        final_path = Path(path_value)
                if final_path is None or not final_path.exists():
                    candidates = sorted(DOWNLOAD_DIR.glob(f"{name}.*"), key=lambda p: p.stat().st_mtime, reverse=True)
                    final_path = candidates[0] if candidates else DOWNLOAD_DIR
            self.events.put(("done", str(final_path)))
        except Exception as exc:
            message = str(exc)
            if "Sign in to confirm" in message or "not a bot" in message:
                message = (
                    "YouTube asked this PC to sign in/confirm playback for this video. "
                    "Try another public video or try again later.\n\n" + message
                )
            self.events.put(("error", message))

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "info":
                    self.current_info = payload["info"]
                    self.name_var.set(safe_filename(payload["title"]))
                    self.status_var.set("Video information loaded.")
                    self.download_button.configure(state="normal")
                elif kind == "progress":
                    self.progress_var.set(max(0.0, min(100.0, float(payload))))
                    self.status_var.set(f"Downloading… {float(payload):.1f}%")
                elif kind == "status":
                    self.status_var.set(str(payload))
                elif kind == "done":
                    self.progress_var.set(100)
                    self.status_var.set(f"Saved: {payload}")
                    self.download_button.configure(state="normal")
                    messagebox.showinfo(APP_NAME, f"Download complete.\n\n{payload}")
                elif kind == "error":
                    self.status_var.set("Download failed.")
                    self.download_button.configure(state="normal")
                    messagebox.showerror(APP_NAME, str(payload))
        except queue.Empty:
            pass
        self.after(120, self._drain_events)

    def open_download_folder(self) -> None:
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(DOWNLOAD_DIR))  # type: ignore[attr-defined]
        except AttributeError:
            subprocess.Popen(["xdg-open", str(DOWNLOAD_DIR)])

    def clear_form(self) -> None:
        self.url_var.set("")
        self.name_var.set("")
        self.progress_var.set(0)
        self.status_var.set("Ready")
        self.current_info = None
        self.url_entry.focus_set()


if __name__ == "__main__":
    app = DownloaderApp()
    app.mainloop()
