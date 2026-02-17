#!/usr/bin/env node
/**
 * Re-deploy AICostGovernor on BSC Testnet + verify on Sourcify in one shot.
 * This ensures Sourcify gets the exact same bytecode.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

const RPC_URL = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
const CHAIN_ID = '97';
const SOURCIFY_API = 'https://sourcify.dev/server';
const USDC_TOKEN = '0xae13d989dac2f0debff460ac112a837c89baa7cd';
const MIN_STAKE = 1000000n; // 1 USDC (6 decimals)

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
  heading('ProceedGate: Re-deploy + Sourcify Verify');

  // ── Load wallet ──────────────────────────────────────────────────────────
  const secretsPath = resolve('.secrets', 'bsc-testnet-deployer.json');
  const secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
  const provider = new JsonRpcProvider(RPC_URL);
  const signer = new Wallet(secrets.privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  ok(`Wallet: ${signer.address} (${Number(balance) / 1e18} tBNB)`);

  // ── Compile ──────────────────────────────────────────────────────────────
  heading('Step 1: Compile');
  const contractPath = resolve('contracts', 'AICostGovernor.sol');
  const source = readFileSync(contractPath, 'utf-8');

  const input = {
    language: 'Solidity',
    sources: {
      'AICostGovernor.sol': { content: source },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'metadata'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors?.some(e => e.severity === 'error')) {
    output.errors.filter(e => e.severity === 'error').forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }

  const artifact = output.contracts?.['AICostGovernor.sol']?.AICostGovernor;
  if (!artifact?.abi || !artifact?.evm?.bytecode?.object || !artifact?.metadata) {
    fail('Missing abi/bytecode/metadata');
    process.exit(1);
  }

  const metadata = artifact.metadata;
  ok(`Compiled with solc ${solc.version()}`);
  ok(`Bytecode: ${artifact.evm.bytecode.object.length / 2} bytes`);

  // ── Deploy ───────────────────────────────────────────────────────────────
  heading('Step 2: Deploy to BSC Testnet');
  const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
  info('Deploying AICostGovernor...');
  const contract = await factory.deploy(USDC_TOKEN, MIN_STAKE);
  const receipt = await contract.deploymentTransaction()?.wait();

  const contractAddress = await contract.getAddress();
  const deployTx = contract.deploymentTransaction()?.hash;

  ok(`Contract: ${contractAddress}`);
  ok(`Deploy TX: ${deployTx}`);
  ok(`Block: ${receipt?.blockNumber}`);
  ok(`Explorer: https://testnet.bscscan.com/address/${contractAddress}`);

  // ── Wait for chain propagation ───────────────────────────────────────────
  info('Waiting 10s for chain propagation...');
  await new Promise(r => setTimeout(r, 10000));

  // ── Verify on Sourcify ───────────────────────────────────────────────────
  heading('Step 3: Sourcify Verification');

  const sourceFiles = {
    'AICostGovernor.sol': source,
  };

  // Collect OZ imports
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
    }
  }

  // Submit with FormData
  const formData = new FormData();
  formData.append('address', contractAddress);
  formData.append('chain', CHAIN_ID);
  formData.append('files', new Blob([metadata], { type: 'application/json' }), 'metadata.json');
  for (const [path, content] of Object.entries(sourceFiles)) {
    formData.append('files', new Blob([content], { type: 'text/plain' }), path);
  }

  info('Submitting to Sourcify...');
  try {
    const res = await fetch(`${SOURCIFY_API}/verify`, { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok && (data.result?.[0]?.status === 'perfect' || data.result?.[0]?.status === 'partial')) {
      ok(`🎉 Sourcify verified! Status: ${data.result[0].status}`);
      ok(`Sourcify: https://sourcify.dev/#/lookup/${contractAddress}`);
    } else {
      fail(`Sourcify response: ${res.status}`);
      console.log(JSON.stringify(data, null, 2));

      // Fallback: JSON method
      info('Trying JSON method...');
      const altRes = await fetch(`${SOURCIFY_API}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: contractAddress,
          chain: CHAIN_ID,
          files: { 'metadata.json': metadata, ...sourceFiles },
        }),
      });
      const altData = await altRes.json();
      if (altRes.ok) {
        ok('Sourcify verified via JSON method!');
        console.log(JSON.stringify(altData, null, 2));
      } else {
        fail('Sourcify verification failed');
        console.log(JSON.stringify(altData, null, 2));
      }
    }
  } catch (err) {
    fail(`Sourcify error: ${err.message}`);
  }

  // ── BscScan verification via API ─────────────────────────────────────────
  heading('Step 4: BscScan API Verification');
  info('Attempting BscScan API verification...');

  // Flatten source for BscScan
  let flatSource = '';
  flatSource += '// SPDX-License-Identifier: MIT\n';
  flatSource += `pragma solidity ^0.8.20;\n\n`;

  // Context.sol
  const contextSrc = readFileSync(resolve('node_modules/@openzeppelin/contracts/utils/Context.sol'), 'utf-8')
    .replace(/\/\/ SPDX[^\n]+\n/, '').replace(/pragma[^\n]+\n/, '').trim();
  flatSource += `// @openzeppelin/contracts/utils/Context.sol\n${contextSrc}\n\n`;

  // IERC20.sol
  const ierc20Src = readFileSync(resolve('node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol'), 'utf-8')
    .replace(/\/\/ SPDX[^\n]+\n/, '').replace(/pragma[^\n]+\n/, '').replace(/import[^\n]+\n/g, '').trim();
  flatSource += `// @openzeppelin/contracts/token/ERC20/IERC20.sol\n${ierc20Src}\n\n`;

  // Ownable.sol
  const ownableSrc = readFileSync(resolve('node_modules/@openzeppelin/contracts/access/Ownable.sol'), 'utf-8')
    .replace(/\/\/ SPDX[^\n]+\n/, '').replace(/pragma[^\n]+\n/, '').replace(/import[^\n]+\n/g, '').trim();
  flatSource += `// @openzeppelin/contracts/access/Ownable.sol\n${ownableSrc}\n\n`;

  // Main contract
  const mainSrc = source
    .replace(/\/\/ SPDX[^\n]+\n/, '').replace(/pragma[^\n]+\n/, '').replace(/import[^\n]+\n/g, '').trim();
  flatSource += `// contracts/AICostGovernor.sol\n${mainSrc}\n`;

  writeFileSync(resolve('contracts', 'AICostGovernor.flat.sol'), flatSource);
  ok('Flattened source written to contracts/AICostGovernor.flat.sol');

  // ── Summary ──────────────────────────────────────────────────────────────
  heading('Summary');
  console.log(JSON.stringify({
    ok: true,
    contract: contractAddress,
    deployer: signer.address,
    deploy_tx: deployTx,
    block: receipt?.blockNumber,
    solc_version: solc.version(),
    chain: 'bsc-testnet',
    explorer: `https://testnet.bscscan.com/address/${contractAddress}`,
    sourcify: `https://sourcify.dev/#/lookup/${contractAddress}`,
  }, null, 2));
}

main().catch(err => {
  fail(String(err));
  process.exit(1);
});
