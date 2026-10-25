'use client';
// Better Auth UI v1.7.30 UserView. MIT license: LICENSE.
import { UserAvatar, type UserIdentity } from './user-avatar';

export function UserView({ user, hideSubtitle = false }: { user: UserIdentity; hideSubtitle?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <UserAvatar user={user} />
      <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium text-foreground">{user.name || user.email}</span>
        {!hideSubtitle && user.name && <span className="truncate text-sm text-muted-foreground">{user.email}</span>}
      </div>
    </div>
  );
}
