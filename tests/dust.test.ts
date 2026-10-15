import assert from 'node:assert/strict';
import test from 'node:test';
import { unshieldedToken, verifySignature } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { registerDust, DustRegistrationError } from '../src/dust.js';
import { deriveWalletKeys } from '../src/wallet.js';

type Wallet = Parameters<typeof registerDust>[0];
type State = Awaited<ReturnType<Parameters<typeof registerDust>[2]>>;
type Coin = State['unshielded']['availableCoins'][number];
const { keystore } = deriveWalletKeys('01'.repeat(32), 'preprod'); // Public, disposable test seed.
const coin = (registered = false, type = unshieldedToken().raw): Coin => ({
  utxo: { type, value: 1_000_000_000n, owner: keystore.getAddress(), intentHash: '02'.repeat(32), outputNo: 0 },
  meta: { registeredForDustGeneration: registered, ctime: new Date(0) },
});

function fixture() {
  const h = {
    coins: [coin()] as readonly Coin[], dust: 1n, generated: 100n,
    estimates: 0, submissions: 0, historyReads: 0, logs: [] as string[],
    registered: [] as readonly Coin[],
    status: 'SUCCESS' as 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS',
  };
  const tx = {
    identifiers: () => ['registration-id'], transactionHash: () => 'registration-hash',
  } as Awaited<ReturnType<Wallet['finalizeRecipe']>>;
  const recipe = { type: 'UNPROVEN_TRANSACTION' } as Awaited<ReturnType<Wallet['registerNightUtxosForDustGeneration']>>;
  const wallet: Wallet = {
    estimateRegistration: async coins => {
      h.estimates++;
      return { fee: 100n, dustGenerationEstimations: [{
        utxo: { ...coins[0].utxo, ...coins[0].meta },
        dust: { generatedNow: h.generated, maxCap: 1_000n, maxCapReachedAt: new Date(), rate: 1n, dtime: undefined },
      }] };
    },
    registerNightUtxosForDustGeneration: async (coins, publicKey, sign, receiver) => {
      h.registered = coins;
      assert.equal(publicKey, keystore.getPublicKey());
      assert.equal(receiver, undefined, 'the SDK must use this wallet\'s own DUST address');
      const payload = new Uint8Array([1, 2, 3]);
      assert.ok(verifySignature(publicKey, payload, sign(payload)), 'the wallet key must sign the registration');
      return recipe;
    },
    finalizeRecipe: async supplied => {
      assert.equal(supplied, recipe);
      return tx;
    },
    submitTransaction: async supplied => {
      assert.equal(supplied, tx);
      h.submissions++;
      h.coins = [coin(true)];
      return 'registration-id';
    },
    queryTxHistoryByHash: async hash => {
      assert.equal(hash, 'registration-hash');
      h.historyReads++;
      return { hash, protocolVersion: 1, status: h.status };
    },
  };
  const sync = async (): Promise<State> => ({
    unshielded: { availableCoins: h.coins }, dust: { balance: () => h.dust },
  });
  const options = { pollMs: 1, timeoutMs: 200, log: (message: string) => h.logs.push(message) };
  return { h, wallet, sync, options };
}

test('waits for faucet funds, fee maturity, indexed success and DUST; reruns do not submit again', async () => {
  const { h, wallet, sync, options } = fixture();
  const unregistered = coin();
  h.coins = [unregistered, coin(true), coin(false, 'ff'.repeat(32)), { ...coin(), utxo: { ...coin().utxo, value: 0n } }];
  let reads = 0;
  const delayedSync = async () => {
    reads++;
    const state = await sync();
    if (reads <= 2) return { ...state, unshielded: { availableCoins: [] } };
    h.generated = reads >= 5 ? 100n : 0n;
    h.dust = reads >= 7 ? 1n : 0n;
    return state;
  };
  const history = wallet.queryTxHistoryByHash;
  let pendingHistory = true;
  wallet.queryTxHistoryByHash = async hash => {
    if (pendingHistory) { pendingHistory = false; return undefined; }
    return history(hash);
  };
  assert.equal(await registerDust(wallet, keystore, delayedSync, options), 1n);
  assert.deepEqual(h.registered, [unregistered], 'only positive unregistered NIGHT is signed');
  assert.ok(h.estimates >= 2, 'must wait for the fee, not submit immediately');
  assert.equal(h.submissions, 1);
  assert.ok(reads >= 7, 'must wait for DUST after confirmation');
  assert.equal(await registerDust(wallet, keystore, sync, options), 1n);
  assert.equal(h.submissions, 1, 'already registered coins must not trigger another transaction');
});

test('an unfunded wallet times out without signing or submitting', async () => {
  const { h, wallet, sync, options } = fixture();
  h.coins = [];
  await assert.rejects(registerDust(wallet, keystore, sync, { ...options, timeoutMs: 20 }), /No available NIGHT/);
  assert.equal(h.estimates, 0);
  assert.equal(h.registered.length, 0);
  assert.equal(h.submissions, 0);
});

test('insufficient registration fee never reaches signing or submission', async () => {
  const { h, wallet, sync, options } = fixture();
  h.generated = 99n;
  await assert.rejects(registerDust(wallet, keystore, sync, { ...options, timeoutMs: 20 }), /cover the registration fee/);
  assert.equal(h.registered.length, 0);
  assert.equal(h.submissions, 0);
});

test('already registered NIGHT with zero DUST waits without resubmitting', async () => {
  const { h, wallet, sync, options } = fixture();
  h.coins = [coin(true)];
  h.dust = 0n;
  await assert.rejects(registerDust(wallet, keystore, sync, { ...options, timeoutMs: 20 }), /DUST has not appeared/);
  assert.equal(h.estimates, 0);
  assert.equal(h.submissions, 0);
});

for (const status of ['FAILURE', 'PARTIAL_SUCCESS'] as const) {
  test(`finalized registration with ${status} is not reported as successful`, async () => {
    const { h, wallet, sync, options } = fixture();
    h.status = status;
    await assert.rejects(registerDust(wallet, keystore, sync, options), new RegExp(status));
    assert.equal(h.submissions, 1);
    assert.ok(!h.logs.includes('DUST registration confirmed.'));
  });
}

test('an uncertain submission is not retried and hides the underlying error', async () => {
  const { h, wallet, sync, options } = fixture();
  wallet.submitTransaction = async () => { h.submissions++; throw new Error('private SDK error data'); };
  await assert.rejects(registerDust(wallet, keystore, sync, options), error => {
    assert.ok(error instanceof DustRegistrationError);
    assert.match(error.message, /Check transaction registration-id before retrying/);
    assert.doesNotMatch(error.message, /private SDK error data/);
    return true;
  });
  assert.equal(h.submissions, 1);
});

test('a missing indexer confirmation times out even when DUST is positive', async () => {
  const { h, wallet, sync, options } = fixture();
  wallet.queryTxHistoryByHash = async () => undefined;
  await assert.rejects(registerDust(wallet, keystore, sync, { ...options, timeoutMs: 20 }), /indexer has not confirmed/);
  assert.equal(h.submissions, 1);
});
