from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

anchor = 'def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n'
if 'def download_frameio_public_share_media(' not in s:
    helper = r'''def _frameio_decode_embedded_url(value: str) -> str:
    text = str(value or "").strip().strip('"\'')
    text = text.replace('\\/', '/')
    replacements = {
        '\\u0026': '&', '\\u003d': '=', '\\u003D': '=', '\\u002F': '/',
        '\\u002f': '/', '\\u003A': ':', '\\u003a': ':', '&amp;': '&',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def _frameio_public_media_candidates(page_text: str) -> list[str]:
    """Extract browser-visible media/CDN URLs from a public Frame.io review page."""
    normalized = str(page_text or '')
    normalized = normalized.replace('\\/', '/')
    for old, new in {
        '\\u0026': '&', '\\u003d': '=', '\\u003D': '=', '\\u002F': '/',
        '\\u002f': '/', '\\u003A': ':', '\\u003a': ':', '&amp;': '&',
    }.items():
        normalized = normalized.replace(old, new)

    found = re.findall(r'https?://[^"\'<>\\\s]+', normalized)
    unique: list[str] = []
    seen: set[str] = set()
    for item in found:
        candidate = _frameio_decode_embedded_url(item).rstrip('),]}')
        if candidate in seen:
            continue
        seen.add(candidate)
        unique.append(candidate)

    def score(candidate: str) -> tuple[int, int]:
        lower = candidate.lower()
        points = 0
        for token, weight in (
            ('.mp4', 12), ('.mov', 10), ('.m4a', 10), ('.mp3', 10),
            ('.wav', 8), ('.aac', 8), ('.webm', 8), ('.m3u8', 9),
            ('download', 5), ('media', 4), ('playback', 4), ('cloudfront', 3),
            ('amazonaws', 3), ('frame.io', 2), ('frameio', 2), ('akamai', 2),
        ):
            if token in lower:
                points += weight
        return points, -len(candidate)

    return sorted(unique, key=score, reverse=True)


def _download_remote_candidate(candidate: str, referer: str, folder: Path) -> LocalMediaSource | None:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
        'Accept': '*/*',
        'Referer': referer,
    }
    max_bytes = MAX_LINK_SOURCE_MB * 1024 * 1024
    parsed = urllib.parse.urlparse(candidate)
    suffix = Path(parsed.path).suffix.lower()

    # HLS/DASH URLs should be handed directly to ffmpeg so segment downloads keep working.
    if suffix in {'.m3u8', '.mpd'}:
        output = folder / 'frameio_public_media.mp3'
        command = [
            ffmpeg_executable(), '-hide_banner', '-loglevel', 'error', '-y',
            '-headers', f'Referer: {referer}\\r\\nUser-Agent: {headers["User-Agent"]}\\r\\n',
            '-i', candidate, '-vn', '-ac', '1', '-ar', '16000',
            '-codec:a', 'libmp3lame', '-b:a', '96k', str(output),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=3600)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return None
        if output.exists() and output.stat().st_size > 0:
            return LocalMediaSource(path=output, name='frameio_public_media.mp3', size=output.stat().st_size)
        return None

    try:
        with requests.get(candidate, headers=headers, stream=True, allow_redirects=True, timeout=(20, 120)) as response:
            if response.status_code >= 400:
                return None
            content_type = str(response.headers.get('Content-Type') or '').split(';', 1)[0].lower()
            if not (content_type.startswith('video/') or content_type.startswith('audio/') or suffix in {'.mp4', '.mov', '.m4a', '.mp3', '.wav', '.aac', '.webm'}):
                return None
            content_length = int(response.headers.get('Content-Length') or 0)
            if content_length and content_length > max_bytes:
                raise ValueError(f'Frame.io source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit.')
            source = folder / ('frameio_public_source' + (suffix if suffix else '.bin'))
            downloaded = 0
            with source.open('wb') as handle:
                for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise ValueError(f'Frame.io source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit.')
                    handle.write(chunk)
    except requests.RequestException:
        return None

    if not source.exists() or source.stat().st_size == 0:
        return None
    output = folder / 'frameio_public_media.mp3'
    try:
        normalize_link_media_to_mp3(source, output)
    except Exception:
        return None
    if not output.exists() or output.stat().st_size == 0:
        return None
    return LocalMediaSource(path=output, name='frameio_public_media.mp3', size=output.stat().st_size)


def download_frameio_public_share_media(url: str, folder: Path) -> LocalMediaSource:
    """Best-effort fallback for third-party public review links that OAuth cannot access."""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    try:
        response = requests.get(url, headers=headers, allow_redirects=True, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError('Could not open the public Frame.io review page.') from exc

    candidates = _frameio_public_media_candidates(response.text)
    if not candidates:
        raise RuntimeError('The public Frame.io page did not expose a browser-visible media URL.')

    # Limit probes so a page full of analytics/static asset URLs cannot stall the app.
    for candidate in candidates[:40]:
        if candidate.startswith(url):
            continue
        media = _download_remote_candidate(candidate, url, folder)
        if media is not None:
            return media

    raise RuntimeError('The public Frame.io page was reachable, but no downloadable/playable media source was exposed.')


'''
    if anchor not in s:
        raise RuntimeError('Frame.io resolver anchor missing')
    s = s.replace(anchor, helper + anchor, 1)

