// ============================================================
//  ShieldFlow AI — Growth Campaigns Module
//  Three automated campaigns that work your existing book:
//
//  1. CROSS-SELL    — Find bundling + coverage gap opportunities
//  2. QUOTE FOLLOW-UP — Chase every quote you send that doesn't close
//  3. WIN-BACK      — Re-engage clients who left in last 1-2 years
//
//  Add these to your existing shieldflow-server-email-edition.js
//  OR run as a standalone module on its own Railway service
//
//  New Supabase tables — run this SQL first:
//
//  CREATE TABLE cross_sell (
//    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//    client_name   text NOT NULL,
//    client_phone  text,
//    client_email  text,
//    current_lines text,      -- 'auto' | 'home' | 'auto,home'
//    target_line   text,      -- 'home' | 'auto' | 'umbrella' | 'renters'
//    status        text DEFAULT 'pending',
//    stage         int  DEFAULT 0,
//    created_at    timestamptz DEFAULT now(),
//    updated_at    timestamptz DEFAULT now()
//  );
//
//  CREATE TABLE quote_followup (
//    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//    client_name   text NOT NULL,
//    client_phone  text,
//    client_email  text,
//    product       text,
//    quoted_amount text,       -- e.g. "$142/mo"
//    quote_date    timestamptz DEFAULT now(),
//    status        text DEFAULT 'pending',
//    stage         int  DEFAULT 0,
//    created_at    timestamptz DEFAULT now(),
//    updated_at    timestamptz DEFAULT now()
//  );
//
//  CREATE TABLE win_back (
//    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//    client_name   text NOT NULL,
//    client_phone  text,
//    client_email  text,
//    product       text,       -- what they had with you
//    left_date     timestamptz,
//    left_reason   text,       -- optional: 'price' | 'service' | 'unknown'
//    status        text DEFAULT 'pending',
//    stage         int  DEFAULT 0,
//    created_at    timestamptz DEFAULT now(),
//    updated_at    timestamptz DEFAULT now()
//  );
//
// ============================================================

import express    from "express";
import twilio     from "twilio";
import Anthropic  from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import cron       from "node-cron";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend       = new Resend(process.env.RESEND_API_KEY);

const S = {
  agentName:  process.env.AGENT_NAME   || "Alex Carter",
  agencyName: process.env.AGENCY_NAME  || "Shield Insurance",
  agentPhone: process.env.TWILIO_PHONE || "+15125550192",
  fromEmail:  process.env.FROM_EMAIL   || "alex@shieldinsurance.com",
  fromName:   process.env.FROM_NAME    || "Alex Carter",
};

const DAY = 86400;

// ── HELPERS ───────────────────────────────────────────────────
function fill(t, r) {
  if (!t) return "";
  return t
    .replace(/{name}/g,    (r.client_name || r.name || "").split(" ")[0] || "there")
    .replace(/{product}/g, r.product || r.target_line || "insurance")
    .replace(/{quoted}/g,  r.quoted_amount || "your rate")
    .replace(/{lines}/g,   r.current_lines || "your policy")
    .replace(/{agent}/g,   S.agentName.split(" ")[0])
    .replace(/{agency}/g,  S.agencyName)
    .replace(/{phone}/g,   S.agentPhone);
}

async function sms(to, body) {
  if (!to) return;
  try {
    await twilioClient.messages.create({ from: S.agentPhone, to, body });
    console.log(`📱 SMS → ${to}: "${body.slice(0, 55)}..."`);
  } catch (e) { console.error("❌ SMS:", e.message); }
}

async function email(to, subject, body) {
  if (!to) return;
  try {
    await resend.emails.send({
      from: `${S.fromName} <${S.fromEmail}>`,
      to, replyTo: S.fromEmail, subject, text: body,
    });
    console.log(`📧 Email → ${to}: "${subject}"`);
  } catch (e) { console.error("❌ Email:", e.message); }
}

async function aiReply(name, product, history, inbound, context) {
  const msgs = history.map(m => ({ role: m.from_ai ? "assistant" : "user", content: m.body }));
  msgs.push({ role: "user", content: inbound });

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 250,
    system: `You are ${S.agentName.split(" ")[0]}, a friendly P&C insurance agent at ${S.agencyName} texting ${name} about ${product}. Context: ${context}. Keep replies to 1-3 sentences. SMS only — no markdown. Be warm and natural.`,
    messages: msgs,
  });
  return resp.content[0].text;
}

