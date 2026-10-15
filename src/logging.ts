import { format } from 'node:util';

// Polkadot's own RPC logs include full endpoint URLs, including query tokens.
export function protectEndpointLogs(urls: string[]) {
  const tokens = urls.flatMap(value => {
    const token = new URL(value).searchParams.get('project_id');
    return token ? [token, encodeURIComponent(token)] : [];
  });
  if (tokens.length === 0) return;
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const output = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      let message = format(...args).replace(/([?&]project_id=)[^\s&#'"<>]+/g, '$1[redacted]');
      for (const token of tokens) message = message.replaceAll(token, '[redacted]');
      output(message);
    };
  }
}
