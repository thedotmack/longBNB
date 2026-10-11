// Invoked by GitHub Actions. Never log credentials or put them in the URL.
const base = process.env.LONG_BNB_URL || "https://longbnb.fly.dev";
const token = process.env.HARVEST_TOKEN;
if (!token) throw new Error("HARVEST_TOKEN secret is required to refresh the hosted site.");
const url = new URL("/api/harvest?stream=1&scheduled=1", base);
if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") throw new Error("Use HTTPS for the hosted refresh.");
const response = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  redirect: "error",
  signal: AbortSignal.timeout(25 * 60 * 1000),
});
if (!response.ok) throw new Error(`Refresh endpoint returned HTTP ${response.status}.`);
let pending = "", last = null;
const decoder = new TextDecoder();
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n"); pending = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    last = JSON.parse(line);
    console.log(JSON.stringify({ running: last.running, phase: last.phase, done: last.done, total: last.total, listings: last.listings, lastSuccessAt: last.lastSuccessAt }));
  }
}
pending += decoder.decode();
if (pending.trim()) last = JSON.parse(pending);
if (!last || last.running || last.error || last.lastError || last.stale) throw new Error("Refresh did not finish successfully; see the site's refresh status. Previous listings were retained.");
console.log(last.skipped ? "Already fresh; no downloads needed." : "Daily refresh completed.");
