/* === app.js - Scrum Board Frontend ===
 * Loads data fresh from server on every page load.
 * Theme preference is the only thing persisted in localStorage.
 */

'use strict';

// ======================================================
// STATE
// ======================================================
let state = {
  tasks: [],
  users: [],
  tags: [],
  sprints: [],
  filters: {
    search: '',
    assignee: '',
    priority: '',
    tag: '',
    type: ''
  },
  draggedTaskId: null,
  currentView: 'board',
  viewingSprintId: null
};

let editingTaskId = null;
let createForStatus = null;
let createForParentId = null;
let createForBacklog = false;
let createPendingLinks = [];
let createPendingSubtasks = [];

// ======================================================
// UTILITY
// ======================================================
function getUser(userId) {
  return state.users.find(u => u.id === userId) || null;
}

function getTag(tagId) {
  return state.tags.find(t => t.id === tagId) || null;
}

function getTask(taskId) {
  return state.tasks.find(t => t.id === taskId) || null;
}

function getSprint(sprintId) {
  return state.sprints.find(s => s.id === sprintId) || null;
}

function getActiveSprint() {
  return state.sprints.find(s => s.status === 'active') || null;
}

function getSubtasks(parentId) {
  return state.tasks.filter(t => t.parentId === parentId);
}

function nextTaskId() {
  const nums = state.tasks.map(t => {
    const m = t.id.match(/SCRUM-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const max = nums.length ? Math.max(...nums) : 0;
  return `SCRUM-${String(max + 1).padStart(3, '0')}`;
}

function priorityIcon(priority) {
  const icons = {
    critical: '<span class="card-priority priority-critical" title="Critical" aria-label="Priority: Critical">&#9679;</span>',
    high:     '<span class="card-priority priority-high"     title="High" aria-label="Priority: High">&#9679;</span>',
    medium:   '<span class="card-priority priority-medium"   title="Medium" aria-label="Priority: Medium">&#9679;</span>',
    low:      '<span class="card-priority priority-low"      title="Low" aria-label="Priority: Low">&#9679;</span>'
  };
  return icons[priority] || '';
}

function typeIcon(type) {
  const icons = {
    story:   '<span class="type-icon type-story"   title="Story" aria-label="Type: Story">&#9670;</span>',
    bug:     '<span class="type-icon type-bug"     title="Bug" aria-label="Type: Bug">&#9679;</span>',
    task:    '<span class="type-icon type-task"    title="Task" aria-label="Type: Task">&#10003;</span>',
    subtask: '<span class="type-icon type-subtask" title="Subtask" aria-label="Type: Subtask">&#8627;</span>'
  };
  return icons[type] || icons['task'];
}

function columnLabel(status) {
  const labels = {
    todo: 'To Do',
    inprogress: 'In Progress',
    inreview: 'In Review',
    done: 'Done'
  };
  return labels[status] || status;
}

function linkTypeLabel(linkType) {
  const labels = {
    blocks: 'blocks',
    isBlockedBy: 'is blocked by',
    duplicates: 'duplicates',
    relatesTo: 'relates to'
  };
  return labels[linkType] || linkType;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function priorityOrder(p) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p] ?? 4;
}

// ======================================================
// SERVER COMMUNICATION
// ======================================================
async function saveState() {
  try {
    await fetch('/save-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: state.tasks,
        users: state.users,
        tags: state.tags,
        sprints: state.sprints,
        savedAt: new Date().toISOString()
      })
    });
  } catch (e) {
    console.warn('Could not save state:', e);
  }
}

