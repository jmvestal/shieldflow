// ============================================================
//  ShieldFlow AI — Debug Version
// ============================================================
 
import express from "express";
 
const app = express();
app.use(express.json());
 
console.log("🔍 Checking environment variables...");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "✅ FOUND - starts with: " + process.env.TWILIO_ACCOUNT_SID.slice(0,4) : "❌ MISSING");
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "✅ FOUND" : "❌ MISSING");
console.log("TWILIO_PHONE:", process.env.TWILIO_PHONE ? "✅ FOUND: " + process.env.TWILIO_PHONE : "❌ MISSING");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ FOUND" : "❌ MISSING");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "✅ FOUND" : "❌ MISSING");
console.log("SUPABASE_SERVICE_KEY:", process.env.SUPABASE_SERVICE_KEY ? "✅ FOUND" : "❌ MISSING");
console.log("All env keys:", Object.keys(process.env).join(", "));
 
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    vars: {
      twilio_sid: process.env.TWILIO_ACCOUNT_SID ? "found" : "missing",
      twilio_token: process.env.TWILIO_AUTH_TOKEN ? "found" : "missing",
      twilio_phone: process.env.TWILIO_PHONE || "missing",
      anthropic: process.env.ANTHROPIC_API_KEY ? "found" : "missing",
      supabase_url: process.env.SUPABASE_URL || "missing",
      supabase_key: process.env.SUPABASE_SERVICE_KEY ? "found" : "missing",
    }
  });
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});
 
