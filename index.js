// ============================================================
//  ShieldFlow AI — SMS Only Server
//  Stack: Node.js + Express + Twilio + Claude + Supabase
//  Deploy to: Railway.app
// ============================================================
 
import express    from "express";
import twilio     from "twilio";
import Anthropic  from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import cron       from "node-cron";
 
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// ── ENV VAR CHECK ─────────────────────────────────────────────
const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY"
];
 
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
}
console.log("✅ All environment variables present");
 
// ── CLIENTS ───────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
 
// ── SETTINGS ──────────────────────────────────────────────────
const S = {
  agentName:  process.env.AGENT_NAME  || "Alex Vestal",
  agencyName: process.env.AGENCY_NAME || "Vestal Agency",
  agentPhone: process.env.TWILIO_PHONE,
  officeHours: {
    days:  ["Mon","Tue","Wed","Thu","Fri"],
    start: "09:00",
    end:   "17:00",
  },
  afterHoursMsg: "Hey {name}! Thanks for reaching out 😊 Our office is currently closed but I'll personally follow up with you first thing when we open. Feel free to reply with any questions!",
};
 
// ── CADENCE ───────────────────────────────────────────────────
const DAY = 86400;
 
const CADENCE = [
  { step: 0, delaySeconds: 0,       label: "Immediately",
    message: "Hi {name}! 👋 This is {agent} with {agency}. You recently inquired about {product} — I'd love to help you find the best rate. Got a quick moment?" },
  { step: 1, delaySeconds: 3600*2,  label: "2 Hours",
    message: "Hey {name}! Still here whenever you're ready 😊 Many of my clients in Texas are saving $400–$800/year on their {product}. Worth a 5-min chat?" },
  { step: 2, delaySeconds: DAY*1,   label: "Day 1",
    message: "Good morning {name}! Quick question — are you bundling home and auto? Most clients save 15–25% combining both. Happy to run the numbers! 🏠🚗" },
  { step: 3, delaySeconds: DAY*3,   label: "Day 3",
    message: "Hi {name}, I know life gets busy! All I need is 5 minutes and your current policy info — I can usually beat what you're paying. Still interested? Reply YES!" },
  { step: 4, delaySeconds: DAY*5,   label: "Day 5",
    message: "Hi {name}! Rates in your area shifted this week — wanted to make sure you get a quote before they move again. No obligation, quick comparison. Worth a look? 📋" },
  { step: 5, delaySeconds: DAY*7,   label: "Day 7",
    message: "Last message from me for now, {name} 🙏 If you ever want to revisit your {product}, I'm one text away. Hope you're doing great!" },
];
 
const WARM_KEYWORDS = [
  "yes","yeah","sure","ready","now","call","available","free",
  "connect","agent","interested","today","how much","quote","save",
  "bundle","renewal","coverage","switching","cheaper"
];
 
// ── HELPERS ───────────────────────────────────────────────────
function fill(template, lead) {
  return template
    .replace(/{name}/g,    (lead.name || "").split(" ")[0] || "there")
    .replace(/{product}/g, lead.product || "insurance")
    .replace(/{agent}/g,   S.agentName.split(" ")[0])
    .replace(/{agency}/g,  S.agencyName);
}
 
function isOfficeOpen() {
  const now  = new Date();
  const day  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()];
  if (!S.officeHours.days.includes(day)) return false;
  const [sh, sm] = S.officeHours.start.split(":").map(Number);
  const [eh, em] = S.officeHours.end.split(":").map(Number);
  const mins     = now.getHours() * 60 + now.getMinutes();
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}
 
function isWarm(text) {
  const lower = text.toLowerCase();
  return WARM_KEYWORDS.some(kw => lower.includes(kw));
}
 
// ── SMS SENDER ────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!to) return null;
  try {
    const msg = await twilioClient.messages.create({
      from: S.agentPhone,
      to,
      body,
    });
    console.log(`📱 SMS → ${to}: "${body.slice(0, 60)}..."`);
    return msg.sid;
  } catch (e) {
    console.error(`❌ SMS error: ${e.message}`);
    return null;
  }
}
 
