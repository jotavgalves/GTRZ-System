param(
  [Parameter(Mandatory = $true)][string]$ExpectedDeviceId,
  [Parameter(Mandatory = $true)][string]$SnapshotId,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedEventId
)

$ErrorActionPreference = 'Stop'
$dataDirectory = Join-Path $env:APPDATA '@gtrz\desktop'
$databasePath = Join-Path $dataDirectory 'gtrz-system.sqlite'
$deviceIdPath = Join-Path $dataDirectory 'gtrz-cloud-device-id'
$credentialPath = Join-Path $dataDirectory 'gtrz-cloud-device-credential.json'
$applicationPath = Join-Path $env:LOCALAPPDATA 'Programs\GTRZ System\GTRZ System.exe'
$endpoint = 'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback'

if (-not (Test-Path -LiteralPath $databasePath) -or
    -not (Test-Path -LiteralPath $deviceIdPath) -or
    -not (Test-Path -LiteralPath $credentialPath)) {
  throw 'O banco ou a credencial deste computador nao foi encontrado. Nenhum dado foi alterado.'
}

$deviceId = (Get-Content -LiteralPath $deviceIdPath -Raw).Trim()
if ($deviceId -ne $ExpectedDeviceId) {
  throw "Este comando foi preparado para outro computador. Dispositivo local: $deviceId."
}

$credential = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
if ($credential.deviceId -ne $deviceId -or
    [string]::IsNullOrWhiteSpace($credential.token)) {
  throw 'A credencial local nao corresponde ao computador. Nenhum dado foi alterado.'
}

$temporaryPath = Join-Path $env:TEMP ("gtrz-recovery-$([guid]::NewGuid().ToString('N')).sqlite")
$backupDirectory = Join-Path $dataDirectory ("recovery-backups\$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N'))")
$movedFiles = @()

try {
  $headers = @{
    'X-GTRZ-Key' = $credential.token
    'X-GTRZ-Device-Id' = $deviceId
  }
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$endpoint/v1/monitor/replica-snapshot/$SnapshotId" -Headers $headers -OutFile $temporaryPath -PassThru -TimeoutSec 90
  if ($response.StatusCode -ne 200 -or
      $response.Headers['X-GTRZ-Snapshot-Event'] -ne $ExpectedEventId) {
    throw 'A nuvem entregou uma copia de outro evento. Nenhum dado foi alterado.'
  }

  $actualSha256 = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash
  if ($actualSha256 -ne $ExpectedSha256 -or
      $response.Headers['X-GTRZ-Snapshot-Sha256'] -ne $ExpectedSha256.ToLowerInvariant() -or
      (Get-Item -LiteralPath $temporaryPath).Length -ne [long]$response.Headers['X-GTRZ-Snapshot-Size']) {
    throw 'A verificacao de integridade da copia falhou. Nenhum dado foi alterado.'
  }

  $stream = [System.IO.File]::OpenRead($temporaryPath)
  try {
    $header = New-Object byte[] 16
    if ($stream.Read($header, 0, 16) -ne 16 -or
        [System.Text.Encoding]::ASCII.GetString($header) -ne "SQLite format 3$([char]0)") {
      throw 'O arquivo recebido nao e um banco SQLite.'
    }
  } finally {
    $stream.Dispose()
  }

  Get-Process -Name 'GTRZ System' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $applicationPath } |
    Stop-Process -Force -ErrorAction Stop
  Start-Sleep -Seconds 2

  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  try {
    foreach ($source in @($databasePath, "$databasePath-wal", "$databasePath-shm")) {
      if (Test-Path -LiteralPath $source) {
        $destination = Join-Path $backupDirectory (Split-Path -Path $source -Leaf)
        Move-Item -LiteralPath $source -Destination $destination
        $movedFiles += @{ Source = $source; Destination = $destination }
      }
    }
    Copy-Item -LiteralPath $temporaryPath -Destination $databasePath
    if ((Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash -ne $ExpectedSha256) {
      throw 'A copia local ficou incompleta.'
    }
  } catch {
    Remove-Item -LiteralPath $databasePath -Force -ErrorAction SilentlyContinue
    foreach ($entry in $movedFiles) {
      Move-Item -LiteralPath $entry.Destination -Destination $entry.Source
    }
    throw
  }

  Write-Output "Banco restaurado para o evento $ExpectedEventId. Banco anterior guardado em $backupDirectory"
  if (Test-Path -LiteralPath $applicationPath) {
    Start-Process -FilePath $applicationPath
  }
} finally {
  Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
}
