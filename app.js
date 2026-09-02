let API_URL = localStorage.getItem("ttt_sheets_api_url") || "https://script.google.com/macros/s/AKfycbxrEnKr-9d5d_DNvjLGqTbWkVMWuJTNgAr2-QSmcSQcPmQwYOI_n6lEnmY5cebSvR90jQ/exec";
let pollInterval = Number(localStorage.getItem("ttt_poll_interval") ?? 0);
let showBacklog = localStorage.getItem("ttt_show_backlog") === "true";

let data = {
  students: [],
  mentors: [],
  tasks: []
};

let activeTaskId = null;
let pendingAssignees = [];
let pendingMentor = null;
let pendingBlockTaskId = null;
let suppressCardClick = false;
let pollTimer = null;

// Touch Drag System
let activeDragCard = null;
let touchClone = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let isDraggingActive = false;

function setSyncStatus(state, msg) {
  const dot = document.getElementById("syncDot");
  const txt = document.getElementById("saveStatus");
  dot.className = "dot " + (state === "syncing" ? "syncing" : state === "error" ? "error" : "");
  txt.textContent = msg;
}

// Instant trigger for low-latency touch response
function bindInstantTap(elId, fn) {
  const el = document.getElementById(elId);
  if (!el) return;

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, { passive: false });
}

// Reliable Fullscreen Toggle across Android Chrome & WebViews
function toggleFullscreen() {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  
  if (!isFull) {
    const root = document.documentElement;
    if (root.requestFullscreen) {
      root.requestFullscreen().catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenBtn() {
  const btn = document.getElementById("fullscreenBtn");
  if (!btn) return;
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  btn.innerHTML = isFull 
    ? `🗗 <span class="hide-small">Exit</span>` 
    : `⛶ <span class="hide-small">Fullscreen</span>`;
}

document.addEventListener("fullscreenchange", updateFullscreenBtn);
document.addEventListener("webkitfullscreenchange", updateFullscreenBtn);

function toggleBacklog() {
  showBacklog = !showBacklog;
  localStorage.setItem("ttt_show_backlog", String(showBacklog));
  updateBacklogBtn();
  render();
}

function updateBacklogBtn() {
  const btn = document.getElementById("toggleBacklogBtn");
  if (btn) {
    const textSpan = btn.querySelector(".btn-text");
    if (textSpan) {
      textSpan.textContent = showBacklog ? "📂 Backlog" : "📁 Backlog";
    } else {
      btn.textContent = showBacklog ? "📂 Backlog" : "📁 Backlog";
    }
  }
}

function hideLoader() {
  const loader = document.getElementById("boardLoader");
  if (loader) loader.classList.add("hidden");
}

function sortTasks(taskList) {
  const prioWeight = { high: 0, medium: 1, low: 2 };
  return [...taskList].sort((a, b) => {
    if (a.due && b.due) {
      const cmp = a.due.localeCompare(b.due);
      if (cmp !== 0) return cmp;
    } else if (a.due && !b.due) {
      return -1;
    } else if (!a.due && b.due) {
      return 1;
    }
    const pA = prioWeight[a.priority] ?? 1;
    const pB = prioWeight[b.priority] ?? 1;
    return pA - pB;
  });
}

async function fetchTasksFromSheets(isManual = false) {
  if (!API_URL || API_URL.includes("YOUR_APPS_SCRIPT")) {
    setSyncStatus("error", "Add Google Apps Script URL in Settings (⚙)");
    hideLoader();
    return;
  }
  const btn = document.getElementById("refreshBtn");
  if (isManual && btn) btn.classList.add("spinning");
  setSyncStatus("syncing", "Fetching latest tasks...");

  try {
    const res = await fetch(API_URL);
    const json = await res.json();
    if (json.tasks) data.tasks = json.tasks;
    if (json.students) data.students = json.students;
    if (json.mentors) data.mentors = json.mentors;
    render();
    setSyncStatus("ok", "Live with Sheets • " + new Date().toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}));
  } catch (err) {
    console.error("Fetch failed:", err);
    setSyncStatus("error", "Sync failed • Check connection");
  } finally {
    if (btn) btn.classList.remove("spinning");
    hideLoader();
  }
}

function manualRefresh() {
  fetchTasksFromSheets(true);
}

function resetPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  if (pollInterval > 0) {
    pollTimer = setInterval(() => fetchTasksFromSheets(false), pollInterval);
  }
}

