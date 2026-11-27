/**
 * The system tray icon (Windows). The bridge starts hidden when Windows signs in and only shows this icon:
 * double click or "Open status window" opens the status window, "Exit" stops the bridge until the next sign-in.
 * The icon is a tiny PowerShell process; it talks to the bridge through one word per line on its output.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir, APP_DIR } from "./paths.js";
import { log } from "./log.js";

const SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$parent = [int]$env:BRIDGE_PARENT
$tray = New-Object System.Windows.Forms.NotifyIcon
try { $tray.Icon = New-Object System.Drawing.Icon($env:BRIDGE_ICON) } catch { $tray.Icon = [System.Drawing.SystemIcons]::Application }
$tray.Text = 'TEAMCRIBER Bridge'
function Say($word) { [Console]::Out.WriteLine($word); [Console]::Out.Flush() }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open status window')
$quit = $menu.Items.Add('Exit TEAMCRIBER Bridge')
$open.add_Click({ Say 'open' })
$quit.add_Click({ Say 'exit'; $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Say 'open' })
$tray.Visible = $true
# If the bridge itself is gone (uninstall, crash), remove the icon.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({ if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
`;

function iconFile() {
  for (const candidate of [path.join(APP_DIR, "bridge.ico"), path.join(APP_DIR, "windows", "bridge.ico")]) if (fs.existsSync(candidate)) return candidate;
  return "";
}

/** Opens the status window the same way the desktop icon does. */
function openWindow() {
  const script = path.join(APP_DIR, "open-window.vbs");
  if (!fs.existsSync(script)) return;
  spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"), [script], { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

/** Shows the tray icon. Does nothing on other systems. Failing to show it never stops the bridge. */
export function startTray({ onExit } = {}) {
  if (process.platform !== "win32" || process.env.BRIDGE_NO_TRAY) return null;
  try {
    const file = path.join(dataDir(), "tray.ps1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A byte order mark makes Windows PowerShell read the file as UTF-8.
    fs.writeFileSync(file, `\uFEFF${SCRIPT}`);
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, BRIDGE_PARENT: String(process.pid), BRIDGE_ICON: iconFile() },
    });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines.map((l) => l.trim())) {
        if (line === "open") openWindow();
        if (line === "exit") onExit?.();
      }
    });
    child.on("error", (error) => log(`The tray icon could not start: ${error.message}`));
    return child;
  } catch (error) {
    log(`The tray icon could not start: ${error.message}`);
    return null;
  }
}
