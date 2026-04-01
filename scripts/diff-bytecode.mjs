import solc from 'solc';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider } from 'ethers';

function findImports(p) {
  const paths = [resolve(p), resolve('node_modules', p)];
  for (const f of paths) if (existsSync(f)) return { contents: readFileSync(f, 'utf-8') };
  return { error: `Not found: ${p}` };
}

const provider = new JsonRpcProvider('https://bsc-dataseed1.bnbchain.org');
const code = await provider.getCode('0x161D749892a23AC8792eE7fD37f0F423E0b69C97');
const deployed = code.slice(2);

// Current source with compatible pragma
const src = readFileSync('contracts/AICostGovernor.sol', 'utf-8')
  .replace(/pragma solidity [^;]+;/, 'pragma solidity ^0.8.20;');

const input = {
  language: 'Solidity',
  sources: { 'AICostGovernor.sol': { content: src } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter(e => e.severity === 'error');
if (errors.length) { console.error(errors[0].formattedMessage); process.exit(1); }

const compiled = out.contracts['AICostGovernor.sol']['AICostGovernor'].evm.deployedBytecode.object;

console.log('Deployed len:', deployed.length / 2, 'Compiled len:', compiled.length / 2);

// Find first difference
let firstDiff = -1;
for (let i = 0; i < Math.min(deployed.length, compiled.length); i += 2) {
  if (deployed[i] !== compiled[i] || deployed[i + 1] !== compiled[i + 1]) {
    firstDiff = i / 2;
    break;
  }
}
console.log('First diff at byte:', firstDiff, 'of', deployed.length / 2);
if (firstDiff >= 0) {
  const start = Math.max(0, firstDiff * 2 - 20);
  const end = Math.min(deployed.length, firstDiff * 2 + 50);
  console.log('Deployed:', deployed.slice(start, end));
  console.log('Compiled:', compiled.slice(start, end));
  // Metadata comparison
  const metaStart = deployed.length - 108;
  console.log('\nMetadata section start at byte:', metaStart / 2);
  console.log('First diff before metadata?', firstDiff < metaStart / 2);
}
