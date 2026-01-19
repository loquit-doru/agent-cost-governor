Param(
  [Parameter(Mandatory = $false)]
  [ValidateSet('prod')]
  [string]$Env = 'prod',

  [Parameter(Mandatory = $false)]
  [string]$GovernorBaseUrl = 'https://governor.proceedgate.dev',

  [Parameter(Mandatory = $false)]
  [string]$WorkspaceId = 'acme',

  [Parameter(Mandatory = $false)]
  [ValidateSet('create', 'rotate', 'revoke', 'status')]
  [string]$Action = 'create',

  [Parameter(Mandatory = $false)]
  [switch]$GenerateAdminKey,

  [Parameter(Mandatory = $false)]
  [string]$AdminKey,

  [Parameter(Mandatory = $false)]
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'

function New-RandomBase64UrlKey([int]$bytes = 32) {
  $buf = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buf)
  $b64 = [Convert]::ToBase64String($buf)
  return $b64.Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Normalize-Origin([string]$raw) {
  $u = [Uri]$raw
  return "$($u.Scheme)://$($u.Host)" + $(if ($u.IsDefaultPort) { '' } else { ":$($u.Port)" })
}

Write-Host "ProceedGate prod provisioning (workspace auth)" -ForegroundColor Cyan

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$workerDir = Join-Path $repoRoot 'worker'
if (!(Test-Path $workerDir)) {
  throw "Worker directory not found: $workerDir"
}

if ([string]::IsNullOrWhiteSpace($WorkspaceId)) {
  throw "WorkspaceId is required"
}

$origin = Normalize-Origin $GovernorBaseUrl
Write-Host "- governor=$origin" -ForegroundColor Gray
Write-Host "- env=$Env" -ForegroundColor Gray
Write-Host "- workspace_id=$WorkspaceId" -ForegroundColor Gray
Write-Host "- action=$Action" -ForegroundColor Gray

# Choose admin key
if ($GenerateAdminKey) {
  $AdminKey = New-RandomBase64UrlKey 32
  Write-Host "- generated API_ADMIN_KEY (save this): $AdminKey" -ForegroundColor Yellow
} elseif ([string]::IsNullOrWhiteSpace($AdminKey)) {
  $secure = Read-Host "Enter API_ADMIN_KEY (will not echo)" -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $AdminKey = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ([string]::IsNullOrWhiteSpace($AdminKey)) {
  throw "AdminKey is required (use -GenerateAdminKey or -AdminKey or interactive prompt)"
}

if ($Action -ne 'status') {
  Push-Location $workerDir
  try {
    Write-Host "- setting secret API_ADMIN_KEY via wrangler (env=$Env)" -ForegroundColor Gray
    # Pipe value to avoid printing it.
    $AdminKey | npx wrangler secret put API_ADMIN_KEY --env $Env | Out-Null
  } finally {
    Pop-Location
  }
} else {
  Write-Host "- status mode: skipping wrangler secret update" -ForegroundColor Gray
}

if ($Action -eq 'create') {
  $endpoint = '/v1/workspaces/create'
} elseif ($Action -eq 'rotate') {
  $endpoint = '/v1/workspaces/rotate_key'
} elseif ($Action -eq 'revoke') {
  $endpoint = '/v1/workspaces/revoke_key'
} elseif ($Action -eq 'status') {
  $endpoint = '/v1/workspaces/status'
} else {
  throw "Invalid Action=$Action"
}

Write-Host "- calling $endpoint" -ForegroundColor Gray

if ($Action -eq 'status') {
  $headers = @{ 'x-admin-key' = $AdminKey }
  try {
    $resp = Invoke-RestMethod -Method Get -Uri "$origin$endpoint?workspace_id=$([Uri]::EscapeDataString($WorkspaceId))" -Headers $headers
  } catch {
    throw "Request failed ($endpoint): $($_.Exception.Message)"
  }
} else {
  $body = @{ workspace_id = $WorkspaceId } | ConvertTo-Json
  $headers = @{ 'content-type' = 'application/json'; 'x-admin-key' = $AdminKey }
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$origin$endpoint" -Headers $headers -Body $body
  } catch {
    throw "Request failed ($endpoint): $($_.Exception.Message)"
  }
}

if (-not $resp -or -not $resp.ok) {
  throw "Unexpected response: $($resp | ConvertTo-Json -Compress)"
}

$ws = [string]$resp.workspace_id
if ($Action -eq 'status') {
  $hasKey = [bool]($resp.has_key)
  Write-Host "Done." -ForegroundColor Green
  Write-Host "workspace_id=$ws" -ForegroundColor Green
  Write-Host "has_key=$hasKey" -ForegroundColor Green
  if ($hasKey) {
    if ($resp.created_at) { Write-Host "created_at=$($resp.created_at)" -ForegroundColor Green }
    if ($resp.updated_at) { Write-Host "updated_at=$($resp.updated_at)" -ForegroundColor Green }
  }

  if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $safeName = $ws -replace '[^a-zA-Z0-9_-]', '_'
    $OutFile = Join-Path $repoRoot "tmp\\workspace_${safeName}_status.json"
  }

  $dir = Split-Path -Parent $OutFile
  if ($dir -and !(Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  ($resp | ConvertTo-Json -Depth 5) | Set-Content -Path $OutFile -Encoding UTF8
  Write-Host "Saved to $OutFile" -ForegroundColor Gray
  exit 0
}
if ($Action -eq 'revoke') {
  Write-Host "Done." -ForegroundColor Green
  Write-Host "workspace_id=$ws" -ForegroundColor Green
  Write-Host "revoked=true" -ForegroundColor Green

  if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $safeName = $ws -replace '[^a-zA-Z0-9_-]', '_'
    $OutFile = Join-Path $repoRoot "tmp\\workspace_${safeName}_revoked.txt"
  }

  $dir = Split-Path -Parent $OutFile
  if ($dir -and !(Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  "workspace_id=$ws`nrevoked=true`napi_admin_key=$AdminKey`n" | Set-Content -Path $OutFile -Encoding UTF8
  Write-Host "Saved to $OutFile" -ForegroundColor Gray
  exit 0
}

if ([string]::IsNullOrWhiteSpace($resp.api_key)) {
  throw "Response missing api_key: $($resp | ConvertTo-Json -Compress)"
}

$apiKey = [string]$resp.api_key

Write-Host "Done." -ForegroundColor Green
Write-Host "workspace_id=$ws" -ForegroundColor Green
Write-Host "api_key=$apiKey" -ForegroundColor Green
Write-Host "" 
Write-Host "Runner example:" -ForegroundColor Cyan
Write-Host "  `$env:PROCEEDGATE_API_KEY = '$apiKey'" -ForegroundColor Cyan
Write-Host "  node runner/dist/cli.js run examples/demo-task.json --governor $origin --api-key `$env:PROCEEDGATE_API_KEY --tx-hash 0xstub" -ForegroundColor Cyan

if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $safeName = $ws -replace '[^a-zA-Z0-9_-]', '_'
  $OutFile = Join-Path $repoRoot "tmp\\workspace_${safeName}_api_key.txt"
}

$dir = Split-Path -Parent $OutFile
if ($dir -and !(Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
}

"workspace_id=$ws`napi_key=$apiKey`napi_admin_key=$AdminKey`n" | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "Saved to $OutFile" -ForegroundColor Gray
