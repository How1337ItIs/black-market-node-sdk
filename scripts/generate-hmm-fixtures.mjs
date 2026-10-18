// HMMLaunchConfigV2/HMMStrategyConfigV2 order from
// contracts/hooks/hmm-manager/src/interfaces/HMMTypesV2.sol. Requires Foundry cast.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const strategy = '(int24,int24,int24,uint32,int24,uint256,uint256,uint256,uint16,uint8,uint256,uint256,uint32,uint256,int24)';
const signature = `f((uint16,${strategy}))`;
const cap = ((1n << 128n) - 1n).toString();
const cases = [
  { name: 'model-defaults-explicit-guards', values: [5000, [5, 5, 1, 86400, 5, '500000000000000', '5000000000000000', '10000000000000000000', 500, 4, '100000000000000000000000', '1000000000000000000000000', 0, '100000000000000000', 0]] },
  { name: 'factory-inclusive-boundaries', values: [10000, [8388607, 8388607, 0, 4294967295, 8388607, ((1n << 256n) - 1n).toString(), ((1n << 256n) - 1n).toString(), '1', 5000, 8, cap, cap, 4294967295, cap, 8388607]] },
  { name: 'zero-share-decay-enabled', values: [0, [1, 1, 0, 1, 1, '0', '1', '4', 0, 4, '4', '4', 259200, '1', 0]] },
];
for (const fixture of cases) {
  const value = `(${fixture.values[0]},(${fixture.values[1].join(',')}))`;
  fixture.command = ['cast', 'abi-encode', signature, value];
  fixture.encoded = execFileSync('cast', fixture.command.slice(1), { encoding: 'utf8' }).trim();
  fixture.setStrategyConfigCalldata = execFileSync('cast', ['calldata', `setStrategyConfig(${strategy})`, `(${fixture.values[1].join(',')})`], { encoding: 'utf8' }).trim();
}
await writeFile(new URL('../test/fixtures/hmm-launch-tail.json', import.meta.url), JSON.stringify({ source: 'Solidity abi.encode(HMMLaunchConfigV2) and setStrategyConfig(HMMStrategyConfigV2), HMMTypesV2.sol', cases }, null, 2) + '\n');
console.log(`Generated ${cases.length} independent cast V2 ABI vectors`);
