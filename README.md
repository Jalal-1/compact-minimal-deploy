# Compact minimal deployment

Deploy one instance of OpenZeppelin's `ZOwnableNativeShieldedTokenExample` on a **Ledger 8 test network**. The script stops after finalization and writing a public receipt. It makes no mint, burn or key-rotation calls.

## Read these three files

- `Token.compact` — OpenZeppelin's deployable example, unchanged except for its two package import paths.
- `deploy.ts` — five numbered steps: configuration/wallet, owner identity, providers, deployment, receipt.
- `wallet.ts` — the small Node wallet adapter required to pay fees and submit the transaction.

The package manifest, lockfile, TypeScript configuration and `.env.example` are the only setup files. Generated contract artifacts and dependencies are excluded from Git.

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
| Proof server | 8.0.3, matching the pinned SDK's preprod configuration |

Keep the lockfile and overrides: unconstrained wallet dependencies otherwise install a different Ledger 8 patch alongside the SDK's version.

## Step 1 — install and compile

Requires Node 22+, the [Compact toolchain manager](https://docs.midnight.network/relnotes/compact-tools), and Docker for the local proof server. The deployment also needs a test wallet with usable DUST.

```sh
git clone https://github.com/Jalal-1/compact-minimal-deploy.git
cd compact-minimal-deploy
npm ci
compact update 0.31.0
npm run compile
npm run check
```

This uses the Compact toolchain manager's `compact compile +0.31.0`. If you have the [standalone 0.31.0 compiler](https://github.com/midnightntwrk/compact/releases/tag/compactc-v0.31.0), the equivalent command is:

```sh
compactc Token.compact managed/token
```

Do not use `--skip-zk` before deployment: all seven exported circuits need generated verifier keys. Compiling their artifacts does not call those circuits on-chain.

## Step 2 — configure a test wallet and proof server

```sh
cp .env.example .env
chmod 600 .env
```

Fill the four secret values in `.env` locally:

| Value | Purpose |
| --- | --- |
| `WALLET_SEED` | Existing test wallet master seed, hex-encoded, 32 or 64 bytes. Account 0/key index 0 derivation. |
| `OWNER_NONCE` | Independent random 32-byte secret used by the OZ owner witness. Keep it for future owner calls. |
| `CMA_SIGNING_KEY` | A separate Ledger 8 signing key for contract maintenance. |
| `PRIVATE_STORAGE_PASSWORD` | Password encrypting the SDK's local signing-key store. |

The wallet must already have usable DUST on the selected network. Receiving test NIGHT alone is not sufficient unless the wallet's DUST-generation registration is complete. This example intentionally leaves wallet funding and registration out of the deployment flow.

Generate an owner nonce with `randomBytes(32).toString('hex')` from `node:crypto`. Generate the CMA key using `sampleSigningKey()` from `@midnight-ntwrk/compact-runtime`; do not substitute an arbitrary wallet seed. Store both values in `.env` before running. The password must be at least 16 characters, contain three of uppercase/lowercase/digits/symbols, and avoid runs of four repeated or sequential characters.

For example, these commands print new **test-only secrets to your local terminal** for copying into `.env`:

```sh
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
node --input-type=module -e "import {sampleSigningKey} from '@midnight-ntwrk/compact-runtime'; console.log(sampleSigningKey())"
```

Run a compatible proof server you control. The pinned SDK's container configuration uses:

```sh
docker run --rm -p 127.0.0.1:6300:6300 \
  ghcr.io/midnight-ntwrk/proof-server:8.0.3 'midnight-proof-server'
```

The default URLs in `.env.example` are the pinned SDK's preprod endpoints. Confirm that the target network still runs a compatible Ledger 8 stack before submitting. Preview is also allowed with matching Preview endpoints; mainnet is rejected by this example.

## Step 3 — deploy

```sh
npm run deploy
```

The key call in `deploy.ts` is:

```ts
const deployed = await deployContract(providers, {
  compiledContract,
  signingKey, // CMA, separate from the token owner
  args: [ownerId, instanceSalt, tokenDomain,
         'Example token', 'DEMO', 2n],
});
```

The script uses the wallet's shielded coin public key and `OWNER_NONCE` to compute `ownerId` through OZ's own pure circuit. A fresh public `instanceSalt` is generated per deployment. The zero token domain is valid because token colour also incorporates the contract address. The example metadata uses two decimals; this is a demonstration choice.

`deployContract` constructs the deployment, runs the SDK proof/balance/submission flow, and waits for the indexer to report success. It then writes `deployment.json` with **only** network ID, contract address, transaction ID and the CMA public key.

Each successful rerun creates another contract and replaces that receipt. After a timeout or uncertain submission, check the submitted transaction before retrying. Keep previous receipts if deploying multiple instances.

## The first key-handling point to inspect

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

**No on-chain deployment or funded-wallet test has been performed.** Proof-server/network compatibility and finalization remain to be checked during the first controlled test deployment.

## Sources and attribution

- [OZ example at v0.3.0-rc.2](https://github.com/OpenZeppelin/compact-contracts/blob/v0.3.0-rc.2/contracts/src/token/examples/ZOwnableNativeShieldedTokenExample.compact), release commit `5cc68d3f391d2c8ec72ce5f908dd8f67817e4762`. OZ contract code is MIT licensed; see `LICENSE-OZ`.
- [SDK deployment](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/packages/contracts/src/deploy-contract.ts) and [post-success key storage](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/packages/contracts/src/submit-deploy-tx.ts).
- [Wallet construction](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/testkit-js/src/wallet/wallet-factory.ts) and [wallet adapter](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/testkit-js/src/wallet/midnight-wallet-provider.ts). `wallet.ts` adapts Midnight Foundation's Apache-2.0 code; see `LICENSE-MIDNIGHT`.
- [Preprod endpoints](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/testkit-js/src/test-environment/test-environments/preprod-test-environment.ts), [proof-server version](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/env/preprod.env) and [container command](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/testkit-js/proof-server.yml).
