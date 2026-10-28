// A repository's star count, 1234 as 1.2k, as GitHub shows it.
export const formatStars = (stars: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars).toLowerCase();

// How long the server keeps a star count. GitHub allows 60 unauthenticated calls an hour per address, so the count
// comes from the server, cached, rather than from each visitor's browser, which a few tabs or a shared address used up.
export const starsRevalidateSeconds = 300;

// A public repository's star count from GitHub's API, on the server. Next.js's data cache keeps only successful
// answers, so a failed refresh keeps serving the last count. Throws when GitHub doesn't answer with one.
export async function repoStars(repo: string): Promise<number> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: 'application/vnd.github+json' },
    next: { revalidate: starsRevalidateSeconds },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const { stargazers_count: stars } = (await response.json()) as { stargazers_count?: unknown };
  if (typeof stars !== 'number') throw new Error('GitHub sent no star count');
  return stars;
}
