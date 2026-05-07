/* ===== STATE ===== */
const STATE = {
  emails: [],
  folders: [],
  currentFolder: 'inbox',
  currentTab: 'focused',   // 'focused' | 'other'
  currentFilter: null,     // null | 'unread' | 'flagged' | 'hasfiles'
  selectedId: null,
  checkedIds: new Set(),   // multi-select checked email ids
  searchQuery: '',
  composeMode: null,        // null | 'new' | 'reply' | 'reply-all' | 'forward' | 'draft'
  composeReplyTo: null,     // email object being replied to
  composeDraftId: null,     // id of draft being edited
  composeToChips: [],       // chip-based To recipients
  composeCcChips: [],       // chip-based Cc recipients
};

/* ===== AVATAR COLOR HELPER ===== */
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xff;
  return `avatar-${h % 10}`;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/* ===== TIME FORMATTING ===== */
// All timestamps in this app encode wall-clock time in the UTC position
// (seed data uses Z-suffix but means local time; server's localNowAsUTC does
// the same for new emails).  So we always read/display via getUTC* methods.
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
  const isToday = d.getUTCFullYear() === todayY &&
                  d.getUTCMonth() === todayM &&
                  d.getUTCDate() === todayD;
  if (isToday) {
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
  }
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function isToday(ts) {
  const d = new Date(ts);
  const now = new Date();
  return d.getUTCFullYear() === now.getFullYear() &&
         d.getUTCMonth() === now.getMonth() &&
         d.getUTCDate() === now.getDate();
}

function formatFullTimestamp(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}, ${h12}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ${ap}`;
}

/* ===== SERVER HELPERS ===== */

/* ---- Inbox toast notification ---- */
function showInboxToast(email) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const senderName = email.from ? email.from.name : 'Unknown';
  const colorClass = avatarColor(senderName);
  toast.innerHTML = `
    <div class="toast-avatar ${colorClass}">${initials(senderName)}</div>
    <div class="toast-body">
      <div class="toast-header">Email &middot; Inbox</div>
      <div class="toast-sender">${senderName}</div>
      <div class="toast-subject">${email.subject || '(no subject)'}</div>
    </div>
    <button class="toast-close">&times;</button>`;
  const dismiss = () => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  };
  toast.querySelector('.toast-close').addEventListener('click', e => { e.stopPropagation(); dismiss(); });
  toast.addEventListener('click', () => {
    dismiss();
    STATE.currentFolder = 'inbox';
    STATE.selectedId = email.id;
    renderSidebar();
    renderEmailList();
    renderReadingPane();
  });
  container.appendChild(toast);
  setTimeout(dismiss, 5000);
}

async function patchEmail(id, changes) {
  const res = await fetch(`/api/emails/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  return res.json();
}

async function reactToEmail(id, emoji) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const reactions = { ...(STATE.emails[idx].reactions || {}) };
  reactions[emoji] = (reactions[emoji] || 0) + 1;
  STATE.emails[idx].reactions = reactions;
  await patchEmail(id, { reactions });
  renderReadingPane();
  renderEmailList();
}

async function createEmail(data) {
  const res = await fetch('/api/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function deleteEmailReq(id) {
  const res = await fetch(`/api/emails/${id}`, { method: 'DELETE' });
  return res.json();
}

async function logEvent(data) {
  return fetch('/log-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, ts: new Date().toISOString() }),
  });
}

async function saveState() {
  return fetch('/save-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: STATE.emails, folders: STATE.folders, calendarEvents: (typeof CAL_STATE !== 'undefined' ? CAL_STATE.events : []) }),
  });
}

/* ===== RENDER SIDEBAR ===== */
const FOLDER_ICONS = {
  inbox:   `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6 3C4.34315 3 3 4.34315 3 6V14C3 15.6569 4.34315 17 6 17H14C15.6569 17 17 15.6569 17 14V6C17 4.34315 15.6569 3 14 3H6ZM16 10H12.5C12.2239 10 12 10.223 12 10.4991L11.9997 10.5114C11.9993 10.5238 11.9983 10.5443 11.9964 10.5718C11.9925 10.6269 11.9843 10.7088 11.9677 10.8084C11.9341 11.0101 11.8679 11.2713 11.7403 11.5264C11.6137 11.7796 11.4317 12.0176 11.168 12.1933C10.9074 12.3671 10.5375 12.5 10 12.5C9.46249 12.5 9.0926 12.3671 8.83204 12.1933C8.56834 12.0176 8.38631 11.7796 8.25971 11.5264C8.13214 11.2713 8.06586 11.0101 8.03226 10.8084C8.01565 10.7088 8.00755 10.6269 8.00361 10.5718C8.00165 10.5443 8.00075 10.5238 8.00033 10.5114L8 10.4994C7.99966 10.2235 7.77594 10 7.5 10H4V6C4 4.89543 4.89543 4 6 4H14C15.1046 4 16 4.89543 16 6V10ZM4 11H7.0505C7.09652 11.2643 7.18655 11.6161 7.36529 11.9736C7.55119 12.3454 7.83791 12.7324 8.27734 13.0254C8.7199 13.3204 9.28751 13.5 10 13.5C10.7125 13.5 11.2801 13.3204 11.7227 13.0254C12.1621 12.7324 12.4488 12.3454 12.6347 11.9736C12.8134 11.6161 12.9035 11.2643 12.9495 11H16V14C16 15.1046 15.1046 16 14 16H6C4.89543 16 4 15.1046 4 14V11Z"/></svg>`,
  sent:    `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2.18412 2.11244C2.33657 1.98818 2.54771 1.96483 2.72363 2.05279L17.7236 9.55279C17.893 9.63749 18 9.81062 18 10C18 10.1894 17.893 10.3625 17.7236 10.4472L2.72363 17.9472C2.54771 18.0352 2.33657 18.0118 2.18412 17.8876C2.03167 17.7633 1.96623 17.5612 2.0169 17.3712L3.98255 10L2.0169 2.62884C1.96623 2.4388 2.03167 2.2367 2.18412 2.11244ZM4.88416 10.5L3.26911 16.5564L16.382 10L3.26911 3.44357L4.88416 9.5H11.5C11.7762 9.5 12 9.72386 12 10C12 10.2761 11.7762 10.5 11.5 10.5H4.88416Z"/></svg>`,
  drafts:  `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M15.5 3.00098C16.8807 3.00098 18 4.12026 18 5.50098V9.13392C17.6757 9.03129 17.3368 8.98764 17 9.003V6.96198L10.2535 10.9319C10.1231 11.0086 9.96661 11.0214 9.82751 10.9703L9.74649 10.9319L3 6.96398V13.501C3 14.3294 3.67157 15.001 4.5 15.001H9.98428C9.7571 15.301 9.58423 15.6395 9.47436 16.001H4.5C3.11929 16.001 2 14.8817 2 13.501V5.50098C2 4.12026 3.11929 3.00098 4.5 3.00098H15.5ZM15.5 4.00098H4.5C3.67157 4.00098 3 4.67255 3 5.50098V5.80298L10 9.92089L17 5.80198V5.50098C17 4.67255 16.3284 4.00098 15.5 4.00098ZM10.9798 15.3772L15.8092 10.5478C16.5395 9.81741 17.7237 9.81741 18.454 10.5478C19.1843 11.2781 19.1843 12.4622 18.454 13.1926L13.6246 18.022C13.343 18.3036 12.9902 18.5033 12.6039 18.5999L11.106 18.9744C10.4546 19.1372 9.86451 18.5472 10.0274 17.8958L10.4018 16.3979C10.4984 16.0116 10.6982 15.6588 10.9798 15.3772Z"/></svg>`,
  deleted: `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 4H11.5C11.5 3.17157 10.8284 2.5 10 2.5C9.17157 2.5 8.5 3.17157 8.5 4ZM7.5 4C7.5 2.61929 8.61929 1.5 10 1.5C11.3807 1.5 12.5 2.61929 12.5 4H17.5C17.7761 4 18 4.22386 18 4.5C18 4.77614 17.7761 5 17.5 5H16.4456L15.2521 15.3439C15.0774 16.8576 13.7957 18 12.2719 18H7.72813C6.20431 18 4.92256 16.8576 4.7479 15.3439L3.55437 5H2.5C2.22386 5 2 4.77614 2 4.5C2 4.22386 2.22386 4 2.5 4H7.5ZM5.74131 15.2292C5.85775 16.2384 6.71225 17 7.72813 17H12.2719C13.2878 17 14.1422 16.2384 14.2587 15.2292L15.439 5H4.56101L5.74131 15.2292ZM8.5 7.5C8.77614 7.5 9 7.72386 9 8V14C9 14.2761 8.77614 14.5 8.5 14.5C8.22386 14.5 8 14.2761 8 14V8C8 7.72386 8.22386 7.5 8.5 7.5ZM12 8C12 7.72386 11.7761 7.5 11.5 7.5C11.2239 7.5 11 7.72386 11 8V14C11 14.2761 11.2239 14.5 11.5 14.5C11.7761 14.5 12 14.2761 12 14V8Z"/></svg>`,
  junk:    `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.2774 2.08397C10.1094 1.97201 9.8906 1.97201 9.72265 2.08397C7.78446 3.3761 5.68833 4.1823 3.42929 4.50503C3.18296 4.54021 3 4.75117 3 5V9.5C3 13.3913 5.30699 16.2307 9.82051 17.9667C9.93605 18.0111 10.064 18.0111 10.1795 17.9667C10.2036 17.9574 10.2277 17.9481 10.2517 17.9387C9.70399 17.5373 9.23336 17.0369 8.86611 16.4639C5.59857 14.8665 4 12.5572 4 9.5V5.42787C5.98541 5.09055 7.85275 4.39606 9.59914 3.34583L10 3.09715L10.4009 3.34583C12.1473 4.39606 14.0146 5.09055 16 5.42787V8.59971C16.3578 8.78261 16.6929 9.00353 17 9.25716V5C17 4.75117 16.817 4.54021 16.5707 4.50503C14.3117 4.1823 12.2155 3.3761 10.2774 2.08397ZM10.6968 15.596L15.596 10.6968C15.0118 10.2592 14.2861 10 13.5 10C11.567 10 10 11.567 10 13.5C10 14.2861 10.2592 15.0118 10.6968 15.596ZM11.4039 16.3032C11.9882 16.7408 12.7138 17 13.5 17C15.433 17 17 15.433 17 13.5C17 12.7138 16.7408 11.9882 16.3032 11.4039L11.4039 16.3032ZM13.5 18C11.0147 18 9 15.9853 9 13.5C9 11.0147 11.0147 9 13.5 9C15.9853 9 18 11.0147 18 13.5C18 15.9853 15.9853 18 13.5 18Z"/></svg>`,
  archive: `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 10C8.22386 10 8 10.2239 8 10.5C8 10.7761 8.22386 11 8.5 11H11.5C11.7761 11 12 10.7761 12 10.5C12 10.2239 11.7761 10 11.5 10H8.5ZM2 4.75C2 3.7835 2.7835 3 3.75 3H16.25C17.2165 3 18 3.7835 18 4.75V6.25C18 6.9481 17.5912 7.55073 17 7.83159V14C17 15.6569 15.6569 17 14 17H6C4.34315 17 3 15.6569 3 14V7.83159C2.40876 7.55073 2 6.9481 2 6.25V4.75ZM3.75 4C3.33579 4 3 4.33579 3 4.75V6.25C3 6.66421 3.33579 7 3.75 7H16.25C16.6642 7 17 6.66421 17 6.25V4.75C17 4.33579 16.6642 4 16.25 4H3.75ZM4 8V14C4 15.1046 4.89543 16 6 16H14C15.1046 16 16 15.1046 16 14V8H4Z"/></svg>`,
};

const DEFAULT_FOLDER_ICON = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 6a1 1 0 011-1h4l2 2h7a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V6z"/></svg>`;

function renderSidebar() {
  const list = document.getElementById('folder-list');
  list.innerHTML = '';

  STATE.folders.forEach(folder => {
    const li = document.createElement('li');
    li.className = `folder-item${folder.id === STATE.currentFolder ? ' active' : ''}`;
    li.id = 'folder-' + folder.id;
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');    li.dataset.folder = folder.id;
    li.innerHTML = `
      <span class="folder-icon">${FOLDER_ICONS[folder.id] || DEFAULT_FOLDER_ICON}</span>
      <span class="folder-name">${folder.name}</span>
      ${folder.count > 0 ? `<span class="folder-badge">${folder.count}</span>` : ''}
    `;
    li.addEventListener('click', () => selectFolder(folder.id));
    list.appendChild(li);
  });
}

/* ===== RENDER EMAIL LIST ===== */
function getVisibleEmails() {
  let emails = STATE.searchQuery
    ? STATE.emails
    : STATE.emails.filter(e => e.folder === STATE.currentFolder);

  if (STATE.searchQuery) {
    const q = STATE.searchQuery.toLowerCase();
    emails = emails.filter(e =>
      e.subject.toLowerCase().includes(q) ||
      e.from.name.toLowerCase().includes(q) ||
      e.from.email.toLowerCase().includes(q) ||
      e.body.replace(/<[^>]+>/g, '').toLowerCase().includes(q)
    );
  }

  if (STATE.currentFolder === 'inbox' && !STATE.searchQuery) {
    emails = emails.filter(e =>
      STATE.currentTab === 'focused' ? e.focused : !e.focused
    );
  }

  if (STATE.currentFilter === 'unread') emails = emails.filter(e => !e.read);
  else if (STATE.currentFilter === 'flagged') emails = emails.filter(e => e.flagged);
  else if (STATE.currentFilter === 'hasfiles') emails = emails.filter(e => e.hasAttachment);

  return emails;
}

function renderEmailList() {
  const emails = getVisibleEmails();

  const showTabRow = STATE.currentFolder === 'inbox' && !STATE.searchQuery;
  const tabsFilterRow = document.getElementById('tabs-filter-row');
  if (tabsFilterRow) tabsFilterRow.style.display = showTabRow ? 'flex' : 'none';

  // Update filter label
  const filterLabel = document.getElementById('filter-label');
  const filterToggle = document.getElementById('filter-toggle');
  if (filterLabel) {
    const labels = { unread: 'Unread', flagged: 'Flagged', hasfiles: 'Has Files' };
    filterLabel.textContent = STATE.currentFilter ? labels[STATE.currentFilter] : 'Filter';
  }
  if (filterToggle) filterToggle.classList.toggle('active', !!STATE.currentFilter);
  document.querySelectorAll('.filter-option').forEach(btn => {
    const isActive = btn.dataset.filter === (STATE.currentFilter || 'all');
    btn.classList.toggle('active', isActive);
  });

  // Split into pinned / today / older
  const pinned = emails.filter(e => e.pinned);
  const unpinned = emails.filter(e => !e.pinned);
  const today = unpinned.filter(e => isToday(e.timestamp));
  const older = unpinned.filter(e => !isToday(e.timestamp));

  // Sort each group newest first
  const byTime = (a, b) => new Date(b.timestamp) - new Date(a.timestamp);
  pinned.sort(byTime); today.sort(byTime); older.sort(byTime);

  const pinnedSection = document.getElementById('pinned-section');
  const todaySection = document.getElementById('today-section');
  const olderSection = document.getElementById('older-section');
  const emptyState = document.getElementById('empty-state');

  pinnedSection.hidden = pinned.length === 0;
  todaySection.hidden = today.length === 0;
  olderSection.hidden = older.length === 0;
  emptyState.hidden = emails.length > 0;

  document.getElementById('pinned-emails').innerHTML = pinned.map(renderEmailCard).join('');
  document.getElementById('today-emails').innerHTML = today.map(renderEmailCard).join('');
  document.getElementById('older-emails').innerHTML = older.map(renderEmailCard).join('');
  renderBulkActionBar();
}

