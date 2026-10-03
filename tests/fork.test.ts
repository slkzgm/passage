import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseEther, parseAbi, toHex, type EIP1193Provider } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

vi.mock('../src/lib/chain', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/chain')>()
  const rpc = process.env.PASSAGE_FORK_RPC
  if (rpc !== 'http://127.0.0.1:18545') throw new Error('This test writes only to the dedicated local fork.')
  const chainId = Number(process.env.PASSAGE_FORK_CHAIN_ID ?? actual.DEFAULT_CHAIN_ID)
  const client = createPublicClient({ chain: actual.getNetwork(chainId).chain, transport: http(rpc) })
  return { ...actual, getPublicClient: (requested: number) => {
    if (requested !== chainId) throw new Error('The requested chain does not match this local fork.')
    return client
  } }
})
import { DEFAULT_CHAIN_ID, getNetwork, IMPLEMENTATION } from '../src/lib/chain'
import { broadcastTransfer, prepareTransfer, quoteTransfer, signTransfer, SubmissionUnknownError, validateBroadcastHash, waitForTransfer } from '../src/lib/transfer'
import { createShareUrl, decodeEnvelope, loadSignedTransfer } from '../src/lib/envelope'

const rpc = 'http://127.0.0.1:18545'
const chainId = Number(process.env.PASSAGE_FORK_CHAIN_ID ?? DEFAULT_CHAIN_ID)
const network = getNetwork(chainId)
const { chain, wrappedNative: WETH } = network
const asset = { kind: 'erc20', address: WETH } as const
const sourceReserve = chainId === 143 ? parseEther('10') : 0n
// Disposable fixture keys stay in memory and are only used on the local fork.
const source = privateKeyToAccount(generatePrivateKey())
const sponsor = privateKeyToAccount(generatePrivateKey())
const recipient = privateKeyToAccount(generatePrivateKey()).address
const client = createPublicClient({ chain, transport: http(rpc) })
const testClient = createTestClient({ mode: 'anvil', chain, transport: http(rpc) })
const sourceWallet = createWalletClient({ account: source, chain, transport: http(rpc) })
const sponsorWallet = createWalletClient({ account: sponsor, chain, transport: http(rpc) })
const provider = (account: typeof source): EIP1193Provider => ({ request: async ({ method, params }: { method: string; params?: unknown }) => {
  if (method === 'eth_chainId') return toHex(chainId)
  if (method === 'eth_accounts') return [account.address]
  if (method === 'eth_signTypedData_v4') return account.signTypedData(JSON.parse((params as string[])[1]))
  if (method === 'eth_sendTransaction') {
    const tx = (params as Record<string, string>[])[0]
    return sponsorWallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
  }
  throw new Error(`Unexpected method: ${method}`)
} } as EIP1193Provider)

beforeAll(async () => {
  expect(await client.getChainId()).toBe(chainId)
  if (chainId === 143) console.warn('Monad fork: balances retain the 10 MON reserve; Anvil does not enforce Monad reserve rules or charge gas-limit fees.')
  if (chainId === 8453) console.warn('Base fork: Anvil does not charge L1/operator fees or populate their receipt fields; native sponsor reconciliation must remain unverified.')
  await testClient.setBalance({ address: source.address, value: parseEther('100') })
  await testClient.setBalance({ address: sponsor.address, value: parseEther('100') })
  const hash = await sourceWallet.writeContract({ address: WETH, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: parseEther('0.01') })
  await client.waitForTransactionReceipt({ hash })
  await testClient.setCode({ address: source.address, bytecode: `0xef0100${IMPLEMENTATION.slice(2)}` })
  await testClient.setBalance({ address: source.address, value: sourceReserve })
})

