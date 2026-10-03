# Team Fahad Local YouTube Downloader

This companion app runs on your own Windows PC instead of Streamlit Cloud. It is intended for public videos that you own or have permission to download.

## One-click Windows start

1. Download or clone this repository to your PC.
2. Double-click `Start_Local_YouTube_Downloader.bat` in the repository root.
3. On the first run, the launcher creates a private Python virtual environment and installs the required packages automatically.
4. The local app opens in your browser at `http://127.0.0.1:8765`.
5. Paste a YouTube URL, choose Audio or Video, choose quality, and download.

Files are saved automatically to:

`Downloads/Team Fahad YouTube`

## Requirements

- Windows 10/11
- Python 3.10+ installed and available in PATH
- Internet connection

No separate FFmpeg installation is required; the app uses the FFmpeg binary provided by `imageio-ffmpeg`.

## Notes

- Keep the launcher window open while using the local app.
- The tool does not bypass private, DRM-protected, login-only, members-only, or other access restrictions.
- If YouTube challenges the local connection, wait and retry later or use YouTube's own download/export option for content you own.