// ════════════════════════════════════════════════════════════
//  CAMPAIGN 1 — CROSS-SELL
//  Target your existing book for bundling and coverage gaps
//  Cadences: auto→home, home→auto, bundle→umbrella, any→renters
// ════════════════════════════════════════════════════════════

const CROSSSELL = {

  auto_home: [
    { step: 0, wait: 0,       ch: "sms",
      msg: "Hi {name}! {agent} from {agency} here 😊 Quick question — are you insuring your home with us as well? There may be a bundling discount I can get you. Worth a quick look?" },
    { step: 1, wait: DAY*3,   ch: "sms",
      msg: "Hey {name}! Following up on home coverage. Most of my auto clients save $200–$400/year bundling both. Takes 10 minutes to quote. Interested?" },
    { step: 2, wait: DAY*3,   ch: "email",
      subj: "A quick way to save on your insurance, {name}",
      body: `Hi {name},

I wanted to reach out personally — I think I can save you money.

You're currently with us on auto, but if you're insuring your home elsewhere you're likely missing out on a bundling discount worth $200–$400 per year.

As your independent agent I have access to 20+ carriers and can shop both policies together for the best combined rate. Takes about 10 minutes.

Want me to run the numbers?

{agent}
{agency} | {phone}` },
    { step: 3, wait: DAY*7,   ch: "sms",
      msg: "Last nudge on this, {name} — no pressure at all! If you ever want a home quote, one text away 😊 Hope everything's going great!" },
  ],

  home_auto: [
    { step: 0, wait: 0,       ch: "sms",
      msg: "Hi {name}! {agent} from {agency} here 👋 Quick question — are you insuring your vehicles with us as well? There may be a bundling discount waiting for you. Worth a quick look?" },
    { step: 1, wait: DAY*3,   ch: "sms",
      msg: "Hey {name}! Following up on auto coverage. If you're insuring elsewhere I can usually beat it — and bundling with home saves most clients $300–$500/year. Interested in a quick quote?" },
    { step: 2, wait: DAY*3,   ch: "email",
      subj: "Are you leaving money on the table, {name}?",
      body: `Hi {name},

A quick thought — if your auto insurance is with a different carrier than your home, you're almost certainly paying more than you need to.

Bundling both lines typically saves my clients $300–$500 per year plus the convenience of one renewal date and one agent.

I can run both quotes in about 10 minutes. Want me to take a look?

{agent}
{agency} | {phone}` },
    { step: 3, wait: DAY*7,   ch: "sms",
      msg: "No worries if timing isn't right, {name}! Whenever you want to explore bundling I'm here. Hope you're doing great 😊" },
  ],

  bundle_umbrella: [
    { step: 0, wait: 0,       ch: "sms",
      msg: "Hi {name}! {agent} here. Quick question — do you have a personal umbrella policy? With home and auto covered you're already most of the way there. Usually only $15–$25/month for $1M+ in extra liability. Interested?" },
    { step: 1, wait: DAY*4,   ch: "email",
      subj: "The $15/month policy most homeowners overlook",
      body: `Hi {name},

Since you have both home and auto with us I wanted to mention something most clients don't think about until it's too late.

A personal umbrella policy adds $1,000,000 in liability coverage above your existing policies — for about $150–$250 per year.

Real situations where it matters:
• Your dog bites a neighbor's child
• Someone slips on your property and sues
• A serious at-fault accident that exceeds your auto limits

At your coverage level an umbrella is one of the smartest $15/month decisions you can make.

Want me to run a quick quote?

{agent}
{agency} | {phone}` },
    { step: 2, wait: DAY*7,   ch: "sms",
      msg: "Last nudge on umbrella coverage, {name} — I know it's one of those 'I'll get to it' things! Usually same-day bind. Just reply anytime 😊" },
  ],

  auto_renters: [
    { step: 0, wait: 0,       ch: "sms",
      msg: "Hi {name}! {agent} from {agency} here. Do you rent or own your home? If you're renting, renters insurance is usually $12–$18/month and bundles with your auto for a discount. Worth knowing!" },
    { step: 1, wait: DAY*3,   ch: "email",
      subj: "Something most renters overlook, {name}",
      body: `Hi {name},

Most renters assume their landlord's insurance covers their belongings. It doesn't — the landlord's policy only covers the building.

Renters insurance covers:
• Your personal belongings (laptop, furniture, clothes, etc.)
• Liability if someone gets hurt in your apartment
• Temporary housing if your place becomes uninhabitable

The cost? Usually $12–$18/month. Bundled with your auto it often pays for itself through the discount.

Want me to run a quick quote?

{agent}` },
    { step: 2, wait: DAY*5,   ch: "sms",
      msg: "Checking in on renters coverage, {name}! No pressure — just want to make sure you're protected. It's the one policy people wish they had before they needed it 😊" },
  ],
};

