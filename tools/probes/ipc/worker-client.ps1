param(
  [Parameter(Mandatory=$true)][string]$PipeName,
  [Parameter(Mandatory=$true)][string]$Scenario,
  [string]$Token = 'right-token',
  [string]$GoalId = 'goal-1',
  [string]$ThreadId = 'thread-registered',
  [string]$Cwd = 'D:\\ws\\allowed',
  [int]$Dispatches = 1
)
$ErrorActionPreference = 'Stop'
$out = [System.Collections.ArrayList]::new()

function Connect-Pipe {
  $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try { $c.Connect(3000) } catch { return @{ error = $_.Exception.GetType().Name + ': ' + $_.Exception.Message } }
  return $c
}

$conn = Connect-Pipe
if ($conn -is [hashtable]) {
  ConvertTo-Json @{ scenario = $Scenario; connected = $false; error = $conn.error } -Compress
  exit 0
}
$reader = New-Object System.IO.StreamReader($conn, [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter($conn, [System.Text.Encoding]::UTF8)
$writer.AutoFlush = $true
$send = { param($o) $writer.WriteLine(($o | ConvertTo-Json -Compress)) }
$read = { $l = $reader.ReadLine(); if ($null -eq $l) { @{ ok = $false; error = 'server-closed' } } else { $l | ConvertFrom-Json } }

$result = [ordered]@{ scenario = $Scenario; connected = $true; steps = @() }

if ($Scenario -eq 'no-handshake') {
  # An authorised-looking dispatch WITHOUT the handshake must be refused.
  & $send @{ type = 'dispatch'; goalId = $GoalId; threadId = $ThreadId; cwd = $Cwd }
  $result.steps += (& $read)
} elseif ($Scenario -eq 'bad-token') {
  & $send @{ type = 'hello'; token = 'wrong-token' }
  $result.steps += (& $read)
} elseif ($Scenario -eq 'hello-only') {
  & $send @{ type = 'hello'; token = $Token }
  $result.steps += (& $read)
} else {
  & $send @{ type = 'hello'; token = $Token }
  $result.steps += (& $read)
  # Scenario selects WHICH single policy rule is being tested; the rest stay valid.
  $g = $GoalId
  if ($Scenario -eq 'unknown-goal') { $g = 'goal-does-not-exist' }
  $payload = @{ type = 'dispatch'; goalId = $g; threadId = $ThreadId; cwd = $Cwd }
  if ($Scenario -eq 'unregistered-thread') { $payload.threadId = 'thread-unknown' }
  if ($Scenario -eq 'cwd-not-allowed') { $payload.cwd = (Split-Path -Parent $Cwd) + '\outside' }
  for ($i = 0; $i -lt $Dispatches; $i++) {
    & $send $payload
    $result.steps += (& $read)
  }
}
$conn.Dispose()
ConvertTo-Json $result -Compress -Depth 6