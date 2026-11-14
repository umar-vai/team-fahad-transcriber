"""Link download tools for the media container.

Downloads media from YouTube, Google Drive, Facebook, Frame.io and other
yt-dlp sites into a local folder, then converts it to MP3.
"""

from __future__ import annotations

import base64
import ipaddress
import logging
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import gdown
import requests
import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe

# Per-process cache (Frame.io tokens and resolved media URLs). Each container handles one job.
SESSION: dict[str, Any] = {}


LOGGER = logging.getLogger(__name__)


MAX_LINK_SOURCE_MB = 10_240


@dataclass
class LocalMediaSource:
    path: Path
    name: str
    size: int


def secret_or_env(name: str) -> Any | None:
    """Read a secret from the container's environment variables."""
    value = os.getenv(name)
    return value if value else None


def safe_name(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[^\w\-]+", "_", stem, flags=re.UNICODE).strip("_")
    return stem[:80] or "transcript"


def validate_public_media_url(url: str) -> str:
    """Validate an HTTP(S) URL and reject obvious private/loopback targets."""
    cleaned = str(url or "").strip()
    if len(cleaned) > 2048:
        raise ValueError("That link is too long. Please provide a shorter media URL.")

    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Please enter a complete HTTP or HTTPS media link.")

    hostname = parsed.hostname.strip().lower().rstrip(".")
    if hostname in {"localhost", "localhost.localdomain", "0.0.0.0", "::1"} or hostname.endswith(".local"):
        raise ValueError("Private/local network links are not supported.")

    try:
        addresses = {
            info[4][0]
            for info in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise ValueError("The link's host could not be resolved.") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address)
        if any((ip.is_private, ip.is_loopback, ip.is_link_local, ip.is_multicast, ip.is_unspecified, ip.is_reserved)):
            raise ValueError("For security, links to private or local network addresses are not supported.")

    return cleaned


def ffmpeg_executable() -> str:
    """Use system FFmpeg when available, otherwise imageio-ffmpeg's bundled binary."""
    return shutil.which("ffmpeg") or get_ffmpeg_exe()


def normalize_link_media_to_mp3(source: Path, destination: Path) -> Path:
    """Normalize any linked audio/video file into a Gemini-friendly MP3."""
    command = [
        ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "64k",
        str(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=1800)
    except FileNotFoundError as exc:
        raise RuntimeError("FFmpeg is not available on the server.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Media conversion timed out. Please use a smaller or shorter recording.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        raise RuntimeError(f"The linked media could not be converted into audio. {detail[:400]}") from exc

    if not destination.exists() or destination.stat().st_size == 0:
        raise RuntimeError("No usable audio was produced from that link.")
    return destination


def google_drive_folder_id(url: str) -> str | None:
    """Extract a Google Drive folder ID from common folder URLs."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if host not in {"drive.google.com", "www.drive.google.com"}:
        return None

    match = re.search(r"/drive/folders/([a-zA-Z0-9_-]+)", parsed.path)
    if match:
        return match.group(1)
    return None


def google_drive_file_id(url: str) -> str | None:
    """Extract a Google Drive file ID from common share/view/download URLs."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if host not in {"drive.google.com", "www.drive.google.com", "docs.google.com"}:
        return None

    match = re.search(r"/file/d/([a-zA-Z0-9_-]+)", parsed.path)
    if match:
        return match.group(1)

    query_id = urllib.parse.parse_qs(parsed.query).get("id", [None])[0]
    if query_id and re.fullmatch(r"[a-zA-Z0-9_-]+", query_id):
        return query_id

    return None


def download_google_drive_media(url: str, folder: Path) -> LocalMediaSource:
    """Download a shared Google Drive file without routing it through yt-dlp."""
    file_id = google_drive_file_id(url)
    if not file_id:
        raise ValueError(
            "This looks like a Google Drive link, but no file ID could be detected. "
            "Please use the Drive file's Share link."
        )

    download_dir = folder / "google_drive_download"
    download_dir.mkdir(parents=True, exist_ok=True)
    output = download_dir / "google_drive_source"

    # gdown does not accept a `retries` keyword. Retry at the application
    # level instead, while allowing resumable downloads for large Drive files.
    result = None
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            result = gdown.download(
                id=file_id,
                output=str(output),
                quiet=True,
                fuzzy=True,
                resume=True,
            )
            if result:
                break
        except UnicodeEncodeError as exc:
            # Some hosted environments use an ASCII locale. Keep all downloader
            # filenames/logging ASCII-only so Bangla/Unicode Drive titles cannot
            # crash the request before the file is downloaded.
            raise RuntimeError(
                "Google Drive download hit a server text-encoding issue. "
                "The app uses an ASCII-safe temporary filename; please retry once "
                "after the latest deployment finishes."
            ) from exc
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(1.5 * attempt)

    if result is None and last_error is not None:
        raise RuntimeError(
            f"Could not download the Google Drive file. "
            f"Make sure the file is shared as 'Anyone with the link' → 'Viewer'. "
            f"If it is already public, Google may be throttling/quota-limiting the file. "
            f"{str(last_error)[:450]}"
        ) from last_error

    downloaded = Path(result) if result else output
    if not downloaded.exists() or downloaded.stat().st_size == 0:
        raise RuntimeError(
            "Google Drive did not return a downloadable file. "
            "Check that the file is shared publicly and that the link points to a file, not a folder."
        )

    max_bytes = MAX_LINK_SOURCE_MB * 1024 * 1024
    if downloaded.stat().st_size > max_bytes:
        raise ValueError(
            f"Linked source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit. "
            "Please use a smaller file."
        )

    normalized = folder / "google_drive_media.mp3"
    normalize_link_media_to_mp3(downloaded, normalized)

    return LocalMediaSource(
        path=normalized,
        name="google_drive_media.mp3",
        size=normalized.stat().st_size,
    )


def frameio_oauth_config() -> tuple[str, str, str] | None:
    client_id = str(secret_or_env("FRAMEIO_CLIENT_ID") or "").strip()
    client_secret = str(secret_or_env("FRAMEIO_CLIENT_SECRET") or "").strip()
    redirect_uri = str(secret_or_env("FRAMEIO_REDIRECT_URI") or "").strip()
    if not all((client_id, client_secret, redirect_uri)):
        return None
    return client_id, client_secret, redirect_uri


def refresh_frameio_access_token(refresh_token: str) -> dict[str, Any]:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError("Frame.io OAuth credentials are not configured.")
    client_id, client_secret, _ = config
    response = requests.post(
        "https://ims-na1.adobelogin.com/ims/token/v3",
        auth=(client_id, client_secret),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        timeout=30,
    )
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = response.text[:500]
        raise RuntimeError(f"Frame.io session refresh failed. {detail}") from exc
    data = response.json()
    access_token = str(data.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("Adobe returned no refreshed Frame.io access token.")
    expires_in = int(data.get("expires_in") or 3600)
    return {
        "access_token": access_token,
        "refresh_token": str(data.get("refresh_token") or refresh_token).strip(),
        "expires_at": time.time() + max(60, expires_in - 60),
    }


def get_frameio_access_token() -> str | None:
    # OAuth Web App is the source of truth; do not silently use an old manual token.
    bundle = SESSION.get("frameio_oauth_tokens") or {}
    token = str(bundle.get("access_token") or "").strip()
    expires_at = float(bundle.get("expires_at") or 0)
    if token and time.time() < expires_at:
        return token

    refresh_token = str(bundle.get("refresh_token") or "").strip()
    if refresh_token:
        refreshed = refresh_frameio_access_token(refresh_token)
        SESSION["frameio_oauth_tokens"] = refreshed
        return str(refreshed["access_token"])
    return None


def resolve_frameio_url(url: str) -> str:
    """Resolve f.io short links to their canonical next.frame.io review URL."""
    value = str(url or "").strip()
    parsed = urllib.parse.urlparse(value)
    host = (parsed.hostname or "").lower()
    if host not in {"f.io", "www.f.io"}:
        return value

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    try:
        response = requests.get(
            value,
            headers=headers,
            allow_redirects=True,
            stream=True,
            timeout=20,
        )
        final_url = str(response.url or value).strip()
        response.close()
        return final_url
    except requests.RequestException:
        return value


def frameio_share_ids(url: str) -> tuple[str, str] | None:
    """Return (share_id, file_id) for Frame.io V4 share/view links, including f.io short links."""
    resolved = resolve_frameio_url(url)
    parsed = urllib.parse.urlparse(resolved)
    host = (parsed.hostname or "").lower()
    if host not in {"next.frame.io", "www.next.frame.io"}:
        return None
    match = re.search(
        r"/share/([0-9a-fA-F-]{36})/view/([0-9a-fA-F-]{36})",
        parsed.path,
    )
    if not match:
        return None
    return match.group(1), match.group(2)


def _frameio_decode_embedded_url(value: str) -> str:
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


def _frameio_get_cached_media_candidate(url: str) -> str | None:
    cache = SESSION.setdefault("_frameio_media_candidate_cache", {})
    item = cache.get(url) or {}
    expires_at = float(item.get("expires_at") or 0)
    candidate = str(item.get("candidate") or "").strip()
    if candidate and time.time() < expires_at:
        return candidate
    cache.pop(url, None)
    return None


def _frameio_set_cached_media_candidate(url: str, candidate: str) -> None:
    value = str(candidate or "").strip()
    if not value:
        return
    cache = SESSION.setdefault("_frameio_media_candidate_cache", {})
    # Keep this conservative because Frame.io media URLs are signed and expire.
    cache[url] = {"candidate": value, "expires_at": time.time() + 8 * 60}


def _frameio_drop_cached_media_candidate(url: str) -> None:
    SESSION.setdefault("_frameio_media_candidate_cache", {}).pop(url, None)


def _frameio_browser_media_candidates(url: str) -> list[str]:
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

            def route_handler(route) -> None:
                try:
                    if route.request.resource_type in {"image", "font", "stylesheet"}:
                        route.abort()
                    else:
                        route.continue_()
                except Exception:
                    try:
                        route.continue_()
                    except Exception:
                        pass

            page.route("**/*", route_handler)

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
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            page.wait_for_timeout(900)

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

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                useful = False
                for item in found:
                    path = urllib.parse.urlparse(item).path.lower()
                    if path.endswith((".m3u8", ".mpd", ".mp4", ".mov", ".m4a", ".mp3", ".wav", ".aac", ".webm", ".mkv")):
                        useful = True
                        break
                if useful:
                    break
                page.wait_for_timeout(250)

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


def download_frameio_public_share_media(url: str, folder: Path) -> LocalMediaSource:
    """Resolve a public Frame.io review link, preferring cached/direct media before Chromium."""
    cached_candidate = _frameio_get_cached_media_candidate(url)
    if cached_candidate:
        media = _download_remote_candidate(cached_candidate, url, folder)
        if media is not None:
            return media
        _frameio_drop_cached_media_candidate(url)

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
            _frameio_set_cached_media_candidate(url, candidate)
            return media

    # Modern Frame.io shares often inject the stream only after JavaScript hydrates
    # the player. Render the public page in headless Chromium and collect the same
    # media requests a normal browser can see.
    browser_candidates = _frameio_browser_media_candidates(url)
    for candidate in browser_candidates[:60]:
        if candidate.startswith(url):
            continue
        media = _download_remote_candidate(candidate, url, folder)
        if media is not None:
            _frameio_set_cached_media_candidate(url, candidate)
            return media

    if browser_candidates:
        raise RuntimeError(
            'The public Frame.io page loaded media requests in Chromium, but none of the exposed renditions could be downloaded or decoded.'
        )
    raise RuntimeError(
        'The public Frame.io page was reachable, but neither the static page nor a headless browser exposed a downloadable/playable media source.'
    )


def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:
    """Resolve Frame.io links: public review fallback first, authenticated V4 API second."""
    url = resolve_frameio_url(url)
    ids = frameio_share_ids(url)
    if not ids:
        raise ValueError("This does not look like a supported Frame.io share/view link.")
    share_id, view_id = ids

    public_error = ""
    try:
        return download_frameio_public_share_media(url, folder)
    except Exception as exc:
        public_error = str(exc)[:320]

    token = get_frameio_access_token()
    if not token:
        raise RuntimeError(
            "This third-party/public Frame.io review link could not be resolved from its public page, "
            "and no authorized Frame.io session is available as a fallback. "
            f"Public resolver: {public_error}"
        )

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "Team-Fahad-Transcriber/1.0",
    }

    try:
        accounts_response = requests.get(
            "https://api.frame.io/v4/accounts",
            headers=headers,
            params={"page_size": 100},
            timeout=30,
        )
        if accounts_response.status_code in {401, 403}:
            SESSION.pop("frameio_oauth_tokens", None)
            raise RuntimeError(
                "Frame.io authorization is not valid for this account. Connect Frame.io again and retry."
            )
        accounts_response.raise_for_status()
        accounts = accounts_response.json().get("data", [])
    except requests.RequestException as exc:
        raise RuntimeError("Could not authenticate with Frame.io.") from exc
    except ValueError as exc:
        raise RuntimeError("Frame.io returned an invalid accounts response.") from exc

    if not accounts:
        raise RuntimeError("The connected Adobe account has no accessible Frame.io accounts.")

    include = "media_links.efficient,media_links.high_quality,media_links.original"
    file_data = None

    # First resolve through the Share API. A /share/{share_id}/view/{view_id}
    # URL is not guaranteed to be fetchable through the direct file endpoint.
    for account in accounts:
        account_id = str(account.get("id") or "").strip()
        if not account_id:
            continue
        try:
            response = requests.get(
                f"https://api.frame.io/v4/accounts/{account_id}/shares/{share_id}/assets",
                headers=headers,
                params={"include": include, "page_size": 100},
                timeout=30,
            )
        except requests.RequestException:
            continue

        if response.status_code != 200:
            continue
        try:
            assets = response.json().get("data", []) or []
        except ValueError:
            continue

        exact = next((item for item in assets if str(item.get("id") or "") == view_id), None)
        if exact:
            file_data = exact
            break

        playable = next(
            (
                item for item in assets
                if str(item.get("type") or "").lower() == "file"
                and str(item.get("media_type") or "").lower().startswith(("audio/", "video/"))
            ),
            None,
        )
        if playable:
            file_data = playable
            break

    # Fallback to direct file lookup for links that do use a real file id.
    if not file_data:
        for account in accounts:
            account_id = str(account.get("id") or "").strip()
            if not account_id:
                continue
            try:
                response = requests.get(
                    f"https://api.frame.io/v4/accounts/{account_id}/files/{view_id}",
                    headers=headers,
                    params={"include": include},
                    timeout=30,
                )
            except requests.RequestException:
                continue
            if response.status_code == 200:
                try:
                    file_data = response.json().get("data") or {}
                except ValueError:
                    file_data = None
                if file_data:
                    break

    if not file_data:
        raise RuntimeError(
            "Frame.io public-page resolution and authenticated API resolution both failed for this link. "
            "The client review page is viewable, but it does not expose a downloadable media source to the app, "
            "and the connected Adobe account cannot access the underlying asset. "
            f"Public resolver: {public_error}"
        )

    media_links = file_data.get("media_links") or {}
    rendition = None
    for key in ("efficient", "high_quality", "original"):
        item = media_links.get(key) or {}
        rendition = item.get("download_url") or item.get("inline_url") or item.get("url")
        if rendition:
            break

    if not rendition:
        raise RuntimeError(
            "Frame.io resolved the shared asset, but did not return a downloadable media rendition. "
            "Downloads may be disabled for this share or the asset may still be processing."
        )

    download_dir = folder / "frameio_download"
    download_dir.mkdir(parents=True, exist_ok=True)
    original_name = str(file_data.get("name") or "frameio_media").strip()
    suffix = Path(original_name).suffix or ".bin"
    source = download_dir / f"frameio_source{suffix}"
    max_bytes = MAX_LINK_SOURCE_MB * 1024 * 1024

    try:
        with requests.get(rendition, stream=True, timeout=(30, 300)) as response:
            response.raise_for_status()
            content_length = int(response.headers.get("Content-Length") or 0)
            if content_length and content_length > max_bytes:
                raise ValueError(
                    f"Frame.io source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
                )
            downloaded = 0
            with source.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise ValueError(
                            f"Frame.io source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
                        )
                    handle.write(chunk)
    except requests.RequestException as exc:
        raise RuntimeError("Could not download the resolved Frame.io media rendition.") from exc

    if not source.exists() or source.stat().st_size == 0:
        raise RuntimeError("Frame.io returned an empty media file.")

    normalized_name = safe_name(Path(original_name).stem)[:100] or "frameio_media"
    normalized = folder / f"{normalized_name}.mp3"
    normalize_link_media_to_mp3(source, normalized)
    return LocalMediaSource(
        path=normalized,
        name=f"{normalized_name}.mp3",
        size=normalized.stat().st_size,
    )


def is_facebook_media_url(url: str) -> bool:
    """Detect Facebook post/reel/video/share URLs handled by the dedicated fallback."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower().lstrip("www.")
    return host in {"facebook.com", "m.facebook.com", "mbasic.facebook.com", "fb.watch"} or host.endswith(".facebook.com")


def _facebook_cookie_text() -> str:
    """Load an optional Netscape-format Facebook cookie export from server-side secrets."""
    raw = str(
        secret_or_env("FACEBOOK_COOKIES")
        or secret_or_env("YTDLP_COOKIES")
        or ""
    ).strip()
    if raw:
        return raw

    encoded = str(
        secret_or_env("FACEBOOK_COOKIES_B64")
        or secret_or_env("YTDLP_COOKIES_B64")
        or ""
    ).strip()
    if not encoded:
        return ""
    try:
        return base64.b64decode(encoded).decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _write_ytdlp_cookie_file(folder: Path) -> Path | None:
    text = _facebook_cookie_text()
    if not text:
        return None
    cookie_file = folder / "browser_cookies.txt"
    if not text.startswith("# Netscape HTTP Cookie File"):
        text = "# Netscape HTTP Cookie File\n" + text
    cookie_file.write_text(text + ("\n" if not text.endswith("\n") else ""), encoding="utf-8")
    return cookie_file


def _netscape_cookies_for_playwright(cookie_text: str) -> list[dict[str, Any]]:
    cookies: list[dict[str, Any]] = []
    for raw_line in str(cookie_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#"):
            continue

        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _include_subdomains, path, secure, expires, name = parts[:6]
        value = "\t".join(parts[6:])
        if not domain or not name:
            continue

        item: dict[str, Any] = {
            "name": name,
            "value": value,
            "domain": domain,
            "path": path or "/",
            "secure": str(secure).upper() == "TRUE",
        }
        try:
            expiry = int(expires)
            if expiry > 0:
                item["expires"] = expiry
        except Exception:
            pass
        cookies.append(item)
    return cookies


def _facebook_static_media_candidates(page_text: str) -> list[str]:
    """Extract CDN/video candidates exposed in Facebook's HTML/JSON payload."""
    normalized = str(page_text or "")
    normalized = normalized.replace("\\/", "/")
    for old, new in {
        "\\u0026": "&", "\\u003d": "=", "\\u003D": "=",
        "\\u002F": "/", "\\u002f": "/", "\\u003A": ":",
        "\\u003a": ":", "&amp;": "&",
    }.items():
        normalized = normalized.replace(old, new)

    candidates: list[str] = []
    seen: set[str] = set()

    # Facebook has used these field names across several page/player payloads.
    field_patterns = (
        r'"(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|hd_src|sd_src)"\s*:\s*"([^"]+)"',
        r'<meta[^>]+property=["\']og:video(?::url|:secure_url)?["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:video(?::url|:secure_url)?["\']',
        r'<source[^>]+src=["\']([^"\']+)["\']',
    )
    for pattern in field_patterns:
        for match in re.findall(pattern, normalized, flags=re.I):
            candidate = _frameio_decode_embedded_url(match).rstrip("),]}")
            if candidate.startswith(("http://", "https://")) and candidate not in seen:
                seen.add(candidate)
                candidates.append(candidate)

    # Also inspect all embedded URLs, preferring Facebook CDN media.
    for item in _frameio_public_media_candidates(normalized):
        lower = item.lower()
        if any(token in lower for token in ("fbcdn.net", ".mp4", ".m3u8", ".mpd", "video")):
            if item not in seen:
                seen.add(item)
                candidates.append(item)

    return candidates


def _facebook_browser_media_candidates(url: str) -> list[str]:
    """Render a public Facebook post and capture media requests made by the player."""
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
        value = _frameio_decode_embedded_url(candidate)
        if not value.startswith(("http://", "https://")) or value.startswith(("blob:", "data:")):
            return
        if value in seen:
            return
        lower = value.lower()
        if not any(token in lower for token in (
            "fbcdn.net", ".mp4", ".m3u8", ".mpd", ".m4a", ".mp3", "video"
        )):
            return
        seen.add(value)
        found.append(value)

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
                ],
            )
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
                ),
                viewport={"width": 1365, "height": 900},
                ignore_https_errors=True,
                locale="en-US",
            )

            cookie_text = _facebook_cookie_text()
            if cookie_text:
                try:
                    cookies = _netscape_cookies_for_playwright(cookie_text)
                    if cookies:
                        context.add_cookies(cookies)
                except Exception:
                    pass

            page = context.new_page()

            def on_request(request) -> None:
                add(request.url)

            def on_response(response) -> None:
                try:
                    content_type = str(response.headers.get("content-type") or "").lower()
                except Exception:
                    content_type = ""
                if any(content_type.startswith(prefix) for prefix in media_content_types):
                    add(response.url)
                else:
                    add(response.url)

            page.on("request", on_request)
            page.on("response", on_response)
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(1_500)

            # Dismiss common public-page prompts where possible.
            for selector in (
                "button:has-text('Allow all cookies')",
                "button:has-text('Allow essential and optional cookies')",
                "button:has-text('Not now')",
                "[aria-label='Close']",
            ):
                try:
                    target = page.locator(selector).first
                    if target.count() and target.is_visible():
                        target.click(timeout=1_500)
                except Exception:
                    pass

            for selector in (
                "video",
                "div[role='button'][aria-label*='Play' i]",
                "button[aria-label*='Play' i]",
            ):
                try:
                    target = page.locator(selector).first
                    if target.count() and target.is_visible():
                        if selector == "video":
                            target.evaluate(
                                "el => { el.muted = true; return el.play().catch(() => null); }"
                            )
                        else:
                            target.click(timeout=2_500)
                        break
                except Exception:
                    continue

            deadline = time.monotonic() + 7.0
            while time.monotonic() < deadline:
                if any(
                    token in candidate.lower()
                    for candidate in found
                    for token in ("fbcdn.net", ".mp4", ".m3u8", ".mpd")
                ):
                    break
                page.wait_for_timeout(300)

            try:
                dom_urls = page.eval_on_selector_all(
                    "video, audio, source",
                    "els => els.flatMap(el => [el.currentSrc || '', el.src || '']).filter(Boolean)",
                )
                for item in dom_urls or []:
                    add(item)
            except Exception:
                pass

            try:
                html_text = page.content()
                for item in _facebook_static_media_candidates(html_text):
                    add(item)
            except Exception:
                pass

            browser.close()
    except Exception:
        return found

    return found


