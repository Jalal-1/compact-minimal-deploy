import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DustWallet, NoOpTransactionHistoryStorage, ShieldedWallet } from '@midnight-ntwrk/wallet-sdk';
import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { checkIndexer, endpoints, readWalletOptions, SetupError } from '../src/config.js';
import { protectEndpointLogs } from '../src/logging.js';

const env = {
  NETWORK_ID: 'preprod', WALLET_SEED: '01'.repeat(32),
  ...endpoints.preprod, PROOF_SERVER_URL: 'http://127.0.0.1:6300',
  BLOCKFROST_PROJECT_ID: 'disposable-project-token',
};

test('real SDK wallets accept the protocol Ledger objects (duplicate WASM regression)', async t => {
  const configuration = {
    networkId: 'preprod',
    indexerClientConnection: { indexerHttpUrl: 'http://127.0.0.1:1', indexerWsUrl: 'ws://127.0.0.1:1' },
    relayURL: new URL('ws://127.0.0.1:1'), provingServerUrl: new URL('http://127.0.0.1:1'),
    costParameters: { feeBlocksMargin: 5 },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };
  const seed = new Uint8Array(32).fill(1);
  // Before the lockfile fix, the first call threw "expected instance of DustParameters".
  const dust = await DustWallet(configuration).startWithSecretKey(
    DustSecretKey.fromSeed(seed), LedgerParameters.initialParameters().dust,
  );
  t.after(() => dust.stop());
  const shielded = await ShieldedWallet(configuration).startWithSecretKeys(ZswapSecretKeys.fromSeed(seed));
  t.after(() => shielded.stop());
});

test('old Preprod configuration resolves to authenticated endpoints without changing keys', () => {
  const existing = {
    ...env, INDEXER_HTTP_URL: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    INDEXER_WS_URL: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    NODE_WS_URL: 'wss://rpc.preprod.midnight.network/',
  };
  const original = { ...existing };
  const options = readWalletOptions(existing);
  assert.deepEqual(existing, original);
  assert.equal(options.seedHex, existing.WALLET_SEED);
  for (const url of [options.indexerHttpUrl, options.indexerWsUrl, options.nodeWsUrl]) {
    assert.ok(new URL(url).hostname.endsWith('.blockfrost.io'));
    assert.equal(new URL(url).searchParams.get('project_id'), env.BLOCKFROST_PROJECT_ID);
  }
  assert.equal(new URL(options.proofServerUrl).search, '');
});

test('a missing Blockfrost token fails before opening any connection', () => {
  assert.throws(() => readWalletOptions({ ...env, BLOCKFROST_PROJECT_ID: '' }), /Set BLOCKFROST_PROJECT_ID/);
});

test('custom providers and Preview do not receive a Blockfrost token', () => {
  const custom = readWalletOptions({ ...env, ...endpoints.preview, NETWORK_ID: 'preview' });
  for (const url of [custom.indexerHttpUrl, custom.indexerWsUrl, custom.nodeWsUrl]) {
    assert.equal(new URL(url).search, '');
  }
  const own = readWalletOptions({
    ...env, INDEXER_HTTP_URL: 'https://indexer.example/api',
    INDEXER_WS_URL: 'wss://indexer.example/ws', NODE_WS_URL: 'wss://rpc.example',
  });
  assert.equal(own.indexerHttpUrl, 'https://indexer.example/api');
  assert.equal(new URL(own.nodeWsUrl).search, '');
});

test('indexer failures have actionable messages without echoing credentials or response bodies', async t => {
  let status = 200;
  let body: object = { data: { block: { height: 42 } } };
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/?project_id=secret-test-token`;
  await checkIndexer(url);
  for (const code of [403, 410, 429]) {
    status = code;
    body = { error: 'private-response-data' };
    await assert.rejects(checkIndexer(url), error => {
      assert.ok(error instanceof SetupError);
      assert.match(error.message, new RegExp(`HTTP ${code}`));
      assert.doesNotMatch(error.message, /secret-test-token|private-response-data/);
      return true;
    });
  }
  status = 200;
  body = { errors: [{ message: 'private-response-data' }] };
  await assert.rejects(checkIndexer(url), /did not return a block height/);
});

test('SDK console messages redact project tokens, including Error objects', () => {
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const messages: string[] = [];
  try {
    console.error = (...args: unknown[]) => { messages.push(String(args[0])); };
    const token = 'private-test-token';
    const url = `wss://rpc.midnight-preprod.blockfrost.io?project_id=${token}`;
    protectEndpointLogs([url]);
    console.error('RPC disconnected from %s', url);
    console.error(new Error(`connection failed: ${url}`));
    assert.equal(messages.length, 2);
    assert.ok(messages.every(message => !message.includes(token) && message.includes('[redacted]')));
  } finally { Object.assign(console, original); }
});
