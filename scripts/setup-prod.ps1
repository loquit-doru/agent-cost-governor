Param(
  [Parameter(Mandatory = $true)]
  [string]$X402Recipient,

  [Parameter(Mandatory = $true)]
  [string]$BaseRpcUrl,

  [Parameter(Mandatory = $false)]
  [string]$FacilitatorKey = $( [guid]::NewGuid().ToString('N') ),

  [Parameter(Mandatory = $false)]
  [ValidateSet('prod')]
  [string]$Env = 'prod'
)

$ErrorActionPreference = 'Stop'

Write-Host "Setting ProceedGate Governor prod secrets/vars (env=$Env)" -ForegroundColor Cyan

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$workerDir = Join-Path $repoRoot 'worker'

if (!(Test-Path $workerDir)) {
  throw "Worker directory not found: $workerDir"
}

Push-Location $workerDir
try {
  # Basic validation
  $x = $X402Recipient.Trim().ToLower()
  if ($x -notmatch '^0x[0-9a-f]{40}$') {
    throw "X402Recipient must be an EVM address like 0xabc... (40 hex chars). Got: $X402Recipient"
  }

  if ([string]::IsNullOrWhiteSpace($BaseRpcUrl)) {
    throw "BaseRpcUrl is required"
  }

  # 1) Generate a stable signing key (private JWK) and store as secret
  Write-Host "- Generating GOVERNOR_SIGNING_JWK" -ForegroundColor Gray
  $jwk = node .\scripts\gen-signing-jwk.mjs
  if ([string]::IsNullOrWhiteSpace($jwk)) {
    throw "Failed to generate JWK"
  }

  # Pipe secrets into wrangler without printing them
  Write-Host "- Setting secrets via wrangler" -ForegroundColor Gray
  $jwk | npx wrangler secret put GOVERNOR_SIGNING_JWK --env $Env | Out-Null
  $FacilitatorKey | npx wrangler secret put FACILITATOR_KEY --env $Env | Out-Null
  $BaseRpcUrl | npx wrangler secret put BASE_RPC_URL --env $Env | Out-Null

  # 2) Tell you what to set in wrangler.toml / dashboard
  Write-Host "Done. Next steps:" -ForegroundColor Green
  Write-Host "1) Set X402_RECIPIENT to your wallet address:" -ForegroundColor Green
  Write-Host "   - worker/wrangler.toml (env.$Env.vars.X402_RECIPIENT) OR Cloudflare dashboard vars" -ForegroundColor Green
  Write-Host "   - Value: $X402Recipient" -ForegroundColor Green
  Write-Host "2) Ensure PAYMENT_VERIFY_MODE=facilitator and FACILITATOR_URL points to /x402/verify" -ForegroundColor Green
  Write-Host "3) Deploy: npm run deploy:worker" -ForegroundColor Green

  Write-Host "FacilitatorKey was generated (keep it secret)." -ForegroundColor Yellow
} finally {
  Pop-Location
}
