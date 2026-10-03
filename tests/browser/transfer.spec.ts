import { test, expect, type Page } from '@playwright/test'
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionResult, erc20Abi, http, parseAbi, parseEther, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { DEFAULT_CHAIN_ID, ENTRY_POINT, IMPLEMENTATION, NETWORKS, getNetwork } from '../../src/lib/chain'

const rpc = 'http://127.0.0.1:18545'
const network = getNetwork(DEFAULT_CHAIN_ID)
const { chain, wrappedNative: WETH } = network
// Disposable fixture keys stay in memory and are only used on the local fork.
const source = privateKeyToAccount(generatePrivateKey())
const sponsor = privateKeyToAccount(generatePrivateKey())
const recipient = privateKeyToAccount(generatePrivateKey()).address
const client = createPublicClient({ chain, transport: http(rpc) })
const node = createTestClient({ mode: 'anvil', chain, transport: http(rpc) })
let sends = 0
let loseSendResponse = false
let lastBroadcastHash: Hex | undefined
let walletChainId = DEFAULT_CHAIN_ID
let payingChainId = DEFAULT_CHAIN_ID
let providerRequests: { provider: 'source' | 'paying'; role: 'source' | 'sponsor'; method: string }[] = []
let networkSwitches: number[] = []
let pendingSwitch: { started: ReturnType<typeof barrier>; respond: ReturnType<typeof barrier> } | undefined
let signingChains: number[] = []
let sendingChains: number[] = []
let singleProvider = false
let sourceAccounts: string[] | undefined
let grantAdditionalAccounts = false
let rejectAccountPermission = false

test.beforeAll(async () => {
  if (process.env.PASSAGE_FORK_RPC !== rpc) throw new Error('Run these tests with pm run test:e2e (local fork only).')
  await node.setBalance({ address: source.address, value: parseEther('1') })
  await node.setBalance({ address: sponsor.address, value: parseEther('1') })
  const wallet = createWalletClient({ account: source, chain, transport: http(rpc) })
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: WETH, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: parseEther('0.01') }) })
  await node.setCode({ address: source.address, bytecode: `0xef0100${IMPLEMENTATION.slice(2)}` })
  await node.setBalance({ address: source.address, value: 0n })
})

