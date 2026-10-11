"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const status = $("finderStatus");
  const results = $("finderResults");
  const dateLabel = value => new Date(value + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  let submitting = false;
  let lastRevision = null;
  const keyStorage = "longbnb.openrouterApiKey";
  const secureOrigin = location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  let serverAI = null, clientApiKey = "";
  try { clientApiKey = localStorage.getItem(keyStorage) || ""; } catch {}

  function setAIConfig(config) {
    serverAI = !!config.aiEnabled;
    $("finderAiEntry").hidden = serverAI || !secureOrigin;
    $("finderSaveKey").hidden = serverAI || !secureOrigin;
    $("finderRemoveKey").disabled = !clientApiKey;
    $("finderApiKey").value = "";
    $("finderAiMode").textContent = serverAI
      ? "AI is provided by this site. Your browser key is not used."
      : secureOrigin ? "Search works without a key. Add your own key for free AI language help."
        : "Search works without a key. Open this site over HTTPS to save and use an AI key.";
    $("finderKeyStatus").textContent = clientApiKey ? (serverAI ? "A browser key is saved, but is not being used." : "A key is saved in this browser.") : "No browser key saved.";
  }

  $("finderSaveKey").addEventListener("click", () => {
    if (serverAI !== false || !secureOrigin) return;
    const value = $("finderApiKey").value.trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(value)) { $("finderKeyStatus").textContent = "Paste a valid OpenRouter API key to save it."; return; }
    try {
      localStorage.setItem(keyStorage, value);
      clientApiKey = value;
      setAIConfig({ aiEnabled: serverAI });
    } catch { $("finderKeyStatus").textContent = "This browser blocked saving the key. Check your storage settings."; }
  });
  $("finderRemoveKey").addEventListener("click", () => {
    try {
      localStorage.removeItem(keyStorage);
      clientApiKey = "";
      $("finderApiKey").value = "";
      $("finderRemoveKey").disabled = true;
      $("finderKeyStatus").textContent = "Browser key removed.";
    } catch { $("finderKeyStatus").textContent = "This browser blocked removing the key. Clear this site's storage in your browser settings."; }
  });

  function setCities(cities) {
    $("finderCities").replaceChildren(...cities.map(city => {
      const option = document.createElement("option");
      option.value = city.split("--").map(part => part.replace(/-/g, " ")).join(", ");
      return option;
    }));
  }

  function setRefresh(state) {
    if (!state) return;
    const revision = state.lastCompletedAt || state.harvestedAt || state.lastSuccessAt;
    if (lastRevision && revision && revision !== lastRevision && !state.running) {
      window.LongBNBFinder.onRefresh?.();
      if (results.children.length) {
        results.replaceChildren();
        status.textContent = "The listings have updated. Search again for the latest matches.";
      }
    }
    if (revision && !state.running) lastRevision = revision;
    const badge = $("refreshStatus");
    badge.classList.toggle("stale", !!state.stale);
    if (state.running) badge.textContent = "Updating listings now · " + state.phase;
    else if (state.harvestDisabled || state.enabled === false) badge.textContent = "Automatic refresh is paused.";
    else if (state.lastError) badge.textContent = "Latest refresh was incomplete. Showing the last good data; another check is scheduled.";
    else if (state.stale) badge.textContent = "These listings need a refresh. Check price and availability on Airbnb.";
    else badge.textContent = state.lastSuccessAt ? "Checked " + new Date(state.lastSuccessAt).toLocaleString() + " · refreshes daily" : "Listings refresh daily.";
  }

  function renderMatches(matches) {
    results.replaceChildren(...matches.map(listing => {
      const card = document.createElement("article");
      card.className = "finder-result";
      const picture = (listing.imgs || []).find(url => /^https:\/\/(?:[a-z0-9-]+\.)?muscache\.com\//i.test(url));
      if (picture) {
        const image = document.createElement("img"); image.src = picture; image.alt = ""; image.loading = "lazy";
        card.append(image);
      }
      const body = document.createElement("div"); body.className = "finder-result-body";
      const title = document.createElement("h2"); title.textContent = listing.name || "Airbnb stay";
      const area = document.createElement("p"); area.textContent = listing.area + " · " + listing.type;
      const price = document.createElement("p"); price.className = "finder-price"; price.textContent = dollars.format(listing.monthly) + " / month";
      const dates = document.createElement("p"); dates.textContent = "From " + dateLabel(listing.availableFrom) + " · up to " + listing.availableDays + " days";
      const link = document.createElement("a"); link.href = "https://www.airbnb.com/rooms/" + encodeURIComponent(listing.id); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Check price & availability ↗";
      body.append(title, area, price, dates, link); card.append(body); return card;
    }));
  }

  $("finderForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting) return;
    const filters = {};
    if ($("finderCity").value.trim()) filters.location = $("finderCity").value.trim();
    if ($("finderBudget").value) filters.maxMonthly = Number($("finderBudget").value);
    if ($("finderDate").value) filters.moveIn = $("finderDate").value;
    if ($("finderDays").value) filters.minDays = Number($("finderDays").value);
    const message = $("finderMessage").value.trim();
    if (!message && !Object.keys(filters).length) { status.textContent = "Add a city, budget, or a short description to start."; return; }
    submitting = true; $("finderSubmit").disabled = true; status.classList.remove("error");
    status.textContent = "Finding stays in the latest available listings…"; results.replaceChildren();
    try {
      const body = { message, filters };
      if (serverAI === false && secureOrigin && clientApiKey) body.clientApiKey = clientApiKey;
      const response = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (response.status === 401) { status.textContent = "Sign in to use the finder."; return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search is unavailable. Please try again.");
      const c = data.criteria;
      const filtersText = [c.location || "All tracked cities", c.type, c.maxMonthly != null ? "max " + dollars.format(c.maxMonthly) + "/month" : "", c.minDays + "+ days", "from " + dateLabel(c.moveIn)].filter(Boolean).join(" · ");
      status.textContent = data.message + " " + filtersText + (data.notice ? " " + data.notice : "");
      renderMatches(data.matches);
      setRefresh(data.freshness);
    } catch (error) { status.textContent = error.name === "TimeoutError" ? "Search took too long. Please try again." : error.message; status.classList.add("error"); }
    finally { submitting = false; $("finderSubmit").disabled = false; }
  });

  window.LongBNBFinder = { setCities, setRefresh, setAIConfig };
  // Refresh an open page's status without triggering a scrape or an AI request.
  async function refreshStatus() {
    if (document.hidden) return;
    try { const response = await fetch("/api/status"); if (response.ok) setRefresh(await response.json()); } catch {}
  }
  refreshStatus();
  setInterval(refreshStatus, 60000);
})();
