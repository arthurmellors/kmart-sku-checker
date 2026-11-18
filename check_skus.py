#!/usr/bin/env python3
"""Check whether Kmart SKUs are online via Constructor (AU + NZ)."""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONSTRUCTOR_BASE = "https://ac.cnstrc.com"
DEFAULT_WATCH_SECONDS = 180

MARKETS = {
    "AU": {
        "key": "key_GZTqlLr41FS2p7AY",
        "site": "https://www.kmart.com.au",
        "currency": "AUD",
        "states": ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"],
    },
    "NZ": {
        "key": "key_EyiTrcbGw7IFH3wR",
        "site": "https://www.kmart.co.nz",
        "currency": "NZD",
        "states": [],
    },
}

# From ko-ui-lib FulfillmentChannel / PIM_CALLOUT_MESSAGE
FULFILMENT_CHANNEL_LABELS = {
    0: "Coming Soon",
    1: "Online Exclusive",
    2: "In Store Only",
    3: "Online & In Store",
    4: "Click & Collect Only",
    5: "Online Exclusive (DC / Marketplace)",
}

# From ko-ui-lib SOH_CALLOUT_MESSAGE / STATE_OOS_CODE
STATE_OOS_LABELS = {
    "6": "Out of Stock Online",
    "7": "Back Online Soon",
    "8": "Out of Stock Online",
    "9": "Coming Soon",
}

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

CSV_FIELDS = [
    "checked_at",
    "market",
    "sku",
    "online",
    "name",
    "sellers",
    "badges",
    "price",
    "currency",
    "save_price",
    "national_inventory",
    "state_oos",
    "state_oos_summary",
    "fulfilment_channel",
    "fulfilment_label",
    "free_shipping",
    "free_shipping_metro",
    "url",
    "error",
]


def normalize_sku(raw: str) -> str:
    sku = raw.strip()
    if sku.upper().startswith("P_"):
        sku = sku[2:]
    return sku