async function syncToSheets(action, taskOrId) {
  if (!API_URL || API_URL.includes("YOUR_APPS_SCRIPT")) return;
  setSyncStatus("syncing", "Saving change...");
  const payload = action === "delete" ? { action: "delete", id: taskOrId } : { action: action, task: taskOrId };
  try {
    await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setSyncStatus("ok", "Saved to Sheets • " + new Date().toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}));
  } catch(err) {
    console.error("Sheets update failed:", err);
    setSyncStatus("error", "Error pushing update to Sheet");
  }
}

function render() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  
  const allCols = [
    ["backlog", "BACKLOG"],
    ["todo", "TO DO"],
    ["progress", "IN PROGRESS"],
    ["blocked", "BLOCKED"],
    ["done", "DONE"]
  ];
  
  const visibleCols = showBacklog ? allCols : allCols.filter(([status]) => status !== "backlog");
  board.style.gridTemplateColumns = `repeat(${visibleCols.length}, minmax(260px, 1fr))`;

  visibleCols.forEach(([status, label]) => {
    const col = document.createElement("section");
    col.className = "column";
    col.dataset.status = status;
    
    const rawTasks = data.tasks.filter(t => t.status === status);
    const tasks = sortTasks(rawTasks);

    col.innerHTML = `
      <div class="column-head">
        <div class="column-title">${label}</div>
        <div class="count">${tasks.length}</div>
      </div>
      <div class="dropzone" data-status="${status}">
        ${tasks.length ? "" : '<div class="empty">Drop tasks here</div>'}
      </div>`;
    board.appendChild(col);

    const zone = col.querySelector(".dropzone");
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
      e.preventDefault(); zone.classList.remove("dragover");
      const id = Number(e.dataTransfer.getData("text/plain"));
      moveTask(id, status);
    });

    tasks.forEach(task => zone.appendChild(makeCard(task)));
  });
}

function makeCard(task) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.id = task.id;
  el.dataset.priority = task.priority;
  el.dataset.status = task.status;
  
  const due = task.due ? `<span class="pill">Due ${formatDate(task.due)}</span>` : "";
  const person = task.assignee 
    ? `<div class="assignee-line">👤 ${escapeHtml(task.assignee)}</div>` 
    : `<div class="assignee-line" style="color:#8b929e">👤 Unassigned</div>`;
  const mentor = task.mentor ? `<div class="mentor-line">🎓 Mentor: ${escapeHtml(task.mentor)}</div>` : "";
  const blockedTag = (task.status === "blocked" && task.blockedBy) 
    ? `<div class="blocked-by-tag">⛔ Waiting on: ${escapeHtml(task.blockedBy)}</div>` 
    : "";

  el.innerHTML = `
    <div class="drag-strip" title="Hold & drag to move">
      <div class="drag-strip-dots">
        <span class="drag-dot"></span>
        <span class="drag-dot"></span>
        <span class="drag-dot"></span>
      </div>
    </div>
    <div class="card-content">
      <div class="card-top">
        <div class="card-title">${escapeHtml(task.title)}</div>
        <button class="edit-btn" title="Edit details">✏️</button>
      </div>
      ${task.desc ? `<div class="card-desc">${escapeHtml(task.desc)}</div>` : ""}
      <div class="meta">
        <span class="pill">${escapeHtml(task.category)}</span>
        <span class="pill priority ${task.priority}">${task.priority.toUpperCase()}</span>${due}