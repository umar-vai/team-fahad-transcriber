from pathlib import Path

APP = Path("app.py")
BATCH = Path("pages/2_Batch_Transcription.py")

s = APP.read_text(encoding="utf-8")

MARKER = "# TEAM_FAHAD_SINGLE_BATCH_REFACTOR_V1"

# Hotfix path for the already-refactored app: ensure the Batch page initializes
# the dynamic URL row accumulator before the loop uses it.
if MARKER in s:
    anchor = '''uploaded = None\n\nif batch_page_mode:\n    st.markdown("<div class='section-label'>01 · Batch transcription</div>", unsafe_allow_html=True)\n'''
    replacement = '''uploaded = None\n\nif batch_page_mode:\n    bulk_link_rows: list[dict[str, str | int]] = []\n    st.markdown("<div class='section-label'>01 · Batch transcription</div>", unsafe_allow_html=True)\n'''
    if 'bulk_link_rows: list[dict[str, str | int]] = []' not in s:
        if anchor not in s:
            raise RuntimeError("Could not find batch hotfix anchor")
        s = s.replace(anchor, replacement, 1)
        APP.write_text(s, encoding="utf-8")
    raise SystemExit(0)

# Establish page mode before page config so the Batch page can reuse the same engine/UI safely.
set_page = 'st.set_page_config(page_title=APP_TITLE, page_icon="🎙️", layout="wide")\n'
if set_page not in s:
    raise RuntimeError("Could not find st.set_page_config anchor")
page_mode = '''batch_page_mode = bool(st.session_state.pop("_team_fahad_batch_page", False))\nPAGE_TITLE = "Batch Transcription · Team Fahad" if batch_page_mode else APP_TITLE\n# TEAM_FAHAD_SINGLE_BATCH_REFACTOR_V1\n\nst.set_page_config(page_title=PAGE_TITLE, page_icon="🎙️", layout="wide")\n'''
s = s.replace(set_page, page_mode, 1)

old_hero = '''  <h1>Turn media into usable content.</h1>\n  <p>Upload a file or paste multiple media links. Get polished transcripts, speaker-aware subtitles, VTT files and client-ready deliverables from one clean workspace.</p>'''
new_hero = '''  <h1>{"Batch URL transcription." if batch_page_mode else "Turn media into usable content."}</h1>\n  <p>{"Paste multiple media links, assign custom VTT names, process them sequentially, and download all successful VTT files as one ZIP." if batch_page_mode else "Upload a file or paste one media link. Choose Smart Clean, Detailed Subtitles + Speakers, or Exact Verbatim from the same sidebar settings."}</p>'''
if old_hero not in s:
    raise RuntimeError("Could not find hero copy anchor")
s = s.replace(old_hero, new_hero, 1)

start = s.index('init_bulk_url_state()\n\nsource_tabs = st.tabs(')
end = s.index('\nif uploaded is not None:', start)
old_source_block = s[start:end]
needle = 'with source_tabs[1]:\n'
body_start = old_source_block.index(needle) + len(needle)
bulk_body = old_source_block[body_start:]
bulk_body = '\n'.join(line[4:] if line.startswith('    ') else line for line in bulk_body.splitlines())
bulk_body_indented = '\n'.join(('    ' + line) if line else '' for line in bulk_body.splitlines())

