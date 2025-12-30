const API_BASE = "/api/admin";

// Elements
const enterKeyBtn = document.getElementById("enterKeyBtn");
const applyFilterBtn = document.getElementById("applyFilterBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");

const accessTypeSelect = document.getElementById("accessType");
const dateFromInput = document.getElementById("dateFrom");
const dateToInput = document.getElementById("dateTo");
const tokenInput = document.getElementById("adminToken");

const totalUsersEl = document.getElementById("statTotalUsers");
const dauEl = document.getElementById("statDAU");
const wauEl = document.getElementById("statWAU");
const messagesEl = document.getElementById("statMessages");

const summaryBody = document.getElementById("summaryBody");
const usersBody = document.getElementById("usersBody");

const chartDAU = document.getElementById("chartDAU");
const chartMessages = document.getElementById("chartMessages");

// Pagination controls
const summaryPrev = document.getElementById("summaryPrev");
const summaryNext = document.getElementById("summaryNext");
const summaryPageInfo = document.getElementById("summaryPageInfo");

const usersPrev = document.getElementById("usersPrev");
const usersNext = document.getElementById("usersNext");
const usersPageInfo = document.getElementById("usersPageInfo");

// State
const PAGE_SIZE = 10;
let summaryAll = [];
let usersAll = [];
let summaryPage = 1;
let usersPage = 1;

// --------------------
// Params / Auth
// --------------------
function buildParams() {
  const params = new URLSearchParams();

  const accessType = accessTypeSelect?.value?.trim();
  if (accessType) params.append("access_type", accessType);

  if (dateFromInput?.value) params.append("date_from", dateFromInput.value);
  if (dateToInput?.value) params.append("date_to", dateToInput.value);

  const token = tokenInput?.value?.trim();
  if (token) params.append("token", token);

  return params;
}

function authHeaders() {
  const headers = {};
  const token = tokenInput?.value?.trim();
  if (token) headers["x-admin-token"] = token;
  return headers;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setLoading(isLoading) {
  const btn = applyFilterBtn; // loading state di tombol filter
  if (!btn) return;

  btn.disabled = !!isLoading;
  btn.innerHTML = isLoading
    ? `<span class="btn-icon" aria-hidden="true">
         <svg viewBox="0 0 24 24" width="16" height="16">
           <path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6a6 6 0 0 1-6 6 6 6 0 0 1-5.65-4H4.26A8 8 0 0 0 12 20a8 8 0 0 0 0-16Z"/>
         </svg>
       </span>Loading…`
    : `<span class="btn-icon" aria-hidden="true">
         <svg viewBox="0 0 24 24" width="16" height="16">
           <path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4Z"/>
         </svg>
       </span>Apply Filter`;
}

// --------------------
// Helpers
// --------------------
function mapAccessLabel(accessType) {
  if (accessType === "direct") return "General";
  if (accessType === "partner") return "Partner";
  return accessType || "—";
}

function mapCodeLabel(code) {
  if (!code) return "General";
  return code === "DIRECT" ? "General" : code;
}

function paginate(arr, page, pageSize) {
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    pages,
    total,
    slice: arr.slice(start, start + pageSize),
  };
}

// --------------------
// Render stats
// --------------------
function renderStats(cards) {
  totalUsersEl.textContent = cards.total_users ?? "—";
  dauEl.textContent = cards.dau ?? "—";
  wauEl.textContent = cards.wau ?? "—";
  messagesEl.textContent = cards.message_volume ?? "—";
}

