import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';

const CONTRACT_ADDRESS = '0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA';
const CHAIN_ID = '204'; // opBNB Mainnet

function findImports(importPath) {
  const localPath = resolve(importPath);
  if (existsSync(localPath)) return { contents: readFileSync(localPath, 'utf-8') };
  const nodeModulesPath = resolve('node_modules', importPath);
  if (existsSync(nodeModulesPath)) return { contents: readFileSync(nodeModulesPath, 'utf-8') };
  return { error: `File not found: ${importPath}` };
}

function compileWithMetadata() {
  // Use flat file — same as deploy script (^0.8.20 compatible with solc 0.8.34)
  const source = readFileSync(resolve('contracts', 'AICostGovernor.flat.v2.sol'), 'utf-8');
  const input = {
    language: 'Solidity',
    sources: { 'AICostGovernor.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const fatal = (output.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) throw new Error(fatal.map((e) => e.formattedMessage).join('\n'));
  const artifact = output.contracts['AICostGovernor.sol'].AICostGovernor;
  return { metadata: artifact.metadata, source };
}

async function main() {
  console.log('Compiling with metadata...');
  const { metadata, source } = compileWithMetadata();
  console.log('Compile OK');

  const boundary = '----SourcifyBoundary' + Date.now();
  const metaParsed = JSON.parse(metadata);
  const sources = metaParsed.sources || {};

  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="address"\r\n\r\n${CONTRACT_ADDRESS}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chain"\r\n\r\n${CHAIN_ID}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n${metadata}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="AICostGovernor.sol"\r\nContent-Type: text/plain\r\n\r\n${source}`);

  for (const [filePath] of Object.entries(sources)) {
    if (filePath === 'AICostGovernor.sol') continue;
    const nodeModulesPath = resolve('node_modules', filePath);
    if (existsSync(nodeModulesPath)) {
      const content = readFileSync(nodeModulesPath, 'utf-8');
      const filename = filePath.split('/').pop();
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}`);
    }
  }

  const body = parts.join('\r\n') + `\r\n--${boundary}--\r\n`;

  console.log(`Submitting to Sourcify (chainId=${CHAIN_ID}, address=${CONTRACT_ADDRESS})...`);
  const res = await fetch('https://sourcify.dev/server/verify', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (res.ok && (json.result?.[0]?.status === 'perfect' || json.result?.[0]?.status === 'partial')) {
    console.log('\n=== VERIFICATION SUCCESS ===');
    console.log('Status:', json.result[0].status);
    console.log('Sourcify:', `https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`);
  } else {
    console.log('\nSourcify response (status', res.status, '):', JSON.stringify(json, null, 2));
    if (res.status === 409) {
      console.log('(409 = already verified — ok)');
      console.log('Sourcify:', `https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`);
    } else {
      process.exit(1);
    }
  }
}

main().catch((e) => { console.error('FAILED:', String(e)); process.exit(1); });