test.beforeEach(async ({ page }) => {
  sends = 0
  loseSendResponse = false
  lastBroadcastHash = undefined
  walletChainId = DEFAULT_CHAIN_ID
  payingChainId = DEFAULT_CHAIN_ID
  providerRequests = []
  networkSwitches = []
  pendingSwitch = undefined
  signingChains = []
  sendingChains = []
  singleProvider = false
  sourceAccounts = undefined
  grantAdditionalAccounts = false
  rejectAccountPermission = false
  await page.route('https://**/*', async route => {
    const request = route.request()
    const selected = NETWORKS.find(item => item.rpcUrls.some(url => request.url().startsWith(url)))
    if (selected?.id === DEFAULT_CHAIN_ID) {
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.postData() })
      await route.fulfill({ status: 200, contentType: 'application/json', body: await response.text() })
    } else if (selected) {
      const payload = request.postDataJSON() as { id: number; method: string } | { id: number; method: string }[]
      const respond = (call: { id: number; method: string }) => {
        const result = call.method === 'eth_chainId' ? toHex(selected.id)
          : ['eth_getBalance', 'eth_gasPrice', 'eth_blockNumber', 'eth_getTransactionCount'].includes(call.method) ? '0x0'
          : call.method === 'eth_getCode' ? '0x' : undefined
        return { jsonrpc: '2.0', id: call.id, ...(result === undefined ? { error: { code: -32601, message: `Unmocked read or blocked wallet action: ${call.method}` } } : { result }) }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(payload) ? payload.map(respond) : respond(payload)) })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], count: 0, isAnalyticsEnabled: false, features: [], planLimits: { tier: 'starter', isAboveMauLimit: false, isAboveRpcLimit: false } }) })
    }
  })
  await page.exposeBinding('passageTestConfiguration', () => ({ singleProvider }))
  await page.exposeBinding('passageTestRequest', async (_, method: string, params: unknown, role: 'source' | 'sponsor', provider: 'source' | 'paying' = 'source') => {
    const requestedAddress = method === 'eth_signTypedData_v4' ? (params as string[])[0]
      : method === 'eth_sendTransaction' ? (params as Record<string, string>[])[0].from : undefined
    const requestedAccount = requestedAddress ? [source, sponsor].find(account => account.address.toLowerCase() === requestedAddress.toLowerCase()) : undefined
    if (requestedAddress) {
      expect(requestedAccount, 'Only disposable fixture accounts may sign or send').toBeDefined()
      const authorized = provider === 'source' && sourceAccounts ? sourceAccounts : [role === 'source' ? source.address : sponsor.address]
      expect(authorized.map(address => address.toLowerCase())).toContain(requestedAddress.toLowerCase())
    }
    providerRequests.push({ provider, role: requestedAccount ? requestedAccount === source ? 'source' : 'sponsor' : role, method })
    const currentChainId = provider === 'paying' ? payingChainId : walletChainId
    const account = role === 'source' ? source : sponsor
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return provider === 'source' && sourceAccounts ? sourceAccounts : [account.address]
    if (method === 'passage_setAccounts') { sourceAccounts = params as string[]; return null }
    if (method === 'eth_chainId') return toHex(currentChainId)
    if (method === 'passage_setChain') {
      if (provider === 'paying') payingChainId = (params as number[])[0]
      else walletChainId = (params as number[])[0]
      return null
    }
    if (method === 'wallet_requestPermissions') {
      if (rejectAccountPermission) return { testError: { code: 4001, message: 'User rejected account permission' } }
      if (grantAdditionalAccounts && provider === 'source') sourceAccounts = [source.address, sponsor.address]
      return [{ parentCapability: 'eth_accounts' }]
    }
    if (method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }]
    if (method === 'wallet_getCapabilities') return {}
    if (method === 'wallet_revokePermissions') return null
    if (method === 'wallet_switchEthereumChain') {
      const nextChainId = Number((params as { chainId: string }[])[0].chainId)
      const held = pendingSwitch
      if (held) { pendingSwitch = undefined; held.started.release(); await held.respond.promise }
      if (provider === 'paying') payingChainId = nextChainId
      else walletChainId = nextChainId
      networkSwitches.push(nextChainId)
      return null
    }
    if (method === 'eth_signTypedData_v4') {
      const data = JSON.parse((params as string[])[1])
      expect(currentChainId).toBe(DEFAULT_CHAIN_ID)
      expect(Number(data.domain.chainId)).toBe(DEFAULT_CHAIN_ID)
      signingChains.push(currentChainId)
      return requestedAccount!.signTypedData(data)
    }
    if (method === 'eth_sendTransaction') {
      const tx = (params as Record<string, string>[])[0]
      expect(currentChainId).toBe(DEFAULT_CHAIN_ID)
      expect(Number(tx.chainId)).toBe(DEFAULT_CHAIN_ID)
      sendingChains.push(currentChainId)
      expect(tx.from.toLowerCase()).toBe(sponsor.address.toLowerCase())
      expect(tx.to.toLowerCase()).toBe(ENTRY_POINT.toLowerCase())
      sends++
      lastBroadcastHash = await createWalletClient({ account: requestedAccount!, chain, transport: http(rpc) }).sendTransaction({ to: ENTRY_POINT, data: tx.data as Hex, value: BigInt(tx.value), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) })
      if (loseSendResponse) throw new Error('Connection lost after broadcast')
      return lastBroadcastHash
    }
    if (method.startsWith('eth_') && !method.startsWith('eth_send') && !method.startsWith('eth_sign')) {
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json())
      if (response.error) throw new Error(response.error.message)
      return response.result
    }
    throw new Error(`Unsupported test wallet request: ${method}`)
  })
  await page.addInitScript(({ sponsorAddress }) => {
    const win = window as typeof window & {
      passageTestRequest: (method: string, params: unknown, role: string, provider?: string) => Promise<unknown>
      passageTestConfiguration: () => Promise<{ singleProvider: boolean }>
      passageSetAccounts: (accounts: string[]) => Promise<void>
      passageMutateSourceAccount: () => void
      passageSetChain: (chainId: number, provider?: 'source' | 'paying') => Promise<void>
      ethereum: unknown
    }
    let role = 'source'
    function createProvider(id: 'source' | 'paying', getRole: () => string) {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
      const provider = {
        isMetaMask: id === 'source',
        isConnected: () => true,
        request: async ({ method, params }: { method: string; params: unknown }) => {
          const response = await win.passageTestRequest(method, params, getRole(), id)
          if (response && typeof response === 'object' && 'testError' in response) {
            const failure = response.testError as { code: number; message: string }
            throw Object.assign(new Error(failure.message), { code: failure.code })
          }
          if (method === 'wallet_switchEthereumChain') {
            for (const fn of listeners.get('chainChanged') ?? []) fn((params as { chainId: string }[])[0].chainId)
          }
          return response
        },
        on: (event: string, fn: (...args: unknown[]) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn) },
        removeListener: (event: string, fn: (...args: unknown[]) => void) => listeners.get(event)?.delete(fn),
      }
      return { provider, listeners }
    }
    const sourceWallet = createProvider('source', () => role)
    const payingWallet = createProvider('paying', () => 'sponsor')
    win.ethereum = sourceWallet.provider
    // Silent drift exercises action-time chain checks independently of event handling.
    win.passageSetChain = async (chainId, provider = 'source') => {
      await win.passageTestRequest('passage_setChain', [chainId], provider === 'paying' ? 'sponsor' : role, provider)
    }
    win.passageSetAccounts = async accounts => {
      await win.passageTestRequest('passage_setAccounts', accounts, role, 'source')
      for (const fn of sourceWallet.listeners.get('accountsChanged') ?? []) fn(accounts)
    }
    win.passageMutateSourceAccount = () => { role = 'sponsor'; for (const fn of sourceWallet.listeners.get('accountsChanged') ?? []) fn([sponsorAddress]) }
    const announce = async () => {
      const configuration = await win.passageTestConfiguration()
      const details = [
        { info: { uuid: 'cce3612e-ab43-47ed-9b16-1e1b8034f036', name: 'Passage Test Wallet', rdns: 'test.passage.wallet' }, provider: sourceWallet.provider },
        { info: { uuid: '802ed602-f05e-4f07-b947-b169be464bf7', name: 'Passage Paying Wallet', rdns: 'test.passage.paying' }, provider: payingWallet.provider },
      ]
      for (const detail of configuration.singleProvider ? details.slice(0, 1) : details) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { ...detail, info: { ...detail.info, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' } } }))
      }
    }
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { sponsorAddress: sponsor.address })
})

