from pathlib import Path

path = Path("pages/3_YouTube_Downloader.py")
text = path.read_text(encoding="utf-8")

old = '''        try:
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
'''

new = '''        def run_download(options: dict[str, Any]) -> None:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.extract_info(url, download=True)

        try:
            run_download(common)
        except yt_dlp.utils.DownloadError as exc:
            message = str(exc).strip()
            lower_message = message.lower()
            if "file is larger than max-filesize" in lower_message or "max-filesize" in lower_message:
                raise RuntimeError(
                    f"The selected output is larger than the current {MAX_OUTPUT_MB} MB app limit. "
                    "Choose a lower video quality or download audio instead."
                ) from exc

            # YouTube increasingly protects direct googlevideo URLs with playback
            # attestation / PO-token checks. The public web_safari client exposes
            # HLS renditions that currently avoid that direct-file 403 path, so
            # use it as an automatic compatibility retry for ordinary public videos.
            if "403" in lower_message or "forbidden" in lower_message:
                status_box.caption("YouTube rejected the direct media URL. Retrying with compatibility mode…")
                retry = dict(common)
                retry["extractor_args"] = {"youtube": {"player_client": ["web_safari"]}}

                if mode == "Audio":
                    retry["format"] = (
                        "bestaudio[protocol*=m3u8]/"
                        "bestaudio/best"
                    )
                else:
                    if video_quality == "Best available":
                        retry["format"] = (
                            "bv*[protocol*=m3u8]+ba[protocol*=m3u8]/"
                            "b[protocol*=m3u8]/"
                            "bv*+ba/b"
                        )
                    else:
                        height = int(video_quality.rstrip("p"))
                        retry["format"] = (
                            f"bv*[protocol*=m3u8][height<={height}]+ba[protocol*=m3u8]/"
                            f"b[protocol*=m3u8][height<={height}]/"
                            f"bv*[height<={height}]+ba/b[height<={height}]"
                        )

                # Discard any partial files from the first failed attempt so the
                # compatibility retry starts cleanly.
                for partial in folder.glob("*"):
                    if partial.is_file() and partial.suffix.lower() in {".part", ".ytdl", ".temp", ".tmp"}:
                        try:
                            partial.unlink()
                        except OSError:
                            pass

                try:
                    run_download(retry)
                except yt_dlp.utils.DownloadError as retry_exc:
                    retry_message = str(retry_exc).strip()
                    retry_lower = retry_message.lower()
                    if "403" in retry_lower or "forbidden" in retry_lower:
                        raise RuntimeError(
                            "YouTube blocked both the normal download path and the HLS compatibility path (HTTP 403). "
                            "This video currently requires YouTube playback attestation/PO-token support from the server. "
                            "Try another public video or retry later."
                        ) from retry_exc
                    raise RuntimeError(f"YouTube compatibility download failed: {retry_message[:700]}") from retry_exc
            else:
                raise RuntimeError(f"YouTube download failed: {message[:700]}") from exc
'''

if old not in text:
    raise SystemExit("Target download block was not found; refusing to patch an unexpected file.")

text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("YouTube 403 compatibility patch applied")
