import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTransaction } from 'viem'
import { estimateFeeBudget, transactionFee } from './fees'
import { getPublicClient } from './chain'

vi.mock('./chain', async (original) => ({ ...await original<typeof import('./chain')>(), getPublicClient: vi.fn() }))

const sponsor = '0x0000000000000000000000000000000000000001' as const
const transaction = { to: sponsor, data: '0x123456' as const, gas: 100_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }
const receipt = { gasUsed: 50_000n, effectiveGasPrice: 10n, type: 'eip1559' }

beforeEach(() => vi.clearAllMocks())

describe('network fee budgets', () => {
  it('includes buffered Base data and operator fees for the actual unsigned transaction', async () => {
    const readContract = vi.fn().mockResolvedValueOnce(100n).mockResolvedValueOnce(300n)
    vi.mocked(getPublicClient).mockReturnValue({ getTransactionCount: vi.fn().mockResolvedValue(17), readContract } as never)
    expect(await estimateFeeBudget(8453, sponsor, transaction)).toEqual({ maxCost: 2_000_800n, extraFee: 800n })
    expect(readContract.mock.calls[0][0].args).toEqual([100_000n])
    expect(parseTransaction(readContract.mock.calls[1][0].args[0])).toMatchObject({ ...transaction, chainId: 8453, nonce: 17, type: 'eip1559' })
  })

  it('fails closed when Base fee data is unavailable', async () => {
    vi.mocked(getPublicClient).mockReturnValue({ getTransactionCount: vi.fn().mockResolvedValue(1), readContract: vi.fn().mockRejectedValue(new Error('oracle unavailable')) } as never)
    await expect(estimateFeeBudget(8453, sponsor, transaction)).rejects.toThrow('oracle unavailable')
  })

  it.each([1, 56, 143, 4663])('does not double-count fee components included in chain %i gas', async (chainId) => {
    expect(await estimateFeeBudget(chainId, sponsor, transaction)).toEqual({ maxCost: 2_000_000n, extraFee: 0n })
    expect(getPublicClient).not.toHaveBeenCalled()
  })
})

describe('receipt fee reconciliation', () => {
  it.each([1, 56, 143, 4663])('uses charged receipt gas on chain %i', (chainId) => {
    expect(transactionFee(chainId, receipt)).toBe(500_000n)
  })

  it('includes Base L1 fees without treating missing zero operator fields as unknown', () => {
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n })).toBe(500_040n)
  })

  it('includes non-zero Jovian operator fees retained as raw RPC fields by viem', () => {
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n, operatorFeeScalar: '0x2', operatorFeeConstant: '0xa', daFootprintGasScalar: '0x94' })).toBe(10_500_050n)
  })

  it('refuses incomplete or ambiguous Base fee fields', () => {
    expect(transactionFee(8453, receipt)).toBeNull()
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n, operatorFeeConstant: '0x1' })).toBeNull()
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n, operatorFeeConstant: '0x1', operatorFeeScalar: '0x2' })).toBeNull()
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n, operatorFeeConstant: null, operatorFeeScalar: null })).toBeNull()
  })

  it('handles a constant-only operator fee and rejects invalid receipts', () => {
    expect(transactionFee(8453, { ...receipt, l1Fee: 40n, operatorFeeConstant: '0xa', operatorFeeScalar: '0x0' })).toBe(500_050n)
    expect(transactionFee(1, { ...receipt, gasUsed: -1n })).toBeNull()
    expect(transactionFee(1, { ...receipt, type: 'eip4844' })).toBeNull()
  })
})