type RpcCall = { id: number; method: string; params: unknown[] }
type RpcOverride = { result: unknown } | { error: { code: number; message: string } }

async function overridePublicRpc(page: Page, override: (call: RpcCall, chainId: number) => RpcOverride | undefined | Promise<RpcOverride | undefined>) {
  await page.route('https://**/*', async route => {
    const selected = NETWORKS.find(item => item.rpcUrls.some(url => route.request().url().startsWith(url)))
    if (!selected) { await route.fallback(); return }
    const call = route.request().postDataJSON() as RpcCall
    const response = await override(call, selected.id)
    if (!response) { await route.fallback(); return }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...response }) })
  })
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function connectSource(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Disconnect Fomo wallet', exact: true })).toBeVisible()
}

async function connectSponsor(page: Page) {
  await page.getByRole('button', { name: 'Connect sponsor wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Paying Wallet', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true })).toBeVisible()
}

async function fillValidTransfer(page: Page) {
  await page.getByLabel('Amount', { exact: true }).fill('0.001')
  await page.getByLabel('Recipient address', { exact: true }).fill(recipient)
}

async function signWithSource(page: Page) {
  await connectSource(page)
  return signCurrentTransfer(page)
}

async function signCurrentTransfer(page: Page) {
  await fillValidTransfer(page)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pay network fees', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Copy payment link', exact: true }).click()
  return page.getByLabel('Payment link', { exact: true }).inputValue()
}

function expectNoWalletAction() {
  expect(networkSwitches).toEqual([])
  expect(signingChains).toEqual([])
  expect(sends).toBe(0)
}

