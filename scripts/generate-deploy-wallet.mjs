import { Wallet } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wallet = Wallet.createRandom();

const outDir = resolve('.secrets');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'bsc-testnet-deployer.json');

const payload = {
  createdAt: new Date().toISOString(),
  chain: 'BSC Testnet',
  address: wallet.address,
  privateKey: wallet.privateKey,
  note: 'Fund this address from a BSC testnet faucet before deployment.',
};

writeFileSync(outFile, JSON.stringify(payload, null, 2), { encoding: 'utf-8' });

console.log(JSON.stringify({
  ok: true,
  address: wallet.address,
  secretsFile: outFile,
}, null, 2));
