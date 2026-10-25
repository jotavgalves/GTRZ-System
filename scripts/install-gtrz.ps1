param(
  [string]$ReleaseTag = 'v0.1.1-owner-access.1',
  [string]$EnrollmentCode = '',
  [switch]$SkipMobileSimulator,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$appNames = @('GTRZ System', 'GTRZ System Mobile')
$profiles = @(Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } | Select-Object -ExpandProperty LocalPath)
$programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)})
foreach ($profile in $profiles) {
  $programRoots += Join-Path $profile 'AppData\Local\Programs'
}
$programRoots = @($programRoots | Where-Object { $_ } | Select-Object -Unique)
$installTargets = @()
foreach ($root in $programRoots) {
  foreach ($name in $appNames) {
    $installTargets += [IO.Path]::GetFullPath((Join-Path $root $name)).TrimEnd('\')
  }
}

$uninstallKeys = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($hive in @(Get-ChildItem Registry::HKEY_USERS -ErrorAction SilentlyContinue)) {
  if ($hive.Name -eq "HKEY_USERS\$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)") { continue }
  $uninstallKeys += "Registry::$($hive.Name)\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
}
$uninstallEntries = @($uninstallKeys | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.DisplayName -match '^GTRZ System( Mobile)?(\s|$)' } |
  Sort-Object PSPath -Unique)

if ($PlanOnly) {
  Write-Host "Instaladores registrados: $($uninstallEntries.Count)"
  foreach ($entry in $uninstallEntries) { Write-Host "- $($entry.DisplayName): $($entry.UninstallString)" }
  Write-Host 'Pastas de instalacao encontradas:'
  foreach ($target in $installTargets) {
    if (Test-Path -LiteralPath $target) { Write-Host "- $target" }
  }
  Write-Host 'AppData, SQLite, credenciais e backups locais serao preservados.'
  return
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Execute este script como Administrador, na conta Windows que usara o GTRZ System.'
}
if ($ReleaseTag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*$') {
  throw 'A tag da versao nao e valida.'
}

function Stop-GtrzApps {
  $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in $appNames })
  foreach ($process in $processes) {
    if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
  }
  if ($processes.Count -gt 0) { Start-Sleep -Seconds 5 }
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -in $appNames } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Uninstall-GtrzEntry {
  param($Entry)
  $command = if ($Entry.QuietUninstallString) { $Entry.QuietUninstallString } else { $Entry.UninstallString }
  if (-not $command) { throw "Desinstalador ausente: $($Entry.DisplayName)" }
  if ($command -match '^\s*"([^"]+\.exe)"\s*(.*)$') {
    $exe = $Matches[1]
    $arguments = $Matches[2]
  } elseif ($command -match '^\s*(.+?\.exe)\s*(.*)$') {
    $exe = $Matches[1]
    $arguments = $Matches[2]
  } else {
    throw "Comando de desinstalacao desconhecido: $($Entry.DisplayName)"
  }
  if ([IO.Path]::GetFileName($exe) -notmatch '^Uninstall GTRZ System( Mobile)?\.exe$') {
    throw "Desinstalador inesperado: $exe"
  }
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Desinstalador nao encontrado: $exe"
  }
  if ($arguments -notmatch '(^|\s)/S(\s|$)') { $arguments = "$arguments /S".Trim() }
  $result = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($result.ExitCode -ne 0) { throw "Falha ao desinstalar $($Entry.DisplayName): codigo $($result.ExitCode)" }
}

function Remove-GtrzInstallFolder {
  param([string]$Target)
  $full = [IO.Path]::GetFullPath($Target).TrimEnd('\')
  if ($full -notin $installTargets) { throw "Pasta fora da lista de instalacoes: $full" }
  if (-not (Test-Path -LiteralPath $full)) { return }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Pasta de instalacao redirecionada; remocao recusada: $full"
  }
  Remove-Item -LiteralPath $full -Recurse -Force
  if (Test-Path -LiteralPath $full) { throw "A pasta antiga permaneceu: $full" }
}

