// This process is shutting down: the Node server's SIGTERM (a host stopping or replacing it) aborts it once. Long
// connections listen for it and close with their reconnect code, so clients come straight back to another instance.
// Nothing aborts it on Vercel, which keeps a deploy's open connections on the old deployment.
const controller = new AbortController();
export const shutdownSignal = controller.signal;
export function beginShutdown() {
  controller.abort();
}
