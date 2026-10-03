from pathlib import Path

path = Path('pages/3_YouTube_Downloader.py')
text = path.read_text(encoding='utf-8')

old = '''                probe = dict(retry)
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
'''

new = '''                probe = dict(retry)
                probe.pop("postprocessors", None)
                probe.pop("progress_hooks", None)
                probe["skip_download"] = True
                # yt-dlp still performs its normal format selection even when
                # download=False. On some YouTube clients that selection fails
                # before the raw format list is returned. Ask for all formats and
                # tolerate an unavailable default so we can choose one ourselves.
                probe["format"] = "all"
                probe["ignore_no_formats_error"] = True
                probe["allow_unplayable_formats"] = True

                try:
                    with yt_dlp.YoutubeDL(probe) as probe_ydl:
                        compat_info = probe_ydl.extract_info(url, download=False) or {}
                except yt_dlp.utils.DownloadError as probe_exc:
                    probe_message = str(probe_exc).strip()
                    # If the Safari client itself cannot expose formats, retry
                    # metadata discovery with yt-dlp's regular public extractor.
                    fallback_probe = dict(probe)
                    fallback_probe.pop("extractor_args", None)
                    try:
                        with yt_dlp.YoutubeDL(fallback_probe) as probe_ydl:
                            compat_info = probe_ydl.extract_info(url, download=False) or {}
                    except yt_dlp.utils.DownloadError as fallback_exc:
                        raise RuntimeError(
                            "YouTube could not expose a usable format list for this public video. "
                            f"Compatibility probe: {probe_message[:320]} | "
                            f"Fallback probe: {str(fallback_exc)[:320]}"
                        ) from fallback_exc
'''

if old not in text:
    raise SystemExit('Expected compatibility probe block not found; refusing to patch unexpected code.')

text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('YouTube compatibility probe fix applied')
