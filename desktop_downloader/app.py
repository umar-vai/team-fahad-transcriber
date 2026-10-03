from __future__ import annotations

import io
import os
import queue
import re
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Any

import customtkinter as ctk
import yt_dlp
from PIL import Image
from imageio_ffmpeg import get_ffmpeg_exe
from tkinter import messagebox

APP_NAME = "Team Fahad YouTube Downloader"
APP_VERSION = "2.0"
DOWNLOAD_DIR = Path.home() / "Downloads" / "Team Fahad YouTube"
YOUTUBE_RE = re.compile(r"^https?://(?:(?:www\.|m\.|music\.)?youtube\.com|youtu\.be)/", re.I)

# Midnight-tech palette
BG = "#060B14"
SURFACE = "#0B1323"
SURFACE_2 = "#101C31"
SURFACE_3 = "#14223A"
BORDER = "#223456"
TEXT = "#F7FAFF"
MUTED = "#8798B5"
CYAN = "#23D5FF"
CYAN_HOVER = "#0EBDE9"
PURPLE = "#7657FF"
PURPLE_HOVER = "#6547E9"
SUCCESS = "#24D18C"
WARNING = "#FFB84D"
DANGER = "#FF647C"

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


def safe_filename(value: str, fallback: str = "youtube_download") -> str:
    text = (value or "").strip()
    text = re.sub(r"\.(mp3|m4a|mp4|webm|mkv|mov)$", "", text, flags=re.I)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return (text[:140] or fallback).strip()


def format_duration(seconds: Any) -> str:
    try:
        total = max(0, int(seconds or 0))
    except (TypeError, ValueError):
        return "--:--"
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def human_bytes(value: Any) -> str:
    try:
        size = float(value or 0)
    except (TypeError, ValueError):
        return ""
    if size <= 0:
        return ""
    units = ["B", "KB", "MB", "GB"]
    index = 0
    while size >= 1024 and index < len(units) - 1:
        size /= 1024
        index += 1
    return f"{size:.1f} {units[index]}"


class DownloaderApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_NAME)
        self.geometry("1120x760")
        self.minsize(980, 700)
        self.configure(fg_color=BG)

        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.current_info: dict[str, Any] | None = None
        self.thumbnail_image: ctk.CTkImage | None = None
        self.last_file: Path | None = None
        self.is_busy = False

        self.url_var = ctk.StringVar()
        self.name_var = ctk.StringVar()
        self.mode_var = ctk.StringVar(value="Video")
        self.video_quality_var = ctk.StringVar(value="720p")
        self.audio_format_var = ctk.StringVar(value="MP3")
        self.audio_quality_var = ctk.StringVar(value="192")

        self._center_window()
        self._build_ui()
        self.after(120, self._drain_events)

    def _center_window(self) -> None:
        self.update_idletasks()
        width, height = 1120, 760
        x = max(0, (self.winfo_screenwidth() - width) // 2)
        y = max(0, (self.winfo_screenheight() - height) // 2 - 20)
        self.geometry(f"{width}x{height}+{x}+{y}")

    def _build_ui(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        self._build_topbar()

        self.content = ctk.CTkScrollableFrame(
            self,
            fg_color="transparent",
            scrollbar_button_color=SURFACE_3,
            scrollbar_button_hover_color=PURPLE,
        )
        self.content.grid(row=1, column=0, sticky="nsew", padx=24, pady=(8, 22))
        self.content.grid_columnconfigure(0, weight=1)

        self._build_hero()
        self._build_url_card()
        self._build_media_card()
        self._build_settings_card()
        self._build_download_card()
        self._build_footer()

        self.url_entry.focus_set()
        self._sync_mode("Video")

    def _build_topbar(self) -> None:
        top = ctk.CTkFrame(self, height=62, corner_radius=0, fg_color=SURFACE, border_width=0)
        top.grid(row=0, column=0, sticky="ew")
        top.grid_columnconfigure(1, weight=1)

        brand_dot = ctk.CTkLabel(
            top,
            text="TF",
            width=36,
            height=36,
            corner_radius=10,
            fg_color=PURPLE,
            text_color=TEXT,
            font=("Segoe UI Semibold", 13),
        )
        brand_dot.grid(row=0, column=0, padx=(24, 12), pady=13)

        brand = ctk.CTkFrame(top, fg_color="transparent")
        brand.grid(row=0, column=1, sticky="w")
        ctk.CTkLabel(
            brand,
            text="TEAM FAHAD",
            text_color=TEXT,
            font=("Segoe UI Semibold", 13),
        ).pack(anchor="w")
        ctk.CTkLabel(
            brand,
            text="MEDIA TOOLKIT",
            text_color=MUTED,
            font=("Segoe UI", 9),
        ).pack(anchor="w")

        version = ctk.CTkLabel(
            top,
            text=f"DESKTOP  •  v{APP_VERSION}",
            height=28,
            corner_radius=9,
            fg_color=SURFACE_2,
            text_color=CYAN,
            font=("Segoe UI Semibold", 10),
        )
        version.grid(row=0, column=2, padx=(12, 24))

    def _build_hero(self) -> None:
        hero = ctk.CTkFrame(self.content, fg_color="transparent")
        hero.grid(row=0, column=0, sticky="ew", pady=(18, 16))
        hero.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            hero,
            text="YouTube Downloader",
            text_color=TEXT,
            font=("Segoe UI Semibold", 31),
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            hero,
            text="Fast local downloads. Clean controls. Your connection, your files.",
            text_color=MUTED,
            font=("Segoe UI", 13),
        ).grid(row=1, column=0, sticky="w", pady=(5, 0))

        local_chip = ctk.CTkLabel(
            hero,
            text="LOCAL ENGINE  •  READY",
            height=30,
            corner_radius=10,
            fg_color="#0D2A2A",
            text_color=SUCCESS,
            font=("Segoe UI Semibold", 10),
        )
        local_chip.grid(row=0, column=1, rowspan=2, sticky="e", padx=(20, 0))

    def _card(self, master: Any, **kwargs: Any) -> ctk.CTkFrame:
        return ctk.CTkFrame(
            master,
            fg_color=SURFACE,
            corner_radius=18,
            border_width=1,
            border_color=BORDER,
            **kwargs,
        )

    def _section_title(self, master: Any, kicker: str, title: str, row: int = 0, column: int = 0, columnspan: int = 1) -> None:
        wrap = ctk.CTkFrame(master, fg_color="transparent")
        wrap.grid(row=row, column=column, columnspan=columnspan, sticky="w")
        ctk.CTkLabel(
            wrap,
            text=kicker.upper(),
            text_color=CYAN,
            font=("Segoe UI Semibold", 9),
        ).pack(anchor="w")
        ctk.CTkLabel(
            wrap,
            text=title,
            text_color=TEXT,
            font=("Segoe UI Semibold", 16),
        ).pack(anchor="w", pady=(2, 0))

    def _build_url_card(self) -> None:
        card = self._card(self.content)
        card.grid(row=1, column=0, sticky="ew", pady=(0, 14))
        card.grid_columnconfigure(0, weight=1)

        self._section_title(card, "01 / Source", "Paste a YouTube link")

        input_row = ctk.CTkFrame(card, fg_color="transparent")
        input_row.grid(row=1, column=0, sticky="ew", padx=18, pady=(16, 18))
        input_row.grid_columnconfigure(0, weight=1)

        self.url_entry = ctk.CTkEntry(
            input_row,
            textvariable=self.url_var,
            height=48,
            corner_radius=12,
            fg_color=SURFACE_2,
            border_color="#2A4169",
            border_width=1,
            text_color=TEXT,
            placeholder_text="https://www.youtube.com/watch?v=...",
            placeholder_text_color="#667995",
            font=("Segoe UI", 11),
        )
        self.url_entry.grid(row=0, column=0, sticky="ew")
        self.url_entry.bind("<Return>", lambda _event: self.read_video())

        self.paste_button = ctk.CTkButton(
            input_row,
            text="Paste",
            width=82,
            height=48,
            corner_radius=12,
            fg_color=SURFACE_3,
            hover_color="#1B3153",
            border_width=1,
            border_color="#2A4169",
            command=self.paste_from_clipboard,
        )
        self.paste_button.grid(row=0, column=1, padx=(10, 0))

        self.read_button = ctk.CTkButton(
            input_row,
            text="Analyze video",
            width=132,
            height=48,
            corner_radius=12,
            fg_color=PURPLE,
            hover_color=PURPLE_HOVER,
            text_color="#FFFFFF",
            font=("Segoe UI Semibold", 11),
            command=self.read_video,
        )
        self.read_button.grid(row=0, column=2, padx=(10, 0))

    def _build_media_card(self) -> None:
        self.media_card = self._card(self.content)
        self.media_card.grid(row=2, column=0, sticky="ew", pady=(0, 14))
        self.media_card.grid_columnconfigure(1, weight=1)

        self.thumbnail_frame = ctk.CTkFrame(
            self.media_card,
            width=214,
            height=122,
            corner_radius=14,
            fg_color=SURFACE_2,
            border_width=1,
            border_color="#24395C",
        )
        self.thumbnail_frame.grid(row=0, column=0, rowspan=3, sticky="nw", padx=18, pady=18)
        self.thumbnail_frame.grid_propagate(False)

        self.thumbnail_label = ctk.CTkLabel(
            self.thumbnail_frame,
            text="VIDEO\nPREVIEW",
            text_color="#526683",
            font=("Segoe UI Semibold", 11),
        )
        self.thumbnail_label.place(relx=0.5, rely=0.5, anchor="center")

        self.media_badge = ctk.CTkLabel(
            self.media_card,
            text="WAITING FOR LINK",
            height=26,
            corner_radius=8,
            fg_color=SURFACE_2,
            text_color=MUTED,
            font=("Segoe UI Semibold", 9),
        )
        self.media_badge.grid(row=0, column=1, sticky="nw", pady=(20, 0), padx=(0, 18))

        self.title_label = ctk.CTkLabel(
            self.media_card,
            text="Analyze a video to see its details here",
            text_color=TEXT,
            font=("Segoe UI Semibold", 18),
            anchor="w",
            justify="left",
            wraplength=760,
        )
        self.title_label.grid(row=1, column=1, sticky="ew", padx=(0, 18), pady=(8, 2))

        self.meta_label = ctk.CTkLabel(
            self.media_card,
            text="Title, channel and duration will appear after analysis.",
            text_color=MUTED,
            font=("Segoe UI", 11),
            anchor="w",
        )
        self.meta_label.grid(row=2, column=1, sticky="new", padx=(0, 18), pady=(2, 18))

    def _build_settings_card(self) -> None:
        card = self._card(self.content)
        card.grid(row=3, column=0, sticky="ew", pady=(0, 14))
        card.grid_columnconfigure(0, weight=1)
        card.grid_columnconfigure(1, weight=1)

        self._section_title(card, "02 / Output", "Choose what you want to save", columnspan=2)

        left = ctk.CTkFrame(card, fg_color="transparent")
        left.grid(row=1, column=0, sticky="nsew", padx=(18, 10), pady=(16, 18))
        left.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(left, text="DOWNLOAD TYPE", text_color=MUTED, font=("Segoe UI Semibold", 9)).grid(row=0, column=0, sticky="w")
        self.mode_control = ctk.CTkSegmentedButton(
            left,
            values=["Video", "Audio"],
            variable=self.mode_var,
            command=self._sync_mode,
            height=40,
            corner_radius=11,
            fg_color=SURFACE_2,
            selected_color=PURPLE,
            selected_hover_color=PURPLE_HOVER,
            unselected_color=SURFACE_2,
            unselected_hover_color=SURFACE_3,
            text_color=TEXT,
            font=("Segoe UI Semibold", 11),
        )
        self.mode_control.grid(row=1, column=0, sticky="ew", pady=(7, 15))

        ctk.CTkLabel(left, text="CUSTOM FILE NAME", text_color=MUTED, font=("Segoe UI Semibold", 9)).grid(row=2, column=0, sticky="w")
        self.name_entry = ctk.CTkEntry(
            left,
            textvariable=self.name_var,
            height=42,
            corner_radius=10,
            fg_color=SURFACE_2,
            border_color="#2A4169",
            border_width=1,
            text_color=TEXT,
            placeholder_text="Video title will appear here",
        )
        self.name_entry.grid(row=3, column=0, sticky="ew", pady=(7, 0))

        right = ctk.CTkFrame(card, fg_color=SURFACE_2, corner_radius=14, border_width=1, border_color="#23385A")
        right.grid(row=1, column=1, sticky="nsew", padx=(10, 18), pady=(16, 18))
        right.grid_columnconfigure((0, 1), weight=1)

        self.quality_label = ctk.CTkLabel(right, text="VIDEO QUALITY", text_color=MUTED, font=("Segoe UI Semibold", 9))
        self.quality_label.grid(row=0, column=0, sticky="w", padx=14, pady=(14, 0))
        self.video_quality = ctk.CTkComboBox(
            right,
            variable=self.video_quality_var,
            values=["360p", "480p", "720p", "1080p", "Best available"],
            height=39,
            corner_radius=9,
            fg_color=SURFACE_3,
            border_color="#30496F",
            button_color="#263E65",
            button_hover_color=PURPLE,
            dropdown_fg_color=SURFACE_2,
            dropdown_hover_color=SURFACE_3,
            text_color=TEXT,
        )
        self.video_quality.grid(row=1, column=0, sticky="ew", padx=(14, 7), pady=(7, 14))

        self.audio_format_label = ctk.CTkLabel(right, text="AUDIO FORMAT", text_color=MUTED, font=("Segoe UI Semibold", 9))
        self.audio_format_label.grid(row=0, column=1, sticky="w", padx=7, pady=(14, 0))
        self.audio_format = ctk.CTkComboBox(
            right,
            variable=self.audio_format_var,
            values=["MP3", "M4A"],
            height=39,
            corner_radius=9,
            fg_color=SURFACE_3,
            border_color="#30496F",
            button_color="#263E65",
            button_hover_color=PURPLE,
            dropdown_fg_color=SURFACE_2,
            dropdown_hover_color=SURFACE_3,
            text_color=TEXT,
        )
        self.audio_format.grid(row=1, column=1, sticky="ew", padx=(7, 14), pady=(7, 14))

        self.audio_quality_label = ctk.CTkLabel(right, text="AUDIO BITRATE", text_color=MUTED, font=("Segoe UI Semibold", 9))
        self.audio_quality_label.grid(row=2, column=0, sticky="w", padx=14, pady=(0, 0))
        self.audio_quality = ctk.CTkComboBox(
            right,
            variable=self.audio_quality_var,
            values=["128", "192", "256", "320"],
            height=39,
            corner_radius=9,
            fg_color=SURFACE_3,
            border_color="#30496F",
            button_color="#263E65",
            button_hover_color=PURPLE,
            dropdown_fg_color=SURFACE_2,
            dropdown_hover_color=SURFACE_3,
            text_color=TEXT,
        )
        self.audio_quality.grid(row=3, column=0, sticky="ew", padx=(14, 7), pady=(7, 14))

        self.output_hint = ctk.CTkLabel(
            right,
            text="MP4 video\nFFmpeg merge when needed",
            text_color="#6F83A2",
            font=("Segoe UI", 9),
            justify="left",
        )
        self.output_hint.grid(row=2, column=1, rowspan=2, sticky="sw", padx=(7, 14), pady=(0, 15))

    def _build_download_card(self) -> None:
        card = self._card(self.content)
        card.grid(row=4, column=0, sticky="ew", pady=(0, 14))
        card.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(card, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=18, pady=(16, 10))
        header.grid_columnconfigure(1, weight=1)

        self.status_chip = ctk.CTkLabel(
            header,
            text="READY",
            height=28,
            corner_radius=9,
            fg_color="#0D2A2A",
            text_color=SUCCESS,
            font=("Segoe UI Semibold", 9),
        )
        self.status_chip.grid(row=0, column=0, sticky="w")

        self.status_label = ctk.CTkLabel(
            header,
            text="Ready to download",
            text_color=MUTED,
            font=("Segoe UI", 10),
            anchor="e",
        )
        self.status_label.grid(row=0, column=1, sticky="e")

        self.download_button = ctk.CTkButton(
            card,
            text="Download video",
            height=54,
            corner_radius=13,
            fg_color=CYAN,
            hover_color=CYAN_HOVER,
            text_color="#031018",
            font=("Segoe UI Semibold", 13),
            command=self.download,
        )
        self.download_button.grid(row=1, column=0, sticky="ew", padx=18, pady=(0, 14))

        self.progress = ctk.CTkProgressBar(
            card,
            height=10,
            corner_radius=6,
            fg_color=SURFACE_3,
            progress_color=PURPLE,
        )
        self.progress.grid(row=2, column=0, sticky="ew", padx=18)
        self.progress.set(0)

        progress_row = ctk.CTkFrame(card, fg_color="transparent")
        progress_row.grid(row=3, column=0, sticky="ew", padx=18, pady=(8, 16))
        progress_row.grid_columnconfigure(0, weight=1)

        self.progress_label = ctk.CTkLabel(progress_row, text="0%", text_color=TEXT, font=("Segoe UI Semibold", 10))
        self.progress_label.grid(row=0, column=0, sticky="w")
        self.speed_label = ctk.CTkLabel(progress_row, text="", text_color=MUTED, font=("Segoe UI", 10))
        self.speed_label.grid(row=0, column=1, sticky="e")

        actions = ctk.CTkFrame(card, fg_color="transparent")
        actions.grid(row=4, column=0, sticky="ew", padx=18, pady=(0, 18))
        actions.grid_columnconfigure(0, weight=1)
        actions.grid_columnconfigure(1, weight=1)
        actions.grid_columnconfigure(2, weight=1)

        self.open_file_button = ctk.CTkButton(
            actions,
            text="Open last file",
            height=40,
            corner_radius=10,
            fg_color=SURFACE_2,
            hover_color=SURFACE_3,
            border_width=1,
            border_color=BORDER,
            text_color=TEXT,
            command=self.open_last_file,
            state="disabled",
        )
        self.open_file_button.grid(row=0, column=0, sticky="ew", padx=(0, 6))

        ctk.CTkButton(
            actions,
            text="Open downloads",
            height=40,
            corner_radius=10,
            fg_color=SURFACE_2,
            hover_color=SURFACE_3,
            border_width=1,
            border_color=BORDER,
            text_color=TEXT,
            command=self.open_download_folder,
        ).grid(row=0, column=1, sticky="ew", padx=6)

        ctk.CTkButton(
            actions,
            text="Clear workspace",
            height=40,
            corner_radius=10,
            fg_color="transparent",
            hover_color=SURFACE_2,
            border_width=1,
            border_color=BORDER,
            text_color=MUTED,
            command=self.clear_form,
        ).grid(row=0, column=2, sticky="ew", padx=(6, 0))

    def _build_footer(self) -> None:
        footer = ctk.CTkFrame(self.content, fg_color="transparent")
        footer.grid(row=5, column=0, sticky="ew", pady=(2, 12))
        footer.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            footer,
            text=f"SAVE LOCATION  •  {DOWNLOAD_DIR}",
            text_color="#637696",
            font=("Segoe UI", 9),
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            footer,
            text="Use only for content you own or have permission to download.",
            text_color="#637696",
            font=("Segoe UI", 9),
        ).grid(row=0, column=1, sticky="e")

    def _sync_mode(self, value: str | None = None) -> None:
        mode = value or self.mode_var.get()
        is_video = mode == "Video"
        self.mode_var.set(mode)
        self.video_quality.configure(state="normal" if is_video else "disabled")
        self.audio_format.configure(state="disabled" if is_video else "normal")
        self.audio_quality.configure(state="disabled" if is_video else "normal")

        quality_color = TEXT if is_video else "#50617C"
        audio_color = "#50617C" if is_video else TEXT
        self.quality_label.configure(text_color=quality_color)
        self.audio_format_label.configure(text_color=audio_color)
        self.audio_quality_label.configure(text_color=audio_color)
        self.download_button.configure(text="Download video" if is_video else "Download audio")
        self.output_hint.configure(
            text="MP4 video\nFFmpeg merge when needed" if is_video else "Audio-only export\nChoose format + bitrate"
        )

    def paste_from_clipboard(self) -> None:
        try:
            text = self.clipboard_get().strip()
        except Exception:
            return
        if text:
            self.url_var.set(text)
            self.url_entry.focus_set()

    def _set_busy(self, busy: bool) -> None:
        self.is_busy = busy
        state = "disabled" if busy else "normal"
        self.read_button.configure(state=state)
        self.paste_button.configure(state=state)
        self.download_button.configure(state=state)

    def _set_status(self, text: str, kind: str = "ready") -> None:
        palette = {
            "ready": ("#0D2A2A", SUCCESS, "READY"),
            "working": ("#162344", CYAN, "WORKING"),
            "success": ("#0E3025", SUCCESS, "COMPLETE"),
            "error": ("#351722", DANGER, "FAILED"),
        }
        bg, fg, chip = palette.get(kind, palette["ready"])
        self.status_chip.configure(text=chip, fg_color=bg, text_color=fg)
        self.status_label.configure(text=text)

    def read_video(self) -> None:
        if self.is_busy:
            return
        url = self.url_var.get().strip()
        if not YOUTUBE_RE.match(url):
            messagebox.showerror(APP_NAME, "Please paste a valid YouTube or youtu.be URL.")
            return
        self._set_busy(True)
        self._set_status("Reading video information…", "working")
        self.media_badge.configure(text="ANALYZING", fg_color="#162344", text_color=CYAN)
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

            thumb_bytes: bytes | None = None
            thumbnail_url = str(info.get("thumbnail") or "")
            if thumbnail_url:
                try:
                    request = urllib.request.Request(thumbnail_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(request, timeout=12) as response:
                        thumb_bytes = response.read(2_500_000)
                except Exception:
                    thumb_bytes = None

            payload = {
                "title": str(info.get("title") or "YouTube video"),
                "channel": str(info.get("channel") or info.get("uploader") or "YouTube"),
                "duration": format_duration(info.get("duration")),
                "views": info.get("view_count"),
                "info": info,
                "thumbnail": thumb_bytes,
            }
            self.events.put(("info", payload))
        except Exception as exc:
            self.events.put(("error", f"Could not read this YouTube link.\n\n{exc}"))

    def download(self) -> None:
        if self.is_busy:
            return
        url = self.url_var.get().strip()
        if not YOUTUBE_RE.match(url):
            messagebox.showerror(APP_NAME, "Please paste a valid YouTube or youtu.be URL.")
            return
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        name = safe_filename(self.name_var.get(), "youtube_download")
        mode = self.mode_var.get()
        self.progress.set(0)
        self.progress_label.configure(text="0%")
        self.speed_label.configure(text="Starting…")
        self._set_status("Connecting to YouTube…", "working")
        self._set_busy(True)
        threading.Thread(target=self._download_worker, args=(url, mode, name), daemon=True).start()

    def _download_worker(self, url: str, mode: str, name: str) -> None:
        def hook(data: dict[str, Any]) -> None:
            status = data.get("status")
            if status == "downloading":
                downloaded = int(data.get("downloaded_bytes") or 0)
                total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
                percent = (downloaded / total * 100.0) if total else 0.0
                speed = human_bytes(data.get("speed"))
                eta = data.get("eta")
                extras: list[str] = []
                if speed:
                    extras.append(f"{speed}/s")
                if eta is not None:
                    try:
                        extras.append(f"ETA {int(eta)}s")
                    except (TypeError, ValueError):
                        pass
                self.events.put(("progress", {"percent": percent, "detail": "  •  ".join(extras)}))
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
                        candidate = Path(path_value)
                        if candidate.exists():
                            final_path = candidate

                candidates = [
                    path
                    for path in DOWNLOAD_DIR.glob(f"{name}.*")
                    if path.is_file() and path.suffix.lower() not in {".part", ".ytdl", ".temp", ".tmp"}
                ]
                if candidates:
                    newest = max(candidates, key=lambda p: p.stat().st_mtime)
                    if final_path is None or newest.stat().st_mtime >= final_path.stat().st_mtime:
                        final_path = newest
                if final_path is None:
                    raise RuntimeError("Download finished, but the final file could not be located.")
            self.events.put(("done", str(final_path)))
        except Exception as exc:
            message = str(exc)
            if "Sign in to confirm" in message or "not a bot" in message:
                message = (
                    "YouTube asked this PC to sign in/confirm playback for this video. "
                    "Try another public video or try again later.\n\n" + message
                )
            self.events.put(("error", message))

    def _apply_thumbnail(self, raw: bytes | None) -> None:
        if not raw:
            self.thumbnail_image = None
            self.thumbnail_label.configure(image=None, text="VIDEO\nPREVIEW")
            return
        try:
            image = Image.open(io.BytesIO(raw)).convert("RGB")
            target = (214, 122)
            image.thumbnail(target, Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", target, (16, 28, 49))
            x = (target[0] - image.width) // 2
            y = (target[1] - image.height) // 2
            canvas.paste(image, (x, y))
            self.thumbnail_image = ctk.CTkImage(light_image=canvas, dark_image=canvas, size=target)
            self.thumbnail_label.configure(image=self.thumbnail_image, text="")
        except Exception:
            self.thumbnail_image = None
            self.thumbnail_label.configure(image=None, text="VIDEO\nPREVIEW")

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "info":
                    self.current_info = payload["info"]
                    self.name_var.set(safe_filename(payload["title"]))
                    self.title_label.configure(text=payload["title"])
                    views = payload.get("views")
                    view_text = ""
                    try:
                        if views:
                            view_text = f"  •  {int(views):,} views"
                    except (TypeError, ValueError):
                        pass
                    self.meta_label.configure(text=f"{payload['channel']}  •  {payload['duration']}{view_text}")
                    self.media_badge.configure(text="VIDEO READY", fg_color="#0E3025", text_color=SUCCESS)
                    self._apply_thumbnail(payload.get("thumbnail"))
                    self._set_status("Video information loaded", "ready")
                    self._set_busy(False)
                elif kind == "progress":
                    percent = max(0.0, min(100.0, float(payload.get("percent") or 0)))
                    self.progress.set(percent / 100.0)
                    self.progress_label.configure(text=f"{percent:.0f}%")
                    self.speed_label.configure(text=str(payload.get("detail") or "Downloading…"))
                    self._set_status(f"Downloading… {percent:.1f}%", "working")
                elif kind == "status":
                    self._set_status(str(payload), "working")
                elif kind == "done":
                    path = Path(str(payload))
                    self.last_file = path
                    self.progress.set(1)
                    self.progress_label.configure(text="100%")
                    self.speed_label.configure(text=path.name)
                    self._set_status("Download completed successfully", "success")
                    self.open_file_button.configure(state="normal")
                    self._set_busy(False)
                elif kind == "error":
                    self._set_status("Download failed", "error")
                    self.speed_label.configure(text="")
                    self._set_busy(False)
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

    def open_last_file(self) -> None:
        if not self.last_file or not self.last_file.exists():
            messagebox.showinfo(APP_NAME, "No completed download is available yet.")
            return
        try:
            os.startfile(str(self.last_file))  # type: ignore[attr-defined]
        except AttributeError:
            subprocess.Popen(["xdg-open", str(self.last_file)])

    def clear_form(self) -> None:
        if self.is_busy:
            return
        self.url_var.set("")
        self.name_var.set("")
        self.current_info = None
        self.progress.set(0)
        self.progress_label.configure(text="0%")
        self.speed_label.configure(text="")
        self.title_label.configure(text="Analyze a video to see its details here")
        self.meta_label.configure(text="Title, channel and duration will appear after analysis.")
        self.media_badge.configure(text="WAITING FOR LINK", fg_color=SURFACE_2, text_color=MUTED)
        self._apply_thumbnail(None)
        self._set_status("Ready to download", "ready")
        self.url_entry.focus_set()


if __name__ == "__main__":
    app = DownloaderApp()
    app.mainloop()