function getCadence(current, target) {
  if (current === "auto"       && target === "home")     return "auto_home";
  if (current === "home"       && target === "auto")     return "home_auto";
  if (current === "auto,home"  && target === "umbrella") return "bundle_umbrella";
  if (current === "auto"       && target === "renters")  return "auto_renters";
  return null;
}

// ════════════════════════════════════════════════════════════
//  CAMPAIGN 2 — QUOTE FOLLOW-UP
//  Every quote you send that doesn't close gets auto-followed up
//  Fires: 2 hours, 1 day, 3 days, 7 days, 14 days after quote
// ════════════════════════════════════════════════════════════

const QUOTE_FOLLOWUP = [
  { step: 0, wait: 0,        ch: "sms",
    msg: "Hi {name}! {agent} here — just sent over your {product} quote. Let me know if you have any questions! Happy to walk you through it real quick." },
  { step: 1, wait: 3600*2,   ch: "sms",
    msg: "Hey {name}! Just checking in on the quote I sent. Did you get a chance to look it over? Happy to answer any questions or adjust coverage if needed 😊" },
  { step: 2, wait: DAY*1,    ch: "email",
    subj: "Your {product} quote — any questions, {name}?",
    body: `Hi {name},

Just following up on the {product} quote I sent yesterday at {quoted}.

A few things worth knowing:
• This rate is based on your specific situation — it's not a ballpark
• Coverage can be adjusted up or down based on your budget
• Most clients can be bound same-day once they decide

Is there anything you'd like me to explain or adjust? Even if you're comparing with another carrier I'm happy to make sure you're comparing apples to apples.

{agent}
{agency} | {phone}` },
  { step: 3, wait: DAY*3,    ch: "sms",
    msg: "Hi {name}! Still thinking over the {product} quote? Totally get it — no rush. If price is a factor I may have other options worth looking at. Just reply and I'll pull some alternatives!" },
  { step: 4, wait: DAY*7,    ch: "sms",
    msg: "Hey {name}! Week check-in on your {product} quote. A lot of my clients ask about payment plans — most carriers offer monthly with no interest. Would that make it easier? 😊" },
  { step: 5, wait: DAY*14,   ch: "email",
    subj: "Last follow-up on your quote, {name}",
    body: `Hi {name},

Last follow-up from me on your {product} quote — I promise!

I just want to make sure the timing or price isn't holding you back from coverage you need. A few things I can do if the quote wasn't quite right:

• Shop a different carrier for a lower rate
• Adjust deductibles to bring the premium down
• Look at coverage options that fit your exact budget

If you've already found something that works, no worries at all — just let me know so I can close your file.

Either way, thanks for giving me the chance to quote you.

{agent}
{agency}` },
];

// ════════════════════════════════════════════════════════════
//  CAMPAIGN 3 — WIN-BACK
//  Re-engage clients who left in the last 1-2 years
//  Tone: friendly, no hard sell, rate-focused, easy door back in
// ════════════════════════════════════════════════════════════

