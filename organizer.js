const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;
const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const tabUrl = (tab) => tab.url || tab.pendingUrl || "";

export function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function duplicateKey(url, ignoreHash) {
  if (!ignoreHash) return url;
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

async function getWindows(scope) {
  if (scope === "all") {
    return chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  }
  return [await chrome.windows.getCurrent({ populate: true })];
}

const COMPARATORS = {
  url: (a, b) => collator.compare(tabUrl(a), tabUrl(b)),
  title: (a, b) => collator.compare(a.title || "", b.title || ""),
  domain: (a, b) =>
    collator.compare(getDomain(tabUrl(a)), getDomain(tabUrl(b))) ||
    collator.compare(tabUrl(a), tabUrl(b)),
  recent: (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
};

function sortedIds(tabs, key, reverse) {
  const sorted = [...tabs].sort(COMPARATORS[key]);
  if (reverse) sorted.reverse();
  return sorted.map((tab) => tab.id);
}

// Pinned tabs stay put. Tabs inside a group are sorted within that group;
// ungrouped tabs are sorted and placed after the groups.
export async function sortTabs(scope, key, reverse) {
  let count = 0;
  for (const win of await getWindows(scope)) {
    const ungrouped = win.tabs.filter((t) => !t.pinned && t.groupId === NO_GROUP);
    if (ungrouped.length > 1) {
      const ids = sortedIds(ungrouped, key, reverse);
      await chrome.tabs.move(ids, { windowId: win.id, index: -1 });
      await chrome.tabs.ungroup(ids);
      count += ids.length;
    }

    const tabs = await chrome.tabs.query({ windowId: win.id });
    const groups = Map.groupBy(
      tabs.filter((t) => t.groupId !== NO_GROUP),
      (t) => t.groupId,
    );
    for (const [groupId, groupTabs] of groups) {
      if (groupTabs.length < 2) continue;
      const start = Math.min(...groupTabs.map((t) => t.index));
      const ids = sortedIds(groupTabs, key, reverse);
      await chrome.tabs.move(ids, { windowId: win.id, index: start });
      await chrome.tabs.group({ groupId, tabIds: ids });
      count += ids.length;
    }
  }
  return count;
}

function findDuplicates(tabs, ignoreHash) {
  const byUrl = Map.groupBy(tabs, (t) => duplicateKey(tabUrl(t), ignoreHash));
  const toClose = [];
  for (const group of byUrl.values()) {
    if (group.length < 2) continue;
    // Keep the active tab if there is one, then a pinned one, then the most recently used.
    const keeper = [...group].sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Number(b.pinned) - Number(a.pinned) ||
        (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
    )[0];
    toClose.push(...group.filter((t) => t.id !== keeper.id));
  }
  return toClose;
}

export async function removeDuplicates(scope, ignoreHash) {
  const tabs = (await getWindows(scope)).flatMap((w) => w.tabs);
  const duplicates = findDuplicates(tabs, ignoreHash);
  if (duplicates.length) await chrome.tabs.remove(duplicates.map((t) => t.id));
  return duplicates.length;
}

export async function groupByDomain(scope) {
  let created = 0;
  for (const win of await getWindows(scope)) {
    const byDomain = Map.groupBy(
      win.tabs.filter((t) => !t.pinned),
      (t) => getDomain(tabUrl(t)) || "Other",
    );
    const existing = await chrome.tabGroups.query({ windowId: win.id });
    let colorIndex = existing.length;

    for (const [domain, tabs] of byDomain) {
      if (tabs.length < 2) continue;
      const tabIds = tabs.map((t) => t.id);
      const match = existing.find((g) => g.title === domain);
      if (match) {
        await chrome.tabs.group({ groupId: match.id, tabIds });
      } else {
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(groupId, {
          title: domain,
          color: GROUP_COLORS[colorIndex++ % GROUP_COLORS.length],
        });
        created++;
      }
    }
  }
  return created;
}

export async function ungroupAll(scope) {
  const ids = (await getWindows(scope))
    .flatMap((w) => w.tabs)
    .filter((t) => t.groupId !== NO_GROUP)
    .map((t) => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids);
  return ids.length;
}

export async function mergeWindows() {
  const target = await chrome.windows.getCurrent();
  const others = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(
    (w) => w.id !== target.id && w.incognito === target.incognito,
  );

  let moved = 0;
  for (const win of others) {
    for (const group of await chrome.tabGroups.query({ windowId: win.id })) {
      moved += (await chrome.tabs.query({ groupId: group.id })).length;
      await chrome.tabGroups.move(group.id, { windowId: target.id, index: -1 });
    }

    const remaining = await chrome.tabs.query({ windowId: win.id });
    if (!remaining.length) continue;
    const pinned = remaining.filter((t) => t.pinned);
    // Pinned tabs can't be moved past unpinned ones, so unpin, move, then re-pin.
    await Promise.all(pinned.map((t) => chrome.tabs.update(t.id, { pinned: false })));
    await chrome.tabs.move(remaining.map((t) => t.id), { windowId: target.id, index: -1 });
    await Promise.all(pinned.map((t) => chrome.tabs.update(t.id, { pinned: true })));
    moved += remaining.length;
  }
  return moved;
}

export async function discardInactive(scope) {
  const candidates = (await getWindows(scope))
    .flatMap((w) => w.tabs)
    .filter((t) => !t.active && !t.discarded && !t.audible);
  const results = await Promise.allSettled(candidates.map((t) => chrome.tabs.discard(t.id)));
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

export async function getStats(scope, ignoreHash) {
  const windows = await getWindows(scope);
  const tabs = windows.flatMap((w) => w.tabs);
  return {
    tabs: tabs.length,
    windows: windows.length,
    duplicates: findDuplicates(tabs, ignoreHash).length,
  };
}
