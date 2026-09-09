// The extension side of the bridge.
//
// It holds a long poll open against the WorkCrew app on loopback. When the app
// has an action, the poll returns immediately, the action runs against the
// user's real tab, and the result is posted back. Then it polls again.
//
// The long poll doubles as the keepalive: an in-flight fetch keeps this service
// worker from being stopped, and chrome.alarms restarts it if it ever is.

importScripts("page.js");

const IDLE_BACKOFF_MS = 2000;
let running = false;

async function config() {
  const stored = await chrome.storage.local.get(["token", "port"]);
  return { token: stored.token || "", port: stored.port || 8317 };
}

function base(port) {
  return "http://127.0.0.1:" + port;
}

async function setBadge(connected) {
  await chrome.action.setBadgeText({ text: connected ? "on" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: connected ? "#3fb950" : "#8b949e" });
}

// The tab actions run against: whatever the user is looking at in the window
// they last used. Deliberately not a tab the extension owns, because the entire
// point is to work where the user already is.
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id != null) return tab;
  const [any] = await chrome.tabs.query({ active: true });
  if (any && any.id != null) return any;
  throw new Error("No browser tab is open.");
}

function assertScriptable(url) {
  // Chrome refuses injection on its own pages, and silently doing nothing there
  // would look like a broken action rather than a page that cannot be automated.
  if (!url || !/^https?:/i.test(url)) {
    throw new Error("That tab is not a normal web page, so it cannot be worked on. Open a website first.");
  }
}

async function inPage(tabId, url, command) {
  assertScriptable(url);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: wcPageAgent,
    args: [command],
    world: "ISOLATED"
  });
  if (!result) throw new Error("The page did not respond.");
  return result.result;
}

async function waitForLoad(tabId) {
  // Resolve when the tab finishes loading, with a ceiling so a page that never
  // settles cannot wedge the run.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, 20000);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runOne(command) {
  const kind = command.command;
  if (kind === "open" || kind === "goto") {
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url: command.url });
    await waitForLoad(tab.id);
    const fresh = await chrome.tabs.get(tab.id);
    return inPage(tab.id, fresh.url, { command: "snapshot" });
  }
  if (kind === "go-back" || kind === "go-forward" || kind === "reload") {
    const tab = await activeTab();
    if (kind === "go-back") await chrome.tabs.goBack(tab.id);
    else if (kind === "go-forward") await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.reload(tab.id);
    await waitForLoad(tab.id);
    const fresh = await chrome.tabs.get(tab.id);
    return inPage(tab.id, fresh.url, { command: "snapshot" });
  }
  if (kind === "screenshot") {
    const shot = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 });
    return shot || "(screenshot unavailable)";
  }
  if (kind === "tab-list") {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    return tabs.map((tab, index) => index + ": " + (tab.title || "") + " - " + (tab.url || "")).join("\n");
  }
  if (kind === "tab-new") {
    const created = await chrome.tabs.create({ url: command.url || "about:blank", active: true });
    if (command.url) await waitForLoad(created.id);
    return "Opened a new tab.";
  }
  if (kind === "tab-select") {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const wanted = tabs[command.index || 0];
    if (!wanted) throw new Error("There is no tab at that position.");
    await chrome.tabs.update(wanted.id, { active: true });
    return "Switched tab.";
  }
  if (kind === "tab-close") {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const wanted = tabs[command.index || 0];
    if (wanted) await chrome.tabs.remove(wanted.id);
    return "Tab closed.";
  }
  const tab = await activeTab();
  return inPage(tab.id, tab.url, command);
}

// A batch runs its steps together and stops at the first failure, reporting how
// far it got and what the page looks like now. Same contract as the app's own
// browser, so the model behaves identically whichever one is driving.
async function runBatch(steps) {
  const done = [];
  for (let i = 0; i < steps.length; i += 1) {
    const label = i + 1 + ". " + steps[i].command;
    try {
      const output = await runOne(steps[i]);
      done.push(label + ": " + output);
    } catch (error) {
      const why = error && error.message ? error.message : String(error);
      const state = await currentPage();
      return done.join("\n") + (done.length ? "\n" : "") + label + ": FAILED - " + why + "\nStopped here. Current page:\n" + state;
    }
  }
  const state = await currentPage();
  return done.join("\n") + "\nDone. Current page:\n" + state;
}

async function currentPage() {
  try {
    const tab = await activeTab();
    return await inPage(tab.id, tab.url, { command: "snapshot" });
  } catch (error) {
    return "(page unavailable)";
  }
}

async function execute(action) {
  if (action.command === "batch") return runBatch(action.steps || []);
  return runOne(action);
}

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const { token, port } = await config();
      if (!token) {
        await setBadge(false);
        await sleep(IDLE_BACKOFF_MS);
        continue;
      }
      let command = null;
      try {
        const response = await fetch(base(port) + "/poll", {
          method: "GET",
          headers: { Authorization: "Bearer " + token }
        });
        if (response.status === 401) {
          await setBadge(false);
          await sleep(5000);
          continue;
        }
        await setBadge(true);
        if (response.status === 200) command = await response.json();
      } catch (error) {
        // The app is closed or the port moved. Keep trying quietly; this is the
        // normal state whenever WorkCrew is not running.
        await setBadge(false);
        await sleep(IDLE_BACKOFF_MS);
        continue;
      }
      if (!command) continue;
      let ok = true;
      let output = "";
      try {
        output = await execute(command.action);
      } catch (error) {
        ok = false;
        output = error && error.message ? error.message : String(error);
      }
      try {
        await fetch(base(port) + "/result", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ id: command.id, ok: ok, output: String(output == null ? "" : output) })
        });
      } catch (error) {
        // Nothing to do: the app has gone away, and it will time the turn out.
      }
    }
  } finally {
    running = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onStartup.addListener(() => void loop());
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("wc-keepalive", { periodInMinutes: 1 });
  void loop();
});
chrome.alarms.onAlarm.addListener(() => void loop());
void loop();
