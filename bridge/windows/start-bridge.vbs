' Starts the bridge in the background (no window). Safe to run again: a second copy exits at once.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run """" & dir & "\node.exe"" """ & dir & "\src\index.js""", 0, False
