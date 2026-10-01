from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import gspread
import imageio_ffmpeg
import streamlit as st
from google import genai
from google.genai import errors
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from moviepy import AudioFileClip, VideoFileClip

APP_TITLE = "Batch Transcription · Team Fahad"
TRANSCRIBE_MODEL = "gemini-3.5-transcribe"
CONTENT_MODEL = "gemini-3.8-flash"
TRANSCRIPT_SHEET_DEFAULT = "Transcripts"
TRANSCRIPT_CHUNK_CHARS = 40_000
SUMMARY_SOURCE_CHARS = 55_000
AUDIO_CHUNK_SECONDS = 50 * 60

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}
LANGUAGES = {
    "Auto detect / mixed language": [],
    "Bangla (Bangladesh)": ["bn-BD"],
    "English (US)": ["en-US"],
    "English (UK)": ["en-GB"],
    "Arabic": ["ar-EG"],
    "Hindi": ["hi-IN"],
}
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]


class APIKeyPoolExhausted(RuntimeError):
    pass


def secret_or_env(name: str) -> Any | None:
    try:
        value = st.secrets.get(name)
        if value not in (None, "", []):
            return value
    except Exception:
        pass
    value = os.getenv(name)
    return value if value else None


def normalize_key_list(value: Any | None) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        raw = [str(item).strip() for item in value]
    else:
        raw = [item.strip() for item in re.split(r"[,;\n]+", str(value))]
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def load_api_key_pool(scope: str | None = None) -> list[str]:
    names: list[str] = []
    if scope:
        prefix = scope.upper()
        names.extend([f"{prefix}_GEMINI_API_KEYS", f"{prefix}_GEMINI_API_KEY"])
    names.extend(["GEMINI_API_KEYS", "GEMINI_API_KEY"])
    for name in names:
        keys = normalize_key_list(secret_or_env(name))
        if keys:
            return keys
    return []