async function logEvent(type, data) {
  try {
    await fetch('/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    });
  } catch (e) {
    console.warn('Could not log event:', e);
  }
}

// ======================================================
// THEME
// ======================================================
function applyTheme(theme) {
  document.body.classList.remove('theme-jira', 'theme-dark', 'theme-sand');
  document.body.classList.add('theme-' + theme);
  document.body.setAttribute('data-theme', theme);

  document.querySelectorAll('.theme-dot').forEach(dot => {
    dot.classList.toggle('selected', dot.dataset.theme === theme);
  });

  localStorage.setItem('scrumboard_theme', theme);
}

function loadTheme() {
  const saved = localStorage.getItem('scrumboard_theme') || 'jira';
  applyTheme(saved);
}

// ======================================================
// RENDER: CARDS
// ======================================================
function renderTagPill(tagId) {
  const tag = getTag(tagId);
  if (!tag) return '';
  return `<span class="tag-pill" style="background:${tag.color}" title="${tag.name}" aria-label="Tag: ${tag.name}">${tag.name}</span>`;
}

function buildCardHTML(task) {
  const user = task.assigneeId ? getUser(task.assigneeId) : null;
  const tagsHTML = (task.tags || []).map(renderTagPill).join('');
  const avatarHTML = user
    ? `<span class="avatar" style="background:${user.color}" title="${user.name}" aria-label="Assignee: ${escapeHtml(user.name)}">${user.avatar}</span>`
    : '';
  const spHTML = `<span class="story-points" title="Story points" aria-label="${task.storyPoints} story points">${task.storyPoints}</span>`;

  // Subtask progress bar
  const subtasks = getSubtasks(task.id);
  let subtaskBarHTML = '';
  if (subtasks.length > 0) {
    const done = subtasks.filter(s => s.status === 'done').length;
    const pct = Math.round((done / subtasks.length) * 100);
    subtaskBarHTML = `
      <div class="subtask-bar" title="${done}/${subtasks.length} subtasks done" aria-label="${done} of ${subtasks.length} subtasks done">
        <div class="subtask-bar-track"><div class="subtask-bar-fill" style="width:${pct}%"></div></div>
        <span class="subtask-bar-label">${done}/${subtasks.length}</span>
      </div>`;
  }

  // Blocker badge: check if any other task's linkedIssues blocks this task
  const isBlocked = state.tasks.some(t =>
    (t.linkedIssues || []).some(l => l.targetId === task.id && l.linkType === 'blocks')
  );
  const blockerBadge = isBlocked
    ? '<span class="blocker-badge" title="Blocked by another issue" aria-label="Blocked by another issue">&#128274;</span>'
    : '';

  // Build a descriptive aria-label for the full card
  const tagNames = (task.tags || []).map(tid => { const t = getTag(tid); return t ? t.name : ''; }).filter(Boolean).join(', ');
  const ariaLabel = [
    task.id,
    escapeHtml(task.title),
    `Priority: ${task.priority}`,
    `Type: ${task.type || 'task'}`,
    user ? `Assignee: ${user.name}` : 'Unassigned',
    `${task.storyPoints} story points`,
    tagNames ? `Tags: ${tagNames}` : '',
    isBlocked ? 'Blocked' : '',
    subtasks.length > 0 ? `${subtasks.filter(s => s.status === 'done').length} of ${subtasks.length} subtasks done` : ''
  ].filter(Boolean).join(' | ');

  return `
    <div class="card" id="card-${task.id}" data-id="${task.id}" draggable="true" title="${escapeHtml(task.title)}" role="option" aria-label="${ariaLabel}" tabindex="0">
      ${tagsHTML ? `<div class="card-tags">${tagsHTML}</div>` : ''}
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        <div class="card-meta-left">
          ${priorityIcon(task.priority)}
          ${typeIcon(task.type || 'task')}
          <span class="card-id">${task.id}</span>
          ${blockerBadge}
        </div>
        <div class="card-meta-right">
          ${spHTML}
          ${avatarHTML}
        </div>
      </div>
      ${subtaskBarHTML}
    </div>
  `;
}

function taskMatchesFilters(task) {
  // Subtasks are hidden from board view
  if (task.parentId) return false;

  // Board shows tasks for the viewed sprint (or active sprint by default)
  const viewingSprint = state.viewingSprintId ? getSprint(state.viewingSprintId) : getActiveSprint();
  if (viewingSprint) {
    if (task.sprintId !== viewingSprint.id) return false;
  } else {
    if (task.sprintId) return false;
  }

  const { search, assignee, priority, tag, type } = state.filters;

  if (search) {
    const q = search.toLowerCase();
    const inTitle = task.title.toLowerCase().includes(q);
    const inDesc = (task.description || '').toLowerCase().includes(q);
    const inId = task.id.toLowerCase().includes(q);
    if (!inTitle && !inDesc && !inId) return false;
  }

  if (assignee && task.assigneeId !== assignee) return false;
  if (priority && task.priority !== priority) return false;
  if (tag && !(task.tags || []).includes(tag)) return false;
  if (type && task.type !== type) return false;

  return true;
}

function renderBoard() {
  const columns = ['todo', 'inprogress', 'inreview', 'done'];

  columns.forEach(status => {
    const container = document.getElementById(`cards-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    if (!container || !countEl) return;

    // Show tasks for the viewed sprint (or active sprint by default)
    const viewingSprint = state.viewingSprintId ? getSprint(state.viewingSprintId) : getActiveSprint();
    const tasksForCol = state.tasks.filter(t => {
      if (t.status !== status || t.parentId) return false;
      if (viewingSprint) return t.sprintId === viewingSprint.id;
      return !t.sprintId;
    });
    container.innerHTML = tasksForCol.map(buildCardHTML).join('');

    // Apply filter visibility
    const visibleCount = tasksForCol.filter(taskMatchesFilters).length;
    tasksForCol.forEach(task => {
      const cardEl = container.querySelector(`[data-id="${task.id}"]`);
      if (cardEl) {
        if (!taskMatchesFilters(task)) {
          cardEl.classList.add('hidden');
        } else {
          cardEl.classList.remove('hidden');
        }
      }
    });

    countEl.textContent = visibleCount;
    countEl.setAttribute('aria-label', `${columnLabel(status)} count: ${visibleCount}`);

    // Attach drag events to newly rendered cards
    attachCardDragEvents(container);
  });
}

function updateColumnCounts() {
  const columns = ['todo', 'inprogress', 'inreview', 'done'];
  const labels = { todo: 'To Do', inprogress: 'In Progress', inreview: 'In Review', done: 'Done' };
  columns.forEach(status => {
    const countEl = document.getElementById(`count-${status}`);
    if (!countEl) return;
    const visible = state.tasks.filter(t => t.status === status && taskMatchesFilters(t)).length;
    countEl.textContent = visible;
    countEl.setAttribute('aria-label', `${labels[status]} count: ${visible}`);
  });
}

// ======================================================
// SPRINT MANAGEMENT
// ======================================================
function renderSprintBanner() {
  const banner = document.getElementById('sprint-banner');
  if (!banner) return;

  // Show the currently viewed sprint (falls back to active sprint)
  const sprint = state.viewingSprintId ? getSprint(state.viewingSprintId) : getActiveSprint();
  if (sprint) {
    const start = sprint.startDate ? new Date(sprint.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const end   = sprint.endDate   ? new Date(sprint.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const dateRange = (start && end) ? ` · ${start} – ${end}` : '';
    banner.textContent = `${sprint.name}${dateRange}`;
    banner.style.display = 'inline-flex';
  } else {
    banner.style.display = 'none';
  }
}

function renderSprintSidebar() {
  const el = document.getElementById('sidebar-sprint-name');
  if (!el) return;
  const active = getActiveSprint();
  el.textContent = active ? active.name : 'No active sprint';
}

function openSprintModal() {
  const modal = document.getElementById('sprint-modal-overlay');
  if (!modal) return;

  // Populate sprint list
  renderSprintList();

  // Clear new sprint form
  document.getElementById('new-sprint-name').value = '';
  document.getElementById('new-sprint-goal').value = '';
  document.getElementById('new-sprint-start').value = '';
  document.getElementById('new-sprint-end').value = '';

  modal.style.display = 'flex';
}

function closeSprintModal() {
  const modal = document.getElementById('sprint-modal-overlay');
  if (modal) modal.style.display = 'none';
}

function renderSprintList() {
  const container = document.getElementById('sprint-list');
  if (!container) return;

  if (state.sprints.length === 0) {
    container.innerHTML = '<p class="empty-hint">No sprints yet. Create one below.</p>';
    return;
  }

  container.innerHTML = state.sprints.map(sprint => {
    const statusClass = `sprint-status-${sprint.status}`;
    const taskCount = state.tasks.filter(t => t.sprintId === sprint.id && !t.parentId).length;
    const doneCount = state.tasks.filter(t => t.sprintId === sprint.id && !t.parentId && t.status === 'done').length;

    let actions = '';
    if (sprint.status === 'planning') {
      actions = `<button class="btn-sm btn-primary" id="modal-start-sprint-${sprint.id}" aria-label="Start sprint" onclick="startSprint('${sprint.id}')">Start Sprint</button>`;
    } else if (sprint.status === 'active') {
      actions = `<button class="btn-sm btn-warning" id="modal-complete-sprint-${sprint.id}" aria-label="Complete sprint" onclick="completeSprint('${sprint.id}')">Complete Sprint</button>`;
    }

    const start = sprint.startDate ? new Date(sprint.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const end   = sprint.endDate   ? new Date(sprint.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    return `
      <div class="sprint-item" id="sprint-modal-item-${sprint.id}" role="listitem" tabindex="0">
        <div class="sprint-item-header">
          <span class="sprint-item-name">${escapeHtml(sprint.name)}</span>
          <span class="sprint-badge ${statusClass}">${sprint.status}</span>
        </div>
        <div class="sprint-item-meta">${start} – ${end} · ${doneCount}/${taskCount} tasks done</div>
        ${sprint.goal ? `<div class="sprint-item-goal">${escapeHtml(sprint.goal)}</div>` : ''}
        <div class="sprint-item-actions">${actions}</div>
      </div>
    `;
  }).join('');
}

function refreshSprintUi() {
  renderSprintList();
  renderSprints();
  renderSprintBanner();
  renderSprintSidebar();
  renderCompleteSprintButton();
}

async function createSprint() {
  const name = document.getElementById('new-sprint-name').value.trim();
  if (!name) {
    document.getElementById('new-sprint-name').focus();
    return;
  }
  const goal = document.getElementById('new-sprint-goal').value.trim();
  const startDate = document.getElementById('new-sprint-start').value || null;
  const endDate   = document.getElementById('new-sprint-end').value || null;

  const newSprint = {
    id: `sprint-${Date.now()}`,
    name,
    goal,
    startDate,
    endDate,
    status: 'planning'
  };

  state.sprints.push(newSprint);
  refreshSprintUi();

  document.getElementById('new-sprint-name').value = '';
  document.getElementById('new-sprint-goal').value = '';
  document.getElementById('new-sprint-start').value = '';
  document.getElementById('new-sprint-end').value = '';

  await saveState();
  await logEvent('sprint_created', { sprintId: newSprint.id, name: newSprint.name, goal: newSprint.goal });
}

async function startSprint(sprintId) {
  // Only one active sprint at a time
  const currentActive = getActiveSprint();
  if (currentActive && currentActive.id !== sprintId) {
    alert(`Sprint "${currentActive.name}" is already active. Complete it first.`);
    return;
  }
  const sprint = getSprint(sprintId);
  if (!sprint) return;

  sprint.status = 'active';
  refreshSprintUi();
  renderBoard();

  await saveState();
  await logEvent('sprint_started', { sprintId: sprint.id, name: sprint.name });
}

async function completeSprint(sprintId) {
  const sprint = getSprint(sprintId);
  if (!sprint) return;

  sprint.status = 'completed';
  refreshSprintUi();
  renderBoard();

  await saveState();
  await logEvent('sprint_completed', { sprintId: sprint.id, name: sprint.name, completedAt: new Date().toISOString() });
}

async function completeActiveSprint() {
  const active = getActiveSprint();
  if (active) await completeSprint(active.id);
}

function renderCompleteSprintButton() {
  const completeBtn = document.getElementById('btn-complete-sprint');
  const startBtn = document.getElementById('btn-start-sprint');

  const active = getActiveSprint();
  const viewedSprintId = state.viewingSprintId || (active ? active.id : null);
  const viewedSprint = viewedSprintId ? getSprint(viewedSprintId) : null;

  // "Complete Sprint" only when viewing the active sprint
  if (completeBtn) {
    completeBtn.style.display = (active && viewedSprintId === active.id) ? '' : 'none';
  }

  // "Start Sprint" only when viewing a planning sprint
  if (startBtn) {
    if (viewedSprint && viewedSprint.status === 'planning') {
      startBtn.style.display = '';
      startBtn.onclick = () => startSprint(viewedSprint.id);
    } else {
      startBtn.style.display = 'none';
      startBtn.onclick = null;
    }
  }
}

// ======================================================
// BACKLOG VIEW
// ======================================================
function showView(viewName) {
  state.currentView = viewName;
  clearAllFilters();
  // Reset viewingSprintId when navigating to board via sidebar (not via openSprintBoard)
  if (viewName === 'board' && !state._openingSprintBoard) {
    state.viewingSprintId = null;
  }
  state._openingSprintBoard = false;
  const boardEl = document.getElementById('board');
  const backlogEl = document.getElementById('backlog-view');
  const sprintsEl = document.getElementById('sprints-view');

  if (viewName === 'board') {
    if (boardEl) boardEl.style.display = '';
    if (backlogEl) backlogEl.style.display = 'none';
    if (sprintsEl) sprintsEl.style.display = 'none';
    renderBoard();
    renderSprintBanner();
    renderCompleteSprintButton();
  } else if (viewName === 'backlog') {
    if (boardEl) boardEl.style.display = 'none';
    if (backlogEl) backlogEl.style.display = '';
    if (sprintsEl) sprintsEl.style.display = 'none';
    renderBacklog();
  } else if (viewName === 'sprints') {
    if (boardEl) boardEl.style.display = 'none';
    if (backlogEl) backlogEl.style.display = 'none';
    if (sprintsEl) sprintsEl.style.display = '';
    renderSprints();
  }

  // Update nav active states
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // Update breadcrumb
  const breadcrumbPage = document.querySelector('.breadcrumb-page');
  if (breadcrumbPage) {
    if (viewName === 'board') breadcrumbPage.textContent = 'Board';
    else if (viewName === 'backlog') breadcrumbPage.textContent = 'Backlog';
    else if (viewName === 'sprints') breadcrumbPage.textContent = 'Sprints';
  }
}

function renderBacklog() {
  const container = document.getElementById('backlog-list');
  const countEl   = document.getElementById('backlog-count');
  if (!container) return;

  // Tasks with no sprint assigned, top-level only
  const backlogTasks = state.tasks
    .filter(t => !t.sprintId && !t.parentId)
    .filter(t => {
      const { search, assignee, priority, tag, type } = state.filters;
      if (search) {
        const q = search.toLowerCase();
        const inTitle = t.title.toLowerCase().includes(q);
        const inDesc = (t.description || '').toLowerCase().includes(q);
        const inId = t.id.toLowerCase().includes(q);
        if (!inTitle && !inDesc && !inId) return false;
      }
      if (assignee && t.assigneeId !== assignee) return false;
      if (priority && t.priority !== priority) return false;
      if (tag && !(t.tags || []).includes(tag)) return false;
      if (type && t.type !== type) return false;
      return true;
    })
    .sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority));

  if (countEl) countEl.textContent = backlogTasks.length;

  if (backlogTasks.length === 0) {
    container.innerHTML = '<div class="backlog-empty">No tasks in backlog. All tasks are assigned to sprints.</div>';
    return;
  }

  const activeSprint = getActiveSprint();

  container.innerHTML = backlogTasks.map(task => {
    const user = task.assigneeId ? getUser(task.assigneeId) : null;
    const avatarHTML = user
      ? `<span class="avatar avatar-sm" style="background:${user.color}" title="${user.name}">${user.avatar}</span>`
      : '<span class="avatar avatar-sm avatar-empty" title="Unassigned">—</span>';
    const tagsHTML = (task.tags || []).slice(0, 3).map(renderTagPill).join('');

    const backlogTagNames = (task.tags || []).map(tid => { const t = getTag(tid); return t ? t.name : ''; }).filter(Boolean).join(', ');
    const backlogAriaLabel = [
      task.id,
      escapeHtml(task.title),
      `Priority: ${task.priority}`,
      `Type: ${task.type || 'task'}`,
      user ? `Assignee: ${user.name}` : 'Unassigned',
      `${task.storyPoints} story points`,
      backlogTagNames ? `Tags: ${backlogTagNames}` : ''
    ].filter(Boolean).join(' | ');

    return `
      <div class="backlog-row" id="backlog-row-${task.id}" data-id="${task.id}" style="cursor:pointer;" role="option" aria-label="${backlogAriaLabel}" tabindex="0">
        <div class="backlog-row-left">
          ${typeIcon(task.type || 'task')}
          ${priorityIcon(task.priority)}
          <span class="backlog-task-id">${task.id}</span>
          <span class="backlog-task-title">${escapeHtml(task.title)}</span>
        </div>
        <div class="backlog-row-right">
          ${tagsHTML}
          <span class="story-points" title="Story points" aria-label="${task.storyPoints} story points">${task.storyPoints}</span>
          ${avatarHTML}
          ${activeSprint
            ? `<button class="btn-sm btn-outline" id="add-sprint-${task.id}" aria-label="Add to sprint" onclick="addToSprint('${task.id}')">+ Sprint</button>`
            : '<span class="backlog-no-sprint">No active sprint</span>'}
          <button class="btn-sm btn-ghost" id="edit-${task.id}" aria-label="Edit ${task.id}" onclick="openCardModal('${task.id}')">Edit</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers to backlog rows to open detail modal
  container.querySelectorAll('.backlog-row').forEach(row => {
    row.addEventListener('click', e => {
      // Don't open modal if a button was clicked
      if (e.target.closest('button')) return;
      const taskId = row.dataset.id;
      if (taskId) openCardModal(taskId);
    });
  });
}

async function addToSprint(taskId) {
  const activeSprint = getActiveSprint();
  if (!activeSprint) {
    alert('No active sprint. Start a sprint first.');
    return;
  }
  const task = getTask(taskId);
  if (!task) return;

  task.sprintId = activeSprint.id;
  renderBacklog();
  renderBoard();

  await logEvent('backlog_item_added', {
    taskId: task.id,
    taskTitle: task.title,
    sprintId: activeSprint.id,
    sprintName: activeSprint.name
  });
  await saveState();
}

function renderSprints() {
  const container = document.getElementById('sprints-list');
  if (!container) return;

  if (state.sprints.length === 0) {
    container.innerHTML = '<div class="sprints-empty" style="padding:20px; text-align:center; color:#666;">No sprints yet. Create one using the "+ New Sprint" button.</div>';
    return;
  }

  container.innerHTML = state.sprints.map(sprint => {
    const statusClass = `sprint-status-${sprint.status}`;
    const taskCount = state.tasks.filter(t => t.sprintId === sprint.id && !t.parentId).length;
    const doneCount = state.tasks.filter(t => t.sprintId === sprint.id && !t.parentId && t.status === 'done').length;

    let actions = '';
    if (sprint.status === 'planning') {
      actions = `<button class="btn-sm btn-primary" id="start-sprint-${sprint.id}" aria-label="Start sprint" onclick="event.stopPropagation(); startSprint('${sprint.id}')">Start Sprint</button>`;
    } else if (sprint.status === 'active') {
      actions = `<button class="btn-sm btn-warning" id="complete-sprint-${sprint.id}" aria-label="Complete sprint" onclick="event.stopPropagation(); completeSprint('${sprint.id}')">Complete Sprint</button>`;
    }

    const start = sprint.startDate ? new Date(sprint.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const end   = sprint.endDate   ? new Date(sprint.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    return `
      <div class="sprint-item sprint-item-clickable" id="sprint-item-${sprint.id}" role="option" aria-label="${escapeHtml(sprint.name)} - ${sprint.status}" tabindex="0" onclick="openSprintBoard('${sprint.id}')" title="Click to view sprint board">
        <div class="sprint-item-header">
          <span class="sprint-item-name">${escapeHtml(sprint.name)}</span>
          <span class="sprint-badge ${statusClass}">${sprint.status}</span>
        </div>
        <div class="sprint-item-meta">${start} – ${end} · ${doneCount}/${taskCount} tasks done</div>
        ${sprint.goal ? `<div class="sprint-item-goal">${escapeHtml(sprint.goal)}</div>` : ''}
        <div class="sprint-item-actions">${actions}</div>
      </div>
    `;
  }).join('');
}

function openSprintBoard(sprintId) {
  const sprint = getSprint(sprintId);
  if (!sprint) return;
  state.viewingSprintId = sprintId;
  state._openingSprintBoard = true;
  showView('board');
}

// ======================================================
// DRAG AND DROP
// ======================================================
function attachCardDragEvents(container) {
  container.querySelectorAll('.card:not(.drag-placeholder)').forEach(card => {
    card.addEventListener('dragstart', onCardDragStart);
    card.addEventListener('dragend', onCardDragEnd);
    card.addEventListener('click', onCardClick);
  });
}

function onCardDragStart(e) {
  const card = e.currentTarget;
  const taskId = card.dataset.id;
  state.draggedTaskId = taskId;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', taskId);
  setTimeout(() => card.classList.add('dragging'), 0);
}

function onCardDragEnd(e) {
  const card = e.currentTarget;
  card.classList.remove('dragging');
  state.draggedTaskId = null;

  document.querySelectorAll('.column-body.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.card.drag-placeholder').forEach(el => el.remove());
}

function setupColumnDropTargets() {
  document.querySelectorAll('.column-body').forEach(colBody => {
    colBody.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colBody.classList.add('drag-over');
    });

    colBody.addEventListener('dragleave', e => {
      if (!colBody.contains(e.relatedTarget)) {
        colBody.classList.remove('drag-over');
      }
    });

    colBody.addEventListener('drop', async e => {
      e.preventDefault();
      colBody.classList.remove('drag-over');

      const taskId = e.dataTransfer.getData('text/plain') || state.draggedTaskId;
      if (!taskId) return;

      const newStatus = colBody.dataset.status;
      const task = getTask(taskId);
      if (!task) return;

      const oldStatus = task.status;
      if (oldStatus === newStatus) return;

      task.status = newStatus;
      renderBoard();

      await saveState();
      await logEvent('card_moved', {
        taskId: task.id,
        taskTitle: task.title,
        fromStatus: oldStatus,
        toStatus: newStatus
      });
    });
  });
}

// ======================================================
// CARD DETAIL MODAL
// ======================================================
function onCardClick(e) {
  if (state.draggedTaskId) return;
  const card = e.currentTarget;
  const taskId = card.dataset.id;
  openCardModal(taskId);
}

function openCardModal(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  editingTaskId = taskId;

  document.getElementById('modal-task-id').textContent = task.id;
  document.getElementById('modal-title').value = task.title;
  document.getElementById('modal-description').value = task.description || '';
  document.getElementById('modal-status').value = task.status;
  document.getElementById('modal-priority').value = task.priority;
  document.getElementById('modal-story-points').value = String(task.storyPoints);

  // Type
  const typeSelect = document.getElementById('modal-type');
  if (typeSelect) typeSelect.value = task.type || 'task';

  // Assignee dropdown
  const assigneeSelect = document.getElementById('modal-assignee');
  assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name;
    if (u.id === task.assigneeId) opt.selected = true;
    assigneeSelect.appendChild(opt);
  });

  // Sprint dropdown (only active and planning sprints allowed)
  const sprintSelect = document.getElementById('modal-sprint');
  if (sprintSelect) {
    sprintSelect.innerHTML = '<option value="">Backlog (No Sprint)</option>';
    const activeAndFutureSprints = state.sprints.filter(s => s.status === 'active' || s.status === 'planning');
    activeAndFutureSprints.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === task.sprintId) opt.selected = true;
      sprintSelect.appendChild(opt);
    });
  }

  // Tags checkboxes
  const tagsContainer = document.getElementById('modal-tags');
  tagsContainer.innerHTML = '';
  state.tags.forEach(tag => {
    const label = document.createElement('label');
    label.className = 'tag-checkbox-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'modal-tag-' + tag.id;
    cb.value = tag.id;
    cb.checked = (task.tags || []).includes(tag.id);
    const span = document.createElement('span');
    span.className = 'tag-checkbox-text';
    span.style.background = tag.color;
    span.textContent = tag.name;
    label.appendChild(cb);
    label.appendChild(span);
    tagsContainer.appendChild(label);
  });

  // Subtasks section
  renderModalSubtasks(task);

  // Issue links section
  renderModalLinks(task);

  document.getElementById('modal-overlay').style.display = 'flex';
}

