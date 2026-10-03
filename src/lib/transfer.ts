import { createWalletClient, custom, encodeFunctionData, erc20Abi, getAddress, isAddressEqual, parseUnits, recoverTypedDataAddress, toHex, type Address, type EIP1193Provider, type Hex } from 'viem'
import { getNetwork, getPublicClient, ENTRY_POINT, entryPointAbi } from './chain'
import { ACCOUNT_GAS_LIMITS, checkedAddress, inspectTransferLogs, MAX_OUTER_GAS, operationHash, operationIntent, transferCalldata, typedData, validateRecipient, ZERO_WORD } from './operation'
import { simulateTransfer } from './simulation'
import { AccountCompatibilityError, validateSource, validateSponsor } from './accounts'
export { validateSource } from './accounts'
import { estimateFeeBudget, transactionFee } from './fees'
import type { GasQuote, PackedOperation, PreparedTransfer, SignedTransfer, Asset, AssetInfo, TransferIntent, TransferResult } from './types'

const cleanLabel = (text: string, length: number) => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, length)

export class SubmissionUnknownError extends Error {
  constructor(readonly sponsor: Address) {
    super('The wallet did not return a confirmation. Check its activity before sending again: the transaction may already have been broadcast.')
    this.name = 'SubmissionUnknownError'
  }
}

function explicitlyRejected(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: number; cause?: unknown }
    if (item.code === 4001) return true
    current = item.cause
  }
  return false
}

export function parseAmount(value: string, decimals: number) {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(normalized) || normalized.length > 100) throw new Error('Enter a valid amount without exponents or thousands separators.')
  if ((normalized.split('.')[1]?.length ?? 0) > decimals) throw new Error(`This token supports up to ${decimals} decimal places.`)
  const amount = parseUnits(normalized, decimals)
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error('The amount must be positive and valid for this token.')
  return amount
}

export function nativeSpendableBalance(chainId: number, totalBalance: bigint) {
  getNetwork(chainId)
  // Monad reserves up to 10 MON for delegated accounts, even with sponsored gas.
  const reservedBalance = chainId === 143 ? (totalBalance < 10n ** 19n ? totalBalance : 10n ** 19n) : 0n
  return { balance: totalBalance - reservedBalance, reservedBalance }
}

export async function readAsset(chainId: number, asset: Asset, owner?: Address): Promise<AssetInfo> {
  const client = getPublicClient(chainId)
  const network = getNetwork(chainId)
  if (await client.getChainId() !== chainId) throw new Error(`The RPC is not connected to ${network.name}.`)
  if (asset.kind === 'native') {
    const totalBalance = owner ? await client.getBalance({ address: owner }) : 0n
    return { kind: 'native', ...network.chain.nativeCurrency, ...nativeSpendableBalance(chainId, totalBalance) }
  }
  const address = checkedAddress(asset.address)
  const [code, decimals, symbol, name, balance] = await Promise.all([
    client.getCode({ address }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => 'ERC-20 token'),
    owner ? client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) : Promise.resolve(0n),
  ])
  if (!code || code === '0x' || decimals > 36) throw new Error('This token contract is not supported.')
  return { kind: 'erc20', address, decimals, symbol: cleanLabel(symbol, 24) || 'TOKEN', name: cleanLabel(name, 80), balance, reservedBalance: 0n }
}

function handleOps(operation: PackedOperation, sponsor: Address) {
  return encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[operation], sponsor] })
}

function checkBalance(intent: TransferIntent, asset: AssetInfo) {
  if (intent.amount > asset.balance) throw new Error('The amount exceeds the available balance.')
}

