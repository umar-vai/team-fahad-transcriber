from pathlib import Path

APP = Path('app.py')
s = APP.read_text(encoding='utf-8')

# Do not block a freshly completed OAuth session on an extra /v4/me preflight.
# The actual Frame.io API request will validate the token and surface a precise
# 401/403 error if the Adobe account cannot access Frame.io.
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

# Keep verification as a diagnostic helper, but don't clear a valid OAuth bundle
# just because the optional preflight endpoint failed transiently.
old_verify = '''    try:\n        response = requests.get(\n            "https://api.frame.io/v4/me",\n            headers={"Authorization": f"Bearer {token}"},\n            timeout=20,\n        )\n        if response.status_code == 200:\n            st.session_state["_frameio_verified_token"] = token_key\n            return True\n    except requests.RequestException:\n        return False\n    st.session_state.pop("frameio_oauth_tokens", None)\n    st.session_state.pop("_frameio_verified_token", None)\n    return False\n'''
new_verify = '''    try:\n        response = requests.get(\n            "https://api.frame.io/v4/me",\n            headers={"Authorization": f"Bearer {token}"},\n            timeout=20,\n        )\n        if response.status_code == 200:\n            st.session_state["_frameio_verified_token"] = token_key\n            return True\n        st.session_state["frameio_verify_error"] = (\n            f"Frame.io /v4/me returned HTTP {response.status_code}: {response.text[:300]}"\n        )\n    except requests.RequestException as exc:\n        st.session_state["frameio_verify_error"] = f"Frame.io verification request failed: {exc}"\n    return False\n'''
if old_verify in s:
    s = s.replace(old_verify, new_verify, 1)

APP.write_text(s, encoding='utf-8')
