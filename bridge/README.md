# Team Fahad Bridge

A small Windows program for each PC. It watches one folder; every new audio file is transcribed
through https://transcribe.abdullahfahad.com and added, with its date, to that PC's tab in the team Google Sheet.

## How it works

1. **Watches the folder** (subfolders too). A file is taken only after it has stopped changing for 8 seconds, so a file still being copied is never half-read.
2. **Prepares the audio on the PC**: ffmpeg decodes any audio or video file to 16 kHz mono, the audio is cut into pieces of about 5 minutes at the quietest moment near each boundary (same as the website), and each piece is compressed to MP3 (about 2 MB per 5 minutes).
3. **Sends the pieces** to `/api/bridge/piece`. The website sends them to Gemini and returns the text. **The Gemini key stays on the server and the audio is never stored.**
4. **Finishes** with `/api/bridge/complete`: the website merges the pieces, saves the transcript to History and appends a row to the PC's own tab (a Date column in front, the same columns as the nightly automation).
5. **No internet or busy Gemini:** the file waits on the PC and is sent later, nothing is lost. Every file has a fingerprint (size plus the first and last megabyte), so the website never does the same recording twice, even if it is renamed or the bridge is reinstalled.
6. **A file that cannot work** (no audio, corrupt) is added to the sheet as a *Failed* row with the reason. If it works later, that row is replaced.

Security: each PC has its own secret token (shown once while pairing, stored on the website only as a hash). Remove a PC on the **Auto** page and its token stops working at once. The setup page only listens on `127.0.0.1` and refuses requests from other websites.

## Install on a PC (about 2 minutes)

One file: **`TeamFahadBridge-Setup.exe`** (about 70 MB, Node and ffmpeg are inside, nothing else to install).
Download it from the [bridge-latest release](https://github.com/umar-vai/team-fahad-transcriber/releases/tag/bridge-latest) and send it to whoever sets up the office PCs (Telegram, USB, anything). Do not use GitHub's *Download ZIP* of the source code.

For each PC:

1. On the website open **Auto**, type the PC's name (for example `PC-03`) and press **Get pairing code**.
2. On that PC double-click **TeamFahadBridge-Setup.exe**, press Next, Install, Finish. No administrator password is needed.
3. The **Team Fahad Bridge** window opens: type the code, press *Connect*, choose the folder, press *Save*.

Windows may show **"Windows protected your PC"** the first time, because the file is not code-signed (signing certificates cost money). Press **More info**, then **Run anyway**. Telegram may also say the file is unknown: that is the same reason.

What you get: a **Team Fahad Bridge** icon on the desktop and in the Start menu (opens the status window), and the bridge starts by itself, hidden, every time Windows signs in. Closing the window does not stop it. By default only files that arrive **after** setup are transcribed; tick "also transcribe the files already in the folder" to include the old ones.

- **Silent install for many PCs:** `TeamFahadBridge-Setup.exe /SILENT` (add `/DIR="D:\Bridge"` to choose the folder).
- **Update:** run the newer Setup.exe over the old one. Settings are kept.
- **Remove:** Windows Settings, Apps, *Team Fahad Bridge*, Uninstall.
- Files: program in `%LOCALAPPDATA%\Programs\TeamFahadBridge`; settings, list of finished files and log in `%APPDATA%\TeamFahadBridge`.

## Development

```bash
cd bridge
npm test        # needs ffmpeg on PATH; uses a fake website, no network
```

No npm dependencies: only Node 22 built-ins. `FFMPEG_PATH`, `BRIDGE_DATA_DIR` and `BRIDGE_PORT` can override the defaults.
The installer is built by `.github/workflows/bridge-windows.yml` with Inno Setup (`bridge/windows/TeamFahadBridge.iss`). The workflow also installs it silently on a Windows runner, checks that the app answers and uninstalls it, so a broken installer fails the build.

Server side: `web/src/lib/bridge.ts`, `web/src/pages/api/bridge/*`, migration `web/migrations/0006_bridge.sql`.