/* ===== RENDER SINGLE EMAIL CARD ===== */
function renderEmailCard(email) {
  const isSelected = email.id === STATE.selectedId;
  const isChecked = STATE.checkedIds.has(email.id);
  const isDraft = email.folder === 'drafts';
  const classes = [
    'email-card',
    (!email.read && !isDraft) ? 'unread' : 'read',
    isSelected ? 'selected' : '',
    isChecked ? 'checked' : '',
  ].filter(Boolean).join(' ');

  const av = initials(email.from.name);
  const avClass = avatarColor(email.from.name);

  const FLAG_SVG_OUTLINE = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3v14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 3h10l-3 4.5L15 12H5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const FLAG_SVG_FILLED  = `<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M5 3v14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 3h10l-3 4.5L15 12H5" fill="currentColor" opacity="0.9"/></svg>`;
  const PIN_SVG_OUTLINE  = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.1221 3.13715C10.7326 1.91616 12.3599 1.65208 13.3251 2.61737L17.382 6.67419C18.3472 7.63947 18.0832 9.26676 16.8622 9.87726L13.4037 11.6065C13.0751 11.7708 12.8183 12.0499 12.6818 12.391L11.2459 15.981C10.9792 16.6476 10.1179 16.8244 9.61027 16.3167L7 13.7064L3.70711 16.9993H3V16.2922L6.29289 12.9993L3.68262 10.3891C3.17498 9.88142 3.35177 9.02011 4.01834 8.75348L7.60829 7.3175C7.94939 7.18106 8.22855 6.92419 8.39285 6.5956L10.1221 3.13715Z" stroke="currentColor" stroke-width="1" fill="none"/></svg>`;
  const PIN_SVG_FILLED   = `<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.1221 3.13715C10.7326 1.91616 12.3599 1.65208 13.3251 2.61737L17.382 6.67419C18.3472 7.63947 18.0832 9.26676 16.8622 9.87726L13.4037 11.6065C13.0751 11.7708 12.8183 12.0499 12.6818 12.391L11.2459 15.981C10.9792 16.6476 10.1179 16.8244 9.61027 16.3167L7 13.7064L3.70711 16.9993H3V16.2922L6.29289 12.9993L3.68262 10.3891C3.17498 9.88142 3.35177 9.02011 4.01834 8.75348L7.60829 7.3175C7.94939 7.18106 8.22855 6.92419 8.39285 6.5956L10.1221 3.13715Z"/></svg>`;
  const CLIP_SVG = `<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M9.5 2a4.5 4.5 0 00-4.5 4.5v7a6 6 0 0012 0V5.5a.5.5 0 011 0V13.5a7 7 0 01-14 0v-7a5.5 5.5 0 0111 0V13a3 3 0 01-6 0V6.5a.5.5 0 011 0V13a2 2 0 004 0V6.5A4.5 4.5 0 009.5 2z"/></svg>`;

  const meta = [
    email.hasAttachment ? `<span class="attachment-icon" title="Has attachment">${CLIP_SVG}</span>` : '',
    email.category && email.category !== 'none' ? `<span class="email-cat-pill cat-${email.category}" title="Category: ${email.category}"></span>` : '',
  ].filter(Boolean).join('');

  const folderTag = (() => {
    if (!STATE.searchQuery) return '';
    const folder = STATE.folders.find(f => f.id === email.folder);
    const name = folder ? folder.name : email.folder;
    return `<span class="email-card-folder-tag">${escapeHtml(name)}</span>`;
  })();

  return `
    <div class="${classes}" data-id="${email.id}" id="email-${email.id}" role="option" aria-label="${escapeHtml(email.from.name)} - ${escapeHtml(email.subject)}" tabindex="0">
      <div class="email-card-select-col">
        <div class="email-card-unread-dot-wrap">
          ${(!email.read && !isDraft) ? '<div class="unread-dot"></div>' : ''}
        </div>
        <input type="checkbox" class="email-card-checkbox" id="check-${email.id}" data-id="${email.id}" ${isChecked ? 'checked' : ''} tabindex="-1" aria-label="Select email">
      </div>
      <div class="email-card-avatar ${avClass}">${av}</div>
      <div class="email-card-sender-row">
        <div class="email-card-sender">${escapeHtml(email.from.name)}${email.isExternal ? ' <span class="external-badge">[External]</span>' : ''}</div>
        <span class="email-card-time">${formatTime(email.timestamp)}</span>
      </div>
      <div class="email-card-flag-pin">
        <button class="card-action-btn card-flag-btn${email.flagged ? ' active' : ''}" id="flag-btn-${email.id}" data-id="${email.id}" title="Flag" tabindex="-1">
          ${email.flagged ? FLAG_SVG_FILLED : FLAG_SVG_OUTLINE}
        </button>
        <button class="card-action-btn card-pin-btn${email.pinned ? ' active' : ''}" id="pin-btn-${email.id}" data-id="${email.id}" title="Pin" tabindex="-1">
          ${email.pinned ? PIN_SVG_FILLED : PIN_SVG_OUTLINE}
        </button>
      </div>
      <div class="email-card-delete-col">
        <button class="card-action-btn card-delete-btn" id="delete-btn-${email.id}" data-id="${email.id}" title="Delete" tabindex="-1">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M8 4h4M3 6h14M5 6l1 10a1 1 0 001 1h6a1 1 0 001-1L15 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 9v5M11.5 9v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="email-card-subject">${isDraft ? '<span class="draft-label">[Draft]</span>' : ''}${escapeHtml(email.subject)}</div>
      ${(meta || folderTag) ? `<div class="email-card-flags">${meta}${folderTag}</div>` : ''}
      ${(() => {
        const reactions = email.reactions || {};
        const pills = Object.entries(reactions).filter(([, c]) => c > 0)
          .map(([emoji, count]) => `<span class="card-reaction-pill">${emoji} ${count}</span>`).join('');
        return pills ? `<div class="email-card-reactions">${pills}</div>` : '';
      })()}
    </div>
  `;
}

/* ===== RENDER READING PANE ===== */
function renderReadingPane() {
  const content = document.getElementById('reading-pane-content');
  const empty = document.getElementById('reading-pane-empty');
  const compose = document.getElementById('compose-modal');

  if (!STATE.selectedId) {
    content.hidden = true;
    compose.hidden = true;
    empty.hidden = false;
    return;
  }

  const email = STATE.emails.find(e => e.id === STATE.selectedId);
  if (!email) {
    content.hidden = true;
    compose.hidden = true;
    empty.hidden = false;
    return;
  }

  content.hidden = false;
  compose.hidden = true;
  empty.hidden = true;

  document.getElementById('rp-subject').textContent = email.subject;

  const fromAv = document.getElementById('rp-from-avatar');
  fromAv.textContent = initials(email.from.name);
  fromAv.className = `avatar ${avatarColor(email.from.name)}`;

  document.getElementById('rp-from-name').textContent = email.from.name;
  const extBadge = document.getElementById('rp-external-badge');
  if (extBadge) extBadge.hidden = !email.isExternal;
  document.getElementById('rp-from-email').textContent = `<${email.from.email}>`;
  document.getElementById('rp-timestamp').textContent = formatFullTimestamp(email.timestamp);

  const toNames = email.to.map(t => t.name || t.email).join(', ');
  document.getElementById('rp-to').textContent = toNames;

  document.getElementById('rp-body').innerHTML = email.body;

  // Meeting invite inline RSVP bar
  const inviteBar = document.getElementById('rp-meeting-invite-bar');
  if (email.isMeetingInvite && email.eventId) {
    inviteBar.hidden = false;
    inviteBar.innerHTML = '';
    const calEvent = CAL_STATE.events.find(e => e.id === email.eventId);
    const currentRsvp = calEvent ? calEvent.rsvp : 'none';
    const rsvpOptions = [
      { rsvp: 'accepted', label: 'Accept' },
      { rsvp: 'tentative', label: 'Tentative' },
      { rsvp: 'declined', label: 'Decline' },
    ];
    const bar = document.createElement('div');
    bar.className = 'rp-invite-bar';
    bar.innerHTML = `<span class="rp-invite-label">Respond:</span>`;
    rsvpOptions.forEach(({ rsvp, label }) => {
      const btn = document.createElement('button');
      btn.className = 'rp-invite-btn' + (currentRsvp === rsvp ? ' active' : '');
      btn.textContent = label;
      btn.onclick = async () => {
        if (!email.eventId) return;
        const res = await fetch(`/api/events/${email.eventId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rsvp }),
        });
        const updated = await res.json();
        const idx = CAL_STATE.events.findIndex(e => e.id === email.eventId);
        if (idx !== -1) CAL_STATE.events[idx] = updated;
        logEvent({ type: 'event_rsvp_changed', eventId: email.eventId, title: updated.title, rsvp });
        // Send RSVP reply email to host
        if (updated.host && updated.host !== CURRENT_USER) {
          const rsvpLabels = { accepted: 'Accepted', tentative: 'Tentatively Accepted', declined: 'Declined' };
          const lbl = rsvpLabels[rsvp] || rsvp;
          const fmt = t => { const [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''} ${ap}`; };
          const timeStr = updated.allDay ? 'All day' : `${fmt(updated.startTime)} – ${fmt(updated.endTime)}`;
          const sentEmail = await createEmail({
            to: [{ name: emailToDisplayName(updated.host), email: updated.host }],
            subject: `${lbl}: ${updated.title}`,
            body: `<p>${emailToDisplayName(CURRENT_USER)} has <strong>${lbl.toLowerCase()}</strong> the meeting invite.</p><p><strong>${updated.title}</strong><br>${updated.date} &nbsp; ${timeStr}${updated.location ? '<br>' + updated.location : ''}</p>`,
            folder: 'sent',
          });
          STATE.emails.push(sentEmail);
        }
        await saveState();
        renderCalendar();
        renderReadingPane();
        renderEmailList();
        renderSidebar();
      };
      bar.appendChild(btn);
    });
    inviteBar.appendChild(bar);
  } else {
    inviteBar.hidden = true;
  }

  // Reaction pills below inline actions
  const reactionsWrap = document.getElementById('rp-reactions');
  const reactions = email.reactions || {};
  const reactionEntries = Object.entries(reactions).filter(([, count]) => count > 0);
  reactionsWrap.innerHTML = reactionEntries
    .map(([emoji, count]) => `<span class="rp-reaction-pill">${emoji} <span class="rp-reaction-count">${count}</span></span>`)
    .join('');
  reactionsWrap.hidden = reactionEntries.length === 0;

  const readBtn = document.getElementById('ribbon-read');
  if (readBtn) {
    readBtn.classList.remove('active');
  }

  // Attachments bar
  const attachWrap = document.getElementById('rp-attachments');
  const attachments = email.attachments || [];
  if (attachments.length > 0) {
    attachWrap.hidden = false;
    attachWrap.innerHTML = `
      <div class="rp-attach-list">
        ${attachments.map((a, i) => `
          <button class="rp-attach-chip" data-email-id="${escapeHtml(email.id)}" data-attach-idx="${i}" title="Download ${escapeHtml(a.name)}">
            <span class="rp-attach-icon">${attachIconSvg(a.name)}</span>
            <span class="rp-attach-info">
              <span class="rp-attach-name">${escapeHtml(a.name)}</span>
              <span class="rp-attach-size">${formatFileSize(a.size)}</span>
            </span>
          </button>
        `).join('')}
      </div>
      <button class="rp-attach-download-all" data-email-id="${escapeHtml(email.id)}">Download all</button>
    `;
  } else {
    attachWrap.hidden = true;
    attachWrap.innerHTML = '';
  }
}

/* ===== SELECT EMAIL ===== */
async function selectEmail(id) {
  await autoSaveDraftIfComposing();
  const email = STATE.emails.find(e => e.id === id);
  if (!email) return;

  // Drafts open in compose instead of the reading pane
  if (email.folder === 'drafts') {
    STATE.selectedId = id;
    renderEmailList();
    openCompose('draft', null, email);
    return;
  }

  STATE.selectedId = id;

  // Render immediately so selection feels instant
  renderEmailList();
  renderReadingPane();

  // Mark read in background — only re-render list/sidebar, not the reading pane
  if (!email.read) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    STATE.emails[idx].read = true;
    await patchEmail(id, { read: true });
    await logEvent({ type: 'email_read', emailId: id, subject: STATE.emails[idx].subject });
    refreshFolderCounts();
    await saveState();
    renderEmailList();
    renderSidebar();
  }
}

/* ===== FLAG EMAIL ===== */
async function flagEmail(id) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const newVal = !STATE.emails[idx].flagged;
  STATE.emails[idx].flagged = newVal;
  await patchEmail(id, { flagged: newVal });
  await logEvent({ type: 'email_flagged', emailId: id, flagged: newVal, subject: STATE.emails[idx].subject });
  await saveState();
  renderEmailList();
  renderReadingPane();
}

/* ===== PIN EMAIL ===== */
async function pinEmail(id) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const newVal = !STATE.emails[idx].pinned;
  STATE.emails[idx].pinned = newVal;
  await patchEmail(id, { pinned: newVal });
  await logEvent({ type: 'email_pinned', emailId: id, pinned: newVal, subject: STATE.emails[idx].subject });
  await saveState();
  renderEmailList();
  renderReadingPane();
}

/* ===== DELETE EMAIL ===== */
async function deleteEmail(id) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const email = STATE.emails[idx];
  const isPermanent = email.folder === 'deleted';

  if (isPermanent) {
    STATE.emails.splice(idx, 1);
  } else {
    STATE.emails[idx].folder = 'deleted';
  }

  await deleteEmailReq(id);
  await logEvent({
    type: 'email_deleted',
    emailId: id,
    permanent: isPermanent,
    subject: email.subject,
  });

  if (STATE.selectedId === id) STATE.selectedId = null;
  refreshFolderCounts();
  await saveState();
  renderEmailList();
  renderReadingPane();
  renderSidebar();
}

/* ===== MOVE EMAIL ===== */
async function moveEmail(id, targetFolder) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const oldFolder = STATE.emails[idx].folder;
  STATE.emails[idx].folder = targetFolder;
  await patchEmail(id, { folder: targetFolder });
  await logEvent({
    type: 'email_moved',
    emailId: id,
    from: oldFolder,
    to: targetFolder,
    subject: STATE.emails[idx].subject,
  });
  if (STATE.selectedId === id) STATE.selectedId = null;
  refreshFolderCounts();
  await saveState();
  renderEmailList();
  renderReadingPane();
  renderSidebar();
  closeMoveModal();
}

/* ===== ARCHIVE EMAIL ===== */
async function archiveEmail(id) {
  await moveEmail(id, 'archive');
}

/* ===== BULK ACTION BAR ===== */
function renderBulkActionBar() {
  const bar = document.getElementById('bulk-action-bar');
  const count = STATE.checkedIds.size;
  if (!bar) return;
  if (count === 0) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
    document.getElementById('bulk-count').textContent = `${count} selected`;
  }

  // Update the select-all checkbox state
  const selectAllCb = document.getElementById('select-all-checkbox');
  const selectAllText = document.getElementById('select-all-text');
  if (!selectAllCb) return;
  const visible = getVisibleEmails();
  if (visible.length === 0) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
    if (selectAllText) selectAllText.textContent = 'Select all';
  } else {
    const allChecked = visible.every(e => STATE.checkedIds.has(e.id));
    const someChecked = visible.some(e => STATE.checkedIds.has(e.id));
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = someChecked && !allChecked;
    if (selectAllText) selectAllText.textContent = allChecked ? `Deselect all (${visible.length})` : `Select all (${visible.length})`;
  }
}

function selectAllVisible() {
  const visible = getVisibleEmails();
  const allChecked = visible.every(e => STATE.checkedIds.has(e.id));
  if (allChecked) {
    visible.forEach(e => STATE.checkedIds.delete(e.id));
  } else {
    visible.forEach(e => STATE.checkedIds.add(e.id));
  }
  renderEmailList();
}

