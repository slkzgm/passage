import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, toHex, zeroAddress, type Address, type Hex } from 'viem'
import { ENTRY_POINT, entryPointAbi, getNetwork } from './chain'
import { BALANCE_READER, SIMULATION_CALLER } from './operation'
import { simulateTransfer } from './simulation'
import type { TransferIntent } from './types'

const rpc = vi.hoisted(() => ({ getBlock: vi.fn(), request: vi.fn() }))
vi.mock('./chain', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chain')>(),
  getPublicClient: () => rpc,
}))

const source: Address = '0x0000000000000000000000000000000000000011'
const recipient: Address = '0x0000000000000000000000000000000000000022'
const sponsor: Address = '0x0000000000000000000000000000000000000033'
const hash = toHex(123n, { size: 32 })
const native: TransferIntent = { chainId: 1, source, recipient, asset: { kind: 'native' }, amount: 50_000n }
const call = { from: sponsor, to: ENTRY_POINT, data: '0x1234' as Hex, gas: 300_000n }
const fees = { maxFeePerGas: 200n, maxPriorityFeePerGas: 7n }
const usedGas = 100n

type Log = { address: Address; topics: Hex[]; data: Hex }
function userOp(success = true): Log {
  return {
    address: ENTRY_POINT,
    topics: encodeEventTopics({ abi: entryPointAbi, eventName: 'UserOperationEvent', args: { userOpHash: hash, sender: source, paymaster: zeroAddress } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, success, 0n, usedGas]),
  }
}
function transfer(token: Address): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: source, to: recipient } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [native.amount]),
  }
}
function response(sourceAfter = 50_000n, recipientAfter = 70_000n, logs = [userOp()]) {
  const balance = (amount: bigint) => ({ status: '0x1', returnData: toHex(amount, { size: 32 }), gasUsed: '0x100', logs: [] })
  return [{ calls: [balance(100_000n), balance(20_000n), { status: '0x1', returnData: '0x', gasUsed: toHex(usedGas), logs }, balance(sourceAfter), balance(recipientAfter)] }]
}
function request() { return rpc.request.mock.calls.at(-1)![0] }

beforeEach(() => {
  vi.resetAllMocks()
  rpc.getBlock.mockResolvedValue({ number: 12345n, baseFeePerGas: 100n })
  rpc.request.mockResolvedValue(response())
})

describe('native transfer simulation', () => {
  it('accepts the exact signed transfer and compensates recipient-paid gas', async () => {
    rpc.request.mockResolvedValue(response(50_000n, 70_000n - usedGas * 107n))
    await expect(simulateTransfer(native, { ...call, from: recipient }, hash, fees)).resolves.toBe(usedGas)
  })

  it('accounts for Robinhood gas with its zero-priority-fee quote', async () => {
    rpc.request.mockResolvedValue(response(50_000n, 70_000n - usedGas * 100n))
    await expect(simulateTransfer({ ...native, chainId: 4663 }, { ...call, from: recipient }, hash, { ...fees, maxPriorityFeePerGas: 0n })).resolves.toBe(usedGas)
  })

  it('rejects a missing or false operation event despite matching balances', async () => {
    for (const logs of [[], [userOp(false)]]) {
      rpc.request.mockResolvedValue(response(50_000n, 70_000n, logs))
      await expect(simulateTransfer(native, call, hash, fees)).rejects.toThrow()
    }
  })

  it('rejects incorrect source or recipient deltas', async () => {
    for (const [sourceAfter, recipientAfter] of [[50_001n, 70_000n], [50_000n, 69_999n]]) {
      rpc.request.mockResolvedValue(response(sourceAfter, recipientAfter))
      await expect(simulateTransfer(native, call, hash, fees)).rejects.toThrow()
    }
  })

  it('pins Monad state and real base fee and enables validation', async () => {
    await simulateTransfer({ ...native, chainId: 143 }, call, hash, fees)
    const { params } = request()
    expect(params[1]).toBe(toHex(12345n))
    expect(params[0].validation).toBe(true)
    expect(params[0].blockStateCalls[0].blockOverrides).toEqual({ baseFeePerGas: toHex(100n) })
    expect(params[0].blockStateCalls[0].calls[2]).toMatchObject({ maxFeePerGas: toHex(200n), maxPriorityFeePerGas: toHex(7n) })
  })

  it('previews without fees and never overrides transfer participants', async () => {
    await simulateTransfer({ ...native, chainId: 143 }, { ...call, from: source, to: source })
    const state = request().params[0].blockStateCalls[0]
    expect(state.blockOverrides).toEqual({ baseFeePerGas: '0x0' })
    expect(Object.keys(state.stateOverrides).sort()).toEqual([BALANCE_READER, SIMULATION_CALLER].sort())
    for (const address of [source, recipient, sponsor]) expect(state.stateOverrides).not.toHaveProperty(address)
    expect(state.calls.every((item: { gasPrice?: Hex }) => item.gasPrice === '0x0')).toBe(true)
    for (const index of [0, 1, 3, 4]) expect(state.calls[index]).toMatchObject({ from: SIMULATION_CALLER, to: BALANCE_READER })
  })

  it('rejects failed execution and malformed balance responses', async () => {
    const failed = response()
    failed[0].calls[2].status = '0x0'
    rpc.request.mockResolvedValue(failed)
    await expect(simulateTransfer(native, call, hash, fees)).rejects.toThrow()
    const malformed = response()
    malformed[0].calls[0].returnData = '0x01'
    rpc.request.mockResolvedValue(malformed)
    await expect(simulateTransfer(native, call, hash, fees)).rejects.toThrow()
  })
})

describe('ERC-20 simulation evidence', () => {
  const token = getNetwork(1).wrappedNative
  const intent: TransferIntent = { ...native, asset: { kind: 'erc20', address: token } }

  it('requires both exact balance changes and an event from the actual token', async () => {
    rpc.request.mockResolvedValue(response(50_000n, 70_000n, [userOp(), transfer(token)]))
    await expect(simulateTransfer(intent, { ...call, from: recipient }, hash, fees)).resolves.toBe(usedGas)
    rpc.request.mockResolvedValue(response(50_000n, 70_000n, [userOp(), transfer(sponsor)]))
    await expect(simulateTransfer(intent, call, hash, fees)).rejects.toThrow()
    rpc.request.mockResolvedValue(response(50_000n, 69_999n, [userOp(), transfer(token)]))
    await expect(simulateTransfer(intent, call, hash, fees)).rejects.toThrow()
  })
})
