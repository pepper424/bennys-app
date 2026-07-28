/* stackNtrack logic engine - pure functions, no DOM, no network.
   Loaded in the browser via <script> and in Node via require() for tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BennysLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var NOTE_MAX = 100;                 // characters, per note

  function cleanNote(t) {
    return String(t == null ? "" : t)
      .replace(/[\r\n\t]+/g, " ")     // keep notes to a single tidy line
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, NOTE_MAX);
  }

  var EXPIRE_SOON_DAYS = 30;          // monthly credits
  var EXPIRE_SOON_DAYS_LONG = 60;     // quarterly, semi-annual, annual

  function warnWindow(reset) {
    return reset === "Monthly" ? EXPIRE_SOON_DAYS : EXPIRE_SOON_DAYS_LONG;
  }

  var MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun",
                      "Jul","Aug","Sep","Oct","Nov","Dec"];
  var MONTH_FULL = ["January","February","March","April","May","June",
                    "July","August","September","October","November",
                    "December"];
  var PERIOD_LABELS = {
    "Monthly": MONTH_LABELS,
    "Quarterly": ["Q1","Q2","Q3","Q4"],
    "Semi-Annual": ["H1","H2"]
  };
  var RECURRING = { "Monthly": 12, "Quarterly": 4, "Semi-Annual": 2 };

  function ymd(y, m, d) {            // month is 1-12
    return new Date(Date.UTC(y, m - 1, d));
  }
  function today(now) {
    var n = now || new Date();
    return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }
  function daysBetween(a, b) {       // b - a in whole days
    return Math.round((b - a) / 86400000);
  }
  function lastDayOfMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function clampDay(y, m, d) {
    return Math.min(d, lastDayOfMonth(y, m));
  }
  function iso(dt) {
    return dt ? dt.toISOString().slice(0, 10) : null;
  }
  function fromISO(s) {
    if (!s) return null;
    var p = s.split("-").map(Number);
    return ymd(p[0], p[1], p[2]);
  }

  /* ---- period ends ---- */
  function calendarYearEnd(t)  { return ymd(t.getUTCFullYear(), 12, 31); }
  function monthEnd(t) {
    var y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
    return ymd(y, m, lastDayOfMonth(y, m));
  }
  function quarterEnd(t) {
    var q = Math.floor(t.getUTCMonth() / 3);           // 0..3
    var m = (q + 1) * 3;                               // 3,6,9,12
    return ymd(t.getUTCFullYear(), m, lastDayOfMonth(t.getUTCFullYear(), m));
  }
  function halfEnd(t) {
    var m = t.getUTCMonth() < 6 ? 6 : 12;
    return ymd(t.getUTCFullYear(), m, lastDayOfMonth(t.getUTCFullYear(), m));
  }
  function nextAnniversary(annISO, t) {
    var a = fromISO(annISO);
    if (!a) return null;
    var m = a.getUTCMonth() + 1, d = a.getUTCDate();
    var y = t.getUTCFullYear();
    var cand = ymd(y, m, clampDay(y, m, d));   // Feb 29 -> Feb 28 off-leap
    if (cand <= t) {
      y += 1;
      cand = ymd(y, m, clampDay(y, m, d));
    }
    return cand;
  }
  function placeholderAnniversary(t) {         // unknown date: Jan 1 next yr
    return ymd(t.getUTCFullYear() + 1, 1, 1);
  }

  function expiryFor(reset, annISO, t) {
    switch (reset) {
      case "Calendar Year": return calendarYearEnd(t);
      case "Monthly":       return monthEnd(t);
      case "Quarterly":     return quarterEnd(t);
      case "Semi-Annual":   return halfEnd(t);
      case "Card Anniversary":
        return annISO ? nextAnniversary(annISO, t)
                      : placeholderAnniversary(t);
      case "Per Stay":      return null;
      default:              return null;
    }
  }

  function currentPeriod(reset, t) {
    if (reset === "Monthly")     return t.getUTCMonth();          // 0-11
    if (reset === "Quarterly")   return Math.floor(t.getUTCMonth() / 3);
    if (reset === "Semi-Annual") return t.getUTCMonth() < 6 ? 0 : 1;
    return null;
  }

  /* Human name for the period currently at risk: "July", "Q3", "H2".
     Returns null for benefits that do not run on periods. */
  function periodLabel(b, now) {
    var t = today(now);
    var p = currentPeriod(b.reset, t);
    if (p === null) return null;
    if (b.reset === "Monthly") return MONTH_FULL[p];
    if (b.reset === "Quarterly") return "Q" + (p + 1);
    if (b.reset === "Semi-Annual") return p === 0 ? "H1" : "H2";
    return null;
  }

  /* ---- tiers (travel-priority ordering) ---- */
  function tier(b) {
    var s = (b.benefit + " " + b.desc).toLowerCase();
    function any(words) {
      return words.some(function (w) { return s.indexOf(w) >= 0; });
    }
    if (any(["hotel","resort","free night","fnc","fna","night award",
             "marriott","hilton","hyatt","ihg","wyndham","bonvoy",
             "stays","property credit","suite"])) return 0;
    if (any(["uber","lyft","rideshare","grubhub","doordash","dashpass",
             "instacart","resy","food delivery"])) return 2;
    if (any(["dining","restaurant"])) return 2;
    if (any(["flight","airline","airfare","travelbank","companion",
             "lounge","club access","sky club","admirals","priority pass",
             "clear","global entry","tsa","precheck","award","bag",
             "boarding","inflight"])) return 3;
    if (any(["saks","equinox","soulcycle","walmart+","peacock","apple tv",
             "streaming","disney","entertainment","retail","shopping",
             "lifestyle","wellness","gym","spa"])) return 4;
    if (any(["status","elite","credit each","spend","anniversary points",
             "points bonus","multiplier","cash back","per stay",
             "everything"])) return 5;
    return 4;
  }

  /* ---- build a user's benefit list from profile + catalog ---- */
  function stateKey(card, benefit) { return card + "||" + benefit; }

  function buildBenefits(catalog, profile, now) {
    var t = today(now);
    var out = [];
    var hidden = {};
    (profile.hidden || []).forEach(function (k) { hidden[k] = 1; });
    var order = Object.keys(catalog.cards);
    order.forEach(function (card) {
      if (profile.cards.indexOf(card) < 0) return;
      var annISO = (profile.anniversaries || {})[card] || null;
      catalog.cards[card].benefits.forEach(function (b) {
        var key = stateKey(card, b.benefit);
        if (hidden[key]) return;
        var saved = (profile.state || {})[key];
        var entry = {
          card: card, benefit: b.benefit, value: b.value,
          reset: b.reset, desc: b.desc, key: key,
          currency: catalog.cards[card].currency || "USD",
          note: (profile.notes || {})[key] || "",
          expires: expiryFor(b.reset, annISO, t)
        };
        if (RECURRING[b.reset]) {
          entry.used_periods = (saved && saved.used_periods) ?
            saved.used_periods.slice() : [];
          entry.available =
            entry.used_periods.indexOf(currentPeriod(b.reset, t)) < 0;
        } else {
          entry.available = !(saved && saved.used === true);
        }
        out.push(entry);
      });
    });
    return out;
  }

  function snapshotState(benefits) {
    var st = {};
    benefits.forEach(function (b) {
      if (RECURRING[b.reset]) {
        if (b.used_periods && b.used_periods.length) {
          st[b.key] = { used_periods: b.used_periods.slice() };
        }
      } else if (!b.available) {
        st[b.key] = { used: true };
      }
    });
    return st;
  }

  /* ---- value accounting ----
     A $10/month credit is worth $120 over a year, and each flipped
     month captures $10 of it. Per Stay benefits have no fixed annual
     value, so they contribute nothing to these totals. */
  function periodsPerYear(reset) {
    if (RECURRING[reset]) return RECURRING[reset];
    if (reset === "Per Stay") return 0;
    return 1;
  }
  function annualValue(b) {
    return (b.value || 0) * periodsPerYear(b.reset);
  }
  function usedValue(b) {
    if (!b.value) return 0;
    if (RECURRING[b.reset]) {
      return b.value * ((b.used_periods || []).length);
    }
    return b.available ? 0 : b.value;
  }
  function remainingValue(b) {
    return Math.max(0, annualValue(b) - usedValue(b));
  }
  /* Roll a list of benefits up per currency. */
  function summarize(list) {
    var byCur = {}, dominant = null, best = -1;
    list.forEach(function (b) {
      var a = annualValue(b);
      if (!a) return;
      var c = b.currency || "USD";
      if (!byCur[c]) byCur[c] = { total: 0, used: 0, left: 0 };
      byCur[c].total += a;
      byCur[c].used += usedValue(b);
      byCur[c].left += remainingValue(b);
    });
    Object.keys(byCur).forEach(function (c) {
      if (byCur[c].total > best) { best = byCur[c].total; dominant = c; }
    });
    return { byCur: byCur, dominant: dominant };
  }

  function daysRemaining(b, now) {
    if (!b.expires) return null;
    return daysBetween(today(now), b.expires);
  }
  function isExpiringSoon(b, now) {
    if (!b.available || !b.expires) return false;
    var d = daysRemaining(b, now);
    return d !== null && d >= 0 && d <= warnWindow(b.reset);
  }

  /* A user-chosen order for one card's credits. Keys the user has
     never seen (a newly added benefit, or one restored from hidden)
     are not in their saved list - those fall to the bottom in the
     normal default order rather than vanishing or jumping to the top. */
  function applyCustomOrder(list, orderKeys, now) {
    if (!orderKeys || !orderKeys.length) return sortGroup(list, now);
    var rank = {};
    orderKeys.forEach(function (k, i) { rank[k] = i; });
    var known = [], unknown = [];
    list.forEach(function (b) {
      if (rank[b.key] === undefined) unknown.push(b);
      else known.push(b);
    });
    known.sort(function (a, b) { return rank[a.key] - rank[b.key]; });
    return known.concat(sortGroup(unknown, now));
  }

  function sortGroup(list, now) {
    return list.slice().sort(function (a, b) {
      var ta = tier(a), tb = tier(b);
      if (ta !== tb) return ta - tb;
      var ua = isExpiringSoon(a, now) ? 0 : 1;
      var ub = isExpiringSoon(b, now) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      var ea = a.expires ? a.expires.getTime() : 8640000000000000;
      var eb = b.expires ? b.expires.getTime() : 8640000000000000;
      if (ea !== eb) return ea - eb;
      return a.benefit < b.benefit ? -1 : 1;
    });
  }

  /* ---- misc formatting / validation ---- */
  var SYMBOL = { USD: "$", GBP: "\u00A3", EUR: "\u20AC",
                 SEK: "kr", NOK: "kr", DKK: "kr", CHF: "CHF ",
                 PLN: "z\u0142" };

  function symbolFor(cur) { return SYMBOL[cur || "USD"] || "$"; }

  function fmtValue(v, cur) {
    if (!v) return null;
    var sym = symbolFor(cur);
    var n = (v === Math.round(v))
      ? Math.round(v).toLocaleString("en-US")
      : v.toLocaleString("en-US",
          { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym + n;
  }

  /* Totals across a mixed-currency wallet: never add pounds to dollars.
     Returns e.g. "$1,240 + \u00A3450". */
  function fmtTotals(byCur) {
    var keys = Object.keys(byCur).filter(function (k) {
      return byCur[k] > 0;
    }).sort(function (a, b) { return byCur[b] - byCur[a]; });
    if (!keys.length) return null;
    var parts = keys.slice(0, 2).map(function (k) {
      return fmtValue(byCur[k], k);
    });
    if (keys.length > 2) parts.push("+" + (keys.length - 2) + " more");
    return parts.join(" + ");
  }
  function fmtDate(dt) {
    if (!dt) return "";
    return MONTH_LABELS[dt.getUTCMonth()] + " " +
           String(dt.getUTCDate()).padStart(2, "0") + ", " +
           dt.getUTCFullYear();
  }
  function validDateParts(m, d, y) {   // m 1-12; true if a real date
    if (!m || !d || !y) return false;
    return d <= lastDayOfMonth(y, m);
  }
  function validEmail(e) {
    e = (e || "").trim().toLowerCase();
    return e.length >= 6 && e.split("@").length === 2 &&
           e.split("@")[1].indexOf(".") > 0 && e.indexOf(" ") < 0;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  return {
    NOTE_MAX: NOTE_MAX, cleanNote: cleanNote,
    EXPIRE_SOON_DAYS: EXPIRE_SOON_DAYS,
    EXPIRE_SOON_DAYS_LONG: EXPIRE_SOON_DAYS_LONG,
    warnWindow: warnWindow, periodLabel: periodLabel,
    MONTH_FULL: MONTH_FULL,
    MONTH_LABELS: MONTH_LABELS,
    PERIOD_LABELS: PERIOD_LABELS,
    RECURRING: RECURRING,
    ymd: ymd, today: today, iso: iso, fromISO: fromISO,
    daysBetween: daysBetween, lastDayOfMonth: lastDayOfMonth,
    expiryFor: expiryFor, nextAnniversary: nextAnniversary,
    currentPeriod: currentPeriod, tier: tier,
    stateKey: stateKey, buildBenefits: buildBenefits,
    snapshotState: snapshotState,
    daysRemaining: daysRemaining, isExpiringSoon: isExpiringSoon,
    sortGroup: sortGroup, applyCustomOrder: applyCustomOrder,
    fmtValue: fmtValue, fmtDate: fmtDate,
    fmtTotals: fmtTotals, symbolFor: symbolFor,
    periodsPerYear: periodsPerYear, annualValue: annualValue,
    usedValue: usedValue, remainingValue: remainingValue,
    summarize: summarize,
    validDateParts: validDateParts, validEmail: validEmail, esc: esc
  };
});
