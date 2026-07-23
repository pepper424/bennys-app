/* Bennys PWA - main application.
   Architecture: a single state object + pure-ish render functions that
   return HTML strings, with a thin DOM/event layer at the bottom. The
   state machine + actions are exported for Node tests via module.exports
   when running outside a browser. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./logic.js"));
  } else {
    root.BennysApp = factory(root.BennysLogic);
    root.BennysApp.boot();
  }
})(typeof self !== "undefined" ? self : this, function (L) {
  "use strict";

  /* ================= state ================= */
  var S = {
    screen: "loading",       // loading|auth|onboard|dash
    authTab: "login",        // login|signup|forgot
    user: null,              // {id, email}
    catalog: null,
    profile: null,           // {cards, anniversaries, state, created}
    benefits: [],
    tab: "alerts",           // alerts|card:<name>|manage
    search: "",
    pick: [],                // onboarding picks
    pickQuery: "",
    mngPick: [], mngQuery: "",
    saving: "idle",          // idle|saving|error
    authMsg: "", authOk: "",
    deferredInstall: null,
    env: null                // injected {supabase, fetchJSON, now()}
  };

  var CARD_ORDER = [];

  /* ================= helpers ================= */
  function esc(s) { return L.esc(s); }
  function now() { return S.env && S.env.now ? S.env.now() : new Date(); }

  function cardsNeedingDates(list) {
    return list.filter(function (c) {
      return S.catalog.cards[c].has_anniversary_benefits;
    });
  }

  function rebuild() {
    S.benefits = L.buildBenefits(S.catalog, S.profile, now());
  }

  var saveTimer = null;
  function persist(immediate) {
    S.profile.state = L.snapshotState(S.benefits);
    S.saving = "saving"; paint();
    clearTimeout(saveTimer);
    var doSave = function () {
      S.env.saveDashboard(S.user.id, S.profile).then(function () {
        S.saving = "idle"; paint();
      }).catch(function () {
        S.saving = "error"; paint();
        toast("Cloud save failed - check your connection", true);
      });
    };
    if (immediate) doSave(); else saveTimer = setTimeout(doSave, 350);
  }

  /* ================= actions ================= */
  var A = {
    setAuthTab: function (t) { S.authTab = t; S.authMsg = ""; S.authOk = ""; paint(); },

    signup: function (email, pw, pw2) {
      S.authMsg = ""; S.authOk = "";
      if (!L.validEmail(email)) { S.authMsg = "Enter a valid email address."; return paint(); }
      if ((pw || "").length < 8) { S.authMsg = "Password must be at least 8 characters."; return paint(); }
      if (pw !== pw2) { S.authMsg = "Those passwords do not match."; return paint(); }
      S.env.signUp(email.trim(), pw).then(function (res) {
        if (res.error) { S.authMsg = friendlyAuthError(res.error); return paint(); }
        if (res.needsConfirm) {
          S.authOk = "Check your email to confirm your account, then log in.";
          S.authTab = "login"; return paint();
        }
        A.onSignedIn(res.user);
      });
    },

    login: function (email, pw) {
      S.authMsg = ""; S.authOk = "";
      if (!L.validEmail(email) || !pw) { S.authMsg = "Enter your email and password."; return paint(); }
      S.env.signIn(email.trim(), pw).then(function (res) {
        if (res.error) { S.authMsg = friendlyAuthError(res.error); return paint(); }
        A.onSignedIn(res.user);
      });
    },

    forgot: function (email) {
      S.authMsg = ""; S.authOk = "";
      if (!L.validEmail(email)) { S.authMsg = "Enter the email you signed up with."; return paint(); }
      S.env.resetPassword(email.trim()).then(function (res) {
        if (res.error) { S.authMsg = friendlyAuthError(res.error); return paint(); }
        S.authOk = "Password reset email sent - check your inbox (and spam).";
        paint();
      });
    },

    google: function () {
      S.env.signInGoogle().then(function (res) {
        if (res && res.error) { S.authMsg = friendlyAuthError(res.error); paint(); }
      });
    },

    onSignedIn: function (user) {
      S.user = user;
      S.env.loadDashboard(user.id).then(function (data) {
        S.profile = data || null;
        if (S.profile && S.profile.cards && S.profile.cards.length) {
          rebuild(); S.screen = "dash"; S.tab = "alerts";
        } else {
          S.profile = S.profile || {
            cards: [], anniversaries: {}, state: {},
            created: L.iso(L.today(now()))
          };
          S.screen = "onboard"; S.pick = []; S.pickQuery = "";
        }
        paint();
      }).catch(function () {
        S.screen = "auth";
        S.authMsg = "Could not reach the cloud - try again.";
        paint();
      });
    },

    finishOnboard: function (dates) {
      S.profile.cards = S.pick.slice();
      S.profile.anniversaries = dates;
      rebuild();
      S.screen = "dash"; S.tab = "alerts";
      persist(true);
      paint();
    },

    flipSingle: function (key, used) {
      var b = S.benefits.find(function (x) { return x.key === key; });
      if (!b) return;
      b.available = !used;
      persist(); paint();
    },

    flipPeriod: function (key, p, used) {
      var b = S.benefits.find(function (x) { return x.key === key; });
      if (!b) return;
      b.used_periods = b.used_periods || [];
      var i = b.used_periods.indexOf(p);
      if (used && i < 0) b.used_periods.push(p);
      if (!used && i >= 0) b.used_periods.splice(i, 1);
      b.available =
        b.used_periods.indexOf(L.currentPeriod(b.reset, L.today(now()))) < 0;
      persist(); paint();
    },

    addCards: function (cards, dates) {
      var have = {};
      S.profile.cards.forEach(function (c) { have[c] = 1; });
      cards.forEach(function (c) { have[c] = 1; });
      S.profile.cards = CARD_ORDER.filter(function (c) { return have[c]; });
      Object.keys(dates).forEach(function (c) {
        S.profile.anniversaries[c] = dates[c];
      });
      rebuild(); persist(true);
      S.mngPick = []; S.mngQuery = "";
      toast("Cards added"); paint();
    },

    saveDates: function (dates) {
      Object.keys(dates).forEach(function (c) {
        S.profile.anniversaries[c] = dates[c];
      });
      rebuild(); persist(true);
      toast("Dates saved"); paint();
    },

    removeCards: function (cards) {
      S.profile.cards = S.profile.cards.filter(function (c) {
        return cards.indexOf(c) < 0;
      });
      cards.forEach(function (c) { delete S.profile.anniversaries[c]; });
      rebuild(); persist(true);
      if (S.tab.indexOf("card:") === 0 &&
          cards.indexOf(S.tab.slice(5)) >= 0) S.tab = "alerts";
      toast("Cards removed"); paint();
    },

    resetDashboard: function () {
      S.env.deleteDashboard(S.user.id).then(function () {
        S.profile = { cards: [], anniversaries: {}, state: {},
                      created: L.iso(L.today(now())) };
        S.benefits = [];
        S.screen = "onboard"; S.pick = []; S.pickQuery = "";
        closeModal(); paint();
      }).catch(function () {
        toast("Reset failed - check your connection", true);
      });
    },

    logout: function () {
      S.env.signOut().then(function () {
        S.user = null; S.profile = null; S.benefits = [];
        S.screen = "auth"; S.authTab = "login";
        S.authMsg = ""; S.authOk = "";
        paint();
      });
    }
  };

  function friendlyAuthError(err) {
    var m = (err && (err.message || err)) + "";
    if (/already registered|already exists/i.test(m))
      return "An account with this email already exists - log in instead.";
    if (/invalid login|invalid credentials/i.test(m))
      return "Email or password is incorrect.";
    if (/rate limit|too many/i.test(m))
      return "Too many attempts - wait a minute and try again.";
    if (/confirm/i.test(m))
      return "Confirm your email first - check your inbox for the link.";
    return "Something went wrong: " + m;
  }

  /* ================= views (HTML strings) ================= */
  function heroHTML() {
    return '<div class="hero">' +
      '<img class="hero-icon" src="icon-192.png" alt="Bennys">' +
      '<div class="hero-name">Bennys</div>' +
      '<div class="hero-thesis">Never let a credit die.</div>' +
      '<div class="hero-sub">Pick your cards and get a live dashboard ' +
      'of every credit, free night, and deadline you are owed. ' +
      'No bank logins - ever.</div></div>';
  }

  function authView() {
    var t = S.authTab;
    var h = heroHTML();
    h += '<div class="authtabs">' +
      '<button data-a="authtab" data-v="login" class="' +
        (t === "login" ? "active" : "") + '">Log in</button>' +
      '<button data-a="authtab" data-v="signup" class="' +
        (t === "signup" ? "active" : "") + '">Create account</button>' +
      '</div>';
    if (t === "signup") {
      h += '<div class="sub">Your cards and deadlines stay tied to you ' +
        'and sync to any device you log in on.</div>' +
        '<div class="field"><input type="email" id="f-email" ' +
        'placeholder="you@example.com" autocomplete="email"></div>' +
        '<div class="field"><input type="password" id="f-pw" ' +
        'placeholder="Choose a password (8+ characters)" ' +
        'autocomplete="new-password"></div>' +
        '<div class="field"><input type="password" id="f-pw2" ' +
        'placeholder="Re-enter it" autocomplete="new-password"></div>' +
        '<div class="err">' + esc(S.authMsg) + '</div>' +
        (S.authOk ? '<div class="ok">' + esc(S.authOk) + '</div>' : "") +
        '<button data-a="signup">Create account</button>';
    } else if (t === "forgot") {
      h += '<div class="sub">Enter your email and we will send a ' +
        'password reset link.</div>' +
        '<div class="field"><input type="email" id="f-email" ' +
        'placeholder="you@example.com" autocomplete="email"></div>' +
        '<div class="err">' + esc(S.authMsg) + '</div>' +
        (S.authOk ? '<div class="ok">' + esc(S.authOk) + '</div>' : "") +
        '<button data-a="forgot">Send reset link</button>' +
        '<button class="link" data-a="authtab" data-v="login">' +
        'Back to log in</button>';
    } else {
      h += '<div class="sub">Welcome back - log in to pick up right ' +
        'where you left off.</div>' +
        '<div class="field"><input type="email" id="f-email" ' +
        'placeholder="you@example.com" autocomplete="email"></div>' +
        '<div class="field"><input type="password" id="f-pw" ' +
        'placeholder="Your password" autocomplete="current-password">' +
        '</div>' +
        '<div class="err">' + esc(S.authMsg) + '</div>' +
        (S.authOk ? '<div class="ok">' + esc(S.authOk) + '</div>' : "") +
        '<button data-a="login">Log in</button>' +
        '<button class="link" data-a="authtab" data-v="forgot">' +
        'Forgot password?</button>';
    }
    if (window.BENNYS_CONFIG && window.BENNYS_CONFIG.ENABLE_GOOGLE) {
      h += '<button class="ghost" data-a="google">Continue with ' +
        'Google</button>';
    }
    return h;
  }

  function pickerHTML(idPrefix, query, chosen, pool) {
    var q = (query || "").toLowerCase();
    var items = pool.filter(function (c) {
      return chosen.indexOf(c) < 0 &&
             (!q || c.toLowerCase().indexOf(q) >= 0);
    }).slice(0, 40);
    var h = '<div class="picker-tags">' + chosen.map(function (c) {
      return '<span class="tag">' + esc(c) +
        '<button data-a="' + idPrefix + '-untag" data-v="' + esc(c) +
        '" aria-label="remove">&times;</button></span>';
    }).join("") + '</div>';
    h += '<input type="text" id="' + idPrefix + '-q" ' +
      'placeholder="Type to search ' + pool.length + ' cards..." ' +
      'value="' + esc(query || "") + '" autocomplete="off">';
    h += '<div class="picker-list">';
    if (items.length === 0) {
      h += '<div class="picker-empty">No matching cards' +
        (q ? ' for "' + esc(query) + '"' : '') +
        '. More cards land in monthly catalog updates.</div>';
    } else {
      h += items.map(function (c) {
        return '<div class="picker-item" data-a="' + idPrefix +
          '-tag" data-v="' + esc(c) + '">' + esc(c) +
          ' <span class="fee">$' +
          S.catalog.cards[c].annual_fee + '/yr</span></div>';
      }).join("");
    }
    h += '</div>';
    return h;
  }

  function annivRowsHTML(prefix, cards, defaults) {
    defaults = defaults || {};
    return cards.map(function (c) {
      var d0 = defaults[c] ? L.fromISO(defaults[c]) : null;
      var selM = d0 ? d0.getUTCMonth() + 1 : 0;
      var selD = d0 ? d0.getUTCDate() : 0;
      var selY = d0 ? d0.getUTCFullYear() : 0;
      var yNow = L.today(now()).getUTCFullYear();
      var h = '<div class="sub" style="margin:.55rem 0 .2rem">' +
        '<b>' + esc(c) + '</b> anniversary</div><div class="row2">';
      h += '<select id="' + prefix + '-m-' + esc(c) + '">' +
        '<option value="0"' + (selM ? "" : " selected") +
        '>Month</option>' +
        L.MONTH_LABELS.map(function (m, i) {
          return '<option value="' + (i + 1) + '"' +
            (selM === i + 1 ? " selected" : "") + '>' + m + '</option>';
        }).join("") + '</select>';
      h += '<select id="' + prefix + '-d-' + esc(c) + '">' +
        '<option value="0"' + (selD ? "" : " selected") + '>Day</option>';
      for (var d = 1; d <= 31; d++) {
        h += '<option value="' + d + '"' +
          (selD === d ? " selected" : "") + '>' + d + '</option>';
      }
      h += '</select>';
      h += '<select id="' + prefix + '-y-' + esc(c) + '">' +
        '<option value="0"' + (selY ? "" : " selected") + '>Year</option>';
      for (var y = yNow; y >= 1990; y--) {
        h += '<option value="' + y + '"' +
          (selY === y ? " selected" : "") + '>' + y + '</option>';
      }
      h += '</select></div>';
      return h;
    }).join("");
  }

  function readAnnivRows(prefix, cards) {
    var dates = {}, bad = [];
    cards.forEach(function (c) {
      var m = +val(prefix + "-m-" + c), d = +val(prefix + "-d-" + c),
          y = +val(prefix + "-y-" + c);
      if (!m && !d && !y) return;                 // fully blank: skip
      if (!L.validDateParts(m, d, y)) { bad.push(c); return; }
      dates[c] = y + "-" + String(m).padStart(2, "0") + "-" +
                 String(d).padStart(2, "0");
    });
    return { dates: dates, bad: bad };
  }

  function onboardView() {
    var h;
    if (S.user) {
      h = '<div class="brand">' +
        '<img class="brand-icon" src="icon-192.png" alt="">' +
        '<div><div class="brand-name">Welcome to Bennys</div>' +
        '<div class="brand-tag">' + esc(S.user.email) + '</div></div>' +
        '</div>' +
        '<div class="hint">Last step - add the cards you carry and ' +
        'your dashboard is ready.</div>';
    } else {
      h = heroHTML();
    }
    h += pickerHTML("pick", S.pickQuery, S.pick, CARD_ORDER);
    var need = cardsNeedingDates(S.pick);
    if (need.length) {
      h += '<div class="sub" style="margin-top:.7rem">Account ' +
        'anniversary dates - these unlock exact free-night and ' +
        'travel-credit deadlines. Leave blank if unsure (you can add ' +
        'them later in the &#65291; Cards tab).</div>';
      h += annivRowsHTML("ann", need);
    }
    h += '<div class="err" id="ob-err"></div>';
    h += '<button data-a="create" ' +
      (S.pick.length ? "" : "disabled") + '>Create my dashboard</button>';
    return h;
  }

  function benefitHTML(b) {
    var urgent = L.isExpiringSoon(b, now());
    var used = !b.available;
    var cls = "benefit-card" + (urgent ? " urgent" : "") +
              (used ? " used" : "");
    var warn = urgent ?
      '<span class="expires-soon">&#9679; EXPIRING</span> ' : "";
    var val = L.fmtValue(b.value);
    var pills = ['<span class="pill">' + esc(b.reset) + '</span>'];
    if (!b.expires) {
      pills.push('<span class="pill">No fixed expiration</span>');
    } else {
      var d = L.daysRemaining(b, now());
      var ds = L.fmtDate(b.expires);
      if (d < 0) {
        pills.push('<span class="pill days-expired">Expired ' + ds +
                   '</span>');
      } else if (urgent) {
        pills.push('<span class="pill days-warn">' + d + " day" +
          (d === 1 ? "" : "s") + " left - " + ds + '</span>');
      } else {
        pills.push('<span class="pill days-ok">' + d +
          ' days left - ' + ds + '</span>');
      }
    }
    return '<div class="' + cls + '">' +
      '<div class="bc-top"><div class="card-name">' + esc(b.card) +
      '</div>' + (val ? '<div class="bc-value">' + esc(val) +
      '</div>' : "") + '</div>' +
      '<div class="benefit-name">' + warn + esc(b.benefit) + '</div>' +
      '<div class="benefit-meta">' + pills.join("") + '</div>' +
      '<div class="benefit-desc">' + esc(b.desc) + '</div></div>';
  }

  function toggleHTML(b) {
    var t = L.today(now());
    if (L.RECURRING[b.reset]) {
      var labels = L.PERIOD_LABELS[b.reset];
      var cur = L.currentPeriod(b.reset, t);
      var cols = labels.length > 4 ? "" : " cols2";
      if (labels.length === 4) cols = "";
      var h = '<div class="pergrid' +
        (labels.length === 2 ? " cols2" : "") + '">';
      labels.forEach(function (lab, p) {
        var used = (b.used_periods || []).indexOf(p) >= 0;
        var flash = p === cur && !used && L.isExpiringSoon(b, now());
        h += '<div class="pcell' + (flash ? " flash" : "") + '">' +
          '<label class="switch"><input type="checkbox" ' +
          'data-a="period" data-k="' + esc(b.key) + '" data-p="' + p +
          '"' + (used ? " checked" : "") + '>' +
          '<span class="track"></span></label>' +
          '<span class="tglabel">' + lab + '</span></div>';
      });
      return h + "</div>";
    }
    return '<div class="tgrow"><label class="switch">' +
      '<input type="checkbox" data-a="single" data-k="' + esc(b.key) +
      '"' + (b.available ? "" : " checked") + '>' +
      '<span class="track"></span></label>' +
      '<span class="tglabel">Used</span></div>';
  }

  function matchesSearch(b) {
    if (!S.search) return true;
    var q = S.search.toLowerCase();
    return (b.benefit + " " + b.card + " " + b.desc)
      .toLowerCase().indexOf(q) >= 0;
  }

  function dashView() {
    var t = now();
    var visible = S.benefits.filter(matchesSearch);
    var urgentAll = S.benefits.filter(function (b) {
      return L.isExpiringSoon(b, t);
    });
    var avail = S.benefits.filter(function (b) { return b.available; });
    var openVal = avail.reduce(function (s, b) {
      return s + (b.value || 0);
    }, 0);

    var h = '<div class="brand">' +
      '<img class="brand-icon" src="icon-192.png" alt="">' +
      '<div><div class="brand-name">Bennys</div>' +
      '<div class="brand-tag">' + S.profile.cards.length + ' cards - ' +
      L.fmtDate(L.today(t)) +
      '<span class="savedot' +
      (S.saving === "saving" ? " saving" :
       S.saving === "error" ? " bad" : "") + '"></span>' +
      '</div></div></div>' +
      '<div class="hint">Flip a switch when you have used a credit - ' +
      'it saves instantly.</div>';

    if (S.installable()) {
      h += '<button class="ghost" data-a="install">&#8681; Install ' +
        'Bennys on this phone</button>';
    }

    h += '<div class="stat-row">' +
      '<div class="stat-box"><div class="stat-num green">' +
      avail.length + '</div><div class="stat-lab">Available</div></div>' +
      '<div class="stat-box"><div class="stat-num gold">' +
      urgentAll.length + '</div><div class="stat-lab">Expiring soon' +
      '</div></div>' +
      '<div class="stat-box"><div class="stat-num">' +
      (L.fmtValue(openVal) || "$0") +
      '</div><div class="stat-lab">Open value</div></div></div>';

    h += '<div class="searchbar"><input type="text" id="dash-q" ' +
      'placeholder="Search benefits..." value="' + esc(S.search) +
      '" autocomplete="off"></div>';

    var userCards = CARD_ORDER.filter(function (c) {
      return S.profile.cards.indexOf(c) >= 0;
    });
    h += '<div class="strip">';
    h += '<button class="chip' +
      (S.tab === "alerts" ? " active" : "") +
      '" data-a="tab" data-v="alerts">&#9888;&#65039; ' +
      urgentAll.length + '</button>';
    userCards.forEach(function (c) {
      h += '<button class="chip' +
        (S.tab === "card:" + c ? " active" : "") +
        '" data-a="tab" data-v="card:' + esc(c) + '">' +
        esc(S.catalog.cards[c].tab_label) + '</button>';
    });
    h += '<button class="chip' +
      (S.tab === "manage" ? " active" : "") +
      '" data-a="tab" data-v="manage">&#65291; Cards</button>';
    h += '</div>';

    if (S.tab === "alerts") {
      var urg = L.sortGroup(urgentAll.filter(matchesSearch), t);
      if (!urg.length) {
        h += '<div class="empty-note">Nothing expires in the next ' +
          L.EXPIRE_SOON_DAYS + ' days. Enjoy it.</div>';
      }
      urg.forEach(function (b) {
        h += benefitHTML(b) + toggleHTML(b);
      });
    } else if (S.tab === "manage") {
      h += manageView();
    } else if (S.tab.indexOf("card:") === 0) {
      var card = S.tab.slice(5);
      var group = visible.filter(function (b) { return b.card === card; });
      var gAvail = group.filter(function (b) { return b.available; });
      var gUrg = group.filter(function (b) {
        return L.isExpiringSoon(b, t);
      });
      var gVal = gAvail.reduce(function (s, b) {
        return s + (b.value || 0);
      }, 0);
      h += '<div class="card-hero"><div class="h-name">' + esc(card) +
        '</div><div class="h-meta">' +
        esc(S.catalog.cards[card].meta) + '</div>' +
        '<div class="h-stats">' + gAvail.length + ' available - ' +
        gUrg.length + ' expiring soon - ' +
        (L.fmtValue(gVal) || "$0") + ' open value</div></div>';
      if (!group.length) {
        h += '<div class="empty-note">No benefits on this card match ' +
          'your search.</div>';
      }
      L.sortGroup(group, t).forEach(function (b) {
        h += benefitHTML(b) + toggleHTML(b);
      });
    }
    return h;
  }

  function manageView() {
    var h = '<div class="card-hero"><div class="h-name">Manage your ' +
      'cards</div><div class="h-meta">Got a new card? Add it here and ' +
      'your dashboard updates instantly. You can also fix anniversary ' +
      'dates or remove cards you have closed.</div></div>';

    var addable = CARD_ORDER.filter(function (c) {
      return S.profile.cards.indexOf(c) < 0;
    });
    h += '<div class="sub" style="margin-top:.4rem"><b>Add cards</b> - ' +
      'type to search all ' + CARD_ORDER.length + ' cards</div>';
    h += pickerHTML("mng", S.mngQuery, S.mngPick, addable);
    var need = cardsNeedingDates(S.mngPick);
    if (need.length) {
      h += '<div class="sub" style="margin-top:.5rem">Anniversary ' +
        'dates (optional - unlock exact deadlines):</div>' +
        annivRowsHTML("mngadd", need);
    }
    h += '<div class="err" id="mng-err"></div>';
    h += '<button data-a="mng-add"' +
      (S.mngPick.length ? "" : " disabled") + '>Add ' +
      S.mngPick.length + ' card' +
      (S.mngPick.length === 1 ? "" : "s") + ' to my dashboard</button>';

    var ownedAnniv = S.profile.cards.filter(function (c) {
      return S.catalog.cards[c].has_anniversary_benefits;
    });
    if (ownedAnniv.length) {
      h += '<details class="section"><summary>Edit anniversary dates' +
        '</summary>' +
        annivRowsHTML("mngdt", ownedAnniv, S.profile.anniversaries) +
        '<div class="err" id="dt-err"></div>' +
        '<button data-a="mng-dates">Save dates</button></details>';
    }
    if (S.profile.cards.length) {
      h += '<details class="section"><summary>Remove cards</summary>' +
        '<div class="sub">Removing a card also deletes its saved ' +
        'toggle history.</div>' +
        S.profile.cards.map(function (c) {
          return '<div class="tgrow"><label class="switch">' +
            '<input type="checkbox" class="rmcheck" data-v="' +
            esc(c) + '"><span class="track"></span></label>' +
            '<span class="tglabel">' + esc(c) + '</span></div>';
        }).join("") +
        '<button class="danger" data-a="mng-remove">Remove selected' +
        '</button></details>';
    }
    h += '<hr class="thin">' +
      '<div class="sub">Signed in as <b>' + esc(S.user.email) +
      '</b></div>' +
      '<div class="sub">Catalog version: ' +
      esc(S.catalog.catalog_version || "?") +
      ' - benefits re-audited monthly.</div>' +
      '<button class="ghost" data-a="logout">Log out</button>' +
      '<button class="ghost" data-a="reset-open">Reset dashboard' +
      '</button>';
    return h;
  }

  function resetModalHTML() {
    return '<div class="modal-back" data-a="modal-back">' +
      '<div class="modal"><h3>Reset dashboard</h3>' +
      '<div class="sub" style="font-size:.95rem;color:var(--ink);' +
      'font-weight:600">Are you sure you want to reset your ' +
      'dashboard?</div>' +
      '<div class="hint">This permanently clears your cards, ' +
      'anniversary dates, and toggle history - the app starts over ' +
      'like a brand-new user. Your login stays; your data does not.' +
      '</div><div class="row2">' +
      '<button class="danger" data-a="reset-yes">Yes, reset ' +
      'everything</button>' +
      '<button class="ghost" data-a="reset-no">Cancel</button>' +
      '</div></div></div>';
  }

  /* ================= render / paint ================= */
  function view() {
    if (S.screen === "loading") {
      return '<div class="hero" style="padding-top:4rem">' +
        '<div class="hero-name">Bennys</div>' +
        '<div class="hero-sub">Loading&hellip;</div></div>';
    }
    if (S.screen === "auth") return authView();
    if (S.screen === "onboard") return onboardView();
    if (S.screen === "dash") return dashView();
    return "";
  }

  var paint = function () {};          // replaced in browser boot
  var toast = function () {};
  var closeModal = function () {};
  function val() { return "0"; }       // replaced in browser boot

  S.installable = function () { return !!S.deferredInstall; };

  /* ================= browser boot ================= */
  function boot() {
    var CFG = window.BENNYS_CONFIG || {};
    var sb = null;
    var configured = CFG.SUPABASE_URL &&
      CFG.SUPABASE_URL.indexOf("PASTE_") < 0;
    if (configured && window.supabase) {
      sb = window.supabase.createClient(
        CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    }

    val = function (id) {
      var el = document.getElementById(id);
      return el ? el.value : "0";
    };

    var toastTimer = null;
    toast = function (msg, bad) {
      var el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "toast show" + (bad ? " bad" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        el.className = "toast";
      }, 2600);
    };

    closeModal = function () {
      document.getElementById("modal-root").innerHTML = "";
    };

    paint = function () {
      var focusEl = document.activeElement;
      var focusId = focusEl && focusEl.id;
      var selStart = focusEl && focusEl.selectionStart;
      document.getElementById("app").innerHTML = view();
      if (focusId) {
        var again = document.getElementById(focusId);
        if (again) {
          again.focus();
          if (selStart != null && again.setSelectionRange) {
            try { again.setSelectionRange(selStart, selStart); }
            catch (e) {}
          }
        }
      }
    };

    /* environment: real Supabase adapters */
    S.env = {
      now: function () { return new Date(); },
      signUp: function (email, pw) {
        return sb.auth.signUp({ email: email, password: pw })
          .then(function (r) {
            if (r.error) return { error: r.error };
            var u = r.data.user;
            var confirmed = u && (u.email_confirmed_at ||
                                  (r.data.session != null));
            if (!confirmed) return { needsConfirm: true };
            return { user: { id: u.id, email: u.email } };
          });
      },
      signIn: function (email, pw) {
        return sb.auth.signInWithPassword({ email: email, password: pw })
          .then(function (r) {
            if (r.error) return { error: r.error };
            return { user: { id: r.data.user.id,
                             email: r.data.user.email } };
          });
      },
      signInGoogle: function () {
        return sb.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.origin + location.pathname }
        });
      },
      resetPassword: function (email) {
        return sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname
        }).then(function (r) { return { error: r.error }; });
      },
      signOut: function () { return sb.auth.signOut(); },
      loadDashboard: function (uid) {
        return sb.from("dashboards").select("data").eq("user_id", uid)
          .maybeSingle().then(function (r) {
            if (r.error) throw r.error;
            return r.data ? r.data.data : null;
          });
      },
      saveDashboard: function (uid, data) {
        return sb.from("dashboards").upsert({
          user_id: uid, data: data,
          updated_at: new Date().toISOString()
        }).then(function (r) {
          if (r.error) throw r.error;
        });
      },
      deleteDashboard: function (uid) {
        return sb.from("dashboards").delete().eq("user_id", uid)
          .then(function (r) { if (r.error) throw r.error; });
      }
    };

    /* install prompt capture */
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      S.deferredInstall = e;
      if (S.screen === "dash") paint();
    });
    window.addEventListener("appinstalled", function () {
      S.deferredInstall = null;
      toast("Bennys installed - check your home screen");
      paint();
    });

    /* global event delegation */
    document.addEventListener("click", function (e) {
      var el = e.target.closest("[data-a]");
      if (!el) return;
      var a = el.getAttribute("data-a");
      var v = el.getAttribute("data-v");
      if (a === "authtab") A.setAuthTab(v);
      else if (a === "signup")
        A.signup(val("f-email"), val("f-pw"), val("f-pw2"));
      else if (a === "login") A.login(val("f-email"), val("f-pw"));
      else if (a === "forgot") A.forgot(val("f-email"));
      else if (a === "google") A.google();
      else if (a === "tab") { S.tab = v; paint(); }
      else if (a === "pick-tag") {
        S.pick.push(v); S.pickQuery = ""; paint();
      }
      else if (a === "pick-untag") {
        S.pick = S.pick.filter(function (c) { return c !== v; });
        paint();
      }
      else if (a === "mng-tag") {
        S.mngPick.push(v); S.mngQuery = ""; paint();
      }
      else if (a === "mng-untag") {
        S.mngPick = S.mngPick.filter(function (c) { return c !== v; });
        paint();
      }
      else if (a === "create") {
        var need = cardsNeedingDates(S.pick);
        var r = readAnnivRows("ann", need);
        if (r.bad.length) {
          document.getElementById("ob-err").textContent =
            "Finish or clear the anniversary date for: " +
            r.bad.join(", ");
          return;
        }
        A.finishOnboard(r.dates);
      }
      else if (a === "mng-add") {
        var need2 = cardsNeedingDates(S.mngPick);
        var r2 = readAnnivRows("mngadd", need2);
        if (r2.bad.length) {
          document.getElementById("mng-err").textContent =
            "Finish or clear the anniversary date for: " +
            r2.bad.join(", ");
          return;
        }
        A.addCards(S.mngPick.slice(), r2.dates);
      }
      else if (a === "mng-dates") {
        var owned = S.profile.cards.filter(function (c) {
          return S.catalog.cards[c].has_anniversary_benefits;
        });
        var r3 = readAnnivRows("mngdt", owned);
        if (r3.bad.length) {
          document.getElementById("dt-err").textContent =
            "Finish or clear the anniversary date for: " +
            r3.bad.join(", ");
          return;
        }
        A.saveDates(r3.dates);
      }
      else if (a === "mng-remove") {
        var rm = Array.prototype.slice.call(
          document.querySelectorAll(".rmcheck:checked")
        ).map(function (x) { return x.getAttribute("data-v"); });
        if (rm.length) A.removeCards(rm);
      }
      else if (a === "reset-open") {
        document.getElementById("modal-root").innerHTML =
          resetModalHTML();
      }
      else if (a === "reset-yes") A.resetDashboard();
      else if (a === "reset-no") closeModal();
      else if (a === "modal-back" && e.target === el) closeModal();
      else if (a === "logout") A.logout();
      else if (a === "install") {
        if (S.deferredInstall) {
          S.deferredInstall.prompt();
          S.deferredInstall = null; paint();
        }
      }
    });

    document.addEventListener("change", function (e) {
      var el = e.target;
      var a = el.getAttribute && el.getAttribute("data-a");
      if (a === "single") A.flipSingle(el.getAttribute("data-k"),
                                       el.checked);
      else if (a === "period")
        A.flipPeriod(el.getAttribute("data-k"),
                     +el.getAttribute("data-p"), el.checked);
    });

    document.addEventListener("input", function (e) {
      var id = e.target.id;
      if (id === "pick-q") { S.pickQuery = e.target.value; paint(); }
      else if (id === "mng-q") { S.mngQuery = e.target.value; paint(); }
      else if (id === "dash-q") { S.search = e.target.value; paint(); }
    });

    /* startup */
    if (!configured) {
      document.getElementById("app").innerHTML = heroHTML() +
        '<div class="section" style="border-color:rgba(224,86,79,.5)">' +
        '<div class="sub" style="color:#ff9d96"><b>Almost there.</b> ' +
        'Open <b>config.js</b> and paste in your Supabase URL and ' +
        'anon key (steps 2-4 of the setup instructions), then reload.' +
        '</div></div>';
      return;
    }

    fetch("benefits.json").then(function (r) { return r.json(); })
      .then(function (cat) {
        S.catalog = cat;
        CARD_ORDER = Object.keys(cat.cards);
        /* password-recovery deep link */
        if (location.hash.indexOf("type=recovery") >= 0) {
          var np = prompt("Enter a new password (8+ characters):");
          if (np && np.length >= 8) {
            sb.auth.updateUser({ password: np }).then(function () {
              toast("Password updated - log in with it next time");
            });
          }
        }
        return sb.auth.getSession();
      }).then(function (r) {
        var sess = r && r.data && r.data.session;
        if (sess && sess.user) {
          A.onSignedIn({ id: sess.user.id, email: sess.user.email });
        } else {
          S.screen = "auth"; paint();
        }
        sb.auth.onAuthStateChange(function (ev, session) {
          if (ev === "SIGNED_IN" && session && !S.user) {
            A.onSignedIn({ id: session.user.id,
                           email: session.user.email });
          }
        });
      }).catch(function () {
        document.getElementById("app").innerHTML = heroHTML() +
          '<div class="err">Could not load the card catalog. Check ' +
          'that benefits.json was uploaded next to index.html.</div>';
      });
  }

  /* exports for Node tests */
  return {
    boot: boot, state: S, actions: A,
    views: { authView: authView, onboardView: onboardView,
             dashView: dashView, manageView: manageView,
             benefitHTML: benefitHTML, toggleHTML: toggleHTML,
             resetModalHTML: resetModalHTML, pickerHTML: pickerHTML },
    _internals: { rebuild: rebuild, readAnnivRows: readAnnivRows,
                  setPaint: function (p) { paint = p; },
                  setToast: function (t) { toast = t; },
                  setCloseModal: function (c) { closeModal = c; },
                  setVal: function (v) { val = v; },
                  setCardOrder: function (o) { CARD_ORDER = o; } }
  };
});
