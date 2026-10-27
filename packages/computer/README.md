# @agent-computers/computer

The interface a computer provider implements, so agents and sync work the same on any provider.

- **`ComputerProvider`:** `create`, `find`, `connect` (resumes a paused computer), `pause`, `setTimeout`, and `kill`; for forks, `snapshot`, `createFromSnapshot` (a copy with the snapshot's memory, so the browser keeps running), and `deleteSnapshot`.
- **`ComputerSession`:** `screenshot`, `act` (click, drag, scroll, type, key chords), `exec`, `cdp`, `closeTabs`, `setTimeZone`, `syncCookies`, live view's `stream` and `setClipboard`, `cdpEndpoint` for the server's CDP proxy, and `refresh`.
- **`actionSchema`:** the zod schema for mouse and keyboard actions, for validating what an agent sends.

[`@agent-computers/e2b`](../e2b) is the first implementation. Daytona, Browserbase, and Kernel are planned; contributions are welcome.
