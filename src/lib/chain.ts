import { createPublicClient, fallback, http, parseAbi, type Address, type Chain, type Hex } from 'viem'
import { base, bsc, mainnet, monad, robinhood } from 'viem/chains'

export const DEFAULT_CHAIN_ID = 4663
export const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as const
export const IMPLEMENTATION = '0xe6Cae83BdE06E4c305530e199D7217f42808555B' as const
export const IMPLEMENTATION_HASH = '0xcc7b633aef4b2543cb8f37522adf1a401f910f0f6b2430c1eecc11f401ccfcf3' as const

export type NetworkConfig = {
  id: number
  name: string
  chain: Chain
  rpcUrls: readonly string[]
  explorer: string
  wrappedNative: Address
  entryPointHash: Hex
}

function network(chain: Chain, rpcUrls: readonly string[], wrappedNative: Address, entryPointHash: Hex): NetworkConfig {
  return {
    id: chain.id,
    name: chain.name,
    chain: { ...chain, rpcUrls: { default: { http: rpcUrls } } },
    rpcUrls,
    explorer: chain.blockExplorers!.default.url,
    wrappedNative,
    entryPointHash,
  }
}

export const NETWORKS: readonly [NetworkConfig, ...NetworkConfig[]] = [
  network({ ...robinhood, blockExplorers: { default: { name: 'Etherscan', url: 'https://robin.etherscan.io' } } }, ['https://rpc.mainnet.chain.robinhood.com'],
    '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    '0xa4b1c865a4a45b99ebaaf4bd06e0036ad489eb521786f59765e4e6a3c0524b03'),
  network(mainnet, ['https://ethereum-rpc.publicnode.com'],
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0x44e632a24c6f2600cbd5b5b8b4c2d372359112c8b5774297f5fd0a9e64f11f86'),
  network(base, ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    '0x4200000000000000000000000000000000000006',
    '0x28f989233f4ffb52e4b168fb74df5dfa52fe0f846141774f5abc56c5604d8e46'),
  network(bsc, ['https://bsc-dataseed.binance.org'],
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x9db0e60a88795050d924820a77335fd296a2a77ca6fcccb9c46c760c1fdbed21'),
  network(monad, ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz'],
    '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    '0x69515af79b28b62817d26d53e00b136ca7bc5e108ee604e4b6d01bf9f864f1d4'),
]

export function getNetwork(chainId: number): NetworkConfig {
  const selected = NETWORKS.find((item) => item.id === chainId)
  if (!selected) throw new Error('Unsupported network. Select a supported network.')
  return selected
}

function createNetworkClient(selected: NetworkConfig) {
  return createPublicClient({
    chain: selected.chain,
    transport: fallback(selected.rpcUrls.map((url) => http(url, { retryCount: 0, timeout: 15_000 })), { retryCount: 2 }),
    batch: { multicall: false },
  })
}

const clients = new Map<number, ReturnType<typeof createNetworkClient>>()

export function getPublicClient(chainId: number) {
  const selected = getNetwork(chainId)
  let client = clients.get(chainId)
  if (!client) {
    client = createNetworkClient(selected)
    clients.set(chainId, client)
  }
  return client
}
export const accountAbi = parseAbi([
  'function execute(address target,uint256 value,bytes data)',
  'function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)',
])
export const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getNonce(address sender,uint192 key) view returns (uint256)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function handleOps(PackedUserOperation[] ops,address beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
  'error FailedOp(uint256 opIndex,string reason)',
  'error FailedOpWithRevert(uint256 opIndex,string reason,bytes inner)',
])
