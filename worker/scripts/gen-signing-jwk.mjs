import { exportJWK, generateKeyPair } from 'jose';

// Outputs a P-256 ES256 private JWK JSON string suitable for GOVERNOR_SIGNING_JWK.
// Note: This is a *private* key. Treat output as a secret.

const { privateKey, publicKey } = await generateKeyPair('ES256');

const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);

// Ensure the private JWK includes public coordinates and a kid.
priv.kid = priv.kid || 'k1';
priv.use = 'sig';
priv.alg = 'ES256';

// Sanity: make sure x/y exist (they should for EC keys)
if (!priv.x || !priv.y || !priv.d) {
  throw new Error('Generated JWK missing required fields (x/y/d)');
}

// Print ONLY the private JWK JSON.
process.stdout.write(JSON.stringify(priv));
