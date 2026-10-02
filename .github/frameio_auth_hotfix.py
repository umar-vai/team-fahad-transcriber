# Trigger hotfix workflow.
from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

old = '''def get_frameio_access_token() -> str | None:\n    # Backward-compatible fixed token support, if explicitly configured.\n    fixed = str(secret_or_env("FRAMEIO_ACCESS_TOKEN") or "").strip()\n    if fixed:\n        return fixed\n\n    bundle = st.session_state.get("frameio_oauth_tokens") or {}\n'''
new = '''def get_frameio_access_token() -> str | None:\n    # OAuth Web App is the source of truth; do not silently use an old manual token.\n    bundle = st.session_state.get("frameio_oauth_tokens") or {}\n'''
if old in s:
    s = s.replace(old, new, 1)

anchor = 'def handle_frameio_oauth_callback() -> None:\n'
if 'def verify_frameio_connection()' not in s:
    helper = '''def verify_frameio_connection() -> bool:\n    token = get_frameio_access_token()\n    if not token:\n        return False\n    token_key = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]\n    if st.session_state.get("_frameio_verified_token") == token_key:\n        return True\n    try:\n        response = requests.get(\n            "https://api.frame.io/v4/me",\n            headers={"Authorization": f"Bearer {token}"},\n            timeout=20,\n        )\n        if response.status_code == 200:\n            st.session_state["_frameio_verified_token"] = token_key\n            return True\n    except requests.RequestException:\n        return False\n    st.session_state.pop("frameio_oauth_tokens", None)\n    st.session_state.pop("_frameio_verified_token", None)\n    return False\n\n\n'''
    if anchor not in s:
        raise RuntimeError('callback anchor missing')
    s = s.replace(anchor, helper + anchor, 1)

s = s.replace(
'''    except requests.RequestException as exc:\n        raise RuntimeError(\n            "Could not authenticate with Frame.io. Check FRAMEIO_ACCESS_TOKEN in Streamlit Secrets."\n        ) from exc\n''',
'''    except requests.RequestException as exc:\n        st.session_state.pop("frameio_oauth_tokens", None)\n        st.session_state.pop("_frameio_verified_token", None)\n        raise RuntimeError(\n            "Frame.io authentication failed. Reconnect Frame.io from the app and try again."\n        ) from exc\n''',
1)

s = s.replace(
'''        accounts_response.raise_for_status()\n        accounts = accounts_response.json().get("data", [])\n''',
'''        if accounts_response.status_code in {401, 403}:\n            st.session_state.pop("frameio_oauth_tokens", None)\n            st.session_state.pop("_frameio_verified_token", None)\n            raise RuntimeError(\n                "Frame.io authorization is not valid for this account. Connect Frame.io again, "\n                "sign in with the Adobe account that can access this asset, then retry."\n            )\n        accounts_response.raise_for_status()\n        accounts = accounts_response.json().get("data", [])\n''',
1)

s = s.replace(
'''        frameio_token = get_frameio_access_token()\n        if frameio_token:\n            st.success("Frame.io connected")\n        else:\n''',
'''        frameio_ready = verify_frameio_connection()\n        if frameio_ready:\n            st.success("Frame.io connected")\n        else:\n''',
1)

s = s.replace(
'''        if frameio_share_ids(single_media_link) and not get_frameio_access_token():\n            if frameio_oauth_config():\n                st.warning("Connect Frame.io once so this private share link can be resolved securely.")\n                st.link_button(\n                    "Connect Frame.io & return to this link",\n                    frameio_authorization_url(pending_url=single_media_link, return_to_batch=False),\n                    type="primary",\n                    use_container_width=True,\n                )\n            else:\n                st.error(\n                    "Frame.io OAuth credentials are missing. Add FRAMEIO_CLIENT_ID, "\n                    "FRAMEIO_CLIENT_SECRET and FRAMEIO_REDIRECT_URI to Streamlit Secrets."\n                )\n        c1, c2 = st.columns([0.72, 0.28])\n''',
'''        is_frameio_link = bool(frameio_share_ids(single_media_link))\n        frameio_ready_for_link = (not is_frameio_link) or verify_frameio_connection()\n        if is_frameio_link and not frameio_ready_for_link:\n            if frameio_oauth_config():\n                st.warning("This is a Frame.io share link. Connect your Adobe/Frame.io account before transcribing it.")\n                st.link_button(\n                    "Connect Frame.io & return to this link",\n                    frameio_authorization_url(pending_url=single_media_link, return_to_batch=False),\n                    type="primary",\n                    use_container_width=True,\n                )\n            else:\n                st.error(\n                    "Frame.io OAuth credentials are missing. Add FRAMEIO_CLIENT_ID, "\n                    "FRAMEIO_CLIENT_SECRET and FRAMEIO_REDIRECT_URI to Streamlit Secrets."\n                )\n        c1, c2 = st.columns([0.72, 0.28])\n''',
1)

pos = s.find('key="transcribe_single_link"')
if pos != -1:
    before = s[:pos]
    idx = before.rfind('disabled=not bool(transcription_api_keys)')
    if idx != -1 and pos - idx < 300:
        end = s.find('key="transcribe_single_link"', idx) + len('key="transcribe_single_link",\n')
        block = s[idx:end]
        block = block.replace('disabled=not bool(transcription_api_keys),', 'disabled=(not bool(transcription_api_keys)) or (bool(frameio_share_ids(single_media_link)) and not verify_frameio_connection()),', 1)
        s = s[:idx] + block + s[end:]

APP.write_text(s, encoding='utf-8')
