from pathlib import Path

APP = Path("app.py")
REQ = Path("requirements.txt")
SECRETS = Path(".streamlit/secrets.toml.example")

s = APP.read_text(encoding="utf-8")

# Imports needed for signed OAuth state.
if "import base64\n" not in s:
    s = s.replace("import hashlib\n", "import base64\nimport hashlib\nimport hmac\nimport json\n", 1)

insert_anchor = "def frameio_share_ids(url: str) -> tuple[str, str] | None:\n"
if insert_anchor not in s:
    raise RuntimeError("Frame.io helper anchor not found")

if "def frameio_oauth_config" not in s:
    oauth_helpers = r'''def frameio_oauth_config() -> tuple[str, str, str] | None:
    client_id = str(secret_or_env("FRAMEIO_CLIENT_ID") or "").strip()
    client_secret = str(secret_or_env("FRAMEIO_CLIENT_SECRET") or "").strip()
    redirect_uri = str(secret_or_env("FRAMEIO_REDIRECT_URI") or "").strip()
    if not all((client_id, client_secret, redirect_uri)):
        return None
    return client_id, client_secret, redirect_uri


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def make_frameio_oauth_state(pending_url: str = "", return_to_batch: bool = False) -> str:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError("Frame.io OAuth credentials are not configured.")
    _, client_secret, _ = config
    payload = {
        "ts": int(time.time()),
        "nonce": _b64url_encode(os.urandom(18)),
        "pending_url": str(pending_url or "")[:1800],
        "batch": bool(return_to_batch),
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(client_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_b64url_encode(signature)}"


def parse_frameio_oauth_state(state: str) -> dict[str, Any]:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError("Frame.io OAuth credentials are not configured.")
    _, client_secret, _ = config
    try:
        encoded, supplied_signature = str(state).split(".", 1)
        expected = hmac.new(client_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        supplied = _b64url_decode(supplied_signature)
        if not hmac.compare_digest(expected, supplied):
            raise ValueError("OAuth state signature mismatch.")
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("Frame.io OAuth state validation failed.") from exc

    if int(time.time()) - int(payload.get("ts") or 0) > 15 * 60:
        raise RuntimeError("Frame.io authorization expired. Please connect again.")
    return payload


def frameio_authorization_url(pending_url: str = "", return_to_batch: bool = False) -> str:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError(
            "Frame.io OAuth is not configured. Add FRAMEIO_CLIENT_ID, FRAMEIO_CLIENT_SECRET, "
            "and FRAMEIO_REDIRECT_URI to Streamlit Secrets."
        )
    client_id, _, redirect_uri = config
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": "offline_access,openid,email,profile,additional_info.roles",
        "state": make_frameio_oauth_state(pending_url, return_to_batch),
        "response_type": "code",
    }
    return "https://ims-na1.adobelogin.com/ims/authorize/v2?" + urllib.parse.urlencode(params)


def exchange_frameio_authorization_code(code: str) -> dict[str, Any]:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError("Frame.io OAuth credentials are not configured.")
    client_id, client_secret, _ = config
    response = requests.post(
        "https://ims-na1.adobelogin.com/ims/token/v3",
        auth=(client_id, client_secret),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"code": code, "grant_type": "authorization_code"},
        timeout=30,
    )
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = response.text[:500]
        raise RuntimeError(f"Adobe could not exchange the Frame.io authorization code. {detail}") from exc
    data = response.json()
    access_token = str(data.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("Adobe returned no Frame.io access token.")
    expires_in = int(data.get("expires_in") or 3600)
    return {
        "access_token": access_token,
        "refresh_token": str(data.get("refresh_token") or "").strip(),
        "expires_at": time.time() + max(60, expires_in - 60),
    }


def refresh_frameio_access_token(refresh_token: str) -> dict[str, Any]:
    config = frameio_oauth_config()
    if not config:
        raise RuntimeError("Frame.io OAuth credentials are not configured.")
    client_id, client_secret, _ = config
    response = requests.post(
        "https://ims-na1.adobelogin.com/ims/token/v3",
        auth=(client_id, client_secret),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        timeout=30,
    )
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = response.text[:500]
        raise RuntimeError(f"Frame.io session refresh failed. {detail}") from exc
    data = response.json()
    access_token = str(data.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("Adobe returned no refreshed Frame.io access token.")
    expires_in = int(data.get("expires_in") or 3600)
    return {
        "access_token": access_token,
        "refresh_token": str(data.get("refresh_token") or refresh_token).strip(),
        "expires_at": time.time() + max(60, expires_in - 60),
    }


def get_frameio_access_token() -> str | None:
    # Backward-compatible fixed token support, if explicitly configured.
    fixed = str(secret_or_env("FRAMEIO_ACCESS_TOKEN") or "").strip()
    if fixed:
        return fixed

    bundle = st.session_state.get("frameio_oauth_tokens") or {}
    token = str(bundle.get("access_token") or "").strip()
    expires_at = float(bundle.get("expires_at") or 0)
    if token and time.time() < expires_at:
        return token

    refresh_token = str(bundle.get("refresh_token") or "").strip()
    if refresh_token:
        refreshed = refresh_frameio_access_token(refresh_token)
        st.session_state["frameio_oauth_tokens"] = refreshed
        return str(refreshed["access_token"])
    return None


def handle_frameio_oauth_callback() -> None:
    if not frameio_oauth_config():
        return

    error = str(st.query_params.get("error", "") or "").strip()
    if error:
        description = str(st.query_params.get("error_description", "") or error)
        st.query_params.clear()
        st.error(f"Frame.io authorization failed: {description}")
        return

    code = str(st.query_params.get("code", "") or "").strip()
    state = str(st.query_params.get("state", "") or "").strip()
    if not code:
        return
    if not state:
        st.query_params.clear()
        st.error("Frame.io authorization returned without a valid state value.")
        return

    try:
        payload = parse_frameio_oauth_state(state)
        st.session_state["frameio_oauth_tokens"] = exchange_frameio_authorization_code(code)
        pending_url = str(payload.get("pending_url") or "").strip()
        return_to_batch = bool(payload.get("batch"))
        if pending_url:
            if return_to_batch:
                init_bulk_url_state()
                first_row = st.session_state["bulk_url_rows"][0]
                st.session_state[f"bulk_url_{first_row}"] = pending_url
            else:
                st.session_state["single_media_link"] = pending_url
        st.query_params.clear()
        st.session_state["frameio_connected_notice"] = True
        if return_to_batch:
            st.switch_page("pages/2_Batch_Transcription.py")
        st.rerun()
    except Exception as exc:
        st.query_params.clear()
        st.error(str(exc))


'''
    s = s.replace(insert_anchor, oauth_helpers + insert_anchor, 1)

