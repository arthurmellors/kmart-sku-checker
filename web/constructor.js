/**
 * Browser-side Constructor search for Kmart AU / NZ.
 * Mirrors the Python CLI logic in check_skus.py.
 */
(() => {
  const CONSTRUCTOR_BASE = "https://ac.cnstrc.com";

  const MARKETS = {
    AU: {
      key: "key_GZTqlLr41FS2p7AY",
      site: "https://www.kmart.com.au",
      currency: "AUD",
      states: ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"],
    },
    NZ: {
      key: "key_EyiTrcbGw7IFH3wR",
      site: "https://www.kmart.co.nz",
      currency: "NZD",
      states: [],
    },
  };

  const FULFILMENT_CHANNEL_LABELS = {
    0: "Coming Soon",
    1: "Online Exclusive",
    2: "In Store Only",
    3: "Online & In Store",
    4: "Click & Collect Only",
    5: "Online Exclusive (DC / Marketplace)",
  };

  const STATE_OOS_LABELS = {
    6: "Out of Stock Online",
    7: "Back Online Soon",
    8: "Out of Stock Online",
    9: "Coming Soon",
  };

  function normalizeSku(raw) {
    let sku = String(raw || "").trim();
    if (sku.toUpperCase().startsWith("P_")) sku = sku.slice(2);
    return sku;
  }

  function loadSkus(values) {
    const seen = new Set();
    const ordered = [];
    for (const value of values) {
      const sku = normalizeSku(value);
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      ordered.push(sku);
    }
    return ordered;
  }

  function badgeLabels(data) {
    const labels = [];
    for (const key of ["badges", "variant_badges"]) {
      const value = data[key] || [];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === "string" && item.trim()) labels.push(item.trim());
        else if (item && typeof item === "object") {
          const text = item.displayText || item.displayLabel || item.type || item.variant;
          if (text) labels.push(String(text));
        }
      }
    }
    const marketplace = data.badgesMarketplace || {};
    for (const group of Object.values(marketplace)) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (!item || typeof item !== "object") continue;
        const text = item.displayLabel || item.displayText || item.variant;
        if (text && !["kmart", "kmart-target"].includes(String(text).toLowerCase())) {
          labels.push(String(text));
        }
      }
    }
    return [...new Set(labels)];
  }

  function priceSummary(data, market) {
    const currency = MARKETS[market].currency;
    const prices = Array.isArray(data.prices) ? data.prices : [];
    let listAmount = null;
    let promoAmount = null;
    for (const entry of prices) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "list" && listAmount === null) listAmount = entry.amount;
      if (entry.type === "promo" && promoAmount === null) promoAmount = entry.amount;
    }
    let current = data.price;
    if (current == null && listAmount != null) {
      const parsed = Number(listAmount);
      current = Number.isFinite(parsed) ? parsed : listAmount;
    }
    return {
      current,
      list: listAmount,
      promo: promoAmount,
      save_price: data.SavePrice || null,
      currency,
      raw_prices: prices,
    };
  }

  function exactMatch(sku, item) {
    const data = item && item.data;
    if (!data || typeof data !== "object") return false;
    const needle = sku.toLowerCase();
    for (const candidate of [data.variation_id, data.id, data.apn]) {
      if (candidate == null) continue;
      const text = String(candidate).toLowerCase();
      if (text === needle || text === `p_${needle}`) return true;
      if (needle.startsWith("p_") && text === needle.slice(2)) return true;
    }
    return false;
  }

  function decodeStateOos(stateOos, market) {
    if (!stateOos || typeof stateOos !== "object" || !Object.keys(stateOos).length) {
      const known = MARKETS[market].states;
      return {
        entries: [],
        summary: known.length
          ? "In stock online (all states)"
          : "No state stock restrictions",
        label: known.length ? "In stock online" : "No restrictions listed",
        oos_states: [],
        back_soon_states: [],
        coming_soon_states: [],
        clear_states: known.slice(),
      };
    }
    const entries = [];
    const oosStates = [];
    const backSoonStates = [];
    const comingSoonStates = [];
    for (const state of Object.keys(stateOos).sort()) {
      const code = String(stateOos[state]);
      const label = STATE_OOS_LABELS[code] || `Unknown code ${code}`;
      entries.push(`${state}:${code} (${label})`);
      if (code === "9") comingSoonStates.push(state);
      else if (code === "7") backSoonStates.push(state);
      else oosStates.push(state);
    }
    const known = MARKETS[market].states;
    const clear = known.filter((s) => !(s in stateOos));
    const parts = [];
    if (oosStates.length) parts.push(`OOS: ${oosStates.join(", ")}`);
    if (backSoonStates.length) parts.push(`Back soon: ${backSoonStates.join(", ")}`);
    if (comingSoonStates.length) parts.push(`Coming soon: ${comingSoonStates.join(", ")}`);
    if (clear.length) parts.push(`In stock: ${clear.join(", ")}`);
    else if (known.length) parts.push("All listed states restricted");
    return {
      entries,
      summary: parts.join(" · ") || `${oosStates.length} OOS online, ${comingSoonStates.length} coming soon`,
      label: parts[0] || "Stock restricted",
      oos_states: oosStates,
      back_soon_states: backSoonStates,
      coming_soon_states: comingSoonStates,
      clear_states: clear,
    };
  }

  function fulfilmentLabel(channel) {
    if (channel == null) return null;
    const n = Number(channel);
    return FULFILMENT_CHANNEL_LABELS[n] || `Unknown (${channel})`;
  }

  function parseProduct(sku, market, item) {
    const data = (item && item.data) || {};
    const cfg = MARKETS[market];
    const path = data.url || data.uri || "";
    const url = path.startsWith("/") ? `${cfg.site}${path}` : path || null;
    let sellers = data.Seller || [];
    if (typeof sellers === "string") sellers = [sellers];
    const stateInfo = decodeStateOos(data.stateOOS, market);
    const badges = badgeLabels(data);
    if (data.clearance && !badges.includes("Clearance")) badges.unshift("Clearance");
    return {
      online: true,
      sku: String(data.variation_id || sku),
      product_id: data.id || null,
      name: item.value || null,
      brand: data.Brand || null,
      sellers,
      badges,
      clearance: Boolean(data.clearance),
      price: priceSummary(data, market),
      national_inventory: data.nationalInventory,
      state_oos: stateInfo.entries,
      state_oos_summary: stateInfo.summary,
      stock_label: stateInfo.label,
      stock_detail: stateInfo.summary,
      oos_states: stateInfo.oos_states,
      back_soon_states: stateInfo.back_soon_states,
      coming_soon_states: stateInfo.coming_soon_states,
      clear_states: stateInfo.clear_states,
      fulfilment_channel: data.FulfilmentChannel,
      fulfilment_label: fulfilmentLabel(data.FulfilmentChannel),
      free_shipping: data.FreeShipping,
      free_shipping_metro: data.FreeShippingMetro,
      url,
      image_url: data.image_url || null,
    };
  }

  async function constructorSearch(sku, market) {
    const cfg = MARKETS[market];
    const params = new URLSearchParams({
      key: cfg.key,
      num_results_per_page: "20",
      page: "1",
      section: "Products",
    });
    const url = `${CONSTRUCTOR_BASE}/search/${encodeURIComponent(sku)}?${params}`;
    const started = performance.now();
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const elapsedMs = Math.round(performance.now() - started);
    const results = (payload.response && payload.response.results) || [];
    return {
      elapsed_ms: elapsedMs,
      total: payload.response ? payload.response.total_num_results : 0,
      results,
    };
  }

  async function checkSku(sku, market) {
    try {
      const search = await constructorSearch(sku, market);
      const match = search.results.find((item) => exactMatch(sku, item));
      if (!match) {
        return {
          online: false,
          sku,
          market,
          elapsed_ms: search.elapsed_ms,
          search_total: search.total,
        };
      }
      return {
        ...parseProduct(sku, market, match),
        market,
        elapsed_ms: search.elapsed_ms,
        search_total: search.total,
      };
    } catch (error) {
      return {
        online: false,
        sku,
        market,
        error: error.message || "network error",
      };
    }
  }

  async function runChecks(skus, markets, delayMs = 120) {
    const results = [];
    let first = true;
    for (const sku of skus) {
      for (const market of markets) {
        if (!first) await new Promise((r) => setTimeout(r, delayMs));
        first = false;
        results.push(await checkSku(sku, market));
      }
    }
    return results;
  }

  window.KmartConstructor = {
    MARKETS,
    loadSkus,
    runChecks,
  };
})();
