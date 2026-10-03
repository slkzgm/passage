import type { Address, Hex } from 'viem'

export type PackedOperation = {
  sender: Address
  nonce: bigint
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: bigint
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}

export type Asset = { kind: 'native' } | { kind: 'erc20'; address: Address }
export type AssetInfo = Asset & { symbol: string; name: string; decimals: number; balance: bigint; reservedBalance: bigint }
export type TransferIntent = { chainId: number; source: Address; recipient: Address; asset: Asset; amount: bigint }
export type PreparedTransfer = { intent: TransferIntent; asset: AssetInfo; operation: PackedOperation; hash: Hex }
export type SignedTransfer = PreparedTransfer
export type GasQuote = { chainId: number; sponsor: Address; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; extraFee: bigint; maxCost: bigint; operationHash: Hex; quotedAt: number }
export type TransferResult = { hash: Hex; blockNumber: bigint; received: bigint; status: 'confirmed' | 'failed' | 'unverified'; message: string }
