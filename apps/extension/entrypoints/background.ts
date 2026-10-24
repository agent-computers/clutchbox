import { defineBackground } from 'wxt/utils/define-background';
import { distribution } from '../src/build';
import { CaptureController, syncAlarm, trustedSender } from '../src/controller';
import { serverOrigin } from '../src/server';

export default defineBackground(() => {
  const controller = new CaptureController(
    {
      permissions: chrome.permissions,
      cookies: chrome.cookies,
      storage: chrome.storage,
      alarms: chrome.alarms,
      tabs: chrome.tabs,
      action: chrome.action,
      runtime: chrome.runtime,
      fetch: (input, init) => fetch(input, init),
    },
    serverOrigin,
    chrome.runtime.getManifest().version,
    distribution,
    chrome.runtime.getURL('connected.html'),
  );
  chrome.alarms.onAlarm.addListener(alarm => {
    void controller.alarmFired(alarm.name).catch(() => undefined);
  });
  // A fresh install opens the setup tab. Updates do not, since an unpacked reload counts as one.
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('/setup.html') });
  });
  chrome.runtime.onStartup.addListener(() => {
    void controller.alarmFired(syncAlarm).catch(() => undefined);
  });
  chrome.cookies.onChanged.addListener(change => {
    void controller.cookieChanged(change).catch(() => undefined);
  });
  chrome.permissions.onAdded.addListener(() => {
    void controller.permissionsAdded().catch(() => undefined);
  });
  chrome.permissions.onRemoved.addListener(removed => {
    void controller.permissionsRemoved(removed.origins).catch(() => undefined);
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!trustedSender(sender, chrome.runtime.id, message)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    void controller.handle(message, { tab: sender.tab?.id }).then(sendResponse);
    return true;
  });
});
