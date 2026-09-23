# Video/Audio Transcriber by Team Fahad

A Streamlit app for client-ready video/audio transcription using the Gemini API.

## Included features

- Audio and video upload
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
- Full translation to Bangla / English / Arabic / Hindi
- Creator content pack: titles, descriptions, hooks, tags, CTA, and chapters when timestamps are available
- TXT, SRT, VTT, DOCX, and complete ZIP downloads
- Temporary local file cleanup
- Gemini Files API cleanup after processing
- Streamlit Secrets support so public users do not need their own API key
- Optional shared access code for private client previews

## Important mode limits

The app follows the Gemini transcription API limits used by the current implementation:

- Standard transcription modes: about 60 minutes per request
- Speaker diarization / word timestamp mode: about 30 minutes per request
- Custom vocabulary cannot be combined with speaker diarization/timestamps
- Smart clean mode cannot be combined with speaker diarization/timestamps

For longer media, split the file into smaller parts.

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
5. Add:

```toml
GEMINI_API_KEY = "your-real-key"
```

Optional private preview:

```toml
APP_ACCESS_CODE = "your-access-code"
```

When `GEMINI_API_KEY` is present in Streamlit Secrets, visitors do not need to enter their own API key.

## 3. Suggested first test

Start with a 1-3 minute MP3 or MP4.

- Test **Smart clean transcript** first.
- Then test **Detailed subtitles + speakers** using a clip with two people speaking.
- Download SRT and import it into Premiere Pro, DaVinci Resolve, or CapCut.
- Generate the summary and creator content pack.

## Production note

This is a strong MVP/client-demo version. Before selling subscriptions at scale, add real authentication, a database, per-user usage metering, payment processing, and server-side rate limiting.
