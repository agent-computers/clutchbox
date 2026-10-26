'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { ApiError } from '../lib/api';

// The server's refusals, in words; any other error shows its own message.
const refusals: Record<string, string> = {
  forbidden: 'Your role does not allow that.',
  last_owner: 'An organization needs an owner. Make someone else an owner first.',
  not_found: 'That is no longer here. Reload to see the latest.',
  invalid_domain: 'Enter domains only, like acme.com.',
  organization_limit: 'You have created as many organizations as you can.',
  api_key_limit: 'This organization has as many API keys as it can. Delete one first.',
  connect_app_limit: 'This organization has as many Connect apps as it can. Delete one first.',
  invalid_redirect_uri: 'Each redirect URI must be a full https address (http only on localhost), without a #fragment.',
  public_email_domain:
    'Anyone can get an address at that domain, so it cannot let people join. Use your own domain, or invite people by email.',
};
// Our API's errors carry their code; Better Auth's (through Better Auth UI's mutations) carry its body, whose message is
// already in words.
const message = (error: Error) => {
  if (error instanceof ApiError) return (error.code && refusals[error.code]) || error.message;
  const body = (error as { error?: { code?: string; message?: string } }).error;
  return (body?.code && refusals[body.code]) || body?.message || error.message;
};

// A failed request's refusal, in words.
export function Failure({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{message(error)}</AlertDescription>
    </Alert>
  );
}
