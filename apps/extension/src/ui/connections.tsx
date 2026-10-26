import type { ConnectionSummary } from '@agent-computers/capture';
import { Button } from './components/button';
import { hint } from './sync-status';

// A connection's name: its organization's, or its server's host until the server names one.
export const connectionName = (connection: Pick<ConnectionSummary, 'origin' | 'organization'>) =>
  connection.organization?.name || new URL(connection.origin).host;
// Whether a connection receives a site at each sync.
export const receives = ({ settings, account }: ConnectionSummary, site: string) =>
  settings.connected &&
  !settings.paused &&
  account.state === 'syncing' &&
  (settings.mode === 'all' || settings.sites.includes(site));

// Every connection, each one organization on one server, with the one the page acts on selected. With `site`, each
// row says whether that connection gets it.
export function Connections(props: {
  connections: ConnectionSummary[];
  selected: string | undefined;
  // Connecting another organization is open.
  another: boolean;
  site?: string | null;
  onSelect: (connection: string) => void;
  onAnother: () => void;
  disabled?: boolean;
}) {
  const { connections, selected, site } = props;
  if (!connections.length) return null;
  return (
    <section className="grid gap-1" aria-label="Organizations">
      <ul className="grid border-t">
        {connections.map(connection => {
          const current = !props.another && connection.id === selected;
          const state =
            connection.account.state === 'reconnect'
              ? 'Reconnect needed'
              : !connection.settings.connected
                ? 'Disconnected'
                : connection.settings.paused
                  ? 'Paused'
                  : connection.account.state === 'syncing'
                    ? connection.account.email
                    : '';
          return (
            <li key={connection.id} className="border-b">
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                disabled={props.disabled}
                onClick={() => props.onSelect(connection.id)}
                className={`flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left ${
                  current ? 'bg-card' : 'hover:bg-muted'
                }`}
              >
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{connectionName(connection)}</span>
                  <span className={`${hint} truncate`}>
                    {new URL(connection.origin).host}
                    {state ? ` · ${state}` : ''}
                  </span>
                </span>
                {site && (
                  <span className="shrink-0 text-[13px] text-soft">
                    {receives(connection, site) ? 'Gets this site' : 'Not this site'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div>
        <Button
          variant="link"
          className="h-auto px-0"
          disabled={props.disabled || props.another}
          onClick={props.onAnother}
        >
          Connect another organization…
        </Button>
      </div>
    </section>
  );
}
