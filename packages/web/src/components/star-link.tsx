import { cn } from '@clutchbox/ui/lib/utils';
import { GitHubMark } from './github-mark';

// Links to a GitHub repository with its mark, for the public pages' header and the signed-in sidebar.
export function StarLink({ repo, className }: { repo: string; className?: string }) {
  return (
    <a
      className={cn(
        'inline-flex min-h-11 items-center px-2 text-muted-foreground no-underline transition-colors hover:text-foreground',
        className,
      )}
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener"
      aria-label="Star on GitHub"
    >
      <GitHubMark className="size-4 shrink-0" />
    </a>
  );
}
