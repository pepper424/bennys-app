#!/usr/bin/env node
/* stackNtrack expiry reminders.
 *
 * Runs daily on a schedule (GitHub Actions). For every user who turned
 * reminders on, it works out which of THEIR credits are about to expire
 * and sends a single web-push notification.
 *
 * It imports the app's own logic.js, so the reminder math is literally
 * the same code the dashboard runs - there is no second implementation
 * to drift out of sync.
 *
 * Sends at most one notification per user per day, and only when
 * something is genuinely close to expiring.
 */

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const L = require("./logic.js");

/* Everything gets trimmed: pasting secrets on a phone very easily
   picks up a trailing space or newline, and web-push rejects keys that
   are not exactly URL-safe base64. */
const clean = (v) => String(v || "").replace(/\s+/g, "");

/* Accept whatever shape the URL was pasted in and reduce it to the
   bare project origin. The app does the same thing client-side; the
   two most common mistakes are pasting the dashboard address or
   leaving "/rest/v1" on the end, and both produce a PGRST125
   "Invalid path" error that is hard to read. */
function normalizeSupabaseUrl(raw) {
  let v = clean(raw);
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    const dash = u.pathname.match(/\/project\/([a-z0-9]+)/i);
    if (/(^|\.)supabase\.com$/i.test(u.host) && dash) {
      return "https://" + dash[1] + ".supabase.co";   // dashboard -> API
    }
    return u.origin;                                   // drops any path
  } catch (e) {
    return "";
  }
}

const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const SERVICE_KEY = clean(process.env.SUPABASE_SERVICE_KEY);
const VAPID_PUBLIC = clean(process.env.VAPID_PUBLIC_KEY);
const VAPID_PRIVATE = clean(process.env.VAPID_PRIVATE_KEY);
const APP_URL = clean(process.env.APP_URL) || "https://stackntrack.net";
const DRY_RUN = process.env.DRY_RUN === "1";

/* The push spec wants a contactable URL. A bare email address is the
   single most common mistake here, so accept it and fix it up. */
function normalizeContact(raw) {
  const v = clean(raw);
  if (!v) return "mailto:noreply@stackntrack.net";
  if (/^(mailto:|https?:\/\/)/i.test(v)) return v;
  if (v.indexOf("@") > 0) return "mailto:" + v;
  return "mailto:noreply@stackntrack.net";
}
const CONTACT = normalizeContact(process.env.VAPID_CONTACT);

/* Nudge windows, in days remaining. Monthly credits get a late, urgent
   reminder; bigger benefits get more runway because they need planning. */
const WINDOWS = { Monthly: [3], other: [30, 7] };

/* Print a readable configuration report before doing anything, so a
   failed run explains itself in the log instead of just exiting 1. */
function preflight() {
  const rows = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_KEY", SERVICE_KEY],
    ["VAPID_PUBLIC_KEY", VAPID_PUBLIC],
    ["VAPID_PRIVATE_KEY", VAPID_PRIVATE]
  ];
  console.log("Configuration check");
  console.log("-------------------");
  rows.forEach(([name, val]) => {
    console.log("  " + (val ? "found  " : "MISSING") + "  " + name);
  });
  console.log("  found    VAPID_CONTACT -> " + CONTACT);
  console.log("  using    SUPABASE_URL  -> " + (SUPABASE_URL || "(unusable)"));
  if (SUPABASE_URL && clean(process.env.SUPABASE_URL) !== SUPABASE_URL) {
    console.log("           (corrected from what was pasted)");
  }
  console.log("  mode     " + (DRY_RUN ? "DRY RUN (nothing is sent)"
                                       : "LIVE (notifications will send)"));
  console.log("");

  const missing = rows.filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) {
    console.error("Stopping: these repository secrets are missing or " +
      "empty -> " + missing.join(", "));
    console.error("Add them under Settings -> Secrets and variables -> " +
      "Actions. Names are case-sensitive.");
    process.exit(1);
  }

  if (!/^https:\/\/[a-z0-9-]+\.supabase\./i.test(SUPABASE_URL)) {
    console.error("Stopping: SUPABASE_URL should look like " +
      "https://yourproject.supabase.co - got: " + SUPABASE_URL);
    process.exit(1);
  }

  try {
    webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) {
    console.error("Stopping: the VAPID settings were rejected -> " +
      e.message);
    console.error("Public key should be 87 characters, private 43, " +
      "both with no spaces. Yours: public " + VAPID_PUBLIC.length +
      ", private " + VAPID_PRIVATE.length + ".");
    process.exit(1);
  }
  console.log("VAPID keys accepted.");
}