# Replace fixed-token requirement with OAuth-aware token retrieval.
old_token = '''    token = str(secret_or_env("FRAMEIO_ACCESS_TOKEN") or "").strip()
    if not token:
        raise RuntimeError(
            "Frame.io links need a Frame.io API access token. Add FRAMEIO_ACCESS_TOKEN to "
            "Streamlit Secrets, then reboot the app. The normal browser share link itself is "
            "not a direct downloadable media URL."
        )
'''
new_token = '''    token = get_frameio_access_token()
    if not token:
        raise RuntimeError(
            "Frame.io is not connected. Use the Connect Frame.io button in the app, authorize Adobe, "
            "then retry this link."
        )
'''
if old_token in s:
    s = s.replace(old_token, new_token, 1)
elif new_token not in s:
    raise RuntimeError("Could not locate Frame.io token block")

# Process OAuth callback immediately after page config, before widgets are created.
page_anchor = 'st.set_page_config(page_title=PAGE_TITLE, page_icon="🎙️", layout="wide")\n\n'
callback_block = 'st.set_page_config(page_title=PAGE_TITLE, page_icon="🎙️", layout="wide")\n\nhandle_frameio_oauth_callback()\n\n'
if callback_block not in s:
    if page_anchor not in s:
        raise RuntimeError("Page config anchor not found")
    s = s.replace(page_anchor, callback_block, 1)

# Add sidebar Frame.io connection status.
sidebar_anchor = '''    st.caption(
        f"API failover: {len(transcription_api_keys)} transcription slot(s) · "
        f"{len(content_api_keys)} AI-tool slot(s). HTTP 429 automatically moves to the next available slot."
    )

'''
sidebar_insert = sidebar_anchor + '''    if frameio_oauth_config():
        frameio_token = get_frameio_access_token()
        if frameio_token:
            st.success("Frame.io connected")
        else:
            try:
                st.link_button(
                    "Connect Frame.io",
                    frameio_authorization_url(return_to_batch=batch_page_mode),
                    use_container_width=True,
                )
            except Exception as exc:
                st.caption(f"Frame.io OAuth: {exc}")

'''
if 'st.success("Frame.io connected")' not in s:
    if sidebar_anchor not in s:
        raise RuntimeError("Sidebar anchor not found")
    s = s.replace(sidebar_anchor, sidebar_insert, 1)

# In single-link mode, show a URL-preserving connect button for Frame.io links.
single_anchor = '''    if single_media_link.strip():
        c1, c2 = st.columns([0.72, 0.28])
'''
single_replacement = '''    if single_media_link.strip():
        if frameio_share_ids(single_media_link) and not get_frameio_access_token():
            if frameio_oauth_config():
                st.warning("Connect Frame.io once so this private share link can be resolved securely.")
                st.link_button(
                    "Connect Frame.io & return to this link",
                    frameio_authorization_url(pending_url=single_media_link, return_to_batch=False),
                    type="primary",
                    use_container_width=True,
                )
            else:
                st.error(
                    "Frame.io OAuth credentials are missing. Add FRAMEIO_CLIENT_ID, "
                    "FRAMEIO_CLIENT_SECRET and FRAMEIO_REDIRECT_URI to Streamlit Secrets."
                )
        c1, c2 = st.columns([0.72, 0.28])
'''
if 'Connect Frame.io & return to this link' not in s:
    if single_anchor not in s:
        raise RuntimeError("Single-link UI anchor not found")
    s = s.replace(single_anchor, single_replacement, 1)

# Add a one-time success message.
hero_anchor = 'transcription_api_keys = load_api_key_pool("TRANSCRIBE")\n'
notice = '''if st.session_state.pop("frameio_connected_notice", False):
    st.success("Frame.io connected successfully. You can now transcribe Frame.io share links.")

'''
if notice not in s:
    if hero_anchor not in s:
        raise RuntimeError("API-key anchor not found")
    s = s.replace(hero_anchor, notice + hero_anchor, 1)

APP.write_text(s, encoding="utf-8")

req = REQ.read_text(encoding="utf-8")
if "requests>=" not in req:
    req += "requests>=2.31,<3.0\n"
    REQ.write_text(req, encoding="utf-8")

sec = SECRETS.read_text(encoding="utf-8")
if "FRAMEIO_CLIENT_ID" not in sec:
    sec += '''\n# Frame.io / Adobe OAuth Web App credentials.\n# FRAMEIO_CLIENT_ID = "your-adobe-client-id"\n# FRAMEIO_CLIENT_SECRET = "your-adobe-client-secret"\n# FRAMEIO_REDIRECT_URI = "https://your-app.streamlit.app/"\n'''
    SECRETS.write_text(sec, encoding="utf-8")
