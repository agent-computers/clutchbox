import 'server-only';
import { sql } from 'drizzle-orm';
import type { Database } from './database';
import { userSettings } from './schema';

// An IANA zone name, like America/Los_Angeles, UTC, or Etc/GMT+5. It becomes a path on the computer, so the
// pattern (the same as the columns' CHECK) admits no dots or spaces; Intl rejects names that are not zones.
const NAME = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
export function isTimeZone(value: string) {
  if (!NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The account page reports the browser's time zone on every visit; the next computer_open sets the
// computer to it (computers.ts, applyTimeZone). Writes only when it changed.
export async function setTimeZone(db: Database, userId: string, timeZone: string) {
  await db
    .insert(userSettings)
    .values({ userId, timeZone })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { timeZone },
      setWhere: sql`${userSettings.timeZone} IS DISTINCT FROM ${timeZone}`,
    });
  return { timeZone };
}
