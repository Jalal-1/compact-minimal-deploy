// SPDX-License-Identifier: Apache-2.0
// Adapted from midnight-js, Copyright (C) 2025-2026 Midnight Foundation.
// Ledger 8 adapter, based on midnight-js v4.1.1's wallet-factory.ts and
// midnight-wallet-provider.ts. No seed generation, logging, or automatic funding.
import {
  createKeystore, DustWallet, HDWallet, InMemoryTransactionHistoryStorage,
  mergeWalletEntries, NetworkId, PublicKey, Roles, ShieldedWallet,
  UnshieldedWallet, WalletEntrySchema, WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import {
  DustSecretKey, LedgerParameters, unshieldedToken, ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { filter, firstValueFrom, timeout } from 'rxjs';
import { registerDust } from './dust.js';
import { checkIndexer, SetupError, type WalletOptions } from './config.js';

// Shared by the offline address command and the deployment wallet.
export function deriveWalletKeys(seedHex: string, network: WalletOptions['networkId']) {
  if (network !== 'preprod' && network !== 'preview') {
    throw new Error('This example supports only preprod and preview.');
  }
  if (!/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(seedHex)) {
    throw new Error('Wallet seed must be 32 or 64 bytes encoded as hexadecimal.');
  }
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid wallet seed.');
  const derive = (role: typeof Roles.Zswap | typeof Roles.NightExternal | typeof Roles.Dust) => {
    const result = hd.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
    if (result.type === 'keyOutOfBounds') throw new Error('Wallet key derivation failed.');
    return result.key;
  };
  const shieldedSeed = derive(Roles.Zswap);
  const dustSeed = derive(Roles.Dust);
  const networkId = network === 'preprod'
    ? NetworkId.NetworkId.PreProd : NetworkId.NetworkId.Preview;
  const keystore = createKeystore(derive(Roles.NightExternal), networkId);
  return { shieldedSeed, dustSeed, networkId, keystore };
}

export async function buildWallet(options: WalletOptions) {
  await checkIndexer(options.indexerHttpUrl);
  const { shieldedSeed, dustSeed, networkId, keystore } = deriveWalletKeys(options.seedHex, options.networkId);
  const zswapSecretKeys = ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = DustSecretKey.fromSeed(dustSeed);
  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: options.indexerHttpUrl,
      indexerWsUrl: options.indexerWsUrl,
    },
    relayURL: new URL(options.nodeWsUrl),
    provingServerUrl: new URL(options.proofServerUrl),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { feeBlocksMargin: 5 },
  };
  // Construct locally before opening the facade's RPC connections. If a
  // constructor fails, close any wallets that were already created.
  const parts: { stop(): Promise<void> }[] = [];
  let wallet: WalletFacade;
  try {
    const dust = await DustWallet(configuration).startWithSecretKey(dustSecretKey, LedgerParameters.initialParameters().dust);
    parts.push(dust);
    const shielded = await ShieldedWallet(configuration).startWithSecretKeys(zswapSecretKeys);
    parts.push(shielded);
    const unshielded = await UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore));
    parts.push(unshielded);
    wallet = await WalletFacade.init({
      configuration, shielded: () => shielded, unshielded: () => unshielded, dust: () => dust,
    });
  } catch (error) {
    await Promise.allSettled(parts.map(part => part.stop()));
    const mismatch = error instanceof Error && error.message.startsWith('expected instance of ');
    throw new SetupError(mismatch
      ? 'Incompatible Ledger objects: run git pull and npm ci to install the single Ledger copy in the lockfile.'
      : 'Wallet initialization failed. Run npm ci and check the endpoint configuration.');
  }
  const sync = () => firstValueFrom(wallet.state().pipe(
    filter(state => state.shielded.state.progress.isStrictlyComplete()
      && state.unshielded.progress.isStrictlyComplete()
      && state.dust.state.progress.isStrictlyComplete()),
    timeout({ first: options.timeoutMs ?? 180_000 }),
  ));
  try {
    await wallet.start(zswapSecretKeys, dustSecretKey);
    await sync();
  } catch (error) {
    await wallet.stop().catch(() => {});
    throw new SetupError(error instanceof Error && error.name === 'TimeoutError'
      ? 'Wallet sync timed out. Check the indexer WebSocket URL, provider access and network status, then retry.'
      : 'Wallet sync failed. Check the indexer WebSocket URL and provider credentials.');
  }

  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => zswapSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => zswapSecretKeys.encryptionPublicKey,
    balanceTx: async (tx, ttl = new Date(Date.now() + 60 * 60 * 1000)) => {
      const recipe = await wallet.balanceUnboundTransaction(tx, {
        shieldedSecretKeys: zswapSecretKeys, dustSecretKey,
      }, { ttl });
      const signed = await wallet.signRecipe(recipe, payload => keystore.signData(payload));
      return wallet.finalizeRecipe(signed);
    },
  };
  const midnightProvider: MidnightProvider = {
    submitTx: tx => wallet.submitTransaction(tx),
  };

  return {
    walletProvider,
    midnightProvider,
    address: keystore.getBech32Address().asString(),
    coinPublicKey: zswapSecretKeys.coinPublicKey,
    encryptionPublicKey: zswapSecretKeys.encryptionPublicKey,
    sync,
    registerDust: () => registerDust(wallet, keystore, sync),
    balances: async () => {
      const state = await sync();
      return {
        night: state.unshielded.balances[unshieldedToken().raw] ?? 0n,
        dust: state.dust.balance(new Date()),
      };
    },
    close: () => wallet.stop(),
  };
}
