import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import * as Token from '../managed/token/contract/index.js';
import { buildWallet } from './wallet.js';
import { readWalletOptions, SetupError } from './config.js';
import { protectEndpointLogs } from './logging.js';

type Circuit = keyof Token.ProvableCircuits<undefined>;
const localPath = (path: string) => fileURLToPath(new URL(path, new URL('../', import.meta.url)));
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new SetupError(`Set ${name} in .env.`);
  return value;
};
let step = 'configuration';

async function main() {
  // 1. Read the test-network configuration and three separate secrets.
  const options = readWalletOptions();
  const { networkId, indexerHttpUrl, indexerWsUrl, proofServerUrl } = options;
  protectEndpointLogs([indexerHttpUrl, indexerWsUrl, options.nodeWsUrl]);
  const nonceHex = required('OWNER_NONCE');
  if (!/^[0-9a-fA-F]{64}$/.test(nonceHex)) throw new SetupError('OWNER_NONCE must be 32 bytes of hex.');
  const ownerNonce = Buffer.from(nonceHex, 'hex');
  const signingKey = required('CMA_SIGNING_KEY');
  const cmaPublicKey = signatureVerifyingKey(signingKey);
  const password = required('PRIVATE_STORAGE_PASSWORD');
  try { validatePassword(password); }
  catch { throw new SetupError('PRIVATE_STORAGE_PASSWORD does not meet the SDK strength policy; see README.'); }
  setNetworkId(networkId);
  const assets = localPath('./managed/token');
  // A --skip-zk compile is insufficient for deployment: verifier keys are needed.
  for (const name of ['mint', 'burn', 'transferOwnership', 'renounceOwnership', 'owner', 'totalMinted', 'tokenColor']) {
    await access(`${assets}/keys/${name}.verifier`);
  }

  step = 'wallet sync';
  console.log('1. Syncing the funded test wallet...');
  const wallet = await buildWallet(options);
  try {
    const balances = await wallet.balances();
    console.log('Fee-paying address:', wallet.address);
    if (balances.dust <= 0n) throw new SetupError('The wallet needs DUST. Fund it at the faucet, then run npm run register-dust.');

    // 2. Owner authorisation is separate from CMA contract maintenance.
    console.log('2. Preparing the OZ constructor arguments...');
    const ownerId = Token.pureCircuits._computeOwnerId({
      is_left: true,
      left: { bytes: Buffer.from(wallet.coinPublicKey, 'hex') },
      right: { bytes: new Uint8Array(32) },
    }, ownerNonce);
    const instanceSalt = randomBytes(32);
    const tokenDomain = new Uint8Array(32); // Token colour also depends on the contract address.
    const witnesses: Token.Witnesses<undefined> = { wit_secretNonce: () => [undefined, ownerNonce] };
    const compiledContract = CompiledContract.make<Token.Contract<undefined>>('Token', Token.Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(assets),
    );

    // 3. Use the standard providers, including the encrypted signing-key store.
    console.log('3. Configuring the standard SDK providers...');
    const zkConfigProvider = new NodeZkConfigProvider<Circuit>(assets);
    const privateStateProvider = levelPrivateStateProvider<string, undefined>({
      midnightDbName: localPath(`./.private-state/${networkId}`),
      accountId: wallet.coinPublicKey,
      privateStoragePasswordProvider: async () => password,
    });
    const providers = {
      privateStateProvider,
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
      walletProvider: wallet.walletProvider,
      midnightProvider: wallet.midnightProvider,
    };

    // 4. This is the deployment call to inspect. It submits and waits for finalization.
    step = 'deployment';
    console.log('4. Deploying; waiting for the indexer to report finalization...');
    const deployed = await deployContract(providers, {
      compiledContract,
      signingKey,
      args: [ownerId, instanceSalt, tokenDomain, 'Example token', 'DEMO', 2n],
    });

    // 5. Only public fields go into the receipt. The full result contains the CMA key.
    step = 'receipt';
    const { contractAddress, txId } = deployed.deployTxData.public;
    const receipt = { networkId, contractAddress, txId, cmaPublicKey };
    await writeFile(localPath('./deployment.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log('5. Deployment finalized. Public receipt:');
    console.log(receipt);
    console.log('CMA key saved by the SDK in the encrypted .private-state signing-key store.');
  } finally {
    await wallet.close();
  }
}

main().catch(error => {
  // SDK error objects can contain private transaction/key data; never dump them.
  const detail = error instanceof SetupError
    ? error.message : error instanceof Error ? error.name : 'UnknownError';
  console.error(`Stopped during ${step}: ${detail}`);
  process.exitCode = 1;
});
