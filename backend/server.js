import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ ENV SETUP ============
const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const MODEL = process.env.AZURE_OPENAI_MODEL || "awakening-assistant";
const API_KEY = process.env.AZURE_OPENAI_API_KEY;

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT;
const SEARCH_KEY = process.env.AZURE_SEARCH_KEY;
const SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX;

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// partner allowlist: comma-separated
// example: PARTNER_CODES="HK_CORP_001,HK_NGO_002"
const PARTNER_CODES = new Set(
  String(process.env.PARTNER_CODES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// warnings
if (!ENDPOINT || !API_KEY || !MODEL) console.warn("⚠️ Missing Azure OpenAI env vars");
if (!SEARCH_ENDPOINT || !SEARCH_KEY || !SEARCH_INDEX) console.warn("⚠️ Missing Azure Search env vars");
if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) console.warn("⚠️ Missing MySQL env vars");

// ============ MYSQL POOL ============
const dbPool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MYSQL_USER,            // Azure: harus format "hooradmin@hoor-mysql"
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,

  // ✅ Azure MySQL Flexible Server biasanya require SSL
  ssl: {
    rejectUnauthorized: false, // dev-friendly (nanti production bisa pakai CA cert)
  },

  waitForConnections: true,
  connectionLimit: 5,
});

function sanitizePartnerCode(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  return /^[A-Za-z0-9_-]{2,80}$/.test(v) ? v : "";
}

// ✅ STRICT partner validation for /p/:partner_code route
function isValidPartnerCode(code) {
  if (!code) return false;
  if (code === "DIRECT") return false;
  if (PARTNER_CODES.size === 0) return false; // strict: no allowlist => no partner links
  return PARTNER_CODES.has(code);
}

function normalizePartnerCode(input) {
  const code = sanitizePartnerCode(input);
  if (!code) return "DIRECT";
  if (code === "DIRECT") return "DIRECT";
  if (PARTNER_CODES.size === 0) {
    // If no allowlist configured, accept sanitized partner codes (MVP)
    return code;
  }
  return PARTNER_CODES.has(code) ? code : "DIRECT";
}

function accessTypeFromPartner(partner_code) {
  return partner_code !== "DIRECT" ? "partner" : "direct";
}

