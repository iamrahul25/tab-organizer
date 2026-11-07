import { restoreSession } from "./sessions.js";
import { autoGroupTab } from "./organizer.js";

// Restoring runs here rather than in the popup because opening a new window
// closes the popup and would cut the restore short.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "restoreSession") return;
  restoreSession(message.id).then(
    (count) => sendResponse({ ok: true, count }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const { autoGroup } = await chrome.storage.sync.get({ autoGroup: false });
  if (!autoGroup) return;
  try {
    await autoGroupTab(tab);
  } catch {
    // Chrome rejects tab edits while the user is dragging a tab.
  }
});
