import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { WalletSessions, type RoleTransport, type SessionState } from './walletSessions'
import { approveConnection, walletConnectTransport, type WcSession } from './walletSessionsWc'
import SignClient, { WALLETCONNECT_DEEPLINK_CHOICE } from '@walletconnect/sign-client'
const source = '0x0000000000000000000000000000000000000001' as Address
const sponsor = '0x0000000000000000000000000000000000000002' as Address
function fixture(id: string, address: Address, chainId = 1) {
  let state = { address, chainId }
  let changed: (state: SessionState | null) => void = () => {}
  const transport: RoleTransport = {
    id, name: id, read: vi.fn(async () => state),
    request: vi.fn(async (_request, authorize) => { await authorize?.(); return '0xsigned' }),
    switchChain: vi.fn(async target => { state = { ...state, chainId: target }; changed(state) }),
    disconnect: vi.fn(async () => {}),
    subscribe: listener => { changed = listener; return () => { changed = () => {} } },
  }
  return { transport, change(next: SessionState) { state = next; changed(state) } }
}
describe('independent role wallets', () => {
  it('disconnects and replaces one role without touching the other, invalidates old providers', async () => {
    const store = new WalletSessions(), a = fixture('a', source), b = fixture('b', sponsor)
    await store.connect('source', async () => a.transport)
    await store.connect('sponsor', async () => b.transport)
    const oldProvider = await store.ensureChain('source', 1)
    await store.disconnect('sponsor')
    expect(store.snapshot('source').address).toBe(source)
    expect(a.transport.disconnect).not.toHaveBeenCalled()
    await store.disconnect('source')
    await expect(oldProvider.request({ method: 'eth_accounts' })).rejects.toThrow('account changed')
  })
  it('preserves the old wallet on failed replacement and rejects role collisions', async () => {
    const store = new WalletSessions(), a = fixture('a', source), b = fixture('b', source)
    await store.connect('source', async () => a.transport)
    await expect(store.connect('source', async () => { throw Error('cancelled') })).rejects.toThrow()
    expect(store.snapshot('source').address).toBe(source)
    await expect(store.connect('sponsor', async () => b.transport)).rejects.toThrow('different account')
    expect(b.transport.disconnect).toHaveBeenCalledOnce()
    expect(a.transport.disconnect).not.toHaveBeenCalled()
  })
  it('discards a late approval after role disconnect', async () => {
    const store = new WalletSessions(), a = fixture('a', source)
    let resolve!: (transport: RoleTransport) => void
    const pending = store.connect('source', () => new Promise(r => { resolve = r }))
    await store.disconnect('source')
    resolve(a.transport)
    await expect(pending).rejects.toThrow('cancelled')
    expect(a.transport.disconnect).toHaveBeenCalledOnce()
    expect(store.snapshot('source').address).toBeNull()
  })
  it('serializes switching and refuses wrong-account or rejected-chain requests', async () => {
    const store = new WalletSessions(), a = fixture('a', source), b = fixture('b', sponsor)
    await store.connect('source', async () => a.transport)
    await store.connect('sponsor', async () => b.transport)
    let release!: () => void
    vi.mocked(a.transport.switchChain).mockImplementationOnce(async () => { await new Promise<void>(r => { release = r }); a.change({ address: source, chainId: 8453 }) })
    const first = store.ensureChain('source', 8453), second = store.ensureChain('sponsor', 8453)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(b.transport.switchChain).not.toHaveBeenCalled()
    release()
    const provider = await first
    await second
    a.change({ address: sponsor, chainId: 8453 })
    await expect(provider.request({ method: 'eth_accounts' })).rejects.toThrow('account changed')
    vi.mocked(b.transport.switchChain).mockRejectedValueOnce({ code: 4001 })
    await expect(store.ensureChain('sponsor', 1)).rejects.toBeDefined()
    expect(store.snapshot('sponsor').syncing).toBe(false)
  })
  it('rejects wrong sender and chain immediately before signing', async () => {
    const store = new WalletSessions(), a = fixture('a', source)
    await store.connect('source', async () => a.transport)
    const provider = await store.ensureChain('source', 1)
    await expect(provider.request({ method: 'eth_signTypedData_v4', params: [sponsor, JSON.stringify({ domain: { chainId: 1 } })] })).rejects.toThrow('account mismatch')
    await expect(provider.request({ method: 'eth_signTypedData_v4', params: [source, JSON.stringify({ domain: { chainId: 8453 } })] })).rejects.toThrow('network mismatch')
    expect(a.transport.request).not.toHaveBeenCalled()
  })
})

