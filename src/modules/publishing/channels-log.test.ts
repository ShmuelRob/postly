import { afterEach, expect, it } from 'vitest';
import { setLogSink } from '../../shared/logger.js';
import { logChannelDisconnected } from './channels.js';

afterEach(() => setLogSink(undefined));

// The channel-disconnected alert (docs/observability.md, "Log-based metrics") counts exactly this line.
it('logs a disconnected channel as the structured "channel disconnected" warning the alert counts', () => {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  logChannelDisconnected({ businessId: 'b1', channelId: 'c1', network: 'instagram', providerStatus: 'disconnected' });
  expect(lines).toHaveLength(1);
  const line = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(line).toMatchObject({ severity: 'WARNING', message: 'channel disconnected', network: 'instagram', channelId: 'c1', providerStatus: 'disconnected' });
  expect(line['logging.googleapis.com/labels']).toMatchObject({ businessId: 'b1' });
});