old = '''def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Resolve a Frame.io V4 share/view URL using share-aware lookup first.\"\"\"\n    ids = frameio_share_ids(url)\n    if not ids:\n        raise ValueError(\"This does not look like a supported Frame.io share/view link.\")\n    share_id, view_id = ids\n\n    token = get_frameio_access_token()\n    if not token:\n        raise RuntimeError(\n            \"Frame.io is not connected. Use the Connect Frame.io button in the app, authorize Adobe, \"\n            \"then retry this link.\"\n        )\n'''
new = '''def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Resolve Frame.io links: public review fallback first, authenticated V4 API second.\"\"\"\n    ids = frameio_share_ids(url)\n    if not ids:\n        raise ValueError(\"This does not look like a supported Frame.io share/view link.\")\n    share_id, view_id = ids\n\n    public_error = \"\"\n    try:\n        return download_frameio_public_share_media(url, folder)\n    except Exception as exc:\n        public_error = str(exc)[:320]\n\n    token = get_frameio_access_token()\n    if not token:\n        raise RuntimeError(\n            \"This third-party/public Frame.io review link could not be resolved from its public page, \"\n            \"and no authorized Frame.io session is available as a fallback. \"\n            f\"Public resolver: {public_error}\"\n        )\n'''
if old not in s:
    raise RuntimeError('Expected Frame.io resolver header not found')
s = s.replace(old, new, 1)

# Replace the terminal permission error with a public-fallback-aware message.
s = s.replace(
'''        raise RuntimeError(\n            \"This Frame.io share is visible in the browser, but the connected Adobe account cannot access \"\n            \"it through the Frame.io API. If this is a public review link from another workspace, the API \"\n            \"still requires the connected account to have access to that share/workspace.\"\n        )\n''',
'''        raise RuntimeError(\n            \"Frame.io public-page resolution and authenticated API resolution both failed for this link. \"\n            \"The client review page is viewable, but it does not expose a downloadable media source to the app, \"\n            \"and the connected Adobe account cannot access the underlying asset. \"\n            f\"Public resolver: {public_error}\"\n        )\n''',
1)

# Public review links should not be blocked behind OAuth in the single-link UI.
s = s.replace(
'''        is_frameio_link = bool(frameio_share_ids(single_media_link))\n        frameio_ready_for_link = (not is_frameio_link) or bool(get_frameio_access_token())\n        if is_frameio_link and not frameio_ready_for_link:\n            if frameio_oauth_config():\n                st.warning(\"This is a Frame.io share link. Connect your Adobe/Frame.io account before transcribing it.\")\n                st.link_button(\n                    \"Connect Frame.io & return to this link\",\n                    frameio_authorization_url(pending_url=single_media_link, return_to_batch=False),\n                    type=\"primary\",\n                    use_container_width=True,\n                )\n            else:\n                st.error(\n                    \"Frame.io OAuth credentials are missing. Add FRAMEIO_CLIENT_ID, \"\n                    \"FRAMEIO_CLIENT_SECRET and FRAMEIO_REDIRECT_URI to Streamlit Secrets.\"\n                )\n''',
'''        is_frameio_link = bool(frameio_share_ids(single_media_link))\n        if is_frameio_link:\n            st.caption(\n                \"Public Frame.io review links are tried without OAuth first. \"\n                \"If the public page does not expose media, a connected Frame.io account is used as fallback when available.\"\n            )\n''',
1)

s = s.replace(
'''            disabled=(not bool(transcription_api_keys)) or (bool(frameio_share_ids(single_media_link)) and not bool(get_frameio_access_token())),\n''',
'''            disabled=not bool(transcription_api_keys),\n''',
1)

APP.write_text(s, encoding='utf-8')
