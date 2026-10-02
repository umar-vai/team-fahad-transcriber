from pathlib import Path

# Trigger v2: apply Frame.io support after workflow creation.
APP = Path("app.py")
SECRETS = Path(".streamlit/secrets.toml.example")

s = APP.read_text(encoding="utf-8")

if "import requests\n" not in s:
    s = s.replace("import gdown\n", "import gdown\nimport requests\n", 1)

marker = "def download_media_from_link(url: str, folder: Path) -> LocalMediaSource:\n"
if marker not in s:
    raise RuntimeError("download_media_from_link anchor not found")

if "def frameio_share_ids" not in s:
    helper = r'''def frameio_share_ids(url: str) -> tuple[str, str] | None:
    """Return (share_id, file_id) for Frame.io V4 share/view links."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
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


def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:
    """Resolve a Frame.io V4 share/view URL with the official API and download a rendition."""
    ids = frameio_share_ids(url)
    if not ids:
        raise ValueError("This does not look like a supported Frame.io share/view link.")
    _, file_id = ids

    token = str(secret_or_env("FRAMEIO_ACCESS_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "Frame.io links need a Frame.io API access token. Add FRAMEIO_ACCESS_TOKEN to "
            "Streamlit Secrets, then reboot the app. The normal browser share link itself is "
            "not a direct downloadable media URL."
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
        accounts_response.raise_for_status()
        accounts = accounts_response.json().get("data", [])
    except requests.RequestException as exc:
        raise RuntimeError(
            "Could not authenticate with Frame.io. Check FRAMEIO_ACCESS_TOKEN in Streamlit Secrets."
        ) from exc
    except ValueError as exc:
        raise RuntimeError("Frame.io returned an invalid accounts response.") from exc

    if not accounts:
        raise RuntimeError("The configured Frame.io token has no accessible accounts.")

    file_data = None
    include = "media_links.efficient,media_links.high_quality,media_links.original"
    for account in accounts:
        account_id = str(account.get("id") or "").strip()
        if not account_id:
            continue
        try:
            response = requests.get(
                f"https://api.frame.io/v4/accounts/{account_id}/files/{file_id}",
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
            "The Frame.io link is valid, but the configured Frame.io token cannot access this asset. "
            "Use a token from an account that has access to the shared file."
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
            "Frame.io did not return a downloadable rendition for this asset. "
            "The file may still be processing, or downloads may be restricted."
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


'''
    s = s.replace(marker, helper + marker, 1)

route_anchor = '''    if google_drive_folder_id(url):
        raise ValueError(
            "This is a Google Drive folder link, not a media file link. "
            "Please open the folder and paste the Share link of the individual video/audio file. "
            "Folder links are not processed as a single transcription item."
        )

    if google_drive_file_id(url):
        return download_google_drive_media(url, folder)
'''
route_replacement = '''    if google_drive_folder_id(url):
        raise ValueError(
            "This is a Google Drive folder link, not a media file link. "
            "Please open the folder and paste the Share link of the individual video/audio file. "
            "Folder links are not processed as a single transcription item."
        )

    if google_drive_file_id(url):
        return download_google_drive_media(url, folder)

    if frameio_share_ids(url):
        return download_frameio_media(url, folder)
'''
if route_replacement not in s:
    if route_anchor not in s:
        raise RuntimeError("link routing anchor not found")
    s = s.replace(route_anchor, route_replacement, 1)

s = s.replace(
    "Supports public Google Drive file links, direct media links, YouTube and other supported sources. ",
    "Supports public Google Drive file links, Frame.io share links, direct media links, YouTube and other supported sources. ",
)

APP.write_text(s, encoding="utf-8")

sec = SECRETS.read_text(encoding="utf-8")
if "FRAMEIO_ACCESS_TOKEN" not in sec:
    sec += '''\n# Optional: enables next.frame.io/share/.../view/... links through the official Frame.io V4 API.\n# Create an access token in Frame.io/Adobe developer settings and paste it only in Streamlit Secrets.\n# FRAMEIO_ACCESS_TOKEN = "paste-frameio-access-token-here"\n'''
    SECRETS.write_text(sec, encoding="utf-8")
