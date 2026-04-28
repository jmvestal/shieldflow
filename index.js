// ============================================================
//  ShieldFlow AI — Backend Server (SMS + Email Edition)
//  Stack: Node.js + Express + Twilio + Resend + Claude + Supabase
//  Deploy to: Railway.app
// ============================================================
//
//  npm init -y
//  npm install express twilio @anthropic-ai/sdk @supabase/supabase-js
//              resend node-cron dotenv
//

import express       from "express";
import twilio        from "twilio";
import Anthropic     from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Resend }    from "resend";
import cron          from "node-cron";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CLIENTS ───────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend       = new Resend(process.env.RESEND_API_KEY);

// ── SETTINGS ──────────────────────────────────────────────────
const S = {
  agentName:   process.env.AGENT_NAME   || "Alex Carter",
  agencyName:  process.env.AGENCY_NAME  || "Shield Insurance",
  agentPhone:  process.env.TWILIO_PHONE || "+15125550192",
  fromEmail:   process.env.FROM_EMAIL   || "alex@shieldinsurance.com",
  fromName:    process.env.FROM_NAME    || "Alex Carter",
  officeHours: { days: ["Mon","Tue","Wed","Thu","Fri"], start: "09:00", end: "17:00" },
  afterHoursSms:   "Hey {name}! Thanks for reaching out 😊 Our office is closed right now but I'll personally follow up first thing when we open. Feel free to reply with any questions!",
  afterHoursEmail: "Hi {name},\n\nThank you for reaching out about {product} — I received your message after hours but wanted you to know I'll be in touch first thing tomorrow morning.\n\nIn the meantime, feel free to reply to this email with any questions.\n\n{agent}\n{agency}",
};

// ── HELPERS ───────────────────────────────────────────────────
const DAY = 86400;

function fill(template, lead) {
  return template
    .replace(/{name}/g,    lead.name.split(" ")[0])
    .replace(/{product}/g, lead.product || "insurance")
    .replace(/{agent}/g,   S.agentName.split(" ")[0])
    .replace(/{agency}/g,  S.agencyName)
    .replace(/{phone}/g,   S.agentPhone)
    .replace(/{email_address}/g, S.fromEmail);
}

function isOpen() {
  const now  = new Date();
  const day  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()];
  if (!S.officeHours.days.includes(day)) return false;
  const [sh, sm] = S.officeHours.start.split(":").map(Number);
  const [eh, em] = S.officeHours.end.split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

const WARM_KEYWORDS = ["yes","yeah","sure","ready","now","call","available","free","connect","agent","transfer","let's","sounds good","go ahead","interested","today","tomorrow","how much","what do you need","current policy","renewal","bundl","deductible","coverage","switching","quote","save","cheaper"];

function isWarm(text) {
  return WARM_KEYWORDS.some(kw => text.toLowerCase().includes(kw));
}

// ── SMS CADENCE ───────────────────────────────────────────────
const SMS_CADENCE = [
  { step: 0, delaySeconds: 0,        label: "Immediately",
    message: "Hi {name}! 👋 This is {agent} with {agency}. I just got your request for {product} — I'd love to find you the best rate. Do you have a few minutes today?" },
  { step: 1, delaySeconds: DAY*0+3600*2, label: "2 hours",
    message: "Hey {name}! Still here whenever you're ready 😊 Many of my Texas clients save $400–$800/year on {product}. Takes about 5 min to see what I can do for you. Worth it?" },
  { step: 2, delaySeconds: DAY*1,    label: "Day 1",
    message: "Good morning {name}! Quick question — are you bundling home and auto? Most clients save 15–25% combining both. Happy to run the numbers either way! 🏠🚗" },
  { step: 3, delaySeconds: DAY*3,    label: "Day 3",
    message: "Hi {name}, I know life gets busy! All I need is 5 minutes and your current policy info — I can usually beat what you're paying now. Still interested? Reply YES!" },
  { step: 4, delaySeconds: DAY*5,    label: "Day 5",
    message: "Hi {name}! Rates in your area shifted this week — wanted to make sure you get a quote before they move again. No obligation, quick comparison. Worth a look? 📋" },
  { step: 5, delaySeconds: DAY*7,    label: "Day 7",
    message: "Last message from me for now, {name} 🙏 If you ever want to revisit your {product}, I'm one text away. Hope you're doing great!" },
];

