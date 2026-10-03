from pathlib import Path

path = Path('pages/3_YouTube_Downloader.py')
text = path.read_text(encoding='utf-8')

old = '''                status_box.caption("Compatible YouTube format found. Downloading…")
                try:
                    run_download(retry)
                except yt_dlp.utils.DownloadError as retry_exc:
                    retry_message = str(retry_exc).strip()
                    retry_lower = retry_message.lower()
                    if "requested format is not available" in retry_lower:
                        raise RuntimeError(
                            "YouTube changed the available formats while the download was starting. "
                            "Please retry once; the app now detects formats dynamically."
                        ) from retry_exc
                    if "403" in retry_lower or "forbidden" in retry_lower:
                        raise RuntimeError(
                            "YouTube blocked both the normal path and the best compatibility format (HTTP 403). "
                            "This video currently requires stronger playback attestation/PO-token support from the server."
                        ) from retry_exc
                    raise RuntimeError(f"YouTube compatibility download failed: {retry_message[:700]}") from retry_exc
'''

new = '''                status_box.caption("Compatible YouTube format found. Downloading…")
                try:
                    run_download(retry)
                except yt_dlp.utils.DownloadError as retry_exc:
                    retry_message = str(retry_exc).strip()
                    retry_lower = retry_message.lower()

                    bot_challenge = (
                        "sign in to confirm" in retry_lower
                        or "not a bot" in retry_lower
                        or "403" in retry_lower
                        or "forbidden" in retry_lower
                    )
                    if bot_challenge:
                        status_box.caption(
                            "YouTube challenged the cloud server. Retrying through the public embedded player…"
                        )
                        embedded = dict(common)
                        embedded["extractor_args"] = {"youtube": {"player_client": ["web_embedded"]}}

                        if mode == "Audio":
                            embedded["format"] = "bestaudio/best"
                        elif video_quality == "Best available":
                            embedded["format"] = "bv*+ba/b"
                        else:
                            embedded_height = int(video_quality.rstrip("p"))
                            embedded["format"] = (
                                f"bv*[height<={embedded_height}]+ba/"
                                f"b[height<={embedded_height}]/best"
                            )

                        for partial in folder.glob("*"):
                            if partial.is_file() and partial.suffix.lower() in {".part", ".ytdl", ".temp", ".tmp"}:
                                try:
                                    partial.unlink()
                                except OSError:
                                    pass

                        try:
                            run_download(embedded)
                            retry_message = ""
                        except yt_dlp.utils.DownloadError as embedded_exc:
                            embedded_message = str(embedded_exc).strip()
                            embedded_lower = embedded_message.lower()
                            if "requested format is not available" in embedded_lower:
                                raise RuntimeError(
                                    "YouTube's public embedded player is reachable, but this video does not expose a compatible "
                                    "download format at the selected quality. Try a lower quality or audio-only."
                                ) from embedded_exc
                            if "sign in to confirm" in embedded_lower or "not a bot" in embedded_lower:
                                raise RuntimeError(
                                    "YouTube is requiring authenticated playback from this Streamlit Cloud server. "
                                    "The normal, compatibility, and public embedded-player paths were all challenged. "
                                    "This video needs a server-side YouTube authentication/PO-token provider to download reliably."
                                ) from embedded_exc
                            if "403" in embedded_lower or "forbidden" in embedded_lower:
                                raise RuntimeError(
                                    "YouTube blocked the normal, compatibility, and public embedded-player download paths (HTTP 403). "
                                    "This video needs stronger server-side playback attestation/PO-token support."
                                ) from embedded_exc
                            raise RuntimeError(
                                f"YouTube embedded-player fallback failed: {embedded_message[:700]}"
                            ) from embedded_exc

                    if retry_message:
                        if "requested format is not available" in retry_lower:
                            raise RuntimeError(
                                "YouTube changed the available formats while the download was starting. "
                                "Please retry once; the app now detects formats dynamically."
                            ) from retry_exc
                        raise RuntimeError(f"YouTube compatibility download failed: {retry_message[:700]}") from retry_exc
'''

if old not in text:
    raise SystemExit('Expected compatibility download block not found; refusing to patch unexpected code.')

path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('YouTube embedded-player fallback patch applied')
