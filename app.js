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

function setSyncStatus(state, msg) {
  const dot = document.getElementById("syncDot");
  const txt = document.getElementById("saveStatus");
  dot.className = "dot " + (state === "syncing" ? "syncing" : state === "error" ? "error" : "");
  txt.textContent = msg;
}

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
      textSpan.textContent = showBacklog ? "📂 Hide Backlog" : "📁 Show Backlog";
    } else {
      btn.textContent = showBacklog ? "📂 Hide Backlog" : "📁 Show Backlog";
    }
  }
}

function hideLoader() {
  const loader = document.getElementById("boardLoader");
  if (loader) {
    loader.classList.add("hidden");
  }
}

// Multi-level column sorting: Due Date (ascending) -> Priority (High -> Med -> Low)
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

// Fetch tasks and people from Google Sheet
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

// Push updates to Google Sheet
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
  
  // Set desktop grid columns (on mobile, CSS flex override handles snap-scrolling)
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
  el.draggable = true;
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
    <div class="card-top">
      <div class="card-title">${escapeHtml(task.title)}</div>
      <button class="edit-btn" title="Edit details">✏️</button>
    </div>
    ${task.desc ? `<div class="card-desc">${escapeHtml(task.desc)}</div>` : ""}
    <div class="meta">
      <span class="pill">${escapeHtml(task.category)}</span>
      <span class="pill priority ${task.priority}">${task.priority.toUpperCase()}</span>
      ${due}
    </div>
    ${blockedTag}
    <div class="people-tags">
      ${person}
      ${mentor}
    </div>`;

  const editBtn = el.querySelector(".edit-btn");
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditModal(task.id);
  });

  el.addEventListener("click", () => {
    if (suppressCardClick) return;
    openAssignment(task.id);
  });

  el.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", String(task.id));
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  
  // Touch / Pointer handling with drag-vs-scroll detection
  let startX = 0, startY = 0, isDragging = false;
  
  el.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse") return;
    startX = e.clientX;
    startY = e.clientY;
    isDragging = false;
  });

  el.addEventListener("pointermove", e => {
    if (e.pointerType === "mouse") return;
    const deltaX = Math.abs(e.clientX - startX);
    const deltaY = Math.abs(e.clientY - startY);

    // If moving predominantly vertically or far enough, treat as drag
    if (deltaX > 25 || deltaY > 25) {
      isDragging = true;
      el.style.opacity = "0.55";
      highlightDrop(e.clientX, e.clientY);
    }
  });

  el.addEventListener("pointerup", e => {
    if (e.pointerType === "mouse") return;
    el.style.opacity = "";
    if (isDragging) {
      suppressCardClick = true;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".dropzone");
      if (target) moveTask(task.id, target.dataset.status);
      setTimeout(() => { suppressCardClick = false; }, 140);
    }
  });

  return el;
}

function highlightDrop(x, y) {
  document.querySelectorAll(".dropzone").forEach(z => z.classList.remove("dragover"));
  const z = document.elementFromPoint(x, y)?.closest(".dropzone");
  if (z) z.classList.add("dragover");
}

function moveTask(id, status) {
  const task = data.tasks.find(t => t.id === id);
  if (!task || task.status === status) { render(); return; }
  
  if (status === "blocked") {
    openBlockerPrompt(id);
    return;
  }

  if (task.status === "blocked" && status !== "blocked") {
    task.blockedBy = "";
  }

  task.status = status;
  render();
  syncToSheets("update", task);
  if (status === "progress" && !task.assignee) openAssignment(id);
}

// Blocker Prompt Modal Handlers
function openBlockerPrompt(id) {
  const task = data.tasks.find(t => t.id === id);
  if (!task) return;
  pendingBlockTaskId = id;

  document.getElementById("blockerTaskSummary").innerHTML = `
    <strong>${escapeHtml(task.title)}</strong>
    <span>${escapeHtml(task.category)} • ${task.priority.toUpperCase()} priority</span>`;

  const bSelect = document.getElementById("promptBlockedBySelect");
  bSelect.innerHTML = '<option value="">-- None / External Issue --</option>';
  
  data.tasks.filter(x => x.id !== id && x.status !== "done").forEach(other => {
    const opt = document.createElement("option");
    opt.value = other.title;
    opt.textContent = other.title + " (" + other.category + ")";
    if (task.blockedBy === other.title) opt.selected = true;
    bSelect.appendChild(opt);
  });

  openModal("blockerPromptModal");
}

function confirmBlockerPrompt() {
  const task = data.tasks.find(t => t.id === pendingBlockTaskId);
  if (task) {
    task.status = "blocked";
    task.blockedBy = document.getElementById("promptBlockedBySelect").value;
    render();
    syncToSheets("update", task);
  }
  closeModal("blockerPromptModal");
  pendingBlockTaskId = null;
}

function cancelBlockerPrompt() {
  closeModal("blockerPromptModal");
  pendingBlockTaskId = null;
  render();
}

// Assignment Modal (Multiple Students + Mentor)
function openAssignment(id) {
  const task = data.tasks.find(t => t.id === id);
  if (!task) return;
  activeTaskId = id;
  
  pendingAssignees = task.assignee 
    ? task.assignee.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  pendingMentor = task.mentor || "";

  document.getElementById("assignTaskSummary").innerHTML = `
    <strong>${escapeHtml(task.title)}</strong>
    <span>${escapeHtml(task.category)} • ${task.priority.toUpperCase()} priority</span>`;

  renderStudentButtons();
  renderMentorButtons();

  openModal("assignModal");
}

function renderStudentButtons() {
  const sWrap = document.getElementById("studentButtons");
  sWrap.innerHTML = "";
  
  data.students.forEach(name => {
    const isSelected = pendingAssignees.includes(name);
    const b = document.createElement("button");
    b.className = "person-btn" + (isSelected ? " selected" : "");
    b.textContent = name;
    b.onclick = () => {
      if (pendingAssignees.includes(name)) {
        pendingAssignees = pendingAssignees.filter(n => n !== name);
      } else {
        pendingAssignees.push(name);
      }
      renderStudentButtons();
    };
    sWrap.appendChild(b);
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "person-btn" + (pendingAssignees.length === 0 ? " selected" : "");
  clearBtn.textContent = "Clear All";
  clearBtn.onclick = () => {
    pendingAssignees = [];
    renderStudentButtons();
  };
  sWrap.appendChild(clearBtn);
}

function renderMentorButtons() {
  const mWrap = document.getElementById("mentorButtons");
  mWrap.innerHTML = "";

  data.mentors.forEach(name => {
    const b = document.createElement("button");
    b.className = "person-btn" + (pendingMentor === name ? " selected" : "");
    b.textContent = name;
    b.onclick = () => {
      pendingMentor = name;
      renderMentorButtons();
    };
    mWrap.appendChild(b);
  });

  const unMentor = document.createElement("button");
  unMentor.className = "person-btn" + (!pendingMentor ? " selected" : "");
  unMentor.textContent = "None";
  unMentor.onclick = () => {
    pendingMentor = "";
    renderMentorButtons();
  };
  mWrap.appendChild(unMentor);
}

function confirmAssignment() {
  const task = data.tasks.find(x => x.id === activeTaskId);
  if (task) {
    task.assignee = pendingAssignees.join(", ");
    task.mentor = pendingMentor;
    render();
    syncToSheets("update", task);
  }
  closeModal("assignModal");
}

function toggleBlockedByField() {
  const status = document.getElementById("editStatus").value;
  document.getElementById("blockedByContainer").style.display = status === "blocked" ? "flex" : "none";
}

function openEditModal(id) {
  const t = data.tasks.find(x => x.id === id);
  if (!t) return;
  activeTaskId = id;
  document.getElementById("editTitle").value = t.title;
  document.getElementById("editDesc").value = t.desc || "";
  document.getElementById("editCategory").value = t.category;
  document.getElementById("editPriority").value = t.priority;
  
  let dateVal = "";
  if (t.due) {
    const d = new Date(t.due);
    if (!isNaN(d.getTime())) {
      dateVal = d.toISOString().split("T")[0];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(t.due)) {
      dateVal = t.due;
    }
  }
  document.getElementById("editDue").value = dateVal;
  document.getElementById("editStatus").value = t.status;

  const bSelect = document.getElementById("editBlockedBy");
  bSelect.innerHTML = '<option value="">-- None / External Block --</option>';
  data.tasks.filter(x => x.id !== id && x.status !== "done").forEach(other => {
    const opt = document.createElement("option");
    opt.value = other.title;
    opt.textContent = other.title + " (" + other.category + ")";
    if (t.blockedBy === other.title) opt.selected = true;
    bSelect.appendChild(opt);
  });

  toggleBlockedByField();
  openModal("editModal");
}

function saveTaskDetails() {
  const title = document.getElementById("editTitle").value.trim();
  if (!title) { alert("Please enter a title."); return; }
  const t = data.tasks.find(x => x.id === activeTaskId);
  if (t) {
    t.title = title;
    t.desc = document.getElementById("editDesc").value.trim();
    t.category = document.getElementById("editCategory").value;
    t.priority = document.getElementById("editPriority").value;
    t.due = document.getElementById("editDue").value;
    t.status = document.getElementById("editStatus").value;
    t.blockedBy = t.status === "blocked" ? document.getElementById("editBlockedBy").value : "";
    render();
    syncToSheets("update", t);
  }
  closeModal("editModal");
}

function deleteTask() {
  if (!activeTaskId) return;
  if (confirm("Delete this task?")) {
    const idToDelete = activeTaskId;
    data.tasks = data.tasks.filter(t => t.id !== idToDelete);
    render();
    syncToSheets("delete", idToDelete);
    closeModal("editModal");
  }
}

function openClaim() {
  const available = data.tasks.filter(t => t.status === "todo" || t.status === "backlog");
  const sorted = sortTasks(available);
  const content = document.getElementById("claimContent");
  if (!sorted.length) {
    content.innerHTML = '<div class="empty">Nothing open right now. Great job! 🎉</div>';
  } else {
    content.innerHTML = sorted.slice(0, 8).map(t => `
      <div class="claim-card" style="cursor:pointer" onclick="closeModal('claimModal'); moveTask(${t.id},'progress')">
        <strong>${escapeHtml(t.title)}</strong>
        <span>${escapeHtml(t.category)} • ${(t.priority||'medium').toUpperCase()} priority${t.mentor ? " • Mentor: " + escapeHtml(t.mentor) : ""}</span>
      </div>`).join("");
  }
  openModal("claimModal");
}

function openSettings() {
  document.getElementById("apiUrlInput").value = API_URL;
  document.getElementById("pollIntervalSelect").value = String(pollInterval);
  openModal("settingsModal");
}

function saveSettings() {
  const url = document.getElementById("apiUrlInput").value.trim();
  const interval = Number(document.getElementById("pollIntervalSelect").value);
  API_URL = url;
  pollInterval = interval;
  localStorage.setItem("ttt_sheets_api_url", url);
  localStorage.setItem("ttt_poll_interval", String(interval));
  resetPollTimer();
  fetchTasksFromSheets(true);
  closeModal("settingsModal");
}

function openModal(id){ document.getElementById(id).classList.add("open"); }
function closeModal(id){ document.getElementById(id).classList.remove("open"); }
document.querySelectorAll(".modal-backdrop").forEach(b => b.addEventListener("click", e => { if (e.target === b) b.classList.remove("open"); }));

function formatDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.querySelectorAll(".modal-backdrop.open").forEach(x => x.classList.remove("open"));
});

// Boot, initialize UI state, & start background poll
updateBacklogBtn();
fetchTasksFromSheets(false);
resetPollTimer();