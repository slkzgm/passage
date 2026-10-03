import { concat, decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, hashTypedData, isAddress, isAddressEqual, toHex, zeroAddress, type Address, type Hex } from 'viem'
import { getUserOperationTypedData } from 'viem/account-abstraction'
import { accountAbi, getNetwork, ENTRY_POINT, entryPointAbi, IMPLEMENTATION } from './chain'
import type { Asset, PackedOperation, TransferIntent } from './types'

export const ZERO_WORD = toHex(0n, { size: 32 })
export const ACCOUNT_GAS_LIMITS = concat([toHex(200_000n, { size: 16 }), toHex(300_000n, { size: 16 })])
export const MAX_OUTER_GAS = 1_000_000n
// These addresses exist only in RPC state overrides, never as deployed contracts.
export const BALANCE_READER: Address = '0x00000000000000000000000000000000ba1a0ce0'
export const SIMULATION_CALLER: Address = '0x00000000000000000000000000000000ba1a0ce1'

export function checkedAddress(value: string): Address {
  if (!isAddress(value)) throw new Error('Invalid address. Enter a complete 0x address.')
  const address = getAddress(value)
  if (isAddressEqual(address, zeroAddress)) throw new Error('The zero address is not a valid recipient.')
  return address
}

export function validateRecipient(source: Address, recipient: string, asset: Asset): void {
  const destination = checkedAddress(recipient)
  const sender = checkedAddress(source)
  if (isAddressEqual(sender, destination)) throw new Error('Choose a recipient different from the sending account.')
  if ([ENTRY_POINT, IMPLEMENTATION, BALANCE_READER, SIMULATION_CALLER].some((address) => isAddressEqual(address, destination))) {
    throw new Error('This recipient address is reserved. Choose another recipient.')
  }
  if ([BALANCE_READER, SIMULATION_CALLER].some((address) => isAddressEqual(address, sender))) throw new Error('Reserved simulation address.')
  if (asset.kind === 'erc20') {
    const token = checkedAddress(asset.address)
    if (isAddressEqual(sender, token)) throw new Error('The token contract cannot be the sending account.')
    if (isAddressEqual(destination, token)) throw new Error('Do not send tokens to their own contract. Choose another recipient.')
    if ([BALANCE_READER, SIMULATION_CALLER].some((address) => isAddressEqual(address, token))) throw new Error('Reserved simulation address.')
  }
}

export function transferCalldata(intent: TransferIntent): Hex {
  return encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: intent.asset.kind === 'native'
    ? [intent.recipient, intent.amount, '0x']
    : [intent.asset.address, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [intent.recipient, intent.amount] })],
  })
}

export function operationIntent(operation: PackedOperation, chainId: number): TransferIntent {
  getNetwork(chainId)
  const source = checkedAddress(operation.sender)
  if (operation.initCode !== '0x' || operation.paymasterAndData !== '0x' || operation.gasFees !== ZERO_WORD || operation.preVerificationGas !== 0n || operation.accountGasLimits !== ACCOUNT_GAS_LIMITS) {
    throw new Error('This authorization is not a supported Passage transfer with zero fees for the source account.')
  }
  const decoded = decodeFunctionData({ abi: accountAbi, data: operation.callData })
  if (decoded.functionName !== 'execute') throw new Error('Only direct asset transfers are supported.')
  const [target, value, data] = decoded.args
  let intent: TransferIntent
  if (value > 0n && data === '0x') {
    intent = { chainId, source, recipient: checkedAddress(target), asset: { kind: 'native' }, amount: value }
  } else {
    if (value !== 0n) throw new Error('Native transfers cannot include contract calls.')
    const token = checkedAddress(target)
    const transfer = decodeFunctionData({ abi: erc20Abi, data })
    if (transfer.functionName !== 'transfer') throw new Error('This authorization is not a token transfer.')
    intent = { chainId, source, recipient: checkedAddress(transfer.args[0]), asset: { kind: 'erc20', address: token }, amount: transfer.args[1] }
  }
  validateRecipient(source, intent.recipient, intent.asset)
  if (intent.amount <= 0n) throw new Error('The amount must be greater than zero.')
  // Re-encoding excludes trailing calldata, nested calls and ambiguous payloads.
  if (transferCalldata(intent).toLowerCase() !== operation.callData.toLowerCase()) throw new Error('The transfer data is invalid.')
  return intent
}

export function typedData(operation: PackedOperation, chainId: number) {
  getNetwork(chainId)
  if (operation.initCode !== '0x' || operation.paymasterAndData !== '0x') throw new Error('Unsupported signature format.')
  return getUserOperationTypedData({ chainId, entryPointAddress: ENTRY_POINT, userOperation: {
    sender: operation.sender, nonce: operation.nonce, callData: operation.callData,
    verificationGasLimit: BigInt(operation.accountGasLimits.slice(0, 34)),
    callGasLimit: BigInt(`0x${operation.accountGasLimits.slice(34)}`),
    preVerificationGas: operation.preVerificationGas,
    maxPriorityFeePerGas: BigInt(operation.gasFees.slice(0, 34)),
    maxFeePerGas: BigInt(`0x${operation.gasFees.slice(34)}`), signature: operation.signature,
  } })
}
export function operationHash(operation: PackedOperation, chainId: number) { return hashTypedData(typedData(operation, chainId)) }

type EventLog = { address: Address; data: Hex; topics: readonly Hex[] }
export function inspectTransferLogs(logs: readonly EventLog[], intent: TransferIntent, hash?: Hex) {
  let received = 0n
  let operationSuccess: boolean | undefined
  for (const log of logs) {
    try {
      if (intent.asset.kind === 'erc20' && isAddressEqual(log.address, intent.asset.address)) {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        if (event.eventName === 'Transfer' && isAddressEqual(event.args.from, intent.source) && isAddressEqual(event.args.to, intent.recipient)) received += event.args.value
      } else if (hash && isAddressEqual(log.address, ENTRY_POINT)) {
        const event = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        if (event.eventName === 'UserOperationEvent' && event.args.userOpHash.toLowerCase() === hash.toLowerCase() && isAddressEqual(event.args.sender, intent.source)) operationSuccess = event.args.success
      }
    } catch { /* Other events in the same transaction are not transfer evidence. */ }
  }
  return { received, operationSuccess }
}
