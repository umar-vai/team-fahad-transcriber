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

## Teams and access

- **Admins** see every team and manage them on the **Admin** page. The admins are
  `umaar.ibn.sulaiman@gmail.com` and `teamfahad86@gmail.com`; set `ADMIN_EMAILS`
  (comma separated) in Cloudflare to change the list.
- An admin creates **teams** (our own teams such as Team Fahad or Sukun Life, or paying
  **customers**), switches each team's features (Bridge PCs, Google Drive automation) on or off,
  and adds members by Gmail address as **Manager** (can pair PCs, connect Drive, change settings)
  or **Viewer** (can only look).
- The **Automation** page only appears for admins and team members, and each team only sees its
  own PCs, Drive accounts, jobs and transcripts. Team transcripts are listed on the team's page and
  never mixed into anyone's personal **History**.
- Only the original team (Team Fahad) may use the shared team spreadsheet and Notion. Other teams
  use their own spreadsheet link (Admin page, or per Drive account).
- Migration `0010_workspaces.sql` moves everything that existed before into the team "Team Fahad".
  Apply it before deploying: `npx wrangler d1 migrations apply team-fahad-transcriber --remote`.

## Local development without Google

Put `DEV_LOGIN=1` in `web/.dev.vars` and run `npm run dev` in `web/`. The sign-in page then shows
a "Sign in without Google" form on `localhost` only, so layouts and permissions can be checked as
any email. It never works on the live site.
