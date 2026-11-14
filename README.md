# Team Fahad Transcriber

Video and audio transcription with the Gemini API, running fully on Cloudflare at
**https://transcribe.abdullahfahad.com** with Google sign-in and per-user history.

## Features

- Upload many audio or video files, or paste many links (YouTube, Google Drive, Facebook, Frame.io and other sites)
- Live microphone transcription
- Output modes: Smart clean transcript, Subtitles + speakers (timed), Exact verbatim transcript
- Shayari transcribe: Urdu/Hindi poetry written in Bangla letters and English letters, with a Bangla meaning
- Summary, explanation, creator content pack and full translation
- TXT, SRT, VTT, DOCX and ZIP downloads

## Repository layout

| Folder | What it is |
| --- | --- |
| `web/` | The website (Astro on Cloudflare Workers): pages, sign-in, Gemini calls, history |
| `media/` | Media helper Worker + Container: downloads links and large files, converts and splits audio |

Setup and deployment are described in [`web/README.md`](web/README.md).
Pushing to `main` deploys automatically through `.github/workflows/deploy-cloudflare.yml`.
