// Explicit owned-fork integration only. Never imports or uses a private key.
// UFG_FORK_RPC_URL=http://127.0.0.1:8561 node test/integration/ufg-launch.fork.mjs
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, defineChain, http, encodeAbiParameters, keccak256, parseAbi, toHex, zeroAddress, zeroHash } from 'viem';
import {
  getAddresses, getKnownLifecycleDeployment, getKnownLifecycleProfile, KnownLifecycleProfile,
  UFG_LAUNCH_PROXY_ADDRESS, UFG_ORCHESTRATOR_ADDRESS, UFG_TREASURY_FACTORY_ADDRESS,
  ufgLaunchNonce, buildUfgFeeAssetPolicies, encodeUfgLaunchConfig, hashUfgLaunchConfig, validateUfgLaunchPlan,
  encodeAbyssLifecycleMarketConfig, encodePoolBoundV4LifecycleMarketConfig, decodePoolBoundV4LifecycleMarketConfig,
  readPoolBoundHookDeployment, minePoolBoundHookSalt, buildUfgApprovals, buildUfgLaunchTransactions,
  readUfgTreasury, launchLifecycleAbi, ufgLaunchProxyV1Abi, ufgTreasuryFactoryV1Abi,
  deriveLaunchPoolRecipe, LifecyclePhase,
} from '@black-market/sdk';
const url = new URL(process.env.UFG_FORK_RPC_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && url.port === '8561', 'An explicitly supplied owned loopback fork on port 8561 is required');
const chain = defineChain({ id: 4663, name: 'Owned Robinhood Anvil fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url.href] } } });
const client = createPublicClient({ chain, transport: http(url.href) });
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
assert.equal(await client.getChainId(), 4663);
const wallet = createWalletClient({ chain, transport: http(url.href) });
const [principal] = await wallet.getAddresses();
assert.equal(principal.toLowerCase(), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'Only the unlocked Anvil default account is allowed');
const sourceBlock = (await client.getBlockNumber()).toString();
const identity = { chainId: 4663n, orchestrator: UFG_ORCHESTRATOR_ADDRESS };
const quote = getAddresses(4663).weth;
const supply = 1_000_000n * 10n ** 18n;
const config = { treasuryShareBps: 10000, exitFeeBps: 100, reserveAssets: [quote] };
const configHash = hashUfgLaunchConfig(config);
const oracleConfigId = keccak256(encodeAbiParameters([{ type: 'uint24' }, { type: 'uint16' }], [1, 4096]));
const send = async (tx) => {
  const hash = await wallet.sendTransaction({ account: principal, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas ?? 80_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${tx.id ?? 'funding'} reverted: ${hash}`);
  return { id: tx.id ?? 'funding', hash, gasUsed: receipt.gasUsed.toString() };
};
const results = [];
const snapshot = await client.request({ method: 'evm_snapshot' });
try {
for (const [index, scenario] of [
  { name: 'abyss-quote-atomic', keys: [KnownLifecycleProfile.Abyss2], mode: 'atomic', erc20: false },
  { name: 'abyss-quote-and-ufg-fixed-staged', keys: [KnownLifecycleProfile.Abyss2, KnownLifecycleProfile.V4UfgFixedPool], mode: 'staged', erc20: true },
  { name: 'ufg-dynamic-atomic', keys: [KnownLifecycleProfile.V4UfgDynamicPool], mode: 'atomic', erc20: false },
].entries()) {
  const block = await client.getBlock();
  let plan = { ...identity, creator: UFG_LAUNCH_PROXY_ADDRESS, nonce: ufgLaunchNonce(principal, BigInt(index + 1)),
    token: { kind: 0, rewardMode: 0, name: `Fork UFG ${index}`, symbol: `UF${index}`, supply, nftUnit: 0n, metadataURI: '', salt: toHex(BigInt(index + 1), { size: 32 }), inventoryRecipient: principal, burnOnCancel: true },
    funding: [{ asset: quote, amount: 10n ** 15n, kind: scenario.erc20 ? 0 : 1, inputAsset: quote, inputAmount: 10n ** 15n, target: zeroAddress, data: '0x' }], feeAssets: [], markets: [], buys: [], deadline: block.timestamp + 3600n, executorFeeBps: 0 };
  const predictedToken = await client.readContract({ address: plan.orchestrator, abi: launchLifecycleAbi, functionName: 'predictToken', args: [plan] });
  plan.feeAssets = buildUfgFeeAssetPolicies(predictedToken, config.reserveAssets);
  plan.markets = scenario.keys.map((key) => {
    const preset = getKnownLifecycleProfile({ ...identity, key });
    const v4 = preset.profile.venueKind === 'uniswap-v4';
    const tokenBudget = supply / BigInt(scenario.keys.length);
    // Fixed $3,000 WETH and $5,000 FDV are deterministic test economics, not a live valuation.
    const recipe = deriveLaunchPoolRecipe({ supply, tokenBudget, pairedTokenDecimals: 18, pairedTokenUsdPriceX18: 3000n * 10n ** 18n, targetMarketCapUsdX18: 5000n * 10n ** 18n, launchedTokenIsQuote: BigInt(predictedToken) < BigInt(quote), fee: 3000, tickSpacing: 60 });
    const p = { tickLower: recipe.tickLower, tickUpper: recipe.tickUpper, liquidity: recipe.liquidity };
    const envelope = preset.profile.envelope;
    const encoded = v4 ? encodePoolBoundV4LifecycleMarketConfig({ version: 6, lpFeePips: 0, tickSpacing: 60, sqrtPriceX96: recipe.launchSqrtPriceX96,
      hookFeePips: 10000, minimumHookFeePips: 1000, feeSensitivityPipsSecondsPerTick: 7654321, feeMode: 1,
      protocolFeeDenominator: envelope.protocolFeeDenominator, treasury: envelope.protocolTreasury, externalLiquidityDisabled: false,
      oracleConfigId, hookSalt: zeroHash, profileId: preset.profile.id, termsDigest: envelope.termsDigest, developerBeneficiary: envelope.beneficiary, developerFeeBps: 0,
      positions: [{ ...p, salt: zeroHash, maxTokenAmount: tokenBudget }], ufgLaunchConfig: config })
      : encodeAbyssLifecycleMarketConfig({ profile: 2, fee: 3000, oracleConfigId: zeroHash, openingSqrtPriceX96: recipe.launchSqrtPriceX96, positions: [{ ...p, tokenAmountMaximum: tokenBudget }] });
    return { adapterId: preset.profile.registration.adapterId, profileId: preset.profile.id, quoteAsset: quote, tokenBudget, configVersion: v4 ? 6 : 1, config: encoded };
  });
  // Prove config tuple decoding against the deployed treasury factory on the fork.
  const validated = await client.readContract({ address: UFG_TREASURY_FACTORY_ADDRESS, abi: ufgTreasuryFactoryV1Abi, functionName: 'validateMarketLaunchConfig', args: [encodeUfgLaunchConfig(config), '0x', predictedToken, quote] });
  assert.deepEqual(validated, config);
  for (const [marketIndex, market] of plan.markets.entries()) {
    if (market.configVersion !== 6) continue;
    const deployment = await readPoolBoundHookDeployment({ client, plan, marketIndex });
    const mined = await minePoolBoundHookSalt({ deployer: deployment.deployer, initCodeHash: deployment.initCodeHash });
    plan.markets[marketIndex] = { ...market, config: encodePoolBoundV4LifecycleMarketConfig({ ...decodePoolBoundV4LifecycleMarketConfig(market.config, 6), hookSalt: mined.salt }) };
    const final = await readPoolBoundHookDeployment({ client, plan, marketIndex });
    assert.equal(final.predictedHook, mined.predictedHook);
    assert.equal(final.initCodeHash, deployment.initCodeHash);
  }
  validateUfgLaunchPlan(plan, config, predictedToken);
  const transactions = [];
  if (scenario.erc20) {
    const hash = await wallet.writeContract({ account: principal, address: quote, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: plan.funding[0].amount });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    for (const approval of buildUfgApprovals(plan)) transactions.push(await send(approval));
  }
  const commands = buildUfgLaunchTransactions({ plan, config, mode: scenario.mode, ...(scenario.mode === 'staged' ? { preparationBatches: [1, 1] } : {}) });
  for (const command of commands) {
    assert.equal(command.to, UFG_LAUNCH_PROXY_ADDRESS);
    assert.equal(command.from.toLowerCase(), principal.toLowerCase());
    // Exact principal eth_call, including msg.value and real fork allowances, before each local write.
    await client.call({ account: principal, to: command.to, data: command.data, value: command.value, gas: 80_000_000n });
    transactions.push(await send(command));
  }
  const launchId = await client.readContract({ address: plan.orchestrator, abi: launchLifecycleAbi, functionName: 'launchIdOf', args: [plan] });
  const progress = await client.readContract({ address: plan.orchestrator, abi: launchLifecycleAbi, functionName: 'readLaunchProgress', args: [launchId] });
  assert.equal(progress.phase, LifecyclePhase.Active);
  const treasury = await readUfgTreasury(client, predictedToken);
  assert.ok(treasury && treasury !== zeroAddress);
  const observedHash = await client.readContract({ address: UFG_LAUNCH_PROXY_ADDRESS, abi: ufgLaunchProxyV1Abi, functionName: 'launchConfigHash', args: [launchId] });
  assert.equal(observedHash, configHash);
  results.push({ scenario: scenario.name, token: predictedToken, treasury, launchId, configHash, launchConfigHashMatch: observedHash === configHash, transactions });
}
console.log(JSON.stringify({ chainId: await client.getChainId(), principal, sourceBlock, results }, null, 2));
} finally {
  assert.equal(await client.request({ method: 'evm_revert', params: [snapshot] }), true, 'Restore the owned fork after integration');
}
