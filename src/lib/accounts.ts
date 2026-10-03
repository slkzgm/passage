import { isAddress, isAddressEqual, keccak256, zeroAddress, type Address } from 'viem'
import { ENTRY_POINT, IMPLEMENTATION, IMPLEMENTATION_HASH, getNetwork, getPublicClient } from './chain'
import { BALANCE_READER, SIMULATION_CALLER } from './operation'

export type AccountCompatibilityCode = 'undelegated' | 'unsupported-implementation' | 'contract-account' | 'contracts-changed' | 'wrong-network' | 'unavailable' | 'empty-sponsor' | 'invalid-address' | 'same-account' | 'reserved-address'

export class AccountCompatibilityError extends Error {
  constructor(readonly code: AccountCompatibilityCode, message: string, readonly chainId: number, readonly address: Address, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AccountCompatibilityError'
  }
}

function validateAddress(chainId: number, address: Address) {
  if (!isAddress(address) || isAddressEqual(address, zeroAddress)) {
    throw new AccountCompatibilityError('invalid-address', 'Choose a valid, non-zero wallet address.', chainId, address)
  }
  if ([BALANCE_READER, SIMULATION_CALLER].some((reserved) => isAddressEqual(address, reserved))) {
    throw new AccountCompatibilityError('reserved-address', 'This address is reserved for verification. Choose another wallet.', chainId, address)
  }
}

export async function validateSource(chainId: number, source: Address): Promise<void> {
  const network = getNetwork(chainId)
  validateAddress(chainId, source)
  const client = getPublicClient(chainId)
  try {
    const [rpcChainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })])
    if (rpcChainId !== chainId) throw new AccountCompatibilityError('wrong-network', `The RPC returned the wrong network. Retry ${network.name} verification.`, chainId, source)
    const [code, implementation, entryPoint] = await Promise.all([
      client.getCode({ address: source, blockNumber }),
      client.getCode({ address: IMPLEMENTATION, blockNumber }),
      client.getCode({ address: ENTRY_POINT, blockNumber }),
    ])
    if (!code || code === '0x') {
      throw new AccountCompatibilityError('undelegated', `This account has no delegation on ${network.name}. Choose another Fomo account or network.`, chainId, source)
    }
    if (!code.toLowerCase().startsWith('0xef0100')) {
      throw new AccountCompatibilityError('contract-account', 'A contract wallet cannot be the sending account. Choose a supported Fomo account.', chainId, source)
    }
    if (code.toLowerCase() !== `0xef0100${IMPLEMENTATION.slice(2).toLowerCase()}`) {
      throw new AccountCompatibilityError('unsupported-implementation', `This account uses an unsupported delegation on ${network.name}. Choose another Fomo account or network.`, chainId, source)
    }
    if (!implementation || !entryPoint || keccak256(implementation) !== IMPLEMENTATION_HASH || keccak256(entryPoint) !== network.entryPointHash) {
      throw new AccountCompatibilityError('contracts-changed', 'The network contracts do not match the verified versions. Transfers are blocked.', chainId, source)
    }
  } catch (cause) {
    if (cause instanceof AccountCompatibilityError) throw cause
    throw new AccountCompatibilityError('unavailable', `Could not verify this account on ${network.name}. Retry when the network responds.`, chainId, source, { cause })
  }
}

export async function validateSponsor(chainId: number, sponsor: Address, source: Address): Promise<void> {
  const network = getNetwork(chainId)
  validateAddress(chainId, sponsor)
  if (isAddressEqual(sponsor, source)) throw new AccountCompatibilityError('same-account', 'Choose a different wallet to pay the fees.', chainId, sponsor)
  const client = getPublicClient(chainId)
  try {
    const [rpcChainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })])
    if (rpcChainId !== chainId) throw new AccountCompatibilityError('wrong-network', `The RPC returned the wrong network. Retry ${network.name} verification.`, chainId, sponsor)
    const [code, balance] = await Promise.all([
      client.getCode({ address: sponsor, blockNumber }),
      client.getBalance({ address: sponsor, blockNumber }),
    ])
    if (code && code !== '0x' && !/^0xef0100[\da-f]{40}$/i.test(code)) {
      throw new AccountCompatibilityError('contract-account', 'This contract wallet cannot pay fees directly. Choose a regular or delegated wallet.', chainId, sponsor)
    }
    if (balance <= 0n) {
      throw new AccountCompatibilityError('empty-sponsor', `This wallet has no ${network.chain.nativeCurrency.symbol} balance on ${network.name}. Fund it or choose another paying wallet.`, chainId, sponsor)
    }
  } catch (cause) {
    if (cause instanceof AccountCompatibilityError) throw cause
    throw new AccountCompatibilityError('unavailable', `Could not verify this paying wallet on ${network.name}. Retry when the network responds.`, chainId, sponsor, { cause })
  }
}
