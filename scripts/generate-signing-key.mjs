#!/usr/bin/env node
/**
 * Generate a stable P-256 signing key for ProceedGate Governor
 * 
 * Usage:
 *   node scripts/generate-signing-key.mjs
 * 
 * Then add the output to Cloudflare secrets:
 *   npx wrangler secret put GOVERNOR_SIGNING_JWK --env production
 */

import { generateKeyPair, exportJWK } from 'jose';

async function generateSigningKey() {
  console.log('🔐 Generating P-256 signing key for ProceedGate...\n');

  // Generate EC P-256 key pair using jose library
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });

  // Export private key as JWK
  const privateJwk = await exportJWK(privateKey);
  
  // Add required fields
  privateJwk.kid = 'k1';  // Key ID - keep stable across deploys
  privateJwk.use = 'sig';
  privateJwk.alg = 'ES256';

  // Export public key as JWK (for reference)
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'k1';
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';

  const privateJson = JSON.stringify(privateJwk);
  
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PRIVATE KEY (GOVERNOR_SIGNING_JWK) - KEEP SECRET!');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  console.log(privateJson);
  console.log();
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  
  console.log('📋 To set this in Cloudflare Workers:\n');
  console.log('  Option 1 - Interactive:');
  console.log('    npx wrangler secret put GOVERNOR_SIGNING_JWK');
  console.log('    (paste the JSON above when prompted)\n');
  
  console.log('  Option 2 - Direct (PowerShell):');
  console.log(`    $jwk = '${privateJson}'`);
  console.log('    echo $jwk | npx wrangler secret put GOVERNOR_SIGNING_JWK\n');
  
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PUBLIC KEY (for verification/debugging only)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  console.log(JSON.stringify(publicJwk, null, 2));
  console.log();
  
  console.log('✅ Key generated successfully!');
  console.log();
  console.log('⚠️  IMPORTANT:');
  console.log('   - Save this private key securely (password manager, vault)');
  console.log('   - Never commit it to git');
  console.log('   - The kid "k1" should stay stable across deploys');
  console.log('   - Rotating the key will invalidate all existing proceed_tokens');
}

generateSigningKey().catch(console.error);