/* ===== BULK ACTIONS ===== */
async function bulkDelete() {
  const ids = [...STATE.checkedIds];
  for (const id of ids) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    if (idx === -1) continue;
    const email = STATE.emails[idx];
    const isPermanent = email.folder === 'deleted';
    if (isPermanent) {
      STATE.emails.splice(idx, 1);
    } else {
      STATE.emails[idx].folder = 'deleted';
    }
    await deleteEmailReq(id);
    await logEvent({ type: 'email_deleted', emailId: id, permanent: isPermanent, subject: email.subject });
    if (STATE.selectedId === id) STATE.selectedId = null;
  }
  STATE.checkedIds.clear();
  refreshFolderCounts();
  await saveState();
  renderBulkActionBar();
  renderEmailList();
  renderReadingPane();
  renderSidebar();
}

async function bulkMarkRead(read) {
  const ids = [...STATE.checkedIds];
  for (const id of ids) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    if (idx === -1) continue;
    STATE.emails[idx].read = read;
    await patchEmail(id, { read });
  }
  refreshFolderCounts();
  await saveState();
  STATE.checkedIds.clear();
  renderBulkActionBar();
  renderEmailList();
  renderSidebar();
}

async function bulkFlag() {
  const ids = [...STATE.checkedIds];
  // If all are flagged, unflag; otherwise flag all
  const allFlagged = ids.every(id => {
    const e = STATE.emails.find(em => em.id === id);
    return e && e.flagged;
  });
  const newVal = !allFlagged;
  for (const id of ids) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    if (idx === -1) continue;
    STATE.emails[idx].flagged = newVal;
    await patchEmail(id, { flagged: newVal });
    await logEvent({ type: 'email_flagged', emailId: id, flagged: newVal, subject: STATE.emails[idx].subject });
  }
  await saveState();
  STATE.checkedIds.clear();
  renderBulkActionBar();
  renderEmailList();
}

async function bulkPin() {
  const ids = [...STATE.checkedIds];
  const allPinned = ids.every(id => {
    const e = STATE.emails.find(em => em.id === id);
    return e && e.pinned;
  });
  const newVal = !allPinned;
  for (const id of ids) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    if (idx === -1) continue;
    STATE.emails[idx].pinned = newVal;
    await patchEmail(id, { pinned: newVal });
    await logEvent({ type: 'email_pinned', emailId: id, pinned: newVal, subject: STATE.emails[idx].subject });
  }
  await saveState();
  STATE.checkedIds.clear();
  renderBulkActionBar();
  renderEmailList();
}

function bulkMove() {
  openBulkMoveModal();
}

function openBulkMoveModal() {
  const modal = document.getElementById('move-modal');
  const list = document.getElementById('move-folder-list');
  list.innerHTML = '';
  STATE.folders.forEach(folder => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="folder-icon">${FOLDER_ICONS[folder.id] || DEFAULT_FOLDER_ICON}</span> ${folder.name}`;
    li.addEventListener('click', async () => {
      closeMoveModal();
      const ids = [...STATE.checkedIds];
      for (const id of ids) {
        const idx = STATE.emails.findIndex(e => e.id === id);
        if (idx === -1) continue;
        const oldFolder = STATE.emails[idx].folder;
        STATE.emails[idx].folder = folder.id;
        await patchEmail(id, { folder: folder.id });
        await logEvent({ type: 'email_moved', emailId: id, from: oldFolder, to: folder.id, subject: STATE.emails[idx].subject });
        if (STATE.selectedId === id) STATE.selectedId = null;
      }
      refreshFolderCounts();
      await saveState();
      STATE.checkedIds.clear();
      renderBulkActionBar();
      renderEmailList();
      renderReadingPane();
      renderSidebar();
    });
    list.appendChild(li);
  });
  modal.hidden = false;
}

function clearChecked() {
  STATE.checkedIds.clear();
  renderBulkActionBar();
  renderEmailList();
}

async function bulkArchive() {
  const ids = [...STATE.checkedIds];
  for (const id of ids) {
    const idx = STATE.emails.findIndex(e => e.id === id);
    if (idx === -1) continue;
    const oldFolder = STATE.emails[idx].folder;
    STATE.emails[idx].folder = 'archive';
    await patchEmail(id, { folder: 'archive' });
    await logEvent({ type: 'email_moved', emailId: id, from: oldFolder, to: 'archive', subject: STATE.emails[idx].subject });
    if (STATE.selectedId === id) STATE.selectedId = null;
  }
  refreshFolderCounts();
  await saveState();
  STATE.checkedIds.clear();
  renderBulkActionBar();
  renderEmailList();
  renderReadingPane();
  renderSidebar();
}

/* ===== CATEGORY EMAIL ===== */
async function categoryEmail(id, category) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  STATE.emails[idx].category = category;
  renderEmailList();
  renderReadingPane();
  await patchEmail(id, { category });
  await logEvent({ type: 'email_categorized', emailId: id, category });
  await saveState();
}

/* ===== CREATE FOLDER ===== */
function createFolder() {
  const modal = document.getElementById('new-folder-modal');
  document.getElementById('new-folder-input').value = '';
  modal.hidden = false;
  document.getElementById('new-folder-input').focus();
}

async function confirmCreateFolder() {
  const name = document.getElementById('new-folder-input').value.trim();
  if (!name) return;
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to create folder');
    return;
  }
  const folder = await res.json();
  STATE.folders.push({ ...folder, count: 0 });
  await logEvent({ type: 'folder_created', folderId: folder.id, name: folder.name });
  document.getElementById('new-folder-modal').hidden = true;
  renderSidebar();
}

/* ===== SELECT FOLDER ===== */
async function selectFolder(folderId) {
  await autoSaveDraftIfComposing();
  STATE.currentFolder = folderId;
  STATE.selectedId = null;
  STATE.checkedIds.clear();
  STATE.searchQuery = '';
  STATE.currentFilter = null;
  document.getElementById('search-input').value = '';
  await logEvent({ type: 'folder_selected', folder: folderId });
  await saveState();
  renderSidebar();
  renderEmailList();
  renderReadingPane();
}

/* ===== SEARCH ===== */
async function handleSearch(query) {
  STATE.searchQuery = query.trim();
  if (STATE.searchQuery) {
    await logEvent({ type: 'search_performed', query: STATE.searchQuery });
  }
  renderEmailList();
}

/* ===== COMPOSE ===== */
function updateFormatRibbon() {
  const ribbon = document.getElementById('ribbon-format');
  if (!ribbon) return;
  const active = !!STATE.composeMode;
  ribbon.classList.toggle('ribbon-format-disabled', !active);
}

function openCompose(mode = 'new', replyToEmail = null, draftEmail = null, initialEmoji = null) {
  STATE.composeMode = mode;
  STATE.composeReplyTo = replyToEmail;
  STATE.composeDraftId = null;

  const modal = document.getElementById('compose-modal');
  const toInput = document.getElementById('compose-to');
  const ccInput = document.getElementById('compose-cc');
  const subjectInput = document.getElementById('compose-subject');
  const bodyEl = document.getElementById('compose-text-area');

  if (mode === 'new') {
    STATE.composeToChips = [];
    STATE.composeCcChips = [];
    toInput.value = '';
    ccInput.value = '';
    subjectInput.value = '';
    bodyEl.innerHTML = '';
  } else if (mode === 'draft' && draftEmail) {
    STATE.composeDraftId = draftEmail.id;
    STATE.composeToChips = draftEmail.to.map(t => t.email);
    STATE.composeCcChips = [];
    toInput.value = '';
    ccInput.value = '';
    subjectInput.value = draftEmail.subject === '(no subject)' ? '' : draftEmail.subject;
    bodyEl.innerHTML = draftEmail.body;
  } else if (mode === 'reply' && replyToEmail) {
    STATE.composeToChips = [replyToEmail.from.email];
    STATE.composeCcChips = [];
    toInput.value = '';
    ccInput.value = '';
    subjectInput.value = replyToEmail.subject.startsWith('Re:')
      ? replyToEmail.subject
      : `Re: ${replyToEmail.subject}`;
    bodyEl.innerHTML = `<br><br><p>-------- Original Message --------</p><p>From: ${escapeHtml(replyToEmail.from.name)} &lt;${escapeHtml(replyToEmail.from.email)}&gt;</p>${replyToEmail.body}`;
  } else if (mode === 'reply-all' && replyToEmail) {
    STATE.composeToChips = [replyToEmail.from.email, ...replyToEmail.to.map(t => t.email)];
    STATE.composeCcChips = [];
    toInput.value = '';
    ccInput.value = '';
    subjectInput.value = replyToEmail.subject.startsWith('Re:')
      ? replyToEmail.subject
      : `Re: ${replyToEmail.subject}`;
    bodyEl.innerHTML = `<br><br><p>-------- Original Message --------</p><p>From: ${escapeHtml(replyToEmail.from.name)} &lt;${escapeHtml(replyToEmail.from.email)}&gt;</p>${replyToEmail.body}`;
  } else if (mode === 'forward' && replyToEmail) {
    STATE.composeToChips = [];
    STATE.composeCcChips = [];
    toInput.value = '';
    ccInput.value = '';
    subjectInput.value = replyToEmail.subject.startsWith('Fwd:')
      ? replyToEmail.subject
      : `Fwd: ${replyToEmail.subject}`;
    bodyEl.innerHTML = `<br><br><p>-------- Forwarded Message --------</p><p>From: ${escapeHtml(replyToEmail.from.name)} &lt;${escapeHtml(replyToEmail.from.email)}&gt;</p>${replyToEmail.body}`;
  }

  renderComposeChips('compose-to-chips', STATE.composeToChips, 'composeToChips');
  renderComposeChips('compose-cc-chips', STATE.composeCcChips, 'composeCcChips');

  // Show compose pane, hide reading pane views
  document.getElementById('reading-pane-empty').hidden = true;
  document.getElementById('reading-pane-content').hidden = true;
  modal.hidden = false;

  logEvent({ type: 'compose_opened', mode });
  if (initialEmoji) {
    bodyEl.focus();
    const textNode = document.createTextNode(initialEmoji + ' ');
    bodyEl.insertBefore(textNode, bodyEl.firstChild);
    const range = document.createRange();
    range.setStartAfter(textNode);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    toInput.focus();
  }
  updateFormatRibbon();
}

async function closeCompose({ discard = false } = {}) {
  const draftId = STATE.composeDraftId;
  document.getElementById('compose-modal').hidden = true;
  STATE.composeMode = null;
  STATE.composeReplyTo = null;
  STATE.composeDraftId = null;
  STATE.composeToChips = [];
  STATE.composeCcChips = [];
  // Restore correct reading pane view
  if (STATE.selectedId) {
    document.getElementById('reading-pane-content').hidden = false;
  } else {
    document.getElementById('reading-pane-empty').hidden = false;
  }
  // Permanently delete the draft only when explicitly discarding
  if (discard && draftId) {
    // First call moves it to 'deleted', second call permanently removes it
    await fetch(`/api/emails/${draftId}`, { method: 'DELETE' });
    await fetch(`/api/emails/${draftId}`, { method: 'DELETE' });
    STATE.emails = STATE.emails.filter(e => e.id !== draftId);
    if (STATE.selectedId === draftId) STATE.selectedId = null;
    refreshFolderCounts();
    renderEmailList();
    renderSidebar();
  }
  updateFormatRibbon();
}

/* ===== AUTO-SAVE DRAFT ===== */
async function autoSaveDraftIfComposing() {
  if (!STATE.composeMode) return;
  const hasTo = STATE.composeToChips.length > 0 || document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-text-area').innerHTML.trim();
  // Don't save a completely blank compose
  if (!hasTo && !subject && !body) {
    STATE.composeMode = null;
    STATE.composeReplyTo = null;
    STATE.composeDraftId = null;
    STATE.composeToChips = [];
    STATE.composeCcChips = [];
    return;
  }
  await saveDraft();
}

/* ===== SAVE DRAFT ===== */
async function saveDraft() {
  const inputExtra = document.getElementById('compose-to').value.trim();
  const allTo = [...STATE.composeToChips];
  if (inputExtra) {
    inputExtra.split(/[;,]/).forEach(t => { const s = t.trim(); if (s && !allTo.includes(s)) allTo.push(s); });
  }
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-text-area').innerHTML.trim();

  const toList = allTo.map(s => ({ name: s, email: s }));

  if (STATE.composeDraftId) {
    // Update existing draft
    const idx = STATE.emails.findIndex(e => e.id === STATE.composeDraftId);
    if (idx !== -1) {
      const updated = await patchEmail(STATE.composeDraftId, {
        subject: subject || '(no subject)',
        to: toList,
        body,
      });
      STATE.emails[idx] = { ...STATE.emails[idx], ...updated };
    }
  } else {
    // Create new draft
    const newDraft = await createEmail({
      subject: subject || '(no subject)',
      to: toList,
      cc: [],
      body,
      folder: 'drafts',
      read: false,
    });
    STATE.emails.push(newDraft);
    STATE.composeDraftId = newDraft.id;
  }

  await logEvent({ type: 'draft_saved', draftId: STATE.composeDraftId });
  refreshFolderCounts();
  await saveState();
  renderSidebar();
  closeCompose();

  STATE.currentFolder = 'drafts';
  STATE.selectedId = null;
  renderSidebar();
  renderEmailList();
  renderReadingPane();
}

const USER_EMAIL = 'alex.johnson@outlook.com';

async function sendEmail() {
  const toRaw = document.getElementById('compose-to').value.trim();
  const ccRaw = document.getElementById('compose-cc').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const bodyEl = document.getElementById('compose-text-area');
  const body = bodyEl.innerHTML.trim();

  // Flush any remaining text in the inputs into chips
  if (toRaw) {
    toRaw.split(/[;,]/).forEach(t => {
      const s = t.trim();
      if (s && !STATE.composeToChips.includes(s)) STATE.composeToChips.push(s);
    });
    document.getElementById('compose-to').value = '';
    renderComposeChips('compose-to-chips', STATE.composeToChips, 'composeToChips');
  }
  if (ccRaw) {
    ccRaw.split(/[;,]/).forEach(t => {
      const s = t.trim();
      if (s && !STATE.composeCcChips.includes(s)) STATE.composeCcChips.push(s);
    });
    document.getElementById('compose-cc').value = '';
    renderComposeChips('compose-cc-chips', STATE.composeCcChips, 'composeCcChips');
  }

  if (STATE.composeToChips.length === 0) { alert('Please add at least one recipient.'); return; }

  // Check for invalid email addresses
  const allRecipientChips = [...STATE.composeToChips, ...STATE.composeCcChips];
  const invalidAddresses = allRecipientChips.filter(a => !isValidEmail(a));

  const toList = STATE.composeToChips.map(s => ({ name: s, email: s }));
  const ccList = STATE.composeCcChips.map(s => ({ name: s, email: s }));

  const replyTo = STATE.composeReplyTo;
  const draftId = STATE.composeDraftId;

  // If sent from a draft, remove the draft
  if (draftId) {
    const draftIdx = STATE.emails.findIndex(e => e.id === draftId);
    if (draftIdx !== -1) STATE.emails.splice(draftIdx, 1);
    await deleteEmailReq(draftId);
  }

  if (invalidAddresses.length > 0) {
    // Delivery failure: don't put in sent folder, deliver bounce to inbox
    const bounceBody = `<p>Your message wasn't delivered to <b>${invalidAddresses.join(', ')}</b> because the address is not formatted correctly.</p>`
      + `<p><b>Subject:</b> ${escapeHtml(subject || '(no subject)')}</p>`
      + `<p>Please verify the recipient's email address and try again.</p>`;
    const bounceEmail = await createEmail({
      subject: `Undeliverable: ${subject || '(no subject)'}`,
      to: [{ name: USER_EMAIL, email: USER_EMAIL }],
      cc: [],
      body: bounceBody,
      folder: 'inbox',
      read: false,
      from: { name: 'Microsoft Outlook', email: 'postmaster@contoso.com' },
    });
    STATE.emails.push(bounceEmail);
    showInboxToast(bounceEmail);
    await logEvent({
      type: 'email_send_failed',
      subject: subject || '(no subject)',
      to: toList.map(t => t.email),
      invalidAddresses,
    });
  } else {
    // Normal send: put in sent folder
    const newEmail = await createEmail({
      subject: subject || '(no subject)',
      to: toList,
      cc: ccList,
      body: body || '',
      folder: 'sent',
      conversationId: replyTo ? replyTo.conversationId : null,
      replyToId: replyTo ? replyTo.id : null,
    });
    STATE.emails.push(newEmail);

    // If the user is in To or CC, deliver a copy to their inbox
    const allRecipients = [...toList, ...ccList];
    const sentToSelf = allRecipients.some(t =>
      t.email.toLowerCase() === USER_EMAIL.toLowerCase()
    );
    if (sentToSelf) {
      const inboxCopy = await createEmail({
        subject: subject || '(no subject)',
        to: toList,
        cc: ccList,
        body: body || '',
        folder: 'inbox',
        read: false,
        conversationId: replyTo ? replyTo.conversationId : null,
      });
      STATE.emails.push(inboxCopy);
      showInboxToast(inboxCopy);
    }

    await logEvent({
      type: 'email_sent',
      emailId: newEmail.id,
      subject: newEmail.subject,
      to: toList.map(t => t.email),
      mode: STATE.composeMode,
      replyToId: replyTo ? replyTo.id : null,
    });
  }

  refreshFolderCounts();
  await saveState();
  closeCompose();

  // Navigate to inbox if send failed (so user sees the bounce), otherwise to sent
  if (invalidAddresses.length > 0) {
    STATE.currentFolder = 'inbox';
  } else {
    STATE.currentFolder = 'sent';
  }
  STATE.selectedId = null;
  renderSidebar();
  renderEmailList();
  renderReadingPane();
}

