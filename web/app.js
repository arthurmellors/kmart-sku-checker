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

  function formatPriceHtml(price) {
    if (!price || price.current === null || price.current === undefined) {
      return `<p class="pane-price pane-price--empty">—</p>`;
    }
    const amount = String(price.current);
    const save = price.save_price
      ? `<span class="price-save">${escapeHtml(String(price.save_price))}</span>`
      : "";
    return `<p class="pane-price"><span class="price-currency">$</span><span class="price-amount">${escapeHtml(
      amount
    )}</span>${save}</p>`;
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

  function stockMetaLine(row) {
    const parts = [];
    if (row.stock_label) parts.push(row.stock_label);
    else if (row.stock_detail) parts.push(row.stock_detail);
    if (row.fulfilment_label) parts.push(row.fulfilment_label);
    if (row.free_shipping) parts.push("Free shipping");
    return parts.join(" · ");
  }

  function statusBadge(row) {
    if (!row) return `<span class="badge badge-offline">Not checked</span>`;
    if (row.error) return `<span class="badge badge-error">Error</span>`;
    if (!row.online) return `<span class="badge badge-offline">Offline</span>`;
    return `<span class="badge badge-online">Online</span>`;
  }

  function cardHtml(group) {
    const row = group.markets.AU || group.markets.NZ || null;
    const name = row?.name || "Untitled SKU";
    const imageUrl = row?.image_url || null;
    const media = imageUrl
      ? `<img class="sku-thumb" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />`
      : `<div class="sku-thumb sku-thumb-fallback" aria-hidden="true"></div>`;

    const sellers = (row?.sellers || []).filter(Boolean);
    const seller = sellers[0] || "Kmart";
    const meta = row?.online ? stockMetaLine(row) : row?.error || "Not in catalogue";
    const online = isOnline(row);
    const href = online && row?.url ? row.url : null;

    const inner = `
      <div class="plp-media">
        ${media}
        <div class="plp-status">${statusBadge(row)}</div>
      </div>
      <div class="plp-body">
        <div class="seller-row">
          <span class="seller-badge">${escapeHtml(seller)}</span>
        </div>
        <h3 class="sku-name">${escapeHtml(name)}</h3>
        ${online ? formatPriceHtml(row.price) : `<p class="pane-price pane-price--empty">—</p>`}
        <div class="plp-utility">
          <p class="sku-code">${escapeHtml(group.sku)}</p>
          <p class="pane-meta">${escapeHtml(meta)}</p>
        </div>
      </div>
    `;

    if (href) {
      return `
        <a class="sku-block sku-block--plp is-clickable" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
          ${inner}
        </a>
      `;
    }

    return `
      <article class="sku-block sku-block--plp is-static" aria-label="${escapeHtml(name)}">
        ${inner}
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
    resultList.classList.add("grid-plp");
    resultList.classList.remove("grid-3");
    resultList.innerHTML = groups.map((group) => cardHtml(group)).join("");
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
