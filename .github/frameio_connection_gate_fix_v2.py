from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

# Treat an OAuth token returned by Adobe as connected. Do not block the UI on
# an extra /v4/me preflight; the real Frame.io API call remains authoritative.
s = s.replace(
'''        frameio_ready = verify_frameio_connection()\n        if frameio_ready:\n            st.success("Frame.io connected")\n        else:\n''',
'''        frameio_ready = bool(get_frameio_access_token())\n        if frameio_ready:\n            st.success("Frame.io connected")\n        else:\n''',
1)

s = s.replace(
'''        is_frameio_link = bool(frameio_share_ids(single_media_link))\n        frameio_ready_for_link = (not is_frameio_link) or verify_frameio_connection()\n''',
'''        is_frameio_link = bool(frameio_share_ids(single_media_link))\n        frameio_ready_for_link = (not is_frameio_link) or bool(get_frameio_access_token())\n''',
1)

s = s.replace(
'''            disabled=(not bool(transcription_api_keys)) or (bool(frameio_share_ids(single_media_link)) and not verify_frameio_connection()),\n''',
'''            disabled=(not bool(transcription_api_keys)) or (bool(frameio_share_ids(single_media_link)) and not bool(get_frameio_access_token())),\n''',
1)

# Preserve any optional verification failure as diagnostic information instead
# of clearing the OAuth session immediately.
old_verify_tail = '''    try:\n        response = requests.get(\n            "https://api.frame.io/v4/me",\n            headers={"Authorization": f"Bearer {token}"},\n            timeout=20,\n        )\n        if response.status_code == 200:\n            st.session_state["_frameio_verified_token"] = token_key\n            return True\n    except requests.RequestException:\n        return False\n    st.session_state.pop("frameio_oauth_tokens", None)\n    st.session_state.pop("_frameio_verified_token", None)\n    return False\n'''
new_verify_tail = '''    try:\n        response = requests.get(\n            "https://api.frame.io/v4/me",\n            headers={"Authorization": f"Bearer {token}"},\n            timeout=20,\n        )\n        if response.status_code == 200:\n            st.session_state["_frameio_verified_token"] = token_key\n            return True\n        st.session_state["frameio_verify_error"] = (\n            f"Frame.io /v4/me returned HTTP {response.status_code}: {response.text[:300]}"\n        )\n    except requests.RequestException as exc:\n        st.session_state["frameio_verify_error"] = f"Frame.io verification request failed: {exc}"\n    return False\n'''
if old_verify_tail in s:
    s = s.replace(old_verify_tail, new_verify_tail, 1)

APP.write_text(s, encoding='utf-8')
