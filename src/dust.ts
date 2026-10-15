import type { FacadeState, UnshieldedKeystore, WalletFacade } from '@midnight-ntwrk/wallet-sdk';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { exhaustMap, filter, firstValueFrom, from, throwError, timeout, timer } from 'rxjs';

export class DustRegistrationError extends Error {}

type RegistrationWallet = Pick<WalletFacade,
  'estimateRegistration' | 'registerNightUtxosForDustGeneration' |
  'finalizeRecipe' | 'submitTransaction' | 'queryTxHistoryByHash'>;
type RegistrationState = {
  unshielded: Pick<FacadeState['unshielded'], 'availableCoins'>;
  dust: Pick<FacadeState['dust'], 'balance'>;
};

export async function registerDust(
  wallet: RegistrationWallet,
  keystore: Pick<UnshieldedKeystore, 'getPublicKey' | 'signData'>,
  sync: () => Promise<RegistrationState>,
  { timeoutMs = 600_000, pollMs = 5_000, log = console.log } = {},
) {
  const waitFor = <T>(check: () => Promise<T | undefined>, message: string) => firstValueFrom(
    timer(0, pollMs).pipe(
      exhaustMap(check),
      filter((value): value is T => value !== undefined),
      timeout({ first: timeoutMs, with: () => throwError(() => new DustRegistrationError(message)) }),
    ),
  );
  const nightCoins = (state: RegistrationState) => state.unshielded.availableCoins.filter(
    coin => coin.utxo.type === unshieldedToken().raw && coin.utxo.value > 0n,
  );

  log('Waiting for faucet NIGHT to arrive...');
  await waitFor(async () => nightCoins(await sync()).length ? true : undefined,
    'No available NIGHT arrived. Fund the printed unshielded address at the faucet, then run this command again.');

  log('Checking registration; waiting for NIGHT to cover the registration fee...');
  // Facade 4.0.1 has no waitForGeneratedDust helper. Re-estimate as the coins age.
  const unregistered = await waitFor(async () => {
    const night = nightCoins(await sync());
    if (night.length === 0) return undefined;
    const coins = night.filter(coin => !coin.meta.registeredForDustGeneration);
    if (coins.length === 0) return coins;
    const { fee, dustGenerationEstimations } = await wallet.estimateRegistration(coins);
    // Only the SDK's guaranteed inputs can pay this first registration's fee.
    const generated = dustGenerationEstimations.reduce((sum, coin) => sum + coin.dust.generatedNow, 0n);
    return generated >= fee ? coins : undefined;
  }, 'NIGHT could not yet cover the registration fee. Wait longer or request more faucet NIGHT, then try again.');

  if (unregistered.length > 0) {
    log('Signing and preparing the DUST registration...');
    // The SDK signs both the NIGHT inputs and registration. Its default receiver
    // is this wallet's DUST address; no wallet secrets leave the process.
    const recipe = await wallet.registerNightUtxosForDustGeneration(
      unregistered, keystore.getPublicKey(), payload => keystore.signData(payload),
    );
    const tx = await wallet.finalizeRecipe(recipe);
    const txId = tx.identifiers().at(-1);
    const txHash = tx.transactionHash();
    log(`Submitting registration. Transaction ID: ${txId}`);
    try {
      await firstValueFrom(from(wallet.submitTransaction(tx)).pipe(timeout({ first: timeoutMs })));
    } catch {
      throw new DustRegistrationError(`Submission was not confirmed. Check transaction ${txId} before retrying.`);
    }
    // Node finalization alone does not establish successful ledger execution.
    await waitFor(async () => {
      const entry = await wallet.queryTxHistoryByHash(txHash);
      if (!entry) return undefined;
      if (entry.status !== 'SUCCESS') {
        throw new DustRegistrationError(`Registration status: ${entry.status}. Check transaction ${txId} before retrying.`);
      }
      return true;
    }, `The indexer has not confirmed registration. Check transaction ${txId} before retrying.`);
    log('DUST registration confirmed.');
  } else {
    log('NIGHT is already registered; no registration transaction needed.');
  }

  log('Waiting for a positive DUST balance...');
  return waitFor(async () => {
    const state = await sync();
    const dust = state.dust.balance(new Date());
    return nightCoins(state).some(coin => coin.meta.registeredForDustGeneration) && dust > 0n
      ? dust : undefined;
  }, 'DUST has not appeared in this wallet yet. Wait and run this command again; existing registrations are preserved.');
}
