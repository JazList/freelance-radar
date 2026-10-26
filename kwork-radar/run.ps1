# Запуск радара kwork: по команде в MAX (кнопка или слово «заказы») или Планировщиком. Лог — logs\kwork-radar.log.
# Прогон без отправки: pwsh -File kwork-radar\run.ps1 -Dry
# По кнопке «Заказы kwork» (bot/listen.js): -Now — без тихих часов, ответ «новых нет».
param([switch]$Dry, [switch]$Now)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
. (Join-Path $dir '..\env.ps1')
$log = Join-Path $LogDir 'kwork-radar.log'
# Cookie входа на kwork — без него вложения заказов не скачиваются. kwork меняет токены входа:
# радар кладет новые в state\kwork-cookie.new, здесь они переносятся в .env.
$newCookie = Join-Path $dir 'state\kwork-cookie.new'
Save-NewCookie $newCookie 'KWORK_COOKIE'
Import-DotEnv

$args2 = @((Join-Path $dir 'radar.js'))
if ($Dry) { $args2 += '--dry' }
if ($Now) { $args2 += '--now' }
node @args2 2>&1 | Tee-Object -FilePath $log -Append
Save-NewCookie $newCookie 'KWORK_COOKIE'