for (const lostResponse of [false, true]) test(`Independent connections → sign → sponsor → ${lostResponse ? 'recover lost response' : 'confirm'} on fork`, async ({ page }) => {
  loseSendResponse = lostResponse
  const before = await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByText(/Available: 0\.0\d+ WETH/)).toBeVisible()
  await expect(page.getByLabel('Asset', { exact: true })).toHaveValue('wrapped')
  await page.getByLabel('Amount', { exact: true }).fill('0.002')
  await page.getByLabel('Recipient address', { exact: true }).fill(recipient)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Sign transfer', exact: true })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pay network fees', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Copy payment link', exact: true }).click()
  const link = await page.getByLabel('Payment link').inputValue()
  expect(link).toContain('#transfer=')
  await connectSponsor(page)
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Pay fees and send', exact: true }).click()
  if (lostResponse) {
    await expect(page.getByRole('heading', { name: 'Check transaction' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pay fees and send', exact: true })).toHaveCount(0)
    expect(lastBroadcastHash).toBeDefined()
    await page.getByLabel('Transaction hash', { exact: true }).fill(lastBroadcastHash!)
    await page.getByRole('button', { name: 'Check transaction', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Transfer complete' })).toBeVisible({ timeout: 40_000 })
  expect(sends).toBe(1)
  expect(await client.getBalance({ address: source.address })).toBe(0n)
  expect(await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })).toBe(before + parseEther('0.002'))
  await page.screenshot({ path: 'test-results/confirmed-desktop.png', fullPage: true })
})

test('native transfer to the paying account switches network before signing and sending', async ({ page }) => {
  walletChainId = 1
  await node.setBalance({ address: source.address, value: parseEther('0.02') })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await page.getByLabel('Asset', { exact: true }).selectOption('native')
  await expect(page.getByText('Available: 0.02 ETH', { exact: true })).toBeVisible()
  await page.getByLabel('Amount', { exact: true }).fill('0.002')
  await page.getByLabel('Recipient address', { exact: true }).fill(sponsor.address)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Network', { exact: true })).toBeDisabled()
  await page.evaluate(() => (window as unknown as { passageSetChain: (chainId: number) => Promise<void> }).passageSetChain(1))
  expect(walletChainId).toBe(1)
  const switchesBeforeSign = networkSwitches.length
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pay network fees', exact: true })).toBeVisible({ timeout: 30_000 })
  expect(networkSwitches.slice(switchesBeforeSign)).toEqual([DEFAULT_CHAIN_ID])
  expect(signingChains).toEqual([DEFAULT_CHAIN_ID])
  await connectSponsor(page)
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => (window as unknown as { passageSetChain: (chainId: number, provider: string) => Promise<void> }).passageSetChain(8453, 'paying'))
  expect(payingChainId).toBe(8453)
  const switchesBeforeSend = networkSwitches.length
  const sponsorBefore = await client.getBalance({ address: sponsor.address })
  await page.getByRole('button', { name: 'Pay fees and send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer complete' })).toBeVisible({ timeout: 40_000 })
  expect(networkSwitches.slice(switchesBeforeSend)).toEqual([DEFAULT_CHAIN_ID])
  expect(sendingChains).toEqual([DEFAULT_CHAIN_ID])
  expect(sends).toBe(1)
  expect(lastBroadcastHash).toBeDefined()
  const receipt = await client.getTransactionReceipt({ hash: lastBroadcastHash! })
  expect(await client.getBalance({ address: source.address })).toBe(parseEther('0.018'))
  expect(await client.getBalance({ address: sponsor.address })).toBe(sponsorBefore + parseEther('0.002') - receipt.gasUsed * receipt.effectiveGasPrice)
})

test('network and asset choices refresh balances and synchronize the connected Fomo wallet', async ({ page }) => {
  walletChainId = 1
  const nativeBalances = new Map(NETWORKS.map((item, index) => [item.id, parseEther(item.chain.nativeCurrency.symbol === 'MON' ? '20' : String(index + 2))]))
  const publicReads: { chainId: number; method: string }[] = []
  await page.route('https://**/*', async route => {
    const selected = NETWORKS.find(item => item.rpcUrls.some(url => route.request().url().startsWith(url)))
    if (!selected) { await route.fallback(); return }
    const payload = route.request().postDataJSON() as { id: number; method: string; params: unknown[] }
    publicReads.push({ chainId: selected.id, method: payload.method })
    let result: Hex | undefined
    if (payload.method === 'eth_chainId') result = toHex(selected.id)
    if (payload.method === 'eth_blockNumber') result = '0x1'
    if (payload.method === 'eth_getBalance') result = toHex(nativeBalances.get(selected.id)!)
    if (payload.method === 'eth_getCode') result = '0x6000'
    if (payload.method === 'eth_call') {
      const call = payload.params[0] as { to: string; data: string }
      const symbol = call.to.toLowerCase() === selected.wrappedNative.toLowerCase() ? `W${selected.chain.nativeCurrency.symbol}` : 'CUSTOM'
      if (call.data.startsWith('0x95d89b41')) result = encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: symbol })
      if (call.data.startsWith('0x06fdde03')) result = encodeFunctionResult({ abi: erc20Abi, functionName: 'name', result: `Test ${symbol}` })
      if (call.data.startsWith('0x313ce567')) result = encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 18 })
      if (call.data.startsWith('0x70a08231')) result = encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: parseEther('1.5') })
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, ...(result === undefined ? { error: { code: -32601, message: `Unmocked method: ${payload.method}` } } : { result }) }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByText('Available: 1.5 WETH', { exact: true })).toBeVisible()
  await expect.poll(() => walletChainId).toBe(DEFAULT_CHAIN_ID)
  const switchesBeforeSelection = networkSwitches.length
  const networkSelect = page.getByLabel('Network', { exact: true })
  const assetSelect = page.getByLabel('Asset', { exact: true })
  await expect(networkSelect.locator('option')).toHaveCount(5)
  await page.getByLabel('Amount', { exact: true }).fill('0.25')
  await networkSelect.selectOption(String(DEFAULT_CHAIN_ID))
  await assetSelect.selectOption('wrapped')
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('0.25')
  await expect(page.getByText('Available: 1.5 WETH', { exact: true })).toBeVisible()
  for (const [index, selected] of NETWORKS.entries()) {
    await networkSelect.selectOption(String(selected.id))
    await expect.poll(() => walletChainId).toBe(selected.id)
    await expect(assetSelect).toHaveValue('wrapped')
    await expect(page.getByText(`Available: 1.5 W${selected.chain.nativeCurrency.symbol}`, { exact: true })).toBeVisible()
    await assetSelect.selectOption('native')
    const nativeAmount = selected.chain.nativeCurrency.symbol === 'MON' ? '10' : String(index + 2)
    await expect(page.getByText(`Available: ${nativeAmount} ${selected.chain.nativeCurrency.symbol}`, { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('A contract wallet cannot be the sending account.')
    await expect(page.locator('.reserve-note')).toHaveCount(0)
    await assetSelect.selectOption('custom')
    await page.getByLabel('Contract address', { exact: true }).fill('0x1111111111111111111111111111111111111111')
    await expect(page.getByText('Available: 1.5 CUSTOM', { exact: true })).toBeVisible()
    await page.getByLabel('Amount', { exact: true }).fill('0.5')
  }
  await networkSelect.selectOption(String(DEFAULT_CHAIN_ID))
  await expect(assetSelect).toHaveValue('wrapped')
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Contract address', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Available: 1.5 WETH', { exact: true })).toBeVisible()
  for (const selected of NETWORKS) {
    expect(publicReads.some(read => read.chainId === selected.id && read.method === 'eth_getBalance')).toBe(true)
    expect(publicReads.some(read => read.chainId === selected.id && read.method === 'eth_call')).toBe(true)
  }
  await expect.poll(() => walletChainId).toBe(DEFAULT_CHAIN_ID)
  expect(networkSwitches.slice(switchesBeforeSelection)).toEqual([...NETWORKS.slice(1).map(item => item.id), DEFAULT_CHAIN_ID])
  expect(signingChains).toEqual([])
  expect(sends).toBe(0)
})

for (const incompatible of [
  { name: 'undelegated account', address: source.address, code: '0x', message: 'This account has no delegation' },
  { name: 'another delegation', address: source.address, code: `0xef0100${recipient.slice(2)}`, message: 'This account uses an unsupported delegation' },
  { name: 'changed implementation code', address: IMPLEMENTATION, code: '0x6000', message: 'The network contracts do not match the verified versions.' },
] as const) test(`early source check rejects ${incompatible.name} without wallet actions`, async ({ page }) => {
  const checkedBlocks: string[] = []
  await overridePublicRpc(page, call => {
    if (call.method !== 'eth_getCode') return
    const address = String(call.params[0]).toLowerCase()
    if ([source.address, IMPLEMENTATION, ENTRY_POINT].some(value => value.toLowerCase() === address)) checkedBlocks.push(String(call.params[1]))
    if (address === incompatible.address.toLowerCase()) return { result: incompatible.code }
  })
  await connectSource(page)
  await fillValidTransfer(page)
  await expect(page.getByRole('alert')).toContainText(incompatible.message)
  await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled()
  expect(checkedBlocks).toHaveLength(3)
  expect(new Set(checkedBlocks).size).toBe(1)
  expect(checkedBlocks[0]).toMatch(/^0x[0-9a-f]+$/i)
  expectNoWalletAction()
})

