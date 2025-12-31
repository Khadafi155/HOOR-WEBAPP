const API_URL = "/api/chat";

const form = document.getElementById("hoorForm");
const input = document.getElementById("hoorInput");
const chatContainer = document.getElementById("hoorChatContainer");
const sendBtn = document.querySelector(".hoor-send-btn");

// Quick exit
const quickExitBtn = document.getElementById("hoorQuickExitBtn");
const backToChatBtn = document.getElementById("hoorBackToChatBtn");
const notesView = document.getElementById("hoorNotesView");
const chatView = document.querySelector(".hoor-view-chat");

// ==============================
// Partner detection (Direct vs Partner)
// ==============================
function sanitizePartnerCode(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  return /^[A-Za-z0-9_-]{2,80}$/.test(v) ? v : "";
}

function getPartnerCodeFromUrl() {
  // support /p/HK_CORP_001
  const parts = window.location.pathname.split("/").filter(Boolean);
  const pIndex = parts.indexOf("p");
  if (pIndex !== -1 && parts[pIndex + 1]) return sanitizePartnerCode(parts[pIndex + 1]);

  // fallback support ?partner=HK_CORP_001
  const url = new URL(window.location.href);
  return sanitizePartnerCode(url.searchParams.get("partner"));
}

// ✅ Persist partner_code so attribution doesn't break across sessions
const PARTNER_STORAGE_KEY = "hoor_partner_code";

const partnerFromUrl = getPartnerCodeFromUrl();

// If user arrived via /p/:partner_code, store it (server is strict, so this is safe)
if (partnerFromUrl) {
  localStorage.setItem(PARTNER_STORAGE_KEY, partnerFromUrl);
}

const storedPartner = sanitizePartnerCode(localStorage.getItem(PARTNER_STORAGE_KEY));

// final partner_code used for telemetry
const partner_code = partnerFromUrl || storedPartner || "DIRECT";
const access_type = partner_code !== "DIRECT" ? "partner" : "direct";

// ==============================
// Anonymous user + session (crypto-safe)
// ==============================
function cryptoId(prefix) {
  try {
    if (window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    const hex = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${hex}`;
  } catch {
    return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }
}

let anonymous_user_id = localStorage.getItem("anonymous_user_id");
if (!anonymous_user_id) {
  anonymous_user_id = cryptoId("u");
  localStorage.setItem("anonymous_user_id", anonymous_user_id);
}

let session_id = sessionStorage.getItem("session_id");
if (!session_id) {
  session_id = cryptoId("s");
  sessionStorage.setItem("session_id", session_id);
}

// ==============================
// UI helpers
// ==============================
function formatTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
function getTimestamp() {
  return formatTime();
}

function appendMessage(role, text) {
  const msg = document.createElement("div");
  msg.className =
    "hoor-message " +
    (role === "user" ? "hoor-message-user" : "hoor-message-assistant");

  const bubble = document.createElement("div");
  bubble.className = "hoor-message-bubble";

  let safeText = String(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  safeText = safeText.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  safeText = safeText.replace(/—/g, "");
  safeText = safeText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  safeText = safeText.replace(/\*(.+?)\*/g, "<strong>$1</strong>");
  safeText = safeText.replace(/\n/g, "<br>");

  bubble.innerHTML = safeText;

  const meta = document.createElement("div");
  meta.className = "hoor-message-meta";
  meta.textContent = `${role === "user" ? "You" : "Hoor"} · ${getTimestamp()}`;

  msg.appendChild(bubble);
  msg.appendChild(meta);

  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendTyping() {
  const msg = document.createElement("div");
  msg.id = "hoor-typing";
  msg.className = "hoor-message hoor-message-assistant";
  msg.innerHTML = `<div class="hoor-message-bubble">Hoor is thinking...</div>`;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById("hoor-typing");
  if (t) t.remove();
}

// ==============================
// Submit chat
// ==============================
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  appendMessage("user", text);

  input.value = "";
  sendBtn.disabled = true;

  appendTyping();

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        partner_code,
        access_type, // ok to send, server will re-derive
        anonymous_user_id,
        session_id,
      }),
    });

    removeTyping();

    if (!res.ok) {
      appendMessage("assistant", "Sorry, something went wrong. Try again later.");
      sendBtn.disabled = false;
      return;
    }

    const data = await res.json();
    appendMessage("assistant", data.reply || "I'm here with you.");
  } catch (err) {
    removeTyping();
    appendMessage("assistant", "Connection issue. Try again in a moment.");
  }

  sendBtn.disabled = false;
});

// Switching views
quickExitBtn.onclick = () => {
  chatView.style.display = "none";
  notesView.style.display = "flex";
};

backToChatBtn.onclick = () => {
  notesView.style.display = "none";
  chatView.style.display = "flex";
};

document.addEventListener("DOMContentLoaded", () => {
  const firstMeta = chatContainer.querySelector(
    ".hoor-message-assistant .hoor-message-meta"
  );
  if (firstMeta) firstMeta.textContent = `Hoor · ${getTimestamp()}`;
});
