import { encodeFunctionData, erc20Abi, isAddressEqual, pad, toHex, type Address, type Hex } from 'viem'
import { getPublicClient } from './chain'
import { BALANCE_READER, inspectTransferLogs, SIMULATION_CALLER } from './operation'
import type { GasQuote, TransferIntent } from './types'

// BALANCE(calldataload(0)), returned as a uint256. Only this isolated reader and
// its caller are overridden; the transfer participants keep their actual state.
const BALANCE_READER_CODE = '0x6000353160005260206000f3' as const

export async function simulateTransfer(intent: TransferIntent, call: { from: Address; to: Address; data: Hex; gas: bigint }, hash?: Hex, fees?: Pick<GasQuote, 'maxFeePerGas' | 'maxPriorityFeePerGas'>): Promise<bigint> {
  const client = getPublicClient(intent.chainId)
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || (fees && block.baseFeePerGas === null)) throw new Error('The RPC cannot provide a block for simulation.')
  const baseFee = fees ? block.baseFeePerGas! : 0n
  if (fees && (fees.maxFeePerGas < baseFee || fees.maxPriorityFeePerGas > fees.maxFeePerGas)) throw new Error('Network fees have changed. Refresh the fee estimate.')
  const prices = fees
    ? { maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas) }
    : { gasPrice: '0x0' as const }
  const balanceCall = (owner: Address) => ({
    from: SIMULATION_CALLER,
    ...(intent.asset.kind === 'native'
      ? { to: BALANCE_READER, data: pad(owner, { size: 32 }) }
      : { to: intent.asset.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) }),
    gas: toHex(100_000n), ...prices,
  })
  // Pin both the state and base fee: Monad otherwise simulates at base fee zero.
  // Unsigned previews use zero fees so a source with no gas can still be checked.
  const result = await client.request({ method: 'eth_simulateV1', params: [{
    validation: true,
    blockStateCalls: [{
      blockOverrides: { baseFeePerGas: toHex(baseFee) },
      stateOverrides: {
        [BALANCE_READER]: { code: BALANCE_READER_CODE },
        [SIMULATION_CALLER]: { balance: toHex(10n ** 30n) },
      },
      calls: [balanceCall(intent.source), balanceCall(intent.recipient), { ...call, gas: toHex(call.gas), ...prices }, balanceCall(intent.source), balanceCall(intent.recipient)],
    }],
  }, toHex(block.number)] })
  const calls = result[0]?.calls
  if (!calls || calls.length !== 5 || calls.some((item) => item.status !== '0x1')) throw new Error('Simulation failed. No transfer will be sent.')
  const balances = [0, 1, 3, 4].map((i) => {
    if (!/^0x[\da-f]{64}$/i.test(calls[i].returnData)) throw new Error('The RPC returned an invalid balance.')
    return BigInt(calls[i].returnData)
  })
  const evidence = inspectTransferLogs(calls[2].logs ?? [], intent, hash)
  const price = fees ? (baseFee + fees.maxPriorityFeePerGas < fees.maxFeePerGas ? baseFee + fees.maxPriorityFeePerGas : fees.maxFeePerGas) : 0n
  const fee = BigInt(calls[2].gasUsed) * price
  // A recipient may also sponsor the transaction. Its native balance gains the
  // transfer minus gas, unlike its ERC-20 balance. Simulations exclude Base L1 fees.
  const sourceFee = intent.asset.kind === 'native' && isAddressEqual(call.from, intent.source) ? fee : 0n
  const recipientFee = intent.asset.kind === 'native' && isAddressEqual(call.from, intent.recipient) ? fee : 0n
  if ((hash && evidence.operationSuccess !== true)
    || (intent.asset.kind === 'erc20' && evidence.received !== intent.amount)
    || balances[0] - balances[2] - sourceFee !== intent.amount
    || balances[3] - balances[1] + recipientFee !== intent.amount) {
    throw new Error('Simulation could not confirm the exact amount received. Transfer fees, restrictions or nonstandard transfers are not supported.')
  }
  return BigInt(calls[2].gasUsed)
}
