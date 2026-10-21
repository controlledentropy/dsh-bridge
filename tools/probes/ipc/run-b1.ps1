# B1 acceptance driver: an Adapter entry that refuses before it dispatches.
#
# Two things this script had to grow, both found by running it rather than reading it:
#
# 1. Start-Process copies the current environment into a case-insensitive dictionary. A shell that
#    carries both HTTP_PROXY and http_proxy (the sandbox that ran this probe does) makes that copy
#    throw "Item has already been added" BEFORE the server exists - the symptom is eight clients
#    timing out, which reads like a policy failure and is not one. Duplicates are dropped first.
# 2. The repo path was hardcoded and the policy fixture lived under .state/, so a fresh clone could
#    not reproduce anything. The path is now derived from this file's location, and the fixture is
#    seeded from policy.sample.json.
#
# It also asserts instead of printing JSON for a human to eyeball: a matrix that cannot fail is not a
# test. Exit code 1 when any case disagrees with the expected answer.
param([switch]$KeepOutput)

$ErrorActionPreference = 'Continue'

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..\..')).Path
$policyDir = Join-Path $repo '.state\b1'
$policy = Join-Path $policyDir 'policy.json'
$sample = Join-Path $here 'policy.sample.json'

if (-not (Test-Path $policy)) {
  if (-not (Test-Path $policyDir)) { New-Item -ItemType Directory -Force -Path $policyDir | Out-Null }
  Copy-Item $sample $policy
}

$policyData = Get-Content $policy -Raw | ConvertFrom-Json
$allowedCwd = $policyData.goals[0].allowedWorkspaces[0]
$srvScript = Join-Path $here 'coordinator.ps1'
$cliScript = Join-Path $here 'worker-client.ps1'

# MEASURED: Windows allows an environment block to hold two entries that differ only in case. .NET
# dictionaries do not, so any Start-Process in such a shell fails at argument-binding time.
function Remove-DuplicateEnvironmentKeys {
  $seen = @{}
  foreach ($k in @([System.Environment]::GetEnvironmentVariables().Keys)) {
    $lower = $k.ToLowerInvariant()
    if ($seen.ContainsKey($lower)) { [System.Environment]::SetEnvironmentVariable($k, $null) }
    else { $seen[$lower] = $true }
  }
}
Remove-DuplicateEnvironmentKeys

function Invoke-Case {
  param([string]$Name, [string]$Scenario, [hashtable]$ServerArgs, [hashtable]$ClientArgs)
  if (-not $ServerArgs) { $ServerArgs = @{} }
  if (-not $ClientArgs) { $ClientArgs = @{} }
  $pipe = 'dsh-b1-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $srvOut = Join-Path $env:TEMP ('srv-' + $pipe + '.out')
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $srvScript, '-PipeName', $pipe, '-PolicyFile', $policy)
  foreach ($k in $ServerArgs.Keys) {
    $argList += ('-' + $k)
    if ($null -ne $ServerArgs[$k]) { $argList += [string]$ServerArgs[$k] }   # switch when the value is $null
  }

  $srv = $null
  try {
    $srv = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -RedirectStandardOutput $srvOut -PassThru -NoNewWindow
  } catch {
    return [pscustomobject]@{ case = $Name; serverReady = $false; serverError = $_.Exception.Message; client = $null; clientRaw = '' }
  }

  # A fixed sleep is a guess about startup time. Wait for the line the server actually prints.
  $deadline = (Get-Date).AddSeconds(15)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $srvOut) {
      $txt = Get-Content $srvOut -Raw -ErrorAction SilentlyContinue
      if ($txt -match '"event":"listening"') { $ready = $true; break }
      if ($txt -match '"event":"connect-failed"') { break }
    }
    Start-Sleep -Milliseconds 100
  }

  $cliOut = ''
  if ($ready) {
    $cliArg = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $cliScript, '-PipeName', $pipe, '-Scenario', $Scenario)
    foreach ($k in $ClientArgs.Keys) { $cliArg += ('-' + $k); $cliArg += [string]$ClientArgs[$k] }
    $cliOut = (& 'powershell.exe' @cliArg 2>&1 | Out-String).Trim()
  }
  Start-Sleep -Milliseconds 150
  if ($srv) { try { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Milliseconds 100

  $serverLines = @(Get-Content $srvOut -ErrorAction SilentlyContinue)
  if (-not $KeepOutput) { Remove-Item $srvOut -Force -ErrorAction SilentlyContinue }

  $parsed = $null
  if ($cliOut) { try { $parsed = $cliOut | ConvertFrom-Json } catch { $parsed = $null } }
  return [pscustomobject]@{ case = $Name; serverReady = $ready; server = $serverLines; client = $parsed; clientRaw = $cliOut }
}

$results = @()

$r = Invoke-Case -Name 'handshake required' -Scenario 'no-handshake'
$step = @($r.client.steps)[0]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'handshake-required'; got = $r }

