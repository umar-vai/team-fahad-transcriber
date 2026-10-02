from pathlib import Path

APP = Path('app.py')
REQ = Path('requirements.txt')
PKG = Path('packages.txt')

s = APP.read_text(encoding='utf-8')

anchor = "def download_frameio_public_share_media(url: str, folder: Path) -> LocalMediaSource:\n"
if anchor not in s:
    raise SystemExit('public Frame.io resolver anchor not found')

helper = r'''def _frameio_browser_media_candidates(url: str) -> list[str]:
    """Render a public Frame.io review page and collect browser-requested media URLs.

    This is a best-effort fallback for third-party public review links whose media
    source is injected by client-side JavaScript and therefore is absent from the
    initial HTML response.
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return []

    chromium_path = (
        shutil.which("chromium")
        or shutil.which("chromium-browser")
        or shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
    )
    if not chromium_path:
        return []

    found: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        value = str(candidate or "").strip()
        if not value or value.startswith(("blob:", "data:")):
            return
        if not value.startswith(("http://", "https://")):
            return
        if value in seen:
            return
        seen.add(value)
        found.append(value)

    media_suffixes = (
        ".m3u8", ".mpd", ".mp4", ".mov", ".m4a", ".mp3", ".wav",
        ".aac", ".webm", ".mkv", ".ts", ".m4s",
    )
    media_content_types = (
        "video/", "audio/", "application/vnd.apple.mpegurl",
        "application/x-mpegurl", "application/dash+xml",
    )

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                executable_path=chromium_path,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--autoplay-policy=no-user-gesture-required",
                    "--disable-background-networking",
                ],
            )
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
                ),
                viewport={"width": 1365, "height": 900},
                ignore_https_errors=True,
            )
            page = context.new_page()

            def on_request(request) -> None:
                request_url = request.url
                path = urllib.parse.urlparse(request_url).path.lower()
                if any(path.endswith(ext) for ext in media_suffixes):
                    add(request_url)

            def on_response(response) -> None:
                try:
                    content_type = str(response.headers.get("content-type") or "").lower()
                except Exception:
                    content_type = ""
                response_url = response.url
                path = urllib.parse.urlparse(response_url).path.lower()
                if any(content_type.startswith(prefix) for prefix in media_content_types):
                    add(response_url)
                elif any(path.endswith(ext) for ext in media_suffixes):
                    add(response_url)

            page.on("request", on_request)
            page.on("response", on_response)
            page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            page.wait_for_timeout(5_000)

            try:
                page.locator("video").first.evaluate(
                    "el => { el.muted = true; el.currentTime = 0; return el.play().catch(() => null); }"
                )
            except Exception:
                pass

            for selector in (
                "button[aria-label*='Play' i]",
                "button[title*='Play' i]",
                "[role='button'][aria-label*='Play' i]",
                "button:has-text('Play')",
            ):
                try:
                    target = page.locator(selector).first
                    if target.count() and target.is_visible():
                        target.click(timeout=2_500)
                        break
                except Exception:
                    continue

            page.wait_for_timeout(10_000)

            try:
                dom_urls = page.eval_on_selector_all(
                    "video, audio, source",
                    "els => els.flatMap(el => [el.currentSrc || '', el.src || '']).filter(Boolean)",
                )
                for item in dom_urls or []:
                    add(item)
            except Exception:
                pass

            browser.close()
    except Exception:
        return found

    preferred: list[str] = []
    fragments: list[str] = []
    for item in found:
        path = urllib.parse.urlparse(item).path.lower()
        if path.endswith((".ts", ".m4s")):
            fragments.append(item)
        else:
            preferred.append(item)
    return preferred + fragments


'''

if 'def _frameio_browser_media_candidates' not in s:
    s = s.replace(anchor, helper + anchor)

old = '''    # Limit probes so a page full of analytics/static asset URLs cannot stall the app.\n    for candidate in candidates[:40]:\n        if candidate.startswith(url):\n            continue\n        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            return media\n\n    raise RuntimeError('The public Frame.io page was reachable, but no downloadable/playable media source was exposed.')\n'''
new = '''    # Limit probes so a page full of analytics/static asset URLs cannot stall the app.\n    for candidate in candidates[:40]:\n        if candidate.startswith(url):\n            continue\n        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            return media\n\n    # Modern Frame.io shares often inject the stream only after JavaScript hydrates\n    # the player. Render the public page in headless Chromium and collect the same\n    # media requests a normal browser can see.\n    browser_candidates = _frameio_browser_media_candidates(url)\n    for candidate in browser_candidates[:60]:\n        if candidate.startswith(url):\n            continue\n        media = _download_remote_candidate(candidate, url, folder)\n        if media is not None:\n            return media\n\n    if browser_candidates:\n        raise RuntimeError(\n            'The public Frame.io page loaded media requests in Chromium, but none of the exposed renditions could be downloaded or decoded.'\n        )\n    raise RuntimeError(\n        'The public Frame.io page was reachable, but neither the static page nor a headless browser exposed a downloadable/playable media source.'\n    )\n'''
if old not in s:
    raise SystemExit('expected public resolver tail not found')
s = s.replace(old, new)
APP.write_text(s, encoding='utf-8')

req = REQ.read_text(encoding='utf-8') if REQ.exists() else ''
if 'playwright' not in req.lower():
    if req and not req.endswith('\n'):
        req += '\n'
    req += 'playwright>=1.55,<2.0\n'
REQ.write_text(req, encoding='utf-8')

pkg = PKG.read_text(encoding='utf-8') if PKG.exists() else ''
if 'chromium' not in {line.strip().lower() for line in pkg.splitlines()}:
    if pkg and not pkg.endswith('\n'):
        pkg += '\n'
    pkg += 'chromium\n'
PKG.write_text(pkg, encoding='utf-8')
