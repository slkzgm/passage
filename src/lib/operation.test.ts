import { describe, expect, it } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, erc20Abi, toHex, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi, ENTRY_POINT, entryPointAbi, NETWORKS, getNetwork } from './chain'
import { decodeEnvelope, encodeEnvelope } from './envelope'
import { ACCOUNT_GAS_LIMITS, inspectTransferLogs, operationHash, operationIntent, transferCalldata, typedData, ZERO_WORD } from './operation'
import { parseAmount, verifySignature, nativeSpendableBalance } from './transfer'
import type { PackedOperation, SignedTransfer, TransferIntent } from './types'

// Public, disposable test key. Never used on a live chain.
const account = privateKeyToAccount(toHex(1n, { size: 32 }))
const recipient = '0x0000000000000000000000000000000000000002' as Address
const chainId = 4663
const WETH = getNetwork(chainId).wrappedNative
const intent: TransferIntent = { chainId, source: account.address, asset: { kind: 'erc20', address: WETH }, recipient, amount: 10n ** 16n }
const op: PackedOperation = { sender: account.address, nonce: 1n << 64n, initCode: '0x', callData: transferCalldata(intent), accountGasLimits: ACCOUNT_GAS_LIMITS, preVerificationGas: 0n, gasFees: ZERO_WORD, paymasterAndData: '0x', signature: '0x' }
async function signed(): Promise<SignedTransfer> {
  return { intent, asset: { kind: 'erc20', address: WETH, reservedBalance: 0n, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, balance: intent.amount }, operation: { ...op, signature: await account.signTypedData(typedData(op, chainId)) }, hash: operationHash(op, chainId) }
}

describe('signature and transfer policy', () => {
  it('verifies EIP-712 and rejects a changed destination, amount or nonce', async () => {
    const s = await signed()
    await expect(verifySignature(s.operation, chainId)).resolves.toBeUndefined()
    for (const changed of [
      { ...s.operation, callData: transferCalldata({ ...intent, amount: intent.amount + 1n }) },
      { ...s.operation, callData: transferCalldata({ ...intent, recipient: '0x0000000000000000000000000000000000000003' }) },
      { ...s.operation, nonce: op.nonce + 1n },
    ]) await expect(verifySignature(changed, chainId)).rejects.toThrow()
  })
  it('rejects approvals, native contract calls, hidden suffixes and fees charged to the source', () => {
    for (const changed of [
      { ...op, callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [WETH, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [recipient, 100n] })] }) },
      { ...op, callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [recipient, 1n, '0x1234'] }) },
      { ...op, callData: `${op.callData}00` as const },
      { ...op, gasFees: toHex(1n, { size: 32 }) },
      { ...op, initCode: '0x7702' as const },
      { ...op, paymasterAndData: recipient },
    ]) expect(() => operationIntent(changed, chainId)).toThrow()
  })
  it('rejects mistaken self, token and zero destinations', () => {
    for (const destination of [intent.source, WETH, zeroAddress, ENTRY_POINT]) expect(() => operationIntent({ ...op, callData: transferCalldata({ ...intent, recipient: destination }) }, chainId)).toThrow()
  })
  it('accepts decimal amounts without silently rounding', () => {
    expect(parseAmount('0,01', 18)).toBe(10n ** 16n)
    expect(parseAmount('12.34', 6)).toBe(12340000n)
    for (const value of ['1e3', '-1', '0', '0.0000001', '1,000,000', 'Infinity']) expect(() => parseAmount(value, 6)).toThrow()
  })
})

describe('untrusted shared authorization', () => {
  it('round-trips only signed protocol fields, excluding display metadata', async () => {
    const s = await signed()
    expect(decodeEnvelope(`#transfer=${encodeEnvelope(s)}`)).toEqual({ chainId, operation: s.operation })
    const decoded = JSON.parse(atob(encodeEnvelope(s).replaceAll('-', '+').replaceAll('_', '/')))
    expect(Object.keys(decoded)).toEqual(['version', 'chainId', 'operation'])
  })
  it('rejects oversized, unexpected and wrong-chain payloads', async () => {
    const s = await signed()
    const json = JSON.parse(atob(encodeEnvelope(s).replaceAll('-', '+').replaceAll('_', '/')))
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    for (const payload of [
      'x'.repeat(8193), encode({ ...json, chainId: 999999 }), encode({ ...json, url: 'https://example.org' }),
      encode({ ...json, operation: { ...json.operation, nonce: '-1' } }),
      encode({ ...json, operation: { ...json.operation, signature: '0x' } }),
    ]) expect(() => decodeEnvelope(payload)).toThrow()
  })
})

