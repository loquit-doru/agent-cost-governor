import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = [
  'node_modules/@openzeppelin/contracts/utils/Context.sol',
  'node_modules/@openzeppelin/contracts/access/Ownable.sol',
  'node_modules/@openzeppelin/contracts/utils/ReentrancyGuard.sol',
  'node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol',
  'contracts/AICostGovernor.sol',
];

let flat = '// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n\n';

for (const f of files) {
  let content = readFileSync(resolve(f), 'utf-8');
  content = content.replace(/\/\/ SPDX-License-Identifier:[^\n]+\n/g, '');
  content = content.replace(/pragma solidity[^;]+;\n/g, '');
  content = content.replace(/import "[^"]+";[\r\n]*/g, '');
  content = content.replace(/import '[^']+';[\r\n]*/g, '');
  content = content.replace(/import \{[^}]+\} from "[^"]+";[\r\n]*/g, '');
  content = content.replace(/import \{[^}]+\} from '[^']+';[\r\n]*/g, '');
  flat += `// File: ${f}\n${content.trim()}\n\n`;
}

writeFileSync('contracts/AICostGovernor.flat.sol', flat);
console.log('Flat file written:', flat.length, 'chars');