// --- Subtasks in modal ---
function renderModalSubtasks(task) {
  const section = document.getElementById('modal-subtasks-section');
  if (!section) return;

  const subtasks = getSubtasks(task.id);

  const listHTML = subtasks.length === 0
    ? '<p class="empty-hint">No subtasks yet.</p>'
    : subtasks.map(st => `
        <div class="subtask-item" role="listitem" tabindex="0">
          <input type="checkbox" class="subtask-check" id="subtask-check-${st.id}" data-id="${st.id}" aria-label="Mark ${escapeHtml(st.title)} as done" ${st.status === 'done' ? 'checked' : ''} />
          <span class="subtask-item-title ${st.status === 'done' ? 'done-text' : ''}">${escapeHtml(st.title)}</span>
          <span class="subtask-item-id">${st.id}</span>
        </div>
      `).join('');

  section.innerHTML = `
    <div class="form-label">Subtasks</div>
    <div id="subtask-list" role="list">${listHTML}</div>
    <button class="btn-sm btn-outline add-subtask-btn" id="add-subtask-btn">+ Add Subtask</button>
  `;

  // Attach checkbox listeners
  section.querySelectorAll('.subtask-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const stId = cb.dataset.id;
      const st = getTask(stId);
      if (!st) return;
      const oldStatus = st.status;
      st.status = cb.checked ? 'done' : 'todo';
      // Re-render subtask labels
      const label = cb.nextElementSibling;
      if (label) label.classList.toggle('done-text', cb.checked);

      // Also update the parent card's subtask bar
      renderBoard();

      await saveState();
      const evType = cb.checked ? 'subtask_completed' : 'subtask_reopened';
      await logEvent(evType, { taskId: st.id, parentId: st.parentId, title: st.title, oldStatus });
    });
  });

  // Add subtask button
  const addBtn = document.getElementById('add-subtask-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      closeCardModal();
      openCreateModal(task.status, task.id);
    });
  }
}

