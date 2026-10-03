import { getAddress, isAddress, toHex, type Address, type EIP1193Provider } from 'viem'
import { getNetwork } from './chain'

export class WalletSelectionCancelled extends Error {
  constructor() { super('Wallet selection cancelled.') }
}
export type WalletRole = 'source' | 'sponsor'
export type WalletState = {
  address: Address | null
  chainId: number | null
  walletName: string | null
  connectionId: string | null
  error: string | null
  syncing: boolean
}
export type SessionState = { address: Address; chainId: number }
export type RoleTransport = {
  id: string
  name: string
  resource?: object
  read(): Promise<SessionState>
  switchChain(chainId: number, authorize?: () => Promise<void>): Promise<void>
  request(request: { method: string; params?: unknown }, authorize?: () => Promise<void>): Promise<unknown>
  disconnect(): Promise<void>
  subscribe(listener: (state: SessionState | null) => void): () => void
}
const empty = (): WalletState => ({ address: null, chainId: null, walletName: null, connectionId: null, error: null, syncing: false })
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const cleanWalletName = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 64)
export function walletError(error: unknown): string {
  let cause = error
  for (let i = 0; i < 6 && cause && typeof cause === 'object'; i++) {
    const value = cause as { code?: number; cause?: unknown; originalError?: unknown }
    if (value.code === 4001) return 'Request rejected in the wallet.'
    if (value.code === -32002) return 'A request is already open. Check your wallet.'
    cause = value.cause ?? value.originalError
  }
  return error instanceof Error ? error.message.slice(0, 240) : 'The wallet did not respond. Please try again.'
}

