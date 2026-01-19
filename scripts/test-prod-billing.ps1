[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$BaseUrl = "https://governor.proceedgate.dev",

  [Parameter(Mandatory = $true)]
  [string]$WorkspaceId,

  [Parameter(Mandatory = $false)]
  [int]$Credits = 1,

  [Parameter(Mandatory = $true)]
  [string]$ApiKeyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-ApiKey([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "ApiKeyFile not found: $Path"
  }
  $raw = (Get-Content -LiteralPath $Path -Raw)
  if (-not $raw) {
    throw "ApiKeyFile is empty: $Path"
  }

  $text = $raw.Trim()
  if (-not $text) {
    throw "ApiKeyFile is empty: $Path"
  }

  # Supported formats:
  # - plain key
  # - JSON containing api_key
  # - text containing api_key: <key>
  # - text containing Authorization: Bearer <key>
  $m = [regex]::Match($text, '(?im)\bapi[_-]?key\b\s*[:=]\s*([A-Za-z0-9_-]{20,})')
  if ($m.Success) { return $m.Groups[1].Value }

  $m = [regex]::Match($text, '(?im)\bBearer\s+([A-Za-z0-9_-]{20,})')
  if ($m.Success) { return $m.Groups[1].Value }

  # Fallback: first base64url-ish token of reasonable length.
  $m = [regex]::Match($text, '([A-Za-z0-9_-]{20,})')
  if ($m.Success) { return $m.Groups[1].Value }

  throw "Could not parse API key from file: $Path"
}

function Invoke-Json([string]$Method, [string]$Uri, [hashtable]$Headers, [object]$Body = $null) {
  try {
    if ($null -eq $Body) {
      return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
    }

    $json = $Body | ConvertTo-Json -Compress
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body $json
  } catch {
    $ex = $_.Exception

    # PowerShell's web cmdlets may throw different exception types depending on version.
    # Prefer structured info when available; otherwise fall back to ErrorDetails.
    $status = $null
    $bodyText = $null

    if ($null -ne $ex -and $ex.PSObject.Properties.Match('Response').Count -gt 0 -and $null -ne $ex.Response) {
      try {
        $status = [int]$ex.Response.StatusCode
      } catch { }
      try {
        $reader = New-Object System.IO.StreamReader($ex.Response.GetResponseStream())
        $bodyText = $reader.ReadToEnd()
      } catch { }
    }

    if (-not $bodyText -and $null -ne $_.ErrorDetails -and $_.ErrorDetails.Message) {
      $bodyText = $_.ErrorDetails.Message
    }

    if ($null -ne $status -or $bodyText) {
      $s = if ($null -ne $status) { "HTTP $status" } else { "HTTP error" }
      $t = if ($bodyText) { "`n$bodyText" } else { "" }
      throw "$s from $Uri$t"
    }

    throw
  }
}

$apiKey = Read-ApiKey -Path $ApiKeyFile
$base = $BaseUrl.TrimEnd('/')

$headers = @{
  Authorization  = "Bearer $apiKey"
  'content-type' = 'application/json'
}

Write-Host "POST $base/v1/billing/quote (workspace_id=$WorkspaceId, credits=$Credits)" -ForegroundColor Cyan
$quote = Invoke-Json -Method 'POST' -Uri "$base/v1/billing/quote" -Headers $headers -Body @{ workspace_id = $WorkspaceId; credits = $Credits }
$quote | ConvertTo-Json -Depth 20

Write-Host "GET  $base/v1/billing/balance?workspace_id=..." -ForegroundColor Cyan
$ws = [System.Uri]::EscapeDataString($WorkspaceId)
$balance = Invoke-Json -Method 'GET' -Uri "$base/v1/billing/balance?workspace_id=$ws" -Headers $headers
$balance | ConvertTo-Json -Depth 20
