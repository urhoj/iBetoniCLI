#requires -Version 5.1
<#
.SYNOPSIS
  End-to-end round-trip for `ib message chat` send -> read -> delete against a
  betoni.online backend. Verifies the soft-delete route + the `delete` command.

.DESCRIPTION
  Posts two messages to a thread (one framed as the customer, one as the
  provider), lists them, soft-deletes both (newest-first, which satisfies the
  "author may delete only an unanswered own message" rule regardless of caller
  tier), then confirms they are gone from the read.

  Auth: set $env:IB_TOKEN to a betoni.online JWT whose personId is a participant
  of the thread, OR have an `ib auth login` session whose token validates against
  -Endpoint. The new DELETE route is deploy-gated, so against prod this script's
  delete steps fail until puminet5api ships them — run it against a local backend
  (npm run dev:backend) that already has the route.

  NOTE: both sends are attributed to the caller's single participant row, so with
  one personId the "provider" message is customer-attributed by body only.

.PARAMETER Endpoint
  Backend base URL. Default http://127.0.0.1:8080 (local dev backend).

.PARAMETER Thread
  Thread id to exercise. Default 3 (the tarjous #23 customer thread).

.PARAMETER Bin
  Path to the built ib binary. Default: ../dist/bin/ib.js next to this script.

.EXAMPLE
  $env:IB_TOKEN = "<jwt>"
  ./roundtrip-message-chat.ps1 -Endpoint http://127.0.0.1:8080 -Thread 3
#>
param(
  [string]$Endpoint = "http://127.0.0.1:8080",
  [int]$Thread = 3,
  [string]$Bin = (Join-Path $PSScriptRoot "..\dist\bin\ib.js")
)

# Continue (not Stop): a native command writing to stderr is wrapped as a
# NativeCommandError in PS 5.1, which under Stop would abort even on exit 0. We
# pass --quiet (suppresses ib's acting-as write diagnostic) and gate on the exit
# code instead; `throw` still terminates the run on a real failure.
$ErrorActionPreference = "Continue"

function Invoke-Ib {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$IbArgs)
  $out = & node $Bin @IbArgs --endpoint $Endpoint --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "ib $($IbArgs -join ' ') failed (exit $LASTEXITCODE) -- see stderr above"
  }
  return ($out | ConvertFrom-Json)
}

Write-Host "== ib message chat round-trip on thread $Thread @ $Endpoint ==" -ForegroundColor Cyan

# 1. customer message
$m1 = Invoke-Ib message chat send "$Thread" --body "ROUNDTRIP customer hei" --source cli --reason "roundtrip test"
Write-Host ("1) sent customer  message -> messageId={0}" -f $m1.messageId)

# 2. provider-framed message (same personId -> same participant attribution)
$m2 = Invoke-Ib message chat send "$Thread" --body "ROUNDTRIP provider vastaus" --source cli --reason "roundtrip test"
Write-Host ("2) sent provider  message -> messageId={0}" -f $m2.messageId)

# 3. read
$list = Invoke-Ib message chat list "$Thread"
$ids = @($list.items | ForEach-Object { $_.messageId })
Write-Host ("3) list -> {0} messages; ids: {1}" -f $list.count, ($ids -join ", "))
if ($ids -notcontains $m1.messageId -or $ids -notcontains $m2.messageId) {
  throw "Expected both sent messages to be listed"
}

# 4. delete newest-first (the m2-then-m1 order keeps each target the tail)
$d2 = Invoke-Ib message chat delete "$($m2.messageId)" --thread "$Thread" --reason "roundtrip cleanup"
Write-Host ("4a) deleted messageId={0} -> deleted={1}" -f $m2.messageId, $d2.deleted)
$d1 = Invoke-Ib message chat delete "$($m1.messageId)" --thread "$Thread" --reason "roundtrip cleanup"
Write-Host ("4b) deleted messageId={0} -> deleted={1}" -f $m1.messageId, $d1.deleted)

# 5. confirm gone
$after = Invoke-Ib message chat list "$Thread"
$afterIds = @($after.items | ForEach-Object { $_.messageId })
Write-Host ("5) list -> {0} messages; ids: {1}" -f $after.count, ($afterIds -join ", "))
if ($afterIds -contains $m1.messageId -or $afterIds -contains $m2.messageId) {
  throw "Deleted messages still visible -- soft-delete not applied"
}

Write-Host "== ROUND-TRIP OK: 2 sent, listed, soft-deleted, gone ==" -ForegroundColor Green
