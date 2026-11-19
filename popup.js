import * as organizer from "./organizer.js";
import * as sessions from "./sessions.js";

const SCOPE = "current";
const ICONS = "icons/ui-icons.svg";
const CONFIRM_TIMEOUT_MS = 3000;
const THEME_KEY = "theme";
const $ = (id) => document.getElementById(id);
// Fixed by the popup layout: duplicates are matched by URL and sorts run in forward order.
const DUP_MODE = "url";
const DEFAULTS = { zoom: 100, sortKey: "url", reverse: false, dupMode: "url", autoGroup: false, sidePanel: false };
let settings = { ...DEFAULTS };
let sidePanelOpen = false;
const currentWindow = await chrome.windows.getCurrent();

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

function chip(text) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = text;
  return span;
}

async function loadSettings() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  $("sort-key").value = settings.sortKey;
}

function applyZoom(percent) {
  document.documentElement.style.zoom = String(percent / 100);
  $("zoom").value = String(percent);
  $("zoom-value").textContent = `${percent}%`;
}

function setZoom(percent) {
  const value = Math.min(130, Math.max(80, Math.round(percent / 5) * 5));
  applyZoom(value);
  saveSettings({ zoom: value });
}

function showSettings(show) {
  $("settings").hidden = !show;
  $("main").hidden = show;
  $("settings-toggle").setAttribute("aria-expanded", String(show));
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
}

async function refreshStats() {
  const { tabs, duplicates } = await organizer.getStats(SCOPE, DUP_MODE);
  $("stats").replaceChildren(chip(plural(tabs, "tab")), chip(plural(duplicates, "duplicate")));
  $("dedupe-label").textContent = duplicates ? `Close ${plural(duplicates, "tab")}` : "No duplicates";
  $("dedupe").disabled = duplicates === 0;
}

function refreshGroupButton() {
  $("group-toggle-label").textContent = settings.autoGroup ? "Ungroup" : "Group by domain";
  $("group-toggle").setAttribute("aria-pressed", String(settings.autoGroup));
}

// Read the real state: the user can close the panel with Chrome's own close button.
async function loadSidePanelState() {
  let open = false;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "sidePanelPing" });
    open = reply?.windowId === currentWindow.id;
  } catch {
    // No side panel page is listening, so it is closed.
  }
  if (!open) {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
      open = contexts.some((c) => c.windowId === currentWindow.id);
    } catch {
      // Older Chrome builds can't list contexts.
    }
  }
  sidePanelOpen = open;
}

function refreshSidePanelButton() {
  $("side-panel-toggle").setAttribute("aria-checked", String(sidePanelOpen));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  $("theme-toggle").setAttribute("aria-label", label);
  $("theme-toggle").title = label;
}

