import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

// BSC Mainnet — Circle native USDC (6 decimals)
// Override with USDC_TOKEN_ADDRESS env var if needed
const rpcUrl = process.env.BSC_MAINNET_RPC_URL || 'https://bsc-dataseed1.bnbchain.org';
const privateKey = process.env.DEPLOYER_PRIVATE_KEY || '';
const usdcToken = process.env.USDC_TOKEN_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const minStake = BigInt(process.env.MIN_STAKE_UNITS || '1000000'); // 1 USDC (adjust if token uses 18 decimals)

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
  const contractPath = resolve('contracts', 'AICostGovernor.sol');
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
  if (network.chainId !== 56n) {
    throw new Error(`Wrong network: expected BSC Mainnet (chainId 56), got ${network.chainId}`);
  }

  const signer = new Wallet(privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Balance:  ${Number(balance) / 1e18} BNB`);

  if (balance < 5_000_000_000_000_000n) {
    throw new Error('Insufficient BNB balance (need at least 0.005 BNB for gas)');
  }

  console.log(`USDC token: ${usdcToken}`);
  console.log(`Min stake:  ${minStake.toString()} (raw units)`);
  console.log('Deploying...');

  const factory = new ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(usdcToken, minStake);
  const receipt = await contract.deploymentTransaction()?.wait();
  const contractAddress = await contract.getAddress();

  const result = {
    ok: true,
    chain: 'bsc-mainnet',
    chainId: 56,
    deployer: signer.address,
    contractAddress,
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
    usdcToken,
    minStake: minStake.toString(),
    explorerContract: `https://bscscan.com/address/${contractAddress}`,
    explorerTx: `https://bscscan.com/tx/${receipt?.hash}`,
  };

  console.log('\n=== DEPLOYMENT SUCCESS ===');
  console.log(JSON.stringify(result, null, 2));

  // Append mainnet entry to bsc.address
  const entry = `\n### Contract deployment (BSC Mainnet)\n- contract_address: ${contractAddress}\n- tx_hash: ${receipt?.hash}\n- explorer_contract: ${result.explorerContract}\n- deployer: ${signer.address}\n- usdc_token: ${usdcToken}\n- min_stake_units: ${minStake.toString()}\n`;
  const bscAddressPath = resolve('bsc.address');
  const existing = existsSync(bscAddressPath) ? readFileSync(bscAddressPath, 'utf-8') : '';
  writeFileSync(bscAddressPath, existing + entry, 'utf-8');
  console.log('\nbsc.address updated.');
}

main().catch((error) => {
  console.error('\nDeploy FAILED:', String(error));
  process.exit(1);
});
