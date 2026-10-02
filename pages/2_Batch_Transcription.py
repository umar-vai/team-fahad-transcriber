from pathlib import Path

import streamlit as st

st.session_state["_team_fahad_batch_page"] = True
app_path = Path(__file__).resolve().parents[1] / "app.py"
code = app_path.read_text(encoding="utf-8")
exec(compile(code, str(app_path), "exec"), {"__name__": "__main__", "__file__": str(app_path)})
