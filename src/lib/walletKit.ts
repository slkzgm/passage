import { createAppKit } from '@reown/appkit/core'
import SignClient from '@walletconnect/sign-client'
import { createConfig, injected, getConnectors, watchConnectors } from '@wagmi/core'
import type { Chain } from 'viem'
import { NETWORKS, getPublicClient } from './chain'
import { WalletSessions, cleanWalletName, type WalletRole } from './walletSessions'
import { injectedTransport, type SelectWalletAccount } from './walletInjected'
import { approveConnection, captureWalletLink, clearWalletLink, walletConnectTransport } from './walletSessionsWc'
import { currentTheme, subscribeTheme } from './theme'

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? ''
export const walletConfigurationError = /^[a-f\d]{32}$/i.test(projectId) ? null
  : 'WalletConnect unavailable: set VITE_REOWN_PROJECT_ID to your public Reown project ID, then restart the app.'
const networks = NETWORKS.map(network => network.chain) as [Chain, ...Chain[]]
const metadata = { name: 'Passage', description: 'Sponsored asset transfers', url: window.location.origin, icons: [] as string[] }
export const walletConfig = createConfig({
  chains: networks,
  connectors: [injected()],
  storage: null,
  client: ({ chain }) => getPublicClient(chain.id),
})
export const walletSessions = new WalletSessions()
let clientPromise: ReturnType<typeof SignClient.init> | undefined
let modal: ReturnType<typeof createAppKit> | undefined
let selecting = false
const client = () => clientPromise ??= SignClient.init({ projectId, metadata })
const getModal = () => modal ??= createAppKit({
  projectId, networks, metadata, manualWCControl: true, enableReconnect: false,
  themeMode: currentTheme(), enableWalletGuide: false,
  features: { analytics: false, email: false, socials: [], swaps: false, onramp: false, send: false, receive: false, history: false },
})

subscribeTheme(() => modal?.setThemeMode(currentTheme()))

export const watchWallets = (listener: () => void) => watchConnectors(walletConfig, { onChange: listener })
export function getAvailableWallets() {
  const connectors = getConnectors(walletConfig)
  const discovered = connectors.filter(connector => connector.id !== 'injected')
  const choices = discovered.length ? discovered : connectors.filter(() => typeof window !== 'undefined' && Boolean((window as Window & { ethereum?: unknown }).ethereum))
  return [...choices.map(connector => ({ id: connector.uid, name: cleanWalletName(connector.name) })), { id: 'walletConnect', name: 'WalletConnect' }]
}

export async function connectRole(role: WalletRole, walletId: string, chainId: number, selectAccount: SelectWalletAccount) {
  if (selecting) throw new Error('Finish the open wallet selection first.')
  selecting = true
  try {
    await walletSessions.connect(role, async () => {
      if (walletId !== 'walletConnect') {
        const connector = getConnectors(walletConfig).find(item => item.uid === walletId)
        if (!connector) throw new Error('Wallet unavailable. Refresh the wallet list.')
        return injectedTransport(connector, selectAccount, resource => walletSessions.isResourceBound(resource))
      }
      if (walletConfigurationError) throw new Error(walletConfigurationError)
      const signClient = await client()
      const picker = getModal()
      picker.resetWalletConnectUri()
      await clearWalletLink(signClient)
      const actionMethod = role === 'source' ? 'eth_signTypedData_v4' : 'eth_sendTransaction'
      const { uri, approval } = await signClient.connect({
        requiredNamespaces: { eip155: { chains: [`eip155:${chainId}`], methods: [actionMethod], events: ['accountsChanged', 'chainChanged'] } },
        optionalNamespaces: { eip155: { chains: NETWORKS.map(network => `eip155:${network.id}`), methods: [actionMethod, 'wallet_switchEthereumChain'], events: ['accountsChanged', 'chainChanged'] } },
      })
      if (!uri) throw new Error('WalletConnect did not provide a connection link. Try again.')
      let opened = false
      let cancel!: () => void
      const cancelled = new Promise<void>(resolve => { cancel = resolve })
      const stop = picker.subscribeState(state => { if (state.open) opened = true; else if (opened) cancel() })
      try {
        await picker.open({ uri })
        const session = await approveConnection(approval, cancelled, async session => { await signClient.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Selection cancelled' } }) })
        // AppKit finalizes its selected mobile link on close. Capture it before another role's picker.
        stop()
        await picker.close()
        try { return walletConnectTransport(signClient, session, chainId, captureWalletLink()) }
        catch (cause) {
          await signClient.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Invalid wallet account' } }).catch(() => {})
          throw cause
        }
      } finally { stop(); await picker.close() }
    })
  } finally { selecting = false }
}