new_source_block = '''init_bulk_url_state()\n\nuploaded = None\n\nif batch_page_mode:\n    bulk_link_rows: list[dict[str, str | int]] = []\n    st.markdown("<div class='section-label'>01 · Batch transcription</div>", unsafe_allow_html=True)\n    st.markdown("### Multiple URL transcription")\n''' + bulk_body_indented + '''\n    st.stop()\n\nsource_tabs = st.tabs(\n    ["Upload file", "Paste link"],\n    key="source_input_tabs",\n    on_change="rerun",\n)\n\nwith source_tabs[0]:\n    st.caption("Upload an audio or video file. Your selected transcription mode and language settings are applied automatically.")\n    uploaded = st.file_uploader(\n        "Upload audio or video",\n        type=["mp3", "wav", "m4a", "aac", "ogg", "flac", "mp4", "mov", "mkv"],\n        help=f"Maximum local upload size: {MAX_UPLOAD_MB} MB.",\n        key="media_file_uploader",\n        max_upload_size=MAX_UPLOAD_MB,\n    )\n\nwith source_tabs[1]:\n    st.caption("Paste one public media URL. It uses the same Spoken language, Output mode, and custom vocabulary settings as file upload.")\n    single_media_link = st.text_input(\n        "Media URL",\n        placeholder="https://drive.google.com/file/d/... or https://youtube.com/watch?v=...",\n        type="url",\n        key="single_media_link",\n    )\n    st.caption(\n        "Supports public Google Drive file links, direct media links, YouTube and other supported sources. "\n        "Google Drive folder links are not single media files."\n    )\n\n    if single_media_link.strip():\n        c1, c2 = st.columns([0.72, 0.28])\n        c1.metric("Source", "Media link")\n        c2.metric(\n            "Mode",\n            "Detailed" if mode.startswith("Detailed") else ("Verbatim" if mode.startswith("Exact") else "Smart"),\n        )\n        if mode == "Detailed subtitles + speakers":\n            st.info("Detailed mode creates speaker labels plus SRT/VTT. Long linked recordings are automatically chunked and merged.")\n\n        if st.button(\n            "Transcribe link",\n            type="primary",\n            disabled=not bool(transcription_api_keys),\n            use_container_width=True,\n            key="transcribe_single_link",\n        ):\n            reset_outputs()\n            st.session_state["source_kind"] = "link"\n            status = st.status("Preparing linked media…", expanded=True)\n            try:\n                validate_public_media_url(single_media_link)\n                with tempfile.TemporaryDirectory(prefix="team_fahad_single_link_") as link_dir:\n                    folder = Path(link_dir)\n                    status.write("Downloading media securely…")\n                    linked_source = download_media_from_link(single_media_link, folder)\n                    status.write("Running speech-to-text…")\n                    if mode == "Detailed subtitles + speakers":\n                        result = transcribe_linked_media_with_chunks(\n                            uploaded=linked_source,\n                            api_keys=transcription_api_keys,\n                            language_codes=LANGUAGES[language_name],\n                        )\n                    else:\n                        result = transcribe_media(\n                            uploaded=linked_source,\n                            api_keys=transcription_api_keys,\n                            language_codes=LANGUAGES[language_name],\n                            mode=mode,\n                            custom_vocabulary=vocab,\n                        )\n                    st.session_state.result = result\n                    st.session_state.source_name = linked_source.name\n                status.update(label="Transcription complete", state="complete", expanded=False)\n            except errors.APIError as exc:\n                status.update(label="Transcription failed", state="error")\n                code = getattr(exc, "code", "API")\n                message = getattr(exc, "message", str(exc))\n                st.error(f"Gemini request failed ({code}): {message}")\n            except Exception as exc:\n                status.update(label="Transcription failed", state="error")\n                st.error(str(exc))\n'''

s = s[:start] + new_source_block + s[end:]

old_bulk_download = '''        if st.session_state.get("bulk_vtt_zip"):\n            st.markdown("### Bulk URL VTT pack")\n            st.caption("The ZIP contains one VTT file per successful URL, using each URL's custom name.")\n            st.download_button(\n                "Download bulk VTT ZIP",\n                data=st.session_state["bulk_vtt_zip"],\n                file_name=st.session_state.get("bulk_zip_name", "Team-Fahad-Bulk-VTT.zip"),\n                mime="application/zip",\n                type="primary",\n                width="stretch",\n                on_click="ignore",\n                key="download_bulk_vtt_zip_workspace",\n            )\n\n'''
s = s.replace(old_bulk_download, "")

APP.write_text(s, encoding="utf-8")

BATCH.write_text('''from pathlib import Path\n\nimport streamlit as st\n\nst.session_state["_team_fahad_batch_page"] = True\napp_path = Path(__file__).resolve().parents[1] / "app.py"\ncode = app_path.read_text(encoding="utf-8")\nexec(compile(code, str(app_path), "exec"), {"__name__": "__main__", "__file__": str(app_path)})\n''', encoding="utf-8")
