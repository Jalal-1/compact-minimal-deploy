import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { DustRegistrationError } from '../src/dust.js';
import { buildWallet } from '../src/wallet.js';
import { readWalletOptions, SetupError } from '../src/config.js';
import { protectEndpointLogs } from '../src/logging.js';
let step = 'configuration';

async function main() {
  const options = readWalletOptions();
  protectEndpointLogs([options.indexerHttpUrl, options.indexerWsUrl, options.nodeWsUrl]);
  setNetworkId(options.networkId);
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
  const detail = error instanceof DustRegistrationError || error instanceof SetupError
    ? error.message : error instanceof Error ? error.name : 'UnknownError';
  console.error(`Stopped during ${step}: ${detail}`);
  process.exitCode = 1;
});
