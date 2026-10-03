import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes, type CSSProperties } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { AccountCompatibilityError, validateSource, validateSponsor } from './lib/accounts'
import { validateRecipient } from './lib/operation'
import { formatUnits, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { useWallet, type AccountChoice } from './hooks/useWallet'
import { AccountPicker } from './components/AccountPicker'
import { WalletSelectionCancelled, type WalletRole } from './lib/walletSessions'
import { DEFAULT_CHAIN_ID, NETWORKS, getNetwork } from './lib/chain'
import { base, bsc, mainnet, monad, robinhood } from 'viem/chains'
import { createShareUrl, loadSignedTransfer } from './lib/envelope'
import { SubmissionUnknownError, broadcastTransfer, formatError, parseAmount, prepareTransfer, quoteTransfer, readAsset, signTransfer, validateBroadcastHash, waitForTransfer } from './lib/transfer'
import type { GasQuote, PreparedTransfer, SignedTransfer, Asset, TransferResult } from './lib/types'
import { initialTransferFragment as initialFragment } from './lib/session'
import { currentTheme, setTheme, subscribeTheme } from './lib/theme'

let sharedTransfer: Promise<SignedTransfer> | undefined
const chainLogos: Record<number, string> = { [mainnet.id]: '/logos/eth.webp', [base.id]: '/logos/base.webp', [bsc.id]: '/logos/bnb-chain.webp', [monad.id]: '/logos/monad.webp', [robinhood.id]: '/logos/robinhood.webp' }
// Wrapped assets reuse their native logo; the symbol tells them apart.
const nativeLogos: Record<string, string> = { ETH: '/logos/eth.webp', BNB: '/logos/bnb.webp', MON: '/logos/monad.webp' }
// The customizable select draws option logos from this property (see styles.css).
const logoStyle = (url: string | undefined) => (url ? { '--logo': `url(${url})` } : undefined) as CSSProperties | undefined
const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

function Icon({ name, size = 20 }: { name: 'arrow' | 'wallet' | 'check' | 'copy' | 'external' | 'sun' | 'moon'; size?: number }) {
  const paths = {
    arrow: <><path d="M4 12h16M14 6l6 6-6 6" /></>,
    wallet: <><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 1 0-4" /><path d="M21 12h-5v5h5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
    external: <><path d="M14 4h6v6M20 4 10 14M10 4H4v16h16v-6" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme)
  const next = theme === 'dark' ? 'light' : 'dark'
  return <button type="button" className="theme-toggle" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setTheme(next)}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button>
}

function AddressLink({ address, chainId }: { address: string; chainId: number }) {
  return <a className="address" href={`${getNetwork(chainId).explorer}/address/${address}`} target="_blank" rel="noreferrer">{address}<Icon name="external" size={13} /></a>
}

function TransferSummary({ transfer }: { transfer: PreparedTransfer }) {
  return <div className="transfer-summary">
    <div className="summary-amount"><span className="eyebrow">Amount</span><p>{formatUnits(transfer.intent.amount, transfer.asset.decimals)} <span>{transfer.asset.symbol}</span></p></div>
    <dl className="summary-details">
      <div><dt>Network</dt><dd>{getNetwork(transfer.intent.chainId).name}</dd></div>
      <div><dt>From</dt><dd><AddressLink address={transfer.intent.source} chainId={transfer.intent.chainId} /></dd></div>
      <div><dt>To</dt><dd><AddressLink address={transfer.intent.recipient} chainId={transfer.intent.chainId} /></dd></div>
    </dl>
    <details className="technical"><summary>Details</summary><dl>
      {transfer.intent.asset.kind === 'erc20' ? <div><dt>Token contract</dt><dd><AddressLink address={transfer.intent.asset.address} chainId={transfer.intent.chainId} /></dd></div> : <div><dt>Asset</dt><dd>Native {transfer.asset.symbol}</dd></div>}
      <div><dt>Authorization ID</dt><dd className="mono">{transfer.hash}</dd></div>
    </dl></details>
  </div>
}

function Button({ children, busy, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; children: ReactNode }) {
  return <button {...props} aria-busy={busy || undefined}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{children}</button>
}

