# Deployment notes

[Back to deployment instructions](../README.md).

## Pinned toolchain

| Component | Version |
| --- | --- |
| Node | 22+; checked using 24.19.0 |
| Compact compiler | 0.31.0 |
| OZ Compact Contracts | 0.3.0-rc.2 |
| Compact runtime / Compact.js | 0.16.0 / 2.5.1 |
| Midnight.js | 4.1.1 |
| Ledger / on-chain runtime | ledger-v8 8.1.0 / onchain-runtime-v3 3.0.0 |
| Wallet SDK / facade | 1.1.0 / 4.0.1 |
| Proof server | `midnightntwrk/proof-server:8.0.3` from public Docker Hub |

Keep the lockfile, direct Ledger dependency and overrides. The application and wallet must use one physical copy of Ledger 8.1.0: separate copies load separate WASM classes even at the same version. The earlier lockfile caused `expected instance of DustParameters` during wallet construction. Run `npm ci` after pulling the fix.

## Wallet setup

`npm run setup` works offline. It generates a random 32-byte wallet seed, an independent 32-byte owner nonce, a CMA signing key using the pinned runtime, and a storage password accepted by the SDK. It saves them in `.env` with owner-only permissions and prints only the public unshielded address.

Running setup again preserves every nonempty setting, including custom endpoints and existing keys. Empty or missing settings are filled. The wallet is restored from the same master seed each time the deployment script runs; it uses account 0 and key index 0.

For a manually supplied storage password, the SDK requires at least 16 characters and three of uppercase, lowercase, digits and symbols. Runs of four repeated or sequential characters are rejected.

## DUST registration

After using the faucet, run `npm run register-dust`. It restores the same wallet, waits for available NIGHT and selects only unregistered NIGHT coins. It repeatedly estimates the registration fee until the SDK's eligible input can cover it from the DUST attributable to its age. A first registration therefore needs no existing DUST balance.

The SDK signs the registration with the wallet's unshielded key and sends the DUST to this wallet's DUST address. The command prints the transaction ID, submits once, checks successful execution in the wallet's indexed transaction history, and waits for a positive DUST balance. Existing registrations are preserved. A positive balance shows that generation is working; the deployment's actual fee can require more accumulation time.

Funding, fee accumulation, submission, confirmation and DUST waits each time out after ten minutes. Wallet sync has a separate three-minute timeout. If submission or confirmation is uncertain, check the printed transaction ID before retrying. Run only one command using this wallet at a time. This command handles first registration, not redirecting existing DUST generation to a different wallet.

## Key handling

There are three different roles here:

1. **Wallet:** funds and submits the transaction.
2. **Token owner:** the commitment derived from the coin public key and owner nonce; authorizes OZ mint/burn operations.
3. **CMA:** controls contract maintenance and can change circuit verifier keys.

This deliberately reproduces ordinary software-key deployment, not a KMS/HSM integration. The supplied CMA private key exists in `.env` and application memory. After successful deployment, the standard SDK calls `privateStateProvider.setSigningKey(contractAddress, signingKey)` and stores an additional encrypted copy under `.private-state/`. It does this **even though this example supplies no contract private-state entry**.

The full deployment result also contains `deployTxData.private.signingKey`; some failure objects may contain private data. The script does not print either object. It prints only safe setup errors or an error class and the step that failed. Inspect unexpected errors locally without dumping them into shared logs. `.env`, `.private-state/` and the receipt are ignored by Git.

## Checked, 15 October 2026

- Full compilation of the exact OZ example with Compact 0.31.0; all seven circuit key pairs generated.
- Strict TypeScript checking of the deployment and wallet adapter.
- Offline constructor execution: owner initialized, expected metadata, no minted entries.
- Disposable standard-provider signing-key write/read and absence of the plaintext key in database files.
- Missing-configuration failure path, before any wallet connection or submission.
- Wallet setup with a fresh or partially filled `.env`, repeated runs preserving keys, private file permissions, and matching address output.
- Offline DUST registration tests: delayed funding and fee accumulation, NIGHT-only selection, confirmation, DUST accumulation, repeated runs, timeouts and submission failures. These use simulated wallet responses, not a live network.
- Real SDK shielded/DUST wallet construction using protocol Ledger objects; regression coverage for duplicate WASM instances.
- Network configuration migration, token handling, and clear HTTP failure messages using a local test server.

**No on-chain deployment or funded-wallet test has been performed.** Proof-server/network compatibility and finalization remain to be checked during the first controlled test deployment.

## Sources and attribution

- [OZ example at v0.3.0-rc.2](https://github.com/OpenZeppelin/compact-contracts/blob/v0.3.0-rc.2/contracts/src/token/examples/ZOwnableNativeShieldedTokenExample.compact), release commit `5cc68d3f391d2c8ec72ce5f908dd8f67817e4762`. OZ contract code is MIT licensed; see [LICENSE-OZ](../LICENSE-OZ).
- [SDK deployment](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/packages/contracts/src/deploy-contract.ts) and [post-success key storage](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/packages/contracts/src/submit-deploy-tx.ts).
- [Wallet construction](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/testkit-js/src/wallet/wallet-factory.ts) and [wallet adapter](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/testkit-js/src/wallet/midnight-wallet-provider.ts). `src/wallet.ts` adapts Midnight Foundation's Apache-2.0 code; see [LICENSE-MIDNIGHT](../LICENSE-MIDNIGHT).
- [Current network endpoints and Blockfrost migration](https://docs.midnight.network/guides/networks-and-environments), [proof-server version](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/env/preprod.env) and [container command](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/proof-server.yml).
- [Funding and first DUST registration](https://docs.midnight.network/guides/acquire-tokens) and [DUST registration rules](https://docs.midnight.network/guides/manage-dust). The implementation uses the pinned facade 4.0.1 API; it polls `estimateRegistration` because that version does not have the newer `waitForGeneratedDust` helper.

## Alternative compiler command

If you use the standalone Compact 0.31.0 compiler:

```sh
compactc contracts/Token.compact managed/token
```

Compile without `--skip-zk`: deployment needs the generated verifier keys.

## Network configuration

The example targets the Ledger 8 stack. Midnight retired its public Preprod endpoints on 9 October 2026; the old indexer was verified to return HTTP 410. `.env.example` now uses Blockfrost. Create a Midnight Preprod project at [blockfrost.io](https://blockfrost.io) and set `BLOCKFROST_PROJECT_ID` in `.env`.

Both registration and deployment use the same configuration helper. It translates the three exact retired Preprod defaults in an existing `.env` to the current endpoints at runtime and adds the project token. It does not rewrite `.env`, change the network, or replace custom endpoints. Setup adds a blank project-ID setting if it is missing. Your existing wallet and keys are preserved.

The scripts check indexer access before starting the wallet, report HTTP errors without dumping response bodies, and redact project tokens from SDK console messages. The RPC library can log a normal closure when it disconnects after loading metadata; that line alone does not establish a sync failure.

Preview is supported with matching endpoints and needs no Blockfrost token. Mainnet is rejected. Authenticated Preprod sync and funded transactions still need a live check using your own project ID.

## Re-running deployment

Each successful run creates another contract and replaces `deployment.json`. Keep earlier receipts if deploying more than once. If submission times out, reconcile the transaction before retrying.