$r = Invoke-Case -Name 'bad token' -Scenario 'bad-token'
$step = @($r.client.steps)[0]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'bad-token'; got = $r }

$r = Invoke-Case -Name 'unknown goal' -Scenario 'unknown-goal'
$step = @($r.client.steps)[-1]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'unknown-goal'; got = $r }

$r = Invoke-Case -Name 'proposed goal' -Scenario 'dispatch' -ClientArgs @{ GoalId = 'goal-proposed' }
$step = @($r.client.steps)[-1]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'goal-not-authorized' -and $step.state -eq 'proposed'; got = $r }

$r = Invoke-Case -Name 'unregistered thread' -Scenario 'unregistered-thread' -ClientArgs @{ Cwd = $allowedCwd }
$step = @($r.client.steps)[-1]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'thread-not-registered'; got = $r }

$r = Invoke-Case -Name 'cwd not allowed' -Scenario 'cwd-not-allowed' -ClientArgs @{ Cwd = $allowedCwd }
$step = @($r.client.steps)[-1]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.error -eq 'cwd-not-allowed'; got = $r }

$r = Invoke-Case -Name 'budget exhausted' -Scenario 'dispatch' -ClientArgs @{ Dispatches = 3; Cwd = $allowedCwd }
$s = @($r.client.steps)
$results += [pscustomobject]@{
  case = $r.case
  ok   = $r.serverReady -and $s.Count -eq 4 -and $s[1].ok -and $s[2].ok -and $s[3].error -eq 'budget-exhausted' -and $s[3].used -eq 2 -and $s[3].max -eq 2
  got  = $r
}

$r = Invoke-Case -Name 'happy path' -Scenario 'dispatch' -ClientArgs @{ Cwd = $allowedCwd }
$step = @($r.client.steps)[-1]
$results += [pscustomobject]@{ case = $r.case; ok = $r.serverReady -and $step.ok -and $step.budgetUsed -eq 1 -and $step.dispatchId; got = $r }

# Negative control for the pipe DACL: a server that grants a SID which exists nowhere must refuse
# every caller at the kernel, so the eight answers above cannot be the policy code being polite.
$r = Invoke-Case -Name 'dacl denies a foreign caller' -Scenario 'hello-only' -ServerArgs @{ DenyAll = $null }
$results += [pscustomobject]@{
  case = $r.case
  ok   = (-not $r.client.connected) -and ($r.client.error -match 'denied|Access')
  got  = $r
}

$pass = @($results | Where-Object { $_.ok }).Count
$fail = @($results | Where-Object { -not $_.ok }).Count
$summary = [pscustomobject]@{
  pass  = $pass
  fail  = $fail
  cases = @($results | ForEach-Object {
      [pscustomobject]@{
        case        = $_.case
        ok          = [bool]$_.ok
        serverReady = $_.got.serverReady
        client      = $_.got.client
      }
    })
}
$summary | ConvertTo-Json -Depth 8
if ($fail -gt 0) { exit 1 }
