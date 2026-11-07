import * as organizer from "./organizer.js";

const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;
const ICONS = "icons/ui-icons.svg";
const THEME_KEY = "theme";
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const RELOAD_DELAY_MS = 40;
const STATUS_TIMEOUT_MS = 4000;
const $ = (id) => document.getElementById(id);
const list = $("tab-list");
const menu = $("menu");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const capitalize = (word) => word[0].toUpperCase() + word.slice(1);

const SORT_OPTIONS = [
  ["url", "By URL"],
  ["domain", "By domain"],
  ["title", "By title"],
  ["recent", "Recently used first"],
];

const { id: windowId } = await chrome.windows.getCurrent();
const settings = await chrome.storage.sync.get({ sortKey: "url", reverse: false, autoGroup: false });

let tabs = [];
let groups = new Map();
let dragging = null;
let drop = null;
let renaming = false;
let stale = false;
let reloadTimer = 0;
let statusTimer = 0;
let pendingRename = null;
let lastActiveId = null;
let menuReturnFocus = null;
let menuAnchor = null;

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  $("theme-toggle").setAttribute("aria-label", label);
  $("theme-toggle").title = label;
}

function showError(err) {
  $("status").textContent = err.message || String(err);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), STATUS_TIMEOUT_MS);
}

// Chrome is the source of truth: after any change, re-read the tabs so the list
// also recovers from optimistic DOM moves that Chrome rejected.
async function act(action) {
  try {
    await action();
  } catch (err) {
    showError(err);
  } finally {
    scheduleReload();
  }
}

const tabById = (id) => tabs.find((t) => t.id === Number(id));

function groupOf(id) {
  return groups.get(id) ?? { id, title: "", color: "grey", collapsed: false };
}

function containerOf(tab) {
  if (tab.pinned) return "pinned";
  return tab.groupId === NO_GROUP ? "top" : `group-${tab.groupId}`;
}

function faviconSrc(tab) {
  if (/^(https?|data):/.test(tab.favIconUrl || "")) return tab.favIconUrl;
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", tab.url || tab.pendingUrl || "about:blank");
  url.searchParams.set("size", "32");
  return url.href;
}

function tabRow(tab) {
  const row = document.createElement("li");
  row.className = "tab";
  row.classList.toggle("active", tab.active);
  row.classList.toggle("sleeping", Boolean(tab.discarded));
  row.draggable = true;
  row.dataset.tabId = tab.id;
  row.dataset.container = containerOf(tab);

  const label = tab.title || tab.url || "New Tab";
  const main = document.createElement("button");
  main.className = "tab-main";
  main.dataset.action = "activate";
  main.title = tab.url ? `${label}\n${tab.url}` : label;
  if (tab.active) main.setAttribute("aria-current", "page");

  const favicon = document.createElement("img");
  favicon.className = "favicon";
  favicon.src = faviconSrc(tab);
  favicon.alt = "";
  favicon.draggable = false;

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = label;
  main.append(favicon, title);

  if (tab.discarded) {
    const badge = document.createElement("span");
    badge.className = "tab-badge";
    badge.textContent = "Sleeping";
    main.append(badge);
  }
  if (tab.pinned) {
    const hidden = document.createElement("span");
    hidden.className = "sr-only";
    hidden.textContent = "(pinned)";
    main.append(hidden);
  }
  row.append(main);

  if (tab.pinned) {
    const pin = icon("pin");
    pin.classList.add("tab-pin");
    row.append(pin);
  }

  const close = document.createElement("button");
  close.className = "btn btn-icon btn-ghost tab-close";
  close.dataset.action = "close";
  close.setAttribute("aria-label", `Close ${label}`);
  close.title = "Close tab";
  close.append(icon("close"));
  row.append(close);
  return row;
}

