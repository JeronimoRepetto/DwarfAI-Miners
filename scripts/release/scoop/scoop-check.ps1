#Requires -Version 7
# P-SCOOP: the Scoop channel of the Windows package leg (20 §6; ADR-027 item 1; ADR-016 item 7; OQ-59; 13 FM-128;
# ISSUE-275). Owner decision 2026-10-24: this check replaces the manual Windows VM check of the issue, since the
# owner has no Windows VM. It runs on the hosted Windows runner after `pnpm package` and SHA256SUMS:
#
#   pwsh ./scripts/release/scoop/scoop-check.ps1 -Release release
#
# 1. Installs Scoop with its documented installer and `-RunAsAdmin` (the hosted runner runs every step elevated).
# 2. Serves the release folder on loopback (serve-release.mjs) and writes the bucket manifest with the generator
#    (scoop-manifest.mjs): every 20 §6 field, the hash from SHA256SUMS, the url moved to the loopback server. The
#    manifest goes into a local git bucket, `dwarfai-ci`; nothing of the app is downloaded from the internet.
# 3. `scoop install`: Scoop checks the hash against the real zip; the exe, the resources, the shim and the Start menu
#    shortcut exist; no `--revert-integrations` ran.
# 4. `scoop update` to a bumped version of the same zip: the new version is current, and no `--revert-integrations`
#    ran (an update never reverts, OQ-59). Whether Scoop ran `pre_uninstall` at all is printed (S-027-1 evidence).
# 5. `scoop uninstall`: `pre_uninstall` ran `--revert-integrations` exactly once, before Scoop went on (the hook waits
#    for it), and the app folder and shim are gone.
#
# Which step ran the command is read from the `host.revert-integrations` records the UI writes into its log
# segments (revert-log.mjs), whatever the revert's outcome. On this elevated runner the Host copy refuses to start
# (ADR-002 D6, exit 65), so the record's outcome is `failed` with `HOST_EXIT_65`; the revert itself is proven by
# ISSUE-225's tests. Any other failed outcome fails the check. It prints one `P-SCOOP ok: …` or `P-SCOOP FAIL: …` line.
param(
  [Parameter(Mandatory = $true)] [string] $Release
)

# Not strict mode: it is inherited by the Scoop scripts this one calls.
$ErrorActionPreference = 'Stop'

function Fail([string] $Message) {
  Write-Host "::error::P-SCOOP FAIL: $Message"
  Write-Host "P-SCOOP FAIL: $Message"
  exit 1
}

