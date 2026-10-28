import 'server-only';
import type { ComputerProvider } from '@clutchbox/computer';
import { e2bComputerProvider, TEMPLATE } from '@clutchbox/e2b';
import type { ServerConfig } from './config';
import { fakeComputerProvider } from './fake-computer-provider';

// The deployment's computers when no provider account hook supplies them: E2B on E2B_API_KEY's team (the E2B SDK
// reads the key from the same environment), from E2B_COMPUTER_TEMPLATE or the default template. Without a key,
// development uses the in-memory fake (one process only), and production cannot run.
export function providerFromConfig(config: ServerConfig): ComputerProvider {
  if (config.E2B_API_KEY) return e2bComputerProvider(config.E2B_COMPUTER_TEMPLATE ?? TEMPLATE);
  if (config.APP_ENV === 'production') throw new Error('E2B_API_KEY is required.');
  return fakeComputerProvider().provider;
}