function groupBlock(group, members) {
  const block = document.createElement("li");
  block.className = "group";
  block.classList.toggle("collapsed", group.collapsed);
  block.dataset.groupId = group.id;
  block.dataset.container = "top";
  block.dataset.color = group.color;

  const header = document.createElement("div");
  header.className = "group-header";
  const toggle = document.createElement("button");
  toggle.className = "group-toggle";
  toggle.dataset.action = "collapse";
  toggle.setAttribute("aria-expanded", String(!group.collapsed));
  const title = document.createElement("span");
  title.className = "group-title";
  title.textContent = `${group.title || "Unnamed group"} - ${members.length}`;
  toggle.append(icon("caret-down"), title);
  header.append(toggle);

  const groupTabs = document.createElement("ul");
  groupTabs.className = "group-tabs";
  groupTabs.hidden = group.collapsed;
  groupTabs.append(...members.map(tabRow));

  block.append(header, groupTabs);
  return block;
}

function focusedControl() {
  const el = document.activeElement;
  if (!el?.dataset?.action || !list.contains(el)) return null;
  const owner = el.closest("[data-tab-id], [data-group-id]");
  return { action: el.dataset.action, tabId: owner.dataset.tabId, groupId: owner.dataset.groupId };
}

function restoreFocus(control) {
  if (!control) return;
  const owner = control.tabId
    ? list.querySelector(`[data-tab-id="${control.tabId}"]`)
    : list.querySelector(`[data-group-id="${control.groupId}"]`);
  owner?.querySelector(`[data-action="${control.action}"]`)?.focus();
}

