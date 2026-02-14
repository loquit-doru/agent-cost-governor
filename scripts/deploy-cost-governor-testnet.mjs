import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

const rpcUrl = process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
const privateKey = process.env.DEPLOYER_PRIVATE_KEY || '';
const usdcToken = process.env.USDC_TOKEN_ADDRESS || '0xae13d989dac2f0debff460ac112a837c89baa7cd';
const minStake = BigInt(process.env.MIN_STAKE_UNITS || '1000000'); // 1 USDC (6 decimals)

if (!privateKey) {
  throw new Error('Missing DEPLOYER_PRIVATE_KEY');
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
    sources: {
      'AICostGovernor.sol': { content: source },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors?.length) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      throw new Error(`Solidity compile error: ${fatal.map((e) => e.formattedMessage).join('\n')}`);
    }
  }

  const artifact = output.contracts?.['AICostGovernor.sol']?.AICostGovernor;
  if (!artifact?.abi || !artifact?.evm?.bytecode?.object) {
    throw new Error('Failed to build contract artifact');
  }

  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  };
}

async function main() {
  const { abi, bytecode } = compileContract();

  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);

  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) {
    throw new Error(`Deployer wallet has 0 balance: ${signer.address}`);
  }

  const factory = new ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(usdcToken, minStake);
  const receipt = await contract.deploymentTransaction()?.wait();

  console.log(JSON.stringify({
    ok: true,
    chain: 'bsc-testnet',
    deployer: signer.address,
    contractAddress: await contract.getAddress(),
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
    usdcToken,
    minStake: minStake.toString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
