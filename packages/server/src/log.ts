// Errors can carry connection strings, cookies, or tokens in their messages, so only the
// error class and a short code (for example a Postgres SQLSTATE) are ever logged.
export function errorLabel(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return `${name}${typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? ` (${code})` : ''}`;
}
export function logError(scope: string, error: unknown) {
  console.error(`${scope} failed: ${errorLabel(error)}`);
}
// Setup funnel events: one JSON line per first completion. Only the opaque user ID is logged, and
// `event` comes last so no field can overwrite it.
export type SetupEvent = 'setup.browserSynced' | 'setup.agentConnected' | 'setup.setUp';
export function logSetupEvent(name: SetupEvent, fields: { user: string }) {
  console.log(JSON.stringify({ ...fields, event: name }));
}
