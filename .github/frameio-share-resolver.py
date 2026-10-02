from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

start = s.index('def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n')
end = s.index('\ndef download_media_from_link(url: str, folder: Path) -> LocalMediaSource:\n', start)

new_func = r'''def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:
    """Resolve a Frame.io V4 share/view URL using share-aware lookup first."""
    ids = frameio_share_ids(url)
    if not ids:
        raise ValueError("This does not look like a supported Frame.io share/view link.")
    share_id, view_id = ids

    token = get_frameio_access_token()
    if not token:
        raise RuntimeError(
            "Frame.io is not connected. Use the Connect Frame.io button in the app, authorize Adobe, "
            "then retry this link."
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
            st.session_state.pop("frameio_oauth_tokens", None)
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

        # Some share/view URLs use a view identifier that differs from the file
        # id. Prefer the first playable audio/video item returned by the share.
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
            "This Frame.io share is visible in the browser, but the connected Adobe account cannot access "
            "it through the Frame.io API. If this is a public review link from another workspace, the API "
            "still requires the connected account to have access to that share/workspace."
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

'''

s = s[:start] + new_func + s[end:]
APP.write_text(s, encoding='utf-8')
