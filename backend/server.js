// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

// ============ ENV SETUP ============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const MODEL = process.env.AZURE_OPENAI_MODEL || "awakening-assistant";
const API_KEY = process.env.AZURE_OPENAI_API_KEY;

if (!ENDPOINT || !API_KEY) {
  console.warn("⚠️ Azure environment variables are missing!");
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ============ STATIC FRONTEND ============
app.use(express.static(path.join(__dirname, "frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ============ CHAT ROUTE ============
app.post("/api/chat", async (req, res) => {
  try {
    const userMsg = req.body.message || "";

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: "You are HOOR, a gentle, trauma-informed companion. Speak softly, warmly, simply for women’s healing. Use warm, validating, non-judgmental language. Offer simple grounding (e.g., “inhale 4 — hold 4 — exhale 6”, “sip water”) when distress appears. Do not provide medical, diagnostic, or legal advice. If the user mentions immediate danger or self-harm, include: “If you’re in immediate danger in Hong Kong, dial 999 (SMS 992 for speech/hearing) or contact The Samaritans 24-hr 2389 2222 / 2389 2223.” Keep answers short, compassionate, and avoid triggering detail. Add: “We can slow down or stop at any time.” after emotional topics." },
        { role: "user", content: userMsg },
      ],
      max_tokens: 4500,
      temperature: 0.7,
    };

    const aiRes = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      const errorMsg = await aiRes.text();
      console.error("Azure Error:", errorMsg);
      return res.status(500).json({ reply: `Azure error: ${errorMsg}` });
    }

    const data = await aiRes.json();
    const reply = data?.choices?.[0]?.message?.content || "No reply from model.";

    res.json({ reply });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ reply: "Server error." });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

// 🔥 NO LOCALHOST MESSAGE
console.log(`Backend running on PORT ${PORT}`);

app.listen(PORT);