describe(`real ${network.name} contracts on a local fork`, () => {
  it('signs an EIP-712 transfer, shares it, sponsors it and verifies the balances', async () => {
    const prepared = await prepareTransfer({ chainId, source: source.address, asset, recipient, amount: '0.004' })
    const signed = await signTransfer(prepared, provider(source))
    const url = createShareUrl(signed, 'https://passage.example/')
    expect(url).toContain('#transfer=')
    const imported = await loadSignedTransfer(new URL(url).hash)
    expect(imported.hash).toBe(signed.hash)
    const quote = await quoteTransfer(imported, sponsor.address)
    const before = await client.getBalance({ address: sponsor.address })
    const hash = await broadcastTransfer(imported, quote, provider(sponsor))
    await expect(validateBroadcastHash(imported, sponsor.address, hash)).resolves.toBeUndefined()
    await expect(validateBroadcastHash(imported, source.address, hash)).rejects.toThrow(/does not match/)
    const result = await waitForTransfer(imported, hash)
    expect(result.status, result.message).toBe('confirmed')
    expect(await client.getBalance({ address: source.address })).toBe(sourceReserve)
    expect(await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })).toBe(parseEther('0.004'))
    expect(await client.getBalance({ address: sponsor.address })).toBeLessThan(before)
    await expect(quoteTransfer(imported, sponsor.address)).rejects.toThrow(/already been used/)
  })
  it('blocks wrong active signer, empty sponsor and insufficient token balance', async () => {
    const prepared = await prepareTransfer({ chainId, source: source.address, asset, recipient, amount: '0.001' })
    await expect(signTransfer(prepared, provider(sponsor))).rejects.toThrow(/active account/)
    const signed = await signTransfer(prepared, provider(source))
    await expect(quoteTransfer(signed, source.address)).rejects.toThrow(/different wallet/)
    await expect(quoteTransfer(signed, recipient)).rejects.toThrow(/balance|enough|funds/i)
    await expect(prepareTransfer({ chainId, source: source.address, asset, recipient, amount: '1' })).rejects.toThrow(/balance/)
    const quote = await quoteTransfer(signed, sponsor.address)
    await expect(broadcastTransfer(signed, { ...quote, quotedAt: Date.now() - 61_000 }, provider(sponsor))).rejects.toThrow(/expired/)
    expect(decodeEnvelope(new URL(createShareUrl(signed, 'https://passage.example/')).hash).operation.sender).toBe(source.address)
  })
  it('distinguishes an explicit refusal from an ambiguous provider failure', async () => {
    const signed = await signTransfer(await prepareTransfer({ chainId, source: source.address, asset, recipient, amount: '0.001' }), provider(source))
    const quote = await quoteTransfer(signed, sponsor.address)
    const base = provider(sponsor)
    let attempts = 0
    const failing = (error: unknown) => ({ request: async (request: { method: string; params?: unknown }) => {
      if (request.method === 'eth_sendTransaction') { attempts++; throw error }
      return base.request(request as never)
    } }) as EIP1193Provider
    await expect(broadcastTransfer(signed, quote, failing({ code: 4001 }))).rejects.toThrow('Transaction rejected')
    await expect(broadcastTransfer(signed, quote, failing(new Error('Lost connection')))).rejects.toBeInstanceOf(SubmissionUnknownError)
    expect(attempts).toBe(2)
  })
  it('sponsors a native transfer to a separate recipient without charging the source gas', async () => {
    await testClient.setBalance({ address: source.address, value: sourceReserve + parseEther('0.05') })
    const beforeSource = await client.getBalance({ address: source.address })
    const beforeRecipient = await client.getBalance({ address: recipient })
    const prepared = await prepareTransfer({ chainId, source: source.address, asset: { kind: 'native' }, recipient, amount: '0.01' })
    const signed = await signTransfer(prepared, provider(source))
    const imported = await loadSignedTransfer(new URL(createShareUrl(signed, 'https://passage.example/')).hash)
    expect(imported.intent.chainId).toBe(chainId)
    expect(imported.asset.kind).toBe('native')
    const quote = await quoteTransfer(imported, sponsor.address)
    const hash = await broadcastTransfer(imported, quote, provider(sponsor))
    const result = await waitForTransfer(imported, hash)
    expect(result.status, result.message).toBe('confirmed')
    expect(await client.getBalance({ address: source.address })).toBe(beforeSource - parseEther('0.01'))
    expect(await client.getBalance({ address: recipient })).toBe(beforeRecipient + parseEther('0.01'))
  })

  it('sends all available native assets to the sponsor, which alone pays the transaction fee', async () => {
    const amount = parseEther('0.04')
    expect(await client.getBalance({ address: source.address })).toBe(sourceReserve + amount)
    const beforeSponsor = await client.getBalance({ address: sponsor.address })
    const signed = await signTransfer(await prepareTransfer({
      chainId, source: source.address, asset: { kind: 'native' }, recipient: sponsor.address, amount: '0.04',
    }), provider(source))
    const quote = await quoteTransfer(signed, sponsor.address)
    const hash = await broadcastTransfer(signed, quote, provider(sponsor))
    const result = await waitForTransfer(signed, hash)
    // Base's omitted fork-only fee fields cannot establish the real chain's complete native fee.
    expect(result.status, result.message).toBe(chainId === 8453 ? 'unverified' : 'confirmed')
    const receipt = await client.getTransactionReceipt({ hash })
    const localFee = receipt.gasUsed * receipt.effectiveGasPrice
    expect(await client.getBalance({ address: source.address })).toBe(sourceReserve)
    expect(await client.getBalance({ address: sponsor.address })).toBe(beforeSponsor + amount - localFee)
    expect(localFee).toBeGreaterThan(0n)
    await expect(quoteTransfer(signed, sponsor.address)).rejects.toThrow(/already been used/)
  })

})
