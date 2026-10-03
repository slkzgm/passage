import { isHex, type Hex } from 'viem'
import { getNetwork } from './chain'
import { operationIntent } from './operation'
import { hydrateOperation } from './transfer'
import type { PackedOperation, SignedTransfer } from './types'

const MAX_LENGTH = 8_192
const operationKeys = ['sender', 'nonce', 'initCode', 'callData', 'accountGasLimits', 'preVerificationGas', 'gasFees', 'paymasterAndData', 'signature']

export function encodeEnvelope(signed: SignedTransfer): string {
  operationIntent(signed.operation, signed.intent.chainId)
  return btoa(JSON.stringify({ version: 1, chainId: signed.intent.chainId, operation: signed.operation }, (_, value) => typeof value === 'bigint' ? value.toString() : value))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeEnvelope(fragment: string): { chainId: number; operation: PackedOperation } {
  const payload = fragment.replace(/^#transfer=/, '')
  if (!payload || payload.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('This transfer link is invalid or too long.')
  let envelope: unknown
  try { envelope = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) } catch { throw new Error('This transfer link could not be read.') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Invalid transfer format.')
  const value = envelope as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'chainId,operation,version' || value.version !== 1 || !Number.isSafeInteger(value.chainId)) throw new Error('This link is not a supported Passage transfer.')
  const chainId = getNetwork(value.chainId as number).id
  if (!value.operation || typeof value.operation !== 'object' || Array.isArray(value.operation)) throw new Error('Missing authorization.')
  const operation = value.operation as Record<string, unknown>
  if (Object.keys(operation).sort().join(',') !== [...operationKeys].sort().join(',')) throw new Error('The authorization contains unexpected fields.')
  for (const key of operationKeys) {
    if (typeof operation[key] !== 'string') throw new Error('Invalid authorization format.')
    if (key === 'nonce' || key === 'preVerificationGas') {
      if (!/^(0|[1-9]\d{0,77})$/.test(operation[key]) || BigInt(operation[key]) >= 2n ** 256n) throw new Error('Invalid nonce or fees.')
    } else if (!isHex(operation[key], { strict: true }) || operation[key].length % 2 !== 0) throw new Error('Invalid hexadecimal data.')
  }
  if ((operation.signature as string).length !== 132) throw new Error('The transfer signature is missing or invalid.')
  const parsed = { ...operation, nonce: BigInt(operation.nonce as string), preVerificationGas: BigInt(operation.preVerificationGas as string) } as PackedOperation
  operationIntent(parsed, chainId)
  return { chainId, operation: parsed }
}

export function createShareUrl(signed: SignedTransfer, baseUrl = window.location.href): string {
  const url = new URL(baseUrl)
  url.search = ''
  // URL fragments are not sent to the hosting server or in Referer headers.
  url.hash = `transfer=${encodeEnvelope(signed)}`
  return url.toString()
}

export async function loadSignedTransfer(fragment: string): Promise<SignedTransfer> {
  const { chainId, operation } = decodeEnvelope(fragment)
  return hydrateOperation(operation, chainId)
}
