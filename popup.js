import * as organizer from "./organizer.js";
import * as sessions from "./sessions.js";

const SCOPE = "current";
const ICONS = "icons/ui-icons.svg";
const CONFIRM_TIMEOUT_MS = 3000;
const $ = (id) => document.getElementById(id);
const DEFAULTS = { sortKey: "url", reverse: false, dupMode: "url", autoGroup: false };
let settings = { ...DEFAULTS };

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
  $("sort-reverse").setAttribute("aria-pressed", String(settings.reverse));
  $("dup-mode").value = settings.dupMode;
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(settings);
}

async function refreshStats() {
  const { tabs, duplicates } = await organizer.getStats(SCOPE, settings.dupMode);
  $("stats").replaceChildren(chip(plural(tabs, "tab")), chip(plural(duplicates, "duplicate")));
  $("dedupe-label").textContent = duplicates ? `Close ${plural(duplicates, "duplicate")}` : "No duplicates";
  $("dedupe").disabled = duplicates === 0;
}

function refreshGroupButton() {
  $("group-toggle-label").textContent = settings.autoGroup ? "Ungroup" : "Group by domain";
  $("group-toggle").setAttribute("aria-pressed", String(settings.autoGroup));
}

async function refreshUndo() {
  $("undo-sort").disabled = !(await organizer.canUndoSort());
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
  $("sessions-empty").hidden = saved.length > 0;
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
    await Promise.all([refreshStats(), refreshUndo()]);
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

$("sort-key").addEventListener("change", (e) => saveSettings({ sortKey: e.target.value }));

$("sort-reverse").addEventListener("click", (e) => {
  saveSettings({ reverse: !settings.reverse });
  e.currentTarget.setAttribute("aria-pressed", String(settings.reverse));
});

$("dup-mode").addEventListener("change", (e) => {
  saveSettings({ dupMode: e.target.value });
  refreshStats();
});

$("sort").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.sortTabs(SCOPE, settings.sortKey, settings.reverse);
    return n ? `Sorted ${plural(n, "tab")}.` : "Nothing to sort.";
  }),
);

$("shuffle").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.sortTabs(SCOPE, "random", false);
    return n ? `Shuffled ${plural(n, "tab")}.` : "Nothing to shuffle.";
  }),
);

$("undo-sort").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.undoSort();
    return n ? `Restored the order of ${plural(n, "tab")}.` : "Nothing left to restore.";
  }),
);

$("dedupe").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.removeDuplicates(SCOPE, settings.dupMode);
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

$("merge").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.mergeWindows();
    return n ? `Moved ${plural(n, "tab")} into this window.` : "Only one window open.";
  }),
);

$("save-session").addEventListener("click", () =>
  run(async () => {
    const windows = await organizer.getWindows(SCOPE);
    const session = await sessions.saveSession(windows, $("session-name").value.trim());
    $("session-name").value = "";
    await renderSessions();
    return `Saved "${session.name}" (${plural(sessions.sessionSummary(session).tabs, "tab")}).`;
  }),
);

$("session-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save-session").click();
});

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

await loadSettings();
refreshGroupButton();
await Promise.all([refreshStats(), refreshUndo(), renderSessions()]);
