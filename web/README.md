# Team Fahad Transcriber on Cloudflare

Live at **https://transcribe.abdullahfahad.com**

Everything runs on Cloudflare:

| Part | Where | What it does |
| --- | --- | --- |
| `web/` | Worker `team-fahad-transcriber` (Astro) | Pages, Google sign-in, Gemini calls, history API |
| D1 `team-fahad-transcriber` | Cloudflare D1 | Users, login sessions, transcription history, one summary row per Drive folder |
| Durable Object `BatchRunner` | inside the web Worker | Runs Google Drive folder batches in the background and keeps their live progress |

There is **no container** any more. It cost too much (Memory billing), so it was removed. Link downloads (Facebook, Frame.io, other sites) and very large uploads no longer work; use the Colab notebook for those.

## How transcription works

- **Batch:** pick or drop many files and paste many links (one per line). They join a queue and run one after another, each with its own progress, retry and remove buttons. Finished items can be opened one by one or downloaded together as one ZIP.
- **Files:** the browser decodes the audio, splits it into ~5 minute parts at
  quiet points, and sends up to 4 parts to Gemini at the same time. Only small
  16 kHz audio is uploaded, not the whole file.
- **YouTube:** Gemini reads public YouTube videos directly, in parallel 5 minute clips.
- **Google Drive folder:** paste a public folder link and pick Smart clean or
  Subtitles (timed). The server lists every **MP3 and WAV** file (subfolders
  too, sorted by name so "2" comes before "10") and works through them one by
  one in a `BatchRunner` Durable Object, so the browser can be closed. Each file
  is cut into pieces of about 5 minutes (or at most 10 MB) by reading byte ranges
  straight from Drive (`src/lib/drivefetch.ts`, `src/lib/audiosplit.ts`), with no
  FFmpeg and no container, and every piece is sent to Gemini. Each finished file
  is saved to History, gets a row in the folder's Notion table and a row in the
  folder's Google Sheets tab. Failed files are listed as "Failed"; "Retry failed"
  replaces those rows when they succeed. Other formats (mp4, m4a ...) are skipped.
  Progress is shown on the **Folders** page.
- **Low Cloudflare usage:** live progress is stored in the Durable Object, not in
  D1. D1 gets one row per folder (written at start and end) and one history row
  per video. The progress page only polls while it is open and visible.
- **Live voice:** the microphone audio is cut at each short pause (6 to 15
  seconds) and each piece is transcribed right away.
- The Worker asks Gemini which models the key can use, skips retired models and
  remembers the one that works. Model "thinking" is set to minimal for speed.

## Nightly automation for Drive "Computers" (Auto page)

For teams whose PCs sync recordings to Google Drive with Drive for desktop. Every night at **11:50 PM Bangladesh time**
the new media files of every computer folder are transcribed and added to Notion and Google Sheets, one page and
one tab per computer, with a Date column. A new computer folder gets its own page and tab by itself.

- **Cron** (UTC, in `wrangler.jsonc`): `50 17 * * *` queues the day's files; `*/5 * * * *` starts queued jobs
  (3 computers at a time, so a free slot is used within 5 minutes) and retries failed videos up to 3 times.
- Files modified since the start of yesterday are checked, so a file that finished syncing after 23:50 is caught the
  next night. A file is never transcribed twice (`drive_files` table).
- **Connect once:** open the **Auto** page and press **Connect Drive** with the Google account that owns the Drive.
  It asks for read-only Drive access and stores an offline refresh token. No new redirect URI is needed (the same
  `/auth/callback` is used). The Drive API must be enabled in the same Google Cloud project, and the OAuth consent
  screen must be **published**: in "Testing" mode Google expires the refresh token after 7 days.
- **Notion is off by default** (Notion's free plan runs out of blocks quickly); everything goes to Google Sheets. Turn on
  "Also save to Notion" on the Auto page to add Notion pages for videos transcribed from then on.
- Press **Check computers in Drive** to see which folders were found. Drive's API has no "Computers" listing, so
  computers are detected as folders owned by the account with no parent. If none show up, set the variable
  `DRIVE_COMPUTER_FOLDER_IDS` (comma separated folder ids).
- Press **Run the nightly scan now** to test without waiting for 23:50.
- D1 migrations are applied by the deploy workflow on every push to `main`.

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

### 4. Notion (for Drive folders)

1. Open https://www.notion.so/profile/integrations, create an **Internal** integration
   for the team workspace and copy its secret.
2. Create a page, for example "Team Fahad Transcripts". Open its `...` menu,
   **Connections**, and add the integration.
3. Save both:

```bash
cd web
npx wrangler secret put NOTION_TOKEN            # the integration secret
npx wrangler secret put NOTION_PARENT_PAGE_ID   # the page link
```

Every folder becomes a page under it with a "Transcripts" table: No., Title,
Duration, Status, Style, Words and Drive file. Open a row to read the transcript.

### 5. Google Sheets (for Drive folders)

1. In Google Cloud Console, enable the **Google Sheets API** and the **Google Drive API**.
2. Create a **service account** (IAM & Admin, Service accounts), open it, Keys,
   Add key, JSON. A key file downloads.
3. Share the team spreadsheet with the service account's email (`...@...iam.gserviceaccount.com`) as **Editor**.
4. Save both:

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste the whole key file
npx wrangler secret put SHEETS_SPREADSHEET_ID         # the spreadsheet link
```

Every folder becomes a new tab at the bottom of the spreadsheet. The same service
account also lists Drive folders through the Drive API, which has no file limit.
Without it, folders are read from Drive's public folder page.
`GOOGLE_DRIVE_API_KEY` (an API key with the Drive API enabled) is an optional extra way.

## Deploying updates

Pushing to `main` runs `.github/workflows/deploy-cloudflare.yml`. Add these
GitHub repository secrets first:

- `CLOUDFLARE_API_TOKEN`: a token with Workers Scripts edit, D1 edit,
  and Workers Routes edit permissions
- `CLOUDFLARE_ACCOUNT_ID`: `1fdb3252722874771d6dc733d7cd6cb4`

Manual deploy from a computer with Node 22:

```bash
cd web && npm ci && npx wrangler d1 migrations apply team-fahad-transcriber --remote && npm run deploy
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
