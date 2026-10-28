# @clutchbox/computer

The interface a computer provider implements, so agents and sync work the same on any provider.

- **`ComputerProvider`:** `create`, `find`, `connect` (resumes a paused computer), `pause`, `setTimeout`, and `kill`; for forks, `snapshot`, `createFromSnapshot` (a copy with the snapshot's memory, so the browser keeps running), and `deleteSnapshot`.
- **`ComputerSession`:** `screenshot`, `act` (click, drag, scroll, type, key chords), `exec`, `cdp`, `closeTabs`, `setTimeZone`, `syncCookies`, live view's `stream` and `setClipboard`, `cdpEndpoint` for the server's CDP proxy, and `refresh`.
- **`actionSchema`:** the zod schema for mouse and keyboard actions, for validating what an agent sends.

[`@clutchbox/e2b`](../e2b) is the implementation. To use a member's capture in another provider's sandbox or browser, use a runtime adapter instead, such as [`@clutchbox/playwright`](../playwright), which applies it to any Chrome over CDP.