// ── AI REPLY ──────────────────────────────────────────────────
async function getAIReply(lead, incomingMessage) {
  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: true });
 
  const history = (messages || []).map(m => ({
    role:    m.direction === "outbound" ? "assistant" : "user",
    content: m.body,
  }));
  history.push({ role: "user", content: incomingMessage });
 
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `You are ${S.agentName.split(" ")[0]}, a friendly Farmers insurance agent at ${S.agencyName} in Lubbock Texas texting leads via SMS.
 
Lead: ${(lead.name || "").split(" ")[0]}, interested in ${lead.product || "insurance"}, from ${lead.source || "online"}.
 
Rules:
- SMS only — 1 to 3 sentences MAX
- Be warm, human, and natural. Never robotic.
- You sell auto, home, renters, umbrella, life, and commercial insurance through Farmers
- Key talking points: bundling savings, renewal timing, coverage gaps
- Goal: get them to agree to a quick call or quote
- When ready: "Great! Let me get you a quote — can I call you now or is there a better time?"
- If not interested: be gracious, wish them well
- Plain text only. No markdown or bullets.`,
    messages: history,
  });
 
  return response.content[0].text;
}
 
// ── DB HELPERS ────────────────────────────────────────────────
async function logMessage(leadId, direction, body, sid = null) {
  await supabase.from("messages").insert({
    lead_id:    leadId,
    channel:    "sms",
    direction,
    body,
    external_id: sid,
    created_at: new Date().toISOString(),
  });
}
 
async function updateLead(leadId, updates) {
  await supabase
    .from("leads")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", leadId);
}
 
// ── ROUTES ────────────────────────────────────────────────────
 
// Health check
app.get("/health", (req, res) => {
  res.json({
    status:     "ok",
    officeOpen: isOfficeOpen(),
    agent:      S.agentName,
    agency:     S.agencyName,
    time:       new Date().toLocaleTimeString(),
  });
});
 