function WalletCard({ label, wallet, chainId, disabled, onChoose, onDisconnect, onSync }: {
  label: 'Fomo wallet' | 'Sponsor wallet'
  wallet: ReturnType<typeof useWallet>
  chainId: number
  disabled: boolean
  onChoose: () => void
  onDisconnect: () => void
  onSync: () => void
}) {
  const actionLabel = label === 'Fomo wallet' ? label : 'sponsor wallet'
  const wrongChain = Boolean(wallet.address && wallet.chainId !== chainId)
  return <section className="wallet-role" aria-label={label}>
    <div className="wallet-role-heading"><span className="field-label">{label}</span><span className="wallet-role-hint">{label === 'Fomo wallet' ? 'Holds and signs the assets' : 'Pays the network fees'}</span></div>
    {wallet.address ? <div className="wallet-identity">
      {/* Deterministic hue gives each address a recognizable avatar without extra assets. */}
      <span className="wallet-avatar" style={{ '--hue': parseInt(wallet.address.slice(2, 6), 16) % 360 } as CSSProperties} aria-hidden="true" />
      <span className="wallet-identity-text"><strong className="mono" title={wallet.address}>{shortAddress(wallet.address)}</strong><small>{wallet.walletName}</small></span>
      <span className={`wallet-network-state${wrongChain ? ' needs-sync' : ''}`} role="status">{wallet.syncing ? <><span className="spinner" />Switching…</> : wrongChain ? 'Switch needed' : <Icon name="check" size={14} />}</span>
      <span className="wallet-role-actions"><button type="button" aria-label={`Change ${actionLabel}`} disabled={disabled || wallet.syncing} onClick={onChoose}>Change</button><button type="button" aria-label={`Disconnect ${actionLabel}`} disabled={disabled || wallet.syncing} onClick={onDisconnect}>Disconnect</button></span>
    </div> : <button type="button" className="source-wallet" disabled={disabled || wallet.syncing} onClick={onChoose}><span className="source-icon"><Icon name="wallet" size={17} /></span><span><strong>Connect {actionLabel}</strong></span><Icon name="arrow" size={18} /></button>}
    {wallet.error ? <p className="notice error" role="alert">{wallet.error}</p> : null}
    {wrongChain && !wallet.syncing ? <button type="button" className="text-button sync-network" aria-label={`Sync ${actionLabel} network`} disabled={disabled} onClick={onSync}>Switch to {getNetwork(chainId).name}</button> : null}
  </section>
}

const accountCheckOptions = {
  retry: false,
  gcTime: 0,
  staleTime: 0,
  refetchOnWindowFocus: 'always',
  refetchInterval: 30_000,
} as const

function AccountStatus({ checking, paused, error, label, retry, disabled }: { checking: boolean; paused: boolean; error: Error | null; label: string; retry: () => void; disabled: boolean }) {
  if (paused) return <p className="notice" role="status">Connection unavailable. Reconnect to check your account.</p>
  if (checking) return <p className="account-status" role="status"><span className="spinner" aria-hidden="true" />Checking {label}…</p>
  if (!error) return null
  return <div className="notice error" role="alert"><span>{formatError(error)}</span><button type="button" className="text-button" disabled={disabled} onClick={retry}>Check again</button></div>
}

