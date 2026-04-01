import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const sources = {};
const queue = [{ key: 'AICostGovernor.sol', filePath: resolve('contracts/AICostGovernor.sol') }];
const visited = new Set();

while (queue.length > 0) {
  const { key, filePath } = queue.shift();
  if (visited.has(key)) continue;
  visited.add(key);

  const content = readFileSync(filePath, 'utf-8');
  sources[key] = { content };

  // extract imports (handles both @ packages and relative paths)
  // matches: import "path", import {X} from "path", import * as X from "path"
  const importRegex = /import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const imp = match[1];
    if (imp.startsWith('@')) {
      // node_modules package
      const nodeModPath = resolve('node_modules', imp);
      if (existsSync(nodeModPath)) {
        queue.push({ key: imp, filePath: nodeModPath });
      }
    } else if (imp.startsWith('.')) {
      // relative import — resolve relative to current file
      const resolvedPath = resolve(dirname(filePath), imp);
      // compute key: if it's inside node_modules, make it an @ key
      const nodeModsDir = resolve('node_modules') + '\\';
      let newKey;
      if (resolvedPath.startsWith(nodeModsDir)) {
        newKey = resolvedPath.slice(nodeModsDir.length).replace(/\\/g, '/');
      } else {
        newKey = resolvedPath.replace(/\\/g, '/').split('/').pop();
      }
      if (existsSync(resolvedPath)) {
        queue.push({ key: newKey, filePath: resolvedPath });
      }
    }
  }
}

const standardJson = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['*'] } },
  },
};

writeFileSync('contracts/standard-json-input.json', JSON.stringify(standardJson, null, 2));
console.log('Sources included:', Object.keys(sources));
console.log('File size:', JSON.stringify(standardJson).length, 'chars');
