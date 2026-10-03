import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CHAIN_ID, getNetwork } from '../src/lib/chain'

const chainArgument = process.argv.slice(2).find((argument) => argument.startsWith('--chain='))
const chainId = chainArgument ? Number(chainArgument.slice('--chain='.length)) : DEFAULT_CHAIN_ID
const network = getNetwork(chainId)
const rpc = 'http://127.0.0.1:18545'
try { await fetch(rpc, { signal: AbortSignal.timeout(300) }); throw new Error('Port 18545 is already in use. Stop its process before running this test.') } catch (error) {
  if (error instanceof Error && error.message.includes('already in use')) throw error
}
async function rpcRead(url: string, method: string): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) })
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
  const body = await response.json() as { result?: unknown; error?: unknown }
  if (body.error || body.result === undefined) throw new Error('Invalid RPC response')
  return body.result
}
let upstream: string | undefined
let blockNumber: bigint | undefined
for (const url of network.rpcUrls) {
  try {
    const [remoteChain, latest] = await Promise.all([rpcRead(url, 'eth_chainId'), rpcRead(url, 'eth_blockNumber')])
    if (typeof remoteChain !== 'string' || Number(remoteChain) !== chainId || typeof latest !== 'string' || !/^0x[\da-f]+$/i.test(latest)) throw new Error('RPC chain or block mismatch')
    upstream = url
    blockNumber = BigInt(latest)
    break
  } catch (error) {
    console.warn(`${url}: ${error instanceof Error ? error.message : 'RPC unavailable'}`)
  }
}
if (!upstream || blockNumber === undefined) throw new Error(`No public RPC available for ${network.name}.`)
const dir = await mkdtemp(join(tmpdir(), 'passage-fork-'))
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18545', '--chain-id', String(chainId), '--accounts', '0', '--fork-url', upstream, '--fork-block-number', String(blockNumber), '--silent'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
anvil.stderr.on('data', chunk => process.stderr.write(chunk))
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (anvil.exitCode !== null) throw new Error('Anvil did not start.')
    try {
      const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(1_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      ready = Number((await response.json()).result) === chainId
    } catch { /* Startup only; no real transaction is sent upstream. */ }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (!ready) throw new Error('The local fork is not ready.')
  console.log(`Local ${network.name} fork (${chainId}) at block ${blockNumber}. All writes stay on 127.0.0.1.`)
  const browser = process.argv.includes('--browser')
  const test = spawn('pnpm', browser ? ['exec', 'playwright', 'test'] : ['exec', 'vitest', 'run', '--config', 'vitest.fork.config.ts'], {
    cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, PASSAGE_FORK_RPC: rpc, PASSAGE_FORK_CHAIN_ID: String(chainId) },
  })
  process.exitCode = await new Promise<number>((resolve, reject) => { test.on('exit', code => resolve(code ?? 1)); test.on('error', reject) })
} finally {
  if (anvil.exitCode === null) {
    const stopped = new Promise(resolve => anvil.once('exit', resolve))
    anvil.kill('SIGTERM')
    await stopped
  }
  await rm(dir, { recursive: true, force: true })
}
