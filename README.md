# Team Fahad Transcriber

Video and audio transcription with the Gemini API, running fully on Cloudflare at
**https://transcribe.abdullahfahad.com** with Google sign-in and per-user history.

## Features

- Upload audio files, or paste a public YouTube link
- Live microphone transcription
- Google Drive folders: paste one folder link and every MP3, WAV and FLAC file in it (FLAC up to 12 MB each) is transcribed on the server (no container, no extra cost), one by one, then saved to History, Notion (a page per folder) and Google Sheets (a tab per folder)
- **Bridge PCs:** a small Windows app on each PC watches a folder; every new audio file is transcribed right away and added, with its date, to that PC's tab in Google Sheets (a new PC can also take over an existing computer, for example a Drive one, with a team PIN; see [`bridge/README.md`](bridge/README.md))
- Output modes: Smart clean transcript, Subtitles + speakers (timed), Exact verbatim transcript
- Shayari transcribe: Urdu/Hindi poetry written in Bangla letters and English letters, with a Bangla meaning
- Summary, explanation, creator content pack and full translation
- TXT, SRT, VTT, DOCX and ZIP downloads

## Repository layout

| Folder | What it is |
| --- | --- |
| `web/` | The website (Astro on Cloudflare Workers): pages, sign-in, Gemini calls, history |
| `bridge/` | The Windows bridge app for each PC (folder watcher, audio cutting, upload) |

Setup and deployment are described in [`web/README.md`](web/README.md).
Pushing to `main` deploys automatically through `.github/workflows/deploy-cloudflare.yml`.
