// HMMLaunchConfigV1/HMMStrategyConfigV1 order from Black Market main 1ca9881,
// contracts/hooks/hmm-manager/src/interfaces/HMMTypesV1.sol. Requires Foundry cast.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const signature = 'f((uint16,(int24,int24,int24,uint32,int24,uint256,uint256,uint256,uint16,uint8,uint256,uint256,uint32)))';
const cases = [
  { name: 'model-defaults', values: [5000, [5, 5, 1, 86400, 5, '500000000000000', '5000000000000000', '10000000000000000000', 500, 4, '100000000000000000000000', '1000000000000000000000000', 0]] },
  { name: 'factory-inclusive-boundaries', values: [10000, [8388607, 8388607, 0, 4294967295, 8388607, '0', '1', '1', 5000, 8, ((1n << 128n) - 1n).toString(), ((1n << 128n) - 1n).toString(), 4294967295]] },
  { name: 'zero-share-decay-enabled', values: [0, [1, 1, 0, 1, 1, '0', '1', '4', 0, 4, '4', '4', 259200]] },
];
for (const fixture of cases) {
  const value = `(${fixture.values[0]},(${fixture.values[1].join(',')}))`;
  fixture.command = ['cast', 'abi-encode', signature, value];
  fixture.encoded = execFileSync('cast', fixture.command.slice(1), { encoding: 'utf8' }).trim();
}
await writeFile(new URL('../test/fixtures/hmm-launch-tail.json', import.meta.url), JSON.stringify({ source: 'Solidity abi.encode(HMMLaunchConfigV1), Black Market main 1ca9881', cases }, null, 2) + '\n');
console.log(`Generated ${cases.length} independent cast ABI vectors`);
