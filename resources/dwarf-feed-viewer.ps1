<#
.SYNOPSIS
  Live viewer for a dwarf's transcript, opened by DwarfAI-Miners when no existing
  terminal window can be focused for a click-to-focus session (see
  src/main/terminalLauncher.ts and src/main/runtime.ts).

.DESCRIPTION
  Pretty-prints the tail of a JSONL transcript (Claude Code session,
  Claude Code subagent, or Codex CLI rollout — the record shapes differ, see
  ConvertTo-DisplayMessage below), then follows the file live like `tail -f`
  so new turns keep appearing as the agent works.

  This is a debugging/visibility aid, not a parser of record: it only needs
  to be readable, not exhaustive. A record it does not recognize is silently
  skipped rather than causing an error.

.PARAMETER Path
  Full path to the transcript file to tail.

.PARAMETER Title
  Display name for the dwarf, shown in the header and the console title.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [string]$Title
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "$Title - DwarfAI-Miners"

Write-Host "=== $Title ===" -ForegroundColor Yellow
Write-Host "Transcript: $Path" -ForegroundColor DarkGray
Write-Host ''

<#
  Extract { role; text } from one parsed JSON record, or $null when the
  record carries nothing worth showing (tool results, meta lines, events
  other than a message). Mirrors (loosely — this only needs to be readable)
  the TypeScript extractors in src/main/providers/*/parse.ts.
#>
function ConvertTo-DisplayMessage {
  param($Record)

  if ($null -eq $Record -or $null -eq $Record.type) { return $null }

  # Claude Code session and subagent transcripts: {type, message: {...}}
  if ($Record.type -eq 'assistant' -and $Record.message) {
    $texts = @()
    foreach ($block in @($Record.message.content)) {
      if ($null -ne $block -and $block.type -eq 'text' -and $block.text) {
        $texts += [string]$block.text
      }
    }
    if ($texts.Count -gt 0) {
      return [pscustomobject]@{ role = 'assistant'; text = ($texts -join "`n") }
    }
    return $null
  }
  if ($Record.type -eq 'user' -and $Record.isMeta -ne $true -and $Record.message) {
    $content = $Record.message.content
    if ($content -is [string] -and -not $content.StartsWith('<')) {
      return [pscustomobject]@{ role = 'user'; text = $content }
    }
    return $null
  }

  # Codex CLI rollouts: {type, payload: {...}}
  if ($Record.type -eq 'event_msg' -and $Record.payload -and $Record.payload.type -eq 'user_message') {
    if ($Record.payload.message) {
      return [pscustomobject]@{ role = 'user'; text = [string]$Record.payload.message }
    }
    return $null
  }
  if ($Record.type -eq 'response_item' -and $Record.payload -and
    $Record.payload.type -eq 'message' -and $Record.payload.role -eq 'assistant') {
    $texts = @()
    foreach ($block in @($Record.payload.content)) {
      if ($null -ne $block -and $block.type -eq 'output_text' -and $block.text) {
        $texts += [string]$block.text
      }
    }
    if ($texts.Count -gt 0) {
      return [pscustomobject]@{ role = 'assistant'; text = ($texts -join "`n") }
    }
    return $null
  }

  return $null
}

function ConvertFrom-JsonLine {
  param([string]$Line)
  $trimmed = $Line.Trim()
  if ($trimmed -eq '') { return $null }
  try {
    return $trimmed | ConvertFrom-Json -ErrorAction Stop
  } catch {
    # Partial or corrupt line (e.g. a byte-offset tail read mid-write) — skip.
    return $null
  }
}

function Write-DisplayMessage {
  param($Message)
  if ($Message.role -eq 'assistant') {
    $label = 'Agent   '
    $color = 'Cyan'
  } else {
    $label = 'Request '
    $color = 'White'
  }
  $text = [string]$Message.text
  $maxChars = 600
  if ($text.Length -gt $maxChars) {
    $text = $text.Substring(0, $maxChars) + ' [...]'
  }
  Write-Host "[$label] " -ForegroundColor $color -NoNewline
  Write-Host $text
  Write-Host ''
}

function Get-DisplayMessages {
  param([string[]]$Lines)
  $messages = @()
  foreach ($line in $Lines) {
    $record = ConvertFrom-JsonLine -Line $line
    $message = ConvertTo-DisplayMessage -Record $record
    if ($null -ne $message) { $messages += $message }
  }
  return $messages
}

# A brand-new session's transcript file can lag a beat behind the process
# actually starting — wait briefly instead of failing immediately.
$waited = 0
while (-not (Test-Path -LiteralPath $Path) -and $waited -lt 30) {
  Start-Sleep -Seconds 1
  $waited++
}

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Host "Transcript not found after waiting: $Path" -ForegroundColor Red
  Write-Host 'It will keep being watched in case it appears.' -ForegroundColor DarkGray
} else {
  # Bounded tail read: readable history without loading a huge file whole.
  $tailLines = Get-Content -LiteralPath $Path -Encoding UTF8 -Tail 400
  $recentMessages = Get-DisplayMessages -Lines $tailLines | Select-Object -Last 30
  foreach ($message in $recentMessages) { Write-DisplayMessage -Message $message }
}

Write-Host '--- following live (Ctrl+C to stop) ---' -ForegroundColor DarkGray
Write-Host ''

# Waits for the file if it still doesn't exist, then streams only lines
# appended from this point on (the last-30 block above already covered the
# existing tail).
Get-Content -LiteralPath $Path -Wait -Tail 0 -Encoding UTF8 | ForEach-Object {
  $message = ConvertTo-DisplayMessage -Record (ConvertFrom-JsonLine -Line $_)
  if ($null -ne $message) { Write-DisplayMessage -Message $message }
}
