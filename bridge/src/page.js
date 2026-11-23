/** The local page (Bangla). One file, no external resources. */
export const PAGE = String.raw`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team Fahad Bridge</title>
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
  <h1>Team Fahad Bridge</h1>
  <div class="muted" id="sub">লোড হচ্ছে…</div>
  <div class="card conn" id="conn" hidden><span class="dot" id="dot"></span><div><b id="connTitle"></b><div class="muted" id="connSub"></div></div></div>

  <div class="card" id="pairCard" hidden>
    <h2>ধাপ ১: এই পিসি যুক্ত করুন</h2>
    <div class="row" style="margin-top:0">
      <button id="tabLink">আগের পিসির সাথে যুক্ত করুন</button>
      <button class="ghost" id="tabNew">নতুন পিসি</button>
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

    <div id="newBox" hidden>
      <p class="muted">ওয়েবসাইটের <b>Auto</b> পেজে পিসির নাম লিখে <b>Get pairing code</b> চাপুন। যে কোডটি আসবে সেটি এখানে লিখুন।</p>
      <div class="row"><input type="text" id="code" placeholder="ABCD-EFGH" maxlength="12" autocomplete="off"><button id="pairBtn">যুক্ত করুন</button></div>
      <div class="err" id="pairErr"></div>
    </div>
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
  let filled = false;
  async function refresh() {
    let s;
    try { s = await (await fetch("/api/status")).json(); } catch { $("sub").textContent = "ব্রিজ চালু নেই।"; return; }
    $("sub").innerHTML = s.paired ? "পিসি: <b>" + esc(s.deviceName) + "</b> · সংস্করণ " + esc(s.version) + "" : "সংস্করণ " + esc(s.version);
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
  function showTab(link) {
    $("linkBox").hidden = !link; $("newBox").hidden = link;
    $("tabLink").className = link ? "" : "ghost"; $("tabNew").className = link ? "ghost" : "";
  }
  $("tabLink").onclick = () => showTab(true);
  $("tabNew").onclick = () => showTab(false);
  showTab(true);
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
    try { const d = await post("/api/browse"); if (d.folder) $("folder").value = d.folder; } catch (e) { $("folderErr").textContent = e.message; }
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