def load_skus(values: list[str], file_path: str | None) -> list[str]:
    skus: list[str] = []
    for value in values:
        skus.append(normalize_sku(value))
    if file_path:
        with open(file_path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                skus.append(normalize_sku(line.split(",")[0].split()[0]))
    seen: set[str] = set()
    ordered: list[str] = []
    for sku in skus:
        if not sku or sku in seen:
            continue
        seen.add(sku)
        ordered.append(sku)
    return ordered


def request_json(url: str, referer: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Referer": referer + "/",
            "Origin": referer,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def constructor_search(sku: str, market: str) -> dict[str, Any]:
    cfg = MARKETS[market]
    params = urllib.parse.urlencode(
        {
            "key": cfg["key"],
            "num_results_per_page": 20,
            "page": 1,
            "section": "Products",
        }
    )
    path = urllib.parse.quote(sku, safe="")
    url = f"{CONSTRUCTOR_BASE}/search/{path}?{params}"
    started = time.perf_counter()
    payload = request_json(url, cfg["site"])
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    response = payload.get("response") if isinstance(payload, dict) else {}
    results = response.get("results") if isinstance(response, dict) else []
    return {
        "elapsed_ms": elapsed_ms,
        "total": response.get("total_num_results") if isinstance(response, dict) else 0,
        "results": results or [],
    }


def badge_labels(data: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    for key in ("badges", "variant_badges"):
        value = data.get(key) or []
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    labels.append(item.strip())
                elif isinstance(item, dict):
                    text = (
                        item.get("displayText")
                        or item.get("displayLabel")
                        or item.get("type")
                        or item.get("variant")
                    )
                    if text:
                        labels.append(str(text))
    marketplace = data.get("badgesMarketplace") or {}
    if isinstance(marketplace, dict):
        for group in marketplace.values():
            if not isinstance(group, list):
                continue
            for item in group:
                if not isinstance(item, dict):
                    continue
                text = item.get("displayLabel") or item.get("displayText") or item.get("variant")
                if text and str(text).lower() not in {"kmart", "kmart-target"}:
                    labels.append(str(text))
    seen: set[str] = set()
    out: list[str] = []
    for label in labels:
        if label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out


def price_summary(data: dict[str, Any], market: str) -> dict[str, Any]:
    currency = MARKETS[market]["currency"]
    prices = data.get("prices") or []
    list_amount = None
    promo_amount = None
    if isinstance(prices, list):
        for entry in prices:
            if not isinstance(entry, dict):
                continue
            amount = entry.get("amount")
            ptype = entry.get("type")
            if ptype == "list" and list_amount is None:
                list_amount = amount
            elif ptype == "promo" and promo_amount is None:
                promo_amount = amount
    current = data.get("price")
    if current is None and list_amount is not None:
        try:
            current = float(list_amount)
        except (TypeError, ValueError):
            current = list_amount
    return {
        "current": current,
        "list": list_amount,
        "promo": promo_amount,
        "save_price": data.get("SavePrice"),
        "currency": currency,
        "raw_prices": prices if isinstance(prices, list) else [],
    }


def exact_match(sku: str, item: dict[str, Any]) -> bool:
    data = item.get("data") if isinstance(item, dict) else None
    if not isinstance(data, dict):
        return False
    candidates = [
        data.get("variation_id"),
        data.get("id"),
        data.get("apn"),
    ]
    needle = sku.casefold()
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate)
        if text.casefold() == needle:
            return True
        if text.casefold() == f"p_{needle}":
            return True
        if needle.startswith("p_") and text.casefold() == needle[2:]:
            return True
    return False


def decode_state_oos(state_oos: Any, market: str) -> dict[str, Any]:
    if not isinstance(state_oos, dict) or not state_oos:
        return {
            "entries": [],
            "raw": None,
            "summary": "no state restrictions (treated as in-stock for checked states)",
            "oos_states": [],
            "coming_soon_states": [],
        }

    entries: list[str] = []
    oos_states: list[str] = []
    coming_soon_states: list[str] = []
    for state in sorted(state_oos.keys(), key=str):
        code = str(state_oos[state])
        label = STATE_OOS_LABELS.get(code, f"Unknown code {code}")
        entries.append(f"{state}:{code} ({label})")
        if code == "9":
            coming_soon_states.append(state)
        else:
            oos_states.append(state)

    known_states = MARKETS[market]["states"]
    if known_states:
        clear_states = [s for s in known_states if s not in state_oos]
        clear_bit = f"; clear: {','.join(clear_states)}" if clear_states else "; all listed states restricted"
    else:
        clear_bit = ""

    summary = (
        f"{len(oos_states)} OOS online, {len(coming_soon_states)} coming soon"
        f"{clear_bit}"
    )
    return {
        "entries": entries,
        "raw": state_oos,
        "summary": summary,
        "oos_states": oos_states,
        "coming_soon_states": coming_soon_states,
    }


def fulfilment_label(channel: Any) -> str | None:
    if channel is None:
        return None
    try:
        return FULFILMENT_CHANNEL_LABELS.get(int(channel), f"Unknown ({channel})")
    except (TypeError, ValueError):
        return f"Unknown ({channel})"


def parse_product(sku: str, market: str, item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data") if isinstance(item, dict) else {}
    if not isinstance(data, dict):
        data = {}
    cfg = MARKETS[market]
    path = data.get("url") or data.get("uri") or ""
    url = f"{cfg['site']}{path}" if path.startswith("/") else (path or None)
    sellers = data.get("Seller") or []
    if isinstance(sellers, str):
        sellers = [sellers]

    state_info = decode_state_oos(data.get("stateOOS"), market)
    channel = data.get("FulfilmentChannel")
    badges = badge_labels(data)
    if data.get("clearance") and "Clearance" not in badges:
        badges = ["Clearance", *badges]

    return {
        "online": True,
        "sku": str(data.get("variation_id") or sku),
        "product_id": data.get("id"),
        "name": item.get("value"),
        "brand": data.get("Brand"),
        "sellers": sellers,
        "badges": badges,
        "clearance": bool(data.get("clearance")),
        "price": price_summary(data, market),
        "national_inventory": data.get("nationalInventory"),
        "state_oos": state_info["entries"],
        "state_oos_summary": state_info["summary"],
        "state_oos_raw": state_info["raw"],
        "fulfilment_channel": channel,
        "fulfilment_label": fulfilment_label(channel),
        "free_shipping": data.get("FreeShipping"),
        "free_shipping_metro": data.get("FreeShippingMetro"),
        "preorder": bool(data.get("isPreOrderActive")),
        "colour": data.get("Colour"),
        "size": data.get("Size"),
        "apn": data.get("apn"),
        "url": url,
        "image_url": data.get("image_url"),
    }


def check_sku(sku: str, market: str) -> dict[str, Any]:
    try:
        search = constructor_search(sku, market)
    except urllib.error.HTTPError as exc:
        return {
            "online": False,
            "sku": sku,
            "market": market,
            "error": f"HTTP {exc.code}",
        }
    except urllib.error.URLError as exc:
        return {
            "online": False,
            "sku": sku,
            "market": market,
            "error": f"network error: {exc.reason}",
        }

    match = None
    for item in search["results"]:
        if exact_match(sku, item):
            match = item
            break

    if match is None:
        return {
            "online": False,
            "sku": sku,
            "market": market,
            "elapsed_ms": search["elapsed_ms"],
            "search_total": search["total"],
        }

    product = parse_product(sku, market, match)
    product.update(
        {
            "market": market,
            "elapsed_ms": search["elapsed_ms"],
            "search_total": search["total"],
        }
    )
    return product


def format_price(price: dict[str, Any] | None) -> str:
    if not price or price.get("current") is None:
        return "-"
    currency = price.get("currency") or ""
    current = price["current"]
    text = f"{currency} {current}"
    save = price.get("save_price")
    if save:
        text += f" ({save})"
    return text


def bool_text(value: Any) -> str:
    if value is None:
        return "-"
    return "Y" if value else "N"


def print_table(rows: list[dict[str, Any]]) -> None:
    headers = [
        "Market",
        "SKU",
        "Online",
        "Name",
        "Price",
        "Seller",
        "Badges",
        "Fulfilment",
        "NatInv",
        "StateOOS",
        "FreeShip",
    ]
    table_rows: list[list[str]] = []
    for row in rows:
        if row.get("error"):
            table_rows.append(
                [
                    str(row.get("market", "")),
                    str(row.get("sku", "")),
                    "ERROR",
                    row["error"],
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ]
            )
            continue
        sellers = ", ".join(row.get("sellers") or []) or "-"
        badges = ", ".join(row.get("badges") or []) or "-"
        name = row.get("name") or "-"
        if len(name) > 36:
            name = name[:33] + "..."
        fulfilment = row.get("fulfilment_label") or "-"
        if row.get("fulfilment_channel") is not None and fulfilment != "-":
            fulfilment = f"{row['fulfilment_channel']}:{fulfilment}"
        state = row.get("state_oos_summary") if row.get("online") else "-"
        if isinstance(state, str) and len(state) > 40:
            state = state[:37] + "..."
        free_ship = bool_text(row.get("free_shipping"))
        if row.get("free_shipping_metro") is not None:
            free_ship = f"{free_ship}/metro:{bool_text(row.get('free_shipping_metro'))}"
        table_rows.append(
            [
                str(row.get("market", "")),
                str(row.get("sku", "")),
                "YES" if row.get("online") else "NO",
                name if row.get("online") else "-",
                format_price(row.get("price")) if row.get("online") else "-",
                sellers if row.get("online") else "-",
                badges if row.get("online") else "-",
                fulfilment if row.get("online") else "-",
                bool_text(row.get("national_inventory")) if row.get("online") else "-",
                state or "-",
                free_ship if row.get("online") else "-",
            ]
        )

    widths = [len(h) for h in headers]
    for row in table_rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    def fmt(cols: list[str]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cols))

    print(fmt(headers))
    print(fmt(["-" * w for w in widths]))
    for row in table_rows:
        print(fmt(row))


def print_detail(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        print()
        print(f"[{row.get('market')}] SKU {row.get('sku')}")
        if row.get("error"):
            print(f"  error: {row['error']}")
            continue
        if not row.get("online"):
            print("  online: NO (not present in Constructor search)")
            continue
        print("  online: YES")
        print(f"  name: {row.get('name')}")
        print(f"  sellers: {', '.join(row.get('sellers') or []) or '-'}")
        print(f"  badges: {', '.join(row.get('badges') or []) or '-'}")
        print(f"  price: {format_price(row.get('price'))}")
        print(
            f"  fulfilment: {row.get('fulfilment_channel')} "
            f"({row.get('fulfilment_label') or 'unknown'})"
        )
        print(f"  national_inventory: {row.get('national_inventory')}")
        print(f"  state_oos_summary: {row.get('state_oos_summary')}")
        entries = row.get("state_oos") or []
        if entries:
            print(f"  state_oos: {'; '.join(entries)}")
        print(
            f"  free_shipping: {row.get('free_shipping')} "
            f"(metro={row.get('free_shipping_metro')})"
        )
        print(f"  url: {row.get('url')}")


def flatten_row(row: dict[str, Any], checked_at: str) -> dict[str, Any]:
    price = row.get("price") or {}
    return {
        "checked_at": checked_at,
        "market": row.get("market", ""),
        "sku": row.get("sku", ""),
        "online": "YES" if row.get("online") else "NO",
        "name": row.get("name") or "",
        "sellers": ", ".join(row.get("sellers") or []),
        "badges": ", ".join(row.get("badges") or []),
        "price": price.get("current") if isinstance(price, dict) else "",
        "currency": price.get("currency") if isinstance(price, dict) else "",
        "save_price": price.get("save_price") if isinstance(price, dict) else "",
        "national_inventory": row.get("national_inventory")
        if row.get("national_inventory") is not None
        else "",
        "state_oos": "; ".join(row.get("state_oos") or []),
        "state_oos_summary": row.get("state_oos_summary") or "",
        "fulfilment_channel": row.get("fulfilment_channel")
        if row.get("fulfilment_channel") is not None
        else "",
        "fulfilment_label": row.get("fulfilment_label") or "",
        "free_shipping": row.get("free_shipping")
        if row.get("free_shipping") is not None
        else "",
        "free_shipping_metro": row.get("free_shipping_metro")
        if row.get("free_shipping_metro") is not None
        else "",
        "url": row.get("url") or "",
        "error": row.get("error") or "",
    }


def write_csv(path: Path, rows: list[dict[str, Any]], checked_at: str, append: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not append or not path.exists() or path.stat().st_size == 0
    mode = "a" if append else "w"
    with path.open(mode, newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        if write_header:
            writer.writeheader()
        for row in rows:
            writer.writerow(flatten_row(row, checked_at))


def signature(row: dict[str, Any]) -> tuple[Any, ...]:
    price = row.get("price") or {}
    return (
        bool(row.get("online")),
        row.get("error"),
        tuple(row.get("sellers") or []),
        tuple(row.get("badges") or []),
        price.get("current") if isinstance(price, dict) else None,
        price.get("save_price") if isinstance(price, dict) else None,
        row.get("national_inventory"),
        tuple(row.get("state_oos") or []),
        row.get("fulfilment_channel"),
        row.get("free_shipping"),
        row.get("free_shipping_metro"),
    )


def print_changes(previous: list[dict[str, Any]] | None, current: list[dict[str, Any]]) -> None:
    if previous is None:
        print("Watch baseline captured.")
        return
    prev_map = {(r.get("market"), r.get("sku")): r for r in previous}
    changes = 0
    for row in current:
        key = (row.get("market"), row.get("sku"))
        old = prev_map.get(key)
        if old is None or signature(old) == signature(row):
            continue
        changes += 1
        old_online = "YES" if old.get("online") else "NO"
        new_online = "YES" if row.get("online") else "NO"
        print(
            f"CHANGE [{row.get('market')}] {row.get('sku')}: "
            f"online {old_online}->{new_online}; "
            f"price {format_price(old.get('price'))}->{format_price(row.get('price'))}; "
            f"sellers {', '.join(old.get('sellers') or []) or '-'}->"
            f"{', '.join(row.get('sellers') or []) or '-'}; "
            f"badges {', '.join(old.get('badges') or []) or '-'}->"
            f"{', '.join(row.get('badges') or []) or '-'}"
        )
    if changes == 0:
        print("No changes since last check.")


def run_checks(skus: list[str], markets: list[str], delay: float) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    first = True
    for sku in skus:
        for market in markets:
            if not first:
                time.sleep(max(0.0, delay))
            first = False
            results.append(check_sku(sku, market))
    return results


def emit_results(
    results: list[dict[str, Any]],
    *,
    as_json: bool,
    detail: bool,
    csv_path: Path | None,
    append_csv: bool,
    checked_at: str,
) -> None:
    if as_json:
        json.dump(
            {"checked_at": checked_at, "results": results},
            sys.stdout,
            indent=2,
            default=str,
        )
        print()
    elif detail:
        print_detail(results)
    else:
        print_table(results)

    if csv_path is not None:
        write_csv(csv_path, results, checked_at, append=append_csv)
        print(f"CSV written: {csv_path}", file=sys.stderr)


def exit_code_for(results: list[dict[str, Any]]) -> int:
    if any(r.get("error") for r in results):
        return 2
    if any(not r.get("online") and not r.get("error") for r in results):
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Check whether specific Kmart SKUs are online in AU and/or NZ "
            "using the public Constructor search API."
        ),
        epilog=(
            "Field meanings (from shopfront constants):\n"
            "  FulfilmentChannel: 0 Coming Soon, 1 Online Exclusive, 2 In Store Only,\n"
            "    3 Online & In Store, 4 Click & Collect Only, 5 Online Exclusive (DC/Marketplace)\n"
            "  stateOOS codes: 6/8 Out of Stock Online, 7 Back Online Soon, 9 Coming Soon\n"
            "    Presence of a state key means that state is restricted; missing key ~= in stock.\n"
            "  nationalInventory: product uses national inventory pool (not unit stock).\n"
            "  FreeShipping / FreeShippingMetro: product free-shipping eligibility flags."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("skus", nargs="*", help="SKU / keycode values (8-digit or P_########)")
    parser.add_argument(
        "-f",
        "--file",
        help="Text file with one SKU per line (# comments allowed)",
    )
    parser.add_argument(
        "-c",
        "--country",
        choices=["AU", "NZ", "both"],
        default="both",
        help="Market to check (default: both)",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument(
        "--detail",
        action="store_true",
        help="Print a detailed per-SKU report instead of a table",
    )
    parser.add_argument(
        "--csv",
        metavar="PATH",
        help="Write/append results to a CSV file",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help=f"Re-check every {DEFAULT_WATCH_SECONDS}s until Ctrl+C",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_WATCH_SECONDS,
        help=f"Watch interval in seconds (default: {DEFAULT_WATCH_SECONDS})",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.15,
        help="Delay between requests in seconds (default: 0.15)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    skus = load_skus(args.skus, args.file)
    if not skus:
        parser.error("Provide at least one SKU as an argument or via --file")

    markets = ["AU", "NZ"] if args.country == "both" else [args.country]
    csv_path = Path(args.csv) if args.csv else None

    if not args.watch:
        checked_at = datetime.now(timezone.utc).isoformat()
        results = run_checks(skus, markets, args.delay)
        emit_results(
            results,
            as_json=args.json,
            detail=args.detail,
            csv_path=csv_path,
            append_csv=False,
            checked_at=checked_at,
        )
        return exit_code_for(results)

    print(
        f"Watching {len(skus)} SKU(s) across {', '.join(markets)} "
        f"every {args.interval}s. Ctrl+C to stop.",
        file=sys.stderr,
    )
    previous: list[dict[str, Any]] | None = None
    last_code = 0
    try:
        while True:
            checked_at = datetime.now(timezone.utc).isoformat()
            print(f"\n=== check @ {checked_at} ===")
            results = run_checks(skus, markets, args.delay)
            emit_results(
                results,
                as_json=args.json,
                detail=args.detail,
                csv_path=csv_path,
                append_csv=True,
                checked_at=checked_at,
            )
            print_changes(previous, results)
            previous = results
            last_code = exit_code_for(results)
            time.sleep(max(1, args.interval))
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        return last_code


if __name__ == "__main__":
    raise SystemExit(main())
