#!/usr/bin/env python3
"""Bennys weekly benefit auditor.

Runs every Monday via GitHub Actions. Two passes:

  1. HOT PASS  - every benefit flagged "rotating": true is re-checked on
     EVERY run. These change on a schedule (quarterly 5% categories,
     choose-your-category cards) and are the ones most likely to be
     stale and most visible to users.

  2. SWEEP PASS - the rest of the catalog is divided into 4 slices by
     ISO week number, so every card is fully re-audited once a month
     while only ~1/4 of the catalog is queried each week. This keeps
     weekly cost close to what a monthly full run used to cost.

Only high-confidence changes are applied automatically. Medium-
confidence findings are quarantined into the report for a human to
read. The workflow opens a pull request; nothing reaches users until
that PR is merged.
"""

import json
import os
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests

MODEL = "claude-sonnet-4-6"
API = "https://api.anthropic.com/v1/messages"
ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / "benefits.json"
REPORT = ROOT / "AUDIT_REPORT.md"
PROMPT = ROOT / "audit_prompt.md"

VALID_RESETS = {"Calendar Year", "Card Anniversary", "Monthly",
                "Quarterly", "Semi-Annual", "Per Stay"}
SWEEP_SLICES = 4          # full catalog covered every 4 weeks
MAX_RETRIES = 3


def api_key():
    k = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not k:
        sys.exit("ANTHROPIC_API_KEY is not set - add it as a repository "
                 "secret named ANTHROPIC_API_KEY.")
    return k


