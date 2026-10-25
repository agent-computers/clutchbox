// The part of noVNC 1.7.0's RFB client the live view uses (core/rfb.js; the package's API documentation).
// @types/novnc__novnc lags at 1.6.0, whose package shape differs; replace this if types for 1.7 ship.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: { shared?: boolean; wsProtocols?: string[] },
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    // Sends a key press, or with down omitted a press and release; nothing while view-only.
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
