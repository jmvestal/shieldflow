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
  officeHours: { days: ["Mon","Tue","Wed","Thu","Fri","Sat"], start: "08:00", end: "20:00" },
  saturdayHours: { start: "09:00", end: "18:00" },
};

function getAfterHoursMsg(lead) {
  const now         = new Date();
  const central     = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const hour        = central.getHours();
  const day         = central.getDay(); // 0=Sun, 6=Sat
  const name        = (lead.name || "").split(" ")[0] || "there";

  // Figure out next open time
  let nextOpen = "";
  if (day === 5 && hour >= 20) {
    // Friday evening — back Monday
    nextOpen = "first thing Monday morning";
  } else if (day === 6 && hour >= 18) {
    // Saturday evening — back Monday
    nextOpen = "first thing Monday morning";
  } else if (day === 0) {
    // Sunday — back Monday
    nextOpen = "first thing Monday morning";
  } else {
    // Weekday evening or early morning
    nextOpen = "tomorrow morning around 9";
  }

  // Pick greeting based on time of day
  let greeting = "";
  if (hour >= 20) {
    greeting = `Have a great evening, ${name}.`;
  } else if (hour >= 17) {
    // Friday evening — wish them a great weekend
    if (day === 5) {
      greeting = `Hope you have a great weekend, ${name}!`;
    } else {
      greeting = `Hope your evening is going well, ${name}.`;
    }
  } else if (hour < 8) {
    greeting = `Good morning, ${name}!`;
  } else {
    greeting = `Hey ${name},`;
  }

  // Friday specific variations
  const isFridayEvening = day === 5 && hour >= 17;

  // Rotate through a few variations
  const variations = isFridayEvening ? [
    `Hope you have a wonderful weekend, ${name}! I got your message and will follow up with you first thing Monday morning. Enjoy your weekend!`,
    `Have a great weekend, ${name}! I saw your message and wanted you to know I'll take care of you first thing Monday. Talk soon!`,
    `${name}, hope you have a great weekend! Got your message — I'll reach out Monday morning and we'll get everything sorted out for you.`,
  ] : [
    `${greeting} I just saw your message and wanted you to know I got it. I'll personally reach out ${nextOpen} — we'll get you taken care of.`,
    `${greeting} Thanks for reaching out. I'm wrapping up for the day but I'll follow up with you ${nextOpen}. Looking forward to talking with you.`,
    `${greeting} Got your message. I'm not available right now but I'll be in touch ${nextOpen}. Feel free to reply with any questions in the meantime.`,
  ];

  // Rotate based on hour so it's consistent per session
  return variations[hour % variations.length];
}

const DAY = 86400;

// Rotating first messages — cycles through for each new lead
const FIRST_MESSAGES = [
  "Hi {name}, this is John Michael and I am a Farmers Insurance agent. You recently requested a {product} quote — I'd love to help you out. Do you have a few minutes?",
  "Hi {name}, this is John Michael and I am a Farmers Insurance agent. You recently requested a {product} quote — I'd love to get you the best rate possible. When's a good time to chat?",
  "Hi {name}, this is John Michael and I am a Farmers Insurance agent. You recently requested a {product} quote — let's see what I can do for you. Do you have a few minutes today?",
];

