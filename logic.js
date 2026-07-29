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

  /* ---- generated card art ----
     Deliberately NOT issuer logos: those are trademarked and shipping
     them in a published app is a real legal exposure. Instead each card
     gets an original monogram tile in colours associated with its
     issuer or travel partner, which gives the same fast recognition
     when scanning a long list. */
  var ART = [
    // travel partners first - on a co-brand the partner is what people
    // recognise ("Hyatt" reads faster than "Chase")
    [/hyatt/i,                    "HY", "#1E4B7B", "#0E2A47"],
    [/marriott|bonvoy|ritz/i,     "MR", "#1C3F94", "#2E5FD0"],
    [/hilton/i,                   "HH", "#0B3C7A", "#1666C8"],
    [/\bihg\b|holiday inn/i,      "IHG", "#8B1D3F", "#C4315F"],
    [/wyndham/i,                  "WY", "#1B5E7E", "#2E8BB0"],
    [/choice privileges/i,        "CP", "#1F5C8B", "#3383C2"],
    [/delta/i,                    "DL", "#8A1830", "#C42B4C"],
    [/united/i,                   "UA", "#0B2C5E", "#1A5DAF"],
    [/southwest/i,                "SW", "#1F3A69", "#D4442A"],
    [/aadvantage|american airlines/i, "AA", "#0C2D57", "#B01B2E"],
    [/jetblue/i,                  "B6", "#0A2E6E", "#1B6FD1"],
    [/atmos|alaska/i,             "AS", "#0B3B5C", "#1E7A9E"],
    [/frontier/i,                 "F9", "#0B5F3E", "#17A06A"],
    [/allegiant/i,                "G4", "#123A6B", "#2E7BC4"],
    [/british airways/i,          "BA", "#0B2A5B", "#9E2236"],
    [/aeroplan|air canada/i,       "AC", "#8E1B2E", "#C4394C"],
    [/disney/i,                   "DS", "#1B3A8C", "#3A63CC"],
    [/costco/i,                   "CO", "#0B4C9B", "#D42A32"],
    [/amazon|prime visa/i,        "AZ", "#232F3E", "#F0912D"],
    [/target/i,                   "TG", "#8E1116", "#CC1F26"],
    [/best buy/i,                 "BB", "#0A3E8C", "#F2C200"],
    [/walmart|sam's club/i,       "WM", "#0B4F9E", "#1E88E5"],
    [/home depot/i,               "HD", "#9E4A10", "#E07B1E"],
    [/lowe's/i,                   "LO", "#0B3B8C", "#2E63C4"],
    [/apple/i,                    "AP", "#3A3A3C", "#6E6E73"],
    [/uber|rideshare/i,           "UB", "#1B1B1B", "#4A4A4A"],
    [/coinbase|gemini|bitcoin/i,  "CB", "#0A2A6B", "#1652F0"],
    [/robinhood/i,                "RH", "#0B5C2E", "#18B44A"],
    [/venmo|paypal/i,             "PP", "#0B3A7A", "#2077C4"],
    [/bilt/i,                     "BL", "#1A1A1A", "#4D4D4D"],
    // credit unions come before the networks: a union card issued on
    // the Amex network should still read as the union
    [/navy federal/i,             "NF", "#0B2E5C", "#1B5FA8"],
    [/penfed/i,                   "PF", "#0B3A6B", "#2E7ABF"],
    [/usaa/i,                     "US", "#0B3560", "#1D6FA8"],
    [/credit union|\bfcu\b|alliant|\bbecu\b|\bdcu\b|schoolsfirst|\bsecu\b|golden 1|suncoast|rbfcu|america first|mountain america|bethpage|first tech|vystar|patelco|wright-patt|security service|delta community/i,
                                  "CU", "#0B5C4E", "#17A08A"],

    // then issuers and networks
    [/american express|amex/i,    "AX", "#0B4EA2", "#3B87D6"],
    [/chase/i,                    "CH", "#0B4A8F", "#1668C4"],
    [/citi/i,                     "CI", "#0B3E86", "#1B6EC2"],
    [/capital one/i,              "C1", "#8E1B2E", "#D0323F"],
    [/discover/i,                 "DI", "#A85416", "#E8811F"],
    [/wells fargo/i,              "WF", "#8E1B24", "#C4232E"],
    [/bank of america|bofa/i,     "BA", "#8E1B2E", "#1B3A8C"],
    [/u\.s\. bank|us bank/i,      "US", "#0B3A6B", "#1E63A8"],
    [/barclays/i,                 "BC", "#0B6EA8", "#2196D6"],
    [/synchrony/i,                "SY", "#5B2C6F", "#8E4CB0"],
    [/comenity|bread/i,           "CM", "#3A4A6B", "#6E82A8"],
    [/truist/i,                   "TR", "#4A2C6B", "#7B4CA8"],
    [/pnc/i,                      "PN", "#8E5A10", "#D18B1E"],
    [/\btd\b/i,                   "TD", "#0B5C2E", "#18A04A"],
    [/regions/i,                  "RG", "#0B5C3E", "#18A06E"],
    [/citizens/i,                 "CZ", "#0B4A6B", "#1E7BA8"],
    [/fifth third/i,              "53", "#0B3A7A", "#2E6EC4"],
    [/huntington/i,               "HU", "#0B5C3A", "#18A068"],
    // credit builders that are NOT from a major issuer. Checked after
    // the issuers above, so "Discover it Secured" still reads Discover.
    [/chime|mission lane|opensky|credit one|indigo|milestone|upgrade|\bself\b/i,
                                  "CR", "#3A4A6B", "#5E7AA8"],
    [/sofi/i,                     "SF", "#0B3A6B", "#1E88C4"],
    [/fidelity/i,                 "FI", "#0B5C3A", "#18A068"],
  ];

  /* Card-level palettes. These approximate the actual finish of the
     physical card - silver for Platinum, gold for Gold, black for the
     metal cards - because the colour is what people recognise at a
     glance. Colour is not a logo, so this stays well clear of
     reproducing anyone's trademark. */
  var CARD_ART = {
    "Amex Platinum":              ["AX",  "#E8EAEC", "#A9B0B8"],
    "Amex Schwab Platinum":       ["AX",  "#E8EAEC", "#A9B0B8"],
    "Amex Morgan Stanley Platinum":["AX", "#E8EAEC", "#A9B0B8"],
    "Amex Gold":                  ["AX",  "#E5C77E", "#B8923E"],
    "Amex Green":                 ["AX",  "#2E7D5B", "#1B4D38"],
    "Amex EveryDay":              ["AX",  "#3E7BC4", "#25528C"],
    "Amex EveryDay Preferred":    ["AX",  "#3E7BC4", "#25528C"],
    "Blue Cash Preferred":        ["AX",  "#2E6FC4", "#1A4585"],
    "Blue Cash Everyday":         ["AX",  "#5B9BE0", "#2E6FB8"],
    "Amex Cash Magnet":           ["AX",  "#4A7FBF", "#2B5488"],
    "Bonvoy Brilliant":           ["MR",  "#3A3A3F", "#141416"],
    "Marriott Bonvoy Bevy":       ["MR",  "#2C4B8E", "#16264A"],
    "Marriott Bonvoy Bountiful":  ["MR",  "#2C4B8E", "#16264A"],
    "Marriott Bold":              ["MR",  "#3E6BC4", "#22407F"],
    "Marriott Boundless":         ["MR",  "#2C4B8E", "#16264A"],
    "Ritz-Carlton":               ["RC",  "#2A2A2E", "#0E0E10"],
    "Hilton Aspire":              ["HH",  "#26262A", "#0C0C0E"],
    "Hilton Surpass":             ["HH",  "#1B4E96", "#0C2A54"],
    "Hilton Honors Card":         ["HH",  "#2E7BC4", "#17457E"],
    "World of Hyatt":             ["HY",  "#1E4B7B", "#0E2A47"],
    "Sapphire Reserve":           ["CSR", "#20477F", "#0C2246"],
    "Sapphire Preferred":         ["CSP", "#3670C9", "#1B3E7E"],
    "Freedom Unlimited":          ["CFU", "#1B6EC2", "#0D3E75"],
    "Freedom Flex":               ["CFF", "#1B6EC2", "#0D3E75"],
    "Freedom Rise":               ["CFR", "#3E8BD6", "#1B5A96"],
    "Venture X":                  ["C1",  "#24405F", "#122438"],
    "Venture":                    ["C1",  "#C2C7CE", "#8A9099"],
    "VentureOne":                 ["C1",  "#D6DAE0", "#A2A8B1"],
    "Savor":                      ["C1",  "#3A3D42", "#1C1E22"],
    "Quicksilver":                ["C1",  "#B8BEC6", "#7C848E"],
    "Citi Double Cash":           ["CI",  "#1B4E96", "#0B2A54"],
    "Citi Custom Cash":           ["CI",  "#2E7BC4", "#154577"],
    "Citi Strata Elite":          ["CI",  "#2A2E36", "#101218"],
    "Citi Strata Premier":        ["CI",  "#1B4E96", "#0B2A54"],
    "Citi Strata":                ["CI",  "#2E6FB8", "#153F70"],
    "Costco Anywhere Visa":       ["CO",  "#1B4E96", "#B02A32"],
    "Discover it Cash Back":      ["DI",  "#E8811F", "#A85210"],
    "Discover it Miles":          ["DI",  "#E8811F", "#A85210"],
    "Discover it Chrome":         ["DI",  "#B8BEC6", "#7C848E"],
    "Discover it Secured":        ["DI",  "#E8A04F", "#B06A1E"],
    "Apple Card":                 ["AP",  "#F2F2F4", "#C7C9CE"],
    "Bilt Blue":                  ["BL",  "#2E5FB0", "#16305E"],
    "Bilt Obsidian":              ["BL",  "#2A2A2E", "#0C0C0E"],
    "Bilt Palladium":             ["BL",  "#C9CDD3", "#8A9099"],
    "Delta SkyMiles Blue":        ["DL",  "#2E6FC4", "#164280"],
    "Delta SkyMiles Gold":        ["DL",  "#D9C08A", "#A8874A"],
    "Delta SkyMiles Platinum":    ["DL",  "#1B3A6B", "#0B1D3D"],
    "Delta SkyMiles Reserve":     ["DL",  "#1B2A4A", "#0B1428"],
    "United Gateway":             ["UA",  "#3E7BC4", "#1B4A85"],
    "United Explorer":            ["UA",  "#1B4E96", "#0B2A54"],
    "United Quest":               ["UA",  "#1B3A6B", "#0B1D3D"],
    "United Club Infinite":       ["UA",  "#2A2E36", "#101218"],
    "IHG Premier":                ["IHG", "#1B3A63", "#0B1E38"],
    "IHG Traveler":               ["IHG", "#C4315F", "#7E1B38"],
    "IHG Platinum (Select)":      ["IHG", "#B8BEC6", "#7C848E"],
    "Altitude Reserve":           ["US",  "#2A3340", "#111820"],
    "Robinhood Gold Card":        ["RH",  "#D9C08A", "#A8874A"],
    "Prime Visa":                 ["AZ",  "#232F3E", "#0E141C"],
    "AAdvantage Executive":       ["AA",  "#2A2E36", "#101218"],
    "Atmos Rewards Summit":       ["AS",  "#0B3B5C", "#05202F"]
  };

  /* Dark text on light tiles, light text on dark ones - computed rather
     than hand-specified so a palette tweak can never make a monogram
     unreadable. */
  function inkFor(c1, c2) {
    function lum(hex) {
      var r = parseInt(hex.slice(1, 3), 16) / 255;
      var g = parseInt(hex.slice(3, 5), 16) / 255;
      var b = parseInt(hex.slice(5, 7), 16) / 255;
      var f = function (v) {
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }
    return ((lum(c1) + lum(c2)) / 2) > 0.42 ? "#1A1D24" : "#FFFFFF";
  }

  /* Returns {mono, c1, c2} for a card. Falls back to the card's own
     initials on a neutral slate so nothing ever renders blank. */
  function cardArt(name, meta, key) {
    // an exact card match wins over the issuer/partner palette
    var exact = CARD_ART[key] || CARD_ART[name];
    if (exact) {
      return { mono: exact[0], c1: exact[1], c2: exact[2],
               ink: inkFor(exact[1], exact[2]) };
    }
    var hay = (name || "") + " " + (meta || "");
    for (var i = 0; i < ART.length; i++) {
      if (ART[i][0].test(hay)) {
        return { mono: ART[i][1], c1: ART[i][2], c2: ART[i][3],
                 ink: inkFor(ART[i][2], ART[i][3]) };
      }
    }
    var words = String(name || "?").replace(/[^A-Za-z ]/g, "").split(/\s+/)
      .filter(Boolean);
    var mono = words.length > 1
      ? (words[0][0] + words[1][0]).toUpperCase()
      : (words[0] || "?").slice(0, 2).toUpperCase();
    return { mono: mono, c1: "#37415C", c2: "#5A6788",
             ink: "#FFFFFF" };
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
    cardArt: cardArt, inkFor: inkFor,
    sortGroup: sortGroup, applyCustomOrder: applyCustomOrder,
    fmtValue: fmtValue, fmtDate: fmtDate,
    fmtTotals: fmtTotals, symbolFor: symbolFor,
    periodsPerYear: periodsPerYear, annualValue: annualValue,
    usedValue: usedValue, remainingValue: remainingValue,
    summarize: summarize,
    validDateParts: validDateParts, validEmail: validEmail, esc: esc
  };
});
