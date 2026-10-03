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

  return <dialog ref={dialog} className="wallet-dialog account-picker" onCancel={onCancel} aria-labelledby="account-selection-title">
    <div className="dialog-heading">
      <div><h2 id="account-selection-title">Choose {role === 'source' ? 'Fomo' : 'sponsor'} account</h2><p className="account-picker-wallet">{choice.walletName}</p></div>
      <button type="button" className="close-dialog" aria-label="Close account selection" onClick={onCancel}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
    <div className="wallet-options">
      {accounts.map(address => {
        const unavailable = address.toLowerCase() === blockedAddress?.toLowerCase()
        return <button key={address} type="button" className="account-option" aria-label={address} disabled={loading || unavailable} onClick={() => onSelect(address)}>
          <span className="account-option-details"><span className="mono">{address}</span>{unavailable ? <small>{role === 'source' ? 'Sponsor wallet' : 'Fomo wallet'}</small> : null}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{unavailable ? <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></> : <path d="m9 6 6 6-6 6" />}</svg>
        </button>
      })}
    </div>
    {accounts.every(address => address.toLowerCase() === blockedAddress?.toLowerCase()) ? <p className="field-note">Allow both accounts in your wallet.</p> : null}
    {error ? <p className="notice error" role="alert">{error}</p> : null}
    <button className="text-button full" disabled={loading} aria-busy={loading || undefined} onClick={() => void requestAccounts()}>{loading ? 'Check your wallet…' : 'Add accounts in wallet'}</button>
  </dialog>
}
