# Team Fahad YouTube Downloader — Desktop App

A portable Windows desktop build of the local downloader. The app uses the PC's own internet connection and saves files to:

`Downloads/Team Fahad YouTube`

## Build locally

```powershell
py -3 -m venv .venv
.venv\Scripts\activate
pip install -r desktop_downloader\requirements.txt
pyinstaller --noconfirm --clean --onefile --windowed --name TeamFahadYouTubeDownloader --collect-all yt_dlp --collect-all imageio_ffmpeg desktop_downloader\app.py
```

The EXE will be created at:

`dist/TeamFahadYouTubeDownloader.exe`

## GitHub Actions build

The repository workflow `.github/workflows/build-desktop-downloader.yml` builds a portable Windows EXE automatically whenever the desktop app files change. Open the latest successful workflow run and download the `TeamFahadYouTubeDownloader-Windows` artifact.

No Python installation is required on the computer that runs the finished EXE.

Use the downloader only for content you own or have permission to download.