/* ===== CONTEXT MENU ===== */
let contextMenuEmailId = null;

const CTX_ICONS = {
  reply:    `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M8 5L3 10l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 10h8c3 0 5 1.5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  replyAll: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M6 5L1 10l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 5L5 10l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10h8c3 0 5 1.5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  forward:  `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M12 5l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 10H9c-3 0-5 1.5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  read:     `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="16" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M2 7l8 5 8-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  unread:   `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="16" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M2 7l8 5 8-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  flag:     `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M5 3v14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 3h10l-3 4.5L15 12H5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  pin:      `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10.1221 3.13715C10.7326 1.91616 12.3599 1.65208 13.3251 2.61737L17.382 6.67419C18.3472 7.63947 18.0832 9.26676 16.8622 9.87726L13.4037 11.6065C13.0751 11.7708 12.8183 12.0499 12.6818 12.391L11.2459 15.981C10.9792 16.6476 10.1179 16.8244 9.61027 16.3167L7 13.7064L3.70711 16.9993H3V16.2922L6.29289 12.9993L3.68262 10.3891C3.17498 9.88142 3.35177 9.02011 4.01834 8.75348L7.60829 7.3175C7.94939 7.18106 8.22855 6.92419 8.39285 6.5956L10.1221 3.13715ZM12.618 3.32447C12.1354 2.84183 11.3217 2.97387 11.0165 3.58437L9.28727 7.04282C9.01345 7.59046 8.54818 8.01858 7.97968 8.24598L4.38973 9.68196L10.3174 15.6096L11.7534 12.0197C11.9808 11.4512 12.4089 10.9859 12.9565 10.7121L16.415 8.98283C17.0255 8.67758 17.1575 7.86394 16.6749 7.3813L12.618 3.32447Z"/></svg>`,
  category: `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M3 5a2 2 0 012-2h4.586a1 1 0 01.707.293l6.414 6.414a1 1 0 010 1.414l-4.586 4.586a1 1 0 01-1.414 0L4.293 9.293A1 1 0 014 8.586V5z" stroke="currentColor" stroke-width="1.5" fill="currentColor" fill-opacity="0.15"/><circle cx="7" cy="7.5" r="1" fill="currentColor"/></svg>`,
  archive:  `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 6.5a1 1 0 011-1h3.5l1.5 1.5H17a1 1 0 011 1V15a1 1 0 01-1 1H3a1 1 0 01-1-1V6.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 11.5h5M11 9.5l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  move:     `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 6.5a1 1 0 011-1h3.5l1.5 1.5H17a1 1 0 011 1V15a1 1 0 01-1 1H3a1 1 0 01-1-1V6.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 11.5h5M11 9.5l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  delete:   `<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M8 4h4M3 6h14M5 6l1 10a1 1 0 001 1h6a1 1 0 001-1L15 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 9v5M11.5 9v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
};

const CTX_COLORS = {
  reply:    '#7719AA',
  replyAll: '#7719AA',
  forward:  '#0078d4',
  delete:   '#d13438',
  archive:  '#605e5c',
  move:     '#0078d4',
  read:     '#0078d4',
  unread:   '#0078d4',
  flag:     '#d83b01',
  pin:      '#0078d4',
  category: '#8764b8',
};

function showContextMenu(e, emailId) {
  e.preventDefault();
  contextMenuEmailId = emailId;
  const email = STATE.emails.find(em => em.id === emailId);
  if (!email) return;

  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Email options');

  const items = [
    { key: 'reply',    icon: CTX_ICONS.reply,    label: 'Reply',                       action: () => openCompose('reply', email) },
    { key: 'replyAll', icon: CTX_ICONS.replyAll,  label: 'Reply All',                   action: () => openCompose('reply-all', email) },
    { key: 'forward',  icon: CTX_ICONS.forward,   label: 'Forward',                     action: () => openCompose('forward', email) },
    { key: 'delete',   icon: CTX_ICONS.delete,    label: 'Delete',                      action: () => deleteEmail(emailId), separator: true },
    { key: 'archive',  icon: CTX_ICONS.archive,   label: 'Archive',                     action: () => archiveEmail(emailId) },
    { key: 'move',     icon: CTX_ICONS.move,      label: 'Move to folder',              action: () => openMoveModal(emailId) },
    { key: email.read ? 'unread' : 'read', icon: email.read ? CTX_ICONS.unread : CTX_ICONS.read, label: email.read ? 'Mark as unread' : 'Mark as read', action: () => toggleRead(emailId), separator: true },
    { key: 'flag',     icon: CTX_ICONS.flag,      label: email.flagged ? 'Unflag' : 'Flag', action: () => flagEmail(emailId) },
    { key: 'pin',      icon: CTX_ICONS.pin,       label: email.pinned  ? 'Unpin'  : 'Pin',  action: () => pinEmail(emailId) },
    { key: 'category', icon: CTX_ICONS.category,  label: 'Category',                    action: () => {} },
  ];

  let firstItem = null;
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'ctx-item' + (item.separator ? ' ctx-separator' : '');
    div.id = 'ctx-' + item.key;
    div.setAttribute('role', 'menuitem');
    div.setAttribute('tabindex', '-1');
    const color = CTX_COLORS[item.key] || 'var(--text-secondary)';
    div.innerHTML = `<span class="ctx-icon" style="color:${color}">${item.icon}</span><span>${item.label}</span>`;
    div.addEventListener('click', () => { hideContextMenu(); item.action(); });
    menu.appendChild(div);
    if (!firstItem) firstItem = div;
  });

  // Keyboard navigation
  menu.addEventListener('keydown', function ctxKeyHandler(ev) {
    const menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
    const cur = menuItems.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      menuItems[(cur + 1) % menuItems.length].focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      menuItems[(cur - 1 + menuItems.length) % menuItems.length].focus();
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      document.activeElement.click();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      hideContextMenu();
    }
  });

  // Position near cursor, flip if off screen
  const menuW = 200, menuH = items.length * 36 + 16;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.hidden = false;
  if (firstItem) firstItem.focus();
}

function hideContextMenu() {
  document.getElementById('context-menu').hidden = true;
  contextMenuEmailId = null;
}

/* ===== TOGGLE READ ===== */
async function toggleRead(id) {
  const idx = STATE.emails.findIndex(e => e.id === id);
  if (idx === -1) return;
  const newVal = !STATE.emails[idx].read;
  STATE.emails[idx].read = newVal;
  await patchEmail(id, { read: newVal });
  refreshFolderCounts();
  await saveState();
  renderEmailList();
  renderSidebar();
  if (STATE.selectedId === id) renderReadingPane();
}

/* ===== MOVE MODAL ===== */
function openMoveModal(emailId) {
  const modal = document.getElementById('move-modal');
  const list = document.getElementById('move-folder-list');
  list.innerHTML = '';
  STATE.folders.forEach(folder => {
    const li = document.createElement('li');
    li.id = 'move-folder-' + folder.id;
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');
    li.innerHTML = `<span class="folder-icon">${FOLDER_ICONS[folder.id] || DEFAULT_FOLDER_ICON}</span> ${folder.name}`;
    li.addEventListener('click', () => moveEmail(emailId, folder.id));
    list.appendChild(li);
  });
  modal.hidden = false;
  modal.dataset.emailId = emailId;
}

function closeMoveModal() {
  document.getElementById('move-modal').hidden = true;
}

/* ===== REFRESH FOLDER COUNTS ===== */
function refreshFolderCounts() {
  STATE.folders = STATE.folders.map(folder => {
    const count = folder.id === 'drafts'
      ? STATE.emails.filter(e => e.folder === 'drafts').length
      : STATE.emails.filter(e => e.folder === folder.id && !e.read).length;
    return { ...folder, count };
  });
}

/* ===== UTILITY ===== */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFileSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

const MIME_TYPES = {
  pdf:  'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt:  'application/vnd.ms-powerpoint',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  zip:  'application/zip',
  txt:  'text/plain',
};

function attachIconSvg(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  // Paperclip icon as default
  const CLIP = `<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M9.5 2a4.5 4.5 0 00-4.5 4.5v7a6 6 0 0012 0V5.5a.5.5 0 011 0V13.5a7 7 0 01-14 0v-7a5.5 5.5 0 0111 0V13a3 3 0 01-6 0V6.5a.5.5 0 011 0V13a2 2 0 004 0V6.5A4.5 4.5 0 009.5 2z"/></svg>`;
  return CLIP;
}

