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

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const CONTACT = process.env.VAPID_CONTACT || "mailto:hello@stackntrack.net";
const APP_URL = process.env.APP_URL || "https://stackntrack.net";
const DRY_RUN = process.env.DRY_RUN === "1";

/* Nudge windows, in days remaining. Monthly credits get a late, urgent
   reminder; bigger benefits get more runway because they need planning. */
const WINDOWS = { Monthly: [3], other: [30, 7] };

function need(name, v) {
  if (!v) { console.error("Missing required env var: " + name); process.exit(1); }
  return v;
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
    throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
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
  need("SUPABASE_URL", SUPABASE_URL);
  need("SUPABASE_SERVICE_KEY", SERVICE_KEY);
  need("VAPID_PUBLIC_KEY", VAPID_PUBLIC);
  need("VAPID_PRIVATE_KEY", VAPID_PRIVATE);
  webpush.setVapidDetails(CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

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
