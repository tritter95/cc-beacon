# CC Beacon Phase 0, step 2 (Windows): toast test. Run only after check-environment.ps1 shows
# LanguageMode = FullLanguage and no policy disabling toasts.
#
# Run it by pasting this whole file into Windows PowerShell 5.1 (not PowerShell 7). No
# -ExecutionPolicy flag and no compiled code. It shows three toasts:
#   1. A toast under VS Code's own identity (AUMID read from product.json). Click it.
#   2. A persistent ("reminder") toast that the script withdraws after 15 s.
#   3. A toast under the Windows PowerShell identity (fallback for portable installs).
# Clicking opens vscode://phase0.ccb-probe/focus?w=windows-toast-test. Without the probe extension
# installed, VS Code says the extension isn't installed. That still proves click-through reached VS Code.

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  "LanguageMode is $($ExecutionContext.SessionState.LanguageMode): WinRT toasts aren't possible here. Stop and tell Claude."
  return
}

$aumid = $null
foreach ($r in "$env:LOCALAPPDATA\Programs\Microsoft VS Code", "$env:ProgramFiles\Microsoft VS Code") {
  $p = Get-ChildItem -Path $r -Recurse -Filter product.json -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'resources\\app\\product.json$' } | Select-Object -First 1
  if ($p) { $aumid = (Get-Content $p.FullName -Raw | ConvertFrom-Json).win32AppUserModelId; break }
}
"VS Code AUMID: $aumid"

try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  'WinRT toast types loaded'
} catch {
  "FAILED to load WinRT toast types: $_"
  return
}

function Show-Toast($appId, $tag, $title, $body, $persistent) {
  $launch = 'vscode://phase0.ccb-probe/focus?w=windows-toast-test'
  $scenario = if ($persistent) { ' scenario="reminder"' } else { '' }
  $actions = if ($persistent) {
    "<actions><action content=`"Show`" activationType=`"protocol`" arguments=`"$launch`"/><action content=`"Dismiss`" activationType=`"system`" arguments=`"dismiss`"/></actions>"
  } else { '' }
  $xml = "<toast activationType=`"protocol`" launch=`"$launch`"$scenario><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text></binding></visual><audio src=`"ms-winsoundevent:Notification.Default`"/>$actions</toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $toast.Tag = $tag
  $toast.Group = 'cc-beacon'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    "Toast '$tag' shown via $appId in $($sw.ElapsedMilliseconds) ms"
  } catch { "Toast '$tag' FAILED via ${appId}: $_" }
}

if ($aumid) {
  Show-Toast $aumid 'probe-1' 'CC Beacon test 1 (VS Code identity)' 'Click me. VS Code should come to the front.' $false
  Start-Sleep 3
  Show-Toast $aumid 'probe-2' 'CC Beacon test 2 (persistent)' 'Should stay on screen. The script removes it in 15 s.' $true
  Start-Sleep 15
  try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove('probe-2', 'cc-beacon', $aumid); "Withdrew probe-2" }
  catch { "Withdraw FAILED: $_" }
}
Start-Sleep 2
Show-Toast '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' 'probe-3' 'CC Beacon test 3 (fallback identity)' 'Fallback for portable installs.' $false
"`nDone. Tell Claude, for each toast: did it appear, what name/icon did it show, did clicking bring VS Code forward, and did test 2 disappear on its own?"
