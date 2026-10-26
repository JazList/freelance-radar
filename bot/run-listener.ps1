# Слушатель MAX-бота (Планировщик Windows, при входе пользователя). Лог - logs\listener.log.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
. (Join-Path $dir '..\env.ps1')
$log = Join-Path $LogDir 'listener.log'
Import-DotEnv
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Ровно один опросчик на бота: Stop-ScheduledTask не гасит дочерний node, прежние слушатели остаются и ловят кнопку дважды.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bot*listen.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$(Get-Date -Format s) остановлен прежний слушатель $($_.ProcessId)" | Add-Content -Path $log -Encoding utf8 }
node (Join-Path $dir 'listen.js') *>&1 | Add-Content -Path $log -Encoding utf8