test('source loading blocks review and an RPC failure can be retried', async ({ page }) => {
  const started = barrier()
  const respond = barrier()
  let first = true
  let failing = true
  await overridePublicRpc(page, async call => {
    if (call.method !== 'eth_getCode' || String(call.params[0]).toLowerCase() !== source.address.toLowerCase()) return
    if (first) { first = false; started.release(); await respond.promise }
    if (failing) return { error: { code: -32000, message: 'Test RPC unavailable' } }
  })
  try {
    await connectSource(page)
    await started.promise
    await fillValidTransfer(page)
    await expect(page.getByText('Checking sending account…', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled()
    respond.release()
    await expect(page.getByRole('alert')).toContainText('Could not verify this account', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled()
    failing = false
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeEnabled({ timeout: 20_000 })
    expectNoWalletAction()
  } finally { respond.release() }
})

for (const change of ['account', 'network'] as const) test(`a delayed old source check cannot unlock a different ${change}`, async ({ page }) => {
  const started = barrier()
  const respond = barrier()
  await overridePublicRpc(page, async (call, chainId) => {
    if (chainId === DEFAULT_CHAIN_ID && call.method === 'eth_getCode' && String(call.params[0]).toLowerCase() === source.address.toLowerCase()) {
      started.release()
      await respond.promise
      return { result: `0xef0100${IMPLEMENTATION.slice(2)}` }
    }
    if (change === 'network' && chainId === 8453 && call.method === 'eth_getBalance') return { result: toHex(parseEther('1.5')) }
  })
  try {
    await connectSource(page)
    await started.promise
    await fillValidTransfer(page)
    await expect(page.getByText('Checking sending account…', { exact: true })).toBeVisible()
    if (change === 'account') {
      await page.evaluate(() => (window as unknown as { passageMutateSourceAccount: () => void }).passageMutateSourceAccount())
      await expect(page.getByRole('button', { name: 'Connect Fomo wallet', exact: true })).toBeVisible()
    } else {
      await page.getByLabel('Network', { exact: true }).selectOption('8453')
      await page.getByLabel('Asset', { exact: true }).selectOption('native')
      await expect(page.getByText('Available: 1.5 ETH', { exact: true })).toBeVisible()
      await fillValidTransfer(page)
    }
    if (change === 'network') await expect(page.getByRole('alert')).toContainText('This account has no delegation')
    const response = page.waitForResponse(reply => {
      if (!network.rpcUrls.some(url => reply.url().startsWith(url))) return false
      const call = reply.request().postDataJSON() as RpcCall
      return call.method === 'eth_getCode' && String(call.params[0]).toLowerCase() === source.address.toLowerCase()
    })
    respond.release()
    await (await response).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    if (change === 'network') await expect(page.getByRole('alert')).toContainText('This account has no delegation')
    else await expect(page.getByRole('button', { name: 'Connect Fomo wallet', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled()
    expect(networkSwitches).toEqual(change === 'network' ? [8453] : [])
    expect(signingChains).toEqual([])
    expect(sends).toBe(0)
  } finally { respond.release() }
})

test('invalid amount and recipients are blocked before review', async ({ page }) => {
  await connectSource(page)
  await fillValidTransfer(page)
  const review = page.getByRole('button', { name: 'Review transfer', exact: true })
  await expect(review).toBeEnabled()
  await page.getByLabel('Amount', { exact: true }).fill('999')
  await expect(page.getByRole('alert')).toContainText('The amount exceeds the available balance.')
  await expect(review).toBeDisabled()
  await page.getByLabel('Amount', { exact: true }).fill('0.001')
  for (const address of [source.address, '0x0000000000000000000000000000000000000000', WETH, ENTRY_POINT]) {
    await page.getByLabel('Recipient address', { exact: true }).fill(address)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(review).toBeDisabled()
  }
  await page.getByLabel('Recipient address', { exact: true }).fill(recipient)
  await expect(review).toBeEnabled()
  expectNoWalletAction()
})

test('changed source implementation after review is rejected before the wallet signs', async ({ page }) => {
  let changed = false
  await overridePublicRpc(page, call => {
    if (changed && call.method === 'eth_getCode' && String(call.params[0]).toLowerCase() === IMPLEMENTATION.toLowerCase()) return { result: '0x6000' }
  })
  await connectSource(page)
  await fillValidTransfer(page)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('checkbox').check()
  await page.evaluate(() => (window as unknown as { passageSetChain: (chainId: number) => Promise<void> }).passageSetChain(1))
  expect(walletChainId).toBe(1)
  changed = true
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('The network contracts do not match the verified versions.')
  expectNoWalletAction()
})

for (const unsuitable of ['contract', 'unfunded'] as const) test(`a ${unsuitable} paying wallet cannot estimate or send`, async ({ page }) => {
  await overridePublicRpc(page, call => {
    if (call.method !== 'eth_getCode' && call.method !== 'eth_getBalance') return
    if (String(call.params[0]).toLowerCase() !== sponsor.address.toLowerCase()) return
    if (unsuitable === 'contract' && call.method === 'eth_getCode') return { result: '0x6000' }
    if (unsuitable === 'unfunded' && call.method === 'eth_getBalance') return { result: '0x0' }
  })
  await connectSource(page)
  await fillValidTransfer(page)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pay network fees', exact: true })).toBeVisible({ timeout: 30_000 })
  await connectSponsor(page)
  await expect(page.getByRole('alert')).toContainText(unsuitable === 'contract' ? 'This contract wallet cannot pay fees directly.' : 'This wallet has no ETH balance')
  await expect(page.getByRole('button', { name: 'Estimate fees', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Pay fees and send', exact: true })).toHaveCount(0)
  expect(signingChains).toEqual([DEFAULT_CHAIN_ID])
  expect(networkSwitches).toEqual([])
  expect(sends).toBe(0)
})

test('malformed recipient and token addresses show errors after blur', async ({ page }) => {
  await connectSource(page)
  const review = page.getByRole('button', { name: 'Review transfer', exact: true })
  const recipientInput = page.getByLabel('Recipient address', { exact: true })
  await page.getByLabel('Amount', { exact: true }).fill('0.001')
  await recipientInput.fill('not-an-address')
  await expect(recipientInput).toHaveAttribute('aria-invalid', 'false')
  await recipientInput.blur()
  await expect(page.getByText('Invalid address. Enter a complete 0x address.', { exact: true })).toBeVisible()
  await expect(recipientInput).toHaveAttribute('aria-invalid', 'true')
  await expect(review).toBeDisabled()
  await recipientInput.fill(recipient)
  await page.getByLabel('Asset', { exact: true }).selectOption('custom')
  const tokenInput = page.getByLabel('Contract address', { exact: true })
  await tokenInput.fill('0x123')
  await expect(tokenInput).toHaveAttribute('aria-invalid', 'false')
  await tokenInput.blur()
  await expect(page.getByText('Enter a valid, non-zero token contract address.', { exact: true })).toBeVisible()
  await expect(tokenInput).toHaveAttribute('aria-invalid', 'true')
  await expect(review).toBeDisabled()
  expectNoWalletAction()
})

test('balance failure can be retried and newly available funds refresh on focus', async ({ page }) => {
  let failing = true
  let balance = 0n
  await overridePublicRpc(page, call => {
    if (call.method !== 'eth_call') return
    const request = call.params[0] as { to: string; data: string }
    if (request.to.toLowerCase() !== WETH.toLowerCase() || !request.data.startsWith('0x70a08231') || !request.data.toLowerCase().endsWith(source.address.slice(2).toLowerCase())) return
    if (failing) return { error: { code: -32000, message: 'Test balance RPC unavailable' } }
    return { result: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balance }) }
  })
  await connectSource(page)
  const review = page.getByRole('button', { name: 'Review transfer', exact: true })
  await expect(page.getByRole('button', { name: 'Retry balance', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(review).toBeDisabled()
  failing = false
  await page.getByRole('button', { name: 'Retry balance', exact: true }).click()
  await expect(page.getByText('Available: 0 WETH', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeDisabled()
  await fillValidTransfer(page)
  await expect(page.getByText('The amount exceeds the available balance.', { exact: true })).toBeVisible()
  await expect(review).toBeDisabled()
  balance = parseEther('0.01')
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByText('Available: 0.01 WETH', { exact: true })).toBeVisible()
  await expect(review).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeEnabled()
  expectNoWalletAction()
})

test('a fee budget expires automatically without submitting a transaction', async ({ page }) => {
  await page.clock.install()
  await connectSource(page)
  await fillValidTransfer(page)
  await page.getByRole('button', { name: 'Review transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review transfer' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Sign transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pay network fees', exact: true })).toBeVisible({ timeout: 30_000 })
  await connectSponsor(page)
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.clock.fastForward(60_001)
  await expect(page.getByText('Fee budget', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pay fees and send', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Estimate fees', exact: true })).toBeVisible()
  expect(signingChains).toEqual([DEFAULT_CHAIN_ID])
  expect(sends).toBe(0)
})

test('mobile independent wallet roles use the source signer and sponsor broadcaster', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const before = await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })
  const paymentLink = await signWithSource(page)
  const summary = await page.locator('.transfer-summary').innerText()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await connectSponsor(page)
  await expect(page.getByRole('button', { name: 'Change sponsor wallet', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disconnect Fomo wallet', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Fomo wallet', exact: true }).getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sponsor wallet', exact: true }).getByText('Passage Paying Wallet', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Payment link', { exact: true })).toHaveValue(paymentLink)
  await expect(page.locator('.transfer-summary')).toHaveText(summary, { useInnerText: true })
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Pay fees and send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer complete', exact: true })).toBeVisible({ timeout: 40_000 })
  expect(providerRequests.filter(request => request.method === 'eth_signTypedData_v4')).toEqual([{ provider: 'source', role: 'source', method: 'eth_signTypedData_v4' }])
  expect(providerRequests.filter(request => request.method === 'eth_sendTransaction')).toEqual([{ provider: 'paying', role: 'sponsor', method: 'eth_sendTransaction' }])
  expect(sends).toBe(1)
  expect(await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })).toBe(before + parseEther('0.001'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('wallet and account picker cancellation preserve both roles and the fee budget', async ({ page }) => {
  const paymentLink = await signWithSource(page)
  const summary = await page.locator('.transfer-summary').innerText()
  const fomo = page.getByRole('region', { name: 'Fomo wallet', exact: true })
  const paying = page.getByRole('region', { name: 'Sponsor wallet', exact: true })
  const selectSponsor = page.getByRole('button', { name: 'Connect sponsor wallet', exact: true })
  await selectSponsor.click()
  await expect(page.getByRole('dialog', { name: 'Connect sponsor wallet', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'WalletConnect', exact: true })).toBeVisible()
  await expect(page.getByText('Mobile wallets and QR code', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close wallet selection', exact: true }).click()
  await expect(selectSponsor).toBeVisible()
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Payment link', { exact: true })).toHaveValue(paymentLink)
  await expect(page.locator('.transfer-summary')).toHaveText(summary, { useInnerText: true })
  await expect(page.getByRole('button', { name: 'Estimate fees', exact: true })).toBeDisabled()
  await selectSponsor.click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose sponsor account', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: source.address, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Close account selection', exact: true }).click()
  await expect(selectSponsor).toBeVisible()
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await connectSponsor(page)
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Change sponsor wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Change sponsor wallet', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close wallet selection', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible()
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await expect(paying.getByText('Passage Paying Wallet', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Change sponsor wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose sponsor account', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: source.address, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Close account selection', exact: true }).click()
  await expect(paying.getByText('Passage Paying Wallet', { exact: true })).toBeVisible()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true }).click()
  await expect(selectSponsor).toBeVisible()
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await expect(page.getByText('Fee budget', { exact: true })).toHaveCount(0)
  await connectSponsor(page)
  await expect(page.getByRole('button', { name: 'Estimate fees', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Pay fees and send', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Payment link', { exact: true })).toHaveValue(paymentLink)
  await expect(page.locator('.transfer-summary')).toHaveText(summary, { useInnerText: true })
  expect(providerRequests.filter(request => request.method === 'eth_signTypedData_v4')).toEqual([{ provider: 'source', role: 'source', method: 'eth_signTypedData_v4' }])
  expect(sends).toBe(0)
})

test('both wallet roles synchronize sequentially and disconnect independently', async ({ page }) => {
  await connectSource(page)
  await connectSponsor(page)
  const fomo = page.getByRole('region', { name: 'Fomo wallet', exact: true })
  const paying = page.getByRole('region', { name: 'Sponsor wallet', exact: true })
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await expect(paying.getByText('Passage Paying Wallet', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Change Fomo wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Change Fomo wallet', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close wallet selection', exact: true }).click()
  const started = barrier()
  const respond = barrier()
  const switches = () => providerRequests.filter(request => request.method === 'wallet_switchEthereumChain')
  const beforeSwitch = switches().length
  pendingSwitch = { started, respond }
  try {
    await page.getByLabel('Network', { exact: true }).selectOption('8453')
    await started.promise
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(switches().slice(beforeSwitch)).toHaveLength(1)
    respond.release()
    await expect.poll(() => [walletChainId, payingChainId]).toEqual([8453, 8453])
    expect(switches().slice(beforeSwitch).map(request => request.provider).sort()).toEqual(['paying', 'source'])
  } finally { respond.release() }
  await page.getByRole('button', { name: 'Disconnect Fomo wallet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect Fomo wallet', exact: true })).toBeVisible()
  await expect(paying.getByText('Passage Paying Wallet', { exact: true })).toBeVisible()
  await page.getByLabel('Network', { exact: true }).selectOption('1')
  await expect.poll(() => payingChainId).toBe(1)
  expect(walletChainId).toBe(8453)
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect.poll(() => [walletChainId, payingChainId]).toEqual([1, 1])
  await page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect sponsor wallet', exact: true })).toBeVisible()
  await expect(fomo.getByText('Passage Test Wallet', { exact: true })).toBeVisible()
  await page.getByLabel('Network', { exact: true }).selectOption(String(DEFAULT_CHAIN_ID))
  await expect.poll(() => walletChainId).toBe(DEFAULT_CHAIN_ID)
  expect(payingChainId).toBe(1)
  expect(signingChains).toEqual([])
  expect(sends).toBe(0)
})

test('changing the Fomo account never assigns the sponsor role or changes the signed transfer', async ({ page }) => {
  const paymentLink = await signWithSource(page)
  const summary = await page.locator('.transfer-summary').innerText()
  await page.evaluate(() => (window as unknown as { passageMutateSourceAccount: () => void }).passageMutateSourceAccount())
  await expect(page.getByRole('button', { name: 'Connect Fomo wallet', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Fomo wallet', exact: true }).getByTitle(sponsor.address)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect sponsor wallet', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Estimate fees', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Payment link', { exact: true })).toHaveValue(paymentLink)
  await expect(page.locator('.transfer-summary')).toHaveText(summary, { useInnerText: true })
  expect(providerRequests.filter(request => request.provider === 'paying' && ['eth_requestAccounts', 'eth_sendTransaction'].includes(request.method))).toEqual([])
  expect(sends).toBe(0)
})

test('one wallet with two authorized accounts pins each role through reordering, switching and transfer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  singleProvider = true
  sourceAccounts = [source.address, sponsor.address]
  const before = await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Fomo wallet', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Passage Paying Wallet', exact: true })).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose Fomo account', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/shared-account-picker-mobile.png', fullPage: true })
  await page.getByRole('dialog').getByRole('button', { name: source.address, exact: true }).click()
  await page.getByRole('button', { name: 'Connect sponsor wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose sponsor account', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: source.address, exact: true })).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: sponsor.address, exact: true }).click()
  const fomo = page.getByRole('region', { name: 'Fomo wallet', exact: true })
  const paying = page.getByRole('region', { name: 'Sponsor wallet', exact: true })
  await expect(fomo.getByTitle(source.address)).toBeVisible()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/shared-account-roles-mobile.png', fullPage: true })
  await page.evaluate(accounts => (window as unknown as { passageSetAccounts: (accounts: string[]) => Promise<void> }).passageSetAccounts(accounts), [sponsor.address, source.address])
  await expect(fomo.getByTitle(source.address)).toBeVisible()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  const switchesBefore = networkSwitches.length
  for (const chainId of [8453, DEFAULT_CHAIN_ID]) {
    await page.getByLabel('Network', { exact: true }).selectOption(String(chainId))
    await expect.poll(() => walletChainId).toBe(chainId)
    await expect(page.getByRole('button', { name: 'Disconnect Fomo wallet', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Sync Fomo wallet network', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sync sponsor wallet network', exact: true })).toHaveCount(0)
  }
  expect(networkSwitches.slice(switchesBefore)).toEqual([8453, DEFAULT_CHAIN_ID])
  await signCurrentTransfer(page)
  await page.evaluate(accounts => (window as unknown as { passageSetAccounts: (accounts: string[]) => Promise<void> }).passageSetAccounts(accounts), [source.address, sponsor.address])
  await expect(fomo.getByTitle(source.address)).toBeVisible()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Pay fees and send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer complete', exact: true })).toBeVisible({ timeout: 40_000 })
  expect(providerRequests.filter(request => request.method === 'eth_signTypedData_v4')).toEqual([{ provider: 'source', role: 'source', method: 'eth_signTypedData_v4' }])
  expect(providerRequests.filter(request => request.method === 'eth_sendTransaction')).toEqual([{ provider: 'source', role: 'sponsor', method: 'eth_sendTransaction' }])
  expect(await client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })).toBe(before + parseEther('0.001'))
  const revokes = () => providerRequests.filter(request => request.method === 'wallet_revokePermissions')
  expect(revokes()).toHaveLength(0)
  await page.getByRole('button', { name: 'Disconnect Fomo wallet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect Fomo wallet', exact: true })).toBeEnabled()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  expect(revokes()).toHaveLength(0)
  await page.getByRole('button', { name: 'Disconnect sponsor wallet', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect sponsor wallet', exact: true })).toBeEnabled()
  await expect.poll(() => revokes().length).toBe(1)
  expect(sends).toBe(1)
})

