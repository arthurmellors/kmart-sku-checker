(() => {
  const skuInput = document.getElementById("sku-input");
  const checkBtn = document.getElementById("check-btn");
  const exportBtn = document.getElementById("export-btn");
  const statusLine = document.getElementById("status-line");
  const summary = document.getElementById("summary");
  const empty = document.getElementById("empty");
  const loading = document.getElementById("loading");
  const errorBox = document.getElementById("error-box");
  const resultList = document.getElementById("result-list");

  // Market toggle hidden for now — AU only.
  const selectedMarket = "AU";
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

  function isOnline(row) {
    return Boolean(row && row.online && !row.error);
  }

  function viewProductCta(url) {
    if (!url) return "";
    return `<a class="product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View product</a>`;
  }

  function stockMetaLine(row) {
    const parts = [];
    if (row.stock_label) parts.push(row.stock_label);
    else if (row.stock_detail) parts.push(row.stock_detail);
    if (row.fulfilment_label) parts.push(row.fulfilment_label);
    if (row.free_shipping) parts.push("Free shipping");
    return parts.join(" · ");
  }

  function paneHtml(market, row) {
    if (!row) return "";

    if (row.error) {
      return `
        <div class="pane">
          <div class="presence-row">
            <span class="market-tag">${market}</span>
            <span class="badge badge-error">Error</span>
          </div>
          <p class="pane-note">${escapeHtml(row.error)}</p>
        </div>
      `;
    }

    if (!row.online) {
      return `
        <div class="pane">
          <div class="presence-row">
            <span class="market-tag">${market}</span>
            <span class="badge badge-offline">Offline</span>
          </div>
          <p class="pane-note">Not in catalogue</p>
        </div>
      `;
    }

    const sellers = (row.sellers || []).filter(Boolean).join(", ");
    const meta = stockMetaLine(row);
    const merchBadges = (row.badges || []).filter(Boolean);
    const badgeHtml = merchBadges.length
      ? `<div class="chip-row">${merchBadges
          .slice(0, 2)
          .map((badge) => `<span class="chip">${escapeHtml(badge)}</span>`)
          .join("")}</div>`
      : "";

    return `
      <div class="pane">
        <div class="presence-row">
          <span class="market-tag">${market}</span>
          <span class="badge badge-online">Online</span>
        </div>
        <p class="pane-price">${escapeHtml(formatPrice(row.price))}</p>
        ${sellers ? `<p class="pane-seller">${escapeHtml(sellers)}</p>` : ""}
        ${meta ? `<p class="pane-meta">${escapeHtml(meta)}</p>` : ""}
        ${badgeHtml}
        ${
          row.url
            ? `<div class="pane-actions">${viewProductCta(row.url)}</div>`
            : ""
        }
      </div>
    `;
  }

  function cardHtml(group, markets) {
    const name =
      group.markets.AU?.name ||
      group.markets.NZ?.name ||
      "Untitled SKU";
    const imageUrl =
      group.markets.AU?.image_url || group.markets.NZ?.image_url || null;
    const media = imageUrl
      ? `<img class="sku-thumb" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />`
      : `<div class="sku-thumb sku-thumb-fallback" aria-hidden="true"></div>`;

    const panes = markets
      .map((market) => paneHtml(market, group.markets[market]))
      .filter(Boolean)
      .join("");

    // Single market → vertical PLP-style tile (Shopfront ProductGrid).
    // Both markets → identity strip + AU|NZ twin panes.
    if (markets.length === 1) {
      const market = markets[0];
      return `
        <article class="sku-block sku-block--plp">
          <div class="plp-media">${media}</div>
          <div class="plp-body">
            <h3 class="sku-name">${escapeHtml(name)}</h3>
            <p class="sku-code">${escapeHtml(group.sku)}</p>
            ${paneHtml(market, group.markets[market])}
          </div>
        </article>
      `;
    }

    return `
      <article class="sku-block sku-block--twin">
        <div class="sku-identity">
          ${media}
          <div class="sku-identity-copy">
            <h3 class="sku-name">${escapeHtml(name)}</h3>
            <p class="sku-code">${escapeHtml(group.sku)}</p>
          </div>
        </div>
        <div class="twin">
          ${panes}
        </div>
      </article>
    `;
  }

  function renderSummary(groups) {
    let online = 0;
    let offline = 0;

    for (const group of groups) {
      const au = group.markets.AU;
      if (isOnline(au)) online += 1;
      else if (au && !au.error) offline += 1;
    }

    document.getElementById("sum-checked").textContent = String(groups.length);
    document.getElementById("sum-au").textContent = String(online);
    document.getElementById("sum-off").textContent = String(offline);
    summary.hidden = false;
  }

  function renderResults(payload) {
    const groups = groupBySku(payload.results || []);
    const markets = payload.markets || ["AU", "NZ"];
    renderSummary(groups);

    if (!groups.length) {
      empty.hidden = false;
      resultList.hidden = true;
      resultList.innerHTML = "";
      exportBtn.disabled = true;
      return;
    }

    empty.hidden = true;
    resultList.hidden = false;
    exportBtn.disabled = false;
    resultList.classList.toggle("grid-plp", markets.length === 1);
    resultList.classList.toggle("grid-3", markets.length > 1);
    resultList.innerHTML = groups
      .map((group) => cardHtml(group, markets))
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
      "fulfilment",
      "stock",
      "national_inventory",
      "free_shipping",
      "url",
      "image_url",
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
        row.fulfilment_label || "",
        row.stock_detail || row.stock_label || "",
        row.national_inventory ? "YES" : "NO",
        row.free_shipping ? "YES" : "NO",
        row.url || "",
        row.image_url || "",
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
    resultList.innerHTML = "";
    summary.hidden = true;
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
      resultList.hidden = true;
      resultList.innerHTML = "";
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