async function downloadAttachment(emailId, attachIdx) {
  const email = STATE.emails.find(e => e.id === emailId);
  if (!email || !email.attachments) return;
  const attachment = email.attachments[attachIdx];
  if (!attachment) return;

  const ext = (attachment.name.split('.').pop() || '').toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  // Create a fake blob of the appropriate size (capped at 4KB for memory)
  const fakeSize = Math.min(attachment.size, 4096);
  const blob = new Blob([new Uint8Array(fakeSize)], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  await logEvent({
    type: 'attachment_downloaded',
    emailId,
    filename: attachment.name,
    size: attachment.size,
  });
}

function downloadAll(emailId) {
  const email = STATE.emails.find(e => e.id === emailId);
  if (!email || !email.attachments) return;
  email.attachments.forEach((_, i) => downloadAttachment(emailId, i));
}

/* ===== EVENT BINDINGS ===== */
function bindEvents() {
  document.getElementById('btn-new-email').addEventListener('click', () => openCompose('new'));

  // Email list — delegated click handling for cards and action buttons
  const emailListEl = document.getElementById('email-list-content');
  emailListEl.addEventListener('click', e => {
    // Checkbox toggle
    const checkbox = e.target.closest('.email-card-checkbox');
    if (checkbox) {
      e.stopPropagation();
      const id = checkbox.dataset.id;
      if (STATE.checkedIds.has(id)) {
        STATE.checkedIds.delete(id);
      } else {
        STATE.checkedIds.add(id);
      }
      renderEmailList();
      return;
    }
    const deleteBtn = e.target.closest('.card-delete-btn');
    if (deleteBtn) { e.stopPropagation(); deleteEmail(deleteBtn.dataset.id); return; }
    const flagBtn = e.target.closest('.card-flag-btn');
    if (flagBtn) { e.stopPropagation(); flagEmail(flagBtn.dataset.id); return; }
    const pinBtn = e.target.closest('.card-pin-btn');
    if (pinBtn) { e.stopPropagation(); pinEmail(pinBtn.dataset.id); return; }
    const card = e.target.closest('.email-card');
    if (card) selectEmail(card.dataset.id);
  });
  emailListEl.addEventListener('contextmenu', e => {
    const card = e.target.closest('.email-card');
    if (card) showContextMenu(e, card.dataset.id);
  });

  // Ribbon collapse toggle
  document.getElementById('btn-ribbon-collapse').addEventListener('click', () => {
    document.getElementById('ribbon').classList.toggle('ribbon-compact');
  });

  // Search input
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => handleSearch(e.target.value), 150);
  });

  // Tab switching
  document.getElementById('inbox-tabs').addEventListener('click', async e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === STATE.currentTab) return;
    STATE.currentTab = tab;
    STATE.selectedId = null;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    await logEvent({ type: 'tab_switched', tab });
    await saveState();
    renderEmailList();
    renderReadingPane();
  });

  // Filter toggle
  document.getElementById('filter-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('filter-menu');
    menu.hidden = !menu.hidden;
  });
  document.getElementById('filter-menu').addEventListener('click', e => {
    const btn = e.target.closest('.filter-option');
    if (!btn) return;
    const f = btn.dataset.filter;
    STATE.currentFilter = (f === 'all' || STATE.currentFilter === f) ? null : f;
    STATE.selectedId = null;
    document.getElementById('filter-menu').hidden = true;
    renderEmailList();
    renderReadingPane();
  });
  document.addEventListener('click', e => {
    const menu = document.getElementById('filter-menu');
    if (menu) menu.hidden = true;
    // Close profile popup if clicking outside
    const popup = document.getElementById('profile-popup');
    if (popup && !popup.hidden && !e.target.closest('#profile-popup') && !e.target.closest('#btn-profile-avatar')) {
      popup.hidden = true;
    }
  });

  // Profile avatar toggle
  document.getElementById('btn-profile-avatar').addEventListener('click', e => {
    e.stopPropagation();
    const popup = document.getElementById('profile-popup');
    popup.hidden = !popup.hidden;
  });

  // Ribbon action buttons
  document.getElementById('ribbon-reply').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply', email);
  });
  document.getElementById('ribbon-reply-all').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply-all', email);
  });
  document.getElementById('ribbon-forward').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('forward', email);
  });
  document.getElementById('ribbon-delete').addEventListener('click', () => {
    if (STATE.checkedIds.size > 0) { bulkDelete(); return; }
    if (STATE.selectedId) deleteEmail(STATE.selectedId);
  });
  document.getElementById('ribbon-archive').addEventListener('click', () => {
    if (STATE.checkedIds.size > 0) { bulkArchive(); return; }
    if (STATE.selectedId) archiveEmail(STATE.selectedId);
  });
  document.getElementById('ribbon-move').addEventListener('click', () => {
    if (STATE.checkedIds.size > 0) { openBulkMoveModal(); return; }
    if (STATE.selectedId) openMoveModal(STATE.selectedId);
  });
  document.getElementById('ribbon-new-folder').addEventListener('click', createFolder);
  document.getElementById('ribbon-read').addEventListener('click', () => {
    if (STATE.selectedId) toggleRead(STATE.selectedId);
  });
  document.getElementById('ribbon-flag').addEventListener('click', () => {
    if (STATE.selectedId) flagEmail(STATE.selectedId);
  });
  document.getElementById('ribbon-pin').addEventListener('click', () => {
    if (STATE.selectedId) pinEmail(STATE.selectedId);
  });

  // Category button — toggle dropdown
  document.getElementById('ribbon-category').addEventListener('click', e => {
    e.stopPropagation();
    const dd = document.getElementById('category-dropdown');
    if (!dd.hidden) { dd.hidden = true; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    dd.style.left = rect.left + 'px';
    dd.style.top = rect.bottom + 4 + 'px';
    dd.hidden = false;
  });

  document.getElementById('category-dropdown').addEventListener('click', async e => {
    const item = e.target.closest('.cat-item');
    if (!item || !STATE.selectedId) return;
    document.getElementById('category-dropdown').hidden = true;
    await categoryEmail(STATE.selectedId, item.dataset.cat);
  });

  // Inline reply buttons in header
  document.getElementById('btn-reply-inline').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply', email);
  });
  document.getElementById('btn-reply-all-inline').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply-all', email);
  });
  document.getElementById('btn-forward-inline').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('forward', email);
  });

  // Footer reply buttons
  document.getElementById('btn-reply-footer').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply', email);
  });
  document.getElementById('btn-reply-all-footer').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('reply-all', email);
  });
  document.getElementById('btn-forward-footer').addEventListener('click', () => {
    const email = STATE.emails.find(e => e.id === STATE.selectedId);
    if (email) openCompose('forward', email);
  });

  // Compose modal controls
  document.getElementById('btn-send').addEventListener('click', sendEmail);
  document.getElementById('btn-discard').addEventListener('click', () => closeCompose({ discard: true }));

  // Attachment download — delegated from reading pane
  document.getElementById('reading-pane').addEventListener('click', e => {
    const dlAll = e.target.closest('.rp-attach-download-all');
    if (dlAll) { downloadAll(dlAll.dataset.emailId); return; }
    const chip = e.target.closest('.rp-attach-chip');
    if (!chip) return;
    downloadAttachment(chip.dataset.emailId, parseInt(chip.dataset.attachIdx, 10));
  });

  // Emoji picker (reading pane)
  const rpEmojiBtn = document.getElementById('btn-rp-emoji');
  const rpEmojiPopup = document.getElementById('rp-emoji-popup');
  rpEmojiBtn.addEventListener('click', e => {
    e.stopPropagation();
    rpEmojiPopup.hidden = !rpEmojiPopup.hidden;
  });
  document.querySelectorAll('.rp-emoji-opt').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const emailId = STATE.selectedId;
      if (!emailId) return;
      reactToEmail(emailId, btn.dataset.emoji);
      rpEmojiPopup.hidden = true;
    });
  });

  // Move modal close
  document.getElementById('btn-move-close').addEventListener('click', closeMoveModal);
  document.getElementById('move-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('move-modal')) closeMoveModal();
  });

  // New folder modal
  document.getElementById('btn-new-folder-close').addEventListener('click', () => {
    document.getElementById('new-folder-modal').hidden = true;
  });
  document.getElementById('btn-new-folder-cancel').addEventListener('click', () => {
    document.getElementById('new-folder-modal').hidden = true;
  });
  document.getElementById('btn-new-folder-confirm').addEventListener('click', confirmCreateFolder);
  document.getElementById('new-folder-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmCreateFolder();
    if (e.key === 'Escape') document.getElementById('new-folder-modal').hidden = true;
  });
  document.getElementById('new-folder-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('new-folder-modal'))
      document.getElementById('new-folder-modal').hidden = true;
  });

  // Outlook tab bar (File / Home / View / Help)
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    document.getElementById('outlook-content').classList.toggle('sidebar-collapsed');
  });

  document.getElementById('outlook-tabbar').addEventListener('click', e => {
    const tab = e.target.closest('.outlook-tab[data-tab]');
    if (!tab) return;
    document.querySelectorAll('.outlook-tab[data-tab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const t = tab.dataset.tab;
    document.getElementById('ribbon').hidden = t !== 'home';
    document.getElementById('ribbon-empty').hidden = t !== 'view';
    document.getElementById('ribbon-format').hidden = t !== 'format';
  });

  // Format Text ribbon
  const composeArea = () => document.getElementById('compose-text-area');

  document.getElementById('fmt-bold').addEventListener('click', () => { composeArea().focus(); document.execCommand('bold'); logEvent({ type: 'format_applied', format: 'bold' }); });
  document.getElementById('fmt-italic').addEventListener('click', () => { composeArea().focus(); document.execCommand('italic'); logEvent({ type: 'format_applied', format: 'italic' }); });
  document.getElementById('fmt-underline').addEventListener('click', () => { composeArea().focus(); document.execCommand('underline'); logEvent({ type: 'format_applied', format: 'underline' }); });
  document.getElementById('fmt-strikethrough').addEventListener('click', () => { composeArea().focus(); document.execCommand('strikeThrough'); logEvent({ type: 'format_applied', format: 'strikethrough' }); });

  document.getElementById('fmt-font').addEventListener('change', e => {
    composeArea().focus();
    document.execCommand('fontName', false, e.target.value);
  });

  document.getElementById('fmt-size').addEventListener('change', e => {
    composeArea().focus();
    // execCommand fontSize only accepts 1-7; use a workaround with font-size style
    const size = e.target.value + 'px';
    document.execCommand('fontSize', false, '7');
    const fonts = composeArea().querySelectorAll('font[size="7"]');
    fonts.forEach(f => { f.removeAttribute('size'); f.style.fontSize = size; });
  });

  const colorBar = document.getElementById('fmt-color-bar');
  let savedSelection = null;
  let activeColor = '#000000';

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) savedSelection = sel.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    if (!savedSelection) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedSelection);
  }
  function applyColor(color) {
    activeColor = color;
    colorBar.style.background = color;
    restoreSelection();
    document.execCommand('foreColor', false, color);
    savedSelection = null;
  }

  // Theme colors (10 columns × 6 rows like Outlook)
  const THEME_COLORS = [
    '#FFFFFF','#000000','#E7E6E6','#44546A','#4472C4','#ED7D31','#A9D18E','#FF0000','#FFC000','#70AD47',
    '#F2F2F2','#7F7F7F','#D0CECE','#D6DCE4','#D9E1F2','#FCE4D6','#E2EFDA','#FFE7E7','#FFF2CC','#E2EFDA',
    '#D9D9D9','#595959','#AEAAAA','#ADB9CA','#B4C6E7','#F8CBAD','#C6E0B4','#FF9999','#FFE699','#C6E0B4',
    '#BFBFBF','#404040','#757070','#8496B0','#8EAADB','#F4B183','#A9D18E','#FF4C4C','#FFD966','#A9D18E',
    '#A6A6A6','#262626','#3A3838','#323F4F','#2F5496','#C55A11','#538135','#C00000','#BF8F00','#375623',
    '#808080','#0D0D0D','#161616','#222A35','#1F3864','#843C0C','#375623','#9C0006','#7F5F00','#233A15',
  ];
  const STANDARD_COLORS = [
    '#C00000','#FF0000','#FFC000','#FFFF00','#92D050','#00B050','#00B0F0','#0070C0','#002060','#7030A0',
  ];

  const themeGrid = document.getElementById('color-theme-grid');
  const standardGrid = document.getElementById('color-standard-grid');

  THEME_COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.className = 'color-swatch';
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('mousedown', e => e.preventDefault());
    sw.addEventListener('click', () => { applyColor(c); closeColorPanel(); });
    themeGrid.appendChild(sw);
  });
  STANDARD_COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.className = 'color-swatch';
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('mousedown', e => e.preventDefault());
    sw.addEventListener('click', () => { applyColor(c); closeColorPanel(); });
    standardGrid.appendChild(sw);
  });

  const colorPanel = document.getElementById('fmt-color-panel');
  function closeColorPanel() { colorPanel.hidden = true; }

  document.getElementById('fmt-color-apply').addEventListener('mousedown', e => { e.preventDefault(); saveSelection(); });
  document.getElementById('fmt-color-apply').addEventListener('click', e => {
    e.stopPropagation();
    colorPanel.hidden = !colorPanel.hidden;
  });

  const customInput = document.getElementById('fmt-color-custom');
  customInput.addEventListener('change', e => { applyColor(e.target.value); closeColorPanel(); });

  document.addEventListener('click', e => {
    if (!e.target.closest('.fmt-color-wrap')) closeColorPanel();
  });

  // Cmd+A / Ctrl+A inside compose selects only compose text
  document.getElementById('compose-text-area').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      const area = document.getElementById('compose-text-area');
      const range = document.createRange();
      range.selectNodeContents(area);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  // Folder Pane
  document.getElementById('btn-view-folder-pane').addEventListener('click', e => {
    e.stopPropagation();
    const card = document.getElementById('folder-pane-card');
    document.getElementById('zoom-card').hidden = true;
    document.getElementById('density-card').hidden = true;
    card.hidden = !card.hidden;
    const collapsed = document.getElementById('outlook-content').classList.contains('sidebar-collapsed');
    document.getElementById('btn-fp-show').classList.toggle('active', !collapsed);
    document.getElementById('btn-fp-hide').classList.toggle('active', collapsed);
  });
  document.getElementById('btn-fp-show').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('outlook-content').classList.remove('sidebar-collapsed');
    document.getElementById('folder-pane-card').hidden = true;
  });
  document.getElementById('btn-fp-hide').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('outlook-content').classList.add('sidebar-collapsed');
    document.getElementById('folder-pane-card').hidden = true;
  });

  // Zoom
  let zoomLevel = 100;
  function applyZoom() {
    document.getElementById('zoom-level').textContent = zoomLevel + '%';
    const scale = zoomLevel / 100;
    for (const id of ['rp-scroll', 'compose-body']) {
      const el = document.getElementById(id);
      el.style.zoom = scale;
      el.style.transform = '';
      el.style.width = '';
      el.style.height = '';
    }
  }
  document.getElementById('btn-view-zoom').addEventListener('click', e => {
    e.stopPropagation();
    const card = document.getElementById('zoom-card');
    const densityCard = document.getElementById('density-card');
    densityCard.hidden = true;
    card.hidden = !card.hidden;
  });
  document.getElementById('btn-zoom-in').addEventListener('click', e => {
    e.stopPropagation();
    zoomLevel = Math.min(200, zoomLevel + 10);
    applyZoom();
    logEvent({ type: 'zoom_changed', zoomLevel });
  });
  document.getElementById('btn-zoom-out').addEventListener('click', e => {
    e.stopPropagation();
    zoomLevel = Math.max(50, zoomLevel - 10);
    applyZoom();
    logEvent({ type: 'zoom_changed', zoomLevel });
  });
  document.getElementById('btn-zoom-reset').addEventListener('click', e => {
    e.stopPropagation();
    zoomLevel = 100;
    applyZoom();
    logEvent({ type: 'zoom_changed', zoomLevel });
  });
  document.getElementById('zoom-card').addEventListener('click', e => e.stopPropagation());

  // Density
  function applyDensity(density) {
    document.body.classList.remove('density-roomy', 'density-cosy', 'density-compact');
    document.body.classList.add('density-' + density);
    document.querySelectorAll('.density-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.density === density);
    });
  }
  applyDensity('cosy');
  // Track current density so we can log changes
  let currentDensity = 'cosy';
  document.getElementById('btn-view-density').addEventListener('click', e => {
    e.stopPropagation();
    const card = document.getElementById('density-card');
    const zoomCard = document.getElementById('zoom-card');
    zoomCard.hidden = true;
    card.hidden = !card.hidden;
  });
  document.getElementById('density-card').addEventListener('click', e => {
    e.stopPropagation();
    const opt = e.target.closest('.density-opt');
    if (!opt) return;
    const newDensity = opt.dataset.density;
    applyDensity(newDensity);
    if (newDensity !== currentDensity) {
      currentDensity = newDensity;
      logEvent({ type: 'density_changed', density: newDensity });
    }
    document.getElementById('density-card').hidden = true;
  });

  // Context menu + emoji + dropdown dismiss on outside click
  document.addEventListener('click', () => {
    hideContextMenu();
    document.getElementById('rp-emoji-popup').hidden = true;
    document.getElementById('category-dropdown').hidden = true;
    document.getElementById('zoom-card').hidden = true;
    document.getElementById('density-card').hidden = true;
    document.getElementById('folder-pane-card').hidden = true;
  });
}

/* ===== CALENDAR ===== */
const CAL_STATE = {
  events: [],
  view: 'workweek',        // 'month' | 'week' | 'workweek' | 'day'
  today: new Date(),
  cursor: new Date(),      // date navigated to (first day of month / week / day)
  miniCursor: new Date(),  // mini calendar month
  editingEventId: null,    // null = new, string = editing existing
  selectedColor: 'blue',
  editingAttendees: [],    // attendees list in the editor
  gridSel: null,           // { dateKey, startMin, endMin } or null
};

const CURRENT_USER = 'alex.johnson@contoso.com';

const CONTACTS = [
  { name: 'Alex Johnson',     email: 'alex.johnson@contoso.com' },
  { name: 'Sarah Kim',        email: 'sarah.kim@contoso.com' },
  { name: 'Marcus Chen',      email: 'marcus.chen@contoso.com' },
  { name: 'Marcus Thompson',  email: 'marcus.thompson@contoso.com' },
  { name: 'Priya Patel',      email: 'priya.patel@contoso.com' },
  { name: 'Priya Sharma',     email: 'priya.sharma@contoso.com' },
  { name: 'Jordan Lee',       email: 'jordan.lee@contoso.com' },
  { name: 'Nina Ross',        email: 'nina.ross@contoso.com' },
  { name: 'Tom Nguyen',       email: 'tom.nguyen@contoso.com' },
  { name: 'Sarah Mitchell',   email: 'sarah.mitchell@contoso.com' },
  { name: 'Daniel Lee',       email: 'daniel.lee@contoso.com' },
  { name: 'Linda Chen',       email: 'linda.chen@contoso.com' },
  { name: 'Rachel Green',     email: 'rachel.green@contoso.com' },
  { name: 'Maya Patel',       email: 'maya.patel@contoso.com' },
  { name: 'Jennifer Park',    email: 'jennifer.park@contoso.com' },
];

function emailToInitials(email) {
  const name = email.split('@')[0];
  const parts = name.split('.');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function emailToDisplayName(email) {
  const name = email.split('@')[0];
  return name.split('.').map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/* ---- Compose chip helpers ---- */
function renderComposeChips(containerId, chips, stateKey) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  chips.forEach((addr, i) => {
    const chip = document.createElement('div');
    chip.className = 'compose-recipient-chip';
    const valid = isValidEmail(addr);
    if (!valid) {
      chip.classList.add('invalid');
      const icon = document.createElement('span');
      icon.className = 'chip-error-icon';
      icon.textContent = '!';
      chip.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = valid ? emailToDisplayName(addr) : addr;
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.innerHTML = '&times;';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      STATE[stateKey].splice(i, 1);
      renderComposeChips(containerId, STATE[stateKey], stateKey);
    });
    chip.appendChild(rm);
    el.appendChild(chip);
  });
}

function flushComposeInput(inputId, containerId, stateKey) {
  const input = document.getElementById(inputId);
  const raw = input.value.trim().replace(/[;,]$/, '').trim();
  if (raw) {
    raw.split(/[;,]/).forEach(t => {
      const s = t.trim();
      if (s && !STATE[stateKey].includes(s)) STATE[stateKey].push(s);
    });
    renderComposeChips(containerId, STATE[stateKey], stateKey);
  }
  input.value = '';
}

