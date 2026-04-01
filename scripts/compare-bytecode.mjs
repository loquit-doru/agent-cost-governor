// Compare deployed bytecode with compiled bytecode from both versions
import solc from 'solc';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider } from 'ethers';

function findImports(importPath) {
  const paths = [resolve(importPath), resolve('node_modules', importPath)];
  for (const p of paths) {
    if (existsSync(p)) return { contents: readFileSync(p, 'utf-8') };
  }
  return { error: `File not found: ${importPath}` };
}

function compileSource(source) {
  const input = {
    language: 'Solidity',
    sources: { 'AICostGovernor.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors[0].formattedMessage);
  return output.contracts['AICostGovernor.sol']['AICostGovernor'].evm.deployedBytecode.object;
}

const provider = new JsonRpcProvider('https://bsc-dataseed1.bnbchain.org');
const code = await provider.getCode('0x161D749892a23AC8792eE7fD37f0F423E0b69C97');
const deployedBytecode = code.slice(2); // remove 0x

console.log('Deployed bytecode length:', deployedBytecode.length / 2, 'bytes');

// Test 1: original version (^0.8.20, no ReentrancyGuard)
const originalSource = readFileSync('contracts/AICostGovernor.sol', 'utf-8')
  .replace(/pragma solidity [^;]+;/, 'pragma solidity ^0.8.20;');
console.log('\n--- Testing original pragma (^0.8.20) with current source ---');
try {
  const bc1 = compileSource(originalSource);
  const match1 = bc1 === deployedBytecode;
  console.log('Bytecode length:', bc1.length / 2, 'bytes');
  console.log('Match with deployed:', match1);
  if (!match1) {
    // Compare without metadata hash (last ~53 bytes usually)
    const noMetaLen = Math.min(bc1.length, deployedBytecode.length) - 106;
    console.log('Logic match (ignoring metadata):', bc1.slice(0, noMetaLen) === deployedBytecode.slice(0, noMetaLen));
  }
} catch(e) {
  console.log('Compile error:', e.message.slice(0, 200));
}

// Test 2: original git version (no ReentrancyGuard)
const gitOriginalSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AICostGovernor is Ownable {
    IERC20 public immutable usdc;
    uint256 public minStake;

    mapping(address => uint256) public stakes;

    event StakeAdded(address indexed user, uint256 amount, uint256 totalStake); 
    event StakeWithdrawn(address indexed user, uint256 amount, uint256 remaining);
    event MinStakeUpdated(uint256 oldValue, uint256 newValue);

    constructor(address usdcToken, uint256 initialMinStake) Ownable(msg.sender) {
        require(usdcToken != address(0), "invalid_usdc");
        require(initialMinStake > 0, "invalid_min_stake");

        usdc = IERC20(usdcToken);
        minStake = initialMinStake;
    }

    function stakeForAction(uint256 amount) external {
        require(amount > 0, "invalid_amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer_failed");

        stakes[msg.sender] += amount;
        emit StakeAdded(msg.sender, amount, stakes[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "invalid_amount");
        require(stakes[msg.sender] >= amount, "insufficient_stake");

        stakes[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer_failed");
        emit StakeWithdrawn(msg.sender, amount, stakes[msg.sender]);
    }

    function checkApproval(address user) external view returns (bool) {
        return stakes[user] >= minStake;
    }

    function setMinStake(uint256 newMinStake) external onlyOwner {
        require(newMinStake > 0, "invalid_min_stake");
        uint256 old = minStake;
        minStake = newMinStake;
        emit MinStakeUpdated(old, newMinStake);
    }
}`;

console.log('\n--- Testing git original (^0.8.20, no ReentrancyGuard) ---');
try {
  const bc2 = compileSource(gitOriginalSource);
  const match2 = bc2 === deployedBytecode;
  console.log('Bytecode length:', bc2.length / 2, 'bytes');
  console.log('Match with deployed:', match2);
  if (!match2) {
    const noMetaLen = Math.min(bc2.length, deployedBytecode.length) - 106;
    console.log('Logic match (ignoring metadata):', bc2.slice(0, noMetaLen) === deployedBytecode.slice(0, noMetaLen));
    console.log('Current first 40:', bc2.slice(0, 40));
    console.log('Deployed first 40:', deployedBytecode.slice(0, 40));
    console.log('Current last 106:', bc2.slice(-106));
    console.log('Deployed last 106:', deployedBytecode.slice(-106));
  }
} catch(e) {
  console.log('Compile error:', e.message.slice(0, 200));
}
