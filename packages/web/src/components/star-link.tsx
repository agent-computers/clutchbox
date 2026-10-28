import { cn } from '@clutchbox/ui/lib/utils';
import { formatStars } from '../lib/github';
import { GitHubMark } from './github-mark';

// Links to a GitHub repository with its star count, for the public pages' header and the signed-in sidebar. The
// count comes from the server (repoStars); without one, the link shows just the mark.
export function StarLink({ repo, stars, className }: { repo: string; stars: number | null; className?: string }) {
  return (
    <a
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 px-2 text-sm text-muted-foreground tabular-nums no-underline transition-colors hover:text-foreground',
        className,
      )}
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener"
      aria-label={stars === null ? 'Star on GitHub' : `Star on GitHub, ${formatStars(stars)} stars`}
    >
      <GitHubMark className="size-4 shrink-0" />
      {stars !== null && <span>{formatStars(stars)}</span>}
    </a>
  );
}
