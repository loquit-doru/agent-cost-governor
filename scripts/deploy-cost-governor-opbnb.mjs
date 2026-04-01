import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

// opBNB Mainnet — Tether USD (USDT) bridged from BSC (18 decimals)
// #1 token by liquidity on opBNB: https://opbnbscan.com/token/0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3
const rpcUrl = process.env.OPBNB_MAINNET_RPC_URL || 'https://opbnb-mainnet-rpc.bnbchain.org';
const privateKey = process.env.DEPLOYER_PRIVATE_KEY || '';
const usdtToken = process.env.USDT_TOKEN_ADDRESS || '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3';
const minStake = BigInt(process.env.MIN_STAKE_UNITS || '1000000000000000000'); // 1 USDT (18 decimals)

if (!privateKey) {
  throw new Error('Missing DEPLOYER_PRIVATE_KEY env var');
}

function findImports(importPath) {
  const localPath = resolve(importPath);
  if (existsSync(localPath)) {
    return { contents: readFileSync(localPath, 'utf-8') };
  }
  const nodeModulesPath = resolve('node_modules', importPath);
  if (existsSync(nodeModulesPath)) {
    return { contents: readFileSync(nodeModulesPath, 'utf-8') };
  }
  return { error: `File not found: ${importPath}` };
}

function compileContract() {
  // Use flat file (^0.8.20 pragma) — compatible with bundled solc 0.8.34
  const contractPath = resolve('contracts', 'AICostGovernor.flat.v2.sol');
  const source = readFileSync(contractPath, 'utf-8');

  const input = {
    language: 'Solidity',
    sources: { 'AICostGovernor.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const fatal = (output.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) {
    throw new Error(`Solidity compile error:\n${fatal.map((e) => e.formattedMessage).join('\n')}`);
  }

  const artifact = output.contracts?.['AICostGovernor.sol']?.AICostGovernor;
  if (!artifact?.abi || !artifact?.evm?.bytecode?.object) {
    throw new Error('Failed to extract contract artifact');
  }

  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

async function main() {
  console.log('Compiling AICostGovernor...');
  const { abi, bytecode } = compileContract();
  console.log('Compile OK');

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 204n) {
    throw new Error(`Wrong network: expected opBNB Mainnet (chainId 204), got ${network.chainId}`);
  }

  const signer = new Wallet(privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Balance:  ${Number(balance) / 1e18} BNB`);

  // opBNB gas is very cheap (~0.0001 BNB sufficient)
  if (balance < 100_000_000_000_000n) {
    throw new Error('Insufficient BNB balance (need at least 0.0001 BNB for gas on opBNB)');
  }

  console.log(`USDT token: ${usdtToken}`);
  console.log(`Min stake:  ${minStake.toString()} (raw units = ${Number(minStake) / 1e18} USDT)`);
  console.log('Deploying...');

  const factory = new ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(usdtToken, minStake);
  const receipt = await contract.deploymentTransaction()?.wait();
  const contractAddress = await contract.getAddress();

  const result = {
    ok: true,
    chain: 'opbnb-mainnet',
    chainId: 204,
    deployer: signer.address,
    contractAddress,
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
    usdtToken,
    minStake: minStake.toString(),
    explorerContract: `https://opbnbscan.com/address/${contractAddress}`,
    explorerTx: `https://opbnbscan.com/tx/${receipt?.hash}`,
  };

  console.log('\n=== DEPLOYMENT SUCCESS ===');
  console.log(JSON.stringify(result, null, 2));

  // Append opBNB entry to bsc.address
  const entry = `\n### Contract deployment (opBNB Mainnet)\n- contract_address: ${contractAddress}\n- tx_hash: ${receipt?.hash}\n- explorer_contract: ${result.explorerContract}\n- explorer_tx: ${result.explorerTx}\n- deployer: ${signer.address}\n- usdt_token: ${usdtToken}\n- min_stake_units: ${minStake.toString()}\n`;
  const bscAddressPath = resolve('bsc.address');
  const existing = existsSync(bscAddressPath) ? readFileSync(bscAddressPath, 'utf-8') : '';
  writeFileSync(bscAddressPath, existing + entry, 'utf-8');
  console.log('\nbsc.address updated.');
}

main().catch((error) => {
  console.error('\nDeploy FAILED:', String(error));
  process.exit(1);
});