describe('receipt evidence', () => {
  const transfer = { address: WETH, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: intent.source, to: recipient } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [intent.amount]) }
  const userOp = (success: boolean) => ({ address: ENTRY_POINT, topics: encodeEventTopics({ abi: entryPointAbi, eventName: 'UserOperationEvent', args: { userOpHash: operationHash(op, chainId), sender: intent.source, paymaster: zeroAddress } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [op.nonce, success, 0n, 100000n]) })
  it('requires the exact token emitter and user operation event', () => {
    expect(inspectTransferLogs([transfer, userOp(true)], intent, operationHash(op, chainId))).toEqual({ received: intent.amount, operationSuccess: true })
    expect(inspectTransferLogs([{ ...transfer, address: recipient }], intent, operationHash(op, chainId))).toEqual({ received: 0n, operationSuccess: undefined })
    expect(inspectTransferLogs([userOp(false)], intent, operationHash(op, chainId)).operationSuccess).toBe(false)
  })
})


describe('multichain assets and replay protection', () => {
  it('binds every supported network signature to its own chain', async () => {
    const hashes = new Set<Hex>()
    for (const network of NETWORKS) {
      const signature = await account.signTypedData(typedData(op, network.id))
      const signedOp = { ...op, signature }
      hashes.add(operationHash(op, network.id))
      await expect(verifySignature(signedOp, network.id)).resolves.toBeUndefined()
      for (const other of NETWORKS.filter(item => item.id !== network.id)) {
        await expect(verifySignature(signedOp, other.id)).rejects.toThrow()
      }
    }
    expect(hashes.size).toBe(NETWORKS.length)
  })

  it('accepts native transfers with empty calldata and distinguishes ETH from WETH', () => {
    for (const network of NETWORKS) {
      const native: TransferIntent = { ...intent, chainId: network.id, asset: { kind: 'native' } }
      const wrapped: TransferIntent = { ...native, asset: { kind: 'erc20', address: network.wrappedNative } }
      const nativeOp = { ...op, callData: transferCalldata(native) }
      const wrappedOp = { ...op, callData: transferCalldata(wrapped) }
      expect(operationIntent(nativeOp, network.id)).toEqual(native)
      expect(operationIntent(wrappedOp, network.id)).toEqual(wrapped)
      expect(operationHash(nativeOp, network.id)).not.toBe(operationHash(wrappedOp, network.id))
      expect(() => operationIntent({ ...nativeOp, callData: `${nativeOp.callData}00` }, network.id)).toThrow()
    }
  })

  it('rejects unknown networks before constructing a signature or parsing an operation', () => {
    expect(() => typedData(op, 999999)).toThrow()
    expect(() => operationIntent(op, 999999)).toThrow()
  })

  it('rejects a valid envelope changed to another supported chain at signature verification', async () => {
    const s = await signed()
    const payload = JSON.parse(atob(encodeEnvelope(s).replaceAll('-', '+').replaceAll('_', '/')))
    payload.chainId = 1
    const encoded = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const decoded = decodeEnvelope(encoded)
    expect(decoded.chainId).toBe(1)
    await expect(verifySignature(decoded.operation, decoded.chainId)).rejects.toThrow()
  })

  it('reserves ten MON for delegated native transfers without reserving other chains', () => {
    const mon = 10n ** 18n
    expect(nativeSpendableBalance(143, 0n)).toEqual({ balance: 0n, reservedBalance: 0n })
    expect(nativeSpendableBalance(143, mon)).toEqual({ balance: 0n, reservedBalance: mon })
    expect(nativeSpendableBalance(143, 10n * mon)).toEqual({ balance: 0n, reservedBalance: 10n * mon })
    expect(nativeSpendableBalance(143, 12n * mon)).toEqual({ balance: 2n * mon, reservedBalance: 10n * mon })
    for (const network of NETWORKS.filter(item => item.id !== 143)) {
      expect(nativeSpendableBalance(network.id, mon)).toEqual({ balance: mon, reservedBalance: 0n })
    }
  })
})
