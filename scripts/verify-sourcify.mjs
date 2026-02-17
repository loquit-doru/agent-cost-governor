#!/usr/bin/env node
/**
 * Verify AICostGovernor contract on Sourcify (BSC Testnet)
 *
 * Usage:
 *   node scripts/verify-sourcify.mjs
 *
 * This submits the contract source + compiler settings to Sourcify
 * for verification at: https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';

const CONTRACT_ADDRESS = '0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA';
const CHAIN_ID = '97'; // BSC Testnet
const SOURCIFY_API = 'https://sourcify.dev/server';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
function ok(msg) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg) { console.log(`  ▸ ${msg}`); }
function fail(msg) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function heading(msg) { console.log(`\n${c.bold}${c.cyan}═══ ${msg} ═══${c.reset}\n`); }

function findImports(importPath) {
  const localPath = resolve(importPath);
  if (existsSync(localPath)) return { contents: readFileSync(localPath, 'utf-8') };
  const nodeModulesPath = resolve('node_modules', importPath);
  if (existsSync(nodeModulesPath)) return { contents: readFileSync(nodeModulesPath, 'utf-8') };
  return { error: `File not found: ${importPath}` };
}

async function main() {
  heading('ProceedGate: Sourcify Verification');

  // Step 1: Read contract source
  const contractPath = resolve('contracts', 'AICostGovernor.sol');
  const source = readFileSync(contractPath, 'utf-8');
  ok(`Read contract source: ${contractPath}`);

  // Step 2: Compile with metadata — MUST match deploy settings exactly
  info('Compiling with solc for metadata (matching deploy settings)...');
  const input = {
    language: 'Solidity',
    sources: {
      // Key must match deploy script: 'AICostGovernor.sol' (not 'contracts/...')
      'AICostGovernor.sol': { content: source },
    },
    settings: {
      // Deploy script has no explicit optimizer — match that
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'metadata'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors?.some(e => e.severity === 'error')) {
    fail('Compilation errors:');
    output.errors.filter(e => e.severity === 'error').forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }

  const artifact = output.contracts?.['AICostGovernor.sol']?.AICostGovernor;
  if (!artifact?.metadata) {
    fail('No metadata in compilation output');
    process.exit(1);
  }

  const metadata = artifact.metadata;
  ok('Compilation successful, metadata extracted');

  // Step 3: Collect all source files for Sourcify
  info('Collecting source files...');
  const sourceFiles = {};

  // Main contract — key must match compilation input key
  sourceFiles['AICostGovernor.sol'] = source;

  // OpenZeppelin imports
  const ozFiles = [
    '@openzeppelin/contracts/token/ERC20/IERC20.sol',
    '@openzeppelin/contracts/access/Ownable.sol',
    '@openzeppelin/contracts/utils/Context.sol',
  ];

  for (const ozFile of ozFiles) {
    const fullPath = resolve('node_modules', ozFile);
    if (existsSync(fullPath)) {
      sourceFiles[ozFile] = readFileSync(fullPath, 'utf-8');
      ok(`Found: ${ozFile}`);
    } else {
      fail(`Missing: ${ozFile}`);
    }
  }

  // Step 4: Check if already verified
  info('Checking if already verified on Sourcify...');
  try {
    const checkRes = await fetch(`${SOURCIFY_API}/check-by-addresses?addresses=${CONTRACT_ADDRESS}&chainIds=${CHAIN_ID}`);
    const checkData = await checkRes.json();
    if (checkData?.[0]?.status === 'perfect' || checkData?.[0]?.status === 'partial') {
      ok(`Already verified on Sourcify! Status: ${checkData[0].status}`);
      ok(`View: https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`);
      return;
    }
  } catch (e) {
    info('Check failed, proceeding to verify...');
  }

  // Step 5: Submit to Sourcify
  heading('Submitting to Sourcify');

  // Method 1: Try with metadata.json approach
  const formData = new FormData();
  formData.append('address', CONTRACT_ADDRESS);
  formData.append('chain', CHAIN_ID);

  // Append metadata
  formData.append('files', new Blob([metadata], { type: 'application/json' }), 'metadata.json');

  // Append source files
  for (const [path, content] of Object.entries(sourceFiles)) {
    formData.append('files', new Blob([content], { type: 'text/plain' }), path);
  }

  try {
    info('Submitting verification request...');
    const res = await fetch(`${SOURCIFY_API}/verify`, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (res.ok && data.result?.[0]?.status === 'perfect') {
      ok('✨ PERFECT MATCH! Contract verified on Sourcify.');
      ok(`View: https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`);
      ok(`BscScan: https://testnet.bscscan.com/address/${CONTRACT_ADDRESS}#code`);
    } else if (res.ok && data.result?.[0]?.status === 'partial') {
      ok('Partial match verified on Sourcify.');
      ok(`View: https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`);
    } else {
      fail(`Verification response: ${res.status}`);
      console.log(JSON.stringify(data, null, 2));

      // Try Method 2: Direct JSON submission
      info('Trying alternative submission method...');
      const altRes = await fetch(`${SOURCIFY_API}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: CONTRACT_ADDRESS,
          chain: CHAIN_ID,
          files: {
            'metadata.json': metadata,
            ...sourceFiles,
          },
        }),
      });

      const altData = await altRes.json();
      if (altRes.ok) {
        ok('Verification submitted via JSON method!');
        console.log(JSON.stringify(altData, null, 2));
      } else {
        fail('Both methods failed. Manual verification may be needed.');
        console.log(JSON.stringify(altData, null, 2));
        info('Manual: visit https://sourcify.dev/#/verifier and upload:');
        info('  1. contracts/AICostGovernor.sol');
        info('  2. metadata.json (from compilation)');
        info(`  3. Address: ${CONTRACT_ADDRESS}`);
        info(`  4. Chain: BSC Testnet (97)`);
      }
    }
  } catch (err) {
    fail(`Submission error: ${err.message}`);
    info('Sourcify may be temporarily unavailable.');
    info(`Direct link: https://sourcify.dev/#/verifier`);
  }

  // Step 6: Also try BscScan API verification
  heading('BscScan API Verification (Alternative)');
  info('For BscScan verification, use their web interface:');
  info(`  1. Go to: https://testnet.bscscan.com/address/${CONTRACT_ADDRESS}#code`);
  info('  2. Click "Verify and Publish"');
  info('  3. Compiler: 0.8.20, License: MIT, Optimization: No');
  info('  4. Paste AICostGovernor.sol source (flatten with imports)');
  info('  5. Constructor args: (address usdcToken, uint256 initialMinStake)');

  // Generate flattened source for manual verification
  info('\nFlattened source saved for manual BscScan verification if needed.');
}

main().catch(err => {
  fail(String(err));
  process.exit(1);
});
