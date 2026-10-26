# CC Beacon Phase 0, step 1 (Windows): READ-ONLY environment check for a corporate machine.
# It changes nothing, compiles no code and loads no WinRT types. It only reads policy, registry and
# file locations that decide whether CC Beacon can work here.
#
# Easiest way to run it: open Windows PowerShell, paste this whole file in, and press Enter.
# (Pasted commands aren't subject to execution policy, so no -ExecutionPolicy flag is needed.)
# Then copy the output back to Claude.

function Show($label, $value) { "{0,-38} {1}" -f $label, $value }
function RegValues($path) {
  if (Test-Path $path) {
    $p = Get-ItemProperty -Path $path
    ($p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '
  } else { '(not set)' }
}

"=== PowerShell ==="
Show 'Version' $PSVersionTable.PSVersion
Show 'LanguageMode (need FullLanguage)' $ExecutionContext.SessionState.LanguageMode
Get-ExecutionPolicy -List | ForEach-Object { Show "ExecutionPolicy $($_.Scope)" $_.ExecutionPolicy }

"`n=== Toast notification policy ==="
Show 'Policy HKCU PushNotifications' (RegValues 'HKCU:\Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications')
Show 'Policy HKLM PushNotifications' (RegValues 'HKLM:\Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications')
Show 'User toasts enabled (ToastEnabled)' (RegValues 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications')
Show 'VS Code toast setting' (RegValues 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Microsoft.VisualStudioCode')

"`n=== VS Code ==="
$roots = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code", "$env:ProgramFiles\Microsoft VS Code")
$found = $false
foreach ($r in $roots) {
  if (Test-Path $r) {
    $prod = Get-ChildItem -Path $r -Recurse -Filter product.json -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'resources\\app\\product.json$' } | Select-Object -First 1
    if ($prod) {
      $j = Get-Content $prod.FullName -Raw | ConvertFrom-Json
      Show 'Install' $r
      Show 'Version' $j.version
      Show 'win32AppUserModelId' $j.win32AppUserModelId
      $found = $true
    }
  }
}
if (-not $found) { Show 'Install' 'not found in the usual locations' }
$lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter 'Visual Studio Code*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
Show 'Start Menu shortcut' $(if ($lnk) { $lnk.FullName } else { 'NOT FOUND' })
Show 'Policy HKLM VSCode' (RegValues 'HKLM:\SOFTWARE\Policies\Microsoft\VSCode')
Show 'Policy HKCU VSCode' (RegValues 'HKCU:\SOFTWARE\Policies\Microsoft\VSCode')

"`n=== Claude Code ==="
$claude = Get-Command claude -ErrorAction SilentlyContinue
Show 'claude on PATH' $(if ($claude) { $claude.Source } else { 'no' })
if ($claude) { Show 'claude --version' (& claude --version 2>&1 | Select-Object -First 1) }
$managed = 'C:\Program Files\ClaudeCode\managed-settings.json'
if (Test-Path $managed) {
  $m = Get-Content $managed -Raw
  Show 'managed-settings.json' 'PRESENT'
  Show '  allowManagedHooksOnly' $(if ($m -match '"allowManagedHooksOnly"\s*:\s*true') { 'TRUE (blocks our hooks)' } else { 'not set' })
  Show '  disableAllHooks' $(if ($m -match '"disableAllHooks"\s*:\s*true') { 'TRUE (blocks our hooks)' } else { 'not set' })
} else { Show 'managed-settings.json' 'not present' }
if (Test-Path 'C:\Program Files\ClaudeCode\managed-settings.d') { Show 'managed-settings.d' 'PRESENT (check it for hook keys)' }
foreach ($hive in 'HKLM', 'HKCU') {
  $k = "$($hive):\SOFTWARE\Policies\ClaudeCode"
  if (Test-Path $k) {
    $s = (Get-ItemProperty $k).Settings
    Show "Policy $hive ClaudeCode" 'PRESENT'
    Show '  mentions hooks' $(if ($s -match 'allowManagedHooksOnly|disableAllHooks') { 'YES - check values' } else { 'no' })
  } else { Show "Policy $hive ClaudeCode" 'not set' }
}
"Also run /status inside Claude Code and copy the 'Setting sources' line (server-managed settings from the claude.ai console can't be seen from disk)."

"`n=== Hook runtime ==="
$bash = Get-Command bash -ErrorAction SilentlyContinue
Show 'bash (Git Bash) on PATH' $(if ($bash) { $bash.Source } else { 'no' })
Show 'Git for Windows bash.exe' $(if (Test-Path "$env:ProgramFiles\Git\bin\bash.exe") { "$env:ProgramFiles\Git\bin\bash.exe" } else { 'not at default path' })
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
Show 'curl.exe' $(if ($curl) { $curl.Source } else { 'no' })
Show 'HTTP_PROXY / HTTPS_PROXY set' $(if ($env:HTTP_PROXY -or $env:http_proxy -or $env:HTTPS_PROXY -or $env:https_proxy) { 'YES' } else { 'no' })
Show 'NO_PROXY' $(if ($env:NO_PROXY) { $env:NO_PROXY } elseif ($env:no_proxy) { $env:no_proxy } else { '(not set)' })
Show 'WSL installed' $(if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { 'yes' } else { 'no' })