export async function prepareTransfer(input: { chainId: number; source: Address; asset: Asset; recipient: Address; amount: string }): Promise<PreparedTransfer> {
  const { chainId } = input
  const client = getPublicClient(chainId)
  const source = checkedAddress(input.source)
  const recipient = checkedAddress(input.recipient)
  validateRecipient(source, recipient, input.asset)
  const [, asset] = await Promise.all([validateSource(chainId, source), readAsset(chainId, input.asset, source)])
  const intent: TransferIntent = { chainId, source, recipient, asset: input.asset, amount: parseAmount(input.amount, asset.decimals) }
  checkBalance(intent, asset)
  // A dedicated nonce lane prevents unrelated Fomo operations from consuming it.
  const key = BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  const nonce = await client.readContract({ address: ENTRY_POINT, abi: entryPointAbi, functionName: 'getNonce', args: [source, key] })
  const operation: PackedOperation = { sender: source, nonce, initCode: '0x', callData: transferCalldata(intent), accountGasLimits: ACCOUNT_GAS_LIMITS, preVerificationGas: 0n, gasFees: ZERO_WORD, paymasterAndData: '0x', signature: '0x' }
  operationIntent(operation, chainId)
  await simulateTransfer(intent, { from: source, to: source, data: operation.callData, gas: 300_000n })
  const hash = operationHash(operation, chainId)
  const onchainHash = await client.readContract({ address: ENTRY_POINT, abi: entryPointAbi, functionName: 'getUserOpHash', args: [operation] })
  if (hash !== onchainHash) throw new Error('The signature format does not match the contract.')
  return { intent, asset, operation, hash }
}

export async function assertWallet(provider: EIP1193Provider, expected: Address, chainId: number) {
  const [accounts, network] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })])
  if (Number(network) !== chainId) throw new Error(`Select ${getNetwork(chainId).name} in your wallet.`)
  if (!accounts[0] || !isAddressEqual(accounts[0], expected)) throw new Error('The active account changed. Select the expected account and try again.')
}

async function currentNonce(operation: PackedOperation, chainId: number) {
  const nonce = await getPublicClient(chainId).readContract({ address: ENTRY_POINT, abi: entryPointAbi, functionName: 'getNonce', args: [operation.sender, operation.nonce >> 64n] })
  if (nonce !== operation.nonce) throw new Error('This authorization has already been used or invalidated. Prepare a new transfer.')
}

export async function signTransfer(prepared: PreparedTransfer, provider: EIP1193Provider): Promise<SignedTransfer> {
  const { chainId } = prepared.intent
  const intent = operationIntent(prepared.operation, chainId)
  await assertWallet(provider, intent.source, chainId)
  const [, , asset] = await Promise.all([validateSource(chainId, intent.source), currentNonce(prepared.operation, chainId), readAsset(chainId, intent.asset, intent.source)])
  checkBalance(intent, asset)
  if (asset.decimals !== prepared.asset.decimals || asset.symbol !== prepared.asset.symbol) throw new Error('The asset details changed. Review the transfer again.')
  await simulateTransfer(intent, { from: intent.source, to: intent.source, data: prepared.operation.callData, gas: 300_000n })
  await assertWallet(provider, intent.source, chainId)
  const wallet = createWalletClient({ chain: getNetwork(chainId).chain, transport: custom(provider) })
  const signature = await wallet.signTypedData({ account: intent.source, ...typedData(prepared.operation, chainId) })
  // A signature stays usable if accounts change during the prompt. Recover its
  // signer instead of silently discarding an already valid authorization.
  const signed = { intent, asset, operation: { ...prepared.operation, signature }, hash: operationHash(prepared.operation, chainId) }
  await verifySignature(signed.operation, chainId)
  return signed
}

export async function verifySignature(operation: PackedOperation, chainId: number) {
  const intent = operationIntent(operation, chainId)
  const signer = await recoverTypedDataAddress({ ...typedData(operation, chainId), signature: operation.signature })
  if (!isAddressEqual(signer, intent.source)) throw new Error('The signature does not match the source wallet.')
}

export async function hydrateOperation(operation: PackedOperation, chainId: number): Promise<SignedTransfer> {
  const intent = operationIntent(operation, chainId)
  await verifySignature(operation, chainId)
  const [, , asset] = await Promise.all([validateSource(chainId, intent.source), currentNonce(operation, chainId), readAsset(chainId, intent.asset, intent.source)])
  checkBalance(intent, asset)
  return { intent, asset, operation, hash: operationHash(operation, chainId) }
}