/* ---- Contact autocomplete ----
   inputEl: a text <input>
   onSelect(contact): called when user picks a suggestion
   The dropdown attaches itself to document.body and positions below the input.
*/
function bindAutocomplete(inputEl, onSelect) {
  let dropdown = null;
  let activeIdx = -1;

  function getQuery() {
    // For semicolon-separated multi-recipient inputs, match only the last segment
    const val = inputEl.value;
    const lastSep = Math.max(val.lastIndexOf(';'), val.lastIndexOf(','));
    return lastSep >= 0 ? val.slice(lastSep + 1).trimStart() : val.trimStart();
  }

  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    activeIdx = -1;
  }

  function buildDropdown(matches) {
    closeDropdown();
    if (!matches.length) return;

    dropdown = document.createElement('ul');
    dropdown.className = 'ac-dropdown';

    matches.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'ac-item';
      li.innerHTML =
        `<div class="ac-avatar">${emailToInitials(c.email)}</div>` +
        `<div class="ac-info"><div class="ac-name">${c.name}</div><div class="ac-email">${c.email}</div></div>`;
      li.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent blur before click
        onSelect(c);
        closeDropdown();
      });
      dropdown.appendChild(li);
    });

    document.body.appendChild(dropdown);
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + window.scrollY) + 'px';
    dropdown.style.width = rect.width + 'px';
    setActive(-1);
  }

  function setActive(idx) {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.ac-item');
    items.forEach((li, i) => li.classList.toggle('active', i === idx));
    activeIdx = idx;
  }

  inputEl.addEventListener('input', () => {
    const q = getQuery().toLowerCase();
    if (!q) { closeDropdown(); return; }
    const matches = CONTACTS.filter(c =>
      c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
    ).slice(0, 5);
    buildDropdown(matches);
  });

  inputEl.addEventListener('keydown', e => {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0) {
        e.preventDefault();
        items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
      } else {
        closeDropdown();
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  inputEl.addEventListener('blur', () => {
    // Small delay so mousedown on item fires first
    setTimeout(closeDropdown, 150);
  });
}

const EVENT_COLORS = {
  blue: '#0078d4', teal: '#038387', green: '#107c10',
  yellow: '#ffb900', orange: '#d83b01', red: '#d13438', purple: '#8764b8',
};

function calDateKey(date) {
  // Returns "YYYY-MM-DD"
  return date.toLocaleDateString('en-CA'); // en-CA gives YYYY-MM-DD
}

function calSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function calEventsForDate(dateKey) {
  return CAL_STATE.events.filter(ev => ev.date === dateKey && ev.rsvp !== 'declined');
}

/* ---- Mini calendar ---- */
function makeMiniCell(dayNum, classes, clickHandler) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-mini-day-wrap';
  const btn = document.createElement('button');
  btn.className = 'cal-mini-day' + (classes ? ' ' + classes : '');
  btn.textContent = dayNum;
  if (clickHandler) btn.addEventListener('click', clickHandler);
  wrap.appendChild(btn);
  return wrap;
}

function renderMiniCal() {
  const y = CAL_STATE.miniCursor.getFullYear();
  const m = CAL_STATE.miniCursor.getMonth();
  document.getElementById('cal-mini-label').textContent =
    new Date(y, m, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  // Keep only the 7 DOW headers, remove old day cells
  const grid = document.getElementById('cal-mini-grid');
  const headers = Array.from(grid.querySelectorAll('.cal-mini-dow'));
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayKey = calDateKey(CAL_STATE.today);

  // Determine the Sunday–Saturday week that contains the cursor
  const cursorSun = new Date(CAL_STATE.cursor);
  cursorSun.setDate(cursorSun.getDate() - cursorSun.getDay());
  cursorSun.setHours(0, 0, 0, 0);
  const cursorSat = new Date(cursorSun);
  cursorSat.setDate(cursorSat.getDate() + 6);

  function inSelectedWeek(date) {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    return d >= cursorSun && d <= cursorSat;
  }

  // Fill previous month tail
  for (let d = firstDay - 1; d >= 0; d--) {
    const date = new Date(y, m, -d);
    const wk = inSelectedWeek(date) ? 'other-month in-selected-week' : 'other-month';
    grid.appendChild(makeMiniCell(prevDays - d, wk));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m, d);
    const key = calDateKey(date);
    const classes = [
      key === todayKey ? 'today' : '',
      calSameDay(date, CAL_STATE.cursor) ? 'selected' : '',
      inSelectedWeek(date) ? 'in-selected-week' : '',
    ].filter(Boolean).join(' ');
    const dd = d;
    grid.appendChild(makeMiniCell(dd, classes, () => {
      CAL_STATE.cursor = new Date(y, m, dd);
      renderCalendar();
    }));
  }

  // Fill next month
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let d = 1; d <= remaining; d++) {
    const date = new Date(y, m + 1, d);
    const wk = inSelectedWeek(date) ? 'other-month in-selected-week' : 'other-month';
    grid.appendChild(makeMiniCell(d, wk));
  }
}

/* ---- Month view ---- */
function renderMonthView() {
  const y = CAL_STATE.cursor.getFullYear();
  const m = CAL_STATE.cursor.getMonth();
  document.getElementById('cal-main-label').textContent =
    new Date(y, m, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const grid = document.getElementById('cal-month-grid');
  grid.innerHTML = '';

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayKey = calDateKey(CAL_STATE.today);

  // Previous month tail
  for (let d = firstDay - 1; d >= 0; d--) {
    const date = new Date(y, m - 1, prevDays - d);
    appendMonthCell(grid, date, true);
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    appendMonthCell(grid, new Date(y, m, d), false);
  }
  // Next month fill
  const totalCells = firstDay + daysInMonth;
  const fill = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let d = 1; d <= fill; d++) {
    appendMonthCell(grid, new Date(y, m + 1, d), true);
  }
}

function appendMonthCell(grid, date, isOther) {
  const key = calDateKey(date);
  const events = calEventsForDate(key);
  const cell = document.createElement('div');
  cell.className = 'cal-month-cell' + (isOther ? ' other-month' : '');
  if (calSameDay(date, CAL_STATE.today)) cell.classList.add('today');

  const dayDiv = document.createElement('div');
  dayDiv.className = 'cal-cell-day';
  dayDiv.textContent = date.getDate();
  cell.appendChild(dayDiv);

  // Show up to 3 events, then "+N more"
  const maxShow = 3;
  events.slice(0, maxShow).forEach(ev => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cal-event-chip cal-event-color-${ev.color || 'blue'}`;
    if (ev.rsvp === 'tentative') chip.classList.add('rsvp-tentative');
    chip.textContent = (ev.allDay ? '' : ev.startTime + ' ') + ev.title;
    chip.title = ev.title;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', `${ev.title}${ev.allDay ? ', All day' : ', ' + ev.startTime}`);
    chip.addEventListener('click', e => { e.stopPropagation(); openEventPopup(ev, chip); });
    cell.appendChild(chip);
  });
  if (events.length > maxShow) {
    const more = document.createElement('span');
    more.className = 'cal-event-more';
    more.textContent = `+${events.length - maxShow} more`;
    cell.appendChild(more);
  }

  // Click empty cell to navigate to that date
  cell.addEventListener('click', () => {
    CAL_STATE.cursor = date;
    renderMiniCal();
  });

  grid.appendChild(cell);
}

/* ---- Week view ---- */
function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

/* ---- Grid selection (click/drag to highlight time range) ---- */
// PX_PER_MIN: each hour cell is 80px = 60min → 80/60 px/min
const PX_PER_MIN = 80 / 60;
const SNAP_MIN = 30; // snap to 30-min slots

function pxToSnapMin(px) {
  const raw = px / PX_PER_MIN;
  return Math.round(raw / SNAP_MIN) * SNAP_MIN;
}

function minToHHMM(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function bindGridSelection(colEl, dateKey) {
  let dragging = false;
  let anchorMin = 0;

  function getMinFromEvent(e) {
    const rect = colEl.getBoundingClientRect();
    // clientY and rect.top are both viewport-relative — no scroll adjustment needed
    const py = e.clientY - rect.top;
    return Math.max(0, Math.min(pxToSnapMin(py), 23 * 60 + 30));
  }

  function getSelEl() {
    // Always look up the live element; never use a stale reference
    return colEl.querySelector('.cal-grid-sel');
  }

  function renderSel(startMin, endMin) {
    let el = getSelEl();
    if (!el) {
      el = document.createElement('div');
      el.className = 'cal-grid-sel';
      colEl.appendChild(el);
    }
    const top = startMin * PX_PER_MIN;
    const height = Math.max((endMin - startMin) * PX_PER_MIN, SNAP_MIN * PX_PER_MIN);
    el.style.top = top + 'px';
    el.style.height = height + 'px';
  }

  function clearSel() {
    const el = getSelEl();
    if (el) el.remove();
    if (CAL_STATE.gridSel && CAL_STATE.gridSel.dateKey === dateKey) {
      CAL_STATE.gridSel = null;
    }
  }

  colEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.cal-timed-event')) return;
    e.preventDefault();
    dragging = true;
    anchorMin = getMinFromEvent(e);
    // Clear any existing selections across all columns
    document.querySelectorAll('.cal-grid-sel').forEach(el => el.remove());
    CAL_STATE.gridSel = null;
    renderSel(anchorMin, anchorMin + SNAP_MIN);
    CAL_STATE.gridSel = { dateKey, startMin: anchorMin, endMin: anchorMin + SNAP_MIN };
  });

  colEl.addEventListener('mousemove', e => {
    if (!dragging) return;
    const curMin = getMinFromEvent(e);
    const startMin = Math.min(anchorMin, curMin);
    const endMin = Math.max(anchorMin, curMin) + SNAP_MIN;
    renderSel(startMin, endMin);
    CAL_STATE.gridSel = { dateKey, startMin, endMin };
  });

  colEl.addEventListener('mouseup', () => { dragging = false; });

  colEl.addEventListener('dblclick', e => {
    if (e.target.closest('.cal-timed-event')) return;
    const sel = CAL_STATE.gridSel && CAL_STATE.gridSel.dateKey === dateKey
      ? CAL_STATE.gridSel : null;
    const start = sel ? minToHHMM(sel.startMin) : minToHHMM(getMinFromEvent(e));
    const end = sel
      ? minToHHMM(Math.min(sel.endMin, 24 * 60 - 30))
      : minToHHMM(Math.min(getMinFromEvent(e) + SNAP_MIN * 2, 24 * 60 - 30));
    clearSel();
    openEventModal(null, dateKey, start, end);
  });
}

function clearAllGridSels() {
  document.querySelectorAll('.cal-grid-sel').forEach(el => el.remove());
  CAL_STATE.gridSel = null;
}

function renderWeekView(days) {
  const numDays = days || 7;
  const isWorkWeek = numDays === 5;
  let weekStart = getWeekStart(CAL_STATE.cursor);
  if (isWorkWeek) {
    weekStart = new Date(weekStart);
    weekStart.setDate(weekStart.getDate() + 1);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + numDays - 1);

  const labelStart = weekStart.toLocaleString('default', { month: 'short', day: 'numeric' });
  const labelEnd = weekEnd.toLocaleString('default', { month: 'short', day: 'numeric', year: 'numeric' });
  document.getElementById('cal-main-label').textContent = `${labelStart} – ${labelEnd}`;

  // --- Header ---
  const header = document.getElementById('cal-week-header');
  header.innerHTML = '';
  const hdrGutter = document.createElement('div');
  hdrGutter.className = 'cal-time-gutter';
  header.appendChild(hdrGutter);
  for (let i = 0; i < numDays; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const cell = document.createElement('div');
    cell.className = 'cal-week-header-day' + (calSameDay(d, CAL_STATE.today) ? ' today' : '');
    const dow = d.toLocaleString('default', { weekday: 'long' });
    cell.innerHTML = `<span class="day-num">${d.getDate()}</span><div class="cal-hdr-dow">${dow}</div>`;
    cell.addEventListener('click', () => { CAL_STATE.cursor = new Date(d); setCalView('day'); });
    header.appendChild(cell);
  }

  // --- Time column ---
  const timeCol = document.getElementById('cal-week-time-col');
  timeCol.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'cal-time-label';
    label.textContent = h === 0 ? '' : (h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
    timeCol.appendChild(label);
  }

  // --- Day columns ---
  const now = new Date();
  const nowTop = (now.getHours() * 60 + now.getMinutes()) / 60 * 80;

  const daysCol = document.getElementById('cal-week-days-col');
  daysCol.innerHTML = '';
  for (let i = 0; i < numDays; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const col = document.createElement('div');
    col.className = 'cal-week-day-col' + (calSameDay(d, CAL_STATE.today) ? ' today' : '');

    for (let h = 0; h < 24; h++) {
      const cell = document.createElement('div');
      cell.className = 'cal-hour-line';
      col.appendChild(cell);
    }

    // Events
    const key = calDateKey(d);
    const dayEvs = calEventsForDate(key).filter(ev => !ev.allDay);
    layoutTimedEvents(dayEvs).forEach(({ ev, col: evCol, totalCols }) => {
      col.appendChild(buildTimedEventEl(ev, evCol, totalCols));
    });

    // Grid selection (click/drag highlight)
    bindGridSelection(col, key);

    // Now-line — position: absolute relative to col (which is position:relative, height = 24*80px)
    if (calSameDay(d, CAL_STATE.today)) {
      const line = document.createElement('div');
      line.className = 'cal-now-line';
      line.style.top = nowTop + 'px';
      const dot = document.createElement('div');
      dot.className = 'cal-now-dot';
      line.appendChild(dot);
      col.appendChild(line);
    } else if (d < CAL_STATE.today) {
      const line = document.createElement('div');
      line.className = 'cal-now-line-dashed';
      line.style.top = nowTop + 'px';
      col.appendChild(line);
    }

    daysCol.appendChild(col);
  }

  // Scroll to center current time, and sync header padding to match scrollbar width
  const body = document.getElementById('cal-week-body');
  requestAnimationFrame(() => {
    body.scrollTop = Math.max(0, nowTop - body.clientHeight / 2);
    const scrollbarWidth = body.offsetWidth - body.clientWidth;
    header.style.paddingRight = scrollbarWidth + 'px';
  });
}

function buildTimedEventEl(ev, col, totalCols) {
  const [sh, sm] = ev.startTime.split(':').map(Number);
  const [eh, em] = ev.endTime.split(':').map(Number);
  const top = (sh * 60 + sm) / 60 * 80;
  const height = Math.max(((eh * 60 + em) - (sh * 60 + sm)) / 60 * 80, 20);
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `cal-timed-event cal-event-color-${ev.color || 'blue'}`;
  if (ev.rsvp === 'tentative') chip.classList.add('rsvp-tentative');
  chip.style.top = top + 'px';
  chip.style.height = height + 'px';
  chip.title = ev.title;
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', `${ev.title}, ${ev.startTime} to ${ev.endTime}${ev.location ? ', ' + ev.location : ''}`);

  // Overlap layout: divide column width equally, leave 2px gutter on outer edges
  if (totalCols > 1) {
    const pct = 100 / totalCols;
    chip.style.left = `calc(${col * pct}% + 2px)`;
    chip.style.right = `calc(${(totalCols - col - 1) * pct}% + 2px)`;
    chip.style.width = 'auto';
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'ev-title';
  titleEl.textContent = ev.title;
  chip.appendChild(titleEl);

  if (height >= 36) {
    const sub = document.createElement('span');
    sub.className = 'ev-sub';
    const fmt = t => { const [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''} ${ap}`; };
    sub.textContent = ev.location ? ev.location : `${fmt(ev.startTime)} – ${fmt(ev.endTime)}`;
    chip.appendChild(sub);
  }

  chip.addEventListener('click', e => { e.stopPropagation(); openEventPopup(ev, chip); });
  return chip;
}

/* Compute side-by-side columns for overlapping timed events.
   Returns array of {ev, col, totalCols} in the same order as input. */