// init mysql (connect + create table)
async function initMySQL() {
  try {
    const conn = await dbPool.getConnection();
    console.log("✅ MySQL connected");
    conn.release();

    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        partner_code VARCHAR(100) NOT NULL,
        access_type VARCHAR(20) NOT NULL DEFAULT 'direct',
        anonymous_user_id VARCHAR(100) NOT NULL,
        session_id VARCHAR(100) NOT NULL,
        timestamp DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_partner_time (partner_code, timestamp),
        INDEX idx_access_type (access_type),
        INDEX idx_user_time (anonymous_user_id, timestamp),
        INDEX idx_event_type (event_type)
      )
    `);

    console.log("✅ MySQL table ready: events");
  } catch (err) {
    console.error("❌ MySQL init failed:", err.message);
  }
}
initMySQL();

// ============ EXPRESS APP ============
const app = express();

// Same-origin is enough for HOOR since you serve frontend from this server.
// Keep cors minimal for local dev.
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// ============ STATIC FRONTEND ============
app.use(express.static(path.join(__dirname, "frontend")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "frontend", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "frontend", "admin.html")));

// ✅ STRICT: invalid partner_code => 404 Not Found
app.get("/p/:partner_code", (req, res) => {
  const code = sanitizePartnerCode(req.params.partner_code);

  if (!isValidPartnerCode(code)) {
    return res.status(404).send("Not Found");
  }

  return res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ==============================
// Simple rate limiting (in-memory)
// ==============================
const buckets = new Map();
// key -> { tokens, last }
function allow(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key) || { tokens: limit, last: now };

  const elapsed = now - entry.last;
  if (elapsed > windowMs) {
    entry.tokens = limit;
    entry.last = now;
  }

  if (entry.tokens <= 0) {
    buckets.set(key, entry);
    return false;
  }

  entry.tokens -= 1;
  buckets.set(key, entry);
  return true;
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// ==============================
// DB insert: message_sent only
// ==============================
async function insertMessageSent({ partner_code, anonymous_user_id, session_id, timestamp }) {
  const safePartnerCode = normalizePartnerCode(partner_code);
  const safeAccessType = accessTypeFromPartner(safePartnerCode);
  const ts = timestamp ? new Date(timestamp) : new Date();

  await dbPool.execute(
    `INSERT INTO events (event_type, partner_code, access_type, anonymous_user_id, session_id, timestamp)
     VALUES ('message_sent', ?, ?, ?, ?, ?)`,
    [safePartnerCode, safeAccessType, String(anonymous_user_id || ""), String(session_id || ""), ts]
  );
}

// ==============================
// ADMIN AUTH MIDDLEWARE
// ==============================
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // local dev allow when empty

  const token =
    req.headers["x-admin-token"] ||
    req.query.token ||
    req.body?.token ||
    "";

  if (String(token) !== String(ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ==============================
// ADMIN SUMMARY
// GET /api/admin/summary?partner_code=&date_from=&date_to=&access_type=partner|direct
// ==============================
app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  try {
    const partnerCode = String(req.query.partner_code || "").trim();
    const accessType = String(req.query.access_type || "").trim();
    const dateFrom = String(req.query.date_from || "").trim(); // YYYY-MM-DD
    const dateTo = String(req.query.date_to || "").trim();     // YYYY-MM-DD
    const anchorDate = dateTo ? dateTo : null;

    const where = ["event_type = 'message_sent'"];
    const params = [];

    if (partnerCode) { where.push("partner_code = ?"); params.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { where.push("access_type = ?"); params.push(accessType); }
    if (dateFrom) { where.push("DATE(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("DATE(timestamp) <= ?"); params.push(dateTo); }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await dbPool.execute(
      `
      SELECT
        partner_code AS partner,
        access_type AS access_type,
        COUNT(DISTINCT anonymous_user_id) AS total_users,
        COUNT(*) AS message_volume,
        MAX(timestamp) AS last_event
      FROM events
      ${whereSql}
      GROUP BY partner_code, access_type
      ORDER BY last_event DESC
      `,
      params
    );

    const [overall] = await dbPool.execute(
      `
      SELECT
        COUNT(DISTINCT anonymous_user_id) AS total_users,
        COUNT(*) AS message_volume
      FROM events
      ${whereSql}
      `,
      params
    );

    // DAU
    const dauParams = [];
    let dauWhere =
      "event_type = 'message_sent' AND DATE(timestamp) = DATE(" + (anchorDate ? "?" : "NOW()") + ")";
    if (anchorDate) dauParams.push(anchorDate);
    if (partnerCode) { dauWhere += " AND partner_code = ?"; dauParams.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { dauWhere += " AND access_type = ?"; dauParams.push(accessType); }

    const [dauRes] = await dbPool.execute(
      `SELECT COUNT(DISTINCT anonymous_user_id) AS dau FROM events WHERE ${dauWhere}`,
      dauParams
    );

    // WAU
    const wauParams = [];
    let wauWhere =
      "event_type = 'message_sent' AND DATE(timestamp) >= DATE(" + (anchorDate ? "?" : "NOW()") + " - INTERVAL 6 DAY)" +
      " AND DATE(timestamp) <= DATE(" + (anchorDate ? "?" : "NOW()") + ")";
    if (anchorDate) wauParams.push(anchorDate, anchorDate);
    if (partnerCode) { wauWhere += " AND partner_code = ?"; wauParams.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { wauWhere += " AND access_type = ?"; wauParams.push(accessType); }

    const [wauRes] = await dbPool.execute(
      `SELECT COUNT(DISTINCT anonymous_user_id) AS wau FROM events WHERE ${wauWhere}`,
      wauParams
    );

    // Per partner DAU/WAU
    const dauByParams = [];
    let dauByWhere =
      "event_type = 'message_sent' AND DATE(timestamp) = DATE(" + (anchorDate ? "?" : "NOW()") + ")";
    if (anchorDate) dauByParams.push(anchorDate);
    if (partnerCode) { dauByWhere += " AND partner_code = ?"; dauByParams.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { dauByWhere += " AND access_type = ?"; dauByParams.push(accessType); }

    const [dauByGroup] = await dbPool.execute(
      `
      SELECT partner_code AS partner, access_type AS access_type, COUNT(DISTINCT anonymous_user_id) AS dau
      FROM events
      WHERE ${dauByWhere}
      GROUP BY partner_code, access_type
      `,
      dauByParams
    );

    const wauByParams = [];
    let wauByWhere =
      "event_type = 'message_sent' AND DATE(timestamp) >= DATE(" + (anchorDate ? "?" : "NOW()") + " - INTERVAL 6 DAY)" +
      " AND DATE(timestamp) <= DATE(" + (anchorDate ? "?" : "NOW()") + ")";
    if (anchorDate) wauByParams.push(anchorDate, anchorDate);
    if (partnerCode) { wauByWhere += " AND partner_code = ?"; wauByParams.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { wauByWhere += " AND access_type = ?"; wauByParams.push(accessType); }

    const [wauByGroup] = await dbPool.execute(
      `
      SELECT partner_code AS partner, access_type AS access_type, COUNT(DISTINCT anonymous_user_id) AS wau
      FROM events
      WHERE ${wauByWhere}
      GROUP BY partner_code, access_type
      `,
      wauByParams
    );

    const keyOf = (p, a) => `${p}__${a}`;
    const dauMap = new Map(dauByGroup.map(r => [keyOf(r.partner, r.access_type), Number(r.dau)]));
    const wauMap = new Map(wauByGroup.map(r => [keyOf(r.partner, r.access_type), Number(r.wau)]));

    const summary = rows.map(r => ({
      partner: r.partner,
      access_type: r.access_type,
      total_users: Number(r.total_users || 0),
      dau: Number(dauMap.get(keyOf(r.partner, r.access_type)) || 0),
      wau: Number(wauMap.get(keyOf(r.partner, r.access_type)) || 0),
      message_volume: Number(r.message_volume || 0),
      last_event: r.last_event
    }));

    return res.json({
      ok: true,
      filters: {
        partner_code: partnerCode || null,
        access_type: accessType || null,
        date_from: dateFrom || null,
        date_to: dateTo || null
      },
      cards: {
        total_users: Number(overall?.[0]?.total_users || 0),
        dau: Number(dauRes?.[0]?.dau || 0),
        wau: Number(wauRes?.[0]?.wau || 0),
        message_volume: Number(overall?.[0]?.message_volume || 0),
      },
      summary
    });
  } catch (err) {
    console.error("ADMIN SUMMARY ERROR:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ==============================
// ADMIN TIMESERIES (for charts)
// GET /api/admin/timeseries?partner_code=&access_type=&date_from=&date_to=
// returns: [{day, dau, messages}]
// ==============================
app.get("/api/admin/timeseries", requireAdmin, async (req, res) => {
  try {
    const partnerCode = String(req.query.partner_code || "").trim();
    const accessType = String(req.query.access_type || "").trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();

    const where = ["event_type = 'message_sent'"];
    const params = [];

    if (partnerCode) { where.push("partner_code = ?"); params.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { where.push("access_type = ?"); params.push(accessType); }
    if (dateFrom) { where.push("DATE(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("DATE(timestamp) <= ?"); params.push(dateTo); }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await dbPool.execute(
      `
      SELECT
        DATE(timestamp) AS day,
        COUNT(*) AS messages,
        COUNT(DISTINCT anonymous_user_id) AS dau
      FROM events
      ${whereSql}
      GROUP BY DATE(timestamp)
      ORDER BY day ASC
      `,
      params
    );

    const timeseries = rows.map(r => ({
      day: r.day ? new Date(r.day).toISOString().slice(5, 10) : "",
      messages: Number(r.messages || 0),
      dau: Number(r.dau || 0),
    }));

    return res.json({ ok: true, timeseries });
  } catch (err) {
    console.error("ADMIN TIMESERIES ERROR:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ==============================
// ADMIN USERS (anonymous drilldown)
// GET /api/admin/users?partner_code=&access_type=&date_from=&date_to=
// ==============================
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const partnerCode = String(req.query.partner_code || "").trim();
    const accessType = String(req.query.access_type || "").trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();

    const where = ["event_type = 'message_sent'"];
    const params = [];

    if (partnerCode) { where.push("partner_code = ?"); params.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { where.push("access_type = ?"); params.push(accessType); }
    if (dateFrom) { where.push("DATE(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("DATE(timestamp) <= ?"); params.push(dateTo); }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await dbPool.execute(
      `
      SELECT
        anonymous_user_id,
        partner_code,
        access_type,
        COUNT(*) AS messages_sent,
        MIN(timestamp) AS first_seen,
        MAX(timestamp) AS last_seen,
        COUNT(DISTINCT DATE(timestamp)) AS active_days
      FROM events
      ${whereSql}
      GROUP BY anonymous_user_id, partner_code, access_type
      ORDER BY last_seen DESC
      LIMIT 200
      `,
      params
    );

    const users = rows.map(r => ({
      anonymous_user_id: r.anonymous_user_id,
      partner_code: r.partner_code,
      access_type: r.access_type,
      messages_sent: Number(r.messages_sent || 0),
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      active_days: Number(r.active_days || 0),
    }));

    return res.json({ ok: true, users });
  } catch (err) {
    console.error("ADMIN USERS ERROR:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ==============================
// ADMIN EXPORT CSV (download)
// ==============================
app.get("/api/admin/export", requireAdmin, async (req, res) => {
  try {
    const partnerCode = String(req.query.partner_code || "").trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    const accessType = String(req.query.access_type || "").trim();

    const where = [];
    const params = [];

    if (partnerCode) { where.push("partner_code = ?"); params.push(normalizePartnerCode(partnerCode)); }
    if (accessType) { where.push("access_type = ?"); params.push(accessType); }
    if (dateFrom) { where.push("DATE(timestamp) >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("DATE(timestamp) <= ?"); params.push(dateTo); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await dbPool.execute(
      `
      SELECT
        partner_code AS partner,
        access_type AS access_type,
        COUNT(DISTINCT anonymous_user_id) AS total_users,
        SUM(event_type = 'message_sent') AS message_volume,
        MAX(timestamp) AS last_event
      FROM events
      ${whereSql}
      GROUP BY partner_code, access_type
      ORDER BY last_event DESC
      `,
      params
    );

    const header = "partner,access_type,total_users,message_volume,last_event\n";
    const lines = rows.map(r => {
      const partner = String(r.partner || "").replaceAll('"', '""');
      const at = String(r.access_type || "").replaceAll('"', '""');
      const total = Number(r.total_users || 0);
      const msg = Number(r.message_volume || 0);
      const last = r.last_event ? new Date(r.last_event).toISOString() : "";
      return `"${partner}","${at}",${total},${msg},"${last}"`;
    });

    const csv = header + lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hoor_partner_report.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error("ADMIN EXPORT ERROR:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ============ CHAT ROUTE ============
// Server-side KPI logging (message_sent only)
app.post("/api/chat", async (req, res) => {
  try {
    const ip = clientIp(req);
    // rate limit: 30 chats / minute per IP
    if (!allow(`chat_ip:${ip}`, 30, 60_000)) {
      return res.status(429).json({ reply: "Too many requests. Please slow down." });
    }

    const rawUserMsg = String(req.body?.message || "");
    const anonymous_user_id = String(req.body?.anonymous_user_id || "");
    const session_id = String(req.body?.session_id || "");
    const partner_code = normalizePartnerCode(req.body?.partner_code || "DIRECT");

    if (!rawUserMsg || !anonymous_user_id || !session_id) {
      return res.status(400).json({ reply: "Bad request." });
    }

    // Rate limit per user too: 20 messages/min
    if (!allow(`chat_user:${anonymous_user_id}`, 20, 60_000)) {
      return res.status(429).json({ reply: "Too many messages. Please slow down." });
    }

    // ✅ Log message_sent on server (only once per message)
    await insertMessageSent({
      partner_code,
      anonymous_user_id,
      session_id,
      timestamp: new Date().toISOString(),
    });

    const EVENT_TYPE = "chat_started";

    console.log("────────────────────────────────");
    console.log("📩 EVENT TYPE :", EVENT_TYPE);
    console.log("partner       :", partner_code);
    console.log("access_type   :", accessTypeFromPartner(partner_code));
    console.log("user_id       :", anonymous_user_id);
    console.log("session_id    :", session_id);
    console.log("timestamp     :", new Date().toISOString());
    console.log("────────────────────────────────");

    // ✅ Do NOT force context (no more Dimple-only framing)
    const userMsg = rawUserMsg;

    const apiVersion = "2025-01-01-preview";
    const url = `${ENDPOINT}/openai/deployments/${MODEL}/chat/completions?api-version=${apiVersion}`;

    const systemMessage = `
You are HOOR, a gentle, trauma-informed emotional companion for women.
Your primary role is to create safety, trust, and emotional grounding — not to sell.

LANGUAGE:
- Always respond in the SAME language the user is using.
- If the user mixes languages (English, Indonesian, Cantonese, slang), respond naturally in the same mix, but softer and clearer.
- Do NOT show citations like [doc1], [doc2], or any document/file names.

STYLE & TONE:
- Speak softly, warmly, and human — like a calm, caring presence.
- Keep responses short: 1–3 small paragraphs.
- Start with emotional validation when the user shares something personal.
- Reflect what she is feeling before offering any suggestion.
- Offer simple grounding only when emotions feel intense.
- Avoid sounding instructional, promotional, or authoritative.
- Never rush the conversation toward solutions or programs.

OPENING RULE (VERY IMPORTANT):
- When the user says “hi”, “hello”, or opens the chat, do NOT mention Dimple Bindra, work, programs, or offerings.
- The first response must focus only on welcoming the user into a safe, personal space.
- Treat the first message as emotional orientation, not an information request.
- Never assume the user wants to know about Dimple unless she explicitly asks.

ROLE BOUNDARIES:
- You are NOT a doctor, lawyer, therapist, or crisis investigator.
- Do not give medical, diagnostic, or legal advice.
- Do not interrogate or push the user to share more than she wants.
- Do not pressure the user to take action.

SAFETY (HK – EXACT TEXT):
If the user expresses self-harm, danger, or abuse, respond with this exact wording:
"If you’re in immediate danger in Hong Kong, please dial 999 (SMS 992 for speech/hearing) or contact The Samaritans 24-hr at 2389 2222 / 2389 2223. You’re not alone. Please reach out to someone who can help you right away."
After emotional or intense topics, gently remind:
"We can slow down or stop at any time."

TRUST-FIRST RULE:
- Do NOT mention Dimple Bindra, programs, classes, offerings, or services unless:
  1) The user explicitly asks about them, OR
  2) The user asks for next steps or deeper support.
