// Independent Solidity ABI vectors. Requires Foundry cast; no RPC or signing.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const address = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const cases = [
  { name: 'single-reserve-zero-exit', config: { treasuryShareBps: 10000, exitFeeBps: 0, reserveAssets: [address(32)] } },
  { name: 'seven-reserves-max-exit', config: { treasuryShareBps: 10000, exitFeeBps: 2000, reserveAssets: Array.from({ length: 7 }, (_, i) => address(32 + i)) } },
];
const prefixSignature = 'f((uint16,uint24,int24,uint160,uint24,uint24,uint32,uint8,uint8,address,bool,bytes32,bytes32,bytes32,bytes32,address,uint16,(int24,int24,uint128,bytes32,uint256)[]))';
for (const fixture of cases) {
  const { config } = fixture;
  fixture.command = ['cast', 'abi-encode', 'f((uint16,uint16,address[]))', `(${config.treasuryShareBps},${config.exitFeeBps},[${config.reserveAssets.join(',')}])`];
  fixture.encoded = execFileSync('cast', fixture.command.slice(1), { encoding: 'utf8' }).trim();
  fixture.market = { version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: (1n << 96n).toString(), hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321, feeMode: 1, protocolFeeDenominator: 6, treasury: address(48), externalLiquidityDisabled: false, oracleConfigId: hash(1), hookSalt: hash(2), profileId: '0x5c6045af480814e469f3dba7c120d264047c9320b869c63a064536041a2dbae6', termsDigest: hash(3), developerBeneficiary: address(49), developerFeeBps: 0, positions: [{ tickLower: -60, tickUpper: 887220, liquidity: '1234', salt: hash(0), maxTokenAmount: '1000000' }] };
  const values = Object.values(fixture.market).slice(0, -1);
  const p = fixture.market.positions[0];
  const tuple = `(${values.join(',')},[(${p.tickLower},${p.tickUpper},${p.liquidity},${p.salt},${p.maxTokenAmount})])`;
  fixture.prefixCommand = ['cast', 'abi-encode', prefixSignature, tuple];
  fixture.prefix = execFileSync('cast', fixture.prefixCommand.slice(1), { encoding: 'utf8' }).trim();
  fixture.marketEncoded = fixture.prefix + fixture.encoded.slice(2);
  fixture.configHash = execFileSync('cast', ['keccak', fixture.encoded], { encoding: 'utf8' }).trim();
}
await writeFile(new URL('../test/fixtures/ufg-launch-config.json', import.meta.url), JSON.stringify({ source: 'UFGTypesV1.sol / V4MarketConfigV6.sol, independent cast abi-encode prefix || tuple tail', cases }, null, 2) + '\n');
console.log(`Generated ${cases.length} independent UFG config and config6/tail vectors`);
