; Inno Setup 6 script of the one-click installer. Built by scripts\build-windows-installer.ps1:
;   ISCC /DAppVersion=1.0.0 /DStageDir=<dist\win\POS-Tasotek-Server> /DOutDir=<dist\win> pos-tasotek.iss
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\dist\win\POS-Tasotek-Server"
#endif
#ifndef OutDir
  #define OutDir "..\..\dist\win"
#endif

[Setup]
AppId={{5B7E2F6C-3C0B-4F0F-9C55-7D1D6B1A0C51}
AppName=POS Tasotek Server
AppVersion={#AppVersion}
AppPublisher=Tasotek
DefaultDirName={autopf}\POS Tasotek Server
DefaultGroupName=POS Tasotek Server
DisableProgramGroupPage=yes
OutputDir={#OutDir}
OutputBaseFilename=POS-Tasotek-Server-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
UninstallDisplayName=POS Tasotek Server
UninstallDisplayIcon={app}\manager\pos_tasotek_server.exe
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Tạo biểu tượng trên màn hình nền"; Flags: checkedonce
Name: "autostart"; Description: "Tự chạy POS khi bật máy tính (khuyên dùng cho máy của quán)"; Flags: checkedonce
Name: "firewall"; Description: "Cho điện thoại trong cùng Wi-Fi truy cập POS (mở cổng 3000 trong Windows Firewall)"; Flags: checkedonce

[Dirs]
; data (database files, settings, backups) is outside the program folder so an update or reinstall never touches it
Name: "{commonappdata}\TasotekPOS"; Permissions: users-modify

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\POS Tasotek Server"; Filename: "{app}\manager\pos_tasotek_server.exe"; WorkingDir: "{app}\manager"
Name: "{commondesktop}\POS Tasotek Server"; Filename: "{app}\manager\pos_tasotek_server.exe"; WorkingDir: "{app}\manager"; Tasks: desktopicon
Name: "{group}\Thư mục dữ liệu"; Filename: "{commonappdata}\TasotekPOS"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "TasotekPOSServer"; ValueData: """{app}\manager\pos_tasotek_server.exe"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""POS Tasotek Server"" dir=in action=allow protocol=TCP localport=3000 profile=private"; Flags: runhidden; Tasks: firewall
Filename: "{app}\manager\pos_tasotek_server.exe"; Description: "Mở POS Tasotek Server"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}\manager"

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""POS Tasotek Server"""; Flags: runhidden; RunOnceId: "DelFirewall"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM pos_tasotek_server.exe /IM node.exe /IM mariadbd.exe /IM ngrok.exe"; Flags: runhidden; RunOnceId: "KillServices"

[UninstallDelete]
; the database and settings in {commonappdata}\TasotekPOS are deliberately NOT removed: reinstalling brings the shop back as it was

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