function layoutTimedEvents(events) {
  // Convert times to minutes
  function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  const items = events.map((ev, i) => ({
    ev, i,
    start: toMin(ev.startTime),
    end: toMin(ev.endTime),
    col: 0,
    totalCols: 1,
  }));

  // Sort by start time, then by longer duration first
  items.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Greedy column assignment
  const cols = []; // cols[c] = end minute of last event placed in column c
  for (const item of items) {
    let placed = false;
    for (let c = 0; c < cols.length; c++) {
      if (cols[c] <= item.start) {
        item.col = c;
        cols[c] = item.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      item.col = cols.length;
      cols.push(item.end);
    }
  }

  // For each item, find the actual number of columns in its overlap group
  // (items that overlap with it at all). We expand each item's totalCols to
  // be the max column index+1 within its overlap cluster.
  for (const item of items) {
    let maxCol = item.col;
    for (const other of items) {
      if (other === item) continue;
      if (other.start < item.end && other.end > item.start) {
        if (other.col > maxCol) maxCol = other.col;
      }
    }
    item.totalCols = maxCol + 1;
  }

  // Return in original order
  const result = new Array(items.length);
  for (const item of items) result[item.i] = { ev: item.ev, col: item.col, totalCols: item.totalCols };
  return result;
}

function buildNowLine() {
  const now = new Date();
  const top = (now.getHours() * 60 + now.getMinutes()) / 60 * 80;
  const line = document.createElement('div');
  line.className = 'cal-now-line';
  line.style.top = top + 'px';

  // In day view, also place a gutter piece in the time column
  if (CAL_STATE.view === 'day') {
    const gutterEl = document.getElementById('cal-day-time-col');
    if (gutterEl) {
      const gutterLine = document.createElement('div');
      gutterLine.className = 'cal-now-gutter';
      gutterLine.style.top = top + 'px';
      const dot = document.createElement('div');
      dot.className = 'cal-now-dot';
      gutterLine.appendChild(dot);
      gutterEl.appendChild(gutterLine);
    }
  } else {
    // Week view: dot lives on the line itself at left edge
    const dot = document.createElement('div');
    dot.className = 'cal-now-dot';
    line.appendChild(dot);
  }

  return line;
}

function buildNowLineDashed() {
  const now = new Date();
  const top = (now.getHours() * 60 + now.getMinutes()) / 60 * 80;
  const line = document.createElement('div');
  line.className = 'cal-now-line-dashed';
  line.style.top = top + 'px';
  return line;
}

/* ---- Day view ---- */
function renderDayView() {
  const d = CAL_STATE.cursor;
  const dateStr = d.toLocaleString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('cal-main-label').textContent = dateStr;

  const isToday = calSameDay(d, CAL_STATE.today);
  const titleCol = document.getElementById('cal-day-title-col');
  titleCol.className = isToday ? 'today' : '';
  const dow = d.toLocaleString('default', { weekday: 'short' });
  titleCol.innerHTML = `<div style="font-size:11px">${dow}</div><span class="day-num">${d.getDate()}</span>`;

  const timeCol = document.getElementById('cal-day-time-col');
  timeCol.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'cal-time-label';
    label.textContent = h === 0 ? '' : (h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
    timeCol.appendChild(label);
  }

  const eventsCol = document.getElementById('cal-day-events-col');
  eventsCol.className = 'cal-day-events-col' + (isToday ? ' today' : '');
  eventsCol.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div');
    line.className = 'cal-day-hour-line';
    eventsCol.appendChild(line);
  }

  const key = calDateKey(d);
  const dayEvs = calEventsForDate(key).filter(ev => !ev.allDay);
  layoutTimedEvents(dayEvs).forEach(({ ev, col: evCol, totalCols }) => {
    eventsCol.appendChild(buildTimedEventEl(ev, evCol, totalCols));
  });

  // Grid selection
  bindGridSelection(eventsCol, key);

  if (isToday) eventsCol.appendChild(buildNowLine());

  // Defer scroll until after layout so clientHeight is known
  const body = document.getElementById('cal-day-body');
  const now2 = new Date();
  const nowTop2 = (now2.getHours() * 60 + now2.getMinutes()) / 60 * 80;
  requestAnimationFrame(() => {
    body.scrollTop = Math.max(0, nowTop2 - body.clientHeight / 2);
  });
}

/* ---- Navigation label for month (used by mini-cal sync) ---- */
function syncMiniToMain() {
  CAL_STATE.miniCursor = new Date(CAL_STATE.cursor.getFullYear(), CAL_STATE.cursor.getMonth(), 1);
}

/* ---- Switch view ---- */
function setCalView(view) {
  CAL_STATE.view = view;
  // Sync both toolbar buttons and ribbon buttons
  document.querySelectorAll('.cal-view-btn, .cal-ribbon-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.getElementById('cal-month-view').hidden = view !== 'month';
  document.getElementById('cal-week-view').hidden = (view !== 'week' && view !== 'workweek');
  document.getElementById('cal-day-view').hidden = view !== 'day';
  logEvent({ type: 'cal_view_changed', view });
  renderCalendar();
}

/* ---- Render calendar (all parts) ---- */
function renderCalendar() {
  syncMiniToMain();
  renderMiniCal();
  if (CAL_STATE.view === 'month') renderMonthView();
  else if (CAL_STATE.view === 'week') renderWeekView(7);
  else if (CAL_STATE.view === 'workweek') renderWeekView(5);
  else renderDayView();
}

/* ---- Time picker helpers ---- */
function formatTimeLabel(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

function setTimePickerValue(inputId, btnId, dropdownId, value) {
  document.getElementById(inputId).value = value;
  document.getElementById(btnId).textContent = formatTimeLabel(value);
  // Refresh active state in the dropdown if it's populated
  const dd = document.getElementById(dropdownId);
  dd.querySelectorAll('.cee-time-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.value === value);
  });
}

function initTimePicker(btnId, inputId, dropdownId, isStart) {
  const btn = document.getElementById(btnId);
  const dropdown = document.getElementById(dropdownId);

  // Build 15-min slot list (00:00 to 23:45)
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const value = `${hh}:${mm}`;
      const opt = document.createElement('div');
      opt.className = 'cee-time-option';
      opt.setAttribute('role', 'option');
      opt.dataset.value = value;
      opt.textContent = formatTimeLabel(value);
      opt.addEventListener('click', () => {
        if (isStart) {
          // Preserve duration: calc diff, then set end = start + diff
          const oldStart = document.getElementById('cee-start-input').value;
          const oldEnd = document.getElementById('cee-end-input').value;
          const [osh, osm] = oldStart.split(':').map(Number);
          const [oeh, oem] = oldEnd.split(':').map(Number);
          const duration = (oeh * 60 + oem) - (osh * 60 + osm);
          const [nsh, nsm] = value.split(':').map(Number);
          let newEndMin = (nsh * 60 + nsm) + Math.max(duration, 30);
          if (newEndMin >= 24 * 60) newEndMin = 23 * 60 + 30;
          const neh = Math.floor(newEndMin / 60);
          const nem = newEndMin % 60;
          const newEnd = `${String(neh).padStart(2,'0')}:${String(nem).padStart(2,'0')}`;
          setTimePickerValue('cee-start-input', 'cee-start-btn', 'cee-start-dropdown', value);
          setTimePickerValue('cee-end-input', 'cee-end-btn', 'cee-end-dropdown', newEnd);
        } else {
          setTimePickerValue(inputId, btnId, dropdownId, value);
        }
        dropdown.hidden = true;
        dropdown.setAttribute('aria-hidden', 'true');
      });
      dropdown.appendChild(opt);
    }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isHidden = dropdown.hidden;
    // Close both dropdowns first
    document.getElementById('cee-start-dropdown').hidden = true;
    document.getElementById('cee-start-dropdown').setAttribute('aria-hidden', 'true');
    document.getElementById('cee-end-dropdown').hidden = true;
    document.getElementById('cee-end-dropdown').setAttribute('aria-hidden', 'true');
    if (isHidden) {
      dropdown.hidden = false;
      dropdown.setAttribute('aria-hidden', 'false');
      // Scroll active option into view
      const active = dropdown.querySelector('.cee-time-option.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  });
}

/* ---- Event modal ---- */
function makeAttendeeChip(email, isHost, removable) {
  const chip = document.createElement('div');
  chip.className = 'ev-attendee-chip' + (isHost ? ' is-host' : '');
  chip.setAttribute('role', 'listitem');
  const avatar = document.createElement('div');
  avatar.className = 'ev-attendee-avatar';
  avatar.textContent = emailToInitials(email);
  chip.appendChild(avatar);
  const label = document.createElement('span');
  label.textContent = emailToDisplayName(email) + (isHost ? ' (organizer)' : '');
  chip.appendChild(label);
  if (removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.innerHTML = '&times;';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      CAL_STATE.editingAttendees = CAL_STATE.editingAttendees.filter(a => a !== email);
      renderEditorAttendees();
    });
    chip.appendChild(rm);
  }
  return chip;
}

function renderEditorAttendees() {
  const el = document.getElementById('cee-attendees-chips');
  el.innerHTML = '';
  CAL_STATE.editingAttendees.forEach(email => {
    const valid = isValidEmail(email);
    const chip = makeAttendeeChip(email, false, true);
    chip.className = 'cee-attendee-chip';
    if (!valid) {
      chip.classList.add('invalid');
      const avatar = chip.querySelector('.ev-attendee-avatar');
      if (avatar) avatar.textContent = '!';
    }
    const avatar = chip.querySelector('.ev-attendee-avatar');
    if (avatar) avatar.style.cssText = '';
    el.appendChild(chip);
  });
}