describe('WalletConnect topic routing', () => {
  function setup() {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) })
    const session = (topic: string, address: Address) => ({ topic, expiry: Date.now() / 1000 + 3600, peer: { metadata: { name: topic } }, namespaces: { eip155: { accounts: [`eip155:1:${address}`, `eip155:8453:${address}`], methods: ['eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain'], events: [] } } }) as unknown as WcSession
    const sessions = new Map([['source', session('source', source)], ['sponsor', session('sponsor', sponsor)]])
    const request = vi.fn(async (request: unknown) => ({ request, link: memory.get(WALLETCONNECT_DEEPLINK_CHOICE) }))
    const disconnect = vi.fn(async ({ topic }: { topic: string }) => { sessions.delete(topic) })
    const client = { session: { get: (topic: string) => { const session = sessions.get(topic); if (!session) throw Error('Session absent'); return session } }, core: { storage: { setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) } }, request, disconnect } as unknown as Awaited<ReturnType<typeof SignClient.init>>
    return { client, request, sessions, disconnect }
  }
  it('routes two mobile sessions and their selected links independently', async () => {
    const { client, sessions, request } = setup()
    const a = walletConnectTransport(client, sessions.get('source')!, 1, 'source-link')
    const b = walletConnectTransport(client, sessions.get('sponsor')!, 1, 'sponsor-link')
    const first = await a.request({ method: 'eth_signTypedData_v4', params: [] })
    const second = await b.request({ method: 'eth_sendTransaction', params: [] })
    expect(first).toMatchObject({ request: { topic: 'source', chainId: 'eip155:1' }, link: 'source-link' })
    expect(second).toMatchObject({ request: { topic: 'sponsor', chainId: 'eip155:1' }, link: 'sponsor-link' })
    await b.switchChain(8453)
    expect((await a.read()).chainId).toBe(1)
    expect((await b.read()).chainId).toBe(8453)
    await expect(a.switchChain(56)).rejects.toThrow('does not authorize')
    expect(request).toHaveBeenCalledTimes(3)
    await b.disconnect()
    expect((await a.read()).address).toBe(source)
  })

  it('checks role identity after queued storage work, before SignClient dispatch', async () => {
    const { client, sessions, request } = setup()
    const transport = walletConnectTransport(client, sessions.get('source')!, 1, 'source-link')
    let current = true
    vi.mocked(client.core.storage.setItem).mockImplementationOnce(async () => { current = false })
    await expect(transport.request({ method: 'eth_signTypedData_v4' }, async () => {
      if (!current) throw Error('Role replaced')
    })).rejects.toThrow('Role replaced')
    expect(request).not.toHaveBeenCalled()
  })
  it('supports chain-specific namespaces and rejects revoked account authorization', async () => {
    const { client, sessions } = setup()
    const session = sessions.get('source')!
    session.namespaces = { 'eip155:1': { ...session.namespaces.eip155, accounts: [`eip155:1:${source}`] } }
    const transport = walletConnectTransport(client, session, 1, null)
    expect((await transport.read()).address).toBe(source)
    await expect(transport.switchChain(8453)).rejects.toThrow('does not authorize')
    session.namespaces['eip155:1'].accounts = [`eip155:1:${sponsor}`]
    await expect(transport.read()).rejects.toThrow('no longer authorized')
  })

  it('routes to an approved target without requiring optional wallet UI switching', async () => {
    const { client, sessions, request } = setup()
    const session = sessions.get('source')!
    session.namespaces.eip155.methods = ['eth_signTypedData_v4']
    const transport = walletConnectTransport(client, session, 1, null)
    await transport.switchChain(8453)
    expect(request).not.toHaveBeenCalled()
    await transport.request({ method: 'eth_signTypedData_v4' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ topic: 'source', chainId: 'eip155:8453' }))
    await expect(transport.request({ method: 'eth_sendTransaction' })).rejects.toThrow('not authorized')
  })
  it('cancels picker without binding a late approved session', async () => {
    let accept!: (session: { topic: string }) => void
    let cancel!: () => void
    const discard = vi.fn(async () => {})
    const result = approveConnection(() => new Promise<{ topic: string }>(r => { accept = r }), new Promise<void>(r => { cancel = r }), discard)
    cancel()
    await expect(result).rejects.toThrow('cancelled')
    accept({ topic: 'late' })
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith({ topic: 'late' }))
  })
})