// ── EMAIL CADENCE ─────────────────────────────────────────────
const EMAIL_CADENCE = [
  {
    step: 0, delaySeconds: 1800, label: "30 min", // After first SMS
    subject: "Your {product} quote request — {agency}",
    body: `Hi {name},

I just texted you about your {product} quote — wanted to follow up here too in case email is easier for you.

I'm {agent} with {agency}, an independent agency with access to 20+ carriers. That means I shop the market for you instead of pushing one company's rates.

A few things that'll help me get you the best rate:
• Your current insurer and what you're paying annually
• Your address (for home) or vehicle year/make/model (for auto)
• Any claims in the last 3 years

Just reply here or text me back — whichever is easier for you.

{agent}
{agency} | {phone}
`
  },
  {
    step: 1, delaySeconds: DAY*2, label: "Day 2",
    subject: "Quick question about your coverage, {name}",
    body: `Hi {name},

One question I ask every new client: are you currently bundling your home and auto with the same carrier?

If not, you're likely leaving money on the table. Most of my clients save 15–25% when they combine both policies — plus the added convenience of one renewal date and one agent for everything.

Takes about 10 minutes to run both quotes. Want me to?

{agent}
{agency}
`
  },
  {
    step: 2, delaySeconds: DAY*5, label: "Day 5",
    subject: "3 things most Texans don't know about their P&C coverage",
    body: `Hi {name},

Whether we end up working together or not, I wanted to share a few things that could save you money:

1. Replacement cost vs. actual cash value — Most home policies default to ACV, which means depreciated payouts on claims. Replacement cost coverage is worth the small premium difference.

2. Bundling discount — If your home and auto are with different carriers, you're almost certainly paying too much.

3. Loyalty penalty — Carriers quietly raise rates on long-term customers. If you haven't shopped in 3+ years, you're likely overpaying by 20–40%.

Happy to do a free coverage review anytime — no commitment needed.

{agent}
{agency} | {phone}
`
  },
  {
    step: 3, delaySeconds: DAY*14, label: "Day 14",
    subject: "Still here if you need me, {name}",
    body: `Hi {name},

Just a quick check-in. I know insurance isn't the most exciting thing to think about, so no worries if the timing wasn't right.

If anything has changed — new vehicle, home updates, renewal coming up — I'm happy to take a look. Independent agents like me can often find options your current carrier won't tell you about.

No pressure at all. Just wanted you to know I'm still here.

{agent}
{agency}
`
  },
  {
    step: 4, delaySeconds: DAY*30, label: "Day 30",
    subject: "One last note, {name}",
    body: `Hi {name},

Last email from me — promise! 😊

If you ever decide to shop your {product} coverage, I'd love the chance to help. I work with 20+ carriers and my job is to find the best fit for your situation, not push one company.

Keep my info handy:
{agent} | {agency}
📱 {phone}
📧 {email_address}

Wishing you all the best,
{agent}
`
  },
];

// ── AI REPLY ──────────────────────────────────────────────────
async function getAIReply(lead, incomingText) {
  const { data: msgs } = await supabase
    .from("messages").select("*").eq("lead_id", lead.id)
    .order("created_at", { ascending: true });

  const history = (msgs || [])
    .filter(m => m.channel === "sms")
    .map(m => ({ role: m.direction === "outbound" ? "assistant" : "user", content: m.body }));

  history.push({ role: "user", content: incomingText });

  const system = `You are ${S.agentName.split(" ")[0]}, a friendly independent P&C insurance agent at ${S.agencyName} texting leads via SMS.

Lead: ${lead.name.split(" ")[0]}, interested in ${lead.product || "insurance"}, from ${lead.source || "online"}.

Rules:
- SMS ONLY — keep replies to 1–3 sentences max
- Be warm, human, natural — never robotic
- P&C lines: auto, home, renters, umbrella, commercial
- Key talking points: bundling, 20+ carrier access, renewal timing, coverage gaps
- Goal: get them to agree to a quick call/quote
- When ready: "Perfect! Let me connect you with a specialist — exact quote in minutes. Ready?"
- If not interested: be gracious, wish them well
- Plain text only, no markdown or bullets`;

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system,
    messages: history,
  });
  return resp.content[0].text;
}

