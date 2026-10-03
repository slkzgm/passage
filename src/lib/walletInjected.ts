import type { Connector } from '@wagmi/core'
import type { Address, EIP1193Provider } from 'viem'
import { cleanWalletName, parseWalletAddress, type RoleTransport } from './walletSessions'

export type AccountChoice = {
  walletName: string
  accounts: Address[]
  requestAccounts: () => Promise<Address[]>
}
export type SelectWalletAccount = (choice: AccountChoice) => Promise<Address>

/** Bind to an explicitly selected authorized account; provider account ordering has no role semantics. */
export async function injectedTransport(
  connector: Connector,
  selectAccount: SelectWalletAccount,
  isResourceBound: (resource: object) => boolean,
): Promise<RoleTransport> {
  const provider = await connector.getProvider() as EIP1193Provider
  const accounts = async () => [...new Set((await provider.request({ method: 'eth_accounts' })).map(parseWalletAddress))]
  try {
    const existing = await accounts()
    await connector.connect(existing.length ? { isReconnecting: true } : undefined)
    const requestAccounts = async () => {
      await connector.connect()
      return accounts()
    }
    const selected = parseWalletAddress(await selectAccount({ walletName: cleanWalletName(connector.name), accounts: await accounts(), requestAccounts }))
    const read = async () => {
      const [authorized, chain] = await Promise.all([accounts(), provider.request({ method: 'eth_chainId' })])
      if (!authorized.includes(selected)) throw new Error('This account is no longer authorized. Add it in your wallet and reconnect.')
      return { address: selected, chainId: Number(chain) }
    }
    await read()
    return {
      id: connector.uid, name: connector.name, resource: provider, read,
      request: async (request, authorize) => { await authorize?.(); return provider.request(request as Parameters<EIP1193Provider['request']>[0]) },
      async switchChain(chainId, authorize) {
        await authorize?.()
        if (!connector.switchChain) throw new Error('Select the network in your wallet, then retry.')
        await connector.switchChain({ chainId })
      },
      disconnect: () => connector.disconnect(),
      subscribe(listener) {
        let revision = 0
        const change = () => {
          const current = ++revision
          void read().then(state => { if (current === revision) listener(state) }, () => { if (current === revision) listener(null) })
        }
        const disconnected = () => { ++revision; listener(null) }
        provider.on('accountsChanged', change)
        provider.on('chainChanged', change)
        provider.on('disconnect', disconnected)
        return () => {
          ++revision
          provider.removeListener('accountsChanged', change)
          provider.removeListener('chainChanged', change)
          provider.removeListener('disconnect', disconnected)
        }
      },
    }
  } catch (cause) {
    if (!isResourceBound(provider)) await connector.disconnect().catch(() => {})
    throw cause
  }
}
