from pathlib import Path

path = Path('pages/3_YouTube_Downloader.py')
text = path.read_text(encoding='utf-8')

old = '''            # YouTube increasingly protects direct googlevideo URLs with playback
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

new = '''            # YouTube increasingly protects some direct googlevideo URLs with
            # playback attestation / PO-token checks. Retry with the Safari web
            # client, but choose from formats that the extractor actually returns
            # instead of assuming a fixed HLS layout exists for every video.
            if "403" in lower_message or "forbidden" in lower_message:
                status_box.caption("YouTube rejected the direct media URL. Detecting an available compatibility format…")
                retry = dict(common)
                retry["extractor_args"] = {"youtube": {"player_client": ["web_safari"]}}

                probe = dict(retry)
                probe.pop("format", None)
                probe.pop("postprocessors", None)
                probe.pop("progress_hooks", None)
                probe["skip_download"] = True

                try:
                    with yt_dlp.YoutubeDL(probe) as probe_ydl:
                        compat_info = probe_ydl.extract_info(url, download=False) or {}
                except yt_dlp.utils.DownloadError as probe_exc:
                    raise RuntimeError(
                        f"YouTube compatibility format detection failed: {str(probe_exc)[:700]}"
                    ) from probe_exc

                formats = [
                    item for item in (compat_info.get("formats") or [])
                    if item.get("format_id") and item.get("url")
                ]
                if not formats:
                    raise RuntimeError("YouTube returned no downloadable compatibility formats for this video.")

                def is_audio(item: dict[str, Any]) -> bool:
                    return str(item.get("acodec") or "none") != "none"

                def is_video(item: dict[str, Any]) -> bool:
                    return str(item.get("vcodec") or "none") != "none"

                def protocol_bonus(item: dict[str, Any]) -> int:
                    protocol = str(item.get("protocol") or "").lower()
                    return 2 if "m3u8" in protocol or "hls" in protocol else 0

                def numeric(item: dict[str, Any], key: str) -> float:
                    try:
                        return float(item.get(key) or 0)
                    except (TypeError, ValueError):
                        return 0.0

                if mode == "Audio":
                    audio_only = [item for item in formats if is_audio(item) and not is_video(item)]
                    audio_pool = audio_only or [item for item in formats if is_audio(item)]
                    if not audio_pool:
                        raise RuntimeError("YouTube returned no audio format for this video.")
                    chosen = max(
                        audio_pool,
                        key=lambda item: (
                            protocol_bonus(item),
                            1 if str(item.get("ext") or "").lower() == "m4a" else 0,
                            numeric(item, "abr"),
                            numeric(item, "tbr"),
                        ),
                    )
                    retry["format"] = str(chosen["format_id"])
                else:
                    max_height = 100000 if video_quality == "Best available" else int(video_quality.rstrip("p"))
                    muxed = [
                        item for item in formats
                        if is_video(item) and is_audio(item)
                        and (numeric(item, "height") <= max_height or numeric(item, "height") == 0)
                    ]
                    if muxed:
                        chosen = max(
                            muxed,
                            key=lambda item: (
                                protocol_bonus(item),
                                1 if str(item.get("ext") or "").lower() == "mp4" else 0,
                                numeric(item, "height"),
                                numeric(item, "tbr"),
                            ),
                        )
                        retry["format"] = str(chosen["format_id"])
                    else:
                        video_only = [
                            item for item in formats
                            if is_video(item) and not is_audio(item)
                            and (numeric(item, "height") <= max_height or numeric(item, "height") == 0)
                        ]
                        audio_only = [item for item in formats if is_audio(item) and not is_video(item)]
                        if not video_only or not audio_only:
                            # Let yt-dlp choose the broadest available fallback when
                            # this client exposes an unusual format layout.
                            retry["format"] = f"best[height<={max_height}]/best"
                        else:
                            best_video = max(
                                video_only,
                                key=lambda item: (
                                    protocol_bonus(item),
                                    1 if str(item.get("ext") or "").lower() == "mp4" else 0,
                                    numeric(item, "height"),
                                    numeric(item, "tbr"),
                                ),
                            )
                            best_audio = max(
                                audio_only,
                                key=lambda item: (
                                    protocol_bonus(item),
                                    1 if str(item.get("ext") or "").lower() == "m4a" else 0,
                                    numeric(item, "abr"),
                                    numeric(item, "tbr"),
                                ),
                            )
                            retry["format"] = f"{best_video['format_id']}+{best_audio['format_id']}"

                # Discard partial files from the failed direct attempt so the
                # compatibility retry starts from a clean directory.
                for partial in folder.glob("*"):
                    if partial.is_file() and partial.suffix.lower() in {".part", ".ytdl", ".temp", ".tmp"}:
                        try:
                            partial.unlink()
                        except OSError:
                            pass

                status_box.caption("Compatible YouTube format found. Downloading…")
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
            else:
                raise RuntimeError(f"YouTube download failed: {message[:700]}") from exc
'''

if old not in text:
    raise SystemExit('Expected YouTube compatibility block not found; refusing to patch unexpected code.')

path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Dynamic YouTube format patch applied')
