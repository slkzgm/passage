import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { connectRole, getAvailableWallets, walletSessions, watchWallets } from '../lib/walletKit'
import type { SelectWalletAccount } from '../lib/walletInjected'
export type { AccountChoice, SelectWalletAccount } from '../lib/walletInjected'
import { WalletSelectionCancelled, type WalletRole } from '../lib/walletSessions'

export function useWallet(role: WalletRole, targetChainId: number) {
  const state = useSyncExternalStore(walletSessions.subscribe, () => walletSessions.snapshot(role))
  const [availableWallets, setAvailableWallets] = useState(getAvailableWallets)
  useEffect(() => watchWallets(() => setAvailableWallets(getAvailableWallets())), [])
  const ensureChain = useCallback((chainId: number) => walletSessions.ensureChain(role, chainId), [role])
  useEffect(() => {
    if (state.connectionId) void ensureChain(targetChainId).catch(() => {})
    // A wallet-side chain change must not trigger repeated approval prompts.
  }, [state.connectionId, targetChainId, ensureChain])
  const connect = useCallback(async (walletId: string, selectAccount: SelectWalletAccount) => {
    try { await connectRole(role, walletId, targetChainId, selectAccount) }
    catch (error) { if (!(error instanceof WalletSelectionCancelled)) walletSessions.setError(role, error) }
  }, [role, targetChainId])
  const disconnect = useCallback(() => walletSessions.disconnect(role), [role])
  return { ...state, availableWallets, connect, disconnect, ensureChain }
}
export type WalletConnection = ReturnType<typeof useWallet>