function sessionMeta(session) {
  const { tabs, groups, windows } = sessions.sessionSummary(session);
  const parts = [plural(tabs, "tab")];
  if (groups) parts.push(plural(groups, "group"));
  if (windows > 1) parts.push(plural(windows, "window"));
  parts.push(new Date(session.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  return parts.join(" · ");
}

function sessionItem(session) {
  const item = document.createElement("li");

  const info = document.createElement("div");
  info.className = "session-info";
  const name = document.createElement("span");
  name.className = "session-name";
  name.textContent = session.name;
  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = sessionMeta(session);
  info.append(name, meta);
  info.title = session.windows.flatMap((w) => w.tabs.map((t) => t.title || t.url)).slice(0, 15).join("\n");

  const restore = document.createElement("button");
  restore.className = "btn";
  restore.dataset.action = "restore";
  restore.dataset.id = session.id;
  restore.setAttribute("aria-label", `Restore ${session.name}`);
  restore.append(icon("restore"), "Restore");

  const remove = document.createElement("button");
  remove.className = "btn btn-icon btn-ghost danger-hover";
  remove.dataset.action = "delete";
  remove.dataset.id = session.id;
  remove.setAttribute("aria-label", `Delete ${session.name}`);
  remove.title = "Delete";
  remove.append(icon("trash"));

  item.append(info, restore, remove);
  return item;
}

async function renderSessions() {
  const saved = await sessions.listSessions();
  $("session-list").hidden = saved.length === 0;
  $("session-list").replaceChildren(...saved.map(sessionItem));
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.classList.toggle("error", isError);
  status.replaceChildren(...(message ? [icon(isError ? "error" : "success"), message] : []));
}

async function run(action) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  $("main").setAttribute("aria-busy", "true");
  try {
    setStatus(await action());
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    $("main").removeAttribute("aria-busy");
    refreshGroupButton();
    refreshSidePanelButton();
    await refreshStats();
  }
}

// Deleting a saved session can't be undone, so the first click arms the button
// and only a second click within a few seconds deletes.
function armDelete(button) {
  button.dataset.armed = "true";
  button.classList.replace("btn-ghost", "btn-danger");
  button.classList.remove("btn-icon");
  button.replaceChildren(icon("trash"), "Confirm");
  setTimeout(() => {
    if (!button.isConnected || button.dataset.armed !== "true") return;
    delete button.dataset.armed;
    button.classList.replace("btn-danger", "btn-ghost");
    button.classList.add("btn-icon");
    button.replaceChildren(icon("trash"));
  }, CONFIRM_TIMEOUT_MS);
}

$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

$("settings-toggle").addEventListener("click", () => showSettings($("settings").hidden));
$("settings-back").addEventListener("click", () => showSettings(false));
$("zoom").addEventListener("input", (e) => setZoom(Number(e.target.value)));
$("zoom-in").addEventListener("click", () => setZoom(settings.zoom + 5));
$("zoom-out").addEventListener("click", () => setZoom(settings.zoom - 5));
$("zoom-reset").addEventListener("click", () => setZoom(100));

$("sort-key").addEventListener("change", (e) => saveSettings({ sortKey: e.target.value }));

$("sort").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.sortTabs(SCOPE, settings.sortKey, false);
    return n ? `Sorted ${plural(n, "tab")}.` : "Nothing to sort.";
  }),
);

$("dedupe").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.removeDuplicates(SCOPE, DUP_MODE);
    return `Closed ${plural(n, "duplicate tab")}.`;
  }),
);

$("group-toggle").addEventListener("click", () =>
  run(async () => {
    if (!settings.autoGroup) {
      const n = await organizer.groupByDomain("all");
      saveSettings({ autoGroup: true });
      return n ? `Created ${plural(n, "group")}.` : "New tabs will be grouped by domain.";
    }
    const n = await organizer.removeDomainGroups();
    saveSettings({ autoGroup: false });
    return n ? `Removed ${plural(n, "group")}.` : "Grouping turned off.";
  }),
);

// sidePanel.open() only works during the click, so it must be called before anything is awaited.
// sidePanel.close() needs Chrome 141; before that, disabling the panel is the only way to close it.
$("side-panel-toggle").addEventListener("click", () =>
  run(async () => {
    const windowId = currentWindow.id;
    if (!sidePanelOpen) {
      await Promise.all([chrome.sidePanel.setOptions({ enabled: true }), chrome.sidePanel.open({ windowId })]);
      saveSettings({ sidePanel: true });
      sidePanelOpen = true;
      return "Side panel shown.";
    }
    if (chrome.sidePanel.close) {
      await chrome.sidePanel.close({ windowId });
    } else {
      await chrome.sidePanel.setOptions({ enabled: false });
    }
    saveSettings({ sidePanel: false });
    sidePanelOpen = false;
    return "Side panel hidden.";
  }),
);

$("save-session").addEventListener("click", () =>
  run(async () => {
    const windows = await organizer.getWindows(SCOPE);
    const session = await sessions.saveSession(windows, "");
    await renderSessions();
    return `Saved "${session.name}" (${plural(sessions.sessionSummary(session).tabs, "tab")}).`;
  }),
);

$("session-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;

  if (action === "delete") {
    if (button.dataset.armed !== "true") {
      armDelete(button);
      return;
    }
    run(async () => {
      await sessions.deleteSession(id);
      await renderSessions();
      return "Deleted saved session.";
    });
  } else if (action === "restore") {
    setStatus("Restoring…");
    chrome.runtime.sendMessage({ type: "restoreSession", id }).then((response) => {
      if (!response?.ok) setStatus(response?.error || "Restore failed.", true);
    });
  }
});

$("discard").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.discardInactive(SCOPE);
    return n ? `Suspended ${plural(n, "tab")}.` : "No tabs to suspend.";
  }),
);

applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
await loadSettings();
applyZoom(settings.zoom);
await loadSidePanelState();
refreshGroupButton();
refreshSidePanelButton();
await Promise.all([refreshStats(), renderSessions()]);