// --- Issue Links in modal ---
function renderModalLinks(task) {
  const section = document.getElementById('modal-links-section');
  if (!section) return;

  const links = task.linkedIssues || [];

  const existingHTML = links.length === 0
    ? '<p class="empty-hint">No linked issues.</p>'
    : links.map((link, idx) => {
        const target = getTask(link.targetId);
        const targetTitle = target ? target.title : link.targetId;
        return `
          <div class="link-item" role="listitem" tabindex="0">
            <span class="link-type-badge">${linkTypeLabel(link.linkType)}</span>
            <span class="link-target-id">${link.targetId}</span>
            <span class="link-target-title">${escapeHtml(targetTitle)}</span>
            <button class="btn-sm btn-ghost link-remove-btn" id="remove-link-${idx}" data-index="${idx}" aria-label="Remove link to ${link.targetId}">&#10005;</button>
          </div>
        `;
      }).join('');

  // Build target task options
  const taskOptions = state.tasks
    .filter(t => t.id !== task.id && !t.parentId)
    .map(t => `<option value="${t.id}">${t.id}: ${escapeHtml(t.title.substring(0, 40))}</option>`)
    .join('');

  section.innerHTML = `
    <div class="form-label">Linked Issues</div>
    <div id="links-list" role="list">${existingHTML}</div>
    <div class="add-link-form">
      <select id="link-target-select" class="form-select link-select" aria-label="Select target issue">
        <option value="">— Select issue —</option>
        ${taskOptions}
      </select>
      <select id="link-type-select" class="form-select link-type-select" aria-label="Select link type">
        <option value="blocks">blocks</option>
        <option value="isBlockedBy">is blocked by</option>
        <option value="duplicates">duplicates</option>
        <option value="relatesTo">relates to</option>
      </select>
      <button class="btn-sm btn-outline" id="add-link-btn">+ Add Link</button>
    </div>
  `;

  // Remove link buttons
  section.querySelectorAll('.link-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const removed = links[idx];
      task.linkedIssues.splice(idx, 1);
      renderModalLinks(task);
      renderBoard();
      await saveState();
      await logEvent('issue_unlinked', { sourceId: task.id, targetId: removed.targetId, linkType: removed.linkType });
    });
  });

  // Add link button
  const addLinkBtn = document.getElementById('add-link-btn');
  if (addLinkBtn) {
    addLinkBtn.addEventListener('click', async () => {
      const targetId = document.getElementById('link-target-select').value;
      const linkType = document.getElementById('link-type-select').value;
      if (!targetId) return;

      // Avoid duplicate links
      const already = (task.linkedIssues || []).some(l => l.targetId === targetId && l.linkType === linkType);
      if (already) return;

      if (!task.linkedIssues) task.linkedIssues = [];
      task.linkedIssues.push({ targetId, linkType });

      // Add reverse link if appropriate
      const targetTask = getTask(targetId);
      if (targetTask) {
        if (!targetTask.linkedIssues) targetTask.linkedIssues = [];
        let reverseType = null;
        if (linkType === 'blocks') reverseType = 'isBlockedBy';
        else if (linkType === 'isBlockedBy') reverseType = 'blocks';
        if (reverseType) {
          const alreadyReverse = targetTask.linkedIssues.some(l => l.targetId === task.id && l.linkType === reverseType);
          if (!alreadyReverse) {
            targetTask.linkedIssues.push({ targetId: task.id, linkType: reverseType });
          }
        }
      }

      renderModalLinks(task);
      renderBoard();
      await saveState();
      await logEvent('issue_linked', { sourceId: task.id, targetId, linkType });
    });
  }
}

function closeCardModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  editingTaskId = null;
}

async function saveCardModal() {
  const task = getTask(editingTaskId);
  if (!task) return;

  const oldData = { ...task, tags: [...(task.tags || [])] };

  task.title = document.getElementById('modal-title').value.trim() || task.title;
  task.description = document.getElementById('modal-description').value.trim();
  task.status = document.getElementById('modal-status').value;
  task.priority = document.getElementById('modal-priority').value;
  task.assigneeId = document.getElementById('modal-assignee').value || null;
  task.storyPoints = parseFloat(document.getElementById('modal-story-points').value);

  const typeSelect = document.getElementById('modal-type');
  if (typeSelect) task.type = typeSelect.value;

  const tagCheckboxes = document.querySelectorAll('#modal-tags input[type="checkbox"]:checked');
  task.tags = Array.from(tagCheckboxes).map(cb => cb.value);

  const sprintSelect = document.getElementById('modal-sprint');
  if (sprintSelect) {
    task.sprintId = sprintSelect.value || null;
  }

  closeCardModal();
  renderBoard();
  if (state.currentView === 'backlog') renderBacklog();

  await saveState();
  await logEvent('card_edited', {
    taskId: task.id,
    taskTitle: task.title,
    changes: {
      title:      task.title      !== oldData.title      ? { from: oldData.title,      to: task.title      } : undefined,
      status:     task.status     !== oldData.status     ? { from: oldData.status,     to: task.status     } : undefined,
      priority:   task.priority   !== oldData.priority   ? { from: oldData.priority,   to: task.priority   } : undefined,
      assigneeId: task.assigneeId !== oldData.assigneeId ? { from: oldData.assigneeId, to: task.assigneeId } : undefined,
      storyPoints:task.storyPoints!== oldData.storyPoints? { from: oldData.storyPoints,to: task.storyPoints} : undefined,
      type:       task.type       !== oldData.type       ? { from: oldData.type,       to: task.type       } : undefined
    }
  });
}