function render() {
  $("stats").textContent = `${plural(tabs.length, "tab")} · ${plural(groups.size, "group")}`;
  refreshCollapseButton();

  const items = [];
  for (let i = 0; i < tabs.length; ) {
    const { groupId } = tabs[i];
    if (groupId === NO_GROUP) {
      items.push(tabRow(tabs[i++]));
      continue;
    }
    let end = i;
    while (end < tabs.length && tabs[end].groupId === groupId) end++;
    items.push(groupBlock(groupOf(groupId), tabs.slice(i, end)));
    i = end;
  }

  const focused = focusedControl();
  list.replaceChildren(...items);
  applySearch();
  restoreFocus(focused);

  const active = tabs.find((t) => t.active);
  if (active && active.id !== lastActiveId) {
    lastActiveId = active.id;
    list.querySelector(`[data-tab-id="${active.id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  if (pendingRename !== null && groups.has(pendingRename)) {
    const id = pendingRename;
    pendingRename = null;
    startRename(id);
  }
}

async function reload() {
  stale = false;
  const [tabList, groupList] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  tabs = tabList.sort((a, b) => a.index - b.index);
  groups = new Map(groupList.map((g) => [g.id, g]));
  // Re-rendering would drop the row being dragged or the name being typed.
  if (dragging || renaming) stale = true;
  else render();
}

function scheduleReload() {
  if (dragging || renaming) {
    stale = true;
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, RELOAD_DELAY_MS);
}

function resumeReloads() {
  if (stale) scheduleReload();
}

// Drag and drop only reorders: a tab moves among the tabs of its own group, among
// pinned tabs, or (when ungrouped) among the ungrouped tabs and whole groups.

function dropTargetFrom(el) {
  let node = el.closest?.("[data-container]");
  while (node) {
    if (node === dragging.row) return null;
    if (node.dataset.container === dragging.container) return node;
    node = node.parentElement.closest("[data-container]");
  }
  return null;
}

function setDrop(node, after) {
  drop?.node.classList.remove("drop-before", "drop-after");
  drop = node ? { node, after } : null;
  node?.classList.add(after ? "drop-after" : "drop-before");
}

function targetIndex({ node, after }) {
  if (node.dataset.groupId) {
    const members = tabs.filter((t) => t.groupId === Number(node.dataset.groupId));
    return after ? members.at(-1).index + 1 : members[0].index;
  }
  const tab = tabById(node.dataset.tabId);
  return after ? tab.index + 1 : tab.index;
}

// Chrome adds a tab to a group when it lands between two of that group's tabs,
// so put the tab back in the group it started in.
async function moveTab(tab, index) {
  await chrome.tabs.move(tab.id, { index });
  const moved = await chrome.tabs.get(tab.id);
  if (moved.groupId === tab.groupId) return;
  if (tab.groupId === NO_GROUP) await chrome.tabs.ungroup(tab.id);
  else await chrome.tabs.group({ groupId: tab.groupId, tabIds: tab.id });
}

list.addEventListener("dragstart", (e) => {
  const row = e.target.closest?.(".tab");
  if (!row) return;
  closeMenu();
  dragging = { row, tab: tabById(row.dataset.tabId), container: row.dataset.container };
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragging.tab.url || "");
  requestAnimationFrame(() => row.classList.add("dragging"));
});

list.addEventListener("dragover", (e) => {
  if (!dragging) return;
  const node = dropTargetFrom(e.target);
  if (!node) {
    // Keep the current marker while crossing the gaps between rows.
    const inGap = e.target === list || e.target.classList?.contains("group-tabs");
    if (inGap && drop) e.preventDefault();
    else setDrop(null);
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const box = node.getBoundingClientRect();
  setDrop(node, e.clientY > box.top + box.height / 2);
});

list.addEventListener("drop", (e) => {
  if (!dragging || !drop) return;
  e.preventDefault();
  const { row } = dragging;
  const tab = tabById(dragging.tab.id) ?? dragging.tab;
  let index = targetIndex(drop);
  if (tab.index < index) index--;
  if (drop.after) drop.node.after(row);
  else drop.node.before(row);
  if (index !== tab.index) act(() => moveTab(tab, index));
});

list.addEventListener("dragend", () => {
  dragging?.row.classList.remove("dragging");
  setDrop(null);
  dragging = null;
  resumeReloads();
});

// Clicks

list.addEventListener("click", (e) => {
  const control = e.target.closest("[data-action]");
  if (!control) return;
  const tabId = Number(control.closest(".tab")?.dataset.tabId);
  switch (control.dataset.action) {
    case "activate":
      act(() => chrome.tabs.update(tabId, { active: true }));
      break;
    case "close":
      act(() => chrome.tabs.remove(tabId));
      break;
    case "collapse": {
      const group = groupOf(Number(control.closest(".group").dataset.groupId));
      act(() => chrome.tabGroups.update(group.id, { collapsed: !group.collapsed }));
      break;
    }
  }
});

list.addEventListener("mousedown", (e) => {
  if (e.button === 1 && e.target.closest(".tab")) e.preventDefault();
});

list.addEventListener("auxclick", (e) => {
  const row = e.button === 1 && e.target.closest(".tab");
  if (row) act(() => chrome.tabs.remove(Number(row.dataset.tabId)));
});

$("new-tab").addEventListener("click", () => act(() => chrome.tabs.create({ windowId })));

// Group rename

function startRename(groupId) {
  const header = list.querySelector(`[data-group-id="${groupId}"] > .group-header`);
  if (!header) return;
  const { title } = groupOf(groupId);
  const input = document.createElement("input");
  input.className = "control group-rename";
  input.value = title;
  input.maxLength = 60;
  input.placeholder = "Name this group";
  input.setAttribute("aria-label", "Group name");
  renaming = true;
  header.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const name = input.value.trim();
    if (save && name !== title) act(() => chrome.tabGroups.update(groupId, { title: name }));
    else scheduleReload();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// Right-click menu

function menuItem(label, onSelect, { role = "menuitem", checked } = {}) {
  const item = document.createElement("button");
  item.className = "menu-item";
  item.setAttribute("role", role);
  if (checked !== undefined) item.setAttribute("aria-checked", String(checked));
  item.textContent = label;
  item.addEventListener("click", () => {
    closeMenu();
    act(onSelect);
  });
  return item;
}

function colorPicker(group) {
  const picker = document.createElement("div");
  picker.className = "menu-colors";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Group color");
  for (const color of COLORS) {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.dataset.color = color;
    swatch.setAttribute("role", "menuitemradio");
    swatch.setAttribute("aria-checked", String(color === group.color));
    swatch.setAttribute("aria-label", capitalize(color));
    swatch.title = capitalize(color);
    swatch.addEventListener("click", () => {
      closeMenu();
      act(() => chrome.tabGroups.update(group.id, { color }));
    });
    picker.append(swatch);
  }
  return picker;
}

function groupMenu(group) {
  const memberIds = tabs.filter((t) => t.groupId === group.id).map((t) => t.id);
  return [
    menuItem("Rename group", () => startRename(group.id)),
    colorPicker(group),
    menuItem("Ungroup", () => chrome.tabs.ungroup(memberIds)),
  ];
}

function tabMenu(tab) {
  const items = [];
  if (tab.groupId !== NO_GROUP) {
    items.push(menuItem("Remove from group", () => chrome.tabs.ungroup(tab.id)));
  } else if (!tab.pinned) {
    items.push(
      menuItem("Add to new group", async () => {
        pendingRename = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId } });
      }),
    );
  }
  items.push(menuItem("Close tab", () => chrome.tabs.remove(tab.id)));
  return items;
}

function menuSeparator() {
  const separator = document.createElement("div");
  separator.className = "menu-separator";
  separator.setAttribute("role", "separator");
  return separator;
}

function saveSetting(patch) {
  Object.assign(settings, patch);
  return chrome.storage.sync.set(patch);
}

async function sortBy(sortKey, reverse = settings.reverse) {
  await saveSetting({ sortKey, reverse });
  await organizer.sortTabs("current", sortKey, reverse);
}

async function sortMenu() {
  const items = SORT_OPTIONS.map(([key, label]) =>
    menuItem(label, () => sortBy(key), { role: "menuitemradio", checked: key === settings.sortKey }),
  );
  items.push(
    menuSeparator(),
    menuItem("Reverse order", () => sortBy(settings.sortKey, !settings.reverse), {
      role: "menuitemcheckbox",
      checked: settings.reverse,
    }),
    menuItem("Shuffle", () => organizer.sortTabs("current", "random", false)),
  );
  if (await organizer.canUndoSort()) items.push(menuItem("Undo last sort", () => organizer.undoSort()));
  return items;
}

// Without a point, the menu opens below the anchor (toolbar buttons, keyboard context menus).
function openMenu(items, anchor, point = null) {
  menuReturnFocus = document.activeElement;
  menuAnchor = anchor;
  menu.replaceChildren(...items);
  menu.hidden = false;

  const anchorBox = anchor.getBoundingClientRect();
  const x = point?.x ?? anchorBox.left;
  const y = point?.y ?? anchorBox.bottom + 4;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  menu.querySelector("button").focus();
}

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menuAnchor = null;
  if (menuReturnFocus?.isConnected) menuReturnFocus.focus();
  menuReturnFocus = null;
}

list.addEventListener("contextmenu", (e) => {
  if (renaming) return;
  const header = e.target.closest(".group-header");
  const row = e.target.closest(".tab");
  if (!header && !row) return;
  e.preventDefault();
  // A context menu opened from the keyboard reports (0, 0).
  const point = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null;
  if (header) openMenu(groupMenu(groupOf(Number(header.parentElement.dataset.groupId))), header, point);
  else openMenu(tabMenu(tabById(row.dataset.tabId)), row, point);
});

// Toolbar

function refreshGroupButton() {
  const label = settings.autoGroup ? "Ungroup domain groups" : "Group by domain";
  $("group-toggle").setAttribute("aria-pressed", String(settings.autoGroup));
  $("group-toggle").setAttribute("aria-label", label);
  $("group-toggle").title = label;
}

$("sort").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  if (menuAnchor === button) {
    closeMenu();
    return;
  }
  openMenu(await sortMenu(), button);
});

$("group-toggle").addEventListener("click", () =>
  act(async () => {
    if (settings.autoGroup) await organizer.removeDomainGroups();
    else await organizer.groupByDomain("all");
    await saveSetting({ autoGroup: !settings.autoGroup });
    refreshGroupButton();
  }),
);

const anyExpanded = () => [...groups.values()].some((g) => !g.collapsed);

function refreshCollapseButton() {
  const collapse = anyExpanded() || groups.size === 0;
  const label = collapse ? "Collapse all groups" : "Expand all groups";
  const button = $("collapse-toggle");
  button.disabled = groups.size === 0;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.querySelector("use").setAttribute("href", `${ICONS}#${collapse ? "collapse-all" : "expand-all"}`);
}

$("collapse-toggle").addEventListener("click", () => {
  const collapsed = anyExpanded();
  const targets = [...groups.values()].filter((g) => g.collapsed !== collapsed);
  act(() => Promise.all(targets.map((g) => chrome.tabGroups.update(g.id, { collapsed }))));
});

$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// Search only filters this list; it never changes the tabs or groups in Chrome.

function applySearch() {
  const query = $("search").value.trim().toLowerCase();
  const matches = (text) => (text || "").toLowerCase().includes(query);

  for (const row of list.querySelectorAll(".tab")) {
    const tab = tabById(row.dataset.tabId);
    row.hidden = Boolean(query) && !(matches(tab?.title) || matches(tab?.url));
  }
  for (const block of list.querySelectorAll(".group")) {
    const group = groupOf(Number(block.dataset.groupId));
    const rows = [...block.querySelectorAll(".tab")];
    if (query && matches(group.title)) rows.forEach((row) => (row.hidden = false));
    block.hidden = Boolean(query) && rows.every((row) => row.hidden);
    // Show matches inside collapsed groups without expanding them in Chrome.
    block.querySelector(".group-tabs").hidden = !query && group.collapsed;
  }
  $("search-empty").hidden = !query || list.querySelector(".tab:not([hidden])") !== null;
}

function setSearchOpen(open) {
  $("search-row").hidden = !open;
  $("search-toggle").setAttribute("aria-expanded", String(open));
  $("search-toggle").setAttribute("aria-pressed", String(open));
  if (open) {
    $("search").focus();
    return;
  }
  $("search").value = "";
  applySearch();
}

$("search-toggle").addEventListener("click", () => setSearchOpen($("search-row").hidden));

$("search").addEventListener("input", applySearch);

$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    if ($("search").value) {
      $("search").value = "";
      applySearch();
    } else {
      setSearchOpen(false);
      $("search-toggle").focus();
    }
  } else if (e.key === "Enter") {
    list.querySelector(".tab:not([hidden]) [data-action='activate']")?.click();
  }
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, textarea, [contenteditable]");
  if (e.key !== "/" || typing || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  setSearchOpen(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  refreshGroupButton();
});

menu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...menu.querySelectorAll("button")];
  const step = e.key === "ArrowDown" ? 1 : -1;
  const next = (items.indexOf(document.activeElement) + step + items.length) % items.length;
  items[next].focus();
});

document.addEventListener("pointerdown", (e) => {
  if (!menu.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
document.addEventListener("scroll", closeMenu, true);
addEventListener("blur", closeMenu);

// Live updates

for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onMoved,
  chrome.tabs.onActivated,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onReplaced,
  chrome.tabGroups.onCreated,
  chrome.tabGroups.onUpdated,
  chrome.tabGroups.onRemoved,
  chrome.tabGroups.onMoved,
]) {
  event.addListener(scheduleReload);
}

// The popup stores the theme in localStorage, which this page shares.
addEventListener("storage", (e) => {
  if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
});

applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
refreshGroupButton();
await reload();
