const STORAGE_KEY = "savedSessions";
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

export async function listSessions() {
  const { [STORAGE_KEY]: sessions = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return sessions;
}

function writeSessions(sessions) {
  return chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

async function snapshotWindow(win) {
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
  return {
    tabs: win.tabs
      .filter((t) => t.url || t.pendingUrl)
      .map((t) => ({
        url: t.url || t.pendingUrl,
        title: t.title || "",
        pinned: t.pinned,
        group: t.groupId === NO_GROUP ? null : groupIndex.get(t.groupId),
      })),
    groups: groups.map(({ title, color, collapsed }) => ({ title, color, collapsed })),
  };
}

export async function saveSession(windows, name) {
  const snapshots = (await Promise.all(windows.map(snapshotWindow))).filter((w) => w.tabs.length);
  if (!snapshots.length) throw new Error("No tabs to save.");

  const session = {
    id: crypto.randomUUID(),
    name: name || new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    createdAt: Date.now(),
    windows: snapshots,
  };
  await writeSessions([session, ...(await listSessions())]);
  return session;
}

export async function deleteSession(id) {
  await writeSessions((await listSessions()).filter((s) => s.id !== id));
}

// Each saved window is reopened as a new window, with pinned state and groups restored.
export async function restoreSession(id) {
  const session = (await listSessions()).find((s) => s.id === id);
  if (!session) throw new Error("Saved session not found.");

  let opened = 0;
  for (const saved of session.windows) {
    const win = await chrome.windows.create({ focused: true });
    const placeholderId = win.tabs[0].id;

    const created = [];
    for (const tab of saved.tabs) {
      try {
        const { id: tabId } = await chrome.tabs.create({
          windowId: win.id,
          url: tab.url,
          pinned: tab.pinned,
          active: false,
        });
        created.push({ id: tabId, group: tab.group });
      } catch {
        // Chrome refuses to open some URLs (e.g. certain chrome:// pages); skip them.
      }
    }
    if (!created.length) continue;
    await chrome.tabs.remove(placeholderId);
    await chrome.tabs.update(created[0].id, { active: true });

    for (const [index, group] of saved.groups.entries()) {
      const tabIds = created.filter((t) => t.group === index).map((t) => t.id);
      if (!tabIds.length) continue;
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
      await chrome.tabGroups.update(groupId, group);
    }
    opened += created.length;
  }
  return opened;
}

export function sessionSummary(session) {
  return {
    tabs: session.windows.reduce((n, w) => n + w.tabs.length, 0),
    groups: session.windows.reduce((n, w) => n + w.groups.length, 0),
    windows: session.windows.length,
  };
}