// Receive new leads from EverQuote, QuoteWizard, Zapier, etc.
app.post("/ingest", async (req, res) => {
  try {
    const b = req.body;
    const name    = b.name || `${b.first_name || ""} ${b.last_name || ""}`.trim() || b.full_name || "Friend";
    const phone   = b.phone || b.phone_number || b.mobile || null;
    const product = b.product || b.insurance_type || b.line_of_business || "Auto Insurance";
    const source  = b.source || b.vendor || "Unknown";
 
    if (!phone) return res.status(400).json({ error: "Phone number required" });
 
    // Dedupe check — don't add same number twice in 30 days
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", phone)
      .gte("created_at", new Date(Date.now() - 30 * DAY * 1000).toISOString())
      .single();
 
    if (existing) {
      console.log(`⚠️ Duplicate lead skipped: ${phone}`);
      return res.json({ status: "duplicate" });
    }
 
    // Save lead
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        name, phone, product, source,
        status:     "queued",
        sms_stage:  0,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
 
    if (error) throw error;
 
    console.log(`✅ New lead: ${name} | ${phone} | ${source} | ${product}`);
 
    // Send first cadence message immediately
    const firstMsg = fill(CADENCE[0].message, lead);
    const sid      = await sendSMS(phone, firstMsg);
    await logMessage(lead.id, "outbound", firstMsg, sid);
    await updateLead(lead.id, { status: "texting", sms_stage: 0 });
 
    res.json({ status: "ok", leadId: lead.id });
  } catch (e) {
    console.error("❌ Ingest error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// Twilio inbound SMS webhook
app.post("/sms/inbound", async (req, res) => {
  // Always respond to Twilio immediately
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
 
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return;
 
  console.log(`📨 Inbound from ${from}: "${body}"`);
 
  try {
    // Find lead by phone
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("phone", from)
      .single();
 
    if (!lead) {
      console.log(`⚠️ Unknown number: ${from}`);
      return;
    }
 
    // Log inbound message
    await logMessage(lead.id, "inbound", body);
 
    // Don't reply to transferred leads
    if (lead.status === "transferred") return;
 
    // Handle opt-out
    if (["stop","unsubscribe","quit","cancel"].includes(body.toLowerCase())) {
      await updateLead(lead.id, { status: "opted_out" });
      console.log(`🚫 Opt-out: ${lead.name}`);
      return;
    }
 
    let replyText;
 
    if (!isOfficeOpen()) {
      // After hours — send holding message
      replyText = fill(S.afterHoursMsg, lead);
    } else {
      // Office hours — get Claude AI reply
      replyText = await getAIReply(lead, body);
 
      // Check if lead is warm
      if (isWarm(body) || isWarm(replyText)) {
        await updateLead(lead.id, { status: "warm" });
        console.log(`🔥 WARM LEAD: ${lead.name} — ready for transfer!`);
      } else {
        await updateLead(lead.id, { status: "texting" });
      }
    }
 
    // Send reply
    const sid = await sendSMS(from, replyText);
    await logMessage(lead.id, "outbound", replyText, sid);
 
  } catch (e) {
    console.error("❌ Inbound SMS error:", e.message);
  }
});
 
// Warm transfer — called from dashboard
app.post("/transfer/:leadId", async (req, res) => {
  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", req.params.leadId)
      .single();
 
    if (!lead) return res.status(404).json({ error: "Lead not found" });
 
    const msg = `Hi ${(lead.name || "").split(" ")[0]}! My colleague is calling you right now to get you that quote — please pick up! 📞`;
    const sid = await sendSMS(lead.phone, msg);
    await logMessage(lead.id, "outbound", msg, sid);
    await updateLead(lead.id, { status: "transferred" });
 
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
// Get all leads for dashboard
app.get("/leads", async (req, res) => {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .not("status", "eq", "opted_out")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
 
// ── CADENCE SCHEDULER ─────────────────────────────────────────
// Runs every 10 minutes — sends next cadence message when due
cron.schedule("*/10 * * * *", async () => {
  try {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 20) return; // No texts before 8am or after 8pm
 
    const { data: leads } = await supabase
      .from("leads")
      .select("*")
      .in("status", ["queued","texting"])
      .lt("sms_stage", CADENCE.length - 1);
 
    if (!leads?.length) return;
 
    const now = Date.now();
 
    for (const lead of leads) {
      const nextStepIndex = lead.sms_stage + 1;
      const nextStep      = CADENCE[nextStepIndex];
      if (!nextStep) continue;
 
      const created   = new Date(lead.created_at).getTime();
      const sendAfter = created + nextStep.delaySeconds * 1000;
 
      if (now >= sendAfter) {
        const msgText = fill(nextStep.message, lead);
        const sid     = await sendSMS(lead.phone, msgText);
        await logMessage(lead.id, "outbound", msgText, sid);
        await updateLead(lead.id, { sms_stage: nextStepIndex });
        console.log(`📤 Cadence step ${nextStepIndex} → ${lead.name}`);
      }
    }
 
    // Archive leads that finished the full cadence with no reply
    const { data: done } = await supabase
      .from("leads")
      .select("*")
      .eq("sms_stage", CADENCE.length - 1)
      .eq("status", "texting");
 
    for (const lead of done || []) {
      const lastUpdated = new Date(lead.updated_at || lead.created_at).getTime();
      if (now - lastUpdated > DAY * 7 * 1000) {
        await updateLead(lead.id, { status: "stalled" });
        console.log(`😴 Stalled: ${lead.name}`);
      }
    }
 
  } catch (e) {
    console.error("❌ Scheduler error:", e.message);
  }
});
 
// ── START SERVER ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │   🛡  ShieldFlow AI — Vestal Agency         │
  │   Port: ${PORT}                                 │
  │   Agent: ${S.agentName}                 │
  │   Office open: ${isOfficeOpen() ? "YES ✅" : "NO  🌙"}                  │
  │                                             │
  │   POST /ingest        ← new leads          │
  │   POST /sms/inbound   ← Twilio replies     │
  │   POST /transfer/:id  ← warm transfer      │
  │   GET  /leads         ← all leads          │
  │   GET  /health        ← status check       │
  └─────────────────────────────────────────────┘
  `);
});
