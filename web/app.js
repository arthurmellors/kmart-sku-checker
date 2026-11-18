(() => {
  const skuInput = document.getElementById("sku-input");
  const checkBtn = document.getElementById("check-btn");
  const exportBtn = document.getElementById("export-btn");
  const statusLine = document.getElementById("status-line");
  const summary = document.getElementById("summary");
  const empty = document.getElementById("empty");
  const loading = document.getElementById("loading");
  const resultList = document.getElementById("result-list");
  const errorBox = document.getElementById("error-box");
  const marketButtons = Array.from(document.querySelectorAll(".market-btn"));

  let selectedMarket = "both";
  let lastPayload = null;

  function parseSkus(text) {
    return text
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }

  function setBusy(isBusy) {
    checkBtn.disabled = isBusy;
    checkBtn.querySelector(".btn-label").hidden = isBusy;
    checkBtn.querySelector(".btn-busy").hidden = !isBusy;
    marketButtons.forEach((btn) => {
      btn.disabled = isBusy;
    });
  }

  function setMarket(market) {
    selectedMarket = market;
    marketButtons.forEach((btn) => {
      const active = btn.dataset.market === market;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function formatPrice(price) {
    if (!price || price.current === null || price.current === undefined) return "—";
    const base = `${price.currency || ""} ${price.current}`.trim();
    return price.save_price ? `${base} (${price.save_price})` : base;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function groupBySku(results) {
    const map = new Map();
    for (const row of results) {
      const sku = String(row.sku || "");
      if (!map.has(sku)) map.set(sku, { sku, markets: {} });
      map.get(sku).markets[row.market] = row;
    }
    return Array.from(map.values());
  }

  function paneHtml(market, row) {
    if (!row) {
      return `
        <div class="pane">
          <div class="pane-top">
            <span class="market-tag">${market}</span>
            <span class="badge badge-offline">Not checked</span>
          </div>
          <p class="muted">Market not included in this run.</p>
        </div>
      `;
    }

    if (row.error) {
      return `
        <div class="pane">
          <div class="pane-top">
            <span class="market-tag">${market}</span>
            <span class="badge badge-error">Error</span>
          </div>
          <div class="meta">
            <div class="meta-row">
              <span class="meta-key">Detail</span>
              <span class="meta-val">${escapeHtml(row.error)}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (!row.online) {
      return `
        <div class="pane">
          <div class="pane-top">
            <span class="market-tag">${market}</span>
            <span class="badge badge-offline">Offline</span>
          </div>
          <p class="muted">Not present in Constructor search.</p>
        </div>
      `;
    }

    const sellers = (row.sellers || []).join(", ") || "—";
    const badges = (row.badges || []).join(", ") || "—";
    const link = row.url
      ? `<a class="market-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Open product</a>`
      : "—";

    return `
      <div class="pane">
        <div class="pane-top">
          <span class="market-tag">${market}</span>
          <span class="badge badge-online">Online</span>
        </div>
        <div class="meta">
          <div class="meta-row">
            <span class="meta-key">Price</span>
            <span class="meta-val">${escapeHtml(formatPrice(row.price))}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Seller</span>
            <span class="meta-val">${escapeHtml(sellers)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Badges</span>
            <span class="meta-val">${escapeHtml(badges)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Link</span>
            <span class="meta-val">${link}</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderSummary(groups, markets) {
    let onlineAu = 0;
    let onlineNz = 0;
    let offline = 0;

    for (const group of groups) {
      const au = group.markets.AU;
      const nz = group.markets.NZ;
      if (au?.online) onlineAu += 1;
      if (nz?.online) onlineNz += 1;
      for (const market of markets) {
        const row = group.markets[market];
        if (row && !row.online && !row.error) offline += 1;
      }
    }

    document.getElementById("sum-checked").textContent = String(groups.length);
    document.getElementById("sum-au").textContent = String(onlineAu);
    document.getElementById("sum-nz").textContent = String(onlineNz);
    document.getElementById("sum-off").textContent = String(offline);
    summary.hidden = false;
  }

  function renderResults(payload) {
    const groups = groupBySku(payload.results || []);
    const markets = payload.markets || ["AU", "NZ"];
    renderSummary(groups, markets);

    if (!groups.length) {
      empty.hidden = false;
      resultList.hidden = true;
      exportBtn.disabled = true;
      return;
    }

    empty.hidden = true;
    resultList.hidden = false;
    exportBtn.disabled = false;

    resultList.innerHTML = groups
      .map((group) => {
        const name =
          group.markets.AU?.name ||
          group.markets.NZ?.name ||
          "Untitled SKU";
        return `
          <article class="sku-block">
            <div class="sku-head">
              <p class="sku-code">${escapeHtml(group.sku)}</p>
              <p class="sku-name">${escapeHtml(name)}</p>
            </div>
            <div class="twin">
              ${paneHtml("AU", group.markets.AU)}
              ${paneHtml("NZ", group.markets.NZ)}
            </div>
          </article>
        `;
      })
      .join("");
  }

  function toCsv(payload) {
    const headers = [
      "checked_at",
      "market",
      "sku",
      "online",
      "name",
      "sellers",
      "badges",
      "price",
      "currency",
      "url",
      "error",
    ];
    const lines = [headers.join(",")];
    for (const row of payload.results || []) {
      const price = row.price || {};
      const values = [
        payload.checked_at || "",
        row.market || "",
        row.sku || "",
        row.online ? "YES" : "NO",
        row.name || "",
        (row.sellers || []).join("; "),
        (row.badges || []).join("; "),
        price.current ?? "",
        price.currency || "",
        row.url || "",
        row.error || "",
      ].map((value) => `"${String(value).replaceAll('"', '""')}"`);
      lines.push(values.join(","));
    }
    return lines.join("\n");
  }

  async function runCheck() {
    const skus = parseSkus(skuInput.value);
    errorBox.hidden = true;
    errorBox.textContent = "";

    if (!skus.length) {
      errorBox.hidden = false;
      errorBox.textContent = "Add at least one SKU, then try again.";
      skuInput.focus();
      return;
    }

    setBusy(true);
    empty.hidden = true;
    resultList.hidden = true;
    loading.hidden = false;
    statusLine.textContent = `Checking ${skus.length} SKU${skus.length === 1 ? "" : "s"}…`;

    try {
      const normalized = window.KmartConstructor.loadSkus(skus);
      const markets =
        selectedMarket === "both" ? ["AU", "NZ"] : [selectedMarket.toUpperCase()];
      const results = await window.KmartConstructor.runChecks(normalized, markets);
      const payload = {
        checked_at: new Date().toISOString(),
        skus: normalized,
        markets,
        results,
      };
      lastPayload = payload;
      loading.hidden = true;
      renderResults(payload);
      const stamp = new Date(payload.checked_at).toLocaleTimeString();
      statusLine.textContent = `Updated ${stamp}`;
    } catch (error) {
      loading.hidden = true;
      empty.hidden = false;
      summary.hidden = true;
      exportBtn.disabled = true;
      errorBox.hidden = false;
      errorBox.textContent = error.message || "Something went wrong while checking.";
      statusLine.textContent = "";
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!lastPayload) return;
    const blob = new Blob([toCsv(lastPayload)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sku-check-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  marketButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMarket(btn.dataset.market));
  });
  checkBtn.addEventListener("click", runCheck);
  exportBtn.addEventListener("click", exportCsv);
  skuInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      runCheck();
    }
  });

  fetch("/api/defaults")
    .then((response) => response.json())
    .then((payload) => {
      if (Array.isArray(payload.skus) && payload.skus.length && !skuInput.value.trim()) {
        skuInput.value = payload.skus.join("\n");
      }
    })
    .catch(() => {
      // Defaults are optional; the page still works without them.
    });
})();