export async function quoteTransfer(signed: SignedTransfer, sponsor: Address): Promise<GasQuote> {
  const { chainId } = signed.intent
  const client = getPublicClient(chainId)
  const network = getNetwork(chainId)
  const validated = await hydrateOperation(signed.operation, chainId)
  await validateSponsor(chainId, sponsor, validated.intent.source)
  const data = handleOps(signed.operation, sponsor)
  const [fees, balance] = await Promise.all([client.estimateFeesPerGas(), client.getBalance({ address: sponsor })])
  // Nitro ignores priority tips; explicitly request zero to keep native balance
  // simulation consistent with the fee actually charged by Robinhood Chain.
  const prices = { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: chainId === 4663 ? 0n : fees.maxPriorityFeePerGas }
  if (balance < 21_000n * prices.maxFeePerGas) throw new Error(`The paying wallet does not have enough ${network.chain.nativeCurrency.symbol} on ${network.name} to cover network fees.`)
  const estimated = await client.estimateGas({ account: sponsor, to: ENTRY_POINT, data, ...prices })
  const gas = (estimated + 50_000n) * 125n / 100n
  if (gas > MAX_OUTER_GAS) throw new Error('This transfer exceeds the supported gas limit.')
  const budget = await estimateFeeBudget(chainId, sponsor, { to: ENTRY_POINT, data, gas, ...prices })
  if (balance < budget.maxCost) throw new Error(`The paying wallet does not have enough ${network.chain.nativeCurrency.symbol} on ${network.name} to cover the fee budget.`)
  // Monad charges by the supplied limit: simulate the actual quoted gas, never
  // derive a new limit from gasUsed reported by a maximum-limit simulation.
  await simulateTransfer(validated.intent, { from: sponsor, to: ENTRY_POINT, data, gas }, validated.hash, prices)
  return { chainId, sponsor: getAddress(sponsor), gas, ...prices, ...budget, operationHash: validated.hash, quotedAt: Date.now() }
}

export async function broadcastTransfer(signed: SignedTransfer, quote: GasQuote, provider: EIP1193Provider): Promise<Hex> {
  const { chainId } = signed.intent
  const client = getPublicClient(chainId)
  if (Date.now() - quote.quotedAt > 60_000) throw new Error('The fee estimate has expired. Refresh it before sending.')
  if (quote.chainId !== chainId || quote.operationHash !== operationHash(signed.operation, chainId) || quote.gas > MAX_OUTER_GAS || quote.gas <= 0n
    || quote.maxFeePerGas <= 0n || quote.maxPriorityFeePerGas < 0n || quote.maxPriorityFeePerGas > quote.maxFeePerGas || quote.extraFee < 0n
    || (chainId === 4663 && quote.maxPriorityFeePerGas !== 0n) || quote.maxCost !== quote.gas * quote.maxFeePerGas + quote.extraFee) throw new Error('The fee estimate does not match this transfer.')
  await assertWallet(provider, quote.sponsor, chainId)
  const validated = await hydrateOperation(signed.operation, chainId)
  await validateSponsor(chainId, quote.sponsor, validated.intent.source)
  const data = handleOps(signed.operation, quote.sponsor)
  await simulateTransfer(validated.intent, { from: quote.sponsor, to: ENTRY_POINT, data, gas: quote.gas }, validated.hash, quote)
  const [balance, budget] = await Promise.all([
    client.getBalance({ address: quote.sponsor }),
    estimateFeeBudget(chainId, quote.sponsor, { to: ENTRY_POINT, data, ...quote }),
  ])
  if (budget.maxCost > quote.maxCost) throw new Error('Network fees have changed. Refresh the fee estimate.')
  if (balance < budget.maxCost) throw new Error('The paying wallet no longer has enough funds to cover the fee budget.')
  await assertWallet(provider, quote.sponsor, chainId)
  try {
    // The wallet displays and approves the exact outer transaction and its fees.
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: quote.sponsor, to: ENTRY_POINT, chainId: toHex(chainId), data, value: '0x0', gas: toHex(quote.gas), maxFeePerGas: toHex(quote.maxFeePerGas), maxPriorityFeePerGas: toHex(quote.maxPriorityFeePerGas) }] })
    if (!/^0x[\da-f]{64}$/i.test(hash)) throw new SubmissionUnknownError(quote.sponsor)
    return hash
  } catch (error) {
    if (explicitlyRejected(error)) throw new Error('Transaction rejected in the wallet.')
    throw new SubmissionUnknownError(quote.sponsor)
  }
}