async function sbGet(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Supabase rejected the key (${res.status}). The ` +
        `SUPABASE_SERVICE_KEY secret must be the service_role key, not ` +
        `the anon key.`);
    }
    if (res.status === 404) {
      throw new Error(`Table "${table}" was not found (404). Run the ` +
        `setup SQL in the same Supabase project as SUPABASE_URL.`);
    }
    throw new Error(`Supabase ${table} ${res.status}: ${body}`);
  }
  return res.json();
}

async function sbDelete(table, query) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
}

/* Which of this user's benefits are inside a nudge window today? */
function dueBenefits(catalog, profile, now) {
  const all = L.buildBenefits(catalog, profile, now);
  const out = [];
  for (const b of all) {
    if (!b.available || !b.expires) continue;
    const days = L.daysRemaining(b, now);
    if (days === null || days < 0) continue;
    const windows = b.reset === "Monthly" ? WINDOWS.Monthly : WINDOWS.other;
    if (windows.indexOf(days) >= 0) out.push({ b, days });
  }
  // most urgent first, then largest value
  out.sort((x, y) => x.days - y.days ||
    (L.remainingValue(y.b) - L.remainingValue(x.b)));
  return out;
}

function buildMessage(due) {
  const top = due[0];
  const cur = top.b.currency;
  const amount = L.fmtValue(top.b.value, cur);
  const when = top.days === 0 ? "today"
    : top.days === 1 ? "tomorrow"
    : `in ${top.days} days`;

  const title = due.length > 1
    ? `${due.length} credits expiring soon`
    : `${amount || "A credit"} expires ${when}`;

  let body = amount
    ? `${top.b.card}: ${amount} ${top.b.benefit} expires ${when}.`
    : `${top.b.card}: ${top.b.benefit} expires ${when}.`;
  if (due.length > 1) {
    body += ` Plus ${due.length - 1} more.`;
  }
  return { title, body };
}

async function main() {
  preflight();

  const catalog = JSON.parse(
    fs.readFileSync(path.join(__dirname, "benefits.json"), "utf8"));
  const now = new Date();

  const subs = await sbGet("push_subs", "select=user_id,subscription");
  if (!subs.length) { console.log("No push subscribers yet."); return; }

  let sent = 0, skipped = 0, pruned = 0, failed = 0;

  for (const row of subs) {
    let profileRows;
    try {
      profileRows = await sbGet("dashboards",
        `user_id=eq.${row.user_id}&select=data`);
    } catch (e) {
      console.error("dashboard fetch failed for a user:", e.message);
      failed++; continue;
    }
    const profile = profileRows[0] && profileRows[0].data;
    if (!profile || !profile.cards || !profile.cards.length) {
      skipped++; continue;
    }

    const due = dueBenefits(catalog, profile, now);
    if (!due.length) { skipped++; continue; }

    const { title, body } = buildMessage(due);
    const payload = JSON.stringify({
      title, body, url: APP_URL,
      tag: "stackntrack-expiring"
    });

    if (DRY_RUN) {
      console.log(`[dry-run] ${row.user_id.slice(0, 8)}: ${title} | ${body}`);
      sent++; continue;
    }

    try {
      await webpush.sendNotification(row.subscription, payload);
      sent++;
    } catch (err) {
      // 404/410 mean the subscription is dead - stop mailing a ghost
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sbDelete("push_subs", `user_id=eq.${row.user_id}`);
        pruned++;
      } else {
        console.error("push failed:", err.statusCode || err.message);
        failed++;
      }
    }
  }

  console.log(`subscribers ${subs.length} | sent ${sent} | ` +
    `nothing due ${skipped} | pruned ${pruned} | failed ${failed}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { dueBenefits, buildMessage, WINDOWS };
