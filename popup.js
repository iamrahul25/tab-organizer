import * as organizer from "./organizer.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = { scope: "current", sortKey: "url", reverse: false, ignoreHash: true };
let settings = { ...DEFAULTS };

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function loadSettings() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  document.querySelector(`input[name="scope"][value="${settings.scope}"]`).checked = true;
  $("sort-key").value = settings.sortKey;
  $("sort-reverse").checked = settings.reverse;
  $("ignore-hash").checked = settings.ignoreHash;
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(settings);
}

async function refreshStats() {
  const { tabs, windows, duplicates } = await organizer.getStats(settings.scope, settings.ignoreHash);
  const parts = [plural(tabs, "tab")];
  if (settings.scope === "all") parts.push(plural(windows, "window"));
  parts.push(plural(duplicates, "duplicate"));
  $("stats").textContent = parts.join(" · ");
  $("dedupe").textContent = duplicates ? `Remove ${plural(duplicates, "duplicate")}` : "No duplicates";
  $("dedupe").disabled = duplicates === 0;
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
    await refreshStats();
  }
}

document.querySelectorAll('input[name="scope"]').forEach((input) =>
  input.addEventListener("change", () => {
    saveSettings({ scope: input.value });
    refreshStats();
  }),
);
$("sort-key").addEventListener("change", (e) => saveSettings({ sortKey: e.target.value }));
$("sort-reverse").addEventListener("change", (e) => saveSettings({ reverse: e.target.checked }));
$("ignore-hash").addEventListener("change", (e) => {
  saveSettings({ ignoreHash: e.target.checked });
  refreshStats();
});

$("sort").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.sortTabs(settings.scope, settings.sortKey, settings.reverse);
    return n ? `Sorted ${plural(n, "tab")}.` : "Nothing to sort.";
  }),
);

$("dedupe").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.removeDuplicates(settings.scope, settings.ignoreHash);
    return `Closed ${plural(n, "duplicate tab")}.`;
  }),
);

$("group-domain").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.groupByDomain(settings.scope);
    return n ? `Created ${plural(n, "group")}.` : "No new groups (need 2+ tabs per domain).";
  }),
);

$("ungroup").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.ungroupAll(settings.scope);
    return n ? `Ungrouped ${plural(n, "tab")}.` : "No grouped tabs.";
  }),
);

$("merge").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.mergeWindows();
    return n ? `Moved ${plural(n, "tab")} into this window.` : "Only one window open.";
  }),
);

$("discard").addEventListener("click", () =>
  run(async () => {
    const n = await organizer.discardInactive(settings.scope);
    return n ? `Suspended ${plural(n, "tab")}.` : "No tabs to suspend.";
  }),
);

await loadSettings();
await refreshStats();
