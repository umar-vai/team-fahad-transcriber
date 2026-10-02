from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

# Cache f.io -> canonical Frame.io redirects.
old = 'def resolve_frameio_url(url: str) -> str:\n'
new = '@st.cache_data(ttl=3600, show_spinner=False)\ndef resolve_frameio_url(url: str) -> str:\n'
if new not in s:
    if old not in s:
        raise SystemExit('resolve_frameio_url marker not found')
    s = s.replace(old, new, 1)

# Cache browser-discovered signed media URLs for a short period. This means
# Chromium is only needed once per review URL while the signed rendition stays valid.
old = 'def _frameio_browser_media_candidates(url: str) -> list[str]:\n'
new = '@st.cache_data(ttl=600, show_spinner=False)\ndef _frameio_browser_media_candidates(url: str) -> list[str]:\n'
if new not in s:
    if old not in s:
        raise SystemExit('browser candidate marker not found')
    s = s.replace(old, new, 1)

# Add an in-session direct media cache so repeat transcriptions bypass Chromium entirely.
marker = '@st.cache_data(ttl=600, show_spinner=False)\ndef _frameio_browser_media_candidates(url: str) -> list[str]:\n'
helpers = '''def _frameio_get_cached_media_candidate(url: str) -> str | None:\n    cache = st.session_state.setdefault("_frameio_media_candidate_cache", {})\n    item = cache.get(url) or {}\n    expires_at = float(item.get("expires_at") or 0)\n    candidate = str(item.get("candidate") or "").strip()\n    if candidate and time.time() < expires_at:\n        return candidate\n    cache.pop(url, None)\n    return None\n\n\ndef _frameio_set_cached_media_candidate(url: str, candidate: str) -> None:\n    value = str(candidate or "").strip()\n    if not value:\n        return\n    cache = st.session_state.setdefault("_frameio_media_candidate_cache", {})\n    # Keep this conservative because Frame.io media URLs are signed and expire.\n    cache[url] = {"candidate": value, "expires_at": time.time() + 8 * 60}\n\n\ndef _frameio_drop_cached_media_candidate(url: str) -> None:\n    st.session_state.setdefault("_frameio_media_candidate_cache", {}).pop(url, None)\n\n\n'''
if '_frameio_get_cached_media_candidate' not in s:
    if marker not in s:
        raise SystemExit('decorated browser marker not found')
    s = s.replace(marker, helpers + marker, 1)

# Make Chromium fallback much faster: block nonessential assets and stop as soon
# as a usable stream appears instead of fixed 15-second waits.
old = '''            page = context.new_page()\n\n            def on_request(request) -> None:\n'''
new = '''            page = context.new_page()\n\n            def route_handler(route) -> None:\n                try:\n                    if route.request.resource_type in {"image", "font", "stylesheet"}:\n                        route.abort()\n                    else:\n                        route.continue_()\n                except Exception:\n                    try:\n                        route.continue_()\n                    except Exception:\n                        pass\n\n            page.route("**/*", route_handler)\n\n            def on_request(request) -> None:\n'''
if old in s:
    s = s.replace(old, new, 1)

s = s.replace(
    '            page.goto(url, wait_until="domcontentloaded", timeout=45_000)\n            page.wait_for_timeout(5_000)\n',
    '            page.goto(url, wait_until="domcontentloaded", timeout=25_000)\n            page.wait_for_timeout(900)\n',
    1,
)

old_wait = '            page.wait_for_timeout(10_000)\n\n            try:\n                dom_urls = page.eval_on_selector_all(\n'
new_wait = '''            deadline = time.monotonic() + 5.0\n            while time.monotonic() < deadline:\n                useful = False\n                for item in found:\n                    path = urllib.parse.urlparse(item).path.lower()\n                    if path.endswith((".m3u8", ".mpd", ".mp4", ".mov", ".m4a", ".mp3", ".wav", ".aac", ".webm", ".mkv")):\n                        useful = True\n                        break\n                if useful:\n                    break\n                page.wait_for_timeout(250)\n\n            try:\n                dom_urls = page.eval_on_selector_all(\n'''
if old_wait in s:
    s = s.replace(old_wait, new_wait, 1)

# Try cached direct rendition before loading the public page at all.
old = '''def download_frameio_public_share_media(url: str, folder: Path) -> LocalMediaSource:\n    """Best-effort fallback for third-party public review links that OAuth cannot access."""\n    headers = {\n'''
new = '''def download_frameio_public_share_media(url: str, folder: Path) -> LocalMediaSource:\n    """Resolve a public Frame.io review link, preferring cached/direct media before Chromium."""\n    cached_candidate = _frameio_get_cached_media_candidate(url)\n    if cached_candidate:\n        media = _download_remote_candidate(cached_candidate, url, folder)\n        if media is not None:\n            return media\n        _frameio_drop_cached_media_candidate(url)\n\n    headers = {\n'''
if old not in s:
    raise SystemExit('public share function marker not found')
s = s.replace(old, new, 1)

# Cache any working static candidate.
old = '''        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            return media\n\n    # Modern Frame.io shares often inject the stream only after JavaScript hydrates\n'''
new = '''        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            _frameio_set_cached_media_candidate(url, candidate)\n            return media\n\n    # Modern Frame.io shares often inject the stream only after JavaScript hydrates\n'''
if old not in s:
    raise SystemExit('static candidate return marker not found')
s = s.replace(old, new, 1)

# Cache the browser-discovered direct media URL, so subsequent retries/reruns skip Chromium.
old = '''        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            return media\n\n    if browser_candidates:\n'''
new = '''        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            _frameio_set_cached_media_candidate(url, candidate)\n            return media\n\n    if browser_candidates:\n'''
if old not in s:
    raise SystemExit('browser candidate return marker not found')
s = s.replace(old, new, 1)

APP.write_text(s, encoding='utf-8')
print('Frame.io fast mode patch applied')