def api_key_id(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def api_error_code(exc: Exception) -> int | None:
    try:
        return int(getattr(exc, "code", None))
    except (TypeError, ValueError):
        return None


def mark_key_rate_limited(api_key: str, seconds: int = 120) -> None:
    state = st.session_state.setdefault("_batch_api_cooldowns", {})
    state[api_key_id(api_key)] = time.time() + seconds


def key_is_available(api_key: str) -> bool:
    state = st.session_state.setdefault("_batch_api_cooldowns", {})
    until = float(state.get(api_key_id(api_key), 0) or 0)
    if until <= time.time():
        state.pop(api_key_id(api_key), None)
        return True
    return False


def run_with_key_pool(api_keys: list[str], operation: Any, purpose: str) -> Any:
    available = [key for key in api_keys if key_is_available(key)]
    if not available:
        raise APIKeyPoolExhausted(f"No available Gemini API key for {purpose} right now.")
    last_error: Exception | None = None
    for key in available:
        try:
            return operation(key)
        except errors.APIError as exc:
            if api_error_code(exc) != 429:
                raise
            last_error = exc
            mark_key_rate_limited(key)
            continue
    raise APIKeyPoolExhausted(f"All Gemini API keys are rate-limited for {purpose}.") from last_error


def load_service_account_info() -> dict[str, Any] | None:
    try:
        block = st.secrets.get("gcp_service_account")
    except Exception:
        block = None
    if block:
        if isinstance(block, Mapping):
            return dict(block)
        try:
            return dict(block)
        except Exception:
            pass

    raw = secret_or_env("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        return None
    if isinstance(raw, Mapping):
        return dict(raw)
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError as exc:
        raise ValueError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("GOOGLE_SERVICE_ACCOUNT_JSON must contain a JSON object.")
    return parsed


def google_clients() -> tuple[gspread.Client, Any, dict[str, Any]]:
    info = load_service_account_info()
    if not info:
        raise RuntimeError(
            "Google service account is not configured. Add [gcp_service_account] to Streamlit Secrets."
        )
    credentials = Credentials.from_service_account_info(info, scopes=GOOGLE_SCOPES)
    sheets_client = gspread.authorize(credentials)
    drive_service = build("drive", "v3", credentials=credentials, cache_discovery=False)
    return sheets_client, drive_service, info


def parse_spreadsheet_id(value: str) -> str:
    text = value.strip()
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", text)
    if match:
        return match.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", text):
        return text
    raise ValueError("Paste a valid Google Sheet URL or spreadsheet ID.")


def parse_folder_id(value: str) -> str | None:
    text = value.strip()
    if not text:
        return None
    match = re.search(r"/folders/([a-zA-Z0-9_-]+)", text)
    if match:
        return match.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", text):
        return text
    raise ValueError("Paste a valid Google Drive folder URL or folder ID.")


def parse_drive_file_id(value: str) -> str | None:
    text = value.strip()
    for pattern in (
        r"/file/d/([a-zA-Z0-9_-]+)",
        r"[?&]id=([a-zA-Z0-9_-]+)",
        r"/open\?id=([a-zA-Z0-9_-]+)",
    ):
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def clean_source_name(value: str) -> str:
    text = re.sub(r"\s+", " ", value.strip())
    text = re.sub(r"^[^\w]+", "", text, flags=re.UNICODE)
    return text.strip()


def normalized_name(value: str) -> str:
    text = clean_source_name(value).casefold()
    text = re.sub(r"\s+", " ", text)
    return text


def column_letter(index: int) -> str:
    result = ""
    current = index
    while current:
        current, remainder = divmod(current - 1, 26)
        result = chr(65 + remainder) + result
    return result


def ensure_headers(worksheet: gspread.Worksheet, header_row: int, source_header: str, output_headers: list[str]) -> dict[str, int]:
    values = worksheet.row_values(header_row)
    mapping = {value.strip(): index + 1 for index, value in enumerate(values) if value.strip()}
    if source_header not in mapping:
        raise ValueError(f'Could not find source column header "{source_header}" on row {header_row}.')
    next_col = max(len(values), max(mapping.values(), default=0)) + 1
    for header in output_headers:
        if header not in mapping:
            worksheet.update_cell(header_row, next_col, header)
            mapping[header] = next_col
            next_col += 1
    return mapping


def worksheet_by_name_or_first(book: gspread.Spreadsheet, worksheet_name: str) -> gspread.Worksheet:
    if worksheet_name.strip():
        return book.worksheet(worksheet_name.strip())
    return book.get_worksheet(0)


def list_drive_folder(drive: Any, folder_id: str) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    token: str | None = None
    while True:
        response = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id,name,mimeType,size,webViewLink)",
            pageSize=1000,
            pageToken=token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        for item in response.get("files", []):
            if item.get("mimeType") == "application/vnd.google-apps.folder":
                continue
            index.setdefault(normalized_name(item.get("name", "")), []).append(item)
        token = response.get("nextPageToken")
        if not token:
            break
    return index


def resolve_drive_file(drive: Any, source_value: str, folder_index: dict[str, list[dict[str, Any]]] | None) -> dict[str, Any]:
    direct_id = parse_drive_file_id(source_value)
    if direct_id:
        return drive.files().get(
            fileId=direct_id,
            fields="id,name,mimeType,size,webViewLink",
            supportsAllDrives=True,
        ).execute()

    if folder_index is None:
        raise ValueError("This row contains a filename, so a Raw Drive Folder URL/ID is required.")

    key = normalized_name(source_value)
    candidates = folder_index.get(key, [])
    if not candidates:
        raise FileNotFoundError(f'No Drive file matched "{clean_source_name(source_value)}".')
    if len(candidates) > 1:
        exact = [item for item in candidates if item.get("name", "").casefold() == clean_source_name(source_value).casefold()]
        if len(exact) == 1:
            return exact[0]
        raise RuntimeError(f'Multiple Drive files matched "{clean_source_name(source_value)}". Rename duplicates or use a direct Drive link.')
    return candidates[0]


def download_drive_file(drive: Any, file_id: str, destination: Path) -> None:
    request = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    with destination.open("wb") as handle:
        downloader = MediaIoBaseDownload(handle, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = downloader.next_chunk()


def prepare_compressed_audio(source: Path, folder: Path) -> tuple[Path, float]:
    extension = source.suffix.lower()
    output = folder / "normalized_audio.mp3"
    if extension in VIDEO_EXTENSIONS:
        with VideoFileClip(str(source)) as clip:
            duration = float(clip.duration or 0)
            if clip.audio is None:
                raise ValueError("Video does not contain an audio track.")
            clip.audio.write_audiofile(
                str(output),
                codec="libmp3lame",
                bitrate="48k",
                fps=16000,
                ffmpeg_params=["-ac", "1"],
                logger=None,
            )
    elif extension in AUDIO_EXTENSIONS:
        with AudioFileClip(str(source)) as clip:
            duration = float(clip.duration or 0)
            clip.write_audiofile(
                str(output),
                codec="libmp3lame",
                bitrate="48k",
                fps=16000,
                ffmpeg_params=["-ac", "1"],
                logger=None,
            )
    else:
        raise ValueError(f"Unsupported media format: {extension or 'unknown'}")
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError("Audio extraction returned an empty file.")
    return output, duration


def split_audio(audio_path: Path, duration: float, folder: Path) -> list[Path]:
    if duration <= AUDIO_CHUNK_SECONDS + 2:
        return [audio_path]
    pattern = folder / "chunk_%03d.mp3"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(audio_path),
        "-f",
        "segment",
        "-segment_time",
        str(AUDIO_CHUNK_SECONDS),
        "-reset_timestamps",
        "1",
        "-c",
        "copy",
        str(pattern),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Could not split long audio: {completed.stderr.strip()}")
    chunks = sorted(folder.glob("chunk_*.mp3"))
    if not chunks:
        raise RuntimeError("Long audio splitting produced no chunks.")
    return chunks


def wait_for_file(client: genai.Client, uploaded_file: Any, timeout_seconds: int = 180) -> Any:
    if getattr(uploaded_file, "state", None) is None:
        return uploaded_file
    deadline = time.monotonic() + timeout_seconds
    current = uploaded_file
    while True:
        state = getattr(getattr(current, "state", None), "name", str(getattr(current, "state", ""))).upper()
        if state in {"ACTIVE", "STATE_ACTIVE", ""}:
            return current
        if "FAILED" in state:
            raise RuntimeError("Gemini could not prepare the uploaded audio.")
        if time.monotonic() >= deadline:
            raise TimeoutError("Gemini file preparation timed out.")
        time.sleep(2)
        current = client.files.get(name=current.name)


def transcribe_chunk_once(api_key: str, audio_path: Path, language_codes: list[str], mode: str, vocabulary: list[str]) -> str:
    client = genai.Client(api_key=api_key)
    remote = None
    try:
        remote = client.files.upload(file=str(audio_path), config={"mime_type": "audio/mpeg"})
        remote = wait_for_file(client, remote)
        config: dict[str, Any] = {"language_codes": language_codes}
        if mode == "Smart clean transcript":
            config["mode"] = "smart"
        else:
            config["mode"] = {"type": "verbatim"}
        if vocabulary:
            config["custom_vocabulary"] = vocabulary[:100]
        item = {
            "type": "audio",
            "uri": remote.uri,
            "mime_type": getattr(remote, "mime_type", "audio/mpeg") or "audio/mpeg",
        }
        interaction = client.interactions.create(
            model=TRANSCRIBE_MODEL,
            input=[item],
            generation_config={"transcription_config": config},
        )
        text = str(getattr(interaction, "output_text", "") or "").strip()
        if not text:
            raise RuntimeError("Gemini returned an empty transcript.")
        return text
    finally:
        if remote is not None:
            try:
                client.files.delete(name=remote.name)
            except Exception:
                pass
        try:
            client.close()
        except Exception:
            pass


def transcribe_chunk(api_keys: list[str], audio_path: Path, language_codes: list[str], mode: str, vocabulary: list[str]) -> str:
    return run_with_key_pool(
        api_keys,
        lambda key: transcribe_chunk_once(key, audio_path, language_codes, mode, vocabulary),
        "transcription",
    )


def ai_text_once(api_key: str, prompt: str) -> str:
    client = genai.Client(api_key=api_key)
    try:
        result = client.interactions.create(model=CONTENT_MODEL, input=prompt)
        text = str(getattr(result, "output_text", "") or "").strip()
        if not text:
            raise RuntimeError("Gemini returned an empty summary.")
        return text
    finally:
        try:
            client.close()
        except Exception:
            pass


def ai_text(api_keys: list[str], prompt: str) -> str:
    return run_with_key_pool(api_keys, lambda key: ai_text_once(key, prompt), "summary")


def summarize_transcript(api_keys: list[str], transcript: str) -> str:
    prompt_template = (
        "Summarize this transcript accurately in the transcript's main language. "
        "Return: (1) short executive summary, (2) key points, (3) action items/decisions only when present. "
        "Do not invent facts.\n\nTRANSCRIPT:\n{}"
    )
    if len(transcript) <= SUMMARY_SOURCE_CHARS:
        return ai_text(api_keys, prompt_template.format(transcript))

    partials: list[str] = []
    for start in range(0, len(transcript), SUMMARY_SOURCE_CHARS):
        part = transcript[start : start + SUMMARY_SOURCE_CHARS]
        partials.append(ai_text(api_keys, prompt_template.format(part)))
    combined = "\n\n--- PARTIAL SUMMARY ---\n".join(partials)
    return ai_text(
        api_keys,
        "Combine the partial summaries below into one accurate final summary in the source language. "
        "Remove repetition and keep only supported facts, key points, decisions and action items.\n\n" + combined,
    )


def split_text(text: str, max_chars: int = TRANSCRIPT_CHUNK_CHARS) -> list[str]:
    return [text[i : i + max_chars] for i in range(0, len(text), max_chars)] or [""]


def get_or_create_transcript_sheet(book: gspread.Spreadsheet, title: str) -> gspread.Worksheet:
    try:
        ws = book.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = book.add_worksheet(title=title, rows=1000, cols=7)
    expected = ["Source Row", "Row Ref", "File Name", "Part", "Total Parts", "Transcript", "Summary"]
    current = ws.row_values(1)
    if current[: len(expected)] != expected:
        ws.update(values=[expected], range_name="A1:G1", value_input_option="RAW")
    return ws


def remove_old_transcript_rows(ws: gspread.Worksheet, source_row: int) -> None:
    values = ws.col_values(1)
    targets = [index for index, value in enumerate(values, start=1) if index > 1 and value.strip() == str(source_row)]
    for row_number in reversed(targets):
        ws.delete_rows(row_number)


def save_transcript(
    ws: gspread.Worksheet,
    source_row: int,
    row_ref: str,
    file_name: str,
    transcript: str,
    summary: str,
) -> tuple[int, int]:
    remove_old_transcript_rows(ws, source_row)
    chunks = split_text(transcript)
    start_row = len(ws.col_values(1)) + 1
    rows = []
    for index, chunk in enumerate(chunks, start=1):
        rows.append([
            str(source_row),
            row_ref,
            file_name,
            index,
            len(chunks),
            chunk,
            summary if index == 1 else "",
        ])
    ws.append_rows(rows, value_input_option="RAW")
    return start_row, start_row + len(rows) - 1


def update_cells(worksheet: gspread.Worksheet, updates: dict[int, Any], row: int) -> None:
    payload = []
    for col, value in updates.items():
        payload.append({"range": f"{column_letter(col)}{row}", "values": [[value]]})
    if payload:
        worksheet.batch_update(payload, value_input_option="USER_ENTERED")


def format_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def safe_error(exc: Exception) -> str:
    text = re.sub(r"\s+", " ", str(exc)).strip()
    return text[:1500] or exc.__class__.__name__


st.set_page_config(page_title=APP_TITLE, page_icon="📚", layout="wide")
st.markdown(
    """
<style>
html, body, [data-testid="stApp"], [data-testid="stAppViewContainer"] {background:#07111f;color:#f7fbff;}
[data-testid="stSidebar"] {background:linear-gradient(180deg,#0d1728,#07111f);border-right:1px solid rgba(148,163,184,.18);}
.block-container {max-width:1180px;padding-top:1.4rem;padding-bottom:4rem;}
.batch-hero {padding:1.6rem 1.7rem;border:1px solid rgba(148,163,184,.18);border-radius:24px;background:linear-gradient(135deg,#161d46,#0d2944);box-shadow:0 22px 60px rgba(124,92,255,.22);margin-bottom:1rem;}
.batch-hero h1 {margin:0;font-size:clamp(1.9rem,4vw,3rem);letter-spacing:-.035em;}
.batch-hero p {color:#93a4bc;max-width:800px;line-height:1.65;margin:.7rem 0 0;}
.stButton>button {border-radius:13px!important;font-weight:750!important;}
.stButton>button[kind="primary"] {background:linear-gradient(90deg,#7c5cff,#00d7ff)!important;color:white!important;border:0!important;min-height:3rem;}
[data-testid="stMetric"] {background:#0d1728;border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:.85rem 1rem;}
</style>
<div class="batch-hero">
  <h1>Google Sheet Batch Transcription</h1>
  <p>Read video names or Drive links from your project tracker, download each file only on the server, compress the audio, transcribe it, generate a summary, save the full transcript in a dedicated worksheet, and mark the original row as done.</p>
</div>
""",
    unsafe_allow_html=True,
)

transcription_keys = load_api_key_pool("TRANSCRIBE")
content_keys = load_api_key_pool("CONTENT") or transcription_keys
service_info = load_service_account_info()

c1, c2, c3 = st.columns(3)
c1.metric("Gemini transcription keys", len(transcription_keys))
c2.metric("Gemini summary keys", len(content_keys))
c3.metric("Google connection", "Ready" if service_info else "Needs setup")

if service_info:
    st.caption(f"Share the Google Sheet and raw video folder with: {service_info.get('client_email', 'service account email unavailable')}")
else:
    st.warning("Google access is not configured yet. Add the service-account block shown in .streamlit/secrets.toml.example to Streamlit Secrets.")

with st.expander("Batch source & output settings", expanded=True):
    left, right = st.columns(2)
    with left:
        sheet_value = st.text_input("Google Sheet URL / ID", placeholder="https://docs.google.com/spreadsheets/d/...")
        worksheet_name = st.text_input("Worksheet/tab name", placeholder="Leave blank to use the first tab")
        drive_folder_value = st.text_input(
            "Raw Drive Folder URL / ID",
            placeholder="Required when the source column contains filenames instead of Drive links",
        )
        transcript_sheet_name = st.text_input("Transcript worksheet", value=TRANSCRIPT_SHEET_DEFAULT)
    with right:
        header_row = st.number_input("Header row", min_value=1, value=3, step=1)
        data_start_row = st.number_input("First data row", min_value=2, value=5, step=1)
        source_header = st.text_input("Source column header", value="Raw Folder")
        row_ref_header = st.text_input("Row reference header (optional)", value="Row Ref")

    st.markdown("#### Columns the app will use/create")
    col1, col2, col3 = st.columns(3)
    with col1:
        status_header = st.text_input("Status", value="Transcription Status")
        transcript_link_header = st.text_input("Transcript link", value="Transcript")
    with col2:
        summary_header = st.text_input("Summary", value="AI Summary")
        duration_header = st.text_input("Duration", value="Media Duration")
    with col3:
        error_header = st.text_input("Error", value="Transcription Error")
        processed_header = st.text_input("Processed time", value="Transcribed At")

with st.expander("Transcription settings", expanded=True):
    a, b, c = st.columns(3)
    with a:
        language_name = st.selectbox("Spoken language", list(LANGUAGES.keys()), index=0)
    with b:
        output_mode = st.selectbox("Output mode", ["Smart clean transcript", "Exact verbatim transcript"])
    with c:
        batch_limit = st.number_input("Max files this run", min_value=1, max_value=100, value=25, step=1)
    generate_summary = st.checkbox("Generate summary + key points automatically", value=True)
    retry_failed = st.checkbox("Retry rows previously marked FAILED", value=True)
    vocab_text = st.text_area(
        "Custom vocabulary (optional)",
        placeholder="Tamrin Institute, Team Fahad, product names...",
        help="Comma or line separated. First 100 terms are used.",
    )

button_left, button_right = st.columns(2)
with button_left:
    test_clicked = st.button("Test Google connection", use_container_width=True)
with button_right:
    start_clicked = st.button("Start / Resume batch", type="primary", use_container_width=True)

if test_clicked:
    try:
        if not sheet_value.strip():
            raise ValueError("Enter the Google Sheet URL/ID first.")
        sheets_client, drive, info = google_clients()
        sheet_id = parse_spreadsheet_id(sheet_value)
        book = sheets_client.open_by_key(sheet_id)
        ws = worksheet_by_name_or_first(book, worksheet_name)
        headers = ws.row_values(int(header_row))
        folder_id = parse_folder_id(drive_folder_value)
        file_count = None
        if folder_id:
            folder_index = list_drive_folder(drive, folder_id)
            file_count = sum(len(items) for items in folder_index.values())
        st.success(f'Connected to "{book.title}" → "{ws.title}". Found {len(headers)} header cells.' + (f" Drive folder contains {file_count} file(s)." if file_count is not None else ""))
        st.caption(f"Connected as {info.get('client_email', 'service account')}.")
    except Exception as exc:
        st.error(safe_error(exc))

if start_clicked:
    report: list[dict[str, Any]] = []
    try:
        if not transcription_keys:
            raise RuntimeError("No Gemini transcription API key is configured.")
        if not sheet_value.strip():
            raise ValueError("Enter the Google Sheet URL/ID first.")

        sheets_client, drive, _ = google_clients()
        sheet_id = parse_spreadsheet_id(sheet_value)
        folder_id = parse_folder_id(drive_folder_value)
        book = sheets_client.open_by_key(sheet_id)
        ws = worksheet_by_name_or_first(book, worksheet_name)

        output_headers = [
            status_header,
            transcript_link_header,
            summary_header,
            duration_header,
            error_header,
            processed_header,
        ]
        mapping = ensure_headers(ws, int(header_row), source_header, output_headers)
        if row_ref_header.strip() and row_ref_header.strip() not in mapping:
            refreshed_headers = ws.row_values(int(header_row))
            mapping = {value.strip(): index + 1 for index, value in enumerate(refreshed_headers) if value.strip()}

        transcript_ws = get_or_create_transcript_sheet(book, transcript_sheet_name.strip() or TRANSCRIPT_SHEET_DEFAULT)
        folder_index = list_drive_folder(drive, folder_id) if folder_id else None

        max_col = max(mapping.values())
        values = ws.get(f"A{int(data_start_row)}:{column_letter(max_col)}")
        queue: list[tuple[int, list[str]]] = []
        source_col = mapping[source_header]
        status_col = mapping[status_header]
        for offset, row_values in enumerate(values):
            sheet_row = int(data_start_row) + offset
            source = row_values[source_col - 1].strip() if len(row_values) >= source_col else ""
            status_value = row_values[status_col - 1].strip().upper() if len(row_values) >= status_col else ""
            if not source:
                continue
            if status_value == "DONE":
                continue
            if status_value == "FAILED" and not retry_failed:
                continue
            queue.append((sheet_row, row_values))
            if len(queue) >= int(batch_limit):
                break

        if not queue:
            st.success("Nothing to process. All matching rows are already done, blank, or excluded by your retry setting.")
        else:
            progress = st.progress(0.0, text=f"Queued {len(queue)} file(s)")
            status_box = st.status("Batch started", expanded=True)
            done_count = 0
            failed_count = 0
            vocab = [item.strip() for item in re.split(r"[,\n]", vocab_text) if item.strip()][:100]

            for position, (sheet_row, row_values) in enumerate(queue, start=1):
                source = row_values[source_col - 1].strip() if len(row_values) >= source_col else ""
                row_ref = ""
                if row_ref_header.strip() and row_ref_header.strip() in mapping:
                    ref_col = mapping[row_ref_header.strip()]
                    row_ref = row_values[ref_col - 1].strip() if len(row_values) >= ref_col else ""
                row_ref = row_ref or f"Row {sheet_row}"

                update_cells(
                    ws,
                    {
                        mapping[status_header]: "PROCESSING",
                        mapping[error_header]: "",
                    },
                    sheet_row,
                )
                status_box.write(f"{position}/{len(queue)} · {row_ref} · locating Drive file…")

                try:
                    meta = resolve_drive_file(drive, source, folder_index)
                    file_name = meta.get("name") or clean_source_name(source) or f"row_{sheet_row}.mp4"
                    suffix = Path(file_name).suffix.lower()
                    if suffix not in VIDEO_EXTENSIONS and suffix not in AUDIO_EXTENSIONS:
                        raise ValueError(f"Unsupported file type for {file_name}.")

                    with tempfile.TemporaryDirectory(prefix=f"team_fahad_batch_{sheet_row}_") as temp_dir:
                        folder = Path(temp_dir)
                        source_path = folder / f"source{suffix}"
                        status_box.write(f"{position}/{len(queue)} · downloading {file_name} to temporary server storage…")
                        download_drive_file(drive, meta["id"], source_path)
                        if not source_path.exists() or source_path.stat().st_size == 0:
                            raise RuntimeError("Drive download returned an empty file.")

                        status_box.write(f"{position}/{len(queue)} · compressing audio…")
                        audio_path, duration = prepare_compressed_audio(source_path, folder)
                        chunks = split_audio(audio_path, duration, folder)

                        transcripts: list[str] = []
                        for chunk_index, chunk_path in enumerate(chunks, start=1):
                            status_box.write(f"{position}/{len(queue)} · transcribing chunk {chunk_index}/{len(chunks)}…")
                            text = transcribe_chunk(
                                transcription_keys,
                                chunk_path,
                                LANGUAGES[language_name],
                                output_mode,
                                vocab,
                            )
                            transcripts.append(text)

                        transcript = "\n\n".join(transcripts).strip()
                        summary = ""
                        if generate_summary:
                            if not content_keys:
                                raise RuntimeError("Summary was requested but no Gemini content API key is configured.")
                            status_box.write(f"{position}/{len(queue)} · generating summary…")
                            summary = summarize_transcript(content_keys, transcript)

                    start_row, end_row = save_transcript(
                        transcript_ws,
                        source_row=sheet_row,
                        row_ref=row_ref,
                        file_name=file_name,
                        transcript=transcript,
                        summary=summary,
                    )
                    transcript_url = (
                        f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
                        f"#gid={transcript_ws.id}&range=A{start_row}:G{end_row}"
                    )
                    update_cells(
                        ws,
                        {
                            mapping[status_header]: "DONE",
                            mapping[transcript_link_header]: transcript_url,
                            mapping[summary_header]: summary[:49_000],
                            mapping[duration_header]: format_duration(duration),
                            mapping[error_header]: "",
                            mapping[processed_header]: datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z"),
                        },
                        sheet_row,
                    )
                    done_count += 1
                    report.append({"Row": sheet_row, "Ref": row_ref, "File": file_name, "Status": "DONE", "Duration": format_duration(duration)})
                except Exception as exc:
                    message = safe_error(exc)
                    failed_count += 1
                    update_cells(
                        ws,
                        {
                            mapping[status_header]: "FAILED",
                            mapping[error_header]: message,
                            mapping[processed_header]: datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z"),
                        },
                        sheet_row,
                    )
                    status_box.write(f"{position}/{len(queue)} · FAILED · {row_ref}: {message}")
                    report.append({"Row": sheet_row, "Ref": row_ref, "File": clean_source_name(source), "Status": "FAILED", "Duration": "", "Error": message})

                progress.progress(position / len(queue), text=f"Processed {position}/{len(queue)} · Done {done_count} · Failed {failed_count}")

            status_box.update(label=f"Batch finished · {done_count} done · {failed_count} failed", state="complete" if failed_count == 0 else "error", expanded=failed_count > 0)
            st.dataframe(report, use_container_width=True, hide_index=True)
            if failed_count:
                st.info("Failed rows were saved with the error message. Fix the cause and press Start / Resume batch again; DONE rows will be skipped automatically.")
            else:
                st.success("Batch complete. Full transcripts are in the Transcripts worksheet and the original tracker rows are marked DONE.")
    except Exception as exc:
        st.error(safe_error(exc))

st.divider()
st.caption("Batch processing uses temporary server storage only. Each downloaded video/audio file and extracted audio are deleted automatically after that row finishes. Keep this browser tab open while a batch is running; resume is safe because rows marked DONE are skipped.")