// ── SEND SMS ──────────────────────────────────────────────────
async function sendSMS(lead, body) {
  if (!lead.phone) return null;
  try {
    const msg = await twilioClient.messages.create({
      from: S.agentPhone,
      to: lead.phone,
      body,
    });
    await supabase.from("messages").insert({
      lead_id: lead.id, channel: "sms", direction: "outbound",
      body, external_id: msg.sid, created_at: new Date().toISOString(),
    });
    console.log(`📱 SMS → ${lead.name}: "${body.slice(0, 50)}..."`);
    return msg.sid;
  } catch (e) {
    console.error(`❌ SMS error for ${lead.name}:`, e.message);
    return null;
  }
}

// ── SEND EMAIL ────────────────────────────────────────────────
async function sendEmail(lead, subject, body) {
  if (!lead.email) return null;
  try {
    const { data, error } = await resend.emails.send({
      from:    `${S.fromName} <${S.fromEmail}>`,
      to:      lead.email,
      replyTo: S.fromEmail,
      subject: fill(subject, lead),
      text:    fill(body, lead),
    });
    if (error) throw new Error(error.message);
    await supabase.from("messages").insert({
      lead_id: lead.id, channel: "email", direction: "outbound",
      subject: fill(subject, lead),
      body:    fill(body, lead),
      external_id: data.id,
      created_at: new Date().toISOString(),
    });
    console.log(`📧 Email → ${lead.name} (${lead.email}): "${fill(subject, lead)}"`);
    return data.id;
  } catch (e) {
    console.error(`❌ Email error for ${lead.name}:`, e.message);
    return null;
  }
}

// ── FIRE FIRST TOUCH ──────────────────────────────────────────
async function fireFirstTouch(lead) {
  // SMS immediately
  if (lead.phone) {
    await sendSMS(lead, fill(SMS_CADENCE[0].message, lead));
  }
  // Email after 30 minutes (EMAIL_CADENCE[0].delaySeconds = 1800)
  // For first touch, schedule it via setTimeout rather than cron
  if (lead.email) {
    setTimeout(async () => {
      const step = EMAIL_CADENCE[0];
      await sendEmail(lead, step.subject, step.body);
      await supabase.from("leads")
        .update({ email_stage: 1, updated_at: new Date().toISOString() })
        .eq("id", lead.id);
    }, EMAIL_CADENCE[0].delaySeconds * 1000);
  }
  await supabase.from("leads")
    .update({ status: "texting", sms_stage: 0, updated_at: new Date().toISOString() })
    .eq("id", lead.id);
  console.log(`🚀 First touch fired for ${lead.name} (SMS${lead.email ? " + Email queued" : ""})`);
}

// ── ROUTES ────────────────────────────────────────────────────

