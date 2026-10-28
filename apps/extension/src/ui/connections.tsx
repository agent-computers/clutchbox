import type { ConnectionSummary } from '@clutchbox/capture';
import { serverOrigin } from '../server';
import { hint } from './sync-status';

// A connection's name: its organization's, or its server's host when the server names none.
export const connectionName = (connection: Pick<ConnectionSummary, 'origin' | 'organization'>) =>
  connection.organization?.name || new URL(connection.origin).host;
// The server's host, for a server other than the build's.
export const otherHost = ({ origin }: Pick<ConnectionSummary, 'origin'>) =>
  origin === serverOrigin ? '' : new URL(origin).host;
// Whether a connection receives a site at each sync.
export const receives = ({ settings, account }: ConnectionSummary, site: string) =>
  settings.connected &&
  !settings.paused &&
  account.state === 'syncing' &&
  (settings.mode === 'all' || settings.sites.includes(site));

// The organization switcher: every connection, one per organization of each signed-in account, with the one the page
// shows selected. With `site`, each row says whether that organization gets it.
export function Connections(props: {
  connections: ConnectionSummary[];
  selected: string | undefined;
  site?: string | null;
  onSelect: (connection: string) => void;
  disabled?: boolean;
}) {
  const { connections, selected, site } = props;
  if (connections.length < 2) return null;
  return (
    <section className="grid gap-1" aria-label="Organizations">
      <ul className="grid border-t">
        {connections.map(connection => {
          const current = connection.id === selected;
          const state =
            connection.account.state === 'reconnect'
              ? 'Reconnect needed'
              : !connection.settings.connected
                ? 'Not syncing'
                : connection.settings.paused
                  ? 'Paused'
                  : '';
          const detail = [otherHost(connection), state].filter(Boolean).join(' · ');
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
                  {detail && <span className={`${hint} truncate`}>{detail}</span>}
                </span>
                {site && (
                  <span className="shrink-0 text-[13px] text-foreground">
                    {receives(connection, site) ? 'Gets this site' : 'Not this site'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
