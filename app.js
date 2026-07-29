/* stackNtrack PWA - main application.
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
    platform: { ios: false, android: false, standalone: false },
    installDismissed: false,
    pushState: "unsupported",   // unsupported|off|on|blocked
    pushAsked: false,
    env: null                // injected {supabase, fetchJSON, now()}
  };

  var CARD_ORDER = [];
  var BUILD = "2.9.1";

  /* ================= helpers ================= */
  function esc(s) { return L.esc(s); }
  function now() { return S.env && S.env.now ? S.env.now() : new Date(); }

  function cardCurrency(c) {
    var e = S.catalog && S.catalog.cards[c];
    return (e && e.currency) ? e.currency : "USD";
  }

  function cardArtHTML(c, size) {
    var e = S.catalog && S.catalog.cards[c];
    var a = L.cardArt(cardLabel(c), e ? e.meta : "", c);
    return '<span class="cart ' + (size || "sm") + '" aria-hidden="true" ' +
      'style="background:linear-gradient(145deg,' + a.c1 + ',' + a.c2 +
      ');color:' + a.ink + '">' + esc(a.mono) + '</span>';
  }

  function cardLabel(c) {
    var e = S.catalog && S.catalog.cards[c];
    return (e && e.full_name) ? e.full_name : c;
  }

  function cardHaystack(c) {
    var e = S.catalog && S.catalog.cards[c];
    return ((e && e.search) ? e.search : c.toLowerCase());
  }

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
    var snap = L.snapshotState(S.benefits);
    var prev = S.profile.state || {};
    (S.profile.hidden || []).forEach(function (k) {
      if (prev[k]) snap[k] = prev[k];      // keep flips through hide/restore
    });
    S.profile.state = snap;
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

    maybeOfferPush: function () {
      if (S.pushAsked || S.screen !== "dash") return;
      if (!pushSupported() || S.pushState !== "off") return;
      if (typeof document === "undefined") return;
      var root = document.getElementById("modal-root");
      if (!root || root.innerHTML) return;      // don't stack modals
      setTimeout(function () {
        if (S.screen === "dash" && !S.pushAsked &&
            !document.getElementById("modal-root").innerHTML) {
          document.getElementById("modal-root").innerHTML = pushModalHTML();
        }
      }, 1200);
    },

    onSignedIn: function (user) {
      S.user = user;
      S.env.loadDashboard(user.id).then(function (data) {
        S.profile = data || null;
        if (S.profile && S.profile.cards && S.profile.cards.length) {
          rebuild(); S.screen = "dash"; S.tab = "alerts";
          refreshPushState().then(function () {
            paint(); A.maybeOfferPush();
          });
        } else {
          S.profile = S.profile || {
            cards: [], anniversaries: {}, state: {},
            created: L.iso(L.today(now()))
          };
          S.screen = "onboard"; S.pick = []; S.pickQuery = "";
        }
        paint();
      }).catch(function (err) {
        S.errMsg = describeDbError(err);
        S.errRaw = rawErrorText(err);
        S.screen = "error";
        paint();
      });
    },

    retry: function () {
      if (S.user) { S.screen = "loading"; paint(); A.onSignedIn(S.user); }
    },

    finishOnboard: function (dates) {
      S.profile.cards = S.pick.slice();
      S.profile.anniversaries = dates;
      rebuild();
      S.screen = "dash"; S.tab = "alerts";
      persist(true);
      paint();
      refreshPushState().then(function () { A.maybeOfferPush(); });
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

    hideBenefit: function (key) {
      S.profile.hidden = S.profile.hidden || [];
      if (S.profile.hidden.indexOf(key) < 0) S.profile.hidden.push(key);
      rebuild(); persist(true);
      closeModal(); toast("Benefit removed"); paint();
    },

    restoreBenefit: function (key) {
      S.profile.hidden = (S.profile.hidden || []).filter(function (k) {
        return k !== key;
      });
      rebuild(); persist(true);
      toast("Benefit restored"); paint();
    },

    enablePush: function () {
      if (!pushSupported()) { closeModal(); return; }
      S.pushAsked = true;
      try { localStorage.setItem("snt_push_asked", "1"); } catch (e) {}
      window.Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") {
          S.pushState = perm === "denied" ? "blocked" : "off";
          closeModal(); paint();
          if (perm === "denied") {
            toast("Notifications blocked - you can turn them on in " +
                  "your browser settings", true);
          }
          return;
        }
        return window.navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(vapidKey())
          });
        }).then(function (sub) {
          return S.env.savePushSub(S.user.id, sub.toJSON());
        }).then(function () {
          S.pushState = "on";
          closeModal(); paint();
          toast("Reminders enabled");
        });
      }).catch(function () {
        S.pushState = "off"; closeModal(); paint();
        toast("Could not turn on reminders", true);
      });
    },

    dismissPush: function () {
      S.pushAsked = true;
      try { localStorage.setItem("snt_push_asked", "1"); } catch (e) {}
      closeModal(); paint();
    },

    disablePush: function () {
      window.navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription();
      }).then(function (sub) {
        return sub ? sub.unsubscribe() : null;
      }).then(function () {
        return S.env.deletePushSub(S.user.id);
      }).then(function () {
        S.pushState = "off"; toast("Reminders off"); paint();
      }).catch(function () { toast("Could not turn reminders off", true); });
    },

    saveOrder: function (card, keys) {
      if (!card || !keys || !keys.length) return;
      S.profile.order = S.profile.order || {};
      S.profile.order[card] = keys;
      persist(true);
    },

    resetOrder: function () {
      S.profile.order = {};
      persist(true);
      closeModal(); toast("Default order restored"); paint();
    },

    saveNote: function (key, text) {
      var t = L.cleanNote(text);
      S.profile.notes = S.profile.notes || {};
      if (t) S.profile.notes[key] = t;
      else delete S.profile.notes[key];
      rebuild(); persist(true);
      closeModal(); toast(t ? "Note saved" : "Note removed"); paint();
    },

    saveCardNote: function (card, text) {
      var t = L.cleanNote(text);
      S.profile.cardNotes = S.profile.cardNotes || {};
      if (t) S.profile.cardNotes[card] = t;
      else delete S.profile.cardNotes[card];
      persist(true);
      closeModal(); toast(t ? "Pinned note saved" : "Pinned note removed");
      paint();
    },

    removeCards: function (cards) {
      S.profile.cards = S.profile.cards.filter(function (c) {
        return cards.indexOf(c) < 0;
      });
      cards.forEach(function (c) { delete S.profile.anniversaries[c]; });
      S.profile.hidden = (S.profile.hidden || []).filter(function (k) {
        return cards.indexOf(k.split("||")[0]) < 0;
      });
      S.profile.notes = S.profile.notes || {};
      Object.keys(S.profile.notes).forEach(function (k) {
        if (cards.indexOf(k.split("||")[0]) >= 0) {
          delete S.profile.notes[k];
        }
      });
      S.profile.cardNotes = S.profile.cardNotes || {};
      cards.forEach(function (c) { delete S.profile.cardNotes[c]; });
      S.profile.order = S.profile.order || {};
      cards.forEach(function (c) { delete S.profile.order[c]; });
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

  function rawErrorText(err) {
    if (!err) return "(no details)";
    var parts = [];
    if (err.code) parts.push("code " + err.code);
    if (err.message) parts.push(err.message);
    if (err.hint) parts.push("hint: " + err.hint);
    if (err.details) parts.push(err.details);
    return parts.length ? parts.join(" | ") : String(err);
  }

  function describeDbError(err) {
    var msg = (err && (err.message || err.error_description)) ||
              String(err || "");
    var code = err && err.code ? String(err.code) : "";
    if (/failed to fetch|networkerror|load failed|fetch event/i.test(msg)) {
      return "Your phone could not reach Supabase at all. Either you are " +
        "offline, or your Supabase project is paused - open supabase.com, " +
        "tap your project, and press Restore if you see it.";
    }
    if (code === "PGRST205" || code === "42P01" ||
        /schema cache|relation .*does not exist|could not find the table/i.test(msg)) {
      return "The 'dashboards' table does not exist in the project your " +
        "keys point at. Run the setup SQL again - and make sure you run it " +
        "in the SAME Supabase project whose URL is in your config.js.";
    }
    if (code === "42501" || /row-level security|permission denied/i.test(msg)) {
      return "The table exists but its security policy is missing. Re-run " +
        "the 'alter table' and 'create policy' lines from the setup SQL.";
    }
    if (/jwt|not authenticated|invalid token|no api key/i.test(msg)) {
      return "You are signed up but not fully signed in. In Supabase, turn " +
        "OFF Authentication -> Email -> 'Confirm email', then log in again.";
    }
    return msg || "Unknown error.";
  }

  /* ---------------- push notifications ---------------- */
  function vapidKey() {
    var k = (window.BENNYS_CONFIG || {}).VAPID_PUBLIC_KEY || "";
    return String(k).trim();
  }

  function pushSupported() {
    return typeof window !== "undefined" &&
      "serviceWorker" in (window.navigator || {}) &&
      typeof window.PushManager !== "undefined" &&
      typeof window.Notification !== "undefined" &&
      !!vapidKey();
  }

  /* VAPID keys are base64url; PushManager wants raw bytes. */
  function urlB64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding)
      .replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  function refreshPushState() {
    if (!pushSupported()) { S.pushState = "unsupported"; return Promise.resolve(); }
    if (window.Notification.permission === "denied") {
      S.pushState = "blocked"; return Promise.resolve();
    }
    return window.navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      S.pushState = sub ? "on" : "off";
    }).catch(function () { S.pushState = "off"; });
  }

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
      '<img class="hero-icon" src="icon-192.png" alt="stackNtrack">' +
      '<div class="wordmark"><span class="wm-1">stack</span>' +
      '<span class="wm-2">N</span><span class="wm-3">track</span></div>' +
      '<div class="hero-thesis">Never let a credit die.</div>' +
      '<div class="hero-sub">Pick your cards and get a live dashboard ' +
      'of every credit, free night, and deadline you are owed. ' +
      'Customize it around the cards and benefits that matter to ' +
      'you. No bank logins - ever.' +
      '</div></div>';
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
    h += '<div class="hint" style="text-align:center;opacity:.55">' +
      'stackNtrack v' + BUILD + '</div>';
    return h;
  }

  function pickerHTML(idPrefix, query, chosen, pool) {
    var q = (query || "").toLowerCase();
    var toks = q.split(/\s+/).filter(Boolean);
    var items = pool.filter(function (c) {
      if (chosen.indexOf(c) >= 0) return false;
      if (!toks.length) return true;
      var hay = cardHaystack(c);
      return toks.every(function (t) { return hay.indexOf(t) >= 0; });
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
          '-tag" data-v="' + esc(c) + '">' + cardArtHTML(c, "sm") +
          '<span class="pi-name">' + esc(cardLabel(c)) +
          ' <span class="fee">' + L.symbolFor(cardCurrency(c)) +
          S.catalog.cards[c].annual_fee + '/yr</span></span></div>';
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
        '<b>' + esc(cardLabel(c)) + '</b> anniversary</div>' +
        '<div class="row2">';
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
        '<div><div class="wm-inline"><span class="a">Welcome to ' +
        'stack</span><span class="n">N</span><span class="b">track</span>' +
        '</div>' +
        '<div class="brand-tag">' + esc(S.user.email) + '</div></div>' +
        '</div>' +
        '<div class="hero-thesis" style="font-size:.95rem;' +
        'margin:.35rem 0 .1rem">Customize your dashboard to fit ' +
        'your needs.</div>' +
        '<div class="hint">Last step - add the cards you carry. ' +
        'You can then hide any credits you do not use and add notes ' +
        'to the ones you do.</div>';
    } else {
      h = heroHTML();
    }
    h += pickerHTML("pick", S.pickQuery, S.pick, CARD_ORDER);
    var need = cardsNeedingDates(S.pick);
    if (need.length) {
      h += '<div class="sub" style="margin-top:.7rem">Account ' +
        'anniversary dates - these unlock exact free-night and ' +
        'travel-credit deadlines. Leave blank if unsure (you can add ' +
        'them later in the &#65291;&#8202;/&#8202;&#8722; Cards tab).</div>';
      h += annivRowsHTML("ann", need);
    }
    h += '<div class="err" id="ob-err"></div>';
    h += '<button data-a="create" ' +
      (S.pick.length ? "" : "disabled") + '>Create my dashboard</button>';
    return h;
  }

  function progressHTML(used, total, cur, label) {
    var pct = total > 0 ? Math.round((used / total) * 100) : 0;
    return '<div class="vwrap">' +
      '<div class="vbar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="vlab">' + label + '</div></div>';
  }

  function cardNoteHTML(card) {
    var note = (S.profile.cardNotes || {})[card] || "";
    if (note) {
      return '<div class="pinned" data-a="note-open" data-kind="card" ' +
        'data-id="' + esc(card) + '" role="button" tabindex="0">' +
        '<span class="note-pin">&#128204;</span>' +
        '<span class="note-text">' + esc(note) + '</span>' +
        '<span class="note-edit">&#9998;</span></div>';
    }
    return '<button class="addnote" data-a="note-open" ' +
      'data-kind="card" data-id="' + esc(card) + '">' +
      '&#65291; Add a pinned note</button>';
  }

  function benefitHTML(b, compact) {
    var urgent = L.isExpiringSoon(b, now());
    var used = !b.available;
    var cls = "benefit-card" + (urgent ? " urgent" : "") +
              (used ? " used" : "") + (compact ? "" : " draggable");
    var warn = urgent ?
      '<span class="expires-soon">&#9679; EXPIRING</span> ' : "";
    var val = L.fmtValue(b.value, b.currency);
    var plabel = compact ? L.periodLabel(b, now()) : null;
    var pills = plabel
      ? ['<span class="pill period">' + esc(plabel) + '</span>']
      : ['<span class="pill">' + esc(b.reset) + '</span>'];
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
    return '<div class="' + cls + '" data-key="' + esc(b.key) + '">' +
      (compact ? '' :
        '<div class="bc-grip" data-a="grip" title="Drag to reorder" ' +
        'aria-label="Drag to reorder">&#8942;&#8942;</div>') +
      '<div class="bc-top"><div class="card-name">' + esc(b.card) +
      '</div>' + (val ? '<div class="bc-value">' + esc(val) +
      '</div>' : "") + '</div>' +
      '<div class="benefit-name">' + warn + esc(b.benefit) + '</div>' +
      '<div class="benefit-meta">' + pills.join("") + '</div>' +
      '<div class="benefit-desc">' + esc(b.desc) + '</div>' +
      valueLineHTML(b) +
      (b.note
        ? '<div class="note" data-a="note-open" data-kind="benefit" ' +
          'data-id="' + esc(b.key) + '" role="button" tabindex="0">' +
          '<span class="note-pin">&#9998;</span>' +
          '<span class="note-text">' + esc(b.note) + '</span></div>'
        : '') +
      '<div class="bc-foot">' +
      '<div class="bc-toggle">' + toggleHTML(b, compact) + '</div>' +
      '<button class="bc-note" data-a="note-open" data-kind="benefit" ' +
      'data-id="' + esc(b.key) + '" title="' +
      (b.note ? 'Edit note' : 'Add note') + '" aria-label="' +
      (b.note ? 'Edit note' : 'Add note') + '">' +
      (b.note ? '&#9998;' : '&#65291;') + '</button>' +
      '<button class="bc-x" data-a="hide-open" data-k="' + esc(b.key) +
      '" title="Remove this benefit" aria-label="Remove this benefit">' +
      '&times;</button>' +
      '</div></div>';
  }

  function valueLineHTML(b) {
    var total = L.annualValue(b);
    if (!total) return "";
    var used = L.usedValue(b), left = L.remainingValue(b);
    var cur = b.currency;
    var zero = L.symbolFor(cur) + "0";
    if (L.RECURRING[b.reset]) {
      return progressHTML(used, total, cur,
        '<b>' + esc(L.fmtValue(left, cur) || zero) + '</b> remaining of ' +
        esc(L.fmtValue(total, cur)) + ' this year' +
        (used ? ' &middot; ' + esc(L.fmtValue(used, cur)) + ' used' : ''));
    }
    return '<div class="vlab solo">' + (used
      ? esc(L.fmtValue(used, cur)) + ' used'
      : '<b>' + esc(L.fmtValue(total, cur)) + '</b> available') +
      '</div>';
  }

  function toggleHTML(b, compact) {
    var t = L.today(now());
    if (L.RECURRING[b.reset] && compact) {
      // Alerts view: only the period that is actually expiring.
      var cur0 = L.currentPeriod(b.reset, t);
      var used0 = (b.used_periods || []).indexOf(cur0) >= 0;
      return '<div class="tgrow"><label class="switch">' +
        '<input type="checkbox" data-a="period" data-k="' + esc(b.key) +
        '" data-p="' + cur0 + '"' + (used0 ? " checked" : "") + '>' +
        '<span class="track"></span></label>' +
        '<span class="tglabel">Used ' +
        esc(L.periodLabel(b, now())) + '</span></div>';
    }
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
    return (b.benefit + " " + b.card + " " + b.desc + " " +
            cardHaystack(b.card)).toLowerCase().indexOf(q) >= 0;
  }

  function dashView() {
    var t = now();
    var visible = S.benefits.filter(matchesSearch);
    var urgentAll = S.benefits.filter(function (b) {
      return L.isExpiringSoon(b, t);
    });
    var avail = S.benefits.filter(function (b) { return b.available; });
    var sum = L.summarize(S.benefits);
    var leftByCur = {}, usedByCur = {};
    Object.keys(sum.byCur).forEach(function (c) {
      leftByCur[c] = sum.byCur[c].left;
      usedByCur[c] = sum.byCur[c].used;
    });
    var openVal = L.fmtTotals(leftByCur);

    var h = '<div class="brand">' +
      '<img class="brand-icon" src="icon-192.png" alt="">' +
      '<div><div class="wm-inline"><span class="a">stack</span>' +
        '<span class="n">N</span><span class="b">track</span></div>' +
      '<div class="brand-tag">' + S.profile.cards.length + ' cards - ' +
      L.fmtDate(L.today(t)) +
      '<span class="savedot' +
      (S.saving === "saving" ? " saving" :
       S.saving === "error" ? " bad" : "") + '"></span>' +
      '</div></div>' +
      '<button class="gear" data-a="settings-open" title="Settings" ' +
      'aria-label="Settings">&#9881;</button>' +
      '</div>' +
      '<div class="hint">Mark a credit as used once you have redeemed ' +
      'it. Changes save automatically.</div>';

    if (S.installable()) {
      h += '<button class="ghost" data-a="install">&#8681; Install ' +
        'stackNtrack on this phone</button>';
    }

    h += '<div class="stat-row">' +
      '<div class="stat-box"><div class="stat-num green">' +
      avail.length + '</div><div class="stat-lab">Available</div></div>' +
      '<div class="stat-box"><div class="stat-num gold">' +
      urgentAll.length + '</div><div class="stat-lab">Expiring soon' +
      '</div></div>' +
      '<div class="stat-box"><div class="stat-num">' +
      (openVal || "0") +
      '</div><div class="stat-lab">Value left</div></div></div>';

    var dom = sum.byCur[sum.dominant];
    if (dom && dom.total) {
      h += progressHTML(dom.used, dom.total, sum.dominant,
        '<b>' + esc(L.fmtTotals(usedByCur) ||
          L.symbolFor(sum.dominant) + "0") + '</b> used this year of ' +
        esc(L.fmtValue(dom.total, sum.dominant)) +
        (Object.keys(sum.byCur).length > 1 ? ' (main currency)' : ''));
    }

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
        cardArtHTML(c, "xs") +
        esc(S.catalog.cards[c].tab_label) + '</button>';
    });
    h += '<button class="chip' +
      (S.tab === "manage" ? " active" : "") +
      '" data-a="tab" data-v="manage">&#65291;&#8202;/&#8202;&#8722; Cards</button>';
    h += '</div>';

    if (S.tab === "alerts") {
      var urg = L.sortGroup(urgentAll.filter(matchesSearch), t);
      if (!urg.length) {
        h += '<div class="empty-note">Nothing requires attention right now. ' +
          'No monthly credit expires within ' + L.EXPIRE_SOON_DAYS +
          ' days, and nothing else within ' + L.EXPIRE_SOON_DAYS_LONG +
          ' days.</div>';
      }
      h += '<div class="benefit-list alerts-list">';
      urg.forEach(function (b) { h += benefitHTML(b, true); });
      h += '</div>';
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
      var gCur = cardCurrency(card);
      var gSum = L.summarize(group);
      var gc = gSum.byCur[gCur] || { total: 0, used: 0, left: 0 };
      var gz = L.symbolFor(gCur) + "0";
      h += '<div class="card-hero">' +
        '<div class="h-top">' + cardArtHTML(card, "lg") +
        '<div class="h-name">' + esc(cardLabel(card)) + '</div></div>' +
        '<div class="h-meta">' +
        esc(S.catalog.cards[card].meta) + '</div>' +
        '<div class="h-stats">' + gAvail.length + ' available &middot; ' +
        gUrg.length + ' expiring soon</div>' +
        (gc.total ? progressHTML(gc.used, gc.total, gCur,
          '<b>' + esc(L.fmtValue(gc.left, gCur) || gz) +
          '</b> remaining &middot; ' +
          esc(L.fmtValue(gc.used, gCur) || gz) + ' of ' +
          esc(L.fmtValue(gc.total, gCur)) + ' used this year') : '') +
        cardNoteHTML(card) +
        '</div>';
      if (!group.length) {
        h += '<div class="empty-note">No benefits on this card match ' +
          'your search.</div>';
      }
      h += '<div class="benefit-list" data-card="' + esc(card) + '">';
      L.applyCustomOrder(group, (S.profile.order || {})[card], t)
        .forEach(function (b) { h += benefitHTML(b); });
      h += '</div>';
    }
    return h;
  }

  function manageView() {
    var h = '<div class="card-hero"><div class="h-name">Manage your ' +
      'cards</div>' +
      '<div class="h-tag">Customize your dashboard to fit your ' +
      'needs.</div>' +
      '<div class="h-meta">Add a new card and your dashboard updates ' +
      'immediately. You can also update anniversary dates, remove ' +
      'closed cards, or hide credits you do not use.</div></div>';

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
    var hid = S.profile.hidden || [];
    if (hid.length) {
      h += '<details class="section"><summary>Removed benefits (' +
        hid.length + ')</summary>' +
        '<div class="sub">These are hidden from your dashboard. Tap ' +
        'Restore to bring one back.</div>' +
        hid.map(function (k) {
          var parts = k.split("||");
          return '<div class="hidrow"><div class="hidname">' +
            esc(parts[1] || k) + '<div class="hidcard">' +
            esc(parts[0] || "") + '</div></div>' +
            '<button class="ghost hidbtn" data-a="restore" data-k="' +
            esc(k) + '">Restore</button></div>';
        }).join("") + '</details>';
    }
    h += '<hr class="thin">' +
      '<div class="hint">Account, reminders, help and reset now live ' +
      'under the &#9881; gear at the top of the screen.</div>';
    return h;
  }

  function hideModalHTML(key) {
    var b = S.benefits.find(function (x) { return x.key === key; });
    var name = b ? b.benefit : "this benefit";
    var card = b ? b.card : "";
    return '<div class="modal-back" data-a="modal-back">' +
      '<div class="modal"><h3>Remove this benefit?</h3>' +
      '<div class="sub" style="font-size:.95rem;color:var(--ink);' +
      'font-weight:600">' + esc(name) + '</div>' +
      '<div class="hint">' + esc(card) + ' &mdash; this hides the ' +
      'benefit from your dashboard, alerts, and totals. Useful for ' +
      'benefits offered by several cards, such as Global Entry or ' +
      'Priority Pass, or credits you do not use. You can restore it ' +
      'at any time from the &#65291;&#8202;/&#8202;&#8722; Cards ' +
      'tab.</div>' +
      '<div class="row2">' +
      '<button class="danger" data-a="hide-yes" data-k="' + esc(key) +
      '">Yes, remove this benefit</button>' +
      '<button class="ghost" data-a="hide-no">Cancel</button>' +
      '</div></div></div>';
  }

  function noteModalHTML(kind, id) {
    var isCard = kind === "card";
    var existing = isCard
      ? ((S.profile.cardNotes || {})[id] || "")
      : ((S.profile.notes || {})[id] || "");
    var b = isCard ? null : S.benefits.find(function (x) {
      return x.key === id;
    });
    var title = isCard ? "Pinned note" : "Note";
    var subject = isCard ? cardLabel(id) : (b ? b.benefit : "this credit");
    var hint = isCard
      ? "Displayed at the top of this card. Use it for anything that " +
        "applies to the card as a whole, such as a retention offer or " +
        "a renewal decision."
      : "Private to your account. Useful for targeted offers, redemption " +
        "plans, or confirmation numbers.";
    return '<div class="modal-back" data-a="modal-back">' +
      '<div class="modal"><h3>' + esc(title) + '</h3>' +
      '<div class="sub" style="font-size:.95rem;color:var(--ink);' +
      'font-weight:600">' + esc(subject) + '</div>' +
      '<div class="hint">' + hint + '</div>' +
      '<textarea id="note-text" class="notebox" rows="3" maxlength="' +
      L.NOTE_MAX + '" placeholder="Add a note..."' +
      '>' + esc(existing) + '</textarea>' +
      '<div class="notecount"><span id="note-count">' +
      existing.length + '</span> / ' + L.NOTE_MAX + '</div>' +
      '<div class="row2">' +
      '<button data-a="note-save" data-kind="' + esc(kind) +
      '" data-id="' + esc(id) + '">Save note</button>' +
      '<button class="ghost" data-a="note-cancel">Cancel</button>' +
      '</div>' +
      (existing ? '<button class="link" data-a="note-clear" ' +
        'data-kind="' + esc(kind) + '" data-id="' + esc(id) +
        '">Delete this note</button>' : '') +
      '</div></div>';
  }

  function pushModalHTML() {
    return '<div class="modal-back" data-a="modal-back">' +
      '<div class="modal"><h3>Never miss an expiring credit</h3>' +
      '<div class="sub">Receive a reminder before a credit expires - ' +
      'a monthly credit three days before month end, bigger benefits ' +
      'further ahead.</div>' +
      '<div class="hint">One reminder at a time, and only for credits ' +
      'you have not yet marked as used. You can turn reminders off ' +
      'at any time in Settings.</div>' +
      '<div class="row2">' +
      '<button data-a="push-enable">Turn on reminders</button>' +
      '<button class="ghost" data-a="push-later">Not now</button>' +
      '</div></div></div>';
  }

  function settingsModalHTML() {
    var h = '<div class="modal-back" data-a="modal-back">' +
      '<div class="modal sheet">' +
      '<div class="sheet-head"><h3>Settings</h3>' +
      '<button class="sheet-x" data-a="settings-close" ' +
      'aria-label="Close">&times;</button></div>' +
      '<div class="sheet-body">';

    h += '<div class="set-sec"><div class="set-lab">Account</div>' +
      '<div class="sub">Signed in as <b>' + esc(S.user.email) +
      '</b></div></div>';

    if (!pushSupported()) {
      var why = !vapidKey()
        ? "Reminders are not switched on for this app yet. If you are " +
          "the owner: add VAPID_PUBLIC_KEY to config.js."
        : "This browser does not support notifications. On iPhone, " +
          "add stackNtrack to your Home Screen first.";
      h += '<div class="set-sec"><div class="set-lab">Reminders</div>' +
        '<div class="sub">' + esc(why) + '</div></div>';
    }
    if (pushSupported()) {
      var on = S.pushState === "on";
      var blocked = S.pushState === "blocked";
      h += '<div class="set-sec"><div class="set-lab">Reminders</div>' +
        '<div class="sub">' + (blocked
          ? 'Notifications are blocked for this site in your browser.'
          : (on ? 'You will be reminded before a credit expires.'
                : 'Receive a reminder before a credit expires.')) + '</div>' +
        (blocked
          ? '<div class="hint">Chrome: &#8942; menu &rarr; Settings ' +
            '&rarr; Site settings &rarr; Notifications.</div>'
          : '<button class="ghost" data-a="push-toggle">' +
            (on ? "Turn off reminders" : "Turn on reminders") +
            '</button>') +
        '</div>';
    }

    var ordered = Object.keys(S.profile.order || {}).length;
    h += '<div class="set-sec"><div class="set-lab">Layout</div>' +
      '<div class="sub">' + (ordered
        ? 'You have reordered credits on ' + ordered + ' card' +
          (ordered === 1 ? '' : 's') + '.'
        : 'Drag the handle on any credit to change its position.') +
      '</div>' +
      (ordered ? '<button class="ghost" data-a="order-reset">' +
        'Restore the default order</button>' : '') + '</div>';

    h += '<div class="set-sec"><div class="set-lab">How stackNtrack ' +
      'works</div>' + helpHTML() + '</div>';

    h += '<div class="set-sec"><div class="set-lab">About</div>' +
      '<div class="sub">Card catalog ' +
      esc(S.catalog.catalog_version || "?") + ' &middot; ' +
      Object.keys(S.catalog.cards).length + ' cards</div>' +
      '<div class="sub">App version ' + BUILD + '</div>' +
      '<div class="hint">Benefit data is reviewed against issuer ' +
      'sources on a regular schedule.</div></div>';

    h += '<div class="set-sec"><div class="set-lab">Account ' +
      'actions</div>' +
      '<button class="ghost" data-a="logout">Log out</button>' +
      '<button class="ghost" data-a="reset-open">Reset dashboard' +
      '</button>' +
      '<div class="hint">Resetting clears your cards, notes, and ' +
      'usage history. Your account remains active.</div></div>';

    return h + '</div></div></div>';
  }

  function helpQ(q, a) {
    return '<details class="qa"><summary>' + q + '</summary>' +
      '<div class="qa-a">' + a + '</div></details>';
  }

  function helpHTML() {
    return '<div class="hint" style="margin-bottom:.5rem">Select the cards ' +
      'you hold, and stackNtrack tracks every credit they carry along ' +
      'with its expiration date.</div>' +
      helpQ("Marking a credit used",
        "Toggle a credit once you have redeemed it. Monthly credits " +
        "provide a switch for each month and quarterly credits one per " +
        "quarter, so you can record past periods you missed. Changes " +
        "save automatically.") +
      helpQ("What the meter means",
        "A $10 monthly credit is worth $120 annually. The bar fills as " +
        "you redeem it, and the card header shows the remaining value. " +
        "Per-stay benefits have no fixed annual value and are " +
        "excluded from totals.") +
      helpQ("Adding a note",
        "Select the &#65291; on any credit to add up to 100 characters " +
        "- a targeted offer, a redemption plan, or a confirmation " +
        "number. For information that applies to an entire card, use " +
        "<b>Add a pinned note</b> at the top of that card. Select any " +
        "note to edit or delete it.") +
      helpQ("Reordering credits",
        "On a card's tab, press and drag the handle (&#8942;&#8942;) to " +
        "the left of any credit to reposition it. Your arrangement is " +
        "saved automatically. The alerts tab always sorts by " +
        "expiration date.") +
      helpQ("Hiding credits you will never use",
        "Select the &times; on a credit to remove it from your " +
        "dashboard - useful when several cards provide the same " +
        "benefit, such as Global Entry. Nothing is deleted: restore " +
        "it at any time from <b>Removed benefits</b> in " +
        "&#65291;&#8202;/&#8202;&#8722; Cards.") +
      helpQ("The &#9888;&#65039; alerts tab",
        "Everything approaching expiration, in one place. Monthly " +
        "credits appear 30 days in advance, all others 60 days in " +
        "advance. Each shows only the period at risk rather than the " +
        "full year.") +
      helpQ("Anniversary dates",
        "Some benefits reset on your account anniversary rather than at " +
        "the start of the calendar year. Enter those dates in " +
        "&#65291;&#8202;/&#8202;&#8722; Cards and stackNtrack " +
        "calculates the exact deadline. If left blank, dates are " +
        "estimated.") +
      helpQ("Your data and privacy",
        "stackNtrack does not request bank credentials and has no " +
        "access to your accounts or transactions. It stores only the " +
        "cards you select, the credits you mark as used, and your " +
        "notes - secured to your account and visible to no one else.");
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
  function dismissInstall() {
    S.installDismissed = true;
    try { localStorage.setItem("bennys_install_dismissed", "1"); }
    catch (e) {}
  }

  function shouldShowInstallGate() {
    return !S.platform.standalone && !S.installDismissed;
  }

  function installView() {
    var h = '<div class="hero" style="padding-bottom:.4rem">' +
      '<img class="hero-icon" src="icon-192.png" alt="stackNtrack">' +
      '<div class="wordmark"><span class="wm-1">stack</span>' +
      '<span class="wm-2">N</span><span class="wm-3">track</span></div>' +
      '<div class="hero-thesis">Never let a credit die.</div></div>';

    h += '<div class="sub" style="text-align:center;font-size:.92rem;' +
      'color:var(--ink);font-weight:600;margin-top:.2rem">' +
      'First, add stackNtrack to your home screen</div>' +
      '<div class="hint" style="text-align:center">It installs like a ' +
      'normal app - its own icon, full screen, no browser bar. ' +
      'Takes 5 seconds.</div>';

    if (S.platform.ios) {
      h += '<div class="section">' +
        '<div class="sub"><b>On iPhone / iPad:</b></div>' +
        '<div class="sub">1. Tap the <b>Share</b> button at the bottom ' +
        'of Safari &mdash; the square with an arrow pointing up ' +
        '<span style="display:inline-block;vertical-align:-3px">' +
        '<svg width="15" height="17" viewBox="0 0 15 17" fill="none" ' +
        'stroke="#7FB4FF" stroke-width="1.4"><path d="M7.5 11V2M7.5 2 ' +
        'L4.5 5M7.5 2 L10.5 5"/><path d="M3 8H1.8v7.2h11.4V8H12"/>' +
        '</svg></span></div>' +
        '<div class="sub">2. Scroll down and tap <b>Add to Home ' +
        'Screen</b></div>' +
        '<div class="sub">3. Tap <b>Add</b> in the top corner</div>' +
        '<div class="hint">Then open stackNtrack from your home screen ' +
        'and '
        'create your account there.</div></div>';
    } else if (S.deferredInstall) {
      h += '<button data-a="install-now">&#8681; Add stackNtrack to my ' +
        'home '
        'screen</button>' +
        '<div class="hint" style="text-align:center">Your phone will ask ' +
        'you to confirm - tap Install.</div>';
    } else if (S.platform.android) {
      h += '<div class="section">' +
        '<div class="sub"><b>On Android:</b></div>' +
        '<div class="sub">1. Tap the <b>&#8942; menu</b> in the top ' +
        'right of Chrome</div>' +
        '<div class="sub">2. Tap <b>Add to Home screen</b> (or ' +
        '<b>Install app</b>)</div>' +
        '<div class="sub">3. Tap <b>Install</b></div>' +
        '<div class="hint">If you opened this link inside Facebook, ' +
        'Instagram, or Messenger, tap the &#8942; menu and choose ' +
        '"Open in Chrome" first.</div></div>';
    } else {
      h += '<div class="section">' +
        '<div class="sub">In your browser menu, choose <b>Install ' +
        'stackNtrack</b> or <b>Add to Home screen</b>. On a computer, ' +
        'look '
        'for the install icon at the right of the address bar.</div>' +
        '</div>';
    }

    h += '<button class="ghost" data-a="install-skip">' +
      'Skip - just use it in the browser</button>';
    h += '<div class="hint" style="text-align:center;opacity:.55">' +
      'stackNtrack v' + BUILD + '</div>';
    return h;
  }

  function errorView() {
    return heroHTML() +
      '<div class="section" style="border-color:rgba(224,86,79,.5)">' +
      '<div class="sub" style="color:#ff9d96;font-weight:700">' +
      'Could not load your dashboard</div>' +
      '<div class="sub">' + esc(S.errMsg) + '</div>' +
      '<details class="section" style="margin-top:.6rem">' +
      '<summary>Exact message from Supabase</summary>' +
      '<div class="hint" style="word-break:break-word">' +
      esc(S.errRaw) + '</div></details>' +
      '<button data-a="retry">Try again</button>' +
      '<button class="ghost" data-a="logout">Log out</button>' +
      '</div>';
  }

  function view() {
    if (S.screen === "loading") {
      return '<div class="hero" style="padding-top:4rem">' +
        '<div class="wordmark"><span class="wm-1">stack</span>' +
        '<span class="wm-2">N</span><span class="wm-3">track</span>' +
        '</div><div class="hero-sub">Loading&hellip;</div></div>';
    }
    if (S.screen === "auth") return authView();
    if (S.screen === "onboard") return onboardView();
    if (S.screen === "dash") return dashView();
    if (S.screen === "install") return installView();
    if (S.screen === "error") return errorView();
    return "";
  }

  var paint = function () {};          // replaced in browser boot
  var toast = function () {};
  var closeModal = function () {};
  function val() { return "0"; }       // replaced in browser boot

  S.installable = function () { return !!S.deferredInstall; };
  S._proceed = function () { S.screen = "auth"; paint(); };

  /* ========= config normalizer / self-diagnosis =========
     Repairs the mistakes that actually happen when pasting on a
     phone, and explains anything it cannot repair in plain English. */
  function normalizeSupabase(cfg) {
    cfg = cfg || {};
    var out = { url: "", key: "", problems: [], fixes: [] };
    var rawUrl = String(cfg.SUPABASE_URL == null ? "" : cfg.SUPABASE_URL);
    var rawKey = String(cfg.SUPABASE_ANON_KEY == null ? ""
                        : cfg.SUPABASE_ANON_KEY);

    // strip ALL whitespace incl. newlines pasted by mobile keyboards
    var u = rawUrl.replace(/\s+/g, "");
    var k = rawKey.replace(/\s+/g, "");
    if (u !== rawUrl.trim()) out.fixes.push("Removed stray spaces from the URL.");
    if (k !== rawKey.trim()) out.fixes.push("Removed stray spaces from the key.");

    if (!u || u.indexOf("PASTE_") === 0) {
      out.problems.push("No Project URL has been pasted into config.js yet.");
    } else {
      if (!/^https?:\/\//i.test(u)) { u = "https://" + u; out.fixes.push("Added https:// to the URL."); }
      var host = "", path = "";
      try { var p = new URL(u); host = p.host; path = p.pathname; }
      catch (e) { out.problems.push("That Project URL is not a valid web address."); }

      if (host) {
        // the classic mistake: the dashboard address, not the project address
        var dash = host.match(/(^|\.)supabase\.com$/i) &&
                   path.match(/\/project\/([a-z0-9]+)/i);
        if (dash) {
          host = dash[1] + ".supabase.co";
          out.fixes.push("You pasted your Supabase dashboard address. " +
            "I converted it to your project address (" + host + ").");
        } else if (!/supabase\.(co|in|red)$/i.test(host)) {
          out.problems.push("Your Project URL should end in .supabase.co - " +
            "yours points at \"" + host + "\". Copy it from Supabase: " +
            "Project Settings -> API -> Project URL.");
        } else if (path && path !== "/") {
          out.fixes.push("Removed the extra \"" + path + "\" from the end of the URL.");
        }
        out.url = "https://" + host;      // origin only: no path, no slash
      }
    }

    if (!k || k.indexOf("PASTE_") === 0) {
      out.problems.push("No anon key has been pasted into config.js yet.");
    } else if (/^sb_secret_/i.test(k)) {
      out.problems.push("That is your SECRET key. Use the anon (publishable) key instead - " +
        "and rotate the secret one in Supabase, since it is now public.");
    } else if (/^eyJ/.test(k)) {
      var isService = false;
      try {
        var body = JSON.parse(atob(k.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        isService = body && body.role === "service_role";
      } catch (e) {}
      if (isService) {
        out.problems.push("That is your service_role key. Use the anon public key - " +
          "and rotate the service_role key in Supabase, since it is now public.");
      } else if (k.length < 100) {
        out.problems.push("Your anon key looks cut off (only " + k.length +
          " characters - a full key is several hundred). Re-copy it with the copy button.");
      } else { out.key = k; }
    } else if (/^sb_publishable_/i.test(k)) {
      out.key = k;
    } else {
      out.problems.push("Your anon key does not look right - it should start with " +
        "\"eyJ\" or \"sb_publishable_\".");
    }
    return out;
  }

  /* ================= browser boot ================= */
  function boot() {
    var CFG = window.BENNYS_CONFIG || {};

    var ua = (navigator.userAgent || "");
    S.platform.ios = /iphone|ipad|ipod/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    S.platform.android = /android/i.test(ua);
    try {
      S.platform.standalone =
        (window.matchMedia &&
         window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true;
    } catch (e) { S.platform.standalone = false; }
    try {
      S.installDismissed =
        localStorage.getItem("bennys_install_dismissed") === "1";
    } catch (e) { S.installDismissed = false; }
    try {
      S.pushAsked = localStorage.getItem("snt_push_asked") === "1";
    } catch (e) { S.pushAsked = false; }
    // Preview override: adding ?install=1 to the URL always shows the
    // install screen, even if you have already installed or skipped.
    try {
      if (/[?&]install=1/.test(location.search)) {
        S.installDismissed = false;
        S.platform.standalone = false;
      }
    } catch (e) {}
    var norm = normalizeSupabase(CFG);
    var sb = null;
    var configured = norm.problems.length === 0 && norm.url && norm.key;
    if (configured && window.supabase) {
      sb = window.supabase.createClient(norm.url, norm.key);
    }

    /* Boot diagnostics. A silent hang is the worst failure mode - it
       tells the user nothing and tells us nothing. Every stage is named,
       a watchdog fires if we never finish, and nothing is left
       unhandled. */
    var BOOT_STAGE = "starting";
    var bootFinished = false;

    function bootFail(headline, detail) {
      bootFinished = true;
      var el = document.getElementById("app");
      if (!el) return;
      el.innerHTML = heroHTML() +
        '<div class="section" style="border-color:rgba(224,86,79,.5)">' +
        '<div class="sub" style="color:#ff9d96"><b>' + esc(headline) +
        '</b></div>' +
        '<div class="hint">Stage: ' + esc(BOOT_STAGE) +
        (detail ? ' &middot; ' + esc(String(detail).slice(0, 140)) : '') +
        '</div></div>' +
        '<button data-a="retry-boot">Try again</button>';
      var btn = document.querySelector('[data-a="retry-boot"]');
      if (btn) {
        btn.addEventListener("click", function () { location.reload(); });
      }
    }

    setTimeout(function () {
      if (!bootFinished) {
        bootFail("stackNtrack is taking longer than expected to start.",
                 "no response");
      }
    }, 15000);

    function withTimeout(p, ms, label) {
      return Promise.race([p, new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("timed out: " + label));
        }, ms);
      })]);
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
      if (drag) return;              // never re-render mid-drag
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
      },
      savePushSub: function (uid, sub) {
        return sb.from("push_subs").upsert({
          user_id: uid, subscription: sub,
          updated_at: new Date().toISOString()
        }).then(function (r) { if (r.error) throw r.error; });
      },
      deletePushSub: function (uid) {
        return sb.from("push_subs").delete().eq("user_id", uid)
          .then(function (r) { if (r.error) throw r.error; });
      }
    };

    /* install prompt capture */
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      S.deferredInstall = e;
      if (S.screen === "dash" || S.screen === "install") paint();
    });
    window.addEventListener("appinstalled", function () {
      S.deferredInstall = null;
      dismissInstall();
      toast("stackNtrack installed - check your home screen");
      if (S.screen === "install" && S._proceed) S._proceed();
      else paint();
    });

    /* ---------------- drag to reorder ----------------
       Pointer events rather than HTML5 drag-and-drop, because the
       latter is unreliable on touch screens. Dragging is confined to a
       grip handle so it can never fight with scrolling or with the
       toggles inside a card. */
    var drag = null;

    function commitDrag() {
      if (!drag) return;
      var el = drag.el, list = drag.list, moved = drag.moved;
      el.classList.remove("dragging");
      el.style.transform = "";
      if (list) list.classList.remove("dragging-active");
      drag = null;
      if (!moved || !list) return;
      var card = list.getAttribute("data-card");
      var keys = Array.prototype.slice
        .call(list.querySelectorAll(".benefit-card"))
        .map(function (n) { return n.getAttribute("data-key"); })
        .filter(Boolean);
      A.saveOrder(card, keys);
      toast("Order saved");
    }

    document.addEventListener("pointerdown", function (e) {
      var t = e.target;
      var grip = t && t.closest ? t.closest(".bc-grip") : null;
      if (!grip) return;
      var el = grip.closest(".benefit-card");
      var list = el && el.closest(".benefit-list[data-card]");
      if (!el || !list) return;          // alerts list is not reorderable
      e.preventDefault();
      drag = { el: el, list: list, startY: e.clientY, moved: false,
               pointerId: e.pointerId };
      el.classList.add("dragging");
      list.classList.add("dragging-active");
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    });

    document.addEventListener("pointermove", function (e) {
      if (!drag) return;
      e.preventDefault();
      var dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 4) drag.moved = true;
      drag.el.style.transform = "translateY(" + dy + "px)";

      var rect = drag.el.getBoundingClientRect();
      var mid = rect.top + rect.height / 2;
      var sibs = Array.prototype.slice
        .call(drag.list.querySelectorAll(".benefit-card"));
      for (var i = 0; i < sibs.length; i++) {
        var o = sibs[i];
        if (o === drag.el) continue;
        var r = o.getBoundingClientRect();
        var omid = r.top + r.height / 2;
        var before = !!(drag.el.compareDocumentPosition(o) &
                        Node.DOCUMENT_POSITION_PRECEDING);
        if (dy < 0 && before && mid < omid) {
          drag.list.insertBefore(drag.el, o);
          drag.startY = e.clientY; drag.el.style.transform = "";
          break;
        }
        if (dy > 0 && !before && mid > omid) {
          drag.list.insertBefore(drag.el, o.nextSibling);
          drag.startY = e.clientY; drag.el.style.transform = "";
          break;
        }
      }
    });

    document.addEventListener("pointerup", commitDrag);
    document.addEventListener("pointercancel", commitDrag);

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
      else if (a === "settings-open") {
        document.getElementById("modal-root").innerHTML =
          settingsModalHTML();
      }
      else if (a === "settings-close") closeModal();
      else if (a === "order-reset") A.resetOrder();
      else if (a === "push-enable") A.enablePush();
      else if (a === "push-later") A.dismissPush();
      else if (a === "push-toggle") {
        if (S.pushState === "on") A.disablePush();
        else A.enablePush();
      }
      else if (a === "note-open") {
        document.getElementById("modal-root").innerHTML =
          noteModalHTML(el.getAttribute("data-kind"),
                        el.getAttribute("data-id"));
        var ta = document.getElementById("note-text");
        if (ta) {
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); }
          catch (e2) {}
        }
      }
      else if (a === "note-save") {
        var txt = val("note-text");
        if (el.getAttribute("data-kind") === "card") {
          A.saveCardNote(el.getAttribute("data-id"), txt);
        } else {
          A.saveNote(el.getAttribute("data-id"), txt);
        }
      }
      else if (a === "note-clear") {
        if (el.getAttribute("data-kind") === "card") {
          A.saveCardNote(el.getAttribute("data-id"), "");
        } else {
          A.saveNote(el.getAttribute("data-id"), "");
        }
      }
      else if (a === "note-cancel") closeModal();
      else if (a === "hide-open") {
        document.getElementById("modal-root").innerHTML =
          hideModalHTML(el.getAttribute("data-k"));
      }
      else if (a === "hide-yes") A.hideBenefit(el.getAttribute("data-k"));
      else if (a === "hide-no") closeModal();
      else if (a === "restore") A.restoreBenefit(el.getAttribute("data-k"));
      else if (a === "reset-open") {
        document.getElementById("modal-root").innerHTML =
          resetModalHTML();
      }
      else if (a === "reset-yes") A.resetDashboard();
      else if (a === "reset-no") closeModal();
      else if (a === "modal-back" && e.target === el) closeModal();
      else if (a === "retry") A.retry();
      else if (a === "logout") A.logout();
      else if (a === "install") {
        if (S.deferredInstall) {
          S.deferredInstall.prompt();
          S.deferredInstall = null; paint();
        }
      }
      else if (a === "install-now") {
        if (S.deferredInstall) {
          var ev = S.deferredInstall;
          S.deferredInstall = null;
          ev.prompt();
          var done = function () { dismissInstall(); S._proceed(); };
          if (ev.userChoice && ev.userChoice.then) {
            ev.userChoice.then(done, done);
          } else { done(); }
        }
      }
      else if (a === "install-skip") { dismissInstall(); S._proceed(); }
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
      else if (id === "note-text") {
        var c = document.getElementById("note-count");
        if (c) c.textContent = e.target.value.length;
      }
    });

    /* startup */
    window.__bennysDiag = function () {
      var box = document.getElementById("diag-out");
      box.textContent = "Testing...";
      fetch(norm.url + "/auth/v1/health", {
        headers: { apikey: norm.key }
      }).then(function (r) {
        box.innerHTML = r.ok
          ? '<span style="color:#6fd39a">Connected. Your URL and key ' +
            'are correct - reload the app.</span>'
          : '<span style="color:#ff9d96">Supabase answered with error ' +
            r.status + '. If 401, the anon key is wrong. If 404, the ' +
            'Project URL is wrong.</span>';
      }).catch(function () {
        box.innerHTML = '<span style="color:#ff9d96">Could not reach ' +
          norm.url + ' at all. Check the Project URL for typos.</span>';
      });
    };

    if (configured && !sb) {
      bootFail("Could not load the sign-in library.",
               "supabase.js did not load - check it uploaded next to " +
               "index.html");
      return;
    }

    if (!configured) {
      document.getElementById("app").innerHTML = heroHTML() +
        '<div class="section" style="border-color:rgba(224,86,79,.5)">' +
        '<div class="sub" style="color:#ff9d96"><b>Setup needs one ' +
        'fix.</b></div>' +
        norm.problems.map(function (p) {
          return '<div class="sub">&bull; ' + esc(p) + '</div>';
        }).join("") +
        (norm.fixes.length ? '<div class="hint">Also auto-corrected: ' +
          norm.fixes.map(esc).join(" ") + '</div>' : "") +
        '<div class="hint">Edit <b>config.js</b> in your GitHub repo, ' +
        'commit, then fully close and reopen this app.</div>' +
        '</div>';
      return;
    }

    /* The config normalizer still repairs a malformed URL or key - it
       just does it silently now. Surfacing it as a toast on every load
       was noise for people using the app, since there is nothing for
       them to act on. It goes to the console for debugging instead. */
    if (norm.fixes.length && window.console && console.info) {
      console.info("stackNtrack config auto-corrected: " +
                   norm.fixes.join(" "));
    }

    /* One retry with a short delay: on a freshly-launched installed
       app, the very first network request can hit a brief cold-start
       hiccup before connectivity is fully up. A single retry smooths
       that over without masking a genuine missing-file problem. */
    function loadCatalog(attempt) {
      return fetch("benefits.json", { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .catch(function (err) {
          if (attempt >= 1) throw err;
          return new Promise(function (resolve) {
            setTimeout(resolve, 900);
          }).then(function () { return loadCatalog(attempt + 1); });
        });
    }

    BOOT_STAGE = "loading card catalog";
    loadCatalog(0).then(function (cat) {
      if (!cat || !cat.cards) throw new Error("catalog malformed");
      S.catalog = cat;
      CARD_ORDER = Object.keys(cat.cards);
      BOOT_STAGE = "checking your session";

      /* password-recovery deep link */
      if (location.hash.indexOf("type=recovery") >= 0) {
        var np = prompt("Enter a new password (8+ characters):");
        if (np && np.length >= 8) {
          sb.auth.updateUser({ password: np }).then(function () {
            toast("Password updated - log in with it next time");
          });
        }
      }

      /* If the session check stalls or fails, fall through to the login
         screen rather than hanging. A reachable app beats a spinner. */
      return withTimeout(sb.auth.getSession(), 10000, "session check")
        .catch(function () { return { data: { session: null } }; });
    }).then(function (r) {
      if (!S.catalog) return;
      var sess = r && r.data && r.data.session;
      S._proceed = function () {
        if (sess && sess.user) {
          A.onSignedIn({ id: sess.user.id, email: sess.user.email });
        } else {
          S.screen = "auth"; paint();
        }
      };
      BOOT_STAGE = "rendering";
      bootFinished = true;
      if (shouldShowInstallGate()) { S.screen = "install"; paint(); }
      else { S._proceed(); }
      sb.auth.onAuthStateChange(function (ev, session) {
        if (ev === "SIGNED_IN" && session && !S.user) {
          A.onSignedIn({ id: session.user.id, email: session.user.email });
        }
      });
    }).catch(function (err) {
      /* Final safety net - nothing gets to fail silently. */
      if (BOOT_STAGE === "loading card catalog") {
        bootFail("Could not load the card catalog.",
                 "check that benefits.json sits next to index.html");
      } else {
        bootFail("stackNtrack could not finish starting up.",
                 err && err.message);
      }
    });
  }

  /* exports for Node tests */
  return {
    boot: boot, state: S, actions: A,
    normalizeSupabase: normalizeSupabase,
    views: { authView: authView, onboardView: onboardView,
             dashView: dashView, manageView: manageView,
             benefitHTML: benefitHTML, toggleHTML: toggleHTML,
             resetModalHTML: resetModalHTML, pickerHTML: pickerHTML,
             errorView: errorView, installView: installView,
             hideModalHTML: hideModalHTML,
             settingsModalHTML: settingsModalHTML,
             noteModalHTML: noteModalHTML,
             pushModalHTML: pushModalHTML, helpHTML: helpHTML },
    shouldShowInstallGate: shouldShowInstallGate,
    describeDbError: describeDbError,
    _internals: { rebuild: rebuild, readAnnivRows: readAnnivRows,
                  setPaint: function (p) { paint = p; },
                  setToast: function (t) { toast = t; },
                  setCloseModal: function (c) { closeModal = c; },
                  setVal: function (v) { val = v; },
                  setCardOrder: function (o) { CARD_ORDER = o; } }
  };
});
