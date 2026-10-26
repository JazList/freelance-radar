# Черновик отклика на заказ kwork: pwsh -File draft.ps1 -Id 3264555 [-Again] [-Comment "что поменять"] [-Dry]. Запускает слушатель по кнопке «Подготовить ответ». На kwork ничего не отправляет.
param([Parameter(Mandatory)][string]$Id, [switch]$Again, [switch]$Dry, [string]$Comment = '')
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
. (Join-Path $dir '..\env.ps1')
$log = Join-Path $LogDir 'kwork-radar.log'
Import-DotEnv
$a = @((Join-Path $dir 'draft.js'), $Id)
if ($Again) { $a += '--again' }
if ($Comment) { $a += '--comment'; $a += $Comment }
if ($Dry) { $a += '--dry' }
node @a 2>&1 | Tee-Object -FilePath $log -Append
