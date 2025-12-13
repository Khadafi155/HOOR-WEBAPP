import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

// ============ PATH SETUP ============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ ENV SETUP ============
const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT; // https://awakening-assistant.openai.azure.com
const MODEL = process.env.AZURE_OPENAI_MODEL || "awakening-assistant";
const API_KEY = process.env.AZURE_OPENAI_API_KEY;

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT;
const SEARCH_KEY = process.env.AZURE_SEARCH_KEY;
const SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX;

if (!ENDPOINT || !API_KEY || !MODEL) {
  console.warn("⚠️ Missing Azure OpenAI environment variables!");
}
if (!SEARCH_ENDPOINT || !SEARCH_KEY || !SEARCH_INDEX) {
  console.warn("⚠️ Missing Azure Search environment variables!");
}

// ============ EXPRESS APP ============
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
    // 👉 raw dari user
    const rawUserMsg = req.body.message || "";

    // 👉 tambah konteks supaya Azure Search tetap ngerti ini tentang Dimple Bindra
    const userMsg = `${rawUserMsg}\n\n(Context: The user is asking about Dimple Bindra, her work, services, programs, and offerings.)`;

    const apiVersion = "2025-01-01-preview";
    const url = `${ENDPOINT}/openai/deployments/${MODEL}/chat/completions?api-version=${apiVersion}`;

    const systemMessage = `
You are HOOR, a gentle, trauma-informed emotional companion for women.

LANGUAGE:
- Always respond in the SAME language the user is using.
- If the user mixes languages (English, Indonesian, Cantonese, slang), answer naturally in the same style, but softer and clearer.
- Do NOT show citations like [doc1], [doc2], or any document/file names.

STYLE:
- Speak softly, warmly, and simply.
- Keep responses short: about 1–3 small paragraphs.
- Validate and normalize her feelings.
- Offer simple grounding when emotions rise (e.g., "take a slow breath in… hold… and exhale gently").
- You are NOT a doctor, lawyer, or crisis responder. Do not give medical, diagnostic, or legal advice.

SAFETY:
If the user expresses self-harm, danger, or abuse:
"If you’re in immediate danger in Hong Kong, please dial 999 (SMS 992 for speech/hearing) or contact The Samaritans 24-hr 2389 2222 / 2389 2223. You’re not alone."

After emotional topics, always add:
"We can slow down or stop at any time."

KNOWLEDGE:
- Use the retrieved documents to answer about Dimple Bindra, her work, classes, and offerings.
- Blend the information into a natural explanation without technical markers or [doc] citations.
    `.trim();

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMsg },
      ],
      data_sources: [
        {
          type: "azure_search",
          parameters: {
            endpoint: SEARCH_ENDPOINT,
            index_name: SEARCH_INDEX,
            authentication: {
              type: "api_key",
              key: SEARCH_KEY,
            },
            // tidak ada "citations" di sini
          },
        },
      ],
      max_tokens: 900,
      temperature: 0.7,
    };

    const aiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      const errorText = await aiRes.text();
      console.error("Azure Error:", aiRes.status, errorText);
      return res
        .status(500)
        .json({ reply: `Azure error: ${aiRes.status} – ${errorText}` });
    }

    const data = await aiRes.json();
    const reply =
      data?.choices?.[0]?.message?.content || "No reply from model.";

    res.json({ reply });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ reply: "Server error." });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
console.log(`HOOR backend running on PORT ${PORT}`);
app.listen(PORT);
