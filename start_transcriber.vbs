' Double-click this file from the same folder as app.py.
Dim shell, files, appFolder
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
appFolder = files.GetParentFolderName(WScript.ScriptFullName)

If Not files.FileExists(files.BuildPath(appFolder, "app.py")) Then
    MsgBox "app.py was not found in this folder.", vbExclamation, "Team Fahad Transcriber"
    WScript.Quit 1
End If

shell.CurrentDirectory = appFolder
shell.Run "cmd.exe /c python -m streamlit run app.py --server.headless false", 0, False
