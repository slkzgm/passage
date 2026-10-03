import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { createConfig } from 'wagmi'
import type { Chain } from 'viem'
import { DEFAULT_CHAIN_ID, NETWORKS, getNetwork, getPublicClient } from './chain'

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? ''
const walletConfigured = /^[a-f\d]{32}$/i.test(projectId)
export const walletConfigurationError = walletConfigured ? null
  : 'Wallet connection unavailable: set VITE_REOWN_PROJECT_ID to your public Reown project ID, then restart the app.'
const networks = NETWORKS.map((network) => network.chain) as [Chain, ...Chain[]]
const customRpcUrls = Object.fromEntries(NETWORKS.map((network) => [
  `eip155:${network.id}`, network.rpcUrls.map((url) => ({ url })),
]))
// AppKit appends its own RPC fallback to transports; Wagmi's client factory bypasses it.
const client = ({ chain }: { chain: Chain }) => getPublicClient(chain.id)
const adapter = walletConfigured ? new WagmiAdapter({
  projectId,
  networks,
  customRpcUrls,
  client,
}) : null

export const walletConfig = adapter?.wagmiConfig ?? createConfig({
  chains: networks,
  connectors: [],
  multiInjectedProviderDiscovery: false,
  client,
})

export const walletKit = adapter ? createAppKit({
  adapters: [adapter],
  projectId,
  networks,
  defaultNetwork: getNetwork(DEFAULT_CHAIN_ID).chain,
  customRpcUrls,
  metadata: {
    name: 'Passage',
    description: 'Sponsored asset transfers',
    url: window.location.origin,
    icons: [],
  },
  themeMode: 'light',
  enableReconnect: false,
  enableWalletGuide: false,
  allowUnsupportedChain: false,
  features: {
    analytics: false,
    email: false,
    socials: [],
    swaps: false,
    onramp: false,
    send: false,
    receive: false,
    history: false,
  },
}) : null
