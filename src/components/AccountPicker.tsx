import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import type { AccountChoice } from '../hooks/useWallet'
import { walletError, type WalletRole } from '../lib/walletSessions'

export function AccountPicker({ choice, role, blockedAddress, onSelect, onCancel }: {
  choice: AccountChoice
  role: WalletRole
  blockedAddress: Address | null
  onSelect: (address: Address) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [accounts, setAccounts] = useState(choice.accounts)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestOpen = useRef(false)
  useEffect(() => { dialog.current?.showModal() }, [])

  async function requestAccounts() {
    if (requestOpen.current) return
    requestOpen.current = true
    setLoading(true)
    setError('')
    try { setAccounts(await choice.requestAccounts()) }
    catch (cause) { setError(walletError(cause)) }
    finally { requestOpen.current = false; setLoading(false) }
  }

  return <dialog ref={dialog} className="wallet-dialog connection-dialog" onCancel={onCancel} aria-labelledby="account-selection-title">
    <div className="dialog-heading"><h2 id="account-selection-title">Choose {role === 'source' ? 'Fomo' : 'sponsor'} account</h2><button className="close-dialog" aria-label="Close account selection" onClick={onCancel}>×</button></div>
    <p className="account-picker-wallet">{choice.walletName}</p>
    <div className="wallet-options">
      {accounts.map(address => {
        const unavailable = address.toLowerCase() === blockedAddress?.toLowerCase()
        return <button key={address} className="account-option" aria-label={address} disabled={loading || unavailable} onClick={() => onSelect(address)}><span className="mono">{address}</span>{unavailable ? <small>{role === 'source' ? 'Sponsor wallet' : 'Fomo wallet'}</small> : null}</button>
      })}
    </div>
    {accounts.every(address => address.toLowerCase() === blockedAddress?.toLowerCase()) ? <p className="field-note">Allow both accounts in your wallet.</p> : null}
    {error ? <p className="notice error" role="alert">{error}</p> : null}
    <button className="text-button full" disabled={loading} aria-busy={loading || undefined} onClick={() => void requestAccounts()}>{loading ? 'Check your wallet…' : 'Add accounts in wallet'}</button>
  </dialog>
}
