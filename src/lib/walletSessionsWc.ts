import SignClient, { WALLETCONNECT_DEEPLINK_CHOICE } from '@walletconnect/sign-client'
import { toHex } from 'viem'
import { WalletSelectionCancelled, parseWalletAddress, type RoleTransport, type SessionState } from './walletSessions'

type Client = Awaited<ReturnType<typeof SignClient.init>>
export type WcSession = ReturnType<Client['session']['get']>
let requestQueue: Promise<unknown> = Promise.resolve()
function namespaces(session: WcSession, chainId: number) {
  return Object.entries(session.namespaces).filter(([key]) => key === 'eip155' || key === `eip155:${chainId}`).map(([, value]) => value)
}
function accounts(session: WcSession, chainId: number) {
  return namespaces(session, chainId).flatMap(value => value.accounts).filter(account => account.startsWith(`eip155:${chainId}:`))
}

export function captureWalletLink(): string | null {
  return localStorage.getItem(WALLETCONNECT_DEEPLINK_CHOICE)
}
export async function clearWalletLink(client: Client) {
  localStorage.removeItem(WALLETCONNECT_DEEPLINK_CHOICE)
  await client.core.storage.removeItem(WALLETCONNECT_DEEPLINK_CHOICE)
}

/** The SDK opens this picker-produced link itself; no wallet URL is constructed by Passage. */
export function walletConnectTransport(client: Client, session: WcSession, initialChainId: number, deepLink: string | null): RoleTransport {
  let chainId = initialChainId
  const address = parseWalletAddress(accounts(session, chainId)[0]?.split(':')[2])
  const read = async (): Promise<SessionState> => {
    const current = client.session.get(session.topic)
    if (current.expiry * 1000 <= Date.now()) throw new Error('Wallet session expired. Reconnect this wallet.')
    if (!accounts(current, chainId).some(account => account.toLowerCase() === `eip155:${chainId}:${address}`.toLowerCase())) {
      throw new Error('This account or network is no longer authorized. Reconnect this wallet.')
    }
    return { address, chainId }
  }
  const request = (request: { method: string; params?: unknown }, authorize?: () => Promise<void>) => {
    const work = requestQueue.catch(() => {}).then(async () => {
      await authorize?.()
      await read()
      const current = client.session.get(session.topic)
      if (!namespaces(current, chainId).some(value => value.methods.includes(request.method))) throw new Error('This wallet has not authorized this request. Reconnect it.')
      // SignClient reads a global deep-link key. Serialize requests and restore this topic's choice.
      if (deepLink) {
        localStorage.setItem(WALLETCONNECT_DEEPLINK_CHOICE, deepLink)
        await client.core.storage.setItem(WALLETCONNECT_DEEPLINK_CHOICE, deepLink)
      } else await clearWalletLink(client)
      await authorize?.()
      return client.request({ topic: session.topic, chainId: `eip155:${chainId}`, request: { method: request.method, params: request.params ?? [] } })
    })
    requestQueue = work
    return work
  }
  return {
    id: `wc:${session.topic}`,
    name: session.peer.metadata.name,
    read,
    request,
    async switchChain(target, authorize) {
      const current = client.session.get(session.topic)
      if (!accounts(current, target).some(account => account.toLowerCase() === `eip155:${target}:${address}`.toLowerCase())) {
        throw new Error('This wallet session does not authorize the selected network. Reconnect it on that network.')
      }
      if (namespaces(current, chainId).some(value => value.methods.includes('wallet_switchEthereumChain'))) {
        await request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(target) }] }, authorize)
      } else await authorize?.()
      // WalletConnect routes each request by CAIP chain, independently of another session's UI.
      chainId = target
    },
    async disconnect() {
      const work = requestQueue.catch(() => {}).then(() => client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } }))
      requestQueue = work
      await work
    },
    subscribe(listener) {
      const onEvent = (event: { topic: string; params: { event: { name: string; data: unknown } } }) => {
        if (event.topic !== session.topic) return
        if (event.params?.event?.name === 'chainChanged') chainId = Number(event.params.event.data)
        if (event.params?.event?.name === 'accountsChanged') {
          const accounts = event.params.event.data
          if (!Array.isArray(accounts) || !accounts.some(value => typeof value === 'string' && value.toLowerCase() === address.toLowerCase())) {
            listener(null)
            return
          }
        }
        void read().then(listener, () => listener(null))
      }
      const onUpdate = (event: { topic: string }) => { if (event.topic === session.topic) void read().then(listener, () => listener(null)) }
      const onDelete = (event: { topic: string }) => { if (event.topic === session.topic) listener(null) }
      client.on('session_event', onEvent)
      client.on('session_update', onUpdate)
      client.on('session_delete', onDelete)
      client.on('session_expire', onDelete)
      return () => {
        client.off('session_event', onEvent)
        client.off('session_update', onUpdate)
        client.off('session_delete', onDelete)
        client.off('session_expire', onDelete)
      }
    },
  }
}

export async function approveConnection<T extends { topic: string }>(
  approval: () => Promise<T>, cancelled: Promise<void>, discard: (session: T) => Promise<void>,
): Promise<T> {
  let abandoned = false
  const approved = approval().then(async session => {
    if (abandoned) { await discard(session); throw new WalletSelectionCancelled() }
    return session
  })
  return Promise.race([
    approved,
    cancelled.then(() => { abandoned = true; throw new WalletSelectionCancelled() }),
  ])
}