// --------------------
// Render User Summary + pagination
// --------------------
function renderSummaryPage() {
  const p = paginate(summaryAll, summaryPage, PAGE_SIZE);
  summaryPage = p.page;

  summaryBody.innerHTML = "";

  if (!p.total) {
    summaryBody.innerHTML = `
      <tr><td colspan="7" class="admin-muted">No data yet. Click “Apply Filter”.</td></tr>
    `;
    summaryPrev.disabled = true;
    summaryNext.disabled = true;
    summaryPageInfo.textContent = "Page 1 / 1";
    return;
  }

  p.slice.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(mapCodeLabel(row.partner))}</td>
      <td>${escapeHtml(mapAccessLabel(row.access_type))}</td>
      <td>${Number(row.total_users ?? 0)}</td>
      <td>${Number(row.dau ?? 0)}</td>
      <td>${Number(row.wau ?? 0)}</td>
      <td>${Number(row.message_volume ?? 0)}</td>
      <td>${row.last_event ? new Date(row.last_event).toLocaleString() : "—"}</td>
    `;
    summaryBody.appendChild(tr);
  });

  summaryPrev.disabled = summaryPage <= 1;
  summaryNext.disabled = summaryPage >= p.pages;
  summaryPageInfo.textContent = `Page ${summaryPage} / ${p.pages}`;
}

// --------------------
// Render Users + pagination
// --------------------
function renderUsersPage() {
  const p = paginate(usersAll, usersPage, PAGE_SIZE);
  usersPage = p.page;

  usersBody.innerHTML = "";

  if (!p.total) {
    usersBody.innerHTML = `
      <tr><td colspan="7" class="admin-muted">No data yet. Click “Apply Filter”.</td></tr>
    `;
    usersPrev.disabled = true;
    usersNext.disabled = true;
    usersPageInfo.textContent = "Page 1 / 1";
    return;
  }

  p.slice.forEach((u) => {
    const tr = document.createElement("tr");
    const masked = String(u.anonymous_user_id || "").slice(0, 10) + "…";

    tr.innerHTML = `
      <td>${escapeHtml(masked)}</td>
      <td>${escapeHtml(mapCodeLabel(u.partner_code || "DIRECT"))}</td>
      <td>${escapeHtml(mapAccessLabel(u.access_type || "direct"))}</td>
      <td>${Number(u.messages_sent ?? 0)}</td>
      <td>${u.first_seen ? new Date(u.first_seen).toLocaleString() : "—"}</td>
      <td>${u.last_seen ? new Date(u.last_seen).toLocaleString() : "—"}</td>
      <td>${Number(u.active_days ?? 0)}</td>
    `;
    usersBody.appendChild(tr);
  });

  usersPrev.disabled = usersPage <= 1;
  usersNext.disabled = usersPage >= p.pages;
  usersPageInfo.textContent = `Page ${usersPage} / ${p.pages}`;
}

// --------------------
// Charts (keep style)
// --------------------
function drawLineChart(canvas, labels, values) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const padding = 40;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;

  const maxVal = Math.max(1, ...values.map(v => Number(v || 0)));
  const n = Math.max(1, values.length);

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, padding + h);
  ctx.lineTo(padding + w, padding + h);
  ctx.stroke();

  ctx.fillStyle = "#6b7280";
  ctx.font = "12px system-ui";
  ctx.fillText(String(maxVal), 8, padding + 4);
  ctx.fillText("0", 20, padding + h + 4);

  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 2;
  ctx.beginPath();

  values.forEach((val, i) => {
    const x = padding + (w * (i / Math.max(1, n - 1)));
    const y = padding + h - (h * (Number(val || 0) / maxVal));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#111827";
  values.forEach((val, i) => {
    const x = padding + (w * (i / Math.max(1, n - 1)));
    const y = padding + h - (h * (Number(val || 0) / maxVal));
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  const idxs = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  ctx.fillStyle = "#6b7280";
  idxs.forEach(i => {
    const x = padding + (w * (i / Math.max(1, n - 1)));
    const label = labels[i] || "";
    ctx.fillText(label, Math.max(0, x - 18), padding + h + 22);
  });
}

function renderTimeseries(ts) {
  const labels = (ts || []).map(r => r.day);
  drawLineChart(chartDAU, labels, (ts || []).map(r => r.dau));
  drawLineChart(chartMessages, labels, (ts || []).map(r => r.messages));
}

// --------------------
// Fetch all data
// --------------------
async function fetchAll() {
  const params = buildParams();

  try {
    setLoading(true);

    const res1 = await fetch(`${API_BASE}/summary?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res1.ok) throw new Error("summary failed");
    const data1 = await res1.json();

    renderStats(data1.cards || {});
    summaryAll = Array.isArray(data1.summary) ? data1.summary : [];
    summaryPage = 1;
    renderSummaryPage();

    const res2 = await fetch(`${API_BASE}/timeseries?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res2.ok) throw new Error("timeseries failed");
    const data2 = await res2.json();
    renderTimeseries(data2.timeseries || []);

    const res3 = await fetch(`${API_BASE}/users?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res3.ok) throw new Error("users failed");
    const data3 = await res3.json();
    usersAll = Array.isArray(data3.users) ? data3.users : [];
    usersPage = 1;
    renderUsersPage();

  } catch (err) {
    console.error(err);
    alert("Failed to load dashboard data. Check Key Access (ADMIN_TOKEN) and server logs.");
  } finally {
    setLoading(false);
  }
}

// Export CSV
function exportCSV() {
  const params = buildParams();
  window.location.href = `${API_BASE}/export?${params.toString()}`;
}

// Clear (FILTER ONLY)
function clearAll() {
  if (accessTypeSelect) accessTypeSelect.value = "";
  if (dateFromInput) dateFromInput.value = "";
  if (dateToInput) dateToInput.value = "";
  // tokenInput stays
  // data stays until Apply Filter is clicked
}

// Pagination events
summaryPrev?.addEventListener("click", () => {
  summaryPage = Math.max(1, summaryPage - 1);
  renderSummaryPage();
});
summaryNext?.addEventListener("click", () => {
  summaryPage = summaryPage + 1;
  renderSummaryPage();
});

usersPrev?.addEventListener("click", () => {
  usersPage = Math.max(1, usersPage - 1);
  renderUsersPage();
});
usersNext?.addEventListener("click", () => {
  usersPage = usersPage + 1;
  renderUsersPage();
});

// Buttons
enterKeyBtn?.addEventListener("click", fetchAll);
applyFilterBtn?.addEventListener("click", fetchAll);
exportBtn?.addEventListener("click", exportCSV);
clearBtn?.addEventListener("click", clearAll);

// Enter key on token input
tokenInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fetchAll();
  }
});
