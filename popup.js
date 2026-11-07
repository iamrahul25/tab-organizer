import * as organizer from "./organizer.js";
import * as sessions from "./sessions.js";

const SCOPE = "current";
const $ = (id) => document.getElementById(id);
const DEFAULTS = { sortKey: "url", reverse: false, dupMode: "url", autoGroup: false };
let settings = { ...DEFAULTS };

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function loadSettings() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  $("sort-key").value = settings.sortKey;
  $("sort-reverse").checked = settings.reverse;
  $("dup-mode").value = settings.dupMode;
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(settings);
}

async function refreshStats() {
  const { tabs, duplicates } = await organizer.getStats(SCOPE, settings.dupMode);
  $("stats").textContent = `${plural(tabs, "tab")} · ${plural(duplicates, "duplicate")}`;
  $("dedupe").textContent = duplicates ? `Remove ${plural(duplicates, "duplicate")}` : "No duplicates";
  $("dedupe").disabled = duplicates === 0;
}

function refreshGroupButton() {
  $("group-toggle").textContent = settings.autoGroup ? "Ungroup" : "Group by domain";
}

function sessionMeta(session) {
  const { tabs, groups, windows } = sessions.sessionSummary(session);
  const parts = [plural(tabs, "tab")];
  if (groups) parts.push(plural(groups, "group"));
  if (windows > 1) parts.push(plural(windows, "window"));
  parts.push(new Date(session.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  return parts.join(" · ");
}

function sessionButton(label, action, id, className = "") {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = className;
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

async function renderSessions() {
  const saved = await sessions.listSessions();
  $("sessions-empty").hidden = saved.length > 0;
  $("session-list").replaceChildren(
    ...saved.map((session) => {
      const item = document.createElement("li");
      const info = document.createElement("div");
      info.className = "session-info";
      const name = document.createElement("strong");
      name.textContent = session.name;
      const meta = document.createElement("span");
      meta.textContent = sessionMeta(session);
      info.append(name, meta);
      item.title = session.windows.flatMap((w) => w.tabs.map((t) => t.title || t.url)).slice(0, 15).join("\n");
      item.append(
        info,
        sessionButton("Restore", "restore", session.id),
        sessionButton("Delete", "delete", session.id, "danger"),
      );
      return item;
    }),
  );
}

async function refreshUndo() {
  $("undo-sort").disabled = !(await organizer.canUndoSort());
}

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

async function run(action) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    setStatus(await action());
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    refreshGroupButton();
    await Promise.all([refreshStats(), refreshUndo()]);
  }
}

$("sort-key").addEventListener("change", (e) => saveSettings({ sortKey: e.target.value }));
$("sort-reverse").addEventListener("change", (e) => saveSettings({ reverse: e.target.checked }));
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
