' Starts the bridge if needed and opens its own app window (Edge or Chrome in app mode: no tabs, no address bar).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run """" & dir & "\node.exe"" """ & dir & "\src\index.js""", 0, False
WScript.Sleep 2500
url = "http://127.0.0.1:47821"
size = " --window-size=560,860"
On Error Resume Next
sh.Run "msedge.exe --app=" & url & size, 1, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run "chrome.exe --app=" & url & size, 1, False
End If
If Err.Number <> 0 Then
  Err.Clear
  sh.Run url
End If
