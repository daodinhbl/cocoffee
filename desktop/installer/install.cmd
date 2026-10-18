@echo off
rem Fallback installer for the portable package (when Inno Setup was not available at build time).
rem Run as administrator. Copies the program to %ProgramFiles%\POS Tasotek Server, creates the data folder, a desktop shortcut,
rem the Windows Firewall rule for phones on the same Wi-Fi, and starts the manager.
setlocal
net session >nul 2>&1 || (echo Hay chay file nay bang quyen Administrator ^(chuot phai ^> Run as administrator^). & pause & exit /b 1)
set "DEST=%ProgramFiles%\POS Tasotek Server"
set "DATA=%ProgramData%\TasotekPOS"
echo Dang cai vao "%DEST%" ...
taskkill /F /IM pos_tasotek_server.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM mariadbd.exe >nul 2>&1
taskkill /F /IM ngrok.exe >nul 2>&1
robocopy "%~dp0." "%DEST%" /E /NFL /NDL /NJH /NJS /XF install.cmd >nul
if not exist "%DATA%" mkdir "%DATA%"
icacls "%DATA%" /grant *S-1-5-32-545:(OI)(CI)M /T >nul
netsh advfirewall firewall delete rule name="POS Tasotek Server" >nul 2>&1
netsh advfirewall firewall add rule name="POS Tasotek Server" dir=in action=allow protocol=TCP localport=3000 profile=private >nul
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('CommonDesktopDirectory')+'\POS Tasotek Server.lnk'); $s.TargetPath='%DEST%\manager\pos_tasotek_server.exe'; $s.WorkingDirectory='%DEST%\manager'; $s.Save()"
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v TasotekPOSServer /t REG_SZ /d "\"%DEST%\manager\pos_tasotek_server.exe\"" /f >nul
echo Xong. Dang mo POS Tasotek Server...
start "" "%DEST%\manager\pos_tasotek_server.exe"
endlocal
