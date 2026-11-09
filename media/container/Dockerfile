# syntax=docker/dockerfile:1
# Build context is the repository root, so app.py can be shared with the container.
# The Playwright image already has Chromium and its system libraries.
FROM mcr.microsoft.com/playwright/python:v1.58.0-noble

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PIP_BREAK_SYSTEM_PACKAGES=1

COPY media/container/requirements.txt /app/requirements.txt
# An optional "ca" build secret is only used when building behind a TLS proxy.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install -r /app/requirements.txt \
    && ln -sf "$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" /usr/local/bin/ffmpeg \
    && ffmpeg -hide_banner -version | head -1

COPY app.py /app/app.py
COPY media/container/stub /app/stub
COPY media/container/server.py /app/server.py

EXPOSE 8080
CMD ["python", "/app/server.py"]
