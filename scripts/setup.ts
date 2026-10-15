import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { sampleSigningKey, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { deriveWalletKeys } from '../src/wallet.js';

class SetupError extends Error {}
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

function newPassword(): string {
  for (;;) {
    const password = randomBytes(32).toString('base64url') + 'Aa1!';
    try { validatePassword(password); return password; }
    catch { /* Try again if random characters form a disallowed sequence. */ }
  }
}

async function main() {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  let original: string | undefined;
  try { original = await readFile(envPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let content = original ?? template;
  const values = parseEnv(content);
  const network = values.NETWORK_ID || 'preprod';
  if (network !== 'preprod' && network !== 'preview') {
    throw new SetupError('NETWORK_ID must be preprod or preview.');
  }
  const fill = (key: string, value: string) => {
    if (values[key]) return;
    const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'gm');
    const matches = [...content.matchAll(line)];
    if (matches.length > 1) throw new SetupError(`Remove duplicate ${key} entries from .env first.`);
    const setting = `${key}=${JSON.stringify(value)}`;
    content = matches.length ? content.replace(line, setting) : content.trimEnd() + '\n' + setting + '\n';
    values[key] = value;
  };
  for (const [key, value] of Object.entries(parseEnv(template))) {
    if (value) fill(key, network === 'preview' ? value.replaceAll('.preprod.', '.preview.') : value);
  }
  if (!values.WALLET_SEED) fill('WALLET_SEED', randomBytes(32).toString('hex'));
  if (!values.OWNER_NONCE) fill('OWNER_NONCE', randomBytes(32).toString('hex'));
  if (!values.CMA_SIGNING_KEY) fill('CMA_SIGNING_KEY', sampleSigningKey());
  if (!values.PRIVATE_STORAGE_PASSWORD) fill('PRIVATE_STORAGE_PASSWORD', newPassword());

  // Validate before writing, without printing any secret values.
  const { WALLET_SEED: seed = '', OWNER_NONCE: nonce = '',
    CMA_SIGNING_KEY: signingKey = '', PRIVATE_STORAGE_PASSWORD: password = '' } = values;
  let address: string;
  try { address = deriveWalletKeys(seed, network).keystore.getBech32Address().asString(); }
  catch { throw new SetupError('WALLET_SEED must be a valid 32- or 64-byte hexadecimal seed.'); }
  if (!/^[0-9a-fA-F]{64}$/.test(nonce)) throw new SetupError('OWNER_NONCE must be 32 bytes of hexadecimal.');
  try { signatureVerifyingKey(signingKey); }
  catch { throw new SetupError('CMA_SIGNING_KEY is invalid; your .env has been left unchanged.'); }
  try { validatePassword(password); }
  catch { throw new SetupError('PRIVATE_STORAGE_PASSWORD does not meet the SDK password policy. See docs/deployment-notes.md.'); }

  if (content !== original) {
    const temporary = `${envPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, envPath);
    } finally { await rm(temporary, { force: true }); }
  }
  await chmod(envPath, 0o600);
  console.log('Test wallet ready. Secrets saved in .env; existing values preserved.');
  console.log('Unshielded address:', address);
}

main().catch(error => {
  const detail = error instanceof SetupError ? error.message : 'Could not safely write .env. Check file permissions.';
  console.error(`Setup stopped: ${detail}`);
  process.exitCode = 1;
});
