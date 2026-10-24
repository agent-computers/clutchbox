import type { ExchangeResponse, Response } from '@agent-computers/capture';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Button } from '../../src/ui/components/button';

const closeAfterMs = 1_500;

// Back to the tab the connect click came from, then closes this one.
async function returnTo(opener: number | undefined) {
  if (opener !== undefined) {
    try {
      const tab = await chrome.tabs.get(opener);
      await chrome.tabs.update(opener, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // The opener closed; this tab still closes.
    }
  }
  window.close();
  // Chrome may refuse window.close() after a redirect chain.
  const self = await chrome.tabs.getCurrent();
  if (self?.id !== undefined) await chrome.tabs.remove(self.id);
}

// The worker exchanges the code; this page only shows the outcome.
export function App({ url }: { url: string }) {
  const exchange = useMutation({
    mutationFn: async () => {
      const response: Response | ExchangeResponse = await chrome.runtime.sendMessage({ type: 'exchange', url });
      if (!response.ok) throw new Error(response.error);
      if (!('email' in response)) throw new Error('invalid_request');
      return response;
    },
    onSuccess: ({ opener }) => {
      setTimeout(() => void returnTo(opener), closeAfterMs);
    },
  });
  // Once, even under StrictMode's double effects: the code is single-use.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    exchange.mutate();
  }, [exchange]);

  const error = exchange.error?.message;
  return (
    <main className="mx-auto grid w-full max-w-md gap-4 px-6 py-16 font-sans text-sm leading-relaxed">
      <span className="font-serif text-lg font-medium italic">agent computers</span>
      <p role="status" aria-live="polite">
        {exchange.isSuccess
          ? `Connected. This browser syncs to ${exchange.data.email}.`
          : error === 'expired'
            ? 'This connection attempt expired or was already used. Open the extension and connect again.'
            : error === 'denied'
              ? 'Connecting was canceled.'
              : error
                ? "Couldn't connect to Agent Computers. Open the extension and try again."
                : 'Connecting…'}
      </p>
      {exchange.isError && (
        <div>
          <Button variant="secondary" onClick={() => void returnTo(undefined)}>
            Close
          </Button>
        </div>
      )}
    </main>
  );
}
