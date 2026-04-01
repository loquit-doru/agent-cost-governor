import { JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider('https://bsc-dataseed1.bnbchain.org');
const code = await provider.getCode('0x161D749892a23AC8792eE7fD37f0F423E0b69C97');

const hex = code.slice(2);
const len = parseInt(hex.slice(-4), 16);
const cbor = hex.slice(-(len * 2 + 4), -4);
console.log('CBOR hex:', cbor);
console.log('Runtime bytecode length:', hex.length / 2, 'bytes');

const buf = Buffer.from(cbor, 'hex');
const solcMarker = Buffer.from('736f6c63', 'hex'); // 'solc' in hex
const idx = buf.indexOf(solcMarker);
if (idx >= 0) {
  const vBytes = buf.slice(idx + 4, idx + 7);
  console.log('Solc version from metadata:', `${vBytes[0]}.${vBytes[1]}.${vBytes[2]}`);
} else {
  console.log('solc marker not found in CBOR');
  console.log('Buffer as text:', buf.toString('utf-8').replace(/[^\x20-\x7e]/g, '.'));
}
