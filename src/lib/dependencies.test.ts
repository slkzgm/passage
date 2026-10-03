import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const connectorsRequire = createRequire(require.resolve('@wagmi/connectors'))
const walletConnectRequire = createRequire(connectorsRequire.resolve('@walletconnect/ethereum-provider'))
const utilsRequire = createRequire(walletConnectRequire.resolve('@walletconnect/utils'))
const queryPath = utilsRequire.resolve('query-string')
const queryRequire = createRequire(queryPath)
const decodePath = queryRequire.resolve('decode-uri-component')

describe('patched wallet dependency compatibility', () => {
  it('decodes Unicode through the real WalletConnect CommonJS query-string dependency', () => {
    const query = utilsRequire('query-string') as { parse: (input: string) => Record<string, unknown> }
    expect(query.parse('name=na%C3%AFve&symbol=%E2%82%AC&label=hello+world')).toEqual({
      name: 'naïve', symbol: '€', label: 'hello world',
    })
  })

  it('supports native CJS and ESM and bounds adversarial malformed URI decoding', () => {
    // A subprocess timeout also stops synchronous decoder regressions that would block Vitest.
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      import { pathToFileURL } from 'node:url'
      const require = createRequire(import.meta.url)
      const query = require(process.argv[1])
      const decode = require(process.argv[2])
      const esm = await import(pathToFileURL(process.argv[2]).href)
      assert.equal(typeof decode, 'function')
      assert.equal(esm.default, decode)
      assert.equal(esm.default('%F0%9F%8C%8D'), '🌍')
      for (const malformed of ['%E0%A4%A', '%FF', '%E2%82', '%C0%AF']) {
        const input = malformed.repeat(8192)
        assert.equal(typeof decode(input), 'string')
        assert.equal(typeof query.parse('value=' + input).value, 'string')
      }
      process.stdout.write('compatible')
    `, queryPath, decodePath], { encoding: 'utf8', timeout: 3_000 })
    expect(result).toBe('compatible')
  })

  it('preserves the UUID v4 and validation APIs consumed by MetaMask', () => {
    const sdkRequire = createRequire(connectorsRequire.resolve('@metamask/sdk'))
    const communicationRequire = createRequire(sdkRequire.resolve('@metamask/sdk-communication-layer'))
    for (const parentRequire of [sdkRequire, communicationRequire]) {
      const uuid = parentRequire('uuid') as { v4: () => string; validate: (value: string) => boolean }
      const first = uuid.v4()
      expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
      expect(uuid.validate(first)).toBe(true)
      expect(uuid.validate('not-a-uuid')).toBe(false)
      expect(uuid.v4()).not.toBe(first)
    }
  })
})
