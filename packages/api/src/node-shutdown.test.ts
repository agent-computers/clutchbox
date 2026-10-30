import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { shutdownSignal } from '@clutchbox/server/shutdown';
import { describe, expect, it, vi } from 'vitest';
import { nodeServer, shutDown } from './node-upgrade';

// Its own file: shutting down aborts the process-wide signal, which can't be undone.
async function listening(listener: (request: IncomingMessage, response: ServerResponse) => unknown) {
  const server = nodeServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('shutting down', () => {
  it('stops taking connections, tells relays to close, lets a request in flight finish, then exits', async () => {
    let finish: () => void = () => {};
    const arrived = new Promise<void>(resolve => {
      void listening((_, response) => {
        finish = () => response.end('done');
        resolve();
      }).then(started => Object.assign(running, started));
    });
    const running = {} as Awaited<ReturnType<typeof listening>>;
    await vi.waitFor(() => expect(running.url).toBeDefined());
    const { server, url } = running;
    const inFlight = fetch(`${url}/slow`);
    await arrived;
    const exit = vi.fn();
    shutDown(server, { graceMs: 5_000, exit });
    expect(shutdownSignal.aborted).toBe(true);
    await expect(fetch(`${url}/new`)).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
    finish();
    expect(await (await inFlight).text()).toBe('done');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('exits after the grace period when a request never finishes', async () => {
    const { server, url } = await listening(() => {});
    void fetch(`${url}/stuck`).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    const exit = vi.fn();
    shutDown(server, { graceMs: 200, exit });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    server.closeAllConnections();
  });
});
