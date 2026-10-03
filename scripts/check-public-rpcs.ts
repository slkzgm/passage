/** Public-node qualification only: synthetic balances/delegation exist solely in
 * eth_simulateV1 overrides. The disposable key is never funded or broadcast. */
import { encodeFunctionData, pad, toHex, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { BALANCE_READER, SIMULATION_CALLER, ACCOUNT_GAS_LIMITS, ZERO_WORD, inspectTransferLogs, operationHash, transferCalldata, typedData } from '../src/lib/operation'
import { ENTRY_POINT, IMPLEMENTATION, NETWORKS, entryPointAbi, getPublicClient } from '../src/lib/chain'
import type { PackedOperation, TransferIntent } from '../src/lib/types'

const source = privateKeyToAccount(generatePrivateKey())
const recipient = privateKeyToAccount(generatePrivateKey()).address
const amount = 10n ** 16n
const funding = 20n * 10n ** 18n
const readerCode = '0x6000353160005260206000f3' as const

const results = await Promise.all(NETWORKS.map(async network => {
  try {
    const client = getPublicClient(network.id)
    const block = await client.getBlock({ blockTag: 'latest' })
    if (block.number === null || block.baseFeePerGas === null) throw new Error('Missing block number/base fee')
    const intent: TransferIntent = { chainId: network.id, source: source.address, recipient, asset: { kind: 'native' }, amount }
    const operation: PackedOperation = {
      sender: source.address, nonce: 1n << 128n, initCode: '0x', callData: transferCalldata(intent),
      accountGasLimits: ACCOUNT_GAS_LIMITS, preVerificationGas: 0n, gasFees: ZERO_WORD, paymasterAndData: '0x', signature: '0x',
    }
    operation.signature = await source.signTypedData(typedData(operation, network.id))
    const hash = operationHash(operation, network.id)
    const gasUsed: bigint[] = []
    for (const signed of [false, true]) {
      const prices = signed
        ? { maxFeePerGas: toHex(block.baseFeePerGas * 2n), maxPriorityFeePerGas: '0x0' as const }
        : { gasPrice: '0x0' as const }
      const balance = (owner: Address) => ({ from: SIMULATION_CALLER, to: BALANCE_READER, data: pad(owner, { size: 32 }), gas: toHex(100_000n), ...prices })
      const result = await client.request({ method: 'eth_simulateV1', params: [{
        validation: true,
        blockStateCalls: [{
          blockOverrides: { baseFeePerGas: signed ? toHex(block.baseFeePerGas) : '0x0' },
          stateOverrides: {
            [source.address]: { balance: toHex(funding), code: `0xef0100${IMPLEMENTATION.slice(2)}` },
            [BALANCE_READER]: { code: readerCode },
            [SIMULATION_CALLER]: { balance: toHex(10n ** 30n) },
            ...(signed ? { [recipient]: { balance: toHex(funding) } } : {}),
          },
          calls: [balance(source.address), balance(recipient), {
            from: signed ? recipient : source.address,
            to: signed ? ENTRY_POINT : source.address,
            data: signed ? encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[operation], recipient] }) : operation.callData,
            gas: toHex(signed ? 600_000n : 300_000n), ...prices,
          }, balance(source.address), balance(recipient)],
        }],
      }, toHex(block.number)] })
      const calls = result[0]?.calls
      if (calls?.length !== 5 || calls.some(call => call.status !== '0x1')) throw new Error(`${signed ? 'Signed' : 'Preview'} execution failed`)
      if (!signed && BigInt(calls[1].returnData) !== 0n) throw new Error('Fresh recipient unexpectedly has a balance')
      const sourceDelta = BigInt(calls[0].returnData) - BigInt(calls[3].returnData)
      const recipientDelta = BigInt(calls[4].returnData) - BigInt(calls[1].returnData)
      const used = BigInt(calls[2].gasUsed)
      if (sourceDelta !== amount || recipientDelta + (signed ? used * block.baseFeePerGas : 0n) !== amount) throw new Error('Native balance conservation failed')
      if (signed && inspectTransferLogs(calls[2].logs ?? [], intent, hash).operationSuccess !== true) throw new Error('Expected successful UserOperation hash not found')
      gasUsed.push(used)
    }
    return { network: network.name, chainId: network.id, preview: 'pass', signedRecipientSponsor: 'pass', previewGas: String(gasUsed[0]), signedGas: String(gasUsed[1]) }
  } catch (error) {
    process.exitCode = 1
    return { network: network.name, chainId: network.id, error: error instanceof Error ? error.message : String(error) }
  }
}))
console.table(results)