def call_claude(system, user, key):
    body = {
        "model": MODEL,
        "max_tokens": 4000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "tools": [{"type": "web_search_20250305", "name": "web_search",
                   "max_uses": 6}],
    }
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.post(API, headers=headers, json=body, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            blocks = r.json().get("content", [])
            return "".join(b.get("text", "") for b in blocks
                           if b.get("type") == "text")
        except requests.RequestException:
            if attempt == MAX_RETRIES - 1:
                return ""
            time.sleep(5 * (attempt + 1))
    return ""


def extract_json(text):
    """Pull the first {...} object out of a model reply."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = fenced.group(1) if fenced else None
    if raw is None:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        raw = text[start:end + 1]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def valid_benefit(b):
    return (isinstance(b, dict)
            and isinstance(b.get("benefit"), str)
            and 3 <= len(b["benefit"]) <= 120
            and "||" not in b["benefit"]
            and isinstance(b.get("value"), (int, float))
            and b["value"] >= 0
            and b.get("reset") in VALID_RESETS
            and isinstance(b.get("desc"), str)
            and 15 <= len(b["desc"]) <= 700)


def audit_card(card_name, card, key, hot_only):
    """Ask the model to verify one card. Returns a parsed result dict."""
    focus = ("ONLY re-verify the benefits marked \"rotating\": true - "
             "specifically the current quarter's bonus categories, the "
             "activation deadline, and the spending cap."
             if hot_only else
             "Verify every benefit: annual credits, statement credits, "
             "free nights, companion certificates, elite status, lounge "
             "access, AND the point/cash-back multipliers. Multipliers "
             "matter as much as credits - if an earn rate changed, say so.")
    payload = {
        "card": card_name,
        "official_name": card.get("full_name", card_name),
        "issuer_meta": card["meta"],
        "annual_fee": card["annual_fee"],
        "benefits": card["benefits"],
    }
    user = (
        f"Today is {date.today().isoformat()}.\n\n"
        f"{focus}\n\n"
        "Search the issuer's own website and newsroom FIRST "
        "(chase.com / media.chase.com, americanexpress.com, citi.com, "
        "capitalone.com, discover.com, usbank.com, etc). Use at most two "
        "reputable secondary sources only to corroborate. If the issuer "
        "page and a blog disagree, the issuer wins.\n\n"
        "Current catalog entry:\n"
        f"{json.dumps(payload, indent=1)}\n\n"
        "Reply with ONLY the JSON object described in your instructions."
    )
    text = call_claude(PROMPT.read_text(), user, key)
    return extract_json(text)


def main():
    key = api_key()
    cat = json.loads(CATALOG.read_text())
    cards = cat["cards"]
    names = sorted(cards.keys())

    week = datetime.utcnow().isocalendar()[1]
    slice_idx = week % SWEEP_SLICES
    sweep = [n for i, n in enumerate(names) if i % SWEEP_SLICES == slice_idx]
    hot = [n for n in names
           if any(b.get("rotating") for b in cards[n]["benefits"])]
    # hot cards are checked every week; don't double-charge for them
    todo = [(n, True) for n in hot] + \
           [(n, False) for n in sweep if n not in hot]

    applied, quarantined, failures = [], [], []

    for card_name, hot_only in todo:
        res = audit_card(card_name, cards[card_name], key, hot_only)
        if not res:
            failures.append(card_name)
            continue

        for ch in res.get("changes", []):
            target = ch.get("benefit")
            conf = ch.get("confidence")
            new = ch.get("new_value", {})
            idx = next((i for i, b in enumerate(cards[card_name]["benefits"])
                        if b["benefit"] == target), None)
            if idx is None:
                quarantined.append((card_name, target, "benefit not found",
                                    ch.get("evidence", "")))
                continue
            merged = dict(cards[card_name]["benefits"][idx])
            merged.update({k: v for k, v in new.items()
                           if k in ("benefit", "value", "reset", "desc")})
            if not valid_benefit(merged):
                quarantined.append((card_name, target, "failed validation",
                                    ch.get("evidence", "")))
                continue
            if conf == "high":
                merged["rotating"] = cards[card_name]["benefits"][idx].get(
                    "rotating", False)
                cards[card_name]["benefits"][idx] = merged
                applied.append((card_name, target, ch.get("summary", ""),
                                ch.get("evidence", "")))
            else:
                quarantined.append((card_name, target,
                                    ch.get("summary", ""),
                                    ch.get("evidence", "")))

        for add in res.get("added", []):
            if add.get("confidence") == "high" and valid_benefit(add):
                existing = {b["benefit"] for b in cards[card_name]["benefits"]}
                if add["benefit"] not in existing:
                    cards[card_name]["benefits"].append(
                        {k: add[k] for k in ("benefit", "value", "reset",
                                             "desc")})
                    applied.append((card_name, add["benefit"],
                                    "NEW benefit added",
                                    add.get("evidence", "")))
            elif add:
                quarantined.append((card_name, add.get("benefit", "?"),
                                    "new benefit, needs review",
                                    add.get("evidence", "")))

        for rem in res.get("removed", []):
            # never auto-delete; a wrong removal silently costs users money
            quarantined.append((card_name, rem.get("benefit", "?"),
                                "REMOVAL suggested: " + rem.get("summary", ""),
                                rem.get("evidence", "")))

        for note in res.get("needs_human_review", []):
            quarantined.append((card_name, note.get("benefit", "-"),
                                note.get("summary", ""),
                                note.get("evidence", "")))

    # keep anniversary flags honest after any edits
    for c in cards.values():
        c["has_anniversary_benefits"] = any(
            b["reset"] == "Card Anniversary" for b in c["benefits"])

    if applied:
        cat["catalog_version"] = date.today().isoformat()
        cat["audited"] = (f"weekly auditor {date.today().isoformat()}: "
                          f"{len(applied)} change(s) applied")
        CATALOG.write_text(json.dumps(cat, indent=1))

    lines = [f"# Bennys audit - {date.today().isoformat()}", "",
             f"- Rotating-category cards checked (every week): {len(hot)}",
             f"- Sweep slice {slice_idx + 1} of {SWEEP_SLICES}: "
             f"{len([1 for n, h in todo if not h])} cards",
             f"- Applied automatically (high confidence): {len(applied)}",
             f"- Needs your eyes: {len(quarantined)}",
             f"- Cards the model could not check: {len(failures)}", ""]
    if applied:
        lines += ["## Applied", ""]
        for c, b, s, e in applied:
            lines += [f"**{c} - {b}**", f"{s}", f"_evidence:_ {e}", ""]
    if quarantined:
        lines += ["## Quarantined (not applied - review these)", ""]
        for c, b, s, e in quarantined:
            lines += [f"**{c} - {b}**", f"{s}", f"_evidence:_ {e}", ""]
    if failures:
        lines += ["## Could not check", "", ", ".join(failures), ""]
    REPORT.write_text("\n".join(lines))

    print(f"audited {len(todo)} cards | applied {len(applied)} | "
          f"quarantined {len(quarantined)} | failed {len(failures)}")


if __name__ == "__main__":
    main()
