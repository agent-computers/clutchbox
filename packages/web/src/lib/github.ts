// A repository's star count, 1234 as 1.2k, as GitHub shows it.
export const formatStars = (stars: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars).toLowerCase();