// ======================================================
// CREATE ISSUE MODAL
// ======================================================
function openCreateModal(status, parentId, forBacklog) {
  createForStatus   = status   || 'todo';
  createForParentId = parentId || null;
  createForBacklog  = !!forBacklog;

  document.getElementById('create-title').value = '';
  document.getElementById('create-description').value = '';
  document.getElementById('create-status').value = createForStatus;
  document.getElementById('create-priority').value = 'medium';
  document.getElementById('create-story-points').value = '3';
  document.getElementById('create-title-error').style.display = 'none';

  // Type: default to subtask if creating under a parent
  const createType = document.getElementById('create-type');
  if (createType) createType.value = parentId ? 'subtask' : 'task';

  // Assignee
  const assigneeSelect = document.getElementById('create-assignee');
  assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name;
    assigneeSelect.appendChild(opt);
  });

  // Tags
  const tagsContainer = document.getElementById('create-tags');
  tagsContainer.innerHTML = '';
  state.tags.forEach(tag => {
    const label = document.createElement('label');
    label.className = 'tag-checkbox-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'create-tag-' + tag.id;
    cb.value = tag.id;
    const span = document.createElement('span');
    span.className = 'tag-checkbox-text';
    span.style.background = tag.color;
    span.textContent = tag.name;
    label.appendChild(cb);
    label.appendChild(span);
    tagsContainer.appendChild(label);
  });

  // Sprint dropdown (only active and planning sprints allowed)
  const sprintSelect = document.getElementById('create-sprint');
  if (sprintSelect) {
    sprintSelect.innerHTML = '<option value="">Backlog (No Sprint)</option>';
    const activeAndFutureSprints = state.sprints.filter(s => s.status === 'active' || s.status === 'planning');
    activeAndFutureSprints.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sprintSelect.appendChild(opt);
    });
  }

  // Hidden parent ID field
  const parentField = document.getElementById('create-parent-id');
  if (parentField) parentField.value = parentId || '';

  // Show parent context label
  const parentLabel = document.getElementById('create-parent-label');
  if (parentLabel) {
    if (parentId) {
      const parent = getTask(parentId);
      parentLabel.textContent = `Subtask of: ${parentId}${parent ? ' — ' + parent.title.substring(0, 40) : ''}`;
      parentLabel.style.display = 'block';
    } else {
      parentLabel.style.display = 'none';
    }
  }

  // Initialize linked issues section
  createPendingLinks = [];
  renderCreateLinks();

  // Initialize subtasks section
  createPendingSubtasks = [];
  renderCreateSubtasks();

  document.getElementById('create-modal-overlay').style.display = 'flex';
  document.getElementById('create-title').focus();
}

