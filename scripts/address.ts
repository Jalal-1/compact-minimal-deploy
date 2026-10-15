import { deriveWalletKeys } from '../src/wallet.js';

// Offline: show only the public address that belongs to WALLET_SEED.
try {
  const seed = process.env.WALLET_SEED;
  const network = process.env.NETWORK_ID;
  if (!seed) throw new Error('Set WALLET_SEED in .env.');
  if (network !== 'preprod' && network !== 'preview') {
    throw new Error('Set NETWORK_ID to preprod or preview in .env.');
  }
  const { keystore } = deriveWalletKeys(seed, network);
  console.log('Unshielded address:', keystore.getBech32Address().asString());
} catch {
  console.error('Check NETWORK_ID and WALLET_SEED in .env. The seed must be 32 or 64 bytes of hexadecimal.');
  process.exitCode = 1;
}
