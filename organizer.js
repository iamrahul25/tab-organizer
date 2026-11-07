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

// "youtube.com" -> "youtube", "chromestore.google" -> "chromestore".
// IP addresses are kept whole since their first segment is meaningless.
function groupName(url) {
  const domain = getDomain(url);
  if (!domain) return "Other";
  if (/^\d+(\.\d+){3}$/.test(domain) || domain.startsWith("[")) return domain;
  return domain.split(".")[0];
}

// "url": same page, ignoring any #fragment. "domain": same site, whatever the path
// (www.github.com/a and github.com/b match). Tabs without a domain fall back to their URL.
function duplicateKey(url, mode) {
  if (mode === "domain") return getDomain(url) || url;
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

export async function getWindows(scope) {
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

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function sortedIds(tabs, key, reverse) {
  const sorted = key === "random" ? shuffle([...tabs]) : [...tabs].sort(COMPARATORS[key]);
  if (reverse) sorted.reverse();
  return sorted.map((tab) => tab.id);
}

const UNDO_KEY = "sortUndo";

function orderSnapshot(windows) {
  return windows.map((win) => ({
    windowId: win.id,
    tabs: win.tabs.filter((t) => !t.pinned).map((t) => ({ id: t.id, groupId: t.groupId })),
  }));
}

export async function canUndoSort() {
  const { [UNDO_KEY]: snapshot } = await chrome.storage.session.get(UNDO_KEY);
  return Boolean(snapshot);
}

// Rebuilds the pre-sort order one unit at a time (a lone tab or a whole group), left to right.
// Each unit lands right after the previous one, so it can never be dropped inside another group.
// Tabs closed, moved to another window, or regrouped since the sort are skipped.
export async function undoSort() {
  const { [UNDO_KEY]: snapshot } = await chrome.storage.session.get(UNDO_KEY);
  if (!snapshot) throw new Error("Nothing to undo.");

  let restored = 0;
  for (const { windowId, tabs: saved } of snapshot) {
    const current = await chrome.tabs.query({ windowId });
    const byId = new Map(current.map((t) => [t.id, t]));

    const units = [];
    for (const { id, groupId } of saved) {
      const tab = byId.get(id);
      if (!tab || tab.pinned || tab.groupId !== groupId) continue;
      const last = units.at(-1);
      if (groupId !== NO_GROUP && last?.groupId === groupId) last.ids.push(id);
      else units.push({ groupId, ids: [id] });
    }

    let index = current.filter((t) => t.pinned).length;
    for (const { groupId, ids } of units) {
      if (groupId === NO_GROUP) {
        await chrome.tabs.move(ids[0], { index });
        index += 1;
      } else {
        await chrome.tabGroups.move(groupId, { index });
        await chrome.tabs.move(ids, { index });
        await chrome.tabs.group({ groupId, tabIds: ids });
        index += (await chrome.tabs.query({ groupId })).length;
      }
      restored += ids.length;
    }
  }
  await chrome.storage.session.remove(UNDO_KEY);
  return restored;
}

// Pinned tabs stay put. Tabs inside a group are sorted within that group;
// ungrouped tabs are sorted and placed after the groups.
export async function sortTabs(scope, key, reverse) {
  const windows = await getWindows(scope);
  const snapshot = orderSnapshot(windows);
  let count = 0;
  for (const win of windows) {
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
  if (count) await chrome.storage.session.set({ [UNDO_KEY]: snapshot });
  return count;
}

function findDuplicates(tabs, mode) {
  const byUrl = Map.groupBy(tabs, (t) => duplicateKey(tabUrl(t), mode));
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

export async function removeDuplicates(scope, mode) {
  const tabs = (await getWindows(scope)).flatMap((w) => w.tabs);
  const duplicates = findDuplicates(tabs, mode);
  if (duplicates.length) await chrome.tabs.remove(duplicates.map((t) => t.id));
  return duplicates.length;
}

export async function groupByDomain(scope) {
  let created = 0;
  for (const win of await getWindows(scope)) {
    const byDomain = Map.groupBy(
      win.tabs.filter((t) => !t.pinned),
      (t) => groupName(tabUrl(t)),
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

// A group counts as one of ours if its title matches the domain name of a tab inside it,
// so user-made groups like "Work" are left alone.
function isDomainGroup(group, tabs) {
  return tabs.some((t) => t.groupId === group.id && groupName(tabUrl(t)) === group.title);
}

// Ungrouping (unlike closing) deletes the group, so Chrome drops it from saved groups.
export async function removeDomainGroups() {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const groupIds = new Set(groups.filter((g) => isDomainGroup(g, tabs)).map((g) => g.id));
  const tabIds = tabs.filter((t) => groupIds.has(t.groupId)).map((t) => t.id);
  if (tabIds.length) await chrome.tabs.ungroup(tabIds);
  return groupIds.size;
}

export async function autoGroupTab(tab) {
  const url = tabUrl(tab);
  if (tab.pinned || !/^https?:/.test(url)) return;

  const name = groupName(url);
  const [groups, tabs] = await Promise.all([
    chrome.tabGroups.query({ windowId: tab.windowId }),
    chrome.tabs.query({ windowId: tab.windowId }),
  ]);
  const others = tabs.filter((t) => t.id !== tab.id);
  const current = groups.find((g) => g.id === tab.groupId);
  if (current && (current.title === name || !isDomainGroup(current, others))) return;

  const target = groups.find((g) => g.title === name);
  if (target) {
    await chrome.tabs.group({ groupId: target.id, tabIds: [tab.id] });
    return;
  }

  const peers = others.filter(
    (t) => !t.pinned && t.groupId === NO_GROUP && groupName(tabUrl(t)) === name,
  );
  if (!peers.length) {
    if (current) await chrome.tabs.ungroup(tab.id);
    return;
  }
  const groupId = await chrome.tabs.group({
    tabIds: [...peers.map((t) => t.id), tab.id],
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
  });
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

export async function getStats(scope, mode) {
  const tabs = (await getWindows(scope)).flatMap((w) => w.tabs);
  return { tabs: tabs.length, duplicates: findDuplicates(tabs, mode).length };
}
