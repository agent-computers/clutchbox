import { type Response, type ServerResponse, serverOriginOfInput } from '@clutchbox/capture';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { approvedServersKey } from '../controller';
import { defaultServerOrigin } from '../origin';
import { serverOrigin } from '../server';
import { Button } from './components/button';
import { Input } from './components/input';
import { hint } from './sync-status';

const host = (origin: string) => new URL(origin).host;
// The build's own server, which the warning compares the other one with.
const ours = serverOrigin === defaultServerOrigin ? 'Clutchbox' : host(serverOrigin);

// The servers the browser's administrator approved (Chrome Enterprise policy), offered first.
async function approvedServers(): Promise<string[]> {
  const value = (await chrome.storage.managed.get(approvedServersKey).catch(() => ({}) as { [key: string]: unknown }))[
    approvedServersKey
  ];
  return Array.isArray(value)
    ? [...new Set(value.map(each => (typeof each === 'string' ? serverOriginOfInput(each) : null)))].filter(
        (each): each is string => !!each && each !== serverOrigin,
      )
    : [];
}

// Connecting to a server other than the build's: its address, or one the administrator approved. The worker says
// whether it needs the warning first.
export function AnotherServer(props: { disabled: boolean; onChoose: (server: ServerResponse) => void }) {
  const inputId = useId();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const { data: approved = [] } = useQuery({ queryKey: ['approved-servers'], queryFn: approvedServers });
  const choose = async (input: string) => {
    const origin = serverOriginOfInput(input);
    if (!origin) {
      setError("Enter the server's address, such as agents.example.com. It must use HTTPS.");
      return;
    }
    setError('');
    setChecking(true);
    try {
      const response: Response | ServerResponse = await chrome.runtime.sendMessage({ type: 'server', origin });
      if (!response.ok) throw new Error(response.error);
      if ('trust' in response) props.onChoose(response);
    } catch {
      setError('Extension unavailable. Reload this page to try again.');
    } finally {
      setChecking(false);
    }
  };
  const disabled = props.disabled || checking;
  return (
    <div className="grid gap-3 rounded-lg bg-card p-4 text-[13px]">
      {approved.length > 0 && (
        <div className="grid justify-items-start gap-2">
          <p className="text-foreground">Approved by your organization:</p>
          {approved.map(origin => (
            <Button key={origin} variant="secondary" disabled={disabled} onClick={() => void choose(origin)}>
              {host(origin)}
            </Button>
          ))}
        </div>
      )}
      <form
        className="grid gap-2"
        onSubmit={event => {
          event.preventDefault();
          void choose(address);
        }}
      >
        <label htmlFor={inputId} className="font-medium">
          Server address
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={address}
            onChange={event => setAddress(event.target.value)}
            placeholder="agents.example.com"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={disabled || !address.trim()}>
            Continue
          </Button>
        </div>
        <p className={hint}>
          For a server your organization runs itself. Servers outside the verified list show a warning first.
        </p>
      </form>
      {error && (
        <p className="text-destructive" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

// The full-page warning before connecting to a server outside the verified list, ahead of Chrome's permission prompt.
export function ServerWarning(props: { origin: string; onAgree: () => void; onBack: () => void }) {
  return (
    <section className="grid gap-4" aria-labelledby="warning-heading">
      <h1 id="warning-heading" className="font-heading text-[40px] leading-[1.05] font-medium tracking-[-0.015em]">
        Connect to {host(props.origin)}?
      </h1>
      <p className="text-base">
        This server, not {ours}, will receive your sign-ins for the sites you add to this connection. Whoever runs it
        can use them as you.
      </p>
      <p className="text-foreground">
        It is not on the verified list of servers that have shown they run Clutchbox at their address. Continue only if
        you trust whoever runs <strong className="font-medium text-foreground">{props.origin}</strong>, such as your
        employer, and you expected to connect to it.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button size="lg" variant="secondary" onClick={props.onBack}>
          Go back
        </Button>
        <Button size="lg" variant="destructive" onClick={props.onAgree}>
          Connect anyway
        </Button>
      </div>
    </section>
  );
}