test('adding a second permitted account works and cancelling new permissions preserves both roles', async ({ page }) => {
  singleProvider = true
  sourceAccounts = [source.address]
  const paymentLink = await signWithSource(page)
  const summary = await page.locator('.transfer-summary').innerText()
  await page.getByRole('button', { name: 'Connect sponsor wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose sponsor account', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: source.address, exact: true })).toBeDisabled()
  grantAdditionalAccounts = true
  const permissionsBefore = providerRequests.filter(request => request.method === 'wallet_requestPermissions').length
  await page.getByRole('button', { name: 'Add accounts in wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: sponsor.address, exact: true }).click()
  expect(providerRequests.filter(request => request.method === 'wallet_requestPermissions')).toHaveLength(permissionsBefore + 1)
  const fomo = page.getByRole('region', { name: 'Fomo wallet', exact: true })
  const paying = page.getByRole('region', { name: 'Sponsor wallet', exact: true })
  await expect(fomo.getByTitle(source.address)).toBeVisible()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  await page.getByRole('button', { name: 'Estimate fees', exact: true }).click()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Change sponsor wallet', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Passage Test Wallet', exact: true }).click()
  rejectAccountPermission = true
  await page.getByRole('button', { name: 'Add accounts in wallet', exact: true }).click()
  await expect.poll(() => providerRequests.filter(request => request.method === 'wallet_requestPermissions').length).toBe(permissionsBefore + 2)
  await expect(page.getByRole('dialog', { name: 'Choose sponsor account', exact: true }).getByRole('alert')).toContainText('Request rejected')
  await page.getByRole('button', { name: 'Close account selection', exact: true }).click()
  await expect(fomo.getByTitle(source.address)).toBeVisible()
  await expect(paying.getByTitle(sponsor.address)).toBeVisible()
  await expect(page.getByText('Fee budget', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Payment link', { exact: true })).toHaveValue(paymentLink)
  await expect(page.locator('.transfer-summary')).toHaveText(summary, { useInnerText: true })
  expect(providerRequests.filter(request => request.method === 'wallet_revokePermissions')).toHaveLength(0)
  expect(sends).toBe(0)
})

test('mobile layout, invalid shared link and no accidental wallet request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#transfer=invalid')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Passage — Send tokens')
  await expect(page.getByRole('alert')).toContainText(/could not be read/)
  expect(new URL(page.url()).hash).toBe('')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
})
