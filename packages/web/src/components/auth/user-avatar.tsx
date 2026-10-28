'use client';
// Better Auth UI v1.7.30 UserAvatar, using the verified user supplied by our server. MIT license: LICENSE.
import { Avatar, AvatarFallback, AvatarImage } from '@clutchbox/ui/components/avatar';
import { cn } from '@clutchbox/ui/lib/utils';
import { User2 } from 'lucide-react';

export type UserIdentity = { name: string; email: string; image?: string | null | undefined };
export function UserAvatar({ user, className }: { user: UserIdentity; className?: string }) {
  const initials = (user.name || user.email).slice(0, 2).toUpperCase();
  return (
    <Avatar className={cn('size-8 rounded-full bg-muted text-sm text-foreground', className)}>
      <AvatarImage src={user.image ?? undefined} alt={user.name || user.email} referrerPolicy="no-referrer" />
      <AvatarFallback>{initials || <User2 aria-hidden="true" className="size-4" />}</AvatarFallback>
    </Avatar>
  );
}