const WIN_BACK = [
  { step: 0, wait: 0,        ch: "sms",
    msg: "Hi {name}! {agent} from {agency} here — it's been a while! I wanted to reach out because rates have actually shifted in your favor recently. Would love to see if I can beat what you're paying now. Interested?" },
  { step: 1, wait: DAY*3,    ch: "sms",
    msg: "Hey {name}! Following up on my note. I know switching feels like a hassle but I can usually have a new quote in your inbox in under 10 minutes. No commitment to look! 😊" },
  { step: 2, wait: DAY*3,    ch: "email",
    subj: "Checking in, {name} — rates have changed",
    body: `Hi {name},

It's {agent} from {agency} — hope you've been doing well!

I wanted to personally reach out because insurance rates in Texas have been shifting quite a bit lately, and I think there's a real chance I can save you money on your {product} compared to what you're currently paying.

As an independent agent I have access to 20+ carriers, so I can shop the whole market for you in one call instead of you having to do it yourself.

No pressure and no obligation — just want to make sure you're getting the best rate available. Want me to run a quick comparison?

{agent}
{agency} | {phone}` },
  { step: 3, wait: DAY*7,    ch: "sms",
    msg: "Hi {name}! One more check-in — did my email come through? Just want to make sure you at least have the option to compare rates. Happy to make it super quick if you're open to it!" },
  { step: 4, wait: DAY*14,   ch: "sms",
    msg: "Hey {name}! {agent} here, last message from me 🙏 If you ever want to revisit your {product} coverage or just want a second opinion on your rate, I'm always just a text away. Hope all is well!" },
  { step: 5, wait: DAY*30,   ch: "email",
    subj: "Still here if you need me, {name}",
    body: `Hi {name},

Just a final note to say I'm still here whenever you need me.

Whether it's shopping your current coverage, adding a new policy, or just getting a second opinion — I'd love the chance to earn your business back.

{agent} | {agency}
📱 {phone}

Wishing you all the best,
{agent}` },
];

// ── SHARED SEND FUNCTION ──────────────────────────────────────
async function fireStep(record, step, table) {
  const ch = step.ch;
  if (ch === "sms"   && record.client_phone) await sms(record.client_phone, fill(step.msg, record));
  if (ch === "email" && record.client_email) await email(record.client_email, fill(step.subj, record), fill(step.body, record));

  await supabase.from(table)
    .update({ stage: step.step + 1, status: "active", updated_at: new Date().toISOString() })
    .eq("id", record.id);

  console.log(`📤 [${table}] Step ${step.step} → ${record.client_name}`);
}

async function runCadence(table, cadence, statusFilter = ["pending","active"]) {
  const { data: records } = await supabase.from(table)
    .select("*").in("status", statusFilter);

  if (!records?.length) return;
  const now = Date.now();

  for (const rec of records) {
    // Pending → fire step 0
    if (rec.status === "pending") {
      await fireStep(rec, cadence[0], table);
      continue;
    }

    // Active → check if next step is due
    const nextStep = cadence[rec.stage];
    if (!nextStep) {
      await supabase.from(table).update({ status: "completed" }).eq("id", rec.id);
      continue;
    }

    const created = new Date(rec.created_at).getTime();
    if (now >= created + nextStep.wait * 1000) {
      await fireStep(rec, nextStep, table);
    }
  }
}

// ── ROUTES ────────────────────────────────────────────────────

// ── CROSS-SELL ────────────────────────────────────────────────

