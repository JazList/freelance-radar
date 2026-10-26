# Общие настройки запуска: .env из корня репозитория -> переменные окружения процесса; Set-DotEnvValue обновляет одно значение
# (площадки присылают новые cookie входа: радар кладет их в state\*.new, run.ps1 переносит в .env).
$EnvFile = Join-Path $PSScriptRoot '.env'
$LogDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Import-DotEnv {
    if (-not (Test-Path $EnvFile)) { throw "нет файла $EnvFile — скопируйте .env.example" }
    foreach ($line in Get-Content $EnvFile -Encoding utf8) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim() }
    }
}

function Set-DotEnvValue([string]$Name, [string]$Value) {
    $lines = @(Get-Content $EnvFile -Encoding utf8 | Where-Object { $_ -notmatch "^\s*$Name\s*=" })
    $lines += "$Name=$Value"
    Set-Content -Path $EnvFile -Value $lines -Encoding utf8
}

function Save-NewCookie([string]$File, [string]$Name) {
    if (Test-Path $File) {
        Set-DotEnvValue -Name $Name -Value (Get-Content $File -Raw).Trim()
        Remove-Item $File
    }
}
