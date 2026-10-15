export class SetupError extends Error {}

export interface WalletOptions {
  seedHex: string;
  networkId: 'preprod' | 'preview';
  indexerHttpUrl: string;
  indexerWsUrl: string;
  nodeWsUrl: string;
  proofServerUrl: string;
  timeoutMs?: number;
}

export const endpoints = {
  preprod: {
    INDEXER_HTTP_URL: 'https://midnight-preprod.blockfrost.io/api/v0',
    INDEXER_WS_URL: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    NODE_WS_URL: 'wss://rpc.midnight-preprod.blockfrost.io',
  },
  preview: {
    INDEXER_HTTP_URL: 'https://indexer.preview.midnight.network/api/v4/graphql',
    INDEXER_WS_URL: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    NODE_WS_URL: 'wss://rpc.preview.midnight.network',
  },
};

// Accept an existing .env without rewriting its seed, keys or custom endpoints.
const retiredPreprod: Record<string, string> = {
  'https://indexer.preprod.midnight.network/api/v4/graphql': endpoints.preprod.INDEXER_HTTP_URL,
  'wss://indexer.preprod.midnight.network/api/v4/graphql/ws': endpoints.preprod.INDEXER_WS_URL,
  'wss://rpc.preprod.midnight.network': endpoints.preprod.NODE_WS_URL,
};

export function readWalletOptions(env: NodeJS.ProcessEnv = process.env): WalletOptions {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new SetupError(`Set ${name} in .env; run npm run setup first.`);
    return value;
  };
  const networkId = required('NETWORK_ID');
  if (networkId !== 'preprod' && networkId !== 'preview') {
    throw new SetupError('This example supports preprod or preview only.');
  }
  const seedHex = required('WALLET_SEED');
  if (!/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(seedHex)) {
    throw new SetupError('WALLET_SEED must be 32 or 64 bytes of hexadecimal.');
  }
  const endpoint = (name: string, protocols: string[]) => {
    let value = required(name);
    if (networkId === 'preprod') value = retiredPreprod[value.replace(/\/$/, '')] ?? value;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new SetupError(`${name} is not a valid URL.`); }
    if (!protocols.includes(url.protocol)) throw new SetupError(`Check the protocol in ${name}.`);
    if (['midnight-preprod.blockfrost.io', 'rpc.midnight-preprod.blockfrost.io'].includes(url.hostname)) {
      if (networkId !== 'preprod') throw new SetupError(`${name} is a Preprod endpoint; check NETWORK_ID.`);
      const token = env.BLOCKFROST_PROJECT_ID?.trim() || url.searchParams.get('project_id');
      if (!token) {
        throw new SetupError('Set BLOCKFROST_PROJECT_ID in .env to your Midnight Preprod project ID from blockfrost.io. The old public Preprod endpoints have retired.');
      }
      url.searchParams.set('project_id', token);
    }
    return url.toString();
  };
  return {
    networkId, seedHex,
    indexerHttpUrl: endpoint('INDEXER_HTTP_URL', ['http:', 'https:']),
    indexerWsUrl: endpoint('INDEXER_WS_URL', ['ws:', 'wss:']),
    nodeWsUrl: endpoint('NODE_WS_URL', ['ws:', 'wss:']),
    proofServerUrl: endpoint('PROOF_SERVER_URL', ['http:', 'https:']),
  };
}

export async function checkIndexer(url: string) {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? 'Check BLOCKFROST_PROJECT_ID and that the project is for Midnight Preprod.'
        : response.status === 410 ? 'This endpoint has retired. Update the project and its network configuration.'
        : 'Check INDEXER_HTTP_URL and your provider availability or quota.';
      throw new SetupError(`Indexer returned HTTP ${response.status}. ${hint}`);
    }
    const result = await response.json() as { data?: { block?: { height?: number } }; errors?: unknown[] };
    if (result.errors?.length || result.data?.block?.height == null) {
      throw new SetupError('The indexer did not return a block height. Check INDEXER_HTTP_URL and the provider API version.');
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('Could not reach the indexer within 15 seconds. Check INDEXER_HTTP_URL, DNS and your connection.');
  }
}
