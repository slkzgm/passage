import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex, zeroAddress, type Address } from 'viem'
import { AccountCompatibilityError, validateSource, validateSponsor } from './accounts'
import { ENTRY_POINT, IMPLEMENTATION } from './chain'
import { BALANCE_READER, SIMULATION_CALLER, validateRecipient } from './operation'

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlockNumber: vi.fn(), getCode: vi.fn(), getBalance: vi.fn() }))
vi.mock('./chain', async (original) => {
  const actual = await original<typeof import('./chain')>()
  const { keccak256, toHex } = await import('viem')
  return {
    ...actual,
    IMPLEMENTATION_HASH: keccak256('0x6001'),
    getNetwork: (id: number) => ({ ...actual.getNetwork(id), entryPointHash: keccak256(toHex(id)) }),
    getPublicClient: () => rpc,
  }
})

const source: Address = '0x0000000000000000000000000000000000000011'
const sponsor: Address = '0x0000000000000000000000000000000000000022'
const recipient: Address = '0x0000000000000000000000000000000000000033'
const delegation = `0xef0100${IMPLEMENTATION.slice(2)}`
let chainId = 4663
beforeEach(() => {
  vi.resetAllMocks()
  chainId = 4663
  rpc.getChainId.mockImplementation(async () => chainId)
  rpc.getBlockNumber.mockResolvedValue(123n)
  rpc.getBalance.mockResolvedValue(1n)
  rpc.getCode.mockImplementation(async ({ address }: { address: Address }) => {
    if (address === source) return delegation
    if (address === IMPLEMENTATION) return '0x6001'
    if (address === ENTRY_POINT) return toHex(chainId)
    return '0x'
  })
})

describe('source compatibility', () => {
  it.each([1, 8453, 56, 143, 4663])('accepts the verified source and contracts on %i using one block', async (id) => {
    chainId = id
    await expect(validateSource(id, source)).resolves.toBeUndefined()
    expect(rpc.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 })
    expect(rpc.getCode.mock.calls.map(([request]) => request)).toEqual([
      { address: source, blockNumber: 123n }, { address: IMPLEMENTATION, blockNumber: 123n }, { address: ENTRY_POINT, blockNumber: 123n },
    ])
  })

  it.each([
    [undefined, 'undelegated'], ['0x', 'undelegated'],
    ['0xef01000000000000000000000000000000000000000042', 'unsupported-implementation'],
    ['0xef0100', 'unsupported-implementation'], ['0xef0100aa', 'unsupported-implementation'],
    ['0x60006000', 'contract-account'],
  ])('classifies source code %s as %s', async (code, expectedCode) => {
    rpc.getCode.mockImplementation(async ({ address }: { address: Address }) => address === source ? code : address === IMPLEMENTATION ? '0x6001' : toHex(chainId))
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ name: 'AccountCompatibilityError', code: expectedCode, chainId, address: source })
  })

  it.each([IMPLEMENTATION, ENTRY_POINT])('rejects changed or missing trusted code at %s', async (changed) => {
    rpc.getCode.mockImplementation(async ({ address }: { address: Address }) => address === changed ? '0x6009' : address === source ? delegation : address === IMPLEMENTATION ? '0x6001' : toHex(chainId))
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ code: 'contracts-changed' })
    rpc.getCode.mockImplementation(async ({ address }: { address: Address }) => address === changed ? undefined : address === source ? delegation : address === IMPLEMENTATION ? '0x6001' : toHex(chainId))
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ code: 'contracts-changed' })
  })

  it('distinguishes a wrong RPC chain from network unavailability', async () => {
    rpc.getChainId.mockResolvedValue(1)
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ code: 'wrong-network' })
    expect(rpc.getCode).not.toHaveBeenCalled()
    const cause = new Error('RPC unavailable')
    rpc.getChainId.mockRejectedValue(cause)
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ code: 'unavailable', cause })
  })

  it('does not label a failed code read as an incompatible account', async () => {
    rpc.getCode.mockRejectedValue(new Error('HTTP 429'))
    await expect(validateSource(chainId, source)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('paying wallet compatibility', () => {
  it.each([undefined, '0x', delegation, '0xef01000000000000000000000000000000000000000042'])('accepts funded EOA or delegated code %s', async (code) => {
    rpc.getCode.mockResolvedValue(code)
    await expect(validateSponsor(chainId, sponsor, source)).resolves.toBeUndefined()
    expect(rpc.getCode).toHaveBeenCalledWith({ address: sponsor, blockNumber: 123n })
    expect(rpc.getBalance).toHaveBeenCalledWith({ address: sponsor, blockNumber: 123n })
  })

  it.each(['0x60006000', '0xef0100aa'])('rejects contract or malformed delegation %s', async (code) => {
    rpc.getCode.mockResolvedValue(code)
    await expect(validateSponsor(chainId, sponsor, source)).rejects.toMatchObject({ code: 'contract-account' })
  })

  it.each([[zeroAddress, 'invalid-address'], [source, 'same-account'], [BALANCE_READER, 'reserved-address'], [SIMULATION_CALLER, 'reserved-address']] as const)('rejects payer %s before RPC', async (address, code) => {
    await expect(validateSponsor(chainId, address, source)).rejects.toMatchObject({ code })
    expect(rpc.getChainId).not.toHaveBeenCalled()
  })

  it('rejects an unfunded payer with an actionable typed error', async () => {
    rpc.getBalance.mockResolvedValue(0n)
    const failure = await validateSponsor(chainId, sponsor, source).catch((error) => error)
    expect(failure).toBeInstanceOf(AccountCompatibilityError)
    expect(failure).toMatchObject({ code: 'empty-sponsor', chainId, address: sponsor })
    expect(failure.message).toContain('ETH')
  })

  it('keeps RPC failures and wrong network distinct from wallet incompatibility', async () => {
    rpc.getChainId.mockResolvedValue(1)
    await expect(validateSponsor(chainId, sponsor, source)).rejects.toMatchObject({ code: 'wrong-network' })
    rpc.getChainId.mockResolvedValue(chainId)
    rpc.getBalance.mockRejectedValue(new Error('network timeout'))
    await expect(validateSponsor(chainId, sponsor, source)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('recipient validation without calldata', () => {
  it('accepts native and token destinations including a distinct paying wallet', () => {
    expect(() => validateRecipient(source, sponsor, { kind: 'native' })).not.toThrow()
    expect(() => validateRecipient(source, recipient, { kind: 'erc20', address: sponsor })).not.toThrow()
  })

  it.each(['0x1234', zeroAddress, source, ENTRY_POINT, IMPLEMENTATION, BALANCE_READER, SIMULATION_CALLER])('rejects invalid or reserved recipient %s', (address) => {
    expect(() => validateRecipient(source, address, { kind: 'native' })).toThrow()
  })

  it('preserves token-contract and reserved-source exclusions', () => {
    expect(() => validateRecipient(source, sponsor, { kind: 'erc20', address: sponsor })).toThrow(/own contract/)
    expect(() => validateRecipient(source, recipient, { kind: 'erc20', address: source })).toThrow(/sending account/)
    expect(() => validateRecipient(source, recipient, { kind: 'erc20', address: BALANCE_READER })).toThrow(/Reserved/)
    expect(() => validateRecipient(SIMULATION_CALLER, recipient, { kind: 'native' })).toThrow(/Reserved/)
  })
})
