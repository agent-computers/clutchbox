import { bigint, timestamp } from 'drizzle-orm/pg-core';

// Shared column builders.
export const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
// Integer primary key; it never leaves packages/server.
export const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
export const key = (name: string) => bigint(name, { mode: 'number' });
// created_at on every table; updated_at on tables whose rows change, set on every Drizzle update.
export const createdAt = () => time('created_at').defaultNow().notNull();
export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: time('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
