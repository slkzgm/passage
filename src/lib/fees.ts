import { parseAbi, serializeTransaction, type Address, type Hex } from 'viem'
import { getNetwork, getPublicClient } from './chain'

const gasPriceOracle = '0x420000000000000000000000000000000000000F' as const
const oracleAbi = parseAbi([
  'function getL1Fee(bytes unsignedTransaction) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
])

type FeeTransaction = {
  to: Address
  data: Hex
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export async function estimateFeeBudget(chainId: number, sponsor: Address, transaction: FeeTransaction): Promise<{ maxCost: bigint; extraFee: bigint }> {
  getNetwork(chainId)
  let extraFee = 0n
  if (chainId === 8453) {
    const client = getPublicClient(chainId)
    const [nonce, operatorFee] = await Promise.all([
      client.getTransactionCount({ address: sponsor, blockTag: 'pending' }),
      client.readContract({ address: gasPriceOracle, abi: oracleAbi, functionName: 'getOperatorFee', args: [transaction.gas] }),
    ])
    const unsigned = serializeTransaction({ ...transaction, chainId, nonce, type: 'eip1559', value: 0n })
    const l1Fee = await client.readContract({ address: gasPriceOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [unsigned] })
    // L1 prices and operator parameters can change before inclusion: this is a budget, not a cap.
    extraFee = 2n * (l1Fee + operatorFee)
  }
  // Nitro includes its parent-chain data fee in the estimated gas; L1s have no separate data fee.
  return { maxCost: transaction.gas * transaction.maxFeePerGas + extraFee, extraFee }
}

type FeeReceipt = {
  gasUsed: bigint
  effectiveGasPrice: bigint
  type?: string
  l1Fee?: unknown
  operatorFeeScalar?: unknown
  operatorFeeConstant?: unknown
  daFootprintGasScalar?: unknown
}

function quantity(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  return typeof value === 'string' && /^0x[\da-f]+$/i.test(value) ? BigInt(value) : null
}

export function transactionFee(chainId: number, receipt: FeeReceipt): bigint | null {
  getNetwork(chainId)
  const gas = quantity(receipt.gasUsed)
  const price = quantity(receipt.effectiveGasPrice)
  if (gas === null || price === null || ['deposit', 'eip4844', '0x7e', '0x3'].includes(receipt.type ?? '')) return null
  const executionFee = gas * price
  // Monad receipts report charged gas (gas limit less applicable refunds), as does Nitro.
  if (chainId !== 8453) return executionFee
  const l1Fee = quantity(receipt.l1Fee)
  if (l1Fee === null) return null
  const { operatorFeeScalar, operatorFeeConstant } = receipt
  // OP Stack omits both fields iff both operator parameters are zero (Isthmus receipt spec).
  if (operatorFeeScalar === undefined && operatorFeeConstant === undefined) return executionFee + l1Fee
  const scalar = quantity(operatorFeeScalar)
  const constant = quantity(operatorFeeConstant)
  if (scalar === null || constant === null) return null
  if (scalar === 0n) return executionFee + l1Fee + constant
  // Jovian adds this receipt field and changes the multiplier from /1e6 to *100.
  // Without the marker a non-zero scalar cannot be safely interpreted from this receipt alone.
  if (quantity(receipt.daFootprintGasScalar) === null) return null
  return executionFee + l1Fee + gas * scalar * 100n + constant
}
