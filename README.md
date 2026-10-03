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

1. Connect the imported Fomo account and select a network, asset, amount and recipient.
2. Review and sign the transfer authorization.
3. Connect another funded wallet, or share the payment link with its owner.
4. Review the fee estimate and approve the transaction in the paying wallet.

The app checks the sending account's delegation and contract code before enabling actions. Missing or unsupported implementations are blocked with a retryable status. The paying account is checked separately; it does not need Fomo's implementation. Wallet networks switch before signing or sending, and checks are repeated before submission.

Balances and account checks refresh on focus and periodically. All blockchain reads and simulations use public RPCs in the browser. The paying wallet broadcasts the transaction through its provider; Reown handles wallet connections.

## Security and limits

- Only accounts already delegated to the verified `Simple7702Account` at `0xe6Cae83BdE06E4c305530e199D7217f42808555B` are supported. EntryPoint v0.8 at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` and both runtime hashes are checked on the selected network. The app never changes delegation.
- Signatures bind the source, network, recipient, asset, amount and nonce. Only direct transfers are accepted; no approvals or arbitrary contract calls.
- Simulations verify exact balance changes and operation success before submission. Tokens with transfer fees or incompatible behavior are rejected. Receipt verification remains inconclusive if the RPC cannot establish the exact balance changes.
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

Fork tests require Anvil and use disposable accounts on `127.0.0.1:18545`; no transactions are sent to public networks. Anvil does not reproduce all Monad or Base fee rules. Browser tests use `/usr/bin/chromium` by default (`CHROMIUM_PATH` overrides it). They emulate an injected wallet; WalletConnect on a physical phone requires separate validation.

## Deployment

Serve `dist/` over HTTPS. Vercel configuration and a `_headers` file for compatible static hosts are included. Set the public `VITE_REOWN_PROJECT_ID` at build time and allowlist the deployed origin in Reown. Apply the supplied security headers and publish only `dist/`.

Dependency overrides keep Wagmi versions compatible and apply security fixes. The small `decode-uri-component` patch preserves its corrected decoder while restoring the CommonJS export required by a transitive dependency; its compatibility is tested.
