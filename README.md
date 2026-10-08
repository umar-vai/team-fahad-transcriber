# Video/Audio Transcriber by Team Fahad

A Streamlit app for client-ready video/audio transcription using the Gemini API.

## Included features

- Audio and video upload
- Browser microphone voice-note recording with automatic transcription
- True live microphone transcription with Gemini Live + WebRTC
- Video-to-audio extraction
- Automatic language detection, including mixed-language speech
- Bangla, English, Arabic, and Hindi language hints
- Smart cleaned transcript mode
- Exact verbatim transcript mode
- Detailed speaker diarization + word timestamps
- SRT and VTT subtitle export
- Speaker/timestamp transcript
- Optional custom vocabulary for names and technical terms
- AI summary + key points
- Explain transcript in clear language
- Full translation to Bangla / English / Arabic / Hindi
- Creator content pack: titles, descriptions, hooks, tags, CTA, and chapters when timestamps are available
- TXT, SRT, VTT, DOCX, and complete ZIP downloads
- Google Sheet + Google Drive batch transcription page
- Server-side download of raw Drive videos (no manual PC download)
- Automatic 48 kbps mono audio compression before transcription
- Automatic splitting of long recordings into ~50 minute chunks
- Resume-safe batch status: PROCESSING / DONE / FAILED
- Full transcript storage in a dedicated `Transcripts` worksheet
- Automatic summary, duration, transcript link, processed time, and error columns
- Temporary local file cleanup
- Gemini Files API cleanup after processing
- Streamlit Secrets support so public users do not need their own API key
- Optional shared access code for private client previews

## Important mode limits

The single-file page follows the Gemini transcription API limits used by the current implementation:

- Standard transcription modes: about 60 minutes per request
- Speaker diarization / word timestamp mode: about 30 minutes per request
- Custom vocabulary cannot be combined with speaker diarization/timestamps
- Smart clean mode cannot be combined with speaker diarization/timestamps

The batch page automatically compresses audio and splits long recordings into roughly 50-minute chunks before transcription.

## 1. Local setup

Install Python 3.11 or 3.12, then open a terminal in this folder:

```bash
python -m pip install -r requirements.txt
```

Create:

```text
.streamlit/secrets.toml
```

Use `.streamlit/secrets.toml.example` as the template and add your Gemini API key.

Run:

```bash
python -m streamlit run app.py
```

On Windows you can also double-click `start_transcriber.vbs` after dependencies are installed.

## 2. Streamlit Community Cloud

1. Upload this folder to a GitHub repository.
2. Do **not** upload `.streamlit/secrets.toml`.
3. In Streamlit Community Cloud, create an app from the repo and use `app.py` as the main file.
4. Go to **App > Settings > Secrets**.
5. Add your Gemini key, for example:

```toml
GEMINI_API_KEY = "your-real-key"
```

Optional private preview:

```toml
APP_ACCESS_CODE = "your-access-code"
```

When `GEMINI_API_KEY` is present in Streamlit Secrets, visitors do not need to enter their own API key.

## 3. Google Sheet Batch Transcription

The Streamlit multipage sidebar now includes **Batch Transcription**. It is designed for project trackers where the `Raw Folder` column contains either a Drive filename or a direct Google Drive file link.

### One-time Google setup

1. Open Google Cloud Console and create/select a project.
2. Enable **Google Drive API** and **Google Sheets API**.
3. Create a **Service Account** and generate a JSON key.
4. Open the JSON key and copy its values into Streamlit Cloud → **App → Settings → Secrets** using the `[gcp_service_account]` template in `.streamlit/secrets.toml.example`.
5. Copy the service account `client_email` (it looks like `name@project.iam.gserviceaccount.com`).
6. Share the project-tracker Google Sheet with that email as **Editor**.
7. Share the Google Drive folder containing the raw videos with that email as **Viewer**.

The batch page itself displays the configured service-account email so it is easy to copy.

### Recommended settings for the tracker shown in the project workflow

- Header row: `3`
- First data row: `5`
- Source column: `Raw Folder`
- Row reference: `Row Ref`
- Transcript worksheet: `Transcripts`

The app automatically creates these output headers if they do not already exist:

- `Transcription Status`
- `Transcript`
- `AI Summary`
- `Media Duration`
- `Transcription Error`
- `Transcribed At`

### How a batch run works

For every queued row the app:

1. Finds the Drive video by direct link or filename.
2. Downloads it to temporary server storage only.
3. Extracts/compresses speech to mono MP3 at 16 kHz / 48 kbps.
4. Splits long audio into ~50 minute chunks.
5. Transcribes all chunks with Gemini and joins them.
6. Optionally generates summary + key points.
7. Stores the complete transcript in the `Transcripts` worksheet (split safely under Google Sheets' cell-size limit).
8. Writes a direct transcript link, summary, duration and timestamp back to the original row.
9. Marks the row `DONE` or `FAILED` with the actual error.
10. Deletes the temporary video/audio from the Streamlit server.

Press **Start / Resume batch** again at any time. Rows already marked `DONE` are skipped automatically, so an interrupted batch can continue safely.

For the first run, use 1–3 files to verify access and matching. Then increase `Max files this run` (default 25, maximum 100). Keep the browser tab open while the current batch is running.

## 4. Suggested first single-file test

Start with a 1-3 minute MP3 or MP4.

- Test **Smart clean transcript** first.
- Then test **Detailed subtitles + speakers** using a clip with two people speaking.
- Download SRT and import it into Premiere Pro, DaVinci Resolve, or CapCut.
- Generate the summary and creator content pack.

## Production note

This is a strong MVP/client-demo version. Before selling subscriptions at scale, add real authentication, a database, per-user usage metering, payment processing, and server-side rate limiting.

## Media links

The single-file transcriber also accepts a public media URL. It temporarily downloads the linked media, normalizes it to a Gemini-friendly MP3, runs the normal transcription pipeline, and removes the temporary files afterward.

Direct MP4/MP3/M4A links and many sites supported by yt-dlp can work. Private, login-only, or platform-protected media may require additional access and may not be downloadable from the hosted app.


## Live transcription

The **Live voice → Live Transcription** mode uses browser WebRTC microphone streaming and Gemini Live input-audio transcription. Audio is resampled to 16 kHz mono PCM on the server and the transcript updates while the user speaks.

A public STUN server is configured by default. On restrictive networks, add a TURN service in Streamlit Secrets:

```toml
LIVE_TURN_URL = "turn:your-turn-server.example.com:3478"
LIVE_TURN_USERNAME = "..."
LIVE_TURN_CREDENTIAL = "..."
```

Gemini API keys remain server-side; they are not exposed to the browser.


### Recommended TURN for Streamlit Cloud

For reliable WebRTC on Streamlit Community Cloud, configure Cloudflare Realtime TURN in Streamlit Secrets:

```toml
CLOUDFLARE_TURN_KEY_ID = "..."
CLOUDFLARE_TURN_KEY_API_TOKEN = "..."
```

The app also supports `LIVE_TURN_URL` / `LIVE_TURN_USERNAME` / `LIVE_TURN_CREDENTIAL`. Without a private TURN credential it uses STUN plus a best-effort public OpenRelay fallback for testing.