def download_facebook_public_fallback(url: str, folder: Path) -> LocalMediaSource:
    """Best-effort resolver for public Facebook posts when yt-dlp's extractor breaks."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    candidates: list[str] = []
    try:
        session = requests.Session()
        cookie_text = _facebook_cookie_text()
        if cookie_text:
            for item in _netscape_cookies_for_playwright(cookie_text):
                try:
                    session.cookies.set(
                        item["name"],
                        item["value"],
                        domain=item.get("domain"),
                        path=item.get("path", "/"),
                    )
                except Exception:
                    pass
        response = session.get(url, headers=headers, allow_redirects=True, timeout=(20, 45))
        if response.ok:
            candidates.extend(_facebook_static_media_candidates(response.text))
            url = response.url or url
    except requests.RequestException:
        pass

    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in candidates + _facebook_browser_media_candidates(url):
        if candidate in seen:
            continue
        seen.add(candidate)
        ordered.append(candidate)

    for candidate in ordered[:80]:
        media = _download_remote_candidate(candidate, url, folder)
        if media is not None:
            return LocalMediaSource(
                path=media.path,
                name="facebook_media.mp3",
                size=media.size,
            )

    if _facebook_cookie_text():
        raise RuntimeError(
            "Facebook opened the post, but no playable media source could be resolved. "
            "The configured Facebook cookies may be expired, or Facebook may be blocking "
            "media delivery from this server."
        )
    raise RuntimeError(
        "Facebook's current public-page format could not expose the video to the hosted app. "
        "This is a known Facebook/yt-dlp extractor problem. If the post is visible only after "
        "Facebook login, add a Netscape-format cookie export to the media container secrets as "
        "FACEBOOK_COOKIES (or FACEBOOK_COOKIES_B64), then retry."
    )


def is_youtube_media_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower().lstrip("www.")
    return host in {
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
    } or host.endswith(".youtube.com")


def _decode_secret_text(plain_key: str, b64_key: str) -> str:
    raw = str(secret_or_env(plain_key) or "").strip()
    if raw:
        return raw
    encoded = str(secret_or_env(b64_key) or "").strip()
    if not encoded:
        return ""
    try:
        return base64.b64decode(encoded).decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _youtube_cookie_text() -> str:
    return (
        _decode_secret_text("YOUTUBE_COOKIES", "YOUTUBE_COOKIES_B64")
        or _decode_secret_text("YTDLP_COOKIES", "YTDLP_COOKIES_B64")
    )


def _write_cookie_text(folder: Path, filename: str, text: str) -> Path | None:
    value = str(text or "").strip()
    if not value:
        return None
    path = folder / filename
    if not value.startswith("# Netscape HTTP Cookie File"):
        value = "# Netscape HTTP Cookie File\n" + value
    path.write_text(value + ("\n" if not value.endswith("\n") else ""), encoding="utf-8")
    return path


def _supported_ytdlp_js_runtimes() -> dict[str, dict[str, str]]:
    """Return only JS runtimes new enough for current yt-dlp EJS."""
    runtimes: dict[str, dict[str, str]] = {}

    def version_tuple(executable: str) -> tuple[int, int]:
        try:
            result = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            match = re.search(r"(\d+)\.(\d+)", (result.stdout or "") + " " + (result.stderr or ""))
            return (int(match.group(1)), int(match.group(2))) if match else (0, 0)
        except Exception:
            return (0, 0)

    deno = shutil.which("deno")
    if deno and version_tuple(deno) >= (2, 3):
        runtimes["deno"] = {"path": deno}

    node = shutil.which("node")
    if node and version_tuple(node) >= (22, 0):
        runtimes["node"] = {"path": node}

    qjs = shutil.which("qjs")
    if qjs:
        runtimes["quickjs"] = {"path": qjs}

    return runtimes


def _configure_youtube_wpc_provider() -> str:
    """Prepare the browser-based yt-dlp PO-token provider for hosted Linux.

    The upstream WPC provider launches Chromium with a visible window by default.
    Hosted Linux containers normally have no DISPLAY, so we switch only
    that provider to headless Chromium and keep the rest of the app unchanged.
    Returns the Chromium executable path when the provider is available.
    """
    chromium_path = (
        shutil.which("chromium")
        or shutil.which("chromium-browser")
        or shutil.which("google-chrome")
        or shutil.which("google-chrome-stable")
    )
    if not chromium_path:
        return ""

    try:
        import nodriver
        import nodriver.core.config
        import yt_dlp_plugins.extractor.getpot_wpc as wpc
    except Exception as exc:
        LOGGER.info("YouTube WPC PO-token provider unavailable: %s", exc)
        return ""

    # The provider itself currently hard-codes headless=False. On hosted Linux
    # there is usually no X/Wayland display, so patch its runtime config only in
    # that environment. Local desktop use keeps the upstream behavior.
    if not os.getenv("DISPLAY") and not getattr(wpc, "_team_fahad_headless_patch", False):
        def hosted_config(self: Any, proxy: str | None = None) -> Any:
            browser_args = [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
            ]
            if proxy:
                browser_args.append(f"--proxy-server={proxy}")
            return nodriver.core.config.Config(
                headless=True,
                browser_executable_path=chromium_path,
                browser_args=browser_args,
            )

        async def hosted_launch_browser(config: Any) -> Any:
            browser = await wpc.start(config=config)
            await browser.cookies.clear()
            await browser.get("https://www.youtube.com?themeRefresh=1")
            return browser

        wpc.WPCPTP.get_nodriver_config = hosted_config
        wpc.launch_browser = hosted_launch_browser
        wpc._team_fahad_headless_patch = True

    return chromium_path


def _youtube_base_ydl_opts(
    output_template: str,
    max_bytes: int,
    progress_hook: Any,
    cookie_file: Path | None,
) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "outtmpl": output_template,
        "noplaylist": True,
        "max_filesize": max_bytes,
        "socket_timeout": 30,
        "retries": 4,
        "fragment_retries": 5,
        "extractor_retries": 3,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "progress_hooks": [progress_hook],
        "cachedir": False,
        "concurrent_fragment_downloads": 2,
        "remote_components": ["ejs:github"],
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                "Version/18.5 Safari/605.1.15"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
        "logger": type(
            "QuietYoutubeLogger",
            (),
            {
                "debug": staticmethod(lambda msg: None),
                "warning": staticmethod(lambda msg: None),
                "error": staticmethod(lambda msg: None),
            },
        )(),
    }
    runtimes = _supported_ytdlp_js_runtimes()
    if runtimes:
        opts["js_runtimes"] = runtimes

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    if cookie_file is not None:
        opts["cookiefile"] = str(cookie_file)

    provider_url = str(secret_or_env("YOUTUBE_PO_PROVIDER_URL") or "").strip()
    if provider_url:
        opts.setdefault("extractor_args", {})["youtubepot-bgutilhttp"] = {
            "base_url": [provider_url]
        }

    # Secondary provider: mint per-video PO tokens with the Chromium already
    # installed for this app. This avoids requiring cookies for ordinary public
    # videos when YouTube rejects the hosted server's direct playback route.
    wpc_browser = _configure_youtube_wpc_provider()
    if wpc_browser:
        opts.setdefault("extractor_args", {})["youtubepot-wpc"] = {
            "browser_path": [wpc_browser]
        }
    return opts


def download_youtube_media(url: str, folder: Path) -> LocalMediaSource:
    """Download YouTube audio with current PO-token/403-aware fallbacks.

    When a PO-token provider is available, prefer mweb with a fresh token.
    Otherwise retain the normal, Safari HLS, embedded, and Android VR routes.
    """
    download_root = folder / "youtube_download"
    download_root.mkdir(parents=True, exist_ok=True)
    max_bytes = MAX_LINK_SOURCE_MB * 1024 * 1024

    def progress_hook(data: dict[str, Any]) -> None:
        if int(data.get("downloaded_bytes") or 0) > max_bytes:
            raise yt_dlp.utils.DownloadError(
                f"Linked source exceeds the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
            )

    cookie_file = _write_cookie_text(
        folder,
        "youtube_cookies.txt",
        _youtube_cookie_text(),
    )

    # Current yt-dlp guidance recommends mweb + a PO-token provider. Prefer
    # that route when either the optional HTTP provider or our browser provider
    # is available, then retain non-token fallbacks for resilience.
    provider_url = str(secret_or_env("YOUTUBE_PO_PROVIDER_URL") or "").strip()
    wpc_browser = _configure_youtube_wpc_provider()

    strategies: list[tuple[str, str, dict[str, list[str]]]] = []
    if provider_url or wpc_browser:
        strategies.append(
            (
                "mweb_po",
                "bestaudio/best",
                {"youtube": {"player_client": ["mweb"]}},
            )
        )

    strategies.extend(
        [
            (
                "default",
                "bestaudio[ext=m4a]/bestaudio/best",
                {},
            ),
            (
                "safari_hls",
                "bestaudio[protocol^=m3u8]/best[protocol^=m3u8]/bestaudio/best",
                {"youtube": {"player_client": ["web_safari"]}},
            ),
            (
                "embedded",
                "bestaudio/best",
                {"youtube": {"player_client": ["web_embedded"]}},
            ),
            (
                "android_vr",
                "bestaudio/best",
                {"youtube": {"player_client": ["android_vr"]}},
            ),
        ]
    )

    errors_seen: list[str] = []
    successful_info: dict[str, Any] | None = None
    successful_source: Path | None = None

    for strategy_name, format_selector, extractor_args in strategies:
        strategy_dir = download_root / strategy_name
        strategy_dir.mkdir(parents=True, exist_ok=True)
        opts = _youtube_base_ydl_opts(
            str(strategy_dir / "source.%(ext)s"),
            max_bytes,
            progress_hook,
            cookie_file,
        )
        opts["format"] = format_selector

        merged_args = dict(opts.get("extractor_args") or {})
        for key, value in extractor_args.items():
            merged_args[key] = value
        if merged_args:
            opts["extractor_args"] = merged_args

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)

            candidates = [
                p for p in strategy_dir.iterdir()
                if p.is_file() and p.suffix.lower() not in {".part", ".ytdl"}
            ]
            if not candidates:
                errors_seen.append(f"{strategy_name}: no downloaded media file")
                continue

            source = max(candidates, key=lambda p: p.stat().st_size)
            if source.stat().st_size <= 0:
                errors_seen.append(f"{strategy_name}: downloaded file was empty")
                continue
            if source.stat().st_size > max_bytes:
                raise ValueError(
                    f"Linked source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
                )

            successful_info = info or {}
            successful_source = source
            break
        except yt_dlp.utils.DownloadError as exc:
            errors_seen.append(f"{strategy_name}: {str(exc).strip()[:220]}")
        except Exception as exc:
            errors_seen.append(f"{strategy_name}: {str(exc).strip()[:220]}")

    if successful_source is None:
        detail = " | ".join(errors_seen[-6:])
        LOGGER.warning(
            "YouTube media download failed after all playback strategies. "
            "po_http=%s wpc=%s cookies=%s attempts=%s",
            bool(provider_url),
            bool(wpc_browser),
            cookie_file is not None,
            detail or "none",
        )
        raise RuntimeError(
            "YouTube could not be accessed from this hosted server right now. "
            "Please try the link again, or upload the video/audio file directly."
        )

    title = str(
        (successful_info or {}).get("title")
        or successful_source.stem
        or "youtube_media"
    ).strip()
    safe_title = safe_name(title)[:100] or "youtube_media"
    normalized = folder / f"{safe_title}.mp3"
    normalize_link_media_to_mp3(successful_source, normalized)

    return LocalMediaSource(
        path=normalized,
        name=f"{safe_title}.mp3",
        size=normalized.stat().st_size,
    )


def download_media_from_link(url: str, folder: Path) -> LocalMediaSource:
    """Download one public media URL, routing Frame.io short links before yt-dlp."""
    url = validate_public_media_url(url)

    # f.io short links redirect to next.frame.io. Resolve them before source
    # detection so they never fall through to yt-dlp as an unsupported URL.
    parsed_host = (urllib.parse.urlparse(url).hostname or "").lower()
    if parsed_host in {"f.io", "www.f.io"}:
        resolved_frameio_url = resolve_frameio_url(url)
        if resolved_frameio_url != url:
            url = validate_public_media_url(resolved_frameio_url)

    if google_drive_folder_id(url):
        raise ValueError(
            "This is a Google Drive folder link, not a media file link. "
            "Please open the folder and paste the Share link of the individual video/audio file. "
            "Folder links are not processed as a single transcription item."
        )

    if google_drive_file_id(url):
        return download_google_drive_media(url, folder)

    if frameio_share_ids(url):
        return download_frameio_media(url, folder)

    if is_youtube_media_url(url):
        return download_youtube_media(url, folder)

    download_dir = folder / "link_download"
    download_dir.mkdir(parents=True, exist_ok=True)
    max_bytes = MAX_LINK_SOURCE_MB * 1024 * 1024

    def progress_hook(data: dict[str, Any]) -> None:
        if int(data.get("downloaded_bytes") or 0) > max_bytes:
            raise yt_dlp.utils.DownloadError(
                f"Linked source exceeds the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
            )

    ydl_opts: dict[str, Any] = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "outtmpl": str(download_dir / "source.%(ext)s"),
        "noplaylist": True,
        "max_filesize": max_bytes,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "progress_hooks": [progress_hook],
        "cachedir": False,
        "logger": type(
            "QuietUnicodeLogger",
            (),
            {
                "debug": staticmethod(lambda msg: None),
                "warning": staticmethod(lambda msg: None),
                "error": staticmethod(lambda msg: None),
            },
        )(),
    }
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        ydl_opts["ffmpeg_location"] = ffmpeg

    cookie_file = _write_ytdlp_cookie_file(folder)
    if cookie_file is not None:
        ydl_opts["cookiefile"] = str(cookie_file)

    is_facebook = is_facebook_media_url(url)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        message = str(exc).strip()

        # Facebook has a known upstream extractor regression where public
        # posts/reels can return "Cannot parse data" even on current yt-dlp.
        # Fall back to the actual browser-visible player/CDN requests instead
        # of failing the transcription workflow immediately.
        if is_facebook:
            try:
                return download_facebook_public_fallback(url, folder)
            except Exception as fallback_exc:
                raise RuntimeError(str(fallback_exc)) from exc

        if "No supported JavaScript runtime" in message:
            raise RuntimeError(
                "This platform needs a supported JavaScript runtime for link extraction. "
                "Try a direct MP4/MP3/M4A link or another supported public media URL."
            ) from exc
        raise RuntimeError(f"Could not download media from that link. {message[:500]}") from exc
    except Exception as exc:
        if is_facebook:
            try:
                return download_facebook_public_fallback(url, folder)
            except Exception as fallback_exc:
                raise RuntimeError(str(fallback_exc)) from exc
        raise RuntimeError(f"Could not process that media link: {exc}") from exc

    candidates = [
        p for p in download_dir.iterdir()
        if p.is_file() and p.suffix.lower() not in {".part", ".ytdl"}
    ]
    if not candidates:
        raise RuntimeError(
            "No downloadable audio/video file was found. Use a direct media URL or a supported platform link."
        )

    source = max(candidates, key=lambda p: p.stat().st_size)
    if source.stat().st_size > max_bytes:
        raise ValueError(
            f"Linked source is larger than the {MAX_LINK_SOURCE_MB // 1024} GB download limit."
        )

    title = str((info or {}).get("title") or source.stem or "linked_media").strip()
    safe_title = safe_name(title)[:100] or "linked_media"
    normalized = folder / f"{safe_title}.mp3"
    normalize_link_media_to_mp3(source, normalized)

    return LocalMediaSource(
        path=normalized,
        name=f"{safe_title}.mp3",
        size=normalized.stat().st_size,
    )
