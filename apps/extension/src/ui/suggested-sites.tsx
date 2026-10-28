import { type ExtensionConfig, type SuggestedSite, withCompanions } from '@clutchbox/capture';
import { Button } from './components/button';
import { hint } from './sync-status';

// The suggested sites by category, in the order the server's config lists them. `hideAdded` leaves out rows whose
// sites are all added.
export function SuggestedSites(props: {
  config: Pick<ExtensionConfig, 'suggestedSites' | 'companions'>;
  // The server whose config this is, which serves the icons.
  origin: string;
  sites: string[];
  blocked: (site: string) => string;
  disabled: boolean;
  onAdd: (sites: string[]) => void;
  hideAdded?: boolean;
  size?: 'sm' | 'default';
}) {
  const { config, sites, blocked, disabled } = props;
  // A row's sites with their companions. One Add asks Chrome once for all of them.
  const rowSites = (row: SuggestedSite) => [
    ...new Set(row.sites.flatMap(site => withCompanions(site, config.companions))),
  ];
  const missing = (row: SuggestedSite) => rowSites(row).filter(site => !sites.includes(site));
  const categories = [...new Set(config.suggestedSites.map(row => row.category))];
  return (
    <div className="grid gap-5">
      {categories.map(category => {
        const rows = config.suggestedSites.filter(
          row => row.category === category && !(props.hideAdded && !missing(row).length),
        );
        if (!rows.length) return null;
        return (
          <section key={category} className="grid gap-1" aria-label={category}>
            <h3 className="text-[13px] font-medium text-muted-foreground">{category}</h3>
            <ul className="grid border-t">
              {rows.map(row => {
                const needed = missing(row);
                const reason = rowSites(row).map(blocked).find(Boolean);
                return (
                  <li key={row.name} className="flex items-center justify-between gap-3 border-b py-1.5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      {row.icon && (
                        <img src={`${props.origin}${row.icon}`} alt="" width={16} height={16} className="size-4" />
                      )}
                      <span className="grid min-w-0">
                        <span>{row.name}</span>
                        {row.detail && <span className={hint}>{row.detail}</span>}
                        {reason && needed.length > 0 && <span className={hint}>{reason}</span>}
                      </span>
                    </span>
                    {needed.length ? (
                      <Button
                        variant="secondary"
                        size={props.size ?? 'default'}
                        disabled={disabled || !!reason}
                        aria-label={`Add ${row.name}`}
                        onClick={() => props.onAdd(needed)}
                      >
                        Add
                      </Button>
                    ) : (
                      <span className="text-[13px] text-foreground">Added</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