const CADENCE = [
  { step: 0, delaySeconds: 0,       message: null }, // null = uses rotating first message
  { step: 1, delaySeconds: 3600*2,  message: "Hey {name}, still here whenever you're ready. Many of my clients save $400-$800 a year on their {product}. Worth a 5-minute chat?" },
  { step: 2, delaySeconds: DAY*1,   message: "Good morning {name}. Quick question — are you bundling home and auto? Most clients save 15-25% combining both. Happy to run the numbers either way." },
  { step: 3, delaySeconds: DAY*3,   message: "Hi {name}, I know life gets busy. All I need is 5 minutes and your current policy info — I can usually beat what you're paying now. Still interested? Just reply YES." },
  { step: 4, delaySeconds: DAY*5,   message: "Hi {name}, rates in your area shifted this week and I wanted to make sure you get a quote before they move again. No obligation, just a quick comparison. Worth a look?" },
  { step: 5, delaySeconds: DAY*7,   message: "Last message from me for now, {name}. If you ever want to revisit your {product} coverage, I'm just a text away. Hope you're doing great." },
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
  // Convert to Central Time (UTC-5 standard, UTC-6 daylight)
  const now        = new Date();
  const centralTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][centralTime.getDay()];
  if (!S.officeHours.days.includes(day)) return false;
  const mins = centralTime.getHours() * 60 + centralTime.getMinutes();
  if (day === "Sat") {
    const [sh, sm] = S.saturdayHours.start.split(":").map(Number);
    const [eh, em] = S.saturdayHours.end.split(":").map(Number);
    return mins >= sh * 60 + sm && mins < eh * 60 + em;
  }
  const [sh, sm] = S.officeHours.start.split(":").map(Number);
  const [eh, em] = S.officeHours.end.split(":").map(Number);
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

  const centralTime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const centralDate = new Date(centralTime);
  const centralHour = centralDate.getHours();
  const centralDay  = centralDate.getDay();
  const isFriday    = centralDay === 5;
  const isMidWeek   = centralDay === 3;
  const isLateWeek  = centralDay === 4;
  const timeContext = centralHour >= 17 && isFriday
    ? "REQUIRED: It is Friday evening. You MUST end your message with a warm weekend send-off. For example: 'Have a great weekend!' or 'Enjoy your weekend!' This is required on every message right now."
    : centralHour >= 18
    ? "REQUIRED: It is evening. You MUST end every message with a warm evening closing. For example: 'Have a great night!' or 'Enjoy your evening!' or 'Talk tomorrow morning — have a good night!' Never just end with 'talk soon' or 'see you then' without adding a warm evening closing."
    : centralHour >= 17
    ? "REQUIRED: It is late afternoon heading into evening. End your message with something warm like 'Have a good evening!' or 'Hope your evening goes well!'"
    : centralHour >= 12
    ? "IMPORTANT: It is the afternoon — do NOT say 'good morning', 'rest of your morning', or reference morning in any way. It is past noon. If closing naturally say 'have a great afternoon' or just close without a time reference."
    : centralHour >= 10
    ? "It is late morning, around 10-11am. You can reference morning if natural but keep it brief."
    : centralHour < 10
    ? "It is early morning before 10am. If natural, open with a good morning reference."
    : isMidWeek && centralHour < 17
    ? "It is Wednesday. If natural and early in the conversation, mention something like 'hope your week is going well so far.'"
    : isLateWeek && centralHour < 17
    ? "It is Thursday. If natural, mention something like 'hope it has been a good week so far.'"
    : isFriday && centralHour < 17
    ? "It is Friday daytime. If natural, reference the upcoming weekend."
    : "It is daytime.";

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 300,
    system: `You are John Michael, a friendly Farmers Insurance agent texting leads via SMS.
Lead: ${(lead.name || "").split(" ")[0]}, interested in ${lead.product || "insurance"}, from ${lead.source || "online"}.
${lead.status === "after_hours" ? "IMPORTANT: This lead sent messages after hours. Review their previous messages carefully and respond to everything they asked in one natural reply." : ""}
Time context: ${timeContext}

Rules:
- SMS only — 1 to 3 sentences MAX
- Be warm, human, and natural. Never robotic.
- Always refer to yourself as John Michael
- NO emojis — ever. Plain conversational text only.
- You sell auto, home, renters, umbrella, life, and commercial insurance through Farmers
- Plain text only. No markdown, no bullets, no emojis.
- IMPORTANT: Vary your wording every time. Never use the exact same phrasing twice in a conversation. Sound like a real person, not a script.

BUNDLING — top priority on every conversation:

If they asked for AUTO, ask about home early. Rotate through variations like:
- "Do you currently rent or own your home? I ask because bundling home and auto together usually saves people 15-25% on both."
- "Quick question — do you own or rent where you live? The reason I ask is bundling can usually get you a better rate on both."
- "Are you a homeowner or renter? I want to make sure I'm getting you every discount available, and bundling is usually the biggest one."

If they asked for HOME, ask about auto early. Rotate through variations like:
- "Do you have any vehicles I can quote as well? Bundling auto with home almost always saves money on both policies."
- "While I have you, do you want me to run your auto too? Most people save when they put both together."
- "Do you have a car I can include? Bundling is usually where the biggest savings come from."

If they asked for RENTERS, ask about auto. Rotate through variations like:
- "Do you have a vehicle I can quote too? Renters and auto bundle really well together."
- "While I'm at it, want me to include your auto? It usually makes both cheaper."

WHEN THEY SAY THEY ONLY WANT ONE LINE — don't push hard, but plant the seed:
- "Totally understand, I'll get that taken care of for you. Just keep in mind if you ever want to add the other line down the road I can usually get you a better combined rate. For now let's focus on the auto."
- "No problem at all. I'll get you taken care of on the home. Just so you know, whenever you're ready to look at bundling I'm here — a lot of my clients end up saving more than they expected."
- "Got it, I'll focus on that for you. I do want to mention bundling when the time is right because the savings are usually pretty significant, but for now let's get this quote done first."

GOAL: Quote at least 2 lines per household when possible, then get them on the phone.
- IMPORTANT: When someone asks you to text them at a specific time or in X minutes, ONLY confirm the time. Do not add any sales pitch, question, or follow-up. Just confirm and stop. Example: "Sounds good, I'll reach out in 3 minutes." or "Perfect, I'll text you at 2pm." Nothing else. The follow-up happens later automatically.
- When ready for quote: Rotate through variations like:
  - "Great, let me get you a quote — can I call you now or is there a better time?"
  - "Sounds good. What's the best number to reach you and when works for a quick call?"
  - "Perfect. I can have numbers for you pretty quickly — when can I give you a call?"

OBJECTION HANDLING — never give up after one objection. Vary your responses every time.

When they say "not right now" or "I'm busy" — rotate through:
- "No problem at all. When would be a better time — later today or sometime this week?"
- "Totally understand. Would tomorrow work better, or is there a specific time that's good for you?"
- "No worries. What does your schedule look like later this week?"

When they say "I already have insurance" — rotate through:
- "That's great, most of my clients already have coverage. I just want to make sure you're getting the best rate — would you be open to a quick comparison? No obligation at all."
- "Completely understand. Honestly I just want to make sure you're not overpaying — would you be open to a free second opinion on your rate?"
- "Good to hear. Rates change a lot and I find a lot of people are paying more than they need to. It only takes a few minutes to compare — would that be okay?"

When they say "I'm not interested" — rotate through:
- "I completely understand. Can I ask — is it the timing, or are you pretty happy with what you have right now?"
- "That's totally fair. Is it more about the timing, or do you feel like you're already in a good spot with your current coverage?"
- "No problem. Out of curiosity, is there something specific that made you feel that way? I just want to make sure I'm not missing something."

When they say "too expensive" or mention price — rotate through:
- "I hear you. That's actually why I reach out — most people I talk to are overpaying without realizing it. I work with over 20 carriers so I can usually find something better. Would you be open to just seeing the number?"
- "Understood. Honestly finding a better rate is exactly what I do — I shop over 20 companies so you don't have to. It costs nothing to look. Want me to see what I can find?"
- "That's a fair concern. I can't promise I'll beat it, but I work with a lot of carriers and it's worth a quick look. Would you be open to that?"

When they say "I'll think about it" — rotate through:
- "Of course, take your time. What's the main thing you're thinking over? I want to make sure I answered everything."
- "Absolutely, no rush. Is there anything I can answer that would help make the decision easier?"
- "That's completely fine. Is there a specific concern I can help clear up before you decide?"

When they say "just text me later" or "remind me" — rotate through:
- "Absolutely, I'll follow up. Would tomorrow morning or afternoon work better for you?"
- "Will do. Is there a specific day or time that works best for me to check back in?"
- "No problem. Should I reach back out tomorrow, or would a few days from now be better?"

Only truly end the conversation if they say STOP, unsubscribe, or are clearly and repeatedly refusing after multiple attempts.`,
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
  const centralTime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  res.json({
    status:      "ok",
    officeOpen:  isOfficeOpen(),
    agent:       S.agentName,
    agency:      S.agencyName,
    centralTime: centralTime,
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

    // Get total lead count to determine which rotating message to use
    const { count } = await supabase.from("leads").select("*", { count: "exact", head: true });
    const rotatingMsg = FIRST_MESSAGES[(count || 0) % FIRST_MESSAGES.length];
    const firstMsg = fill(rotatingMsg, lead);
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

    // Opt-out detection — only triggers on clear explicit opt-out phrases
    // Does NOT trigger on things like "text me at 11:30" or "can you text me tomorrow"
    const lowerBody = body.toLowerCase().trim();
    const hardOptOut = [
      "stop", "unsubscribe", "quit", "cancel",
      "stop texting", "stop texting me",
      "no more texts", "no more messages",
      "leave me alone", "remove me",
      "do not contact", "do not text",
      "don't contact me", "dont contact me",
      "please stop texting", "stop please",
      "take me off your list",
    ].some(phrase => lowerBody === phrase || lowerBody.startsWith(phrase + " ") || lowerBody.endsWith(" " + phrase));

    if (hardOptOut) {
      await updateLead(lead.id, { status: "opted_out" });
      await sendSMS(from, "No problem at all. I'll leave you alone and wish you all the best. If you ever need anything down the road, don't hesitate to reach out.");
      await logMessage(lead.id, "outbound", "No problem at all. I'll leave you alone and wish you all the best. If you ever need anything down the road, don't hesitate to reach out.");
      console.log(`🚫 Opted out: ${lead.name}`);
      return;
    }

    let replyText;

    if (!isOfficeOpen()) {
      // Check if we already sent an after-hours message to this lead tonight
      const tonightStart = new Date();
      tonightStart.setHours(0, 0, 0, 0);

      const { data: afterHoursMsgs } = await supabase
        .from("messages")
        .select("id")
        .eq("lead_id", lead.id)
        .eq("direction", "outbound")
        .gte("created_at", tonightStart.toISOString());

      const alreadySentAfterHours = (afterHoursMsgs || []).length > 0 &&
        lead.status === "after_hours";

      if (alreadySentAfterHours) {
        // Silently log — no reply. Claude will catch up in the morning.
        await updateLead(lead.id, { status: "after_hours" });
        console.log(`🌙 After-hours follow-up logged silently for ${lead.name}`);
        return;
      }

      // First after-hours message — send the holding message
      replyText = getAfterHoursMsg(lead);
      await updateLead(lead.id, { status: "after_hours" });
      const sid = await sendSMS(from, replyText);
      await logMessage(lead.id, "outbound", replyText, sid);
      return;

    } else {
      // Office is open — if lead was in after_hours status, Claude catches up on everything they said
      if (lead.status === "after_hours") {
        console.log(`☀️ Office opened — catching up on after-hours messages for ${lead.name}`);
      }
      replyText = await getAIReply(lead, body);

      // Detect callback request BEFORE sending reply
      const lowerMsg = body.toLowerCase();
      const wantsCallback = (
        lowerMsg.includes("text me at") ||
        lowerMsg.includes("call me at") ||
        lowerMsg.includes("reach out at") ||
        lowerMsg.includes("contact me at") ||
        lowerMsg.includes("text me in") ||
        lowerMsg.includes("call me in") ||
        lowerMsg.includes("text me tomorrow") ||
        lowerMsg.includes("call me tomorrow") ||
        lowerMsg.includes("follow up tomorrow") ||
        lowerMsg.includes("try me tomorrow") ||
        lowerMsg.includes("try again tomorrow")
      );

      // Send Claude's reply first
      const sid = await sendSMS(from, replyText);
      await logMessage(lead.id, "outbound", replyText, sid);

      if (wantsCallback) {
        const callbackTime = new Date();

        // Check for "in X minutes/mins/min"
        const minuteMatch = lowerMsg.match(/in (\d+)\s*min/);
        if (minuteMatch) {
          callbackTime.setMinutes(callbackTime.getMinutes() + parseInt(minuteMatch[1]));
          console.log(`⏰ Scheduling callback in ${minuteMatch[1]} minutes`);
        } else {
          const timeMatch = body.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) ||
                            body.match(/(\d{1,2})\s*(am|pm)/i);
          if (timeMatch) {
            let hour = parseInt(timeMatch[1]);
            const mins = timeMatch[2] && !isNaN(timeMatch[2]) ? parseInt(timeMatch[2]) : 0;
            const meridiem = (timeMatch[3] || timeMatch[2] || "").toLowerCase();
            if (meridiem === "pm" && hour !== 12) hour += 12;
            if (meridiem === "am" && hour === 12) hour = 0;
            if (!meridiem && hour < 8) hour += 12;
            callbackTime.setHours(hour, mins, 0, 0);
            if (callbackTime < new Date()) {
              callbackTime.setDate(callbackTime.getDate() + 1);
            }
          } else {
            callbackTime.setDate(callbackTime.getDate() + 1);
            callbackTime.setHours(9, 0, 0, 0);
            console.log(`⏰ No specific time detected — scheduling for tomorrow 9am`);
          }
        }

        await supabase.from("leads").update({
          status:        "callback_scheduled",
          callback_time: callbackTime.toISOString(),
          updated_at:    new Date().toISOString(),
        }).eq("id", lead.id);

        console.log(`📅 Callback scheduled for ${lead.name} at ${callbackTime.toLocaleString("en-US", { timeZone: "America/Chicago" })} Central`);

      } else if (isWarm(body) || isWarm(replyText)) {
        await updateLead(lead.id, { status: "warm" });
        console.log(`🔥 WARM LEAD: ${lead.name}`);
      } else {
        await updateLead(lead.id, { status: "texting" });
      }
    }

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
// OUTBOUND RULES: Mon-Fri 8am-6pm only. No weekend outbound.
// AI still replies to inbound messages any time office is open (8am-8pm Mon-Sat)
cron.schedule("*/10 * * * *", async () => {
  try {
    // Use Central time for all time checks
    const centralTime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    const centralDate = new Date(centralTime);
    const centralHour = centralDate.getHours();
    const centralDay  = centralDate.getDay(); // 0=Sun, 6=Sat

    // No outbound cadence texts on weekends
    if (centralDay === 0 || centralDay === 6) {
      console.log("⏸ Weekend — no outbound cadence texts today");
      return;
    }

    // No outbound cadence texts before 8am or after 6pm on weekdays
    if (centralHour < 8 || centralHour >= 18) {
      console.log("⏸ Outside outbound hours — no cadence texts right now");
      return;
    }

    const { data: leads } = await supabase.from("leads").select("*")
      .in("status", ["queued","texting"])
      .lt("sms_stage", CADENCE.length - 1);

    const now = Date.now();

    for (const lead of leads || []) {
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

    // Cadence scheduler only handles lead nurture steps
    // Callbacks are handled exclusively by setTimeout in scheduleCallback()

  } catch (e) {
    console.error("❌ Scheduler error:", e.message);
  }
});

// ── CALLBACK SCHEDULER ───────────────────────────────────────
// Runs every minute — checks for due callbacks from database
// More reliable than setTimeout on free hosting (survives restarts/sleep)
cron.schedule("* * * * *", async () => {
  try {
    const { data: callbacks } = await supabase.from("leads")
      .select("*")
      .eq("status", "callback_scheduled")
      .lte("callback_time", new Date().toISOString())
      .not("callback_time", "is", null);

    for (const lead of callbacks || []) {
      const centralNow = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
      const hour       = new Date(centralNow).getHours();
      const greeting   = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
      const msg        = `${greeting} ${(lead.name || "").split(" ")[0]}, this is John Michael following up as promised. Is now still a good time to chat about your ${lead.product || "insurance"} quote?`;
      await sendSMS(lead.phone, msg);
      await logMessage(lead.id, "outbound", msg);
      await updateLead(lead.id, { status: "texting", callback_time: null });
      console.log(`📞 Callback fired for ${lead.name}`);
    }
  } catch (e) {
    console.error("❌ Callback scheduler error:", e.message);
  }
});


const CROSSSELL = {
  auto_home: [
    { step: 0, wait: 0,       ch: "sms", msg: "Hi {name}, this is John Michael, a Farmers Insurance agent. I wanted to reach out because you're currently insured with us on auto — do you currently have your home insured as well? Bundling both can save you 15-25% on both policies." },
    { step: 1, wait: 86400*3, ch: "sms", msg: "Hey {name}, following up on bundling your home with your auto. Most of my clients save $200-$400 a year when they combine both. Would you be open to a quick quote on the home side?" },
    { step: 2, wait: 86400*3, ch: "sms", msg: "Hi {name}, last check-in on this. If you ever want to explore bundling your home and auto together I'm just a text away. The savings are usually pretty significant." },
    { step: 3, wait: 86400*7, ch: "sms", msg: "Hey {name}, no pressure at all. Just want you to know the offer stands whenever you're ready. Bundling home and auto is one of the best ways to save on both. Take care." },
  ],
  home_auto: [
    { step: 0, wait: 0,       ch: "sms", msg: "Hi {name}, this is John Michael, a Farmers Insurance agent. You're currently with us on your home — do you have your vehicles insured with us as well? Bundling auto with your home usually saves people money on both." },
    { step: 1, wait: 86400*3, ch: "sms", msg: "Hey {name}, following up on adding auto to your home policy. Most clients save $300-$500 a year bundling both together. Want me to run a quick quote?" },
    { step: 2, wait: 86400*3, ch: "sms", msg: "Hi {name}, last check-in. If you're ever ready to look at bundling your auto with your home I'd love to help. Just reply anytime." },
    { step: 3, wait: 86400*7, ch: "sms", msg: "Hey {name}, no worries if the timing isn't right. I'm here whenever you want to explore saving on both your home and auto. Take care." },
  ],
  bundle_umbrella: [
    { step: 0, wait: 0,       ch: "sms", msg: "Hi {name}, this is John Michael with Farmers. Since you have both home and auto with us I wanted to mention a personal umbrella policy. It adds $1 million in extra liability coverage for about $15-25 a month. Would you want to know more?" },
    { step: 1, wait: 86400*4, ch: "sms", msg: "Hey {name}, following up on the umbrella policy. It's one of those things most people don't think about until they need it. Want me to run a quick quote? Usually same-day bind." },
    { step: 2, wait: 86400*7, ch: "sms", msg: "Hi {name}, last nudge on umbrella coverage. Whenever you're ready I can usually get it bound same day. Just reply and I'll take care of it." },
  ],
  auto_renters: [
    { step: 0, wait: 0,       ch: "sms", msg: "Hi {name}, this is John Michael with Farmers. Quick question — do you rent where you live? If so, renters insurance is usually $12-18 a month and bundles with your auto for a discount on both." },
    { step: 1, wait: 86400*3, ch: "sms", msg: "Hey {name}, following up on renters coverage. A lot of people don't realize their landlord's insurance doesn't cover their belongings. Want me to run a quick quote bundled with your auto?" },
    { step: 2, wait: 86400*5, ch: "sms", msg: "Hi {name}, last check-in on renters insurance. It's one of the most affordable policies I offer and pairs really well with your auto. Just reply anytime if you want to take a look." },
  ],
};

const WIN_BACK = [
  { step: 0, wait: 0,       msg: "Hi {name}, this is John Michael with Farmers Insurance. It's been a while since we last worked together and I wanted to reach out — rates have shifted quite a bit lately and I think I might be able to beat what you're currently paying on your {product}. Would you be open to a quick comparison?" },
  { step: 1, wait: 86400*3, msg: "Hey {name}, following up on my last message. I know switching feels like a hassle but I can usually have a quote ready in about 10 minutes. No commitment to look. Want me to run it?" },
  { step: 2, wait: 86400*3, msg: "Hi {name}, I work with over 20 carriers so I can shop the whole market for you at once. A lot of my clients are surprised by what I find. Would you be open to just seeing the number?" },
  { step: 3, wait: 86400*7, msg: "Hey {name}, last check-in from me. If your {product} renewal is coming up I'd love a shot at earning your business back. Just reply anytime and I'll get right on it." },
  { step: 4, wait: 86400*14, msg: "Hi {name}, one final note. I'm always here if you want to compare rates on your {product}. Keep my number and reach out whenever the time is right. Hope all is well." },
];

const QUOTE_FOLLOWUP = [
  { step: 0, wait: 0,        msg: "Hi {name}, just wanted to make sure you received the quote I sent over for your {product}. Let me know if you have any questions or if you'd like to adjust anything." },
  { step: 1, wait: 3600*2,   msg: "Hey {name}, just checking in on your {product} quote. Happy to walk you through it or look at different coverage options if needed." },
  { step: 2, wait: 86400*1,  msg: "Hi {name}, following up on your quote. If price is a concern I may have other options worth looking at. Just reply and I'll pull some alternatives." },
  { step: 3, wait: 86400*3,  msg: "Hey {name}, still thinking it over? No rush at all. Is there anything I can answer to help make the decision easier?" },
  { step: 4, wait: 86400*7,  msg: "Hi {name}, last follow-up on your {product} quote. If you've already found something that works, no worries at all. If not, I'm still here and happy to help." },
];

// ── CAMPAIGN HELPERS ──────────────────────────────────────────
function fillCampaign(template, record) {
  return (template || "")
    .replace(/{name}/g,    (record.client_name || "").split(" ")[0] || "there")
    .replace(/{product}/g, record.product || record.target_line || "insurance");
}

async function fireCampaignStep(table, record, step) {
  const msg = fillCampaign(step.msg, record);
  const sid = await sendSMS(record.client_phone, msg);
  await supabase.from(table).update({
    stage:      (record.stage || 0) + 1,
    status:     "active",
    updated_at: new Date().toISOString(),
  }).eq("id", record.id);
  console.log(`📤 [${table}] Step ${record.stage} → ${record.client_name}`);
}

function getCadenceKey(current, target) {
  if (current === "auto"      && target === "home")     return "auto_home";
  if (current === "home"      && target === "auto")     return "home_auto";
  if (current === "auto,home" && target === "umbrella") return "bundle_umbrella";
  if (current === "auto"      && target === "renters")  return "auto_renters";
  return null;
}

// ── CROSS-SELL ROUTES ─────────────────────────────────────────

// Add single client to cross-sell
// POST /crosssell/add
// { client_name, client_phone, current_lines, target_line }
app.post("/crosssell/add", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, current_lines, target_line } = req.body;
    const cadenceKey = getCadenceKey(current_lines, target_line);
    if (!cadenceKey) return res.status(400).json({ error: `No cadence for ${current_lines} → ${target_line}` });

    const { data, error } = await supabase.from("cross_sell")
      .insert({ client_name, client_phone, client_email, current_lines, target_line, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    const step = CROSSSELL[cadenceKey][0];
    await fireCampaignStep("cross_sell", data, step);
    res.json({ status: "ok", id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk upload book for cross-sell
// POST /crosssell/bulk
// { clients: [{ client_name, client_phone, current_lines, target_line }] }
app.post("/crosssell/bulk", async (req, res) => {
  try {
    const { clients } = req.body;
    let queued = 0, skipped = 0;
    for (const c of clients || []) {
      const key = getCadenceKey(c.current_lines, c.target_line);
      if (!key) { skipped++; continue; }
      await supabase.from("cross_sell").insert({ ...c, status: "pending", stage: 0 });
      queued++;
    }
    res.json({ status: "ok", queued, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WIN-BACK ROUTES ───────────────────────────────────────────

// Add single lapsed client
// POST /winback/add
// { client_name, client_phone, product, renewal_date?, left_reason? }
app.post("/winback/add", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, product, renewal_date, left_reason } = req.body;
    const { data, error } = await supabase.from("win_back")
      .insert({ client_name, client_phone, client_email, product, renewal_date, left_reason, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    await fireCampaignStep("win_back", data, WIN_BACK[0]);
    res.json({ status: "ok", id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk upload lapsed clients
// POST /winback/bulk
// { clients: [{ client_name, client_phone, product, renewal_date }] }
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
app.post("/winback/won/:id", async (req, res) => {
  await supabase.from("win_back").update({ status: "converted" }).eq("id", req.params.id);
  res.json({ status: "ok" });
});

// ── QUOTE FOLLOW-UP ROUTES ────────────────────────────────────

// Trigger when you send a quote
// POST /quote/sent
// { client_name, client_phone, product, quoted_amount? }
app.post("/quote/sent", async (req, res) => {
  try {
    const { client_name, client_phone, client_email, product, quoted_amount } = req.body;
    const { data, error } = await supabase.from("quote_followup")
      .insert({ client_name, client_phone, client_email, product, quoted_amount, status: "pending", stage: 0 })
      .select().single();
    if (error) throw error;

    await fireCampaignStep("quote_followup", data, QUOTE_FOLLOWUP[0]);
    res.json({ status: "ok", id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark quote as won — stops follow-up
app.post("/quote/closed", async (req, res) => {
  try {
    const { client_phone } = req.body;
    await supabase.from("quote_followup")
      .update({ status: "won" })
      .eq("client_phone", client_phone)
      .eq("status", "active");
    res.json({ status: "ok" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Campaign stats
app.get("/campaigns/stats", async (req, res) => {
  const [cs, qf, wb] = await Promise.all([
    supabase.from("cross_sell").select("status"),
    supabase.from("quote_followup").select("status"),
    supabase.from("win_back").select("status"),
  ]);
  const count = (arr, s) => (arr?.data || []).filter(r => r.status === s).length;
  res.json({
    cross_sell:     { active: count(cs, "active"), completed: count(cs, "completed") },
    quote_followup: { active: count(qf, "active"), won: count(qf, "won"), completed: count(qf, "completed") },
    win_back:       { active: count(wb, "active"), converted: count(wb, "converted"), completed: count(wb, "completed") },
  });
});

// ── CAMPAIGN SCHEDULER ────────────────────────────────────────
// OUTBOUND RULES: Mon-Fri 8am-6pm Central only. No weekends.
cron.schedule("*/15 * * * *", async () => {
  try {
    const centralTime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    const centralDate = new Date(centralTime);
    const centralHour = centralDate.getHours();
    const centralDay  = centralDate.getDay();

    // No outbound on weekends
    if (centralDay === 0 || centralDay === 6) return;

    // No outbound before 8am or after 6pm Central
    if (centralHour < 8 || centralHour >= 18) return;

    const now = Date.now();

    // Cross-sell — fire pending (5 per run to stagger)
    const { data: csPending } = await supabase.from("cross_sell").select("*").eq("status","pending").limit(5);
    for (const rec of csPending || []) {
      const key = getCadenceKey(rec.current_lines, rec.target_line);
      if (!key) continue;
      await fireCampaignStep("cross_sell", rec, CROSSSELL[key][0]);
    }

    // Cross-sell — advance active
    const { data: csActive } = await supabase.from("cross_sell").select("*").eq("status","active");
    for (const rec of csActive || []) {
      const key = getCadenceKey(rec.current_lines, rec.target_line);
      if (!key) continue;
      const cadence  = CROSSSELL[key];
      const nextStep = cadence[rec.stage];
      if (!nextStep) { await supabase.from("cross_sell").update({ status: "completed" }).eq("id", rec.id); continue; }
      if (now >= new Date(rec.created_at).getTime() + nextStep.wait * 1000) {
        await fireCampaignStep("cross_sell", rec, nextStep);
      }
    }

    // Win-back — fire pending (5 per run)
    const { data: wbPending } = await supabase.from("win_back").select("*").eq("status","pending").limit(5);
    for (const rec of wbPending || []) await fireCampaignStep("win_back", rec, WIN_BACK[0]);

    // Win-back — advance active
    const { data: wbActive } = await supabase.from("win_back").select("*").eq("status","active");
    for (const rec of wbActive || []) {
      const nextStep = WIN_BACK[rec.stage];
      if (!nextStep) { await supabase.from("win_back").update({ status: "completed" }).eq("id", rec.id); continue; }
      if (now >= new Date(rec.created_at).getTime() + nextStep.wait * 1000) {
        await fireCampaignStep("win_back", rec, nextStep);
      }
    }

    // Quote follow-up — advance active
    const { data: qfActive } = await supabase.from("quote_followup").select("*").eq("status","active");
    for (const rec of qfActive || []) {
      const nextStep = QUOTE_FOLLOWUP[rec.stage];
      if (!nextStep) { await supabase.from("quote_followup").update({ status: "completed" }).eq("id", rec.id); continue; }
      if (now >= new Date(rec.created_at).getTime() + nextStep.wait * 1000) {
        await fireCampaignStep("quote_followup", rec, nextStep);
      }
    }

  } catch (e) { console.error("❌ Campaign scheduler error:", e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   🛡  ShieldFlow AI — Vestal Agency     │
  │   Farmers Insurance                     │
  │   Port: ${PORT}                             │
  │   Office: ${isOfficeOpen() ? "OPEN ✅" : "CLOSED 🌙"}                  │
  │                                         │
  │   POST /ingest          ← new leads    │
  │   POST /sms/inbound     ← Twilio       │
  │   POST /crosssell/add   ← cross-sell   │
  │   POST /crosssell/bulk  ← bulk upload  │
  │   POST /winback/add     ← win-back     │
  │   POST /winback/bulk    ← bulk upload  │
  │   POST /quote/sent      ← quote f/u   │
  │   GET  /campaigns/stats ← overview     │
  │   GET  /health          ← status       │
  └─────────────────────────────────────────┘
  `);

  console.log("✅ ShieldFlow AI server started successfully");
});