// Add single client to cross-sell
// POST /crosssell/add
// { client_name, client_phone, client_email, current_lines, target_line }
app.post("/crosssell/add", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, current_lines, target_line } = req.body;
    const cadenceKey = getCadence(current_lines, target_line);
    if (!cadenceKey) return res.status(400).json({ error: `No cadence for ${current_lines} → ${target_line}` });

    const { data, error } = await supabase.from("cross_sell")
      .insert({ client_name, client_phone, client_email, current_lines, target_line, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    // Fire step 0 immediately
    const cadence = CROSSSELL[cadenceKey];
    await fireStep(data, cadence[0], "cross_sell");

    res.json({ status: "ok", id: data.id, cadence: cadenceKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk upload entire book
// POST /crosssell/bulk
// { clients: [{ client_name, client_phone, client_email, current_lines, target_line }] }
app.post("/crosssell/bulk", async (req, res) => {
  try {
    const { clients } = req.body;
    let queued = 0, skipped = 0;
    for (const c of clients || []) {
      const key = getCadence(c.current_lines, c.target_line);
      if (!key) { skipped++; continue; }
      await supabase.from("cross_sell").insert({ ...c, status: "pending", stage: 0 });
      queued++;
    }
    // Stagger: scheduler picks up 5/run so it doesn't blast everyone at once
    res.json({ status: "ok", queued, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── QUOTE FOLLOW-UP ───────────────────────────────────────────

// Trigger when you send a quote — add to follow-up queue
// POST /quote/sent
// { client_name, client_phone, client_email, product, quoted_amount }
//
// TIP: Set this up as a Zapier trigger on your quoting software
// so it fires automatically every time you send a quote
//
app.post("/quote/sent", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, product, quoted_amount } = req.body;

    const { data, error } = await supabase.from("quote_followup")
      .insert({ client_name, client_phone, client_email, product, quoted_amount, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    // Step 0 fires immediately (confirmation text)
    await fireStep(data, QUOTE_FOLLOWUP[0], "quote_followup");

    console.log(`📋 Quote follow-up started: ${client_name} | ${product} | ${quoted_amount}`);
    res.json({ status: "ok", id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark quote as closed/won — stops the follow-up sequence
// POST /quote/closed/:id
app.post("/quote/closed/:id", async (req, res) => {
  await supabase.from("quote_followup").update({ status: "won" }).eq("id", req.params.id);
  console.log(`✅ Quote closed/won: ${req.params.id}`);
  res.json({ status: "ok" });
});

// ── WIN-BACK ──────────────────────────────────────────────────

// Add a lapsed client to win-back campaign
// POST /winback/add
// { client_name, client_phone, client_email, product, left_date?, left_reason? }
app.post("/winback/add", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, product, left_date, left_reason } = req.body;

    const { data, error } = await supabase.from("win_back")
      .insert({ client_name, client_phone, client_email, product, left_date, left_reason, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    await fireStep(data, WIN_BACK[0], "win_back");

    console.log(`🔄 Win-back started: ${client_name} | ${product}`);
    res.json({ status: "ok", id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk upload lapsed client list
// POST /winback/bulk
// { clients: [{ client_name, client_phone, client_email, product, left_date }] }
app.post("/winback/bulk", async (req, res) => {
  try {
    const { clients } = req.body;
    let queued = 0;
    for (const c of clients || []) {
      await supabase.from("win_back").insert({ ...c, status: "pending", stage: 0 });
      queued++;
    }
    res.json({ status: "ok", queued });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark win-back as converted
// POST /winback/won/:id
app.post("/winback/won/:id", async (req, res) => {
  await supabase.from("win_back").update({ status: "converted" }).eq("id", req.params.id);
  res.json({ status: "ok" });
});

// ── STATS ─────────────────────────────────────────────────────
app.get("/campaigns/stats", async (req, res) => {
  const [cs, qf, wb] = await Promise.all([
    supabase.from("cross_sell").select("status"),
    supabase.from("quote_followup").select("status"),
    supabase.from("win_back").select("status"),
  ]);

  const count = (arr, s) => (arr?.data || []).filter(r => r.status === s).length;

  res.json({
    cross_sell: {
      active:    count(cs, "active"),
      completed: count(cs, "completed"),
    },
    quote_followup: {
      active:    count(qf, "active"),
      won:       count(qf, "won"),
      completed: count(qf, "completed"),
    },
    win_back: {
      active:    count(wb, "active"),
      converted: count(wb, "converted"),
      completed: count(wb, "completed"),
    },
  });
});

// Inbound SMS reply handler for all campaigns
// Add this to your existing /sms/inbound route
app.post("/campaigns/sms/reply", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return;

  // Find which campaign this number belongs to
  const [cs, qf, wb] = await Promise.all([
    supabase.from("cross_sell").select("*").eq("client_phone", from).eq("status", "active").single(),
    supabase.from("quote_followup").select("*").eq("client_phone", from).eq("status", "active").single(),
    supabase.from("win_back").select("*").eq("client_phone", from).eq("status", "active").single(),
  ]);

  const record = cs.data || qf.data || wb.data;
  if (!record) return;

  const table = cs.data ? "cross_sell" : qf.data ? "quote_followup" : "win_back";
  const context = cs.data
    ? `cross-sell campaign, pitching ${record.target_line} coverage to someone who has ${record.current_lines}`
    : qf.data
    ? `quote follow-up, they were quoted ${record.quoted_amount} for ${record.product}`
    : `win-back campaign, they were previously a client for ${record.product}`;

  const reply = await aiReply(record.client_name, record.product || record.target_line, [], body, context);
  await sms(from, reply);

  // Mark as responded
  await supabase.from(table).update({ status: "responded", updated_at: new Date().toISOString() }).eq("id", record.id);
  console.log(`💬 [${table}] ${record.client_name} replied: "${body}"`);
});

// ── SCHEDULER ─────────────────────────────────────────────────
// Runs every 15 minutes during business hours
cron.schedule("*/15 9-17 * * 1-5", async () => {
  console.log("⏰ Campaign scheduler tick...");
  try {
    // Cross-sell: process 5 pending per run to stagger sends
    const { data: pending } = await supabase.from("cross_sell")
      .select("*").eq("status", "pending").limit(5);
    for (const rec of pending || []) {
      const key = getCadence(rec.current_lines, rec.target_line);
      if (key) await fireStep(rec, CROSSSELL[key][0], "cross_sell");
    }

    // Advance all active campaigns
    const { data: csActive } = await supabase.from("cross_sell").select("*").eq("status","active");
    for (const rec of csActive || []) {
      const key = getCadence(rec.current_lines, rec.target_line);
      if (!key) continue;
      const cadence  = CROSSSELL[key];
      const nextStep = cadence[rec.stage];
      if (!nextStep) { await supabase.from("cross_sell").update({ status:"completed" }).eq("id",rec.id); continue; }
      if (Date.now() >= new Date(rec.created_at).getTime() + nextStep.wait*1000) {
        await fireStep(rec, nextStep, "cross_sell");
      }
    }

    // Quote follow-ups
    const { data: qfActive } = await supabase.from("quote_followup").select("*").in("status",["active"]);
    for (const rec of qfActive || []) {
      const nextStep = QUOTE_FOLLOWUP[rec.stage];
      if (!nextStep) { await supabase.from("quote_followup").update({ status:"completed" }).eq("id",rec.id); continue; }
      if (Date.now() >= new Date(rec.created_at).getTime() + nextStep.wait*1000) {
        await fireStep(rec, nextStep, "quote_followup");
      }
    }

    // Win-backs: process 5 pending + all active
    const { data: wbPending } = await supabase.from("win_back").select("*").eq("status","pending").limit(5);
    for (const rec of wbPending || []) await fireStep(rec, WIN_BACK[0], "win_back");

    const { data: wbActive } = await supabase.from("win_back").select("*").eq("status","active");
    for (const rec of wbActive || []) {
      const nextStep = WIN_BACK[rec.stage];
      if (!nextStep) { await supabase.from("win_back").update({ status:"completed" }).eq("id",rec.id); continue; }
      if (Date.now() >= new Date(rec.created_at).getTime() + nextStep.wait*1000) {
        await fireStep(rec, nextStep, "win_back");
      }
    }
  } catch (e) { console.error("❌ Scheduler error:", e.message); }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`
  ┌────────────────────────────────────────────────────────┐
  │   🛡  ShieldFlow — Growth Campaigns                    │
  │   Port: ${PORT}                                            │
  │                                                        │
  │   CROSS-SELL                                           │
  │   POST /crosssell/add       ← single client           │
  │   POST /crosssell/bulk      ← upload entire book      │
  │                                                        │
  │   QUOTE FOLLOW-UP                                      │
  │   POST /quote/sent          ← trigger on quote send   │
  │   POST /quote/closed/:id    ← mark as won             │
  │                                                        │
  │   WIN-BACK                                             │
  │   POST /winback/add         ← single lapsed client    │
  │   POST /winback/bulk        ← upload lapsed list      │
  │   POST /winback/won/:id     ← mark as reconverted     │
  │                                                        │
  │   GET  /campaigns/stats     ← dashboard overview      │
  └────────────────────────────────────────────────────────┘
  `);
});
