# 人和 Codex 共用的唯一启动入口：所有路径解析、预检、stdout 捕获都在 launch.mjs 里，
# 这个脚本只负责转发 —— 升级时只可能坏在一处。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @('D:\Program Files\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe')
if ($env:DSH_NODE) { $candidates = @($env:DSH_NODE) + $candidates }
$node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Error 'node.exe not found; set $env:DSH_NODE'; exit 1 }
$cmd = if ($args.Count -gt 0) { $args[0] } else { 'start' }
& $node (Join-Path $here 'launch.mjs') $cmd
exit $LASTEXITCODE