function Get-VerifiedAsset {
  param($Release, [string]$Name, [string]$Directory)
  $asset = @($Release.assets | Where-Object { $_.name -eq $Name })
  if ($asset.Count -ne 1) { throw "Instalador ausente ou duplicado na release: $Name" }
  $urlPrefix = "https://github.com/jotavgalves/GTRZ-System/releases/download/$ReleaseTag/"
  if (-not $asset[0].browser_download_url.StartsWith($urlPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Endereco inesperado para $Name"
  }
  if ($asset[0].digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
    throw "A release nao informa SHA-256 para $Name"
  }
  $expectedHash = $Matches[1]
  $file = Join-Path $Directory $Name
  Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $file
  $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if ($actualHash -ne $expectedHash) { throw "Hash invalido para $Name" }
  return $file
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/jotavgalves/GTRZ-System/releases/tags/$ReleaseTag" -Headers @{ 'User-Agent' = 'GTRZ-Installer' }
$desktopAsset = @($release.assets | Where-Object { $_.name -match '^GTRZ-System-[0-9]+\.[0-9]+\.[0-9]+-Setup\.exe$' })
if ($desktopAsset.Count -ne 1) { throw 'A release nao possui exatamente um instalador desktop.' }
$mobileAsset = @($release.assets | Where-Object { $_.name -match '^GTRZ-System-Mobile-[0-9]+\.[0-9]+\.[0-9]+-Setup\.exe$' })
if (-not $SkipMobileSimulator -and $mobileAsset.Count -ne 1) {
  throw 'A release nao possui exatamente um instalador mobile.'
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$workDir = [IO.Path]::GetFullPath((Join-Path $tempRoot "GTRZ-install-$([guid]::NewGuid().ToString('N'))"))
if (-not $workDir.StartsWith("$tempRoot\GTRZ-install-", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Pasta temporaria invalida.'
}
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
  $desktopSetup = Get-VerifiedAsset $release $desktopAsset[0].name $workDir
  $mobileSetup = if ($SkipMobileSimulator) { $null } else { Get-VerifiedAsset $release $mobileAsset[0].name $workDir }

  Stop-GtrzApps
  foreach ($entry in $uninstallEntries) { Uninstall-GtrzEntry $entry }
  foreach ($target in $installTargets) { Remove-GtrzInstallFolder $target }

  foreach ($profile in $profiles) {
    foreach ($name in $appNames) {
      foreach ($shortcutRoot in @(
        (Join-Path $profile 'Desktop'),
        (Join-Path $profile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs')
      )) {
        $shortcut = Join-Path $shortcutRoot "$name.lnk"
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
      }
    }
  }

  $desktopInstall = Start-Process -FilePath $desktopSetup -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  if ($desktopInstall.ExitCode -ne 0) { throw "Falha na instalacao desktop: $($desktopInstall.ExitCode)" }
  if ($mobileSetup) {
    $mobileInstall = Start-Process -FilePath $mobileSetup -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($mobileInstall.ExitCode -ne 0) { throw "Falha na instalacao mobile: $($mobileInstall.ExitCode)" }
  }

  $desktopExe = Join-Path $env:LOCALAPPDATA 'Programs\GTRZ System\GTRZ System.exe'
  if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
    throw "O programa nao foi encontrado apos instalar: $desktopExe"
  }
  do {
    $env:GTRZ_INSTALL_ENROLLMENT = '1'
    $env:GTRZ_INSTALL_ENROLLMENT_CODE = $EnrollmentCode
    try {
      $verification = Start-Process -FilePath $desktopExe -Wait -PassThru -WindowStyle Hidden
    } finally {
      Remove-Item Env:\GTRZ_INSTALL_ENROLLMENT -ErrorAction SilentlyContinue
      Remove-Item Env:\GTRZ_INSTALL_ENROLLMENT_CODE -ErrorAction SilentlyContinue
    }
    if ($verification.ExitCode -eq 2) {
      $EnrollmentCode = Read-Host 'Cole o codigo temporario criado no PC administrador'
      if ([string]::IsNullOrWhiteSpace($EnrollmentCode)) { throw 'Vinculo nao concluido: codigo nao informado.' }
    } elseif ($verification.ExitCode -ne 0) {
      throw 'O app nao conseguiu confirmar o vinculo com a nuvem. Verifique o codigo e a conexao.'
    }
  } while ($verification.ExitCode -eq 2)

  Write-Host "GTRZ System $ReleaseTag instalado e vinculado. Dados locais preservados."
  Start-Process -FilePath $desktopExe
} finally {
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force
  }
}
