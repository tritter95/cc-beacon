# Phase 0 Windows probe: persistent toast worker for Windows PowerShell 5.1. Reads one JSON request
# per line on stdin and writes one JSON reply per line on stdout. Started by the probe extension with
#   powershell.exe -NoLogo -NoProfile -NonInteractive -File toast-worker.ps1 -AppId <AUMID>
# (no -ExecutionPolicy flag, no -EncodedCommand, no Add-Type).
param([string]$AppId)

try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch { }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
function Esc($s) { [Security.SecurityElement]::Escape([string]$s) }

$sw = [Diagnostics.Stopwatch]::StartNew()
$hello = @{
  ok = $true; op = 'hello'; pid = $PID; appId = $AppId
  psVersion = "$($PSVersionTable.PSVersion)"
  languageMode = "$($ExecutionContext.SessionState.LanguageMode)"
  executionPolicy = "$(Get-ExecutionPolicy)"
}
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $hello.winrt = $true
} catch { $hello.winrt = $false; $hello.winrtError = "$_" }
$hello.winrtMs = $sw.ElapsedMilliseconds
# A toast under an AUMID only shows if a Start Menu shortcut carries that AUMID.
try { $hello.startMenuEntry = [bool](Get-StartApps | Where-Object { $_.AppID -eq $AppId }) } catch { $hello.startMenuEntry = "unknown: $_" }
$hello.ms = $sw.ElapsedMilliseconds
Reply $hello

function Show-Toast($r) {
  $launch = Esc $r.launch
  $scenario = ''
  $actions = ''
  if ($r.persistent) {
    $scenario = ' scenario="reminder"'
    $actions = "<actions><action content=`"Show`" activationType=`"protocol`" arguments=`"$launch`"/>" +
      "<action content=`"Dismiss`" activationType=`"system`" arguments=`"dismiss`"/></actions>"
  }
  $xml = "<toast activationType=`"protocol`" launch=`"$launch`"$scenario><visual><binding template=`"ToastGeneric`">" +
    "<text>$(Esc $r.title)</text><text>$(Esc $r.body)</text></binding></visual>$actions</toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $toast.Tag = $r.tag
  $toast.Group = 'cc-beacon'
  $id = if ($r.appId) { $r.appId } else { $AppId }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)
}

# Process ancestry, to check that the parent of CLAUDE_PID is the terminal's shell (Terminal.processId).
function Get-Parents($procId) {
  $chain = @()
  for ($i = 0; $i -lt 6 -and $procId; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
    if (-not $p) { break }
    $chain += @{ pid = $p.ProcessId; name = $p.Name }
    $procId = $p.ParentProcessId
  }
  , $chain
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $sw.Restart()
  $r = $null
  try {
    $r = $line | ConvertFrom-Json
    switch ($r.op) {
      'show' { Show-Toast $r; Reply @{ ok = $true; op = 'show'; tag = $r.tag; ms = $sw.ElapsedMilliseconds } }
      'remove' {
        [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($r.tag, 'cc-beacon', $AppId)
        Reply @{ ok = $true; op = 'remove'; tag = $r.tag; ms = $sw.ElapsedMilliseconds }
      }
      'parents' { Reply @{ ok = $true; op = 'parents'; pid = $r.pid; chain = (Get-Parents $r.pid); ms = $sw.ElapsedMilliseconds } }
      'exit' { Reply @{ ok = $true; op = 'exit' }; exit 0 }
      default { Reply @{ ok = $false; op = "$($r.op)"; error = 'unknown op' } }
    }
  } catch { Reply @{ ok = $false; op = "$($r.op)"; error = "$_" } }
}
