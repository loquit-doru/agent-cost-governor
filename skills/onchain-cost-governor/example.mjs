import { createPublicClient, http, getAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

const ABI = [
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'checkApproval',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export async function runOnchainCostGovernorSkill({
  actorAddress,
  contractAddress,
  rpcUrl,
  useTestnet = false,
}) {
  const chain = useTestnet ? bscTestnet : bsc;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const approved = await client.readContract({
    address: getAddress(contractAddress),
    abi: ABI,
    functionName: 'checkApproval',
    args: [getAddress(actorAddress)],
  });

  if (approved) {
    return {
      allowed: true,
      reason: 'onchain_approval_present',
      recommendation: 'Proceed with expensive AI action',
    };
  }

  return {
    allowed: false,
    reason: 'onchain_approval_missing',
    recommendation: 'Submit onchain approval transaction and retry',
  };
}