function renderCreateLinks() {
  const listEl = document.getElementById('create-links-list');
  if (!listEl) return;

  if (createPendingLinks.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">No linked issues.</p>';
  } else {
    listEl.innerHTML = createPendingLinks.map((link, idx) => {
      const target = getTask(link.targetId);
      const targetTitle = target ? target.title : link.targetId;
      return `
        <div class="link-item" role="listitem" tabindex="0">
          <span class="link-type-badge">${linkTypeLabel(link.linkType)}</span>
          <span class="link-target-id">${link.targetId}</span>
          <span class="link-target-title">${escapeHtml(targetTitle)}</span>
          <button class="btn-sm btn-ghost create-link-remove-btn" id="create-remove-link-${idx}" data-index="${idx}" aria-label="Remove link to ${link.targetId}">&#10005;</button>
        </div>
      `;
    }).join('');
  }

  // Populate target dropdown
  const targetSelect = document.getElementById('create-link-target-select');
  if (targetSelect) {
    targetSelect.innerHTML = '<option value="">— Select issue —</option>';
    state.tasks.filter(t => !t.parentId).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.id}: ${t.title.substring(0, 40)}`;
      targetSelect.appendChild(opt);
    });
  }

  // Remove link buttons
  listEl.querySelectorAll('.create-link-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      createPendingLinks.splice(idx, 1);
      renderCreateLinks();
    });
  });

  // Add link button
  const addBtn = document.getElementById('create-add-link-btn');
  if (addBtn) {
    // Remove old listeners by cloning
    const newBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newBtn, addBtn);
    newBtn.addEventListener('click', () => {
      const targetId = document.getElementById('create-link-target-select').value;
      const linkType = document.getElementById('create-link-type-select').value;
      if (!targetId) return;
      const already = createPendingLinks.some(l => l.targetId === targetId && l.linkType === linkType);
      if (already) return;
      createPendingLinks.push({ targetId, linkType });
      renderCreateLinks();
    });
  }
}

function renderCreateSubtasks() {
  const listEl = document.getElementById('create-subtasks-list');
  if (!listEl) return;

  if (createPendingSubtasks.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">No subtasks.</p>';
  } else {
    listEl.innerHTML = createPendingSubtasks.map((title, idx) => `
      <div class="subtask-item" role="listitem">
        <span class="subtask-item-title">${escapeHtml(title)}</span>
        <button class="btn-sm btn-ghost create-subtask-remove-btn" id="create-remove-subtask-${idx}" data-index="${idx}" aria-label="Remove subtask">&#10005;</button>
      </div>
    `).join('');
  }

  // Remove buttons
  listEl.querySelectorAll('.create-subtask-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      createPendingSubtasks.splice(idx, 1);
      renderCreateSubtasks();
    });
  });

  // Add subtask button
  const addBtn = document.getElementById('create-add-subtask-btn');
  if (addBtn) {
    const newBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newBtn, addBtn);
    newBtn.addEventListener('click', () => {
      const input = document.getElementById('create-subtask-title-input');
      const title = (input.value || '').trim();
      if (!title) return;
      createPendingSubtasks.push(title);
      input.value = '';
      renderCreateSubtasks();
    });
  }
}

function closeCreateModal() {
  document.getElementById('create-modal-overlay').style.display = 'none';
  createForStatus = null;
  createForParentId = null;
  createForBacklog = false;
}

async function submitCreateModal() {
  const title = document.getElementById('create-title').value.trim();
  if (!title) {
    document.getElementById('create-title-error').style.display = 'block';
    document.getElementById('create-title').focus();
    return;
  }
  document.getElementById('create-title-error').style.display = 'none';

  const status      = document.getElementById('create-status').value;
  const priority    = document.getElementById('create-priority').value;
  const assigneeId  = document.getElementById('create-assignee').value || null;
  const storyPoints = parseFloat(document.getElementById('create-story-points').value);
  const description = document.getElementById('create-description').value.trim();

  const createType = document.getElementById('create-type');
  const type = createType ? createType.value : 'task';

  const tagCheckboxes = document.querySelectorAll('#create-tags input[type="checkbox"]:checked');
  const tags = Array.from(tagCheckboxes).map(cb => cb.value);

  const parentField = document.getElementById('create-parent-id');
  const parentId = (parentField && parentField.value) ? parentField.value : null;

  // Determine sprint: use the value from sprint dropdown
  let sprintId = null;
  const sprintSelect = document.getElementById('create-sprint');
  if (sprintSelect && sprintSelect.value) {
    sprintId = sprintSelect.value;
  } else if (!createForBacklog && parentId) {
    // Subtasks inherit parent's sprint
    const parent = getTask(parentId);
    sprintId = parent ? parent.sprintId : null;
  } else if (!createForBacklog && !sprintId) {
    // If no sprint selected and not a subtask, use active sprint
    const activeSprint = getActiveSprint();
    sprintId = activeSprint ? activeSprint.id : null;
  }

  const newTask = {
    id: nextTaskId(),
    title,
    description,
    status,
    priority,
    assigneeId,
    storyPoints,
    tags,
    type,
    sprintId,
    parentId,
    linkedIssues: createPendingLinks.slice(),
    createdAt: new Date().toISOString()
  };

  // Add reverse links for blocks/isBlockedBy
  createPendingLinks.forEach(link => {
    const targetTask = getTask(link.targetId);
    if (targetTask) {
      if (!targetTask.linkedIssues) targetTask.linkedIssues = [];
      let reverseType = null;
      if (link.linkType === 'blocks') reverseType = 'isBlockedBy';
      else if (link.linkType === 'isBlockedBy') reverseType = 'blocks';
      if (reverseType) {
        const alreadyReverse = targetTask.linkedIssues.some(l => l.targetId === newTask.id && l.linkType === reverseType);
        if (!alreadyReverse) {
          targetTask.linkedIssues.push({ targetId: newTask.id, linkType: reverseType });
        }
      }
    }
  });

  state.tasks.push(newTask);
  closeCreateModal();
  renderBoard();
  if (state.currentView === 'backlog') renderBacklog();

  await saveState();
  await logEvent('card_created', {
    taskId: newTask.id,
    taskTitle: newTask.title,
    status: newTask.status,
    priority: newTask.priority,
    assigneeId: newTask.assigneeId,
    storyPoints: newTask.storyPoints,
    tags: newTask.tags,
    type: newTask.type,
    parentId: newTask.parentId
  });

  if (parentId) {
    await logEvent('subtask_created', { taskId: newTask.id, parentId, title: newTask.title });
  }

  // Log issue_linked events
  for (const link of createPendingLinks) {
    await logEvent('issue_linked', { sourceId: newTask.id, targetId: link.targetId, linkType: link.linkType });
  }

  // Create subtasks
  for (const subtaskTitle of createPendingSubtasks) {
    const subtask = {
      id: nextTaskId(),
      title: subtaskTitle,
      description: '',
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      storyPoints: 0,
      tags: [],
      type: 'subtask',
      sprintId: newTask.sprintId,
      parentId: newTask.id,
      linkedIssues: [],
      createdAt: new Date().toISOString()
    };
    state.tasks.push(subtask);
    await logEvent('subtask_created', { taskId: subtask.id, parentId: newTask.id, title: subtaskTitle });
  }

  if (createPendingSubtasks.length > 0) {
    renderBoard();
    await saveState();
  }
}

// ======================================================
// SEARCH & FILTER
// ======================================================
function setupFilters() {
  // Assignee
  const filterAssignee = document.getElementById('filter-assignee');
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name;
    filterAssignee.appendChild(opt);
  });

  // Tag
  const filterTag = document.getElementById('filter-tag');
  state.tags.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag.id;
    opt.textContent = tag.name;
    filterTag.appendChild(opt);
  });

  // Avatar filter buttons
  const avatarFilter = document.getElementById('avatar-filter');
  if (avatarFilter) {
    state.users.forEach(u => {
      const btn = document.createElement('button');
      btn.className = 'avatar-filter-btn';
      btn.id = 'avatar-filter-' + u.id;
      btn.style.background = u.color;
      btn.textContent = u.avatar;
      btn.title = u.name;
      btn.setAttribute('aria-label', 'Filter by ' + u.name);
      btn.dataset.userId = u.id;
      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        // Toggle: if already active, clear; otherwise set this user
        const newValue = isActive ? '' : u.id;
        onFilterChange('assignee', newValue);
      });
      avatarFilter.appendChild(btn);
    });
  }
}

async function onFilterChange(filterType, value) {
  state.filters[filterType] = value;

  const ids = {
    assignee: 'filter-assignee',
    priority: 'filter-priority',
    tag: 'filter-tag',
    type: 'filter-type'
  };
  if (ids[filterType]) {
    const el = document.getElementById(ids[filterType]);
    if (el) {
      el.classList.toggle('active', !!value);
      if (el.value !== value) el.value = value;
    }
  }

  // Sync avatar filter buttons with assignee state
  if (filterType === 'assignee') {
    document.querySelectorAll('.avatar-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.userId === value);
    });
  }

  if (state.currentView === 'backlog') {
    renderBacklog();
  } else {
    state.tasks.forEach(task => {
      const cardEl = document.querySelector(`.card[data-id="${task.id}"]`);
      if (cardEl) {
        if (!taskMatchesFilters(task)) {
          cardEl.classList.add('hidden');
        } else {
          cardEl.classList.remove('hidden');
        }
      }
    });

    updateColumnCounts();
  }

  await logEvent('filter_applied', {
    filterType,
    value,
    activeFilters: { ...state.filters }
  });
}

function clearAllFilters() {
  state.filters = { search: '', assignee: '', priority: '', tag: '', type: '' };
  document.getElementById('search-input').value = '';
  document.getElementById('filter-assignee').value = '';
  document.getElementById('filter-priority').value = '';
  document.getElementById('filter-tag').value = '';
  const filterType = document.getElementById('filter-type');
  if (filterType) filterType.value = '';
  document.getElementById('search-clear').classList.remove('visible');

  document.querySelectorAll('.filter-select.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.avatar-filter-btn.active').forEach(el => el.classList.remove('active'));

  document.querySelectorAll('.card.hidden').forEach(el => el.classList.remove('hidden'));
  updateColumnCounts();
  if (state.currentView === 'backlog') renderBacklog();
}

// ======================================================
// SIDEBAR COLLAPSE
// ======================================================
function setupSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle  = document.getElementById('sidebar-toggle');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
}

// ======================================================
// EVENT LISTENERS
// ======================================================
function setupEventListeners() {
  setupSidebar();

  // Theme dots
  document.querySelectorAll('.theme-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const theme = dot.dataset.theme;
      applyTheme(theme);
      await logEvent('theme_changed', { theme });
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');

  let searchTimeout;
  searchInput.addEventListener('input', () => {
    const value = searchInput.value;
    searchClear.classList.toggle('visible', value.length > 0);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      onFilterChange('search', value);
    }, 200);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.remove('visible');
    onFilterChange('search', '');
  });

  // Filter selects
  document.getElementById('filter-assignee').addEventListener('change', e => {
    onFilterChange('assignee', e.target.value);
  });
  document.getElementById('filter-priority').addEventListener('change', e => {
    onFilterChange('priority', e.target.value);
  });
  document.getElementById('filter-tag').addEventListener('change', e => {
    onFilterChange('tag', e.target.value);
  });
  const filterType = document.getElementById('filter-type');
  if (filterType) {
    filterType.addEventListener('change', e => {
      onFilterChange('type', e.target.value);
    });
  }

  // Clear filters
  document.getElementById('btn-clear-filters').addEventListener('click', clearAllFilters);

  // Create Issue buttons
  document.querySelectorAll('.btn-create-issue').forEach(btn => {
    btn.addEventListener('click', () => {
      openCreateModal(btn.dataset.status);
    });
  });

  // Card modal
  document.getElementById('modal-close').addEventListener('click', closeCardModal);
  document.getElementById('modal-cancel').addEventListener('click', closeCardModal);
  document.getElementById('modal-save').addEventListener('click', saveCardModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeCardModal();
  });

  // Create modal
  document.getElementById('create-modal-close').addEventListener('click', closeCreateModal);
  document.getElementById('create-cancel').addEventListener('click', closeCreateModal);
  document.getElementById('create-submit').addEventListener('click', submitCreateModal);
  document.getElementById('create-modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('create-modal-overlay')) closeCreateModal();
  });

  // Sprint modal
  const sprintModalOverlay = document.getElementById('sprint-modal-overlay');
  if (sprintModalOverlay) {
    sprintModalOverlay.addEventListener('click', e => {
      if (e.target === sprintModalOverlay) closeSprintModal();
    });
  }
  const sprintCloseBtn = document.getElementById('sprint-modal-close');
  if (sprintCloseBtn) sprintCloseBtn.addEventListener('click', closeSprintModal);

  const createSprintBtn = document.getElementById('btn-create-sprint');
  if (createSprintBtn) createSprintBtn.addEventListener('click', createSprint);

  // Sprints view create button
  const sprintsCreateBtn = document.getElementById('sprints-create-btn');
  if (sprintsCreateBtn) sprintsCreateBtn.addEventListener('click', openSprintModal);

  // Sidebar sprint button removed — sprints now accessed via Sprints tab
  // const sidebarSprintBtn = document.getElementById('sidebar-sprint-btn');
  // if (sidebarSprintBtn) sidebarSprintBtn.addEventListener('click', openSprintModal);

  // Backlog create issue button — new tasks stay in backlog (no sprint assigned)
  const backlogCreateBtn = document.getElementById('backlog-create-btn');
  if (backlogCreateBtn) {
    backlogCreateBtn.addEventListener('click', () => openCreateModal('todo', null, true));
  }

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('modal-overlay').style.display !== 'none') closeCardModal();
      if (document.getElementById('create-modal-overlay').style.display !== 'none') closeCreateModal();
      if (sprintModalOverlay && sprintModalOverlay.style.display !== 'none') closeSprintModal();
    }
    if (e.key === 'Enter') {
      if (document.getElementById('create-modal-overlay').style.display !== 'none') {
        // If subtask input is focused, add subtask instead of submitting
        if (document.activeElement && document.activeElement.id === 'create-subtask-title-input') {
          e.preventDefault();
          const btn = document.getElementById('create-add-subtask-btn');
          if (btn) btn.click();
          return;
        }
        submitCreateModal();
      }
    }
  });

  // Nav links
  document.querySelectorAll('.nav-item[data-view]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      showView(link.dataset.view);
    });
  });
}

// ======================================================
// INIT
// ======================================================
async function init() {
  try {
    const resp = await fetch('/api/data');
    if (!resp.ok) throw new Error('Failed to fetch data');
    const data = await resp.json();

    state.tasks   = data.tasks   || [];
    state.users   = data.users   || [];
    state.tags    = data.tags    || [];
    state.sprints = data.sprints || [];

    loadTheme();
    setupFilters();
    renderBoard();
    renderSprintBanner();
    renderSprintSidebar();
    renderCompleteSprintButton();
    setupColumnDropTargets();
    setupEventListeners();

    await saveState();
  } catch (err) {
    console.error('Init failed:', err);
    document.getElementById('board').innerHTML =
      '<div style="padding:32px;color:red;">Failed to load board data. Make sure the server is running.</div>';
  }
}

document.addEventListener('DOMContentLoaded', init);
