# Starts unelevated-inner.ps1 as a standard local user (scripts/ci/run-unelevated.mjs; ISSUE-051).
#
# .NET `ProcessStartInfo` with `UserName` calls CreateProcessWithLogonW: the user is logged on with its profile
# (LoadUserProfile), and the new process gets its own profile's environment and the job's window station and desktop,
# which Windows opens to the user. The command's output, merged with its errors by the inner script, is streamed line by
# line into this process's output, so it reaches the job log as it is written; this script exits with the command's
# exit code. The password comes from DWARFAI_CI_USER_PASSWORD, never from argv.
param(
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$SpecFile,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$inner = Join-Path $PSScriptRoot 'unelevated-inner.ps1'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $powershell
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$inner`" -SpecFile `"$SpecFile`" -WorkDir `"$WorkDir`""
$psi.UserName = $User
$psi.Domain = $env:COMPUTERNAME
$psi.Password = ConvertTo-SecureString $env:DWARFAI_CI_USER_PASSWORD -AsPlainText -Force
$psi.LoadUserProfile = $true
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = $utf8
$psi.StandardErrorEncoding = $utf8
$psi.WorkingDirectory = $WorkDir

$process = [System.Diagnostics.Process]::Start($psi)
$errors = $process.StandardError.ReadToEndAsync()
$reader = $process.StandardOutput
$next = $reader.ReadLineAsync()
# A process the command left behind may still hold the output pipe: once the command's process exited, what is
# already written is drained for a few seconds, and the wait ends.
$drainUntil = $null
while ($true) {
  if ($next.Wait(250)) {
    $line = $next.Result
    if ($null -eq $line) { break }
    [Console]::Out.WriteLine($line)
    $next = $reader.ReadLineAsync()
    continue
  }
  if ($process.HasExited) {
    if ($null -eq $drainUntil) { $drainUntil = (Get-Date).AddSeconds(5) }
    elseif ((Get-Date) -gt $drainUntil) { break }
  }
}
$process.WaitForExit()
if ($errors.Wait(5000) -and $errors.Result.Length -gt 0) { [Console]::Out.Write($errors.Result) }
[Console]::Out.Flush()
exit $process.ExitCode
