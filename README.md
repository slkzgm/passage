# Passage

Send assets from a compatible Fomo account while another wallet pays the network fees. A static React + Vite app with Reown AppKit, WalletConnect and public RPCs. No backend or private keys required.

## Supported networks

| Network | Native asset | Wrapped asset |
| --- | --- | --- |
| Ethereum | ETH | WETH |
| Base | ETH | WETH |
| BNB Smart Chain | BNB | WBNB |
| Monad | MON | WMON |
| Robinhood Chain | ETH | WETH |

Custom ERC-20 contract addresses are supported. Transfers stay on the selected network. See [Fomo's supported chains](https://help.fomo.family/en/articles/14436558-supported-chains).

## Development

Requires Node.js 22.12+ and pnpm 11.24.0.

```sh
pnpm install --frozen-lockfile
cp config/public/.env.example config/public/.env.local
# Add your public Reown project ID to config/public/.env.local.
pnpm dev
```

Open `http://127.0.0.1:5173`. In [Reown Dashboard](https://dashboard.reown.com), allowlist the app's origin and disable email/social login, swaps, on-ramp and history. Remote project settings can override local AppKit options.

Only `config/public/` supplies Vite environment files. Never put private keys or recovery phrases in `VITE_*` variables. Local environment files are ignored by Git.

## How it works

1. Connect the imported Fomo account and a funded sponsor wallet. Both connections stay available independently.
2. Select a network, asset, amount and recipient.
3. Review and sign in the Fomo wallet, then approve the fee payment in the sponsor wallet. You can also share the payment link with a sponsor.

Each wallet has its own Change and Disconnect controls. Replacing one connection preserves the other and any signed authorization. Cancelling a replacement preserves the existing wallet. Changing the sponsor invalidates its fee estimate.

The app checks the sending account's delegation and contract code before enabling actions. Missing or unsupported implementations are blocked with a retryable status. The paying account is checked separately; it does not need Fomo's implementation. Selecting a network synchronizes both connections. Wallet switch prompts run one at a time; a rejected switch remains visible with a retry action. WalletConnect sessions without switch support route requests to the authorized network explicitly. The source signs and the sponsor submits through their own connections; accounts and networks are checked again before each request.

Balances and account checks refresh on focus and periodically. All blockchain reads and simulations use public RPCs in the browser. The paying wallet broadcasts through its provider. Reown AppKit Core supplies the mobile wallet picker; WalletConnect SignClient keeps separate sessions for the two roles. Each request uses its session topic, authorized chain and wallet link. Wagmi handles browser extension connections. Two authorized accounts in the same extension can fill both roles: choose the Fomo and sponsor addresses in the account picker. If an address is missing, use **Add accounts in wallet** and authorize both accounts. Each role stays bound to its chosen address even when the wallet reorders accounts. Disconnecting one role keeps a shared extension connected for the other.

## Security and limits

- Only accounts already delegated to the verified `Simple7702Account` at `0xe6Cae83BdE06E4c305530e199D7217f42808555B` are supported. EntryPoint v0.8 at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` and both runtime hashes are checked on the selected network. The app never changes delegation.
- Signatures bind the source, network, recipient, asset, amount and nonce. Only direct transfers are accepted; no approvals or arbitrary contract calls.
- Simulations verify exact balance changes and operation success before submission. Tokens with transfer fees or incompatible behavior are rejected. Receipt verification remains inconclusive if the RPC cannot establish the exact balance changes.
- Wallet roles are held in memory for the current page. Reloading requires reconnecting. Save the payment link before leaving a signed transfer.
- **Signed authorizations do not expire.** Closing the page or deleting a payment link does not revoke them. Payment links contain an executable authorization in a URL fragment, stripped before SDK initialization.
- Monad reserves up to [10 MON for delegated accounts](https://docs.monad.xyz/developer-essentials/reserve-balance); this is excluded from the transferable native balance. Base fee estimates include buffered L1/operator fees. Estimates expire after 60 seconds.
- Network state can change after simulation, and failed transactions can cost gas. Contract wallets that cannot submit a direct transaction are not supported as payers.

## Checks

```sh
pnpm check                 # TypeScript and unit tests
pnpm build                 # Production build
pnpm test:rpc              # Read-only simulations on all five public RPCs
pnpm test:fork             # Local Robinhood Chain fork
pnpm test:fork --chain=1   # Fork another supported network
pnpm test:e2e              # Browser flow and compatibility checks
```

Fork tests require Anvil and use disposable accounts on `127.0.0.1:18545`; no transactions are sent to public networks. Anvil does not reproduce all Monad or Base fee rules. Browser tests use `/usr/bin/chromium` by default (`CHROMIUM_PATH` overrides it). Browser tests emulate separate injected wallets. Unit tests cover WalletConnect session routing and lifecycle; WalletConnect on a physical phone requires separate validation.

## Deployment

Serve `dist/` over HTTPS. Vercel configuration and a `_headers` file for compatible static hosts are included. Set the public `VITE_REOWN_PROJECT_ID` at build time and allowlist the deployed origin in Reown. Apply the supplied security headers and publish only `dist/`.

Dependency overrides apply security fixes to transitive packages.

## License

[MIT](LICENSE) © 2026 slkzgm.
