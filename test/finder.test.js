const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function browser({ stored = "", blocked = false, protocol = "https:" } = {}) {
  const elements = new Map();
  const storage = new Map(stored ? [["longbnb.openrouterApiKey", stored]] : []);
  const requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", children: [], handlers: {}, classList: { remove() {}, add() {}, toggle() {} }, replaceChildren(...children) { this.children = children; }, addEventListener(event, handler) { this.handlers[event] = handler; } });
    return elements.get(id);
  };
  const context = {
    document: { hidden: true, getElementById: element }, window: {},
    location: { protocol, hostname: "longbnb.example" }, Intl, Date, AbortSignal,
    setInterval() {},
    localStorage: {
      getItem(key) { if (blocked) throw new Error("blocked"); return storage.get(key); },
      setItem(key, value) { if (blocked) throw new Error("blocked"); storage.set(key, value); },
      removeItem(key) { if (blocked) throw new Error("blocked"); storage.delete(key); },
    },
    async fetch(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ criteria: { location: "", minDays: 28, moveIn: "2026-10-11" }, message: "No matches.", matches: [] }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/finder.js"), "utf8"), context);
  return { element, storage, requests, config: context.window.LongBNBFinder.setAIConfig,
    submit: () => { element("finderMessage").value = "a cheap place"; return element("finderForm").handlers.submit({ preventDefault() {} }); } };
}

test("browser setting saves, uses, and removes a key without exposing it in the input", async () => {
  const app = browser();
  app.config({ aiEnabled: false });
  app.element("finderApiKey").value = "browser-only-key";
  app.element("finderSaveKey").handlers.click();
  assert.equal(app.storage.get("longbnb.openrouterApiKey"), "browser-only-key");
  assert.equal(app.element("finderApiKey").value, "");
  await app.submit();
  assert.equal(app.requests[0].body.clientApiKey, "browser-only-key");
  app.element("finderRemoveKey").handlers.click();
  await app.submit();
  assert.equal(app.storage.size, 0);
  assert.equal(app.requests[1].body.clientApiKey, undefined);
});

test("browser key is withheld until configuration is loaded and whenever the server provides AI", async () => {
  const app = browser({ stored: "browser-only-key" });
  await app.submit();
  app.config({ aiEnabled: true });
  await app.submit();
  assert.ok(app.requests.every(request => request.body.clientApiKey === undefined));
  assert.equal(app.element("finderAiEntry").hidden, true);
  assert.equal(app.element("finderApiKey").value, "");
  app.element("finderRemoveKey").handlers.click();
  assert.equal(app.storage.size, 0);
});

test("blocked storage and insecure pages retain no-key search", async () => {
  for (const options of [{ blocked: true }, { stored: "browser-only-key", protocol: "http:" }]) {
    const app = browser(options);
    app.config({ aiEnabled: false });
    app.element("finderApiKey").value = "browser-only-key";
    app.element("finderSaveKey").handlers.click();
    await app.submit();
    assert.equal(app.requests[0].body.clientApiKey, undefined);
  }
});