function openEventPopup(ev, anchor) {
  const popup = document.getElementById('ev-popup');
  const colorBar = document.getElementById('ev-popup-color-bar');
  const titleEl = document.getElementById('ev-popup-title');
  const timeEl = document.getElementById('ev-popup-time');
  const locationRow = document.getElementById('ev-popup-location-row');
  const locationEl = document.getElementById('ev-popup-location');
  const hostRow = document.getElementById('ev-popup-host-row');
  const hostEl = document.getElementById('ev-popup-host');
  const attendeesRow = document.getElementById('ev-popup-attendees-row');
  const attendeesEl = document.getElementById('ev-popup-attendees');
  const rsvpSection = document.getElementById('ev-popup-rsvp');

  // Color bar
  colorBar.style.background = EVENT_COLORS[ev.color || 'blue'] || EVENT_COLORS.blue;

  // Title
  titleEl.textContent = ev.title;

  // Time
  const fmt = t => { const [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''} ${ap}`; };
  if (ev.allDay) {
    timeEl.textContent = 'All day';
  } else {
    timeEl.textContent = `${fmt(ev.startTime)} – ${fmt(ev.endTime)}`;
  }

  // Location
  if (ev.location) {
    locationEl.textContent = ev.location;
    locationRow.hidden = false;
  } else {
    locationRow.hidden = true;
  }

  // Host
  if (ev.host) {
    hostEl.textContent = emailToDisplayName(ev.host) + (ev.host === CURRENT_USER ? ' (you)' : '');
    hostRow.hidden = false;
  } else {
    hostRow.hidden = true;
  }

  // Attendees
  const attendees = ev.attendees || [];
  if (attendees.length > 0) {
    attendeesEl.innerHTML = '';
    attendees.forEach(email => {
      const chip = makeAttendeeChip(email, email === ev.host, false);
      attendeesEl.appendChild(chip);
    });
    attendeesRow.hidden = false;
  } else {
    attendeesRow.hidden = true;
  }

  // RSVP — show only if user is an attendee but not the host.
  const isAttendee = attendees.includes(CURRENT_USER);
  const isHost = ev.host === CURRENT_USER;
  if (isAttendee && !isHost) {
    rsvpSection.hidden = false;
    document.querySelectorAll('.ev-rsvp-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.rsvp === (ev.rsvp || 'none'));
      btn.onclick = async () => {
        const rsvp = btn.dataset.rsvp;
        const res = await fetch(`/api/events/${ev.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rsvp }),
        });
        const updated = await res.json();
        const idx = CAL_STATE.events.findIndex(e => e.id === ev.id);
        if (idx !== -1) CAL_STATE.events[idx] = updated;
        ev.rsvp = rsvp;
        document.querySelectorAll('.ev-rsvp-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.rsvp === rsvp);
        });
        logEvent({ type: 'event_rsvp_changed', eventId: ev.id, title: ev.title, rsvp });
        await saveState();

        // Send RSVP confirmation email to host
        if (ev.host && ev.host !== CURRENT_USER) {
          const rsvpLabels = { accepted: 'Accepted', tentative: 'Tentatively Accepted', declined: 'Declined' };
          const label = rsvpLabels[rsvp] || rsvp;
          const fmt = t => { const [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''} ${ap}`; };
          const timeStr = ev.allDay ? 'All day' : `${fmt(ev.startTime)} – ${fmt(ev.endTime)}`;
          const sentEmail = await createEmail({
            to: [{ name: emailToDisplayName(ev.host), email: ev.host }],
            subject: `${label}: ${ev.title}`,
            body: `<p>${emailToDisplayName(CURRENT_USER)} has <strong>${label.toLowerCase()}</strong> the meeting invite.</p><p><strong>${ev.title}</strong><br>${ev.date} &nbsp; ${timeStr}${ev.location ? '<br>' + ev.location : ''}</p>`,
            folder: 'sent',
          });
          STATE.emails.push(sentEmail);
          renderEmailList();
        }

        // Save scroll pos, re-render, restore scroll (avoid jump to current time)
        const weekBody = document.getElementById('cal-week-body');
        const dayBody = document.getElementById('cal-day-body');
        const savedWeek = weekBody ? weekBody.scrollTop : 0;
        const savedDay = dayBody ? dayBody.scrollTop : 0;
        renderCalendar();
        // Double rAF ensures our restore runs after renderCalendar's own rAF
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (weekBody) weekBody.scrollTop = savedWeek;
          if (dayBody) dayBody.scrollTop = savedDay;
        }));
        // Close popup if declined
        if (rsvp === 'declined') closeEventPopup();
      };
    });
  } else {
    rsvpSection.hidden = true;
  }

  // Edit button
  document.getElementById('btn-ev-popup-edit').onclick = () => {
    closeEventPopup();
    openEventModal(ev);
  };

  // Position popup near anchor
  popup.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const pw = popup.offsetWidth || 340;
  const ph = popup.offsetHeight || 300;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.right + 8;
  let top = rect.top;
  if (left + pw > vw - 8) left = rect.left - pw - 8;
  if (left < 8) left = 8;
  if (top + ph > vh - 8) top = vh - ph - 8;
  if (top < 8) top = 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function closeEventPopup() {
  document.getElementById('ev-popup').hidden = true;
}

function openEventModal(ev, defaultDate, defaultStart, defaultEnd) {
  const editor = document.getElementById('cal-event-editor');
  const titleInput = document.getElementById('cee-title-input');
  const dateInput = document.getElementById('cee-date-input');
  const alldayCheck = document.getElementById('cee-allday-check');
  const locationInput = document.getElementById('cee-location-input');
  const notesInput = document.getElementById('cee-notes-input');
  const recurrenceInput = document.getElementById('cee-recurrence-input');
  const deleteBtn = document.getElementById('btn-cee-delete');

  if (ev) {
    CAL_STATE.editingEventId = ev.id;
    CAL_STATE.editingAttendees = (ev.attendees || []).filter(a => a !== CURRENT_USER);
    titleInput.value = ev.title;
    dateInput.value = ev.date;
    setTimePickerValue('cee-start-input', 'cee-start-btn', 'cee-start-dropdown', ev.startTime || '09:00');
    setTimePickerValue('cee-end-input', 'cee-end-btn', 'cee-end-dropdown', ev.endTime || '10:00');
    alldayCheck.checked = !!ev.allDay;
    locationInput.value = ev.location || '';
    notesInput.value = ev.notes || '';
    recurrenceInput.value = ev.recurrence || 'none';
    setEventModalColor(ev.color || 'blue');
    deleteBtn.hidden = false;
  } else {
    CAL_STATE.editingEventId = null;
    CAL_STATE.editingAttendees = [];
    titleInput.value = '';
    dateInput.value = defaultDate || calDateKey(CAL_STATE.cursor);
    setTimePickerValue('cee-start-input', 'cee-start-btn', 'cee-start-dropdown', defaultStart || '09:00');
    setTimePickerValue('cee-end-input', 'cee-end-btn', 'cee-end-dropdown', defaultEnd || '10:00');
    alldayCheck.checked = false;
    locationInput.value = '';
    notesInput.value = '';
    recurrenceInput.value = 'none';
    setEventModalColor('blue');
    deleteBtn.hidden = true;
  }

  renderEditorAttendees();
  document.getElementById('cee-time-row').hidden = alldayCheck.checked;
  editor.hidden = false;
  titleInput.focus();
}

function setEventModalColor(color) {
  CAL_STATE.selectedColor = color;
  document.querySelectorAll('#cee-color-picker .event-color-dot').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function closeEventModal() {
  document.getElementById('cal-event-editor').hidden = true;
  CAL_STATE.editingEventId = null;
  clearAllGridSels();
}

async function saveEvent() {
  const title = document.getElementById('cee-title-input').value.trim() || '(No title)';
  const date = document.getElementById('cee-date-input').value;
  const allDay = document.getElementById('cee-allday-check').checked;
  const startTime = document.getElementById('cee-start-input').value;
  const endTime = document.getElementById('cee-end-input').value;
  const location = document.getElementById('cee-location-input').value.trim();
  const notes = document.getElementById('cee-notes-input').value.trim();
  const recurrence = document.getElementById('cee-recurrence-input').value;
  const color = CAL_STATE.selectedColor;
  const attendees = [CURRENT_USER, ...CAL_STATE.editingAttendees.filter(a => a !== CURRENT_USER)];

  // Validate attendee email addresses
  const invalidAttendees = CAL_STATE.editingAttendees.filter(a => !isValidEmail(a));
  if (invalidAttendees.length > 0) {
    alert('The address is not formatted correctly. Please correct and try again.');
    return;
  }

  const payload = { title, date, allDay, startTime, endTime, location, notes, recurrence, color, attendees, host: CURRENT_USER, rsvp: 'accepted' };

  if (CAL_STATE.editingEventId) {
    const res = await fetch(`/api/events/${CAL_STATE.editingEventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const updated = await res.json();
    const idx = CAL_STATE.events.findIndex(e => e.id === CAL_STATE.editingEventId);
    if (idx !== -1) CAL_STATE.events[idx] = updated;
    logEvent({ type: 'cal_event_edited', eventId: updated.id, title: updated.title, date: updated.date, startTime: updated.startTime, endTime: updated.endTime });
  } else {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const created = await res.json();
    CAL_STATE.events.push(created);
    logEvent({ type: 'cal_event_created', eventId: created.id, title: created.title, date: created.date });

    // Send meeting invite emails to all attendees except the organizer
    const otherAttendees = attendees.filter(a => a !== CURRENT_USER);
    if (otherAttendees.length > 0) {
      const fmt = t => { const [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2,'0') : ''} ${ap}`; };
      const timeStr = allDay ? 'All day' : `${fmt(startTime)} – ${fmt(endTime)}`;
      const attendeeListHtml = attendees.map(a => `<li>${emailToDisplayName(a)}${a === CURRENT_USER ? ' (organizer)' : ''}</li>`).join('');
      const bodyHtml = `<div class="meeting-invite-card">
<p><strong>${emailToDisplayName(CURRENT_USER)}</strong> has invited you to a meeting.</p>
<table class="meeting-detail-table">
  <tr><td><strong>Subject:</strong></td><td>${title}</td></tr>
  <tr><td><strong>Date:</strong></td><td>${date}</td></tr>
  <tr><td><strong>Time:</strong></td><td>${timeStr}</td></tr>
  ${location ? `<tr><td><strong>Location:</strong></td><td>${location}</td></tr>` : ''}
  ${notes ? `<tr><td><strong>Notes:</strong></td><td>${notes}</td></tr>` : ''}
</table>
<p><strong>Attendees:</strong></p>
<ul>${attendeeListHtml}</ul>
</div>`;

      for (const attendeeEmail of otherAttendees) {
        const inviteEmail = await createEmail({
          to: [{ name: emailToDisplayName(attendeeEmail), email: attendeeEmail }],
          subject: `Meeting Invite: ${title}`,
          body: bodyHtml,
          folder: 'inbox',
          read: false,
          focused: true,
          isMeetingInvite: true,
          eventId: created.id,
        });
        // Add to local STATE so it shows in the email list immediately (simulating inbox for attendees)
        STATE.emails.unshift(inviteEmail);
        showInboxToast(inviteEmail);
      }
      renderEmailList();
      renderSidebar();
    }
  }

  await saveState();
  closeEventModal();
  renderCalendar();
}

async function deleteCalEvent() {
  if (!CAL_STATE.editingEventId) return;
  const ev = CAL_STATE.events.find(e => e.id === CAL_STATE.editingEventId);
  await fetch(`/api/events/${CAL_STATE.editingEventId}`, { method: 'DELETE' });
  CAL_STATE.events = CAL_STATE.events.filter(e => e.id !== CAL_STATE.editingEventId);
  if (ev) logEvent({ type: 'cal_event_deleted', eventId: ev.id, title: ev.title, date: ev.date });
  await saveState();
  closeEventModal();
  renderCalendar();
}

/* ---- Switch main view: mail vs calendar ---- */
function setAppView(view) {
  const isCalendar = view === 'calendar';

  // Update app name and title
  const appNameEl = document.getElementById('outlook-app-name');
  const titleEl = document.querySelector('title');
  if (isCalendar) {
    appNameEl.textContent = 'Calendar';
    titleEl.textContent = 'Calendar';
  } else {
    appNameEl.textContent = 'Email';
    titleEl.textContent = 'Email';
  }

  // Toggle content panels
  document.getElementById('sidebar').hidden = isCalendar;
  document.getElementById('email-list-panel').hidden = isCalendar;
  document.getElementById('reading-pane').hidden = isCalendar;
  document.getElementById('calendar-view').hidden = !isCalendar;

  // Toggle tabbar context
  const tbMail = document.getElementById('tabbar-mail');
  const tbCal = document.getElementById('tabbar-calendar');
  if (isCalendar) {
    tbMail.hidden = true;
    tbCal.hidden = false;
  } else {
    tbMail.hidden = false;
    tbCal.hidden = true;
  }

  // Toggle ribbons
  const mailRibbons = ['ribbon', 'ribbon-empty', 'ribbon-format'];
  const calRibbons = ['ribbon-cal-home', 'ribbon-cal-view'];
  if (isCalendar) {
    mailRibbons.forEach(id => { document.getElementById(id).hidden = true; });
    // Show ribbon for currently active cal tab
    const activeCalTab = document.querySelector('.outlook-tab[data-caltab].active');
    const ct = activeCalTab ? activeCalTab.dataset.caltab : 'home';
    document.getElementById('ribbon-cal-home').hidden = ct !== 'home';
    document.getElementById('ribbon-cal-view').hidden = ct !== 'view';
  } else {
    calRibbons.forEach(id => { document.getElementById(id).hidden = true; });
    // Restore the currently active tabbar tab's ribbon
    const activeTab = document.querySelector('.outlook-tab[data-tab].active');
    const t = activeTab ? activeTab.dataset.tab : 'home';
    document.getElementById('ribbon').hidden = t !== 'home';
    document.getElementById('ribbon-empty').hidden = t !== 'view';
    document.getElementById('ribbon-format').hidden = t !== 'format';
  }

  // Nav rail active state
  document.querySelectorAll('.nav-rail-btn').forEach(btn => btn.classList.remove('active'));
  const idx = isCalendar ? 1 : 0;
  document.querySelectorAll('.nav-rail-btn')[idx]?.classList.add('active');

  logEvent({ type: 'app_view_changed', view });
  if (isCalendar) renderCalendar();
}

/* ---- Calendar init ---- */
async function initCalendar() {
  const events = await fetch('/api/events').then(r => r.json());
  CAL_STATE.events = events || [];
  CAL_STATE.cursor = new Date();
  CAL_STATE.miniCursor = new Date();
  // Nav rail buttons
  const navBtns = document.querySelectorAll('.nav-rail-btn');
  navBtns[0]?.addEventListener('click', () => setAppView('mail'));
  navBtns[1]?.addEventListener('click', () => setAppView('calendar'));

  // Calendar tabbar (Home / View)
  document.getElementById('tabbar-calendar').addEventListener('click', e => {
    const btn = e.target.closest('.outlook-tab[data-caltab]');
    if (!btn) return;
    document.querySelectorAll('.outlook-tab[data-caltab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const ct = btn.dataset.caltab;
    document.getElementById('ribbon-cal-home').hidden = ct !== 'home';
    document.getElementById('ribbon-cal-view').hidden = ct !== 'view';
  });

  // Hamburger: in calendar mode toggles cal-sidebar; in mail mode handled by existing bindEvents
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    const calView = document.getElementById('calendar-view');
    if (!calView.hidden) {
      calView.classList.toggle('cal-sidebar-collapsed');
    }
    // mail sidebar toggle is already bound in bindEvents — do nothing here for mail
  });

  // Calendar ribbon: view buttons (Day / Work Week / Week / Month)
  document.querySelectorAll('.cal-ribbon-view-btn').forEach(btn => {
    btn.addEventListener('click', () => setCalView(btn.dataset.view));
  });

  // Calendar ribbon: New Event
  document.getElementById('ribbon-cal-new-event').addEventListener('click', () => {
    const sel = CAL_STATE.gridSel;
    if (sel) {
      const start = minToHHMM(sel.startMin);
      const end = minToHHMM(Math.min(sel.endMin, 24 * 60 - 30));
      clearAllGridSels();
      openEventModal(null, sel.dateKey, start, end);
    } else {
      openEventModal(null);
    }
  });

  // Calendar ribbon: Today
  document.getElementById('ribbon-cal-today').addEventListener('click', () => {
    CAL_STATE.cursor = new Date();
    renderCalendar();
  });

  // Calendar ribbon: collapse/expand
  document.getElementById('btn-cal-ribbon-collapse').addEventListener('click', () => {
    const rib = document.getElementById('ribbon-cal-home');
    rib.classList.toggle('ribbon-collapsed');
    const icon = document.getElementById('cal-ribbon-collapse-icon');
    const isCollapsed = rib.classList.contains('ribbon-collapsed');
    icon.setAttribute('viewBox', '0 0 14 14');
    icon.innerHTML = isCollapsed
      ? '<path d="M7 9.5L2 4.5h10L7 9.5z" fill="currentColor"/>'
      : '<path d="M7 4.5L2 9.5h10L7 4.5z" fill="currentColor"/>';
  });

  // Mini-cal navigation
  document.getElementById('cal-mini-prev').addEventListener('click', () => {
    CAL_STATE.miniCursor = new Date(CAL_STATE.miniCursor.getFullYear(), CAL_STATE.miniCursor.getMonth() - 1, 1);
    renderMiniCal();
  });
  document.getElementById('cal-mini-next').addEventListener('click', () => {
    CAL_STATE.miniCursor = new Date(CAL_STATE.miniCursor.getFullYear(), CAL_STATE.miniCursor.getMonth() + 1, 1);
    renderMiniCal();
  });

  // Main calendar navigation
  document.getElementById('btn-cal-today').addEventListener('click', () => {
    CAL_STATE.cursor = new Date();
    renderCalendar();
  });
  document.getElementById('btn-cal-prev').addEventListener('click', () => {
    navigateCal(-1);
  });
  document.getElementById('btn-cal-next').addEventListener('click', () => {
    navigateCal(1);
  });

  // View switcher (toolbar inside cal-main)
  document.getElementById('cal-view-switcher').addEventListener('click', e => {
    const btn = e.target.closest('.cal-view-btn');
    if (btn) setCalView(btn.dataset.view);
  });

  // Event editor buttons
  document.getElementById('btn-cee-discard').addEventListener('click', closeEventModal);
  document.getElementById('btn-cee-save').addEventListener('click', saveEvent);
  document.getElementById('btn-cee-delete').addEventListener('click', deleteCalEvent);

  // All day toggle hides time row
  document.getElementById('cee-allday-check').addEventListener('change', e => {
    document.getElementById('cee-time-row').hidden = e.target.checked;
  });

  // Color picker
  document.getElementById('cee-color-picker').addEventListener('click', e => {
    const dot = e.target.closest('.event-color-dot');
    if (dot) setEventModalColor(dot.dataset.color);
  });

  // Enter key saves event
  document.getElementById('cee-title-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveEvent();
  });

  // People input: Enter or comma adds an attendee chip
  const peopleInput = document.getElementById('cee-people-input');
  bindAutocomplete(peopleInput, contact => {
    const email = contact.email;
    if (email && !CAL_STATE.editingAttendees.includes(email) && email !== CURRENT_USER) {
      CAL_STATE.editingAttendees.push(email);
      renderEditorAttendees();
    }
    peopleInput.value = '';
  });
  peopleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,$/, '');
      if (val && !CAL_STATE.editingAttendees.includes(val) && val !== CURRENT_USER) {
        CAL_STATE.editingAttendees.push(val);
        renderEditorAttendees();
      }
      e.target.value = '';
    }
  });

  // Autocomplete for compose To / Cc — chip-based
  bindAutocomplete(document.getElementById('compose-to'), contact => {
    const email = contact.email;
    if (email && !STATE.composeToChips.includes(email)) {
      STATE.composeToChips.push(email);
      renderComposeChips('compose-to-chips', STATE.composeToChips, 'composeToChips');
    }
    document.getElementById('compose-to').value = '';
  });
  bindAutocomplete(document.getElementById('compose-cc'), contact => {
    const email = contact.email;
    if (email && !STATE.composeCcChips.includes(email)) {
      STATE.composeCcChips.push(email);
      renderComposeChips('compose-cc-chips', STATE.composeCcChips, 'composeCcChips');
    }
    document.getElementById('compose-cc').value = '';
  });

  // Keydown handlers for compose To/Cc chip creation
  document.getElementById('compose-to').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ';' || e.key === ',') {
      e.preventDefault();
      flushComposeInput('compose-to', 'compose-to-chips', 'composeToChips');
    }
    if (e.key === 'Backspace' && !e.target.value && STATE.composeToChips.length) {
      STATE.composeToChips.pop();
      renderComposeChips('compose-to-chips', STATE.composeToChips, 'composeToChips');
    }
  });
  document.getElementById('compose-cc').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ';' || e.key === ',') {
      e.preventDefault();
      flushComposeInput('compose-cc', 'compose-cc-chips', 'composeCcChips');
    }
    if (e.key === 'Backspace' && !e.target.value && STATE.composeCcChips.length) {
      STATE.composeCcChips.pop();
      renderComposeChips('compose-cc-chips', STATE.composeCcChips, 'composeCcChips');
    }
  });

  // Close popup on outside click; clear grid selection when clicking outside calendar grid
  document.addEventListener('click', e => {
    const popup = document.getElementById('ev-popup');
    if (!popup.hidden && !popup.contains(e.target)) closeEventPopup();
    if (!e.target.closest('.cal-week-day-col') && !e.target.closest('.cal-day-events-col')) {
      clearAllGridSels();
    }
  });
  document.getElementById('btn-ev-popup-close').addEventListener('click', closeEventPopup);

  // Time picker setup
  initTimePicker('cee-start-btn', 'cee-start-input', 'cee-start-dropdown', true);
  initTimePicker('cee-end-btn', 'cee-end-input', 'cee-end-dropdown', false);

  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.cee-time-picker')) {
      document.getElementById('cee-start-dropdown').hidden = true;
      document.getElementById('cee-start-dropdown').setAttribute('aria-hidden', 'true');
      document.getElementById('cee-end-dropdown').hidden = true;
      document.getElementById('cee-end-dropdown').setAttribute('aria-hidden', 'true');
    }
  });

  // Set initial view — shows correct pane and renders
  setCalView('workweek');
}

function navigateCal(dir) {
  if (CAL_STATE.view === 'month') {
    CAL_STATE.cursor = new Date(CAL_STATE.cursor.getFullYear(), CAL_STATE.cursor.getMonth() + dir, 1);
  } else if (CAL_STATE.view === 'week' || CAL_STATE.view === 'workweek') {
    const d = new Date(CAL_STATE.cursor);
    d.setDate(d.getDate() + dir * 7);
    CAL_STATE.cursor = d;
  } else {
    const d = new Date(CAL_STATE.cursor);
    d.setDate(d.getDate() + dir);
    CAL_STATE.cursor = d;
  }
  renderCalendar();
}

/* ===== INIT ===== */
async function init() {
  const [emails, folders] = await Promise.all([
    fetch('/api/emails').then(r => r.json()),
    fetch('/api/folders').then(r => r.json()),
  ]);

  STATE.emails = emails;
  STATE.folders = folders;
  refreshFolderCounts();

  bindEvents();
  updateFormatRibbon();
  renderSidebar();
  renderEmailList();
  renderReadingPane();
  await initCalendar();
  await saveState();
}

init().catch(console.error);