export default function App() {
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID)
  const wallet = useWallet('source', selectedChainId)
  const sponsorWallet = useWallet('sponsor', selectedChainId)
  const walletRef = useRef(wallet)
  walletRef.current = wallet
  const sponsorRef = useRef(sponsorWallet)
  sponsorRef.current = sponsorWallet
  const [choosingWallet, setChoosingWallet] = useState<'source' | 'sponsor' | null>(null)
  const walletDialog = useRef<HTMLDialogElement>(null)
  const [accountChoice, setAccountChoice] = useState<{
    choice: AccountChoice
    role: WalletRole
    blockedAddress: Address | null
    onSelect: (address: Address) => void
    onCancel: () => void
  } | null>(null)
  const [assetChoice, setAssetChoice] = useState<'native' | 'wrapped' | 'custom'>('wrapped')
  const [customAddress, setCustomAddress] = useState('')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [recipientTouched, setRecipientTouched] = useState(false)
  const [amount, setAmount] = useState('')
  const [recipientChoice, setRecipientChoice] = useState<'custom' | 'sponsor'>('custom')
  const [customRecipient, setCustomRecipient] = useState('')
  const recipient = recipientChoice === 'sponsor' ? sponsorWallet.address ?? '' : customRecipient
  const [prepared, setPrepared] = useState<PreparedTransfer>()
  const [signed, setSigned] = useState<SignedTransfer>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [quote, setQuote] = useState<GasQuote & { connectionId: typeof sponsorWallet.connectionId }>()
  const [txHash, setTxHash] = useState<Hex>()
  const [submissionUnknown, setSubmissionUnknown] = useState<Address>()
  const [recoveryHash, setRecoveryHash] = useState('')
  const [result, setResult] = useState<TransferResult>()
  const [busy, setBusy] = useState(initialFragment ? 'Loading transfer…' : '')
  const [error, setError] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [restartModal, setRestartModal] = useState(false)
  const restartDialog = useRef<HTMLDialogElement>(null)
  const actionLock = useRef(Boolean(initialFragment))
  const formVersion = useRef(0)
  const syncingWallets = wallet.syncing || sponsorWallet.syncing
  const controlsBusy = Boolean(busy) || syncingWallets
  const sourceNetworkBlocked = Boolean(wallet.error && wallet.chainId !== selectedChainId)
  const sponsorNetworkBlocked = Boolean(sponsorWallet.error && sponsorWallet.chainId !== selectedChainId)
  const network = getNetwork(selectedChainId)
  const nativeCurrency = network.chain.nativeCurrency
  const sourceAddress = signed?.intent.source ?? prepared?.intent.source ?? wallet.address
  const checkingAccounts = !txHash && !submissionUnknown
  const sourceCheck = useQuery({
    ...accountCheckOptions,
    queryKey: ['source-account', selectedChainId, sourceAddress?.toLowerCase()],
    queryFn: sourceAddress ? async () => { await validateSource(selectedChainId, sourceAddress); return true } : skipToken,
    enabled: Boolean(sourceAddress && checkingAccounts),
  })
  const sponsorAddress = sponsorWallet.address
  const sponsorCheck = useQuery({
    ...accountCheckOptions,
    queryKey: ['sponsor-account', selectedChainId, sponsorAddress?.toLowerCase(), sourceAddress?.toLowerCase()],
    queryFn: sponsorAddress && sourceAddress ? async () => { await validateSponsor(selectedChainId, sponsorAddress, sourceAddress); return true } : skipToken,
    enabled: Boolean(sponsorAddress && sourceAddress && checkingAccounts),
  })
  // Cached success cannot unlock a new account/network or an in-flight refresh.
  const sourceReady = Boolean(sourceAddress && sourceCheck.isSuccess && !sourceCheck.isFetching && !sourceCheck.isPaused)
  const sponsorReady = Boolean(sponsorAddress && sourceAddress && sponsorCheck.isSuccess && !sponsorCheck.isFetching && !sponsorCheck.isPaused)
  const sourceStatus = sourceAddress && checkingAccounts ? <AccountStatus checking={sourceCheck.isPending || sourceCheck.isFetching} paused={sourceCheck.isPaused} error={sourceCheck.error} label="sending account" retry={() => void sourceCheck.refetch()} disabled={controlsBusy} /> : null
  const sponsorStatus = sponsorAddress && sourceAddress && checkingAccounts ? <AccountStatus checking={sponsorCheck.isPending || sponsorCheck.isFetching} paused={sponsorCheck.isPaused} error={sponsorCheck.error} label="paying account" retry={() => void sponsorCheck.refetch()} disabled={controlsBusy} /> : null
  const actionError = error === sourceCheck.error?.message || error === sponsorCheck.error?.message ? '' : error
  const assetAddress = assetChoice === 'wrapped' ? network.wrappedNative : customAddress
  const selectedAsset: Asset | undefined = assetChoice === 'native' ? { kind: 'native' } : isAddress(assetAddress) && assetAddress !== zeroAddress ? { kind: 'erc20', address: getAddress(assetAddress) } : undefined
  const assetCheck = useQuery({
    ...accountCheckOptions,
    queryKey: ['asset-balance', selectedChainId, assetChoice === 'native' ? 'native' : assetAddress.toLowerCase(), wallet.address?.toLowerCase()],
    queryFn: selectedAsset && wallet.address ? () => readAsset(selectedChainId, selectedAsset, wallet.address!) : skipToken,
    enabled: Boolean(selectedAsset && wallet.address && !prepared && !signed),
  })
  const assetInfo = assetCheck.isSuccess && !assetCheck.isPaused ? assetCheck.data : undefined
  const assetError = sourceReady && assetCheck.error ? formatError(assetCheck.error) : undefined
  const assetLoading = Boolean(wallet.address && selectedAsset && !prepared && !signed && (assetCheck.isPending || assetCheck.isFetching))
  const assetSymbol = assetInfo?.symbol || (assetChoice === 'native' ? nativeCurrency.symbol : assetChoice === 'wrapped' ? `W${nativeCurrency.symbol}` : '')
  const step = signed ? 3 : prepared ? 2 : 1
  const activeQuote = quote && quote.chainId === signed?.intent.chainId && sponsorWallet.address?.toLowerCase() === quote.sponsor.toLowerCase() && sponsorWallet.connectionId === quote.connectionId ? quote : undefined
  const isSource = Boolean(signed && sponsorWallet.address?.toLowerCase() === signed.intent.source.toLowerCase())
  const isPreparedSource = Boolean(prepared && wallet.address?.toLowerCase() === prepared.intent.source.toLowerCase())
  const confirmed = result?.status === 'confirmed'
  const failed = result?.status === 'failed'
  let amountError = ''
  let recipientError = ''
  const tokenError = tokenTouched && assetChoice === 'custom' && customAddress && !selectedAsset ? 'Enter a valid, non-zero token contract address.' : ''
  if (amount.trim() && assetInfo) {
    try {
      if (parseAmount(amount, assetInfo.decimals) > assetInfo.balance) amountError = 'The amount exceeds the available balance.'
    } catch (reason) { amountError = formatError(reason) }
  }
  if (wallet.address && selectedAsset && recipient && (recipientTouched || isAddress(recipient))) {
    try { validateRecipient(wallet.address, recipient, selectedAsset) }
    catch (reason) { recipientError = formatError(reason) }
  }

  // Explains why "Review transfer" is disabled; validation errors and account checks already speak for themselves.
  const reviewHint = !wallet.address ? 'Connect your Fomo wallet to get started.' : !amount ? 'Enter the amount to send.' : !recipient && recipientChoice === 'custom' ? 'Add the recipient address.' : ''

  useEffect(() => {
    if (!initialFragment) return
    let current = true
    sharedTransfer ??= loadSignedTransfer(initialFragment)
    sharedTransfer.then(value => { if (current) { setSelectedChainId(value.intent.chainId); setSigned(value) } }).catch(reason => { if (current) setError(formatError(reason)) }).finally(() => {
      if (current) { setBusy(''); actionLock.current = false }
    })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!quote) return
    const timer = window.setTimeout(() => setQuote(undefined), Math.max(0, quote.quotedAt + 60_000 - Date.now()))
    return () => window.clearTimeout(timer)
  }, [quote])

  useEffect(() => { setError('') }, [wallet.address, sponsorWallet.address, selectedChainId])

  useEffect(() => {
    if (choosingWallet) walletDialog.current?.showModal()
    else walletDialog.current?.close()
  }, [choosingWallet])

  useEffect(() => {
    if (restartModal) restartDialog.current?.showModal()
    else restartDialog.current?.close()
  }, [restartModal])

  async function run(label: string, action: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(label)
    setError('')
    try { await action() } catch (reason) {
      setError(formatError(reason))
      if (reason instanceof AccountCompatibilityError) {
        void (reason.address.toLowerCase() === sourceAddress?.toLowerCase() ? sourceCheck : sponsorCheck).refetch()
      }
    }
    finally { actionLock.current = false; setBusy('') }
  }

  function chooseWallet(role: 'source' | 'sponsor') {
    if (!actionLock.current) setChoosingWallet(role)
  }

  function connectWallet(id: string) {
    if (!choosingWallet) return
    const role = choosingWallet
    const selected = choosingWallet === 'source' ? wallet : sponsorWallet
    setChoosingWallet(null)
    void run('Connecting wallet…', () => selected.connect(id, async choice => {
      const blockedAddress = role === 'source' ? sponsorRef.current.address : sourceAddress
      if (choice.accounts.length === 1 && choice.accounts[0].toLowerCase() !== blockedAddress?.toLowerCase()) return choice.accounts[0]
      return new Promise<Address>((resolve, reject) => {
        setAccountChoice({ choice, role, blockedAddress,
          onSelect: address => { setAccountChoice(null); resolve(address) },
          onCancel: () => { setAccountChoice(null); reject(new WalletSelectionCancelled()) },
        })
      })
    }))
  }

  function edit(update: () => void) {
    formVersion.current += 1
    update()
    setError('')
  }

  async function prepare() {
    await run('Checking transfer…', async () => {
      const source = wallet.address
      if (!source) throw new Error('Connect the account holding your assets.')
      if (!sourceReady || !assetInfo || assetLoading || amountError || recipientError || tokenError) return
      if (!selectedAsset || !isAddress(recipient)) throw new Error('Check the asset and recipient addresses.')
      const version = formVersion.current
      const next = await prepareTransfer({ chainId: selectedChainId, source, asset: selectedAsset, recipient: getAddress(recipient), amount })
      if (version !== formVersion.current || walletRef.current.address?.toLowerCase() !== source.toLowerCase()) throw new Error('The account changed. Review the transfer again.')
      if (recipientChoice === 'sponsor' && sponsorRef.current.address?.toLowerCase() !== recipient.toLowerCase()) throw new Error('The recipient changed. Review the transfer again.')
      setPrepared(next)
      setAcknowledged(false)
    })
  }

  async function sign() {
    await run('Sign in your wallet…', async () => {
      if (!sourceReady || syncingWallets || sourceNetworkBlocked) return
      if (!prepared || !acknowledged || !isPreparedSource) throw new Error('Reconnect your Fomo account to sign this transfer.')
      await validateSource(prepared.intent.chainId, prepared.intent.source)
      if (walletRef.current.address?.toLowerCase() !== prepared.intent.source.toLowerCase()) throw new Error('Reconnect the sending account to sign.')
      const provider = await wallet.ensureChain(prepared.intent.chainId)
      const next = await signTransfer(prepared, provider)
      setSigned(next)
      setQuote(undefined)
    })
  }

  async function estimate() {
    await run('Estimating fees…', async () => {
      const sponsor = sponsorWallet.address
      const connectionId = sponsorWallet.connectionId
      if (!sourceReady || !sponsorReady || syncingWallets) return
      if (!signed || !sponsor || isSource) throw new Error('Connect another account to cover the fees.')
      const next = await quoteTransfer(signed, sponsor)
      if (sponsorRef.current.address?.toLowerCase() !== sponsor.toLowerCase() || sponsorRef.current.connectionId !== connectionId) throw new Error('The fee-paying account changed. Estimate the fees again.')
      setQuote({ ...next, connectionId })
    })
  }

  async function send() {
    await run('Confirm in your wallet…', async () => {
      if (submissionUnknown || txHash) throw new Error('Check the existing transaction before trying again.')
      if (!sourceReady || !sponsorReady || syncingWallets || sponsorNetworkBlocked) return
      if (!signed || !activeQuote) throw new Error('Estimate fees with the paying account before continuing.')
      await Promise.all([validateSource(signed.intent.chainId, signed.intent.source), validateSponsor(signed.intent.chainId, activeQuote.sponsor, signed.intent.source)])
      if (Date.now() - activeQuote.quotedAt >= 60_000) { setQuote(undefined); return }
      if (sponsorRef.current.address?.toLowerCase() !== activeQuote.sponsor.toLowerCase() || sponsorRef.current.connectionId !== activeQuote.connectionId) throw new Error('The paying account changed. Estimate the fees again.')
      const provider = await sponsorWallet.ensureChain(signed.intent.chainId)
      if (sponsorRef.current.connectionId !== activeQuote.connectionId) throw new Error('The paying account changed. Estimate the fees again.')
      let hash: Hex
      try { hash = await broadcastTransfer(signed, activeQuote, provider) }
      catch (reason) {
        if (reason instanceof SubmissionUnknownError) { setSubmissionUnknown(reason.sponsor); return }
        throw reason
      }
      setTxHash(hash)
      setBusy('Verifying transfer…')
      setResult(await waitForTransfer(signed, hash))
    })
  }

  async function recoverSubmission() {
    await run('Checking transaction…', async () => {
      if (!signed || !submissionUnknown || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) throw new Error('Enter a valid transaction hash: 0x followed by 64 hexadecimal characters.')
      const hash = recoveryHash as Hex
      await validateBroadcastHash(signed, submissionUnknown, hash)
      setTxHash(hash)
      setSubmissionUnknown(undefined)
      setResult(await waitForTransfer(signed, hash))
    })
  }

  async function copyShare() {
    await run('Preparing link…', async () => {
      if (!signed) return
      const url = createShareUrl(signed)
      setShareUrl(url)
      try { await navigator.clipboard.writeText(url); setCopied(true) }
      catch { setCopied(false) }
    })
  }

  function reset() {
    if (actionLock.current) return
    formVersion.current += 1
    setPrepared(undefined); setSigned(undefined); setQuote(undefined); setResult(undefined); setTxHash(undefined); setSubmissionUnknown(undefined); setRecoveryHash('')
    setAssetChoice('wrapped'); setCustomAddress('')
    setTokenTouched(false); setRecipientTouched(false)
    setAmount(''); setRecipientChoice('custom'); setCustomRecipient(''); setAcknowledged(false); setShareUrl(''); setCopied(false); setError(''); setRestartModal(false)
  }

  return <div className="app-shell">
    <header className="site-header">
      <a href="/" className="brand" aria-label="Passage, home" onClick={event => { event.preventDefault(); if (!busy) signed && !confirmed ? setRestartModal(true) : reset() }}><span className="brand-symbol" aria-hidden="true"><i /><i /></span><span className="brand-wordmark">passage<span className="brand-dot">.</span></span></a>
      <div className="header-right"><ThemeToggle /><span className="network-picker"><img className="select-logo" src={chainLogos[selectedChainId]} alt="" /><select className="network-select" aria-label="Network" value={selectedChainId} disabled={controlsBusy || Boolean(prepared) || Boolean(signed)} onChange={event => { const next = Number(event.target.value); if (next !== selectedChainId) edit(() => { setSelectedChainId(next); setAssetChoice('wrapped'); setCustomAddress(''); setAmount(''); setTokenTouched(false) }) }}>{NETWORKS.map(item => <option key={item.id} value={item.id} style={logoStyle(chainLogos[item.id])}>{item.name}</option>)}</select></span></div>
    </header>

    <main className="transfer-main">
      <h1 className="sr-only">Asset transfer</h1>
      <section className="transfer-card" aria-label="Asset transfer" aria-busy={Boolean(busy)}>
        <ol className="stepper" aria-label="Transfer steps">{['Prepare', 'Sign', 'Send'].map((name, index) => <li key={name} className={step === index + 1 ? 'current' : step > index + 1 ? 'complete' : ''} aria-current={step === index + 1 ? 'step' : undefined}><span className="step-number">{step > index + 1 ? <Icon name="check" size={13} /> : index + 1}</span><span>{name}</span></li>)}</ol>
        <div className="card-content">
          <div className="wallet-roles" aria-label="Connected wallets">
            <WalletCard label="Fomo wallet" wallet={wallet} chainId={selectedChainId} disabled={controlsBusy} onChoose={() => chooseWallet('source')} onDisconnect={() => void run('Disconnecting Fomo wallet…', wallet.disconnect)} onSync={() => void run('Switching Fomo wallet network…', async () => { await wallet.ensureChain(selectedChainId) })} />
            <WalletCard label="Sponsor wallet" wallet={sponsorWallet} chainId={selectedChainId} disabled={controlsBusy} onChoose={() => chooseWallet('sponsor')} onDisconnect={() => void run('Disconnecting sponsor wallet…', sponsorWallet.disconnect)} onSync={() => void run('Switching sponsor wallet network…', async () => { await sponsorWallet.ensureChain(selectedChainId) })} />
          </div>
          {!prepared && !signed ? <>
            <div className="section-heading"><h2>Send assets</h2></div>
            <form onSubmit={event => { event.preventDefault(); void prepare() }}>
              {sourceStatus}
              {sponsorStatus}
              <div className="field">
                <div className="amount-input">
                  <label htmlFor="amount">Amount</label>
                  <div className="amount-row">
                    <input id="amount" inputMode="decimal" aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'amount-error' : undefined} placeholder="0.00" autoComplete="off" value={amount} disabled={controlsBusy} onChange={event => edit(() => setAmount(event.target.value.replace(',', '.')))} required />
                    <label htmlFor="asset-select" className="sr-only">Asset</label>
                    <span className="select-wrap asset-select">{assetChoice === 'custom' ? <span className="select-logo token-placeholder" aria-hidden="true" /> : <img className="select-logo" src={nativeLogos[nativeCurrency.symbol]} alt="" />}<select id="asset-select" value={assetChoice} disabled={controlsBusy} onChange={event => { const next = event.target.value as 'native' | 'wrapped' | 'custom'; if (next !== assetChoice) edit(() => { setAssetChoice(next); setCustomAddress(''); setAmount(''); setTokenTouched(false) }) }}><option value="native" style={logoStyle(nativeLogos[nativeCurrency.symbol])}>{nativeCurrency.symbol}</option><option value="wrapped" style={logoStyle(nativeLogos[nativeCurrency.symbol])}>{`W${nativeCurrency.symbol}`}</option><option value="custom" className="custom-token">{assetChoice === 'custom' && assetSymbol ? assetSymbol : 'Custom'}</option></select></span>
                  </div>
                  <div className="balance-row"><span className="balance">{assetLoading ? 'Loading balance…' : assetInfo ? `Available: ${formatUnits(assetInfo.balance, assetInfo.decimals)} ${assetInfo.symbol}` : wallet.address ? '' : 'Connect a wallet to see your balance'}</span><button type="button" className="max-button" disabled={!assetInfo || assetLoading || assetInfo.balance === 0n || controlsBusy} onClick={() => edit(() => { if (assetInfo) setAmount(formatUnits(assetInfo.balance, assetInfo.decimals)) })}>Max</button></div>
                </div>
              </div>
              {assetChoice === 'custom' ? <div className="field"><label htmlFor="token-address">Contract address</label><input id="token-address" className="mono" onBlur={() => setTokenTouched(true)} aria-invalid={Boolean(tokenError)} aria-describedby={tokenError ? 'token-error' : undefined} placeholder="0x…" value={customAddress} disabled={controlsBusy} onChange={event => { const next = event.target.value.trim(); if (next !== customAddress) edit(() => { setCustomAddress(next); setAmount(''); setTokenTouched(false) }) }} autoComplete="off" spellCheck={false} required /></div> : null}
              {tokenError ? <p id="token-error" className="notice error" role="alert">{tokenError}</p> : null}
              {amountError ? <p id="amount-error" className="notice error" role="alert">{amountError}</p> : null}
              {sourceReady && assetInfo && assetInfo.reservedBalance > 0n ? <p className="field-note reserve-note">{formatUnits(assetInfo.reservedBalance, assetInfo.decimals)} {assetInfo.symbol} is reserved by Monad and cannot be transferred.</p> : null}
              <div className="field recipient-field">
                <div className="label-row"><label htmlFor="recipient-select">Recipient</label>
                <span className="select-wrap recipient-select"><select id="recipient-select" value={recipientChoice} disabled={controlsBusy} onChange={event => edit(() => { setRecipientChoice(event.target.value as 'custom' | 'sponsor'); setRecipientTouched(false) })}><option value="sponsor" disabled={!sponsorWallet.address}>Sponsor wallet</option><option value="custom">Another wallet</option></select></span></div>
                {recipientChoice === 'sponsor' ? <output className="recipient-address mono" aria-label="Recipient address">{recipient || 'Connect a sponsor wallet.'}</output> : <><label htmlFor="recipient" className="sr-only">Recipient address</label><input id="recipient" className="mono" onBlur={() => setRecipientTouched(true)} aria-invalid={Boolean(recipientError)} aria-describedby={recipientError ? 'recipient-error' : undefined} placeholder="0x…" autoComplete="off" spellCheck={false} value={customRecipient} disabled={controlsBusy} onChange={event => edit(() => setCustomRecipient(event.target.value.trim()))} required /></>}
              </div>
              {recipientError ? <p id="recipient-error" className="notice error" role="alert">{recipientError}</p> : null}
              {assetError ? <div className="notice error" role="alert"><span>{assetError}</span><button type="button" className="text-button" disabled={controlsBusy || assetLoading} onClick={() => void assetCheck.refetch()}>Retry balance</button></div> : null}
              <Button type="submit" className="primary full" disabled={controlsBusy || !sourceReady || assetLoading || !wallet.address || !assetInfo || !amount || !isAddress(recipient) || Boolean(amountError || recipientError || tokenError)} busy={Boolean(busy)}>{busy || 'Review transfer'}{!busy ? <Icon name="arrow" size={18} /> : null}</Button>
              {!busy && reviewHint ? <p className="cta-hint">{reviewHint}</p> : null}
            </form>
          </> : null}

          {prepared && !signed ? <>
            <div className="section-heading"><h2>Review transfer</h2></div>
            <TransferSummary transfer={prepared} />
            {sourceStatus}
            <label className="acknowledgement"><input type="checkbox" checked={acknowledged} disabled={controlsBusy} onChange={event => setAcknowledged(event.target.checked)} /><span>I checked the recipient and understand this authorization does not expire.</span></label>
            {!isPreparedSource ? <p className="notice">Reconnect the sending account to sign.</p> : null}
            <Button className="primary full" disabled={controlsBusy || !sourceReady || sourceNetworkBlocked || !acknowledged || !isPreparedSource} busy={Boolean(busy)} onClick={() => void sign()}>{busy || 'Sign transfer'}{!busy ? <Icon name="arrow" size={18} /> : null}</Button>
            <button className="text-button full" disabled={controlsBusy} onClick={() => { setPrepared(undefined); setAcknowledged(false); setError('') }}>Edit transfer</button>
          </> : null}

          {signed ? <>
            <div className="section-heading"><h2>{confirmed ? 'Transfer complete' : failed ? 'Transfer failed' : submissionUnknown ? 'Check transaction' : txHash ? 'Confirming transfer' : 'Pay network fees'}</h2></div>
            <TransferSummary transfer={signed} />
            {sourceStatus}
            {!txHash && submissionUnknown ? <>
              <p className="notice" role="status">Your transaction may already be pending. Check the paying wallet before sending again.</p>
              <a className="transaction-link" href={`${getNetwork(signed.intent.chainId).explorer}/address/${submissionUnknown}`} target="_blank" rel="noreferrer"><span>Wallet activity <span className="mono">{shortAddress(submissionUnknown)}</span></span><Icon name="external" size={16} /></a>
              <form onSubmit={event => { event.preventDefault(); void recoverSubmission() }}>
                <div className="field"><label htmlFor="recovery-hash">Transaction hash</label><input id="recovery-hash" className="mono" value={recoveryHash} onChange={event => setRecoveryHash(event.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" disabled={controlsBusy} required pattern="0x[0-9a-fA-F]{64}" /></div>
                <Button type="submit" className="primary full" disabled={controlsBusy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)} busy={Boolean(busy)}>{busy || 'Check transaction'}</Button>
              </form>
              <p className="signed-note">Closing this page does not revoke the signed authorization.</p>
            </> : !txHash ? <>
              {sponsorStatus}
              {activeQuote ? <div className="fee-review"><div><span>Fee budget</span><strong>{formatUnits(activeQuote.maxCost, nativeCurrency.decimals)} {nativeCurrency.symbol}</strong></div></div> : null}
              {activeQuote ? <Button className="primary full" disabled={controlsBusy || !sourceReady || !sponsorReady || sponsorNetworkBlocked} busy={Boolean(busy)} onClick={() => void send()}>{busy || 'Pay fees and send'}{!busy ? <Icon name="arrow" size={18} /> : null}</Button> : <Button className="primary full" disabled={controlsBusy || !sourceReady || !sponsorReady || !sponsorWallet.address || isSource} busy={Boolean(busy)} onClick={() => void estimate()}>{busy || 'Estimate fees'}{!busy ? <Icon name="arrow" size={18} /> : null}</Button>}
              {activeQuote ? <button className="text-button full" disabled={controlsBusy || !sourceReady || !sponsorReady} onClick={() => void estimate()}>Refresh estimate</button> : null}
              <div className="share-section"><button className="text-button" disabled={controlsBusy} onClick={() => void copyShare()}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Link copied' : 'Copy payment link'}</button></div>
              {shareUrl ? <div className="share-link"><label htmlFor="share-link">Payment link</label><input id="share-link" readOnly value={shareUrl} onFocus={event => event.target.select()} /><p>Anyone with this link can submit this exact transfer.</p></div> : null}
              <p className="signed-note">Closing this page does not revoke the signed authorization.</p>
            </> : <>
              <a className="transaction-link" href={`${getNetwork(signed.intent.chainId).explorer}/tx/${txHash}`} target="_blank" rel="noreferrer"><span>View transaction <span className="mono">{shortAddress(txHash)}</span></span><Icon name="external" size={16} /></a>
              {result && !confirmed ? <p className="notice" role="status">{result.message}</p> : null}
              {!confirmed ? <><Button className="primary full" busy={Boolean(busy)} disabled={controlsBusy} onClick={() => void run('Verifying delivery…', async () => setResult(await waitForTransfer(signed, txHash)))}>{busy || 'Check delivery again'}</Button>{failed ? <button className="text-button full" disabled={controlsBusy} onClick={() => setRestartModal(true)}>Start a new transfer</button> : null}</> : <button className="primary full" onClick={reset}>Make another transfer<Icon name="arrow" size={18} /></button>}
            </>}
          </> : null}
          {actionError ? <p className="notice error" role="alert">{actionError}</p> : null}
          <span className="sr-only" role="status" aria-live="polite">{busy}</span>
        </div>
      </section>
    </main>
    <footer className="site-footer"><a href={network.explorer} target="_blank" rel="noreferrer">Explore the network<Icon name="external" size={12} /></a></footer>

    <dialog ref={walletDialog} className="wallet-dialog connection-dialog" onCancel={() => setChoosingWallet(null)} aria-labelledby="wallet-selection-title">
      <div className="dialog-heading"><h2 id="wallet-selection-title">{choosingWallet === 'source' ? `${wallet.address ? 'Change' : 'Connect'} Fomo wallet` : `${sponsorWallet.address ? 'Change' : 'Connect'} sponsor wallet`}</h2><button className="close-dialog" aria-label="Close wallet selection" onClick={() => setChoosingWallet(null)}>×</button></div>
      <div className="wallet-options">
        {wallet.availableWallets.filter(item => item.id !== 'walletConnect').map(item => <button key={item.id} className="source-wallet" onClick={() => connectWallet(item.id)}><span className="source-icon"><Icon name="wallet" /></span><span><strong>{item.name}</strong></span><Icon name="arrow" size={18} /></button>)}
        <button className="source-wallet" aria-label="WalletConnect" onClick={() => connectWallet('walletConnect')}><span className="source-icon"><Icon name="wallet" /></span><span><strong>WalletConnect</strong><small>Mobile wallets and QR code</small></span><Icon name="arrow" size={18} /></button>
      </div>
    </dialog>

    {accountChoice ? <AccountPicker {...accountChoice} /> : null}

    <dialog ref={restartDialog} className="wallet-dialog" onCancel={() => setRestartModal(false)} aria-labelledby="restart-title"><div className="dialog-heading"><h2 id="restart-title">Leave this transfer?</h2></div><p className="dialog-description">Starting over does not revoke your signature. Save the payment link to return to this transfer.</p><button className="primary full" onClick={() => setRestartModal(false)}>Keep this transfer</button><button className="text-button full" onClick={reset}>Start over anyway</button></dialog>
  </div>
}