- In emotional conversations, keep the focus entirely on the user.

WHEN ASKED ABOUT DIMPLE OR PROGRAMS:
- Answer clearly, briefly, and without marketing language.
- Keep it optional and calm.
- Use phrases like: “If it feels right for you…” or “Only if you want to explore further…”

GOAL:
- Help the user feel heard, grounded, and safe.
- Trust comes first. Guidance comes second. Recommendations come last — and only when invited.
`.trim();

    // ---- fallback helpers (scoped here; no other code touched) ----
    function looksBad(reply) {
      const t = String(reply || "").toLowerCase();
      return (
        !t ||
        t.includes("not found") ||
        t.includes("no information") ||
        t.includes("i don't know") ||
        t.includes("cannot find") ||
        t.includes("unable to find")
      );
    }

    async function callAzure(useSearch) {
      const payload = {
        model: MODEL,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMsg },
        ],
        max_tokens: 900,
        temperature: 0.7,
      };

      if (useSearch) {
        payload.data_sources = [
          {
            type: "azure_search",
            parameters: {
              endpoint: SEARCH_ENDPOINT,
              index_name: SEARCH_INDEX,
              authentication: { type: "api_key", key: SEARCH_KEY },
            },
          },
        ];
      }

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
        throw new Error(errorText);
      }

      const data = await aiRes.json();
      return data?.choices?.[0]?.message?.content || "";
    }

    // 1) Try with Azure Search (RAG)
    let reply = "";
    try {
      reply = await callAzure(true);
    } catch (e) {
      console.error("Azure RAG Error:", e.message);
    }

    // 2) Fallback to chat-only (no search)
    if (looksBad(reply)) {
      try {
        reply = await callAzure(false);
      } catch (e) {
        console.error("Azure Fallback Error:", e.message);
      }
    }

    if (!reply) reply = "I’m here with you. What’s coming up for you right now?";

    return res.json({ reply });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ reply: "Server error." });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HOOR backend running on PORT ${PORT}`);
});

process.on("SIGINT", async () => {
  try { await dbPool.end(); } catch {}
  process.exit(0);
});
