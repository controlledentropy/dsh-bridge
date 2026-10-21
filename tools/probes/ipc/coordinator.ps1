param(
  [Parameter(Mandatory=$true)][string]$PipeName,
  [Parameter(Mandatory=$true)][string]$PolicyFile,
  [string]$AllowSid = '',       # if set, the pipe DACL grants ONLY this SID
  [switch]$DenyAll              # if set, DACL grants a bogus SID -> nothing can connect
)
$ErrorActionPreference = 'Stop'
$policy = Get-Content $PolicyFile -Raw | ConvertFrom-Json

function New-PipeSecurity {
  $ps = New-Object System.IO.Pipes.PipeSecurity
  try { $ps.SetAccessRuleProtection($true, $false) } catch {}
  if ($DenyAll) {
    # A SID that exists nowhere: the kernel still evaluates the DACL, so a legitimate
    # client must be refused. This is the negative control for "is the DACL enforced at all".
    $bogus = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-9999999999-9999999999-9999999999-4999')
    $ps.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($bogus, 'FullControl', 'Allow')))
  } elseif ($AllowSid) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($AllowSid)
    $ps.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid, 'FullControl', 'Allow')))
  } else {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $ps.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))
  }
  return $ps
}

$sec = New-PipeSecurity
$server = New-Object System.IO.Pipes.NamedPipeServerStream(
  $PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1,
  [System.IO.Pipes.PipeTransmissionMode]::Byte,
  [System.IO.Pipes.PipeOptions]::None, 65536, 65536, $sec)

Write-Output (ConvertTo-Json @{ event = 'listening'; pipe = $PipeName; pid = $PID } -Compress)
[Console]::Out.Flush()

try {
  $server.WaitForConnection()
} catch {
  Write-Output (ConvertTo-Json @{ event = 'connect-failed'; error = $_.Exception.GetType().Name + ': ' + $_.Exception.Message } -Compress)
  [Console]::Out.Flush()
  exit 0
}

$reader = New-Object System.IO.StreamReader($server, [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter($server, [System.Text.Encoding]::UTF8)
$writer.AutoFlush = $true
$authed = $false
$spent = 0

# MEASURED: GetImpersonationUserName() throws "Unable to impersonate using a named pipe until data
# has been read from that pipe" if called right after WaitForConnection(). The identity of the caller
# is therefore only known AFTER the first read - which reorders the protocol: the first message must
# be read before it can be attributed, so an unauthenticated peer always gets one message in.
$clientUser = $null
$firstRead = $true

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  if ($firstRead) {
    try {
      $clientUser = $server.GetImpersonationUserName()
      Write-Output (ConvertTo-Json @{ event = 'connected'; clientUser = $clientUser; serverUser = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) } -Compress)
      [Console]::Out.Flush()
    } catch {
      $clientUser = 'unknown: ' + $_.Exception.Message
      Write-Output (ConvertTo-Json @{ event = 'identity-unavailable'; error = $clientUser } -Compress)
      [Console]::Out.Flush()
    }
    $firstRead = $false
  }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'bad-json' } -Compress)); continue }

  if (-not $authed) {
    # Handshake first: an accepted connection is NOT an authorised caller (audit item on IPC).
    if ($req.type -ne 'hello') {
      $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'handshake-required' } -Compress)); continue
    }
    if ($req.token -ne $policy.handshakeToken) {
      $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'bad-token' } -Compress)); continue
    }
    $authed = $true
    $writer.WriteLine((ConvertTo-Json @{ ok = $true; hello = 'coordinator'; clientUser = $clientUser } -Compress))
    continue
  }

  if ($req.type -eq 'dispatch') {
    $goal = $policy.goals | Where-Object { $_.goalId -eq $req.goalId } | Select-Object -First 1
    if (-not $goal) { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'unknown-goal' } -Compress)); continue }
    if ($goal.state -ne 'authorized') { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'goal-not-authorized'; state = $goal.state } -Compress)); continue }
    if ($spent -ge $goal.maxRounds) { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'budget-exhausted'; used = $spent; max = $goal.maxRounds } -Compress)); continue }
    if (-not ($policy.registeredThreads -contains $req.threadId)) { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'thread-not-registered' } -Compress)); continue }
    if (-not ($goal.allowedWorkspaces -contains $req.cwd)) { $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'cwd-not-allowed'; cwd = $req.cwd } -Compress)); continue }
    # Budget is decremented in the same step that admits the dispatch: no admit-then-check.
    $spent++
    $dispatchId = 'dsp-' + [guid]::NewGuid().ToString('N').Substring(0,12)
    $writer.WriteLine((ConvertTo-Json @{ ok = $true; dispatchId = $dispatchId; budgetUsed = $spent; budgetMax = $goal.maxRounds } -Compress))
    continue
  }

  $writer.WriteLine((ConvertTo-Json @{ ok = $false; error = 'unknown-request' } -Compress))
}
$server.Disconnect()