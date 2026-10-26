# Радар вакансий hh.ru: итог в консоль и в лог logs\hh-radar.log; -Max — еще отчет state\max-report.json для команды /hh MAX-бота.
# Запуск: pwsh -File hh-radar\run.ps1 [-Period 1] [-Count] [-All] [-Ids 1,2] [-Max]
param([int]$Period = 0, [switch]$Count, [switch]$All, [string]$Ids = '', [switch]$Max)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
. (Join-Path $dir '..\env.ps1')
$log = Join-Path $LogDir 'hh-radar.log'
# hh обновляет cookie входа: радар кладет новые в state\hh-cookie.new, здесь они переносятся в .env.
$newCookie = Join-Path $dir 'state\hh-cookie.new'
Save-NewCookie $newCookie 'HH_COOKIE'
Import-DotEnv

$args2 = @((Join-Path $dir 'radar.js'))
if ($Period -gt 0) { $args2 += @('--period', $Period) }
if ($Count) { $args2 += '--count' }
if ($All) { $args2 += '--all' }
if ($Ids) { $args2 += @('--ids', $Ids) }
if ($Max) { $args2 += '--max' }
node @args2 2>&1 | Tee-Object -FilePath $log -Append
Save-NewCookie $newCookie 'HH_COOKIE'
