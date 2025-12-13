const API_URL = "http://localhost:3000/api/chat"; 
// Ganti ke: https://awakening-assistant.azurewebsites.net/api/chat saat live

const form = document.getElementById("hoorForm");
const input = document.getElementById("hoorInput");
const chatContainer = document.getElementById("hoorChatContainer");
const sendBtn = document.querySelector(".hoor-send-btn");

// Quick exit
const quickExitBtn = document.getElementById("hoorQuickExitBtn");
const backToChatBtn = document.getElementById("hoorBackToChatBtn");
const notesView = document.getElementById("hoorNotesView");
const chatView = document.querySelector(".hoor-view-chat");

function formatTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

// NEW: message timestamp generator
function getTimestamp() {
  const now = new Date();
  const today = new Date();

  if (now.toDateString() === today.toDateString()) {
    return formatTime();
  }

  // FIX: supaya tidak return undefined
  return formatTime();
}

function appendMessage(role, text) {
  const msg = document.createElement("div");
  msg.className =
    "hoor-message " +
    (role === "user" ? "hoor-message-user" : "hoor-message-assistant");

  const bubble = document.createElement("div");
  bubble.className = "hoor-message-bubble";

  // ---------- FORMATTER ----------
  // 0. escape < >
  let safeText = text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 1. Markdown link: [label](https://url)
  safeText = safeText.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 2. Hapus em-dash (—) biar nggak ganggu
  safeText = safeText.replace(/—/g, "");

  // 3. **bold**  → <strong>
  safeText = safeText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // 4. *italic* (single star) → juga <strong>
  safeText = safeText.replace(/\*(.+?)\*/g, "<strong>$1</strong>");

  // 5. newline → <br>
  safeText = safeText.replace(/\n/g, "<br>");

  bubble.innerHTML = safeText;
  // ---------- END FORMATTER ----------

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
  msg.innerHTML = `
    <div class="hoor-message-bubble">Hoor is thinking...</div>
  `;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById("hoor-typing");
  if (t) t.remove();
}

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
      body: JSON.stringify({ message: text })
    });

    removeTyping();

    if (!res.ok) {
      appendMessage("assistant", "Sorry, something went wrong. Try again later.");
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

// Update timestamp untuk pesan pembuka yang statis di HTML
document.addEventListener("DOMContentLoaded", () => {
  const firstMeta = chatContainer.querySelector(
    ".hoor-message-assistant .hoor-message-meta"
  );
  if (firstMeta) {
    firstMeta.textContent = `Hoor · ${getTimestamp()}`;
  }
});