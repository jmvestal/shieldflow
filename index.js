// ShieldFlow AI — SMS Only Server
// Vestal Agency — Farmers Insurance

import express    from "express";
import twilio     from "twilio";
import Anthropic  from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import cron       from "node-cron";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Settings
const S = {
  agentName:  process.env.AGENT_NAME  || "John Michael Vestal",
  agencyName: process.env.AGENCY_NAME || "Vestal Agency",
  agentPhone: process.env.TWILIO_PHONE,
  officeHours: { days: ["Mon","Tue","Wed","Thu","Fri"], start: "09:00", end: "17:00" },
  afterHoursMsg: "Hey {name}! Thanks for reaching out 😊 Our office is currently closed but I'll personally follow up with you first thing when we open. Feel free to reply with any questions!",
};

const DAY = 86400;

const CADENCE = [
  { step: 0, delaySeconds: 0,       message: "Hi {name}! 👋 This is {agent} with {agency}, a Farmers Insurance agent here in Lubbock. You recently requested a {product} quote — I'd love to help you find the best rate. Got a quick moment?" },
  { step: 1, delaySeconds: 3600*2,  message: "Hey {name}! Still here whenever you're ready 😊 Many of my clients in Lubbock save $400–$800/year on their {product}. Worth a 5-min chat?" },
  { step: 2, delaySeconds: DAY*1,   message: "Good morning {name}! Quick question — are you bundling home and auto? Most clients save 15–25% combining both. Happy to run the numbers! 🏠🚗" },
  { step: 3, delaySeconds: DAY*3,   message: "Hi {name}, I know life gets busy! All I need is 5 minutes and your current policy info — I can usually beat what you're paying. Still interested? Reply YES!" },
  { step: 4, delaySeconds: DAY*5,   message: "Hi {name}! Rates in your area shifted this week — wanted to make sure you get a quote before they move again. No obligation, quick comparison. Worth a look? 📋" },
  { step: 5, delaySeconds: DAY*7,   message: "Last message from me for now, {name} 🙏 If you ever want to revisit your {product}, I'm one text away. Hope you're doing great!" },
];

const WARM_KEYWORDS = ["yes","yeah","sure","ready","now","call","available","free","connect","agent","interested","today","how much","quote","save","bundle","renewal","coverage","switching","cheaper"];

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

async function sendSMS(to, body) {
  if (!to) return null;
  try {
    const msg = await twilioClient.messages.create({ from: S.agentPhone, to, body });
    console.log(`📱 SMS → ${to}: "${body.slice(0, 60)}"`);
    return msg.sid;
  } catch (e) {
    console.error(`❌ SMS error: ${e.message}`);
    return null;
  }
}

async function getAIReply(lead, incomingMessage) {
  const { data: messages } = await supabase
    .from("messages").select("*").eq("lead_id", lead.id)
    .order("created_at", { ascending: true });

  const history = (messages || []).map(m => ({
    role:    m.direction === "outbound" ? "assistant" : "user",
    content: m.body,
  }));
  history.push({ role: "user", content: incomingMessage });

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `You are ${S.agentName.split(" ")[0]}, a friendly Farmers Insurance agent at ${S.agencyName} in Lubbock Texas texting leads via SMS.
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

async function logMessage(leadId, direction, body, sid = null) {
  await supabase.from("messages").insert({
    lead_id: leadId, channel: "sms", direction, body,
    external_id: sid, created_at: new Date().toISOString(),
  });
}

async function updateLead(leadId, updates) {
  await supabase.from("leads")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", leadId);
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok", officeOpen: isOfficeOpen(),
    agent: S.agentName, agency: S.agencyName,
    time: new Date().toLocaleTimeString(),
  });
});

// Receive new leads
app.post("/ingest", async (req, res) => {
  try {
    const b = req.body;
    const name    = b.name || `${b.first_name || ""} ${b.last_name || ""}`.trim() || b.full_name || "Friend";
    const phone   = b.phone || b.phone_number || b.mobile || null;
    const product = b.product || b.insurance_type || b.line_of_business || "Auto Insurance";
    const source  = b.source || b.vendor || "Unknown";

    if (!phone) return res.status(400).json({ error: "Phone number required" });

    const { data: existing } = await supabase.from("leads").select("id")
      .eq("phone", phone)
      .gte("created_at", new Date(Date.now() - 30 * DAY * 1000).toISOString())
      .single();

    if (existing) return res.json({ status: "duplicate" });

    const { data: lead, error } = await supabase.from("leads")
      .insert({ name, phone, product, source, status: "queued", sms_stage: 0, created_at: new Date().toISOString() })
      .select().single();

    if (error) throw error;

    console.log(`✅ New lead: ${name} | ${phone} | ${source} | ${product}`);

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

// Twilio inbound SMS
app.post("/sms/inbound", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return;

  console.log(`📨 Inbound from ${from}: "${body}"`);

  try {
    const { data: lead } = await supabase.from("leads").select("*").eq("phone", from).single();
    if (!lead) return;

    await logMessage(lead.id, "inbound", body);

    if (lead.status === "transferred") return;

    if (["stop","unsubscribe","quit","cancel"].includes(body.toLowerCase())) {
      await updateLead(lead.id, { status: "opted_out" });
      return;
    }

    let replyText;

    if (!isOfficeOpen()) {
      replyText = fill(S.afterHoursMsg, lead);
    } else {
      replyText = await getAIReply(lead, body);
      if (isWarm(body) || isWarm(replyText)) {
        await updateLead(lead.id, { status: "warm" });
        console.log(`🔥 WARM LEAD: ${lead.name}`);
      } else {
        await updateLead(lead.id, { status: "texting" });
      }
    }

    const sid = await sendSMS(from, replyText);
    await logMessage(lead.id, "outbound", replyText, sid);

  } catch (e) {
    console.error("❌ Inbound SMS error:", e.message);
  }
});

// Warm transfer
app.post("/transfer/:leadId", async (req, res) => {
  try {
    const { data: lead } = await supabase.from("leads").select("*").eq("id", req.params.leadId).single();
    if (!lead) return res.status(404).json({ error: "Not found" });

    const msg = `Hi ${(lead.name || "").split(" ")[0]}! My colleague is calling you right now to get your quote — please pick up! 📞`;
    const sid = await sendSMS(lead.phone, msg);
    await logMessage(lead.id, "outbound", msg, sid);
    await updateLead(lead.id, { status: "transferred" });

    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all leads
app.get("/leads", async (req, res) => {
  const { data, error } = await supabase.from("leads").select("*")
    .not("status", "eq", "opted_out")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Cadence scheduler — runs every 10 minutes
cron.schedule("*/10 * * * *", async () => {
  try {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 20) return;

    const { data: leads } = await supabase.from("leads").select("*")
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
  } catch (e) {
    console.error("❌ Scheduler error:", e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   🛡  ShieldFlow AI — Vestal Agency     │
  │   Farmers Insurance — Lubbock TX        │
  │   Port: ${PORT}                             │
  │   Office: ${isOfficeOpen() ? "OPEN ✅" : "CLOSED 🌙"}                  │
  │                                         │
  │   POST /ingest       ← new leads       │
  │   POST /sms/inbound  ← Twilio replies  │
  │   GET  /health       ← status          │
  └─────────────────────────────────────────┘
  `);
});
