import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { DustRegistrationError } from '../src/dust.js';
import { buildWallet } from '../src/wallet.js';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new DustRegistrationError(`Set ${name} in .env; run npm run setup first.`);
  return value;
};
let step = 'configuration';

async function main() {
  const networkId = required('NETWORK_ID');
  if (networkId !== 'preprod' && networkId !== 'preview') {
    throw new DustRegistrationError('This example supports preprod or preview only.');
  }
  const options = {
    networkId,
    seedHex: required('WALLET_SEED'),
    indexerHttpUrl: required('INDEXER_HTTP_URL'),
    indexerWsUrl: required('INDEXER_WS_URL'),
    nodeWsUrl: required('NODE_WS_URL'),
    proofServerUrl: required('PROOF_SERVER_URL'),
  } as const;
  setNetworkId(networkId);
  step = 'wallet sync';
  console.log('Syncing the test wallet...');
  const wallet = await buildWallet(options);
  try {
    console.log('Unshielded address:', wallet.address);
    step = 'DUST registration';
    const dust = await wallet.registerDust();
    console.log(`DUST is accumulating. Current balance: ${dust} SPECK (1 DUST = 10^15 SPECK).`);
    console.log('Next: npm run deploy. If its fee exceeds the balance, allow more time for DUST to accumulate.');
  } finally {
    await wallet.close();
  }
}

main().catch(error => {
  // SDK errors can contain private data. Print only our safe messages or a class name.
  const detail = error instanceof DustRegistrationError
    ? error.message : error instanceof Error ? error.name : 'UnknownError';
  console.error(`Stopped during ${step}: ${detail}`);
  process.exitCode = 1;
});