/** Each returned provider is bound to one role generation, never the globally active wallet. */
export class WalletSessions {
  private states: Record<WalletRole, WalletState> = { source: empty(), sponsor: empty() }
  private bindings: Partial<Record<WalletRole, { transport: RoleTransport; stop: () => void }>> = {}
  private epochs: Record<WalletRole, number> = { source: 0, sponsor: 0 }
  private listeners = new Set<() => void>()
  private switching: Promise<unknown> = Promise.resolve()
  private revision = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = (role: WalletRole) => this.states[role]
  private update(role: WalletRole, patch: Partial<WalletState>) {
    this.states[role] = { ...this.states[role], ...patch }
    this.listeners.forEach(listener => listener())
  }
  setError(role: WalletRole, error: unknown) { this.update(role, { error: walletError(error) }) }
  private other(role: WalletRole) { return role === 'source' ? 'sponsor' : 'source' }
  isResourceBound(resource: object) { return Object.values(this.bindings).some(binding => binding.transport.resource === resource) }
  private async disconnectUnused(transport: RoleTransport) {
    const bound = Object.values(this.bindings).some(binding => binding.transport.id === transport.id || (transport.resource && binding.transport.resource === transport.resource))
    if (!bound) await transport.disconnect()
  }
  private assertDistinct(role: WalletRole, address: Address) {
    const other = this.states[this.other(role)]
    if (other.address && same(other.address, address)) {
      throw new Error('Choose a different account for each role.')
    }
  }
  async connect(role: WalletRole, create: () => Promise<RoleTransport>) {
    const epoch = ++this.epochs[role]
    this.update(role, { error: null })
    let candidate: RoleTransport | undefined
    try {
      candidate = await create()
      const state = await candidate.read()
      if (epoch !== this.epochs[role]) throw new WalletSelectionCancelled()
      this.assertDistinct(role, state.address)
      const previous = this.bindings[role]
      const transport = candidate
      const stop = transport.subscribe(next => {
        if (this.bindings[role]?.transport !== transport) return
        if (!next) {
          this.bindings[role]?.stop()
          delete this.bindings[role]
          this.update(role, { ...empty(), error: 'Wallet disconnected. Connect it again.' })
          return
        }
        const current = this.states[role]
        let error: string | null = null
        try { this.assertDistinct(role, next.address) } catch (cause) { error = walletError(cause) }
        this.update(role, { ...next, error,
          connectionId: current.address && same(current.address, next.address) ? current.connectionId : `${transport.id}:${++this.revision}`,
        })
      })
      previous?.stop()
      this.bindings[role] = { transport, stop }
      this.update(role, { ...state, walletName: cleanWalletName(transport.name), connectionId: `${transport.id}:${++this.revision}`, error: null, syncing: false })
      candidate = undefined
      if (previous) {
        // Shared injected providers stay authorized until their final role is released.
        void this.disconnectUnused(previous.transport).catch(() => {})
      }
    } catch (error) {
      if (candidate) await this.disconnectUnused(candidate).catch(() => {})
      if (epoch === this.epochs[role] && !(error instanceof WalletSelectionCancelled)) this.setError(role, error)
      throw error
    }
  }
  async disconnect(role: WalletRole) {
    ++this.epochs[role]
    const binding = this.bindings[role]
    binding?.stop()
    delete this.bindings[role]
    this.update(role, empty())
    try { if (binding) await this.disconnectUnused(binding.transport) }
    catch (cause) { this.setError(role, cause) }
  }
  async ensureChain(role: WalletRole, chainId: number): Promise<EIP1193Provider> {
    getNetwork(chainId)
    const binding = this.bindings[role]
    const expected = this.states[role]
    if (!binding || !expected.address) throw new Error('Connect this wallet first.')
    const identity = () => {
      if (this.bindings[role] !== binding || this.states[role].connectionId !== expected.connectionId) {
        throw new Error('The account changed. Try again with the selected account.')
      }
      this.assertDistinct(role, expected.address!)
    }
    const check = async (requireChain = true) => {
      identity()
      const actual = await binding.transport.read()
      identity()
      if (!same(actual.address, expected.address!)) throw new Error('The account changed. Reconnect this wallet.')
      if (requireChain && actual.chainId !== chainId) throw new Error(`Select ${getNetwork(chainId).name} in this wallet.`)
      return actual
    }
    this.update(role, { syncing: true, error: null })
    const task = this.switching.catch(() => {}).then(async () => {
      const actual = await check(false)
      if (actual.chainId !== chainId) await binding.transport.switchChain(chainId, async () => { await check(false) })
      await check()
      this.update(role, { chainId })
    })
    this.switching = task
    try { await task }
    catch (cause) { if (this.bindings[role] === binding) this.setError(role, cause); throw cause }
    finally { if (this.bindings[role] === binding) this.update(role, { syncing: false }) }
    return {
      request: async (request: { method: string; params?: unknown }) => {
        await check()
        if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [expected.address]
        if (request.method === 'eth_chainId') return toHex(chainId)
        const params = request.params as unknown[] | undefined
        if (request.method === 'eth_sendTransaction') {
          if (role !== 'sponsor') throw new Error('Only the paying wallet can send this transaction.')
          const tx = params?.[0] as { from?: string; chainId?: string } | undefined
          if (!tx?.from || !same(tx.from, expected.address!) || Number(tx.chainId) !== chainId) throw new Error('Transaction wallet or network mismatch.')
        } else if (request.method === 'eth_signTypedData_v4') {
          if (role !== 'source') throw new Error('Only the sending wallet can sign this authorization.')
          if (typeof params?.[0] !== 'string' || !same(params[0], expected.address!)) throw new Error('Signing account mismatch.')
          const data = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
          if (Number(data?.domain?.chainId) !== chainId) throw new Error('Signing network mismatch.')
        } else throw new Error('Unsupported wallet request.')
        identity()
        // Do not discard a broadcast result if an account event arrives during approval.
        return binding.transport.request(request, async () => { await check() })
      },
    } as EIP1193Provider
  }
}

export function parseWalletAddress(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('The wallet returned an invalid account.')
  return getAddress(value)
}
