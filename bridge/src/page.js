/** The local page (Bangla). One file, no external resources. */
export const PAGE = String.raw`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TEAMCRIBER Bridge</title>
<style>
  :root { --bg:#f6f6fb; --card:#fff; --ink:#1d2033; --muted:#6b6f85; --line:#e3e4ee; --main:#4a43d8; --good:#0d8c59; --warn:#b36b00; --bad:#c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14151f; --card:#1d1f2e; --ink:#eceef8; --muted:#9a9db5; --line:#2f3248; --main:#8b86ff; --good:#3ecf8e; --warn:#f0b04a; --bad:#ff6b6b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 "Segoe UI","Nirmala UI",system-ui,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:14px; }
  .muted { color:var(--muted); font-size:14px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:99px; font-size:13px; font-weight:600; border:1px solid currentColor; }
  .good { color:var(--good); } .warn { color:var(--warn); } .bad { color:var(--bad); } .work { color:var(--main); }
  input[type=text] { width:100%; padding:10px 12px; font-size:16px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; }
  button { font:inherit; font-weight:600; padding:9px 16px; border-radius:8px; border:1px solid var(--main); background:var(--main); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--main); }
  select { flex:1 1 240px; padding:10px 12px; font-size:16px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:inherit; }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px; }
  .row > input { flex:1 1 240px; width:auto; }
  .big { font-size:30px; font-weight:700; }
  pre { margin:0; font:12px/1.5 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-word; max-height:240px; overflow:auto; color:var(--muted); }
  .conn { display:flex; gap:12px; align-items:center; padding:12px 16px; }
  .dot { width:14px; height:14px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.good { background:var(--good); box-shadow:0 0 0 4px color-mix(in srgb, var(--good) 25%, transparent); }
  .dot.bad { background:var(--bad); }
  .dot.warn { background:var(--warn); }
  .err { color:var(--bad); margin-top:8px; font-size:14px; }
</style>
</head>
<body>
<main>
  <h1>TEAMCRIBER Bridge</h1>
  <div class="muted" id="sub">লোড হচ্ছে…</div>
  <div class="card conn" id="conn" hidden><span class="dot" id="dot"></span><div><b id="connTitle"></b><div class="muted" id="connSub"></div></div></div>

  <div class="card" id="updateCard" hidden>
    <b id="updTitle"></b>
    <div class="muted" id="updSub"></div>
    <div class="row"><button id="updBtn" hidden></button></div>
  </div>

  <div class="card" id="pairCard" hidden>
    <h2>ধাপ ১: এই পিসি যুক্ত করুন</h2>
    <div class="row" style="margin-top:0">
      <button id="tabLink">আগের পিসির সাথে</button>
      <button class="ghost" id="tabNew">নতুন পিসি</button>
      <button class="ghost" id="tabGoogle">Google লগইন</button>
    </div>

    <div id="linkBox">
      <p class="muted">আগে থেকে ওয়েবসাইটে থাকা কোনো পিসির (যেমন মাহবুব, হাসান) জায়গায় এই কম্পিউটারকে বসান। ওই পিসির শিট ট্যাবেই নতুন ট্রান্সক্রাইব যাবে। <b>একটা নামে একটাই কম্পিউটার চালু থাকে:</b> আগের কম্পিউটারটি বন্ধ হয়ে যাবে। ওয়েবসাইটের <b>Auto</b> পেজে ঠিক করা টিম পিনটি লিখুন।</p>
      <div class="row"><input type="text" id="pin" placeholder="টিম পিন" maxlength="40" autocomplete="off"><button id="listBtn">তালিকা দেখান</button></div>
      <div id="pickBox" hidden>
        <div class="muted" style="margin-top:12px">এই কম্পিউটার কোনটি হবে?</div>
        <div class="row"><select id="pick"></select><button id="linkBtn">যুক্ত করুন</button></div>
      </div>
      <div class="err" id="linkErr"></div>
    </div>

    <div id="googleBox" hidden>
      <p class="muted">নিজের Google অ্যাকাউন্ট দিয়ে যুক্ত করলে ট্রান্সক্রাইবগুলো ওয়েবসাইটে <b>আপনার নিজের অ্যাকাউন্টের History-তে</b> জমা হবে, টিমের শিটে নয়। ব্রাউজারে ওয়েবসাইট খুলবে, সেখানে সাইন ইন করে "Allow this computer" চাপুন।</p>
      <div class="row"><button id="googleBtn">Google দিয়ে যুক্ত করুন</button></div>
      <div id="googleWait" class="muted" style="margin-top:10px" hidden>ব্রাউজারে এই কোডটি মিলিয়ে অনুমতি দিন: <b id="googleCode" style="font-size:20px;letter-spacing:.1em"></b><br>ব্রাউজার না খুললে এই ঠিকানা খুলুন: <span id="googleLink"></span></div>
      <div class="err" id="googleErr"></div>
    </div>

    <div id="newBox" hidden>
      <p class="muted">ওয়েবসাইটের <b>Auto</b> পেজে পিসির নাম লিখে <b>Get pairing code</b> চাপুন। যে কোডটি আসবে সেটি এখানে লিখুন।</p>
      <div class="row"><input type="text" id="code" placeholder="ABCD-EFGH" maxlength="12" autocomplete="off"><button id="pairBtn">যুক্ত করুন</button></div>
      <div class="err" id="pairErr"></div>
    </div>
  </div>

  <div class="card" id="prefsCard" hidden>
    <h2>সেটিংস</h2>
    <div id="teamPrefs" hidden>
      <label class="row" style="gap:8px;margin-top:0"><input type="checkbox" id="sheetOn"> ট্রান্সক্রাইব টিমের Google স্প্রেডশিটেও যোগ করুন</label>
      <div class="muted">বন্ধ করলে ট্রান্সক্রাইব শুধু History-তে যাবে। আগের ফাইল শিটে পরে যোগ হয় না।</div>
    </div>
    <div id="personalPrefs" hidden>
      <div class="muted">অ্যাকাউন্ট: <b id="acct"></b> (ট্রান্সক্রাইব এই অ্যাকাউন্টের History-তে যাচ্ছে)</div>
      <div class="row"><select id="modeSel"></select><select id="langSel"></select></div>
    </div>
    <div class="row"><button class="ghost" id="resetBtn">এই পিসি আলাদা করুন (রিসেট)</button></div>
    <div class="muted">রিসেট করলে এই পিসি আবার "যুক্ত করুন" পর্দায় ফিরবে, তখন অন্য পিসি বা অন্য অ্যাকাউন্টে যুক্ত করা যাবে। ফোল্ডার ও শেষ হওয়া ফাইলের তালিকা থাকবে।</div>
    <div class="err" id="prefsErr"></div>
  </div>

  <div class="card" id="folderCard" hidden>
    <h2>ধাপ ২: কোন ফোল্ডার দেখবে?</h2>
    <p class="muted" style="margin-top:0">এই ফোল্ডারে (ভেতরের ফোল্ডারসহ) নতুন কোনো অডিও আসলেই ট্রান্সক্রাইব হয়ে শিটে যাবে।</p>
    <div class="row"><input type="text" id="folder" placeholder="D:\Recordings"><button class="ghost" id="browseBtn">বেছে নিন…</button></div>
    <label class="row" style="gap:8px"><input type="checkbox" id="existing"> ফোল্ডারে আগে থেকে থাকা ফাইলগুলোও ট্রান্সক্রাইব করুন</label>
    <div class="row"><button id="folderBtn">সেভ করুন</button></div>
    <div class="err" id="folderErr"></div>
  </div>

  <div class="card" id="statusCard" hidden>
    <h2 id="phase"></h2>
    <div class="muted" id="detail"></div>
    <div class="row" style="gap:28px;margin-top:14px">
      <div><div class="big" id="doneCount">0</div><div class="muted">মোট শেষ</div></div>
      <div><div class="big" id="queue">0</div><div class="muted">অপেক্ষায়</div></div>
    </div>
    <div class="err" id="lastError"></div>
    <div class="muted" style="margin-top:10px">ফোল্ডার: <b id="folderShown"></b></div>
  </div>

  <div class="card" id="failedCard" hidden>
    <h2>ব্যর্থ ফাইল</h2>
    <div id="failedList" class="muted"></div>
    <div class="row"><button class="ghost" id="retryBtn">আবার চেষ্টা করুন</button></div>
  </div>

  <div class="card"><h2>লগ</h2><pre id="log"></pre></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-bridge": "1" }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "কিছু একটা ভুল হয়েছে।");
    return d;
  }
  const PHASES = {
    "idle": ["অপেক্ষা করছে, নতুন ফাইল এলেই শুরু হবে", "good"],
    "working": ["ট্রান্সক্রাইব হচ্ছে", "work"],
    "retry-later": ["কিছুক্ষণ পর আবার চেষ্টা করবে", "warn"],
    "folder-missing": ["ফোল্ডার পাওয়া যাচ্ছে না", "bad"],
    "needs-setup": ["যুক্ত করা দরকার", "bad"],
    "needs-folder": ["ফোল্ডার বেছে নিন", "warn"],
  };
  let editing = false;
  function renderPrefs(s) {
    $("prefsCard").hidden = !s.paired || s.needsPairing;
    $("teamPrefs").hidden = s.kind === "personal";
    $("personalPrefs").hidden = s.kind !== "personal";
    if (editing) return;
    $("sheetOn").checked = s.sheetEnabled;
    if (s.kind === "personal") {
      $("acct").textContent = s.account || "";
      if (s.choices) {
        $("modeSel").innerHTML = Object.entries(s.choices.modes).map(([k, v]) => "<option value='" + esc(k) + "'>" + esc(v) + "</option>").join("");
        $("langSel").innerHTML = s.choices.languages.map((l) => "<option>" + esc(l) + "</option>").join("");
        if (s.settings) { $("modeSel").value = s.settings.mode; $("langSel").value = s.settings.language; }
      }
    }
  }
  async function savePrefs(patch) {
    $("prefsErr").textContent = "";
    try { await post("/api/prefs", patch); } catch (e) { $("prefsErr").textContent = e.message; }
    editing = false; refresh();
  }
  $("sheetOn").onchange = () => { editing = true; savePrefs({ sheet: $("sheetOn").checked }); };
  $("modeSel").onchange = () => { editing = true; savePrefs({ mode: $("modeSel").value }); };
  $("langSel").onchange = () => { editing = true; savePrefs({ language: $("langSel").value }); };
  $("resetBtn").onclick = async () => {
    if (!confirm("এই পিসি আলাদা করবেন? ফোল্ডার ও শেষ হওয়া ফাইলের তালিকা থাকবে, কিন্তু আবার যুক্ত না করা পর্যন্ত ট্রান্সক্রাইব বন্ধ থাকবে।")) return;
    try { await post("/api/reset"); filled = false; await refresh(); } catch (e) { $("prefsErr").textContent = e.message; }
  };
  let filled = false;
  let loadedVersion = null;
  let wasInstalling = false;
  function renderUpdate(s) {
    const u = s.update, card = $("updateCard"), btn = $("updBtn");
    if (!u) { card.hidden = true; return; }
    btn.hidden = true; card.hidden = false;
    if (u.state === "available") {
      $("updTitle").textContent = "নতুন সংস্করণ " + u.latest + " এসেছে (আপনার: " + s.version + ")";
      $("updSub").textContent = "এক ক্লিকে ডাউনলোড ও ইনস্টল হবে। কয়েক সেকেন্ডের জন্য অ্যাপ বন্ধ হয়ে নিজে আবার চালু হবে। চলমান ফাইল পরে আবার শুরু হবে, কিছু হারাবে না।";
      btn.textContent = "এখনই আপডেট করুন"; btn.hidden = false; btn.onclick = async () => { btn.disabled = true; await post("/api/update/install").catch(() => {}); refresh(); };
    } else if (u.state === "downloading") {
      $("updTitle").textContent = "নতুন সংস্করণ ডাউনলোড হচ্ছে… " + u.progress + "%"; $("updSub").textContent = "এই উইন্ডো বন্ধ করবেন না।";
    } else if (u.state === "installing") {
      $("updTitle").textContent = "ইনস্টল হচ্ছে…"; $("updSub").textContent = "অ্যাপ নিজে থেকে আবার চালু হবে, এই উইন্ডো আপনা-আপনি নতুন হয়ে যাবে।"; wasInstalling = true;
    } else if (u.state === "error") {
      $("updTitle").textContent = "আপডেট দেখা বা ইনস্টল করা যায়নি"; $("updSub").textContent = u.error || "";
      btn.textContent = "আবার দেখুন"; btn.hidden = false; btn.disabled = false; btn.onclick = async () => { await post("/api/update/check").catch(() => {}); refresh(); };
    } else if (u.state === "current") {
      $("updTitle").textContent = "✓ অ্যাপ আপ টু ডেট (সংস্করণ " + s.version + ")"; $("updSub").textContent = "";
      btn.textContent = "নতুন আপডেট আছে কি দেখুন"; btn.hidden = false; btn.disabled = false; btn.className = "ghost"; btn.onclick = async () => { await post("/api/update/check").catch(() => {}); refresh(); };
    } else { card.hidden = true; }
  }
  async function refresh() {
    let s;
    try { s = await (await fetch("/api/status")).json(); } catch { $("sub").textContent = wasInstalling ? "আপডেট হচ্ছে, একটু অপেক্ষা করুন…" : "ব্রিজ চালু নেই।"; return; }
    if (loadedVersion && s.version !== loadedVersion) { location.reload(); return; }
    loadedVersion = s.version;
    renderUpdate(s);
    $("sub").innerHTML = s.paired ? (s.kind === "personal" ? "অ্যাকাউন্ট: <b>" + esc(s.account || "") + "</b> · " : "") + "পিসি: <b>" + esc(s.deviceName) + "</b> · সংস্করণ " + esc(s.version) : "সংস্করণ " + esc(s.version);
    renderPrefs(s);
    const CONN = {
      connected: ["good", "ওয়েবসাইটের সাথে সংযুক্ত", s.serverHost + (s.contactAgo == null ? "" : " · শেষ যোগাযোগ " + (s.contactAgo < 90 ? s.contactAgo + " সেকেন্ড" : Math.round(s.contactAgo / 60) + " মিনিট") + " আগে")],
      offline: ["bad", "ওয়েবসাইটে পৌঁছানো যাচ্ছে না", "ফাইল এই পিসিতে জমছে, ইন্টারনেট এলে নিজে থেকেই পাঠাবে।"],
      removed: ["bad", "সংযোগ বিচ্ছিন্ন", "এই পিসি ওয়েবসাইট থেকে সরানো হয়েছে। আবার যুক্ত করুন (অন্য কম্পিউটার এই পিসির জায়গা নিয়ে থাকতে পারে)।"],
      checking: ["warn", "ওয়েবসাইটের সাথে সংযোগ দেখা হচ্ছে…", s.serverHost],
    };
    const c = CONN[s.connection];
    $("conn").hidden = !c;
    if (c) { $("dot").className = "dot " + c[0]; $("connTitle").textContent = c[1]; $("connSub").textContent = c[2]; }
    $("pairCard").hidden = s.paired && !s.needsPairing;
    $("folderCard").hidden = !s.paired || s.needsPairing;
    $("statusCard").hidden = !s.paired || !s.folder;
    if (!filled && s.folder) { $("folder").value = s.folder; $("existing").checked = s.includeExisting; filled = true; }
    const [text, cls] = PHASES[s.phase] || PHASES.idle;
    $("phase").innerHTML = "<span class='pill " + cls + "'>" + text + "</span>";
    $("detail").textContent = s.current ? s.current + (s.detail ? " · " + s.detail : "") : "";
    $("doneCount").textContent = s.doneCount; $("queue").textContent = s.queue;
    $("lastError").textContent = s.lastError || "";
    $("folderShown").textContent = s.folder;
    $("failedCard").hidden = !s.failed.length;
    $("failedList").innerHTML = s.failed.map((f) => "<div>" + esc(f.file.split(/[\\/]/).pop()) + " <span class=bad>" + esc(f.error || "") + "</span></div>").join("");
    $("log").textContent = s.log.join("\n");
  }
  function showTab(name) {
    $("linkBox").hidden = name !== "link"; $("newBox").hidden = name !== "new"; $("googleBox").hidden = name !== "google";
    $("tabLink").className = name === "link" ? "" : "ghost"; $("tabNew").className = name === "new" ? "" : "ghost"; $("tabGoogle").className = name === "google" ? "" : "ghost";
  }
  $("tabLink").onclick = () => showTab("link");
  $("tabNew").onclick = () => showTab("new");
  $("tabGoogle").onclick = () => showTab("google");
  showTab("link");
  let loginTimer = null;
  $("googleBtn").onclick = async () => {
    $("googleErr").textContent = "";
    clearInterval(loginTimer);
    try {
      const d = await post("/api/login-start");
      $("googleCode").textContent = d.userCode; $("googleLink").textContent = d.link; $("googleWait").hidden = false;
      loginTimer = setInterval(async () => {
        try {
          const r = await post("/api/login-poll");
          if (r.state === "done") { clearInterval(loginTimer); $("googleWait").hidden = true; await refresh(); }
          if (r.state === "none") { clearInterval(loginTimer); $("googleWait").hidden = true; }
        } catch (e) { clearInterval(loginTimer); $("googleWait").hidden = true; $("googleErr").textContent = e.message; }
      }, 2000);
    } catch (e) { $("googleErr").textContent = e.message; }
  };
  $("listBtn").onclick = async () => {
    $("linkErr").textContent = "";
    try {
      const { computers } = await post("/api/link-list", { pin: $("pin").value });
      $("pick").innerHTML = computers.map((c) => "<option value='" + esc(c.key) + "'>" + esc(c.name) + "</option>").join("");
      $("pickBox").hidden = !computers.length;
      if (!computers.length) $("linkErr").textContent = "ওয়েবসাইটে এখনো কোনো পিসি নেই। 'নতুন পিসি' ব্যবহার করুন।";
    } catch (e) { $("pickBox").hidden = true; $("linkErr").textContent = e.message; }
  };
  $("linkBtn").onclick = async () => {
    $("linkErr").textContent = "";
    try { await post("/api/link", { pin: $("pin").value, key: $("pick").value }); $("pin").value = ""; $("pickBox").hidden = true; await refresh(); } catch (e) { $("linkErr").textContent = e.message; }
  };
  $("pairBtn").onclick = async () => {
    $("pairErr").textContent = "";
    try { await post("/api/pair", { code: $("code").value }); $("code").value = ""; await refresh(); } catch (e) { $("pairErr").textContent = e.message; }
  };
  $("browseBtn").onclick = async () => {
    try { const d = await post("/api/browse"); if (d.folder) $("folder").value = d.folder; if (d.error) $("folderErr").textContent = d.error; } catch (e) { $("folderErr").textContent = e.message; }
  };
  $("folderBtn").onclick = async () => {
    $("folderErr").textContent = "";
    try { await post("/api/folder", { folder: $("folder").value, includeExisting: $("existing").checked }); filled = true; await refresh(); } catch (e) { $("folderErr").textContent = e.message; }
  };
  $("retryBtn").onclick = async () => { await post("/api/retry"); await refresh(); };
  refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>`;