export async function validateBroadcastHash(signed: SignedTransfer, sponsor: Address, hash: Hex): Promise<void> {
  if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error('Invalid transaction hash.')
  const tx = await getPublicClient(signed.intent.chainId).getTransaction({ hash })
  if (!tx.to || !isAddressEqual(tx.to, ENTRY_POINT) || !isAddressEqual(tx.from, sponsor) || tx.value !== 0n || tx.input.toLowerCase() !== handleOps(signed.operation, sponsor).toLowerCase()) {
    throw new Error('This transaction does not match the signed transfer and paying wallet. Check its hash.')
  }
}

export async function waitForTransfer(signed: SignedTransfer, hash: Hex): Promise<TransferResult> {
  const { chainId } = signed.intent
  const client = getPublicClient(chainId)
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000, pollingInterval: 2_000 })
  const intent = operationIntent(signed.operation, chainId)
  const evidence = inspectTransferLogs(receipt.logs, intent, operationHash(signed.operation, chainId))
  const base = { hash: receipt.transactionHash, blockNumber: receipt.blockNumber, received: evidence.received }
  if (receipt.status === 'reverted' || evidence.operationSuccess === false) return { ...base, status: 'failed', message: 'The transfer failed. The paying wallet may still have paid network fees.' }
  if (evidence.operationSuccess !== true || (intent.asset.kind === 'erc20' && evidence.received !== intent.amount)) return { ...base, status: 'unverified', message: 'The transaction is included, but the exact transfer is not confirmed. Check the explorer before taking any further action.' }
  try {
    const balanceAt = (address: Address, blockNumber: bigint) => intent.asset.kind === 'native'
      ? client.getBalance({ address, blockNumber })
      : client.readContract({ address: intent.asset.address, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber })
    const snapshots = await Promise.all([receipt.blockNumber - 1n, receipt.blockNumber].map((blockNumber) => Promise.all([balanceAt(intent.source, blockNumber), balanceAt(intent.recipient, blockNumber)])))
    let recipientFee = 0n
    if (intent.asset.kind === 'native' && isAddressEqual(receipt.from, intent.recipient)) {
      const fee = transactionFee(chainId, receipt)
      if (fee === null) throw new Error('The RPC did not provide the full transaction fee.')
      recipientFee = fee
    }
    if (snapshots[0][0] - snapshots[1][0] !== intent.amount || snapshots[1][1] - snapshots[0][1] + recipientFee !== intent.amount) {
      return { ...base, status: 'unverified', message: 'The balance changes in this block do not match exactly. Other transactions may explain the difference. Check the explorer before taking any further action.' }
    }
  } catch {
    return { ...base, status: 'unverified', message: 'The transfer is recorded. The RPC cannot verify its exact balance changes yet. Try checking again.' }
  }
  return { ...base, received: intent.amount, status: 'confirmed', message: 'The transfer and balance changes confirm the expected amount.' }
}

export function formatError(error: unknown): string {
  if (error instanceof AccountCompatibilityError) return error.message
  const code = (error as { code?: number } | null)?.code
  if (code === 4001 || /User rejected|denied transaction|user denied/i.test(error instanceof Error ? error.message : '')) return 'Request rejected in the wallet. The page has not requested another transaction.'
  if (code === -32002) return 'A request is already open in your wallet.'
  if (error instanceof Error) {
    if (/timeout|timed out|took too long/i.test(error.message)) return 'The response is taking longer than expected. If you approved a transaction, check its status before trying again.'
    if (/fetch|HTTP|RPC|rate limit|429/i.test(error.message)) return 'The network is temporarily unavailable. Please try again shortly.'
    if (!error.message.includes('\n') && error.message.length < 260) return error.message
  }
  return 'The operation could not be verified. Check your wallet and try again.'
}