// Receive leads from any source
app.post("/ingest", async (req, res) => {
  try {
    const b = req.body;
    const name    = b.name || `${b.first_name||""} ${b.last_name||""}`.trim() || b.full_name || "Friend";
    const phone   = b.phone || b.phone_number || b.mobile || null;
    const email   = b.email || b.email_address || null;
    const product = b.product || b.insurance_type || b.line_of_business || "Auto Insurance";
    const source  = b.source || b.vendor || "Unknown";

    if (!phone && !email) {
      return res.status(400).json({ error: "Phone or email required" });
    }

    // Dedupe check
    const { data: existing } = await supabase.from("leads").select("id")
      .or(`phone.eq.${phone},email.eq.${email}`)
      .gte("created_at", new Date(Date.now() - 30*DAY*1000).toISOString())
      .single();
    if (existing) return res.json({ status: "duplicate" });

    const { data: lead, error } = await supabase.from("leads")
      .insert({ name, phone, email, product, source, status: "queued", sms_stage: 0, email_stage: 0, created_at: new Date().toISOString() })
      .select().single();
    if (error) throw error;

    console.log(`✅ Lead ingested: ${name} | SMS:${phone||"none"} | Email:${email||"none"} | ${source}`);
    await fireFirstTouch(lead);
    res.json({ status: "ok", leadId: lead.id });
  } catch (e) {
    console.error("❌ Ingest error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Twilio inbound SMS
app.post("/sms/inbound", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return;

  try {
    const { data: lead } = await supabase.from("leads").select("*").eq("phone", from).single();
    if (!lead) return;

    // Log inbound
    await supabase.from("messages").insert({
      lead_id: lead.id, channel: "sms", direction: "inbound",
      body, created_at: new Date().toISOString(),
    });

    if (lead.status === "transferred") return;
    if (["stop","unsubscribe","quit","cancel"].includes(body.toLowerCase())) {
      await supabase.from("leads").update({ status: "opted_out" }).eq("id", lead.id);
      return;
    }

    let reply;
    if (!isOpen()) {
      reply = fill(S.afterHoursSms, lead);
    } else {
      reply = await getAIReply(lead, body);
      if (isWarm(body) || isWarm(reply)) {
        await supabase.from("leads").update({ status: "warm", updated_at: new Date().toISOString() }).eq("id", lead.id);
        console.log(`🔥 WARM: ${lead.name}`);
      } else {
        await supabase.from("leads").update({ status: "texting" }).eq("id", lead.id);
      }
    }

    await sendSMS(lead, reply);
  } catch (e) {
    console.error("❌ Inbound SMS error:", e.message);
  }
});

// Email reply webhook (set in Resend dashboard)
// When a lead replies to an email, Resend POSTs here
app.post("/email/inbound", async (req, res) => {
  res.json({ ok: true });
  try {
    const { from, text, subject } = req.body;
    const emailAddr = from?.match(/<(.+)>/)?.[1] || from;

    const { data: lead } = await supabase.from("leads").select("*").eq("email", emailAddr).single();
    if (!lead) {
      // Forward unknown email to agent's inbox
      await resend.emails.send({
        from: `ShieldFlow <${S.fromEmail}>`,
        to: S.fromEmail,
        subject: `Unknown reply: ${subject}`,
        text: `From: ${from}\n\n${text}`,
      });
      return;
    }

    // Log it
    await supabase.from("messages").insert({
      lead_id: lead.id, channel: "email", direction: "inbound",
      subject, body: text, created_at: new Date().toISOString(),
    });

    // Flag as warm if keywords present
    if (isWarm(text || "")) {
      await supabase.from("leads").update({ status: "warm" }).eq("id", lead.id);
      console.log(`🔥 WARM via email: ${lead.name}`);
    }

    // Forward to agent so they can reply personally
    await resend.emails.send({
      from: `ShieldFlow Alerts <${S.fromEmail}>`,
      to: S.fromEmail,
      replyTo: emailAddr,
      subject: `Lead reply: ${lead.name} — ${subject}`,
      text: `${lead.name} (${lead.phone || "no phone"}) replied to your email:\n\n"${text}"\n\n---\nReply directly to this email to respond to the lead.`,
    });

    console.log(`📧 Email reply from ${lead.name} forwarded to agent`);
  } catch (e) {
    console.error("❌ Email inbound error:", e.message);
  }
});

// Warm transfer
app.post("/transfer/:id", async (req, res) => {
  try {
    const { data: lead } = await supabase.from("leads").select("*").eq("id", req.params.id).single();
    if (!lead) return res.status(404).json({ error: "Not found" });

    const smsMsg = `Hi ${lead.name.split(" ")[0]}! My colleague is calling you right now to get your quote — please pick up! 📞`;
    if (lead.phone) await sendSMS(lead, smsMsg);

    await supabase.from("leads").update({ status: "transferred", updated_at: new Date().toISOString() }).eq("id", lead.id);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/leads", async (req, res) => {
  const { data } = await supabase.from("leads").select("*, messages(*)").order("created_at", { ascending: false });
  res.json(data || []);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", officeOpen: isOpen(), smsCadenceSteps: SMS_CADENCE.length, emailCadenceSteps: EMAIL_CADENCE.length });
});

app.get("/cadence", (req, res) => {
  res.json({
    sms:   SMS_CADENCE.map(s   => ({ step: s.step,   label: s.label,   day: Math.round(s.delaySeconds/DAY), preview: s.message.slice(0,80) })),
    email: EMAIL_CADENCE.map(e => ({ step: e.step,   label: e.label,   day: Math.round(e.delaySeconds/DAY), subject: e.subject })),
  });
});

// ── CADENCE SCHEDULER ─────────────────────────────────────────
// Runs every 10 minutes — checks all active leads for due messages
cron.schedule("*/10 * * * *", async () => {
  try {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 20) return; // Quiet hours

    const { data: leads } = await supabase.from("leads")
      .select("*")
      .in("status", ["queued","texting"])
      .not("status", "eq", "opted_out");

    if (!leads?.length) return;
    const now = Date.now();

    for (const lead of leads) {
      const created = new Date(lead.created_at).getTime();

      // SMS cadence
      const nextSmsStep = lead.sms_stage + 1;
      if (nextSmsStep < SMS_CADENCE.length) {
        const step = SMS_CADENCE[nextSmsStep];
        if (now >= created + step.delaySeconds * 1000) {
          if (lead.phone) await sendSMS(lead, fill(step.message, lead));
          await supabase.from("leads").update({
            sms_stage: nextSmsStep, updated_at: new Date().toISOString()
          }).eq("id", lead.id);
          console.log(`📤 SMS cadence step ${nextSmsStep} → ${lead.name}`);
        }
      }

      // Email cadence (starts at step 1 — step 0 is fired at ingest)
      const nextEmailStep = lead.email_stage;
      if (nextEmailStep < EMAIL_CADENCE.length && lead.email) {
        const step = EMAIL_CADENCE[nextEmailStep];
        if (now >= created + step.delaySeconds * 1000) {
          await sendEmail(lead, step.subject, step.body);
          await supabase.from("leads").update({
            email_stage: nextEmailStep + 1, updated_at: new Date().toISOString()
          }).eq("id", lead.id);
          console.log(`📤 Email cadence step ${nextEmailStep} → ${lead.name}`);
        }
      }
    }

    // Archive stalled leads after full cadence + 7 days
    const { data: done } = await supabase.from("leads").select("*")
      .eq("sms_stage", SMS_CADENCE.length - 1).eq("status", "texting");
    for (const lead of done || []) {
      const last = new Date(lead.updated_at).getTime();
      if (now - last > DAY * 7 * 1000) {
        await supabase.from("leads").update({ status: "archived" }).eq("id", lead.id);
        console.log(`📦 Archived: ${lead.name}`);
      }
    }
  } catch (e) {
    console.error("❌ Scheduler error:", e.message);
  }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌────────────────────────────────────────────────────┐
  │   🛡  ShieldFlow AI — SMS + Email Edition          │
  │   Port: ${PORT}                                        │
  │   Office open: ${isOpen() ? "YES ✅" : "NO  🌙"}                       │
  │                                                    │
  │   SMS cadence:   ${SMS_CADENCE.length} steps over 7 days              │
  │   Email cadence: ${EMAIL_CADENCE.length} emails over 30 days           │
  │                                                    │
  │   POST /ingest          ← all lead sources        │
  │   POST /sms/inbound     ← Twilio SMS replies      │
  │   POST /email/inbound   ← Resend email replies    │
  │   POST /transfer/:id    ← warm transfer           │
  │   GET  /leads           ← dashboard data          │
  │   GET  /health          ← status check            │
  └────────────────────────────────────────────────────┘
  `);
});
