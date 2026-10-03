import { useCallback, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import type { EIP1193Provider } from 'viem'
import { getNetwork } from '../lib/chain'
import { walletConfig, walletConfigurationError, walletKit } from '../lib/walletKit'

function walletError(error: unknown): string {
  let current = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: number; cause?: unknown }
    if (item.code === 4001) return 'Request rejected in the wallet.'
    if (item.code === -32002) return 'A request is already open. Check your wallet.'
    current = item.cause
  }
  return 'The wallet did not respond correctly. Please try again in your wallet.'
}

export function useWallet() {
  const account = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [error, setError] = useState<string | null>(walletConfigurationError)

  const connect = useCallback(async ({ replace = false }: { replace?: boolean } = {}) => {
    if (!walletKit) { setError(walletConfigurationError); return }
    setError(null)
    try {
      if (replace && getAccount(walletConfig).isConnected) {
        // A WalletConnect session otherwise reuses the sending wallet on mobile.
        await walletKit.disconnect('eip155')
        if (getAccount(walletConfig).isConnected) {
          setError('The current wallet is still connected. Disconnect it and try again.')
          return
        }
      }
      await walletKit.open({ view: 'Connect', namespace: 'eip155' })
    }
    catch (cause) { setError(walletError(cause)) }
  }, [])

  const manageWallet = useCallback(async () => {
    if (!walletKit) { setError(walletConfigurationError); return }
    setError(null)
    try {
      await walletKit.open({ view: getAccount(walletConfig).isConnected ? 'Account' : 'Connect', namespace: 'eip155' })
    } catch (cause) { setError(walletError(cause)) }
  }, [])

  const ensureChain = useCallback(async (targetId: number): Promise<EIP1193Provider> => {
    const target = getNetwork(targetId)
    const initial = getAccount(walletConfig)
    if (!initial.isConnected || !initial.connector || !initial.address) {
      throw new Error('Connect a wallet first.')
    }
    const assertAccount = () => {
      const current = getAccount(walletConfig)
      if (!current.isConnected || current.connector?.uid !== initial.connector?.uid || current.address !== initial.address) {
        throw new Error('The account changed. Try again with the selected account.')
      }
    }
    setError(null)
    try {
      const initialChain = await initial.connector.getChainId()
      assertAccount()
      if (initialChain !== targetId) {
        await switchChainAsync({ chainId: targetId })
      }
      assertAccount()
      const freshProvider = await initial.connector.getProvider() as EIP1193Provider
      assertAccount()
      const [actualChain, accounts] = await Promise.all([
        freshProvider.request({ method: 'eth_chainId' }),
        freshProvider.request({ method: 'eth_accounts' }),
      ])
      assertAccount()
      if (accounts[0]?.toLowerCase() !== initial.address.toLowerCase()) {
        throw new Error('The account changed. Try again with the selected account.')
      }
      if (Number(actualChain) !== targetId) throw new Error(`Select ${target.name} in your wallet.`)
      return freshProvider
    } catch (cause) {
      const text = cause instanceof Error && /^(The account changed|Select .+ in your wallet\.)/.test(cause.message)
        ? cause.message : walletError(cause)
      setError(text)
      throw new Error(text)
    }
  }, [switchChainAsync])

  return {
    address: account.isConnected ? account.address ?? null : null,
    walletName: account.isConnected ? account.connector?.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 64) ?? 'Wallet' : null,
    error,
    connect,
    manageWallet,
    ensureChain,
  }
}
