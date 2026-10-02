from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

old = '''def frameio_share_ids(url: str) -> tuple[str, str] | None:\n    \"\"\"Return (share_id, file_id) for Frame.io V4 share/view links.\"\"\"\n    parsed = urllib.parse.urlparse(str(url or \"\").strip())\n    host = (parsed.hostname or \"\").lower()\n    if host not in {\"next.frame.io\", \"www.next.frame.io\"}:\n        return None\n    match = re.search(\n        r\"/share/([0-9a-fA-F-]{36})/view/([0-9a-fA-F-]{36})\",\n        parsed.path,\n    )\n    if not match:\n        return None\n    return match.group(1), match.group(2)\n'''

new = '''def resolve_frameio_url(url: str) -> str:\n    \"\"\"Resolve f.io short links to their canonical next.frame.io review URL.\"\"\"\n    value = str(url or \"\").strip()\n    parsed = urllib.parse.urlparse(value)\n    host = (parsed.hostname or \"\").lower()\n    if host not in {\"f.io\", \"www.f.io\"}:\n        return value\n\n    headers = {\n        \"User-Agent\": \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36\",\n        \"Accept\": \"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\n    }\n    try:\n        response = requests.get(\n            value,\n            headers=headers,\n            allow_redirects=True,\n            stream=True,\n            timeout=20,\n        )\n        final_url = str(response.url or value).strip()\n        response.close()\n        return final_url\n    except requests.RequestException:\n        return value\n\n\ndef frameio_share_ids(url: str) -> tuple[str, str] | None:\n    \"\"\"Return (share_id, file_id) for Frame.io V4 share/view links, including f.io short links.\"\"\"\n    resolved = resolve_frameio_url(url)\n    parsed = urllib.parse.urlparse(resolved)\n    host = (parsed.hostname or \"\").lower()\n    if host not in {\"next.frame.io\", \"www.next.frame.io\"}:\n        return None\n    match = re.search(\n        r\"/share/([0-9a-fA-F-]{36})/view/([0-9a-fA-F-]{36})\",\n        parsed.path,\n    )\n    if not match:\n        return None\n    return match.group(1), match.group(2)\n'''

if old not in s:
    raise SystemExit('frameio_share_ids block not found')
s = s.replace(old, new, 1)

old2 = '''def download_media_from_link(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Download one public media URL with yt-dlp, then normalize it to MP3.\"\"\"\n    url = validate_public_media_url(url)\n\n    if google_drive_folder_id(url):\n'''

new2 = '''def download_media_from_link(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Download one public media URL, routing Frame.io short links before yt-dlp.\"\"\"\n    url = validate_public_media_url(url)\n\n    # f.io short links redirect to next.frame.io. Resolve them before source\n    # detection so they never fall through to yt-dlp as an unsupported URL.\n    parsed_host = (urllib.parse.urlparse(url).hostname or \"\").lower()\n    if parsed_host in {\"f.io\", \"www.f.io\"}:\n        resolved_frameio_url = resolve_frameio_url(url)\n        if resolved_frameio_url != url:\n            url = validate_public_media_url(resolved_frameio_url)\n\n    if google_drive_folder_id(url):\n'''

if old2 not in s:
    raise SystemExit('download_media_from_link header not found')
s = s.replace(old2, new2, 1)

# Make download_frameio_media use the canonical URL for public-page probing too.
old3 = '''def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Resolve Frame.io links: public review fallback first, authenticated V4 API second.\"\"\"\n    ids = frameio_share_ids(url)\n'''
new3 = '''def download_frameio_media(url: str, folder: Path) -> LocalMediaSource:\n    \"\"\"Resolve Frame.io links: public review fallback first, authenticated V4 API second.\"\"\"\n    url = resolve_frameio_url(url)\n    ids = frameio_share_ids(url)\n'''
if old3 not in s:
    raise SystemExit('download_frameio_media header not found')
s = s.replace(old3, new3, 1)

APP.write_text(s, encoding='utf-8')
