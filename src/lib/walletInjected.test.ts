import { describe, expect, it, vi } from 'vitest'
import type { Connector } from '@wagmi/core'
import type { Address } from 'viem'
import { injectedTransport, type AccountChoice } from './walletInjected'
import { WalletSelectionCancelled, WalletSessions } from './walletSessions'

const source = '0x0000000000000000000000000000000000000001' as Address
const sponsor = '0x0000000000000000000000000000000000000002' as Address
function fixture() {
  let accounts = [sponsor, source]
  const listeners = new Map<string, Set<() => void>>()
  const emit = (name: string) => listeners.get(name)?.forEach(listener => listener())
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === 'eth_accounts') return accounts
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_signTypedData_v4') return '0xsignature'
    if (method === 'eth_sendTransaction') return '0xtransaction'
    throw Error(`Unexpected request ${method}`)
  })
  const provider = {
    request,
    on(name: string, callback: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback) },
    removeListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback) },
  }
  const connect = vi.fn(async () => ({ accounts, chainId: 1 }))
  const disconnect = vi.fn(async () => { accounts = []; emit('disconnect') })
  const connector = { uid: 'metamask', name: 'MetaMask', getProvider: async () => provider, connect, disconnect } as unknown as Connector
  const store = new WalletSessions()
  const bind = (role: 'source' | 'sponsor', address: Address) => store.connect(role, () => injectedTransport(connector, async () => address, resource => store.isResourceBound(resource)))
  return { provider, request, connect, disconnect, connector, store, bind, change(next: Address[]) { accounts = next; emit('accountsChanged') } }
}

describe('two accounts authorized by one injected provider', () => {
  it('binds explicit non-first addresses and dispatches role-correct signatures and transactions', async () => {
    const { bind, store, request, connect, change } = fixture()
    await bind('source', source)
    await bind('sponsor', sponsor)
    expect(connect.mock.calls).toEqual([[{ isReconnecting: true }], [{ isReconnecting: true }]])
    const sourceProvider = await store.ensureChain('source', 1)
    const sponsorProvider = await store.ensureChain('sponsor', 1)
    await sourceProvider.request({ method: 'eth_signTypedData_v4', params: [source, JSON.stringify({ domain: { chainId: 1 } })] })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_signTypedData_v4', params: [source, expect.any(String)] }))
    const sourceId = store.snapshot('source').connectionId
    const sponsorId = store.snapshot('sponsor').connectionId
    change([source, sponsor])
    await vi.waitFor(() => expect(store.snapshot('source').connectionId).toBe(sourceId))
    await sponsorProvider.request({ method: 'eth_sendTransaction', params: [{ from: sponsor, chainId: '0x1', to: source }] })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction', params: [expect.objectContaining({ from: sponsor })] }))
    expect(store.snapshot('source').address).toBe(source)
    expect(store.snapshot('sponsor').address).toBe(sponsor)
    expect(store.snapshot('sponsor').connectionId).toBe(sponsorId)
  })
  it('does not revoke shared authorization until the final role disconnects', async () => {
    const { bind, store, disconnect } = fixture()
    await bind('source', source)
    await bind('sponsor', sponsor)
    await store.disconnect('source')
    expect(disconnect).not.toHaveBeenCalled()
    expect(store.snapshot('sponsor').address).toBe(sponsor)
    await store.disconnect('sponsor')
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('keeps the shared provider alive when one role moves to a different wallet', async () => {
    const first = fixture(), second = fixture()
    await first.bind('source', source)
    await first.bind('sponsor', sponsor)
    const otherConnector = { ...second.connector, uid: 'other-wallet' } as Connector
    await first.store.connect('source', () => injectedTransport(otherConnector, async () => source, resource => first.store.isResourceBound(resource)))
    expect(first.disconnect).not.toHaveBeenCalled()
    await first.store.disconnect('sponsor')
    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(second.disconnect).not.toHaveBeenCalled()
    expect(first.store.snapshot('source').address).toBe(source)
  })
  it('preserves shared roles when replacement is cancelled or selects the other role account', async () => {
    const { bind, store, connector, disconnect } = fixture()
    await bind('source', source)
    await bind('sponsor', sponsor)
    await expect(store.connect('source', () => injectedTransport(connector, async () => { throw new WalletSelectionCancelled() }, resource => store.isResourceBound(resource)))).rejects.toThrow('cancelled')
    await expect(bind('source', sponsor)).rejects.toThrow('different account')
    expect(disconnect).not.toHaveBeenCalled()
    expect(store.snapshot('source').address).toBe(source)
    expect(store.snapshot('sponsor').address).toBe(sponsor)
  })
  it('revokes only the role whose pinned address is no longer permitted', async () => {
    const { bind, store, change, disconnect } = fixture()
    await bind('source', source)
    await bind('sponsor', sponsor)
    const provider = await store.ensureChain('source', 1)
    change([sponsor])
    await vi.waitFor(() => expect(store.snapshot('source').address).toBeNull())
    expect(store.snapshot('sponsor').address).toBe(sponsor)
    expect(disconnect).not.toHaveBeenCalled()
    await expect(provider.request({ method: 'eth_accounts' })).rejects.toThrow('account changed')
    await store.disconnect('sponsor')
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('re-reads permitted accounts after an explicit account-access request', async () => {
    const { store, connector, connect, change } = fixture()
    let choice!: AccountChoice
    await store.connect('source', () => injectedTransport(connector, async value => {
      choice = value
      change([source, sponsor])
      expect(await value.requestAccounts()).toEqual([source, sponsor])
      return sponsor
    }, resource => store.isResourceBound(resource)))
    expect(choice.accounts).toEqual([sponsor, source])
    expect(connect.mock.calls).toEqual([[{ isReconnecting: true }], []])
    expect(store.snapshot('source').address).toBe(sponsor)
  })
})