if (-not $IsWindows) { Fail 'the Scoop check runs on Windows only' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
$releaseDir = (Resolve-Path $Release).Path
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$zip = "DwarfAI-Miners-$version-win-x64.zip"
$bumped = "$version.1"
if (-not (Test-Path (Join-Path $releaseDir $zip) -PathType Leaf)) { Fail "$Release holds no $zip" }
if (-not (Test-Path (Join-Path $releaseDir 'SHA256SUMS') -PathType Leaf)) { Fail "$Release holds no SHA256SUMS" }

# The UI's log folder of the default profile (ADR-026 item 1; `20` §6 notes).
$logs = Join-Path $env:APPDATA 'DwarfAI-Miners' 'logs'
function Get-RevertEntries {
  $json = node (Join-Path $repo 'scripts' 'release' 'scoop' 'revert-log.mjs') $logs
  if ($LASTEXITCODE -ne 0) { Fail 'revert-log.mjs failed' }
  return , @($json | ConvertFrom-Json)
}

# Runs one Scoop command, echoes its whole output (Write-Host included) and answers it; a non-zero exit fails.
function Invoke-Scoop([string[]] $Arguments) {
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  Write-Host "> scoop $($Arguments -join ' ')"
  $output = & scoop @Arguments *>&1 | Out-String
  $code = $LASTEXITCODE
  Write-Host $output
  if ($code -ne 0) { Fail "scoop $($Arguments -join ' ') exited $code" }
  return $output
}

function Assert-Path([string] $Path, [string] $What) {
  if (-not (Test-Path $Path)) { Fail "$What is missing: $Path" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) "dwarfai-scoop-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
$server = $null
try {
  # ---- 1. Scoop, through its documented installer (https://get.scoop.sh, `-RunAsAdmin` for an elevated shell).
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
  $installer = Join-Path $work 'install-scoop.ps1'
  Invoke-RestMethod -Uri 'https://get.scoop.sh' -OutFile $installer
  & {
    $ErrorActionPreference = 'Continue'
    & $installer -RunAsAdmin
  }
  $scoopDir = if ($env:SCOOP) { $env:SCOOP } else { Join-Path $env:USERPROFILE 'scoop' }
  $env:PATH = "$(Join-Path $scoopDir 'shims');$env:PATH"
  Assert-Path (Join-Path $scoopDir 'shims' 'scoop.ps1') 'the Scoop shim'

  # ---- 2. The loopback server and the local bucket.
  $urlFile = Join-Path $work 'url.txt'
  $server = Start-Process -FilePath (Get-Command node).Source -NoNewWindow -PassThru -ArgumentList @(
    "`"$(Join-Path $repo 'scripts' 'release' 'scoop' 'serve-release.mjs')`"",
    "`"$releaseDir`"",
    "`"$urlFile`""
  )
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path $urlFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path $urlFile)) { Fail 'the loopback release server did not start' }
  $base = (Get-Content $urlFile -Raw).Trim()

  $bucket = Join-Path $work 'bucket'
  $manifestFile = Join-Path $bucket 'bucket' 'dwarfai.json'
  node (Join-Path $repo 'scripts' 'release' 'scoop-manifest.mjs') --version $version `
    --sums (Join-Path $releaseDir 'SHA256SUMS') --url "$base$zip" --out $manifestFile
  if ($LASTEXITCODE -ne 0) { Fail 'scoop-manifest.mjs failed' }
  Get-Content $manifestFile -Raw | Write-Host
  git -C $bucket init --quiet
  git -C $bucket add --all
  git -C $bucket -c user.name=dwarfai-ci -c user.email=dwarfai-ci@localhost commit --quiet -m "dwarfai $version"
  if ($LASTEXITCODE -ne 0) { Fail 'the local bucket commit failed' }
  Invoke-Scoop @('bucket', 'add', 'dwarfai-ci', $bucket) | Out-Null

  $revertsBefore = (Get-RevertEntries).Count
  $app = Join-Path $scoopDir 'apps' 'dwarfai'
  $current = Join-Path $app 'current'
  $shim = Join-Path $scoopDir 'shims' 'DwarfAI-Miners.shim'
  $shortcut = Join-Path $env:APPDATA 'Microsoft' 'Windows' 'Start Menu' 'Programs' 'Scoop Apps' 'DwarfAI-Miners.lnk'

  # ---- 3. Install.
  $installOutput = Invoke-Scoop @('install', 'dwarfai-ci/dwarfai')
  Assert-Path (Join-Path $current 'DwarfAI-Miners.exe') 'the installed exe'
  Assert-Path (Join-Path $current 'resources' 'app.asar') 'the installed resources'
  Assert-Path $shim 'the bin shim'
  Assert-Path $shortcut 'the Start menu shortcut'
  $installed = (Get-Content (Join-Path $current 'manifest.json') -Raw | ConvertFrom-Json).version
  if ($installed -ne $version) { Fail "install left version $installed current, not $version" }
  if ($installOutput -match 'pre_uninstall') { Fail 'scoop install ran pre_uninstall' }
  if ((Get-RevertEntries).Count -ne $revertsBefore) { Fail 'scoop install ran --revert-integrations' }

  # ---- 4. Update: the same zip under a bumped version.
  $manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
  $manifest.version = $bumped
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -Path $manifestFile -Encoding utf8NoBOM
  git -C $bucket -c user.name=dwarfai-ci -c user.email=dwarfai-ci@localhost commit --quiet --all -m "dwarfai $bumped"
  if ($LASTEXITCODE -ne 0) { Fail 'the bumped bucket commit failed' }
  git -C (Join-Path $scoopDir 'buckets' 'dwarfai-ci') pull --quiet --ff-only
  if ($LASTEXITCODE -ne 0) { Fail 'the installed bucket did not pull the bumped manifest' }
  $updateOutput = Invoke-Scoop @('update', 'dwarfai')
  $updated = (Get-Content (Join-Path $current 'manifest.json') -Raw | ConvertFrom-Json).version
  if ($updated -ne $bumped) { Fail "update left version $updated current, not $bumped" }
  Assert-Path (Join-Path $current 'DwarfAI-Miners.exe') 'the updated exe'
  if ((Get-RevertEntries).Count -ne $revertsBefore) { Fail 'scoop update ran --revert-integrations' }
  $hookOnUpdate = if ($updateOutput -match 'Running pre_uninstall script') { 'yes' } else { 'no' }

  # ---- 5. Uninstall.
  $uninstallOutput = Invoke-Scoop @('uninstall', 'dwarfai')
  if ($uninstallOutput -notmatch 'Running pre_uninstall script') { Fail 'scoop uninstall did not run pre_uninstall' }
  $reverts = Get-RevertEntries
  if ($reverts.Count -ne $revertsBefore + 1) {
    Fail "scoop uninstall left $($reverts.Count - $revertsBefore) --revert-integrations records, not 1"
  }
  $revert = $reverts[-1]
  $elevatedRefusal = $revert.outcome -eq 'failed' -and $revert.errCode -eq 'HOST_EXIT_65'
  if ($revert.outcome -ne 'ok' -and -not $elevatedRefusal) {
    Fail "the uninstall's revert answered outcome=$($revert.outcome) errCode=$($revert.errCode)"
  }
  if (Test-Path $app) { Fail "scoop uninstall left $app" }
  if (Test-Path $shim) { Fail "scoop uninstall left $shim" }

  Write-Host ("P-SCOOP ok: install $version (hash from SHA256SUMS checked by Scoop; exe, shim and shortcut present; " +
    "no revert), update to $bumped (pre_uninstall ran: $hookOnUpdate; no revert), uninstall (revert ran once, " +
    "outcome=$($revert.outcome) errCode=$($revert.errCode); app folder and shim removed)")
}
finally {
  if ($null -ne $server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
