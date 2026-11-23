; Inno Setup script: builds one TeamFahadBridge-Setup.exe that installs for the current user (no administrator needed).
; Build: ISCC.exe /DAppVersion=1.0.0 /DStage=<folder with node.exe, ffmpeg, src> TeamFahadBridge.iss
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Stage
  #define Stage "..\..\dist\stage"
#endif

[Setup]
AppId={{6E1F2B3C-5A47-4D2E-9B7A-3F4C8D1E6A52}
AppName=Team Fahad Bridge
AppVersion={#AppVersion}
AppPublisher=Team Fahad
DefaultDirName={localappdata}\Programs\TeamFahadBridge
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=TeamFahadBridge-Setup
SetupIconFile=bridge.ico
UninstallDisplayIcon={app}\bridge.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Files]
Source: "{#Stage}\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "{#Stage}\ffmpeg\*"; DestDir: "{app}\ffmpeg"; Flags: ignoreversion recursesubdirs
Source: "start-bridge.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "open-window.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-bridge.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "bridge.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-bridge.ps1"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\Team Fahad Bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-window.vbs"""; IconFilename: "{app}\bridge.ico"
Name: "{autodesktop}\Team Fahad Bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-window.vbs"""; IconFilename: "{app}\bridge.ico"
; Starts by itself (hidden) every time this user signs in.
Name: "{userstartup}\Team Fahad Bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-bridge.vbs"""; IconFilename: "{app}\bridge.ico"

[Run]
; Start the bridge right away, also for silent installs.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-bridge.vbs"""; Flags: nowait runhidden
; At the end of the normal installer: open the app window to pair the PC.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-window.vbs"""; Description: "Open Team Fahad Bridge and pair this PC"; Flags: nowait postinstall skipifsilent

[Code]
procedure StopBridge(ScriptPath: String);
var
  Code: Integer;
begin
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('stop-bridge.ps1');
  StopBridge(ExpandConstant('{tmp}\stop-bridge.ps1'));
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopBridge(ExpandConstant('{app}\stop-bridge.ps1'));
end;
