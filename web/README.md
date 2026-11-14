# Team Fahad Transcriber on Cloudflare

Live at **https://transcribe.abdullahfahad.com**

Everything runs on Cloudflare:

| Part | Where | What it does |
| --- | --- | --- |
| `web/` | Worker `team-fahad-transcriber` (Astro) | Pages, Google sign-in, Gemini calls, history API |
| D1 `team-fahad-transcriber` | Cloudflare D1 | Users, login sessions, transcription history |
| `media/` | Worker `team-fahad-transcriber-media` + Container | Downloads links (Drive, Facebook, Frame.io, other sites) and large files, converts with FFmpeg, splits into 5 minute parts |

The link download code lives in `media/container/link_tools.py`.

## How transcription works

- **Batch:** pick or drop many files and paste many links (one per line). They join a queue and run one after another, each with its own progress, retry and remove buttons. Finished items can be opened one by one or downloaded together as one ZIP.
- **Files:** the browser decodes the audio, splits it into ~5 minute parts at
  quiet points, and sends up to 4 parts to Gemini at the same time. Only small
  16 kHz audio is uploaded, not the whole video. Files the browser cannot read
  (or over 300 MB) go to the media container instead.
- **YouTube:** Gemini reads public YouTube videos directly, in parallel 5 minute
  clips. If that fails, the container downloads the video.
- **Other links:** the container downloads and splits the media, then the parts
  are transcribed in parallel.
- **Live voice:** the microphone audio is cut at each short pause (6 to 15
  seconds) and each piece is transcribed right away.
- The Worker asks Gemini which models the key can use, skips retired models and
  remembers the one that works. Model "thinking" is set to minimal for speed.

## One-time setup

### 1. Gemini API key (required)

```bash
cd web
npx wrangler secret put GEMINI_API_KEYS
```

Paste one key, or several separated by commas. Several keys spread the load and
take over when one hits its quota.

### 2. Google sign-in (required)

1. Open Google Cloud Console, APIs & Services, Credentials.
2. Create an **OAuth client ID** of type **Web application**.
3. Authorized redirect URI: `https://transcribe.abdullahfahad.com/auth/callback`
4. Save the client ID and secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

If the OAuth consent screen is in "Testing" mode, only listed test users can sign
in. Publish it to let anyone sign in.

### 3. Who can use the app (optional)

By default any Google account can sign in. To limit it, set `ALLOWED_EMAILS` in
`wrangler.jsonc`, for example `"a@gmail.com, b@gmail.com"` or `"@yourdomain.com"`.

### 4. Optional cookies for difficult links

For Facebook or YouTube links that need a signed-in session, set these secrets on
the **media** Worker (Netscape cookie file text):

```bash
cd media
npx wrangler secret put FACEBOOK_COOKIES
npx wrangler secret put YTDLP_COOKIES
```

## Deploying updates

Pushing to `main` runs `.github/workflows/deploy-cloudflare.yml`. Add these
GitHub repository secrets first:

- `CLOUDFLARE_API_TOKEN`: a token with Workers Scripts edit, D1 edit,
  Containers edit and Workers Routes edit permissions
- `CLOUDFLARE_ACCOUNT_ID`: `1fdb3252722874771d6dc733d7cd6cb4`

Manual deploy from a computer with Node 22 and Docker:

```bash
cd media && npm ci && npx wrangler deploy
cd ../web && npm ci && npx wrangler d1 migrations apply team-fahad-transcriber --remote && npm run deploy
```

`scripts/inline-assets.mjs` is only a fallback for networks where the static
asset upload is blocked; normal deploys do not need it.

## Local development

```bash
cd web
cp .dev.vars.example .dev.vars   # then add your keys
npx wrangler d1 migrations apply team-fahad-transcriber --local
npm run preview
```
