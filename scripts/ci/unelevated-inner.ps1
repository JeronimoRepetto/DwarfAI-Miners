# Runs as the standard local user (scripts/ci/start-as-user.ps1; ISSUE-051): takes the job's environment from the
# spec file over its own profile's (the profile folders, the temporary folder and the user name stay the user's own),
# then runs the command through cmd.exe with its errors merged into its output, and exits with its exit code.
param(
  [Parameter(Mandatory = $true)][string]$SpecFile,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$spec = Get-Content -Raw -LiteralPath $SpecFile -Encoding UTF8 | ConvertFrom-Json
foreach ($variable in $spec.env.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($variable.Name, [string]$variable.Value, 'Process')
}
Set-Location -LiteralPath $WorkDir
& (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /s /c "$($spec.command) 2>&1"
exit $LASTEXITCODE
