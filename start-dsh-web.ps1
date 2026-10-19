# 人和 agent 共用的唯一入口：所有路径解析、预检、stdout 捕获、启停都在 launch.mjs 里，
# 这个脚本只负责转发 —— 升级时只可能坏在一处。
#
#   .\start-dsh-web.ps1                  启动（已运行则连接）
#   .\start-dsh-web.ps1 status           看状态：端口、登记的 pid、端口占用者
#   .\start-dsh-web.ps1 stop             停掉本状态目录启动的实例（整棵进程树）
#   .\start-dsh-web.ps1 stop --pid 1234  停掉别处启动、你已确认归属的实例
#   .\start-dsh-web.ps1 restart          先停再起
#   .\start-dsh-web.ps1 doctor           逐级体检
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @('D:\Program Files\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe')
if ($env:DSH_NODE) { $candidates = @($env:DSH_NODE) + $candidates }
$node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Error 'node.exe not found; set $env:DSH_NODE'; exit 1 }
# Every argument is forwarded, not just the first: `stop --pid 1234` used to lose the pid, and the
# launcher then refused a stop the operator had already confirmed.
$cmd = if ($args.Count -gt 0) { $args[0] } else { 'start' }
$forward = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
& $node (Join-Path $here 'launch.mjs') $cmd @forward
exit $LASTEXITCODE