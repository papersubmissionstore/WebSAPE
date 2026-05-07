// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  users: [],
  conversations: [],
  messages: [],
  currentUserId: 'user-me',
  activeConversationId: null,
  searchQuery: '',
  mutedConvIds: new Set(),
  // reactions: { [msgId]: { [emoji]: [userId, ...] } }
  reactions: {},
  // replyingToMsgId — the message being quoted/replied to
  replyingToMsgId: null
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getUserById(id) {
  return state.users.find(u => u.id === id);
}

function getConversationById(id) {
  return state.conversations.find(c => c.id === id);
}

function getOtherParticipant(conv) {
  const otherId = conv.participantIds.find(id => id !== state.currentUserId);
  return getUserById(otherId);
}

function getConvDisplayName(conv) {
  if (conv.type !== 'direct') return conv.name;
  const other = getOtherParticipant(conv);
  return other ? other.name : 'Unknown';
}

function getConvMessages(convId) {
  return state.messages.filter(m => m.conversationId === convId);
}

function getLastMessage(conv) {
  const msgs = getConvMessages(conv.id);
  return msgs[msgs.length - 1] || null;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatFullTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return 'Today';
  const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  if (isYesterday) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function statusLabel(status) {
  const map = { available: 'Available', busy: 'Busy', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' };
  return map[status] || status;
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function logEvent(payload) {
  try {
    await fetch('/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('Failed to log event', e);
  }
}

async function saveState() {
  try {
    const snapshot = {
      currentUserId: state.currentUserId,
      activeConversationId: state.activeConversationId,
      searchQuery: state.searchQuery,
      conversations: state.conversations.map(c => ({
        id: c.id,
        isFavorite: c.isFavorite,
        unreadCount: c.unreadCount,
        isMuted: state.mutedConvIds.has(c.id)
      })),
      messages: state.messages.map(m => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        body: m.body,
        timestamp: m.timestamp,
        isRead: m.isRead,
        replyToId: m.replyToId || null
      })),
      reactions: state.reactions
    };
    await fetch('/save-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
  } catch (e) {
    console.warn('Failed to save state', e);
  }
}

// ─── Render Helpers ───────────────────────────────────────────────────────────
function getConvAvatarData(conv) {
  if (conv.type === 'direct') {
    const other = getOtherParticipant(conv);
    return {
      initials: other ? other.initials : '?',
      color: other ? other.color : '#888',
      isGroup: false,
      status: other ? other.status : 'offline'
    };
  }
  // Group/channel: use first letter of name, show member count as initials hint
  const initial = conv.name ? conv.name[0].toUpperCase() : '#';
  return {
    initials: conv.type === 'channel' ? '#' : initial,
    color: conv.type === 'channel' ? '#4F5B93' : '#6264A7',
    isGroup: true,
    status: null
  };
}

// ─── Render Conversation Item ─────────────────────────────────────────────────
function renderConvItem(conv) {
  const item = document.createElement('div');
  item.className = 'conv-item';
  item.id = 'conv-' + conv.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-label', getConvDisplayName(conv));
  item.setAttribute('tabindex', '0');
  item.dataset.convId = conv.id;
  if (conv.id === state.activeConversationId) item.classList.add('active');
  if (conv.unreadCount > 0 && !state.mutedConvIds.has(conv.id)) item.classList.add('has-unread');

  const { initials, color, isGroup, status } = getConvAvatarData(conv);

  const avatarEl = document.createElement('div');
  avatarEl.className = isGroup ? 'conv-avatar group-avatar' : 'conv-avatar';
  avatarEl.style.background = color;
  avatarEl.textContent = initials;

  if (status) {
    const dot = document.createElement('div');
    dot.className = `status-dot ${status}`;
    avatarEl.appendChild(dot);
    avatarEl.title = statusLabel(status);
  }

  const infoEl = document.createElement('div');
  infoEl.className = 'conv-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'conv-name';
  nameEl.textContent = getConvDisplayName(conv);

  const lastMsg = getLastMessage(conv);
  const previewEl = document.createElement('div');
  previewEl.className = 'conv-preview';
  if (lastMsg) {
    const sender = getUserById(lastMsg.senderId);
    const prefix = lastMsg.senderId === state.currentUserId
      ? 'You: '
      : (conv.type !== 'direct' && sender ? `${sender.name.split(' ')[0]}: ` : '');
    previewEl.textContent = prefix + lastMsg.body;
  }

  infoEl.appendChild(nameEl);
  infoEl.appendChild(previewEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'conv-meta';

  const timeEl = document.createElement('div');
  timeEl.className = 'conv-time';
  if (lastMsg) timeEl.textContent = formatTime(lastMsg.timestamp);
  metaEl.appendChild(timeEl);

  const isMuted = state.mutedConvIds.has(conv.id);
  if (isMuted) {
    const muteIcon = document.createElement('span');
    muteIcon.className = 'mute-icon';
    muteIcon.title = 'Muted';
    muteIcon.textContent = '🔇';
    metaEl.appendChild(muteIcon);
  } else if (conv.unreadCount > 0) {
    const badge = document.createElement('div');
    badge.className = 'unread-badge';
    badge.textContent = conv.unreadCount;
    metaEl.appendChild(badge);
  }

  item.appendChild(avatarEl);
  item.appendChild(infoEl);
  item.appendChild(metaEl);

  // Context menu on right-click
  item.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConvContextMenu(e, conv);
  });

  item.addEventListener('click', () => openConversation(conv.id));
  return item;
}

// ─── Context-menu keyboard navigation helper ─────────────────────────────────
function addContextMenuKeyboard(menu) {
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const cur = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(cur + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(cur - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.activeElement.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      removeContextMenus();
    }
  });
}

// ─── Conversation Context Menu ────────────────────────────────────────────────
function showConvContextMenu(e, conv) {
  removeContextMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Conversation options');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const isMuted = state.mutedConvIds.has(conv.id);
  const isFav = conv.isFavorite;

  const items = [
    { label: isFav ? '☆ Remove from Favorites' : '★ Add to Favorites', action: () => { toggleFavoriteById(conv.id); } },
    { label: isMuted ? '🔔 Unmute' : '🔇 Mute', action: () => { toggleMute(conv.id); } },
    { label: conv.unreadCount === 0 ? '● Mark as Unread' : '○ Mark as Read', action: () => { toggleReadState(conv); } },
    { separator: true },
    { label: '📌 Pin to Top', action: () => showToast('Pin feature coming soon') }
  ];

  let ctxIdx = 0;
  let firstItem = null;
  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.id = 'conv-ctx-' + (ctxIdx++);
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '-1');
    el.textContent = item.label;
    el.addEventListener('click', () => { item.action(); removeContextMenus(); });
    menu.appendChild(el);
    if (!firstItem) firstItem = el;
  });

  addContextMenuKeyboard(menu);
  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (e.clientX - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (e.clientY - rect.height) + 'px';

  if (firstItem) firstItem.focus();
  setTimeout(() => document.addEventListener('click', removeContextMenus, { once: true }), 0);
}

function removeContextMenus() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
}

// ─── Message Context Menu (three-dot) ─────────────────────────────────────────
function showMsgContextMenu(e, msgId) {
  removeContextMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Message options');
  // Position near the button
  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';

  const items = [
    {
      label: 'Reply with quote',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 8H6M6 8l3-3M6 8l3 3"/><path d="M6 12h8a2 2 0 002-2V5a2 2 0 00-2-2H6a2 2 0 00-2 2v10l3-3"/></svg>`,
      action: () => setReplyTo(msgId)
    },
    {
      label: 'Forward',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 5l5 5-5 5"/><path d="M16 10H8a4 4 0 000 8h1"/></svg>`,
      action: () => showForwardPicker(msgId)
    },
    { separator: true },
    {
      label: 'Delete',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6h10M8 6V4h4v2M9 10v5M11 10v5M6 6l.7 10.1A1 1 0 007.7 17h4.6a1 1 0 001-.9L14 6"/></svg>`,
      action: () => deleteMessage(msgId),
    },
  ];

  let firstItem = null;
  let msgCtxIdx = 0;
  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    el.id = 'msg-ctx-' + (msgCtxIdx++) + '-' + msgId;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '-1');
    el.innerHTML = `<span class="ctx-icon">${item.icon}</span><span>${item.label}</span>`;
    el.addEventListener('click', () => { item.action(); removeContextMenus(); });
    menu.appendChild(el);
    if (!firstItem) firstItem = el;
  });

  addContextMenuKeyboard(menu);
  document.body.appendChild(menu);

  // Clamp so menu doesn't go off-screen right or bottom
  const mRect = menu.getBoundingClientRect();
  if (mRect.right > window.innerWidth - 8) {
    menu.style.left = (window.innerWidth - mRect.width - 8) + 'px';
  }
  if (mRect.bottom > window.innerHeight - 8) {
    menu.style.top = (rect.top - mRect.height - 4) + 'px';
  }

  if (firstItem) firstItem.focus();
  setTimeout(() => document.addEventListener('click', removeContextMenus, { once: true }), 0);
}

function deleteMessage(msgId) {
  const idx = state.messages.findIndex(m => m.id === msgId);
  if (idx !== -1) {
    state.messages.splice(idx, 1);
    renderMessages(state.activeConversationId);
  }
}

// ─── Forward Message ──────────────────────────────────────────────────────────
function showForwardPicker(msgId) {
  const msg = state.messages.find(m => m.id === msgId);
  if (!msg) return;

  const selectedRecipients = []; // array of conv objects

  // Build overlay
  const overlay = document.createElement('div');
  overlay.className = 'forward-overlay';
  overlay.id = 'forward-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Forward message');

  const modal = document.createElement('div');
  modal.className = 'forward-modal';
  modal.id = 'forward-modal';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'forward-header';
  header.innerHTML = `
    <div class="forward-header-text">
      <div class="forward-title">Forward this message</div>
      <div class="forward-subtitle">You can forward to any chat or channel.</div>
    </div>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'forward-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // ── Recipients field ──
  const recipientsSection = document.createElement('div');
  recipientsSection.className = 'forward-recipients-section';
  const recipientsLabel = document.createElement('label');
  recipientsLabel.className = 'forward-label';
  recipientsLabel.textContent = 'Add recipients';
  const requiredStar = document.createElement('span');
  requiredStar.className = 'forward-required';
  requiredStar.textContent = ' *';
  recipientsLabel.appendChild(requiredStar);
  recipientsSection.appendChild(recipientsLabel);

  const recipientsField = document.createElement('div');
  recipientsField.className = 'forward-recipients-field';

  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'forward-chips';

  const recipientInput = document.createElement('input');
  recipientInput.className = 'forward-recipient-input';
  recipientInput.type = 'text';
  recipientInput.placeholder = 'Type a name or group…';

  recipientsField.appendChild(chipsContainer);
  recipientsField.appendChild(recipientInput);
  recipientsSection.appendChild(recipientsField);

  // Autocomplete dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'forward-dropdown';
  dropdown.style.display = 'none';
  recipientsSection.appendChild(dropdown);

  modal.appendChild(recipientsSection);

  // ── Recipients logic ──
  function renderChips() {
    chipsContainer.innerHTML = '';
    selectedRecipients.forEach((conv, idx) => {
      const chip = document.createElement('div');
      chip.className = 'forward-chip';
      const { initials, color, isGroup, status } = getConvAvatarData(conv);
      const avatar = document.createElement('div');
      avatar.className = isGroup ? 'forward-chip-avatar group-avatar' : 'forward-chip-avatar';
      avatar.style.background = color;
      avatar.textContent = initials;
      const chipName = document.createElement('span');
      chipName.textContent = getConvDisplayName(conv);
      const removeBtn = document.createElement('span');
      removeBtn.className = 'forward-chip-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedRecipients.splice(idx, 1);
        renderChips();
        updateForwardBtn();
      });
      chip.appendChild(avatar);
      chip.appendChild(chipName);
      chip.appendChild(removeBtn);
      chipsContainer.appendChild(chip);
    });
  }

  function renderDropdown(filter) {
    dropdown.innerHTML = '';
    const query = (filter || '').toLowerCase().trim();
    if (!query) { dropdown.style.display = 'none'; return; }

    const selectedIds = new Set(selectedRecipients.map(c => c.id));
    const matches = state.conversations.filter(c => {
      if (c.id === msg.conversationId) return false;
      if (selectedIds.has(c.id)) return false;
      return getConvDisplayName(c).toLowerCase().includes(query);
    });

    if (matches.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    matches.slice(0, 8).forEach(conv => {
      const row = document.createElement('div');
      row.className = 'forward-dropdown-item';
      const { initials, color, isGroup, status } = getConvAvatarData(conv);
      const avatar = document.createElement('div');
      avatar.className = isGroup ? 'conv-avatar group-avatar' : 'conv-avatar';
      avatar.style.background = color;
      avatar.textContent = initials;
      if (status) {
        const dot = document.createElement('div');
        dot.className = `status-dot ${status}`;
        avatar.appendChild(dot);
      }
      const name = document.createElement('span');
      name.className = 'forward-dropdown-name';
      name.textContent = getConvDisplayName(conv);
      row.appendChild(avatar);
      row.appendChild(name);
      row.addEventListener('click', () => {
        selectedRecipients.push(conv);
        renderChips();
        recipientInput.value = '';
        dropdown.style.display = 'none';
        updateForwardBtn();
        recipientInput.focus();
      });
      dropdown.appendChild(row);
    });
    dropdown.style.display = 'block';
  }

  recipientInput.addEventListener('input', () => renderDropdown(recipientInput.value));
  recipientInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && recipientInput.value === '' && selectedRecipients.length > 0) {
      selectedRecipients.pop();
      renderChips();
      updateForwardBtn();
    }
  });

  // ── Message preview section ──
  const previewSection = document.createElement('div');
  previewSection.className = 'forward-preview-section';
  const previewLabel = document.createElement('label');
  previewLabel.className = 'forward-label';
  previewLabel.textContent = 'Message preview';
  previewSection.appendChild(previewLabel);

  // Additional message input
  const additionalInput = document.createElement('input');
  additionalInput.className = 'forward-additional-msg';
  additionalInput.type = 'text';
  additionalInput.placeholder = 'Add a message (optional)';
  previewSection.appendChild(additionalInput);

  // Original message preview card
  const previewCard = document.createElement('div');
  previewCard.className = 'forward-preview-card';
  const sender = getUserById(msg.senderId);
  const senderName = sender ? sender.name : 'Unknown';
  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const bodyText = msg.bodyText || msg.body.replace(/<[^>]+>/g, '');

  // Sender info row in preview
  const senderRow = document.createElement('div');
  senderRow.className = 'forward-preview-sender';
  const senderAvatar = document.createElement('div');
  senderAvatar.className = 'forward-preview-avatar';
  if (sender) {
    const first = sender.name.split(' ')[0] || '';
    const last = sender.name.split(' ')[1] || '';
    senderAvatar.textContent = (first[0] || '') + (last[0] || '');
    senderAvatar.style.background = '#5B5FC7';
  } else {
    senderAvatar.textContent = '?';
    senderAvatar.style.background = '#888';
  }
  const senderInfo = document.createElement('div');
  senderInfo.className = 'forward-preview-sender-info';
  senderInfo.innerHTML = `<span class="forward-preview-name">${senderName}</span> <span class="forward-preview-time">${timeStr}</span>`;
  senderRow.appendChild(senderAvatar);
  senderRow.appendChild(senderInfo);
  previewCard.appendChild(senderRow);

  const previewBody = document.createElement('div');
  previewBody.className = 'forward-preview-body';
  previewBody.textContent = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;
  previewCard.appendChild(previewBody);
  previewSection.appendChild(previewCard);

  modal.appendChild(previewSection);

  // ── Footer buttons ──
  const footer = document.createElement('div');
  footer.className = 'forward-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'forward-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const forwardBtn = document.createElement('button');
  forwardBtn.className = 'forward-send-btn';
  forwardBtn.textContent = 'Forward';
  forwardBtn.disabled = true;

  function updateForwardBtn() {
    forwardBtn.disabled = selectedRecipients.length === 0;
  }

  forwardBtn.addEventListener('click', () => {
    if (selectedRecipients.length === 0) return;
    const additionalMsg = additionalInput.value.trim();
    selectedRecipients.forEach(conv => {
      forwardMessageTo(msg, conv.id, additionalMsg);
    });
    overlay.remove();
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(forwardBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on overlay background click
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  recipientInput.focus();
}

function forwardMessageTo(originalMsg, targetConvId, additionalMsg) {
  const sender = getUserById(originalMsg.senderId);
  const senderName = sender ? sender.name : 'Unknown';
  const bodyText = originalMsg.bodyText || originalMsg.body.replace(/<[^>]+>/g, '');

  let fwdBody = '';
  if (additionalMsg) fwdBody += additionalMsg + '\n\n';
  fwdBody += `[Forwarded from ${senderName}]\n${bodyText}`;

  const newMsg = {
    id: `msg-${Date.now()}`,
    conversationId: targetConvId,
    senderId: state.currentUserId,
    body: renderMarkdown(fwdBody),
    bodyText: fwdBody,
    timestamp: new Date().toISOString(),
    isRead: true,
    replyToId: null
  };

  state.messages.push(newMsg);

  logEvent({
    type: 'message_forwarded',
    originalMessageId: originalMsg.id,
    sourceConversationId: originalMsg.conversationId,
    targetConversationId: targetConvId,
    messageId: newMsg.id,
    body: fwdBody
  });

  // If forwarded to the currently active conversation, re-render messages
  if (state.activeConversationId === targetConvId) {
    renderMessages(targetConvId);
  }
  renderConvList();
  saveState();

  const targetConv = getConversationById(targetConvId);
  const targetName = targetConv ? getConvDisplayName(targetConv) : 'conversation';
  showToast(`Message forwarded to ${targetName}`);
}

function startEditMessage(msgId) {
  const msg = state.messages.find(m => m.id === msgId);
  if (!msg || msg.senderId !== state.currentUserId) return;

  removeEmojiPickers();
  removeContextMenus();

  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!row) return;
  const bubble = row.querySelector('.message-bubble');
  if (!bubble) return;

  // Prevent double-editing
  if (row.querySelector('.inline-edit-box')) return;

  row.classList.add('editing');

  const originalHTML = msg.body;

  // Hide the bubble and insert a clean white edit box in its place
  bubble.style.display = 'none';

  const editBox = document.createElement('div');
  editBox.className = 'inline-edit-box';
  editBox.contentEditable = 'true';
  editBox.innerHTML = originalHTML;
  bubble.parentNode.insertBefore(editBox, bubble.nextSibling);

  // Move cursor to end
  editBox.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(editBox);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);

  // Save/Cancel buttons
  const controls = document.createElement('div');
  controls.className = 'inline-edit-controls';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'inline-edit-btn save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'inline-edit-btn cancel';
  cancelBtn.textContent = 'Cancel';

  controls.appendChild(saveBtn);
  controls.appendChild(cancelBtn);
  editBox.parentNode.insertBefore(controls, editBox.nextSibling);

  function finishEdit(save) {
    bubble.style.display = '';
    row.classList.remove('editing');
    editBox.remove();
    controls.remove();
    if (save) {
      msg.body = editBox.innerHTML;
      msg.bodyText = editBox.innerText.trim();
      saveState();
      renderConvList();
      bubble.innerHTML = msg.body;
    }
  }

  saveBtn.addEventListener('click', () => finishEdit(true));
  cancelBtn.addEventListener('click', () => finishEdit(false));

  editBox.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      editBox.removeEventListener('keydown', onKey);
      finishEdit(true);
    }
    if (e.key === 'Escape') {
      editBox.removeEventListener('keydown', onKey);
      finishEdit(false);
    }
  });
}

// ─── Mute ─────────────────────────────────────────────────────────────────────
function toggleMute(convId) {
  if (state.mutedConvIds.has(convId)) {
    state.mutedConvIds.delete(convId);
    showToast('Notifications unmuted');
    logEvent({ type: 'conversation_muted', conversationId: convId, muted: false });
  } else {
    state.mutedConvIds.add(convId);
    showToast('Notifications muted');
    logEvent({ type: 'conversation_muted', conversationId: convId, muted: true });
  }
  renderConvList();
  if (state.activeConversationId === convId) {
    const conv = getConversationById(convId);
    if (conv) renderChatHeader(conv);
  }
  saveState();
}

// ─── Mark as Read/Unread ──────────────────────────────────────────────────────
function toggleReadState(conv) {
  if (conv.unreadCount === 0) {
    conv.unreadCount = 1;
    logEvent({ type: 'conversation_marked_unread', conversationId: conv.id });
  } else {
    conv.unreadCount = 0;
    logEvent({ type: 'conversation_marked_read', conversationId: conv.id });
  }
  renderConvList();
  saveState();
}

// ─── Render Conversation List ─────────────────────────────────────────────────
function renderConvList() {
  const query = state.searchQuery.trim().toLowerCase();

  const favoritesListEl = document.getElementById('favorites-list');
  const recentListEl = document.getElementById('recent-list');
  const favSection = document.getElementById('favorites-section');
  const recentSection = document.getElementById('recent-section');
  const searchSection = document.getElementById('search-results-section');
  const searchList = document.getElementById('search-results-list');

  if (query) {
    favSection.style.display = 'none';
    recentSection.style.display = 'none';
    searchSection.style.display = 'block';

    const results = state.conversations.filter(c => {
      const name = getConvDisplayName(c).toLowerCase();
      const msgs = getConvMessages(c.id);
      const hasMsg = msgs.some(m => m.body.toLowerCase().includes(query));
      return name.includes(query) || hasMsg;
    });

    searchList.innerHTML = '';
    if (results.length === 0) {
      searchList.innerHTML = '<div class="no-results">No results found</div>';
    } else {
      results.forEach(c => searchList.appendChild(renderConvItem(c)));
    }
    return;
  }

  // Normal view
  favSection.style.display = 'block';
  recentSection.style.display = 'block';
  searchSection.style.display = 'none';

  const favorites = state.conversations.filter(c => c.isFavorite);
  const recent = state.conversations.filter(c => !c.isFavorite);

  favoritesListEl.innerHTML = '';
  if (favorites.length === 0) {
    favoritesListEl.innerHTML = '<div class="no-results">No favorites yet</div>';
  } else {
    favorites.forEach(c => favoritesListEl.appendChild(renderConvItem(c)));
  }

  recentListEl.innerHTML = '';
  recent.forEach(c => recentListEl.appendChild(renderConvItem(c)));
}

// ─── Render Chat Header ───────────────────────────────────────────────────────
function renderChatHeader(conv) {
  const { initials, color, isGroup, status } = getConvAvatarData(conv);

  const headerAvatar = document.getElementById('chat-header-avatar');
  headerAvatar.className = isGroup ? 'chat-header-avatar group-avatar' : 'chat-header-avatar';
  headerAvatar.style.background = color;
  headerAvatar.textContent = initials;

  document.getElementById('chat-header-name').textContent = getConvDisplayName(conv);

  let subText;
  if (conv.type === 'direct') {
    const other = getOtherParticipant(conv);
    subText = other ? statusLabel(other.status) : '';
  } else if (conv.type === 'channel') {
    subText = `# ${conv.name} · ${conv.participantIds.length} members`;
  } else {
    subText = `${conv.participantIds.length} members`;
  }
  document.getElementById('chat-header-sub').textContent = subText;

  const favBtn = document.getElementById('favorite-btn');
  favBtn.classList.toggle('is-favorite', conv.isFavorite);
  favBtn.title = conv.isFavorite ? 'Remove from favorites' : 'Add to favorites';

  const muteBtn = document.getElementById('mute-btn');
  const isMuted = state.mutedConvIds.has(conv.id);
  muteBtn.title = isMuted ? 'Unmute notifications' : 'Mute notifications';
  muteBtn.querySelector('.mute-label').textContent = isMuted ? '🔔' : '🔇';
}

// ─── Reply To ─────────────────────────────────────────────────────────────────
function setReplyTo(msgId) {
  state.replyingToMsgId = msgId;
  const msg = state.messages.find(m => m.id === msgId);
  if (!msg) return;
  const sender = getUserById(msg.senderId);
  const senderName = sender ? sender.name : 'Unknown';
  const previewText = (msg.bodyText || msg.body.replace(/<[^>]+>/g, '')).slice(0, 200);

  const input = document.getElementById('message-input');
  // Remove any existing quote block
  const existing = input.querySelector('.input-quote-block');
  if (existing) existing.remove();

  const quoteBlock = document.createElement('div');
  quoteBlock.className = 'input-quote-block';
  quoteBlock.contentEditable = 'false';
  quoteBlock.innerHTML = `
    <div class="input-quote-inner">
      <span class="input-quote-author">${senderName}</span>
      <span class="input-quote-text">${previewText}</span>
    </div>
    <button class="input-quote-cancel" title="Cancel reply">✕</button>
  `;
  quoteBlock.querySelector('.input-quote-cancel').addEventListener('click', (e) => {
    e.preventDefault();
    cancelReply();
  });

  // Insert at start of input
  input.insertBefore(quoteBlock, input.firstChild);

  // Add a zero-width space after if none so cursor lands after block
  if (!quoteBlock.nextSibling || quoteBlock.nextSibling.nodeType !== Node.TEXT_NODE) {
    input.appendChild(document.createTextNode('\u200B'));
  }

  // Place cursor after the quote block
  const range = document.createRange();
  const sel = window.getSelection();
  range.setStartAfter(quoteBlock);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  input.focus();

  // Trigger send button state update
  input.dispatchEvent(new Event('input'));
}

function cancelReply() {
  state.replyingToMsgId = null;
  const input = document.getElementById('message-input');
  const quoteBlock = input.querySelector('.input-quote-block');
  if (quoteBlock) quoteBlock.remove();
  // Clean up lingering zero-width spaces
  input.childNodes.forEach(n => {
    if (n.nodeType === Node.TEXT_NODE && n.textContent === '\u200B') n.remove();
  });
  document.getElementById('reply-bar').style.display = 'none';
  input.dispatchEvent(new Event('input'));
}

// ─── Emoji Reactions ──────────────────────────────────────────────────────────
const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '👏', '🔥'];

function toggleReaction(msgId, emoji) {
  if (!state.reactions[msgId]) state.reactions[msgId] = {};
  if (!state.reactions[msgId][emoji]) state.reactions[msgId][emoji] = [];

  const list = state.reactions[msgId][emoji];
  const idx = list.indexOf(state.currentUserId);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (list.length === 0) delete state.reactions[msgId][emoji];
    if (Object.keys(state.reactions[msgId]).length === 0) delete state.reactions[msgId];
  } else {
    list.push(state.currentUserId);
  }

  // Re-render only this message's reactions row
  renderMessageReactions(msgId);
  logEvent({ type: 'reaction_toggled', messageId: msgId, emoji });
  saveState();
}

function renderMessageReactions(msgId) {
  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!row) return;
  let reactionsEl = row.querySelector('.message-reactions');
  const rxData = state.reactions[msgId];
  if (!rxData || Object.keys(rxData).length === 0) {
    if (reactionsEl) reactionsEl.remove();
    return;
  }
  if (!reactionsEl) {
    reactionsEl = document.createElement('div');
    reactionsEl.className = 'message-reactions';
    const contentEl = row.querySelector('.message-content');
    if (contentEl) contentEl.appendChild(reactionsEl);
  }
  reactionsEl.innerHTML = '';
  Object.entries(rxData).forEach(([emoji, users]) => {
    if (users.length === 0) return;
    const chip = document.createElement('button');
    chip.className = 'reaction-chip';
    if (users.includes(state.currentUserId)) chip.classList.add('mine');
    chip.title = users.map(uid => getUserById(uid)?.name || uid).join(', ');
    chip.textContent = `${emoji} ${users.length}`;
    chip.addEventListener('click', () => toggleReaction(msgId, emoji));
    reactionsEl.appendChild(chip);
  });
}

function showEmojiPicker(msgId, anchorEl) {
  removeEmojiPickers();
  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  picker.id = 'emoji-picker';
  picker.setAttribute('role', 'toolbar');
  picker.setAttribute('aria-label', 'Emoji reactions');
  QUICK_EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', 'React with ' + emoji);
    btn.addEventListener('click', () => {
      toggleReaction(msgId, emoji);
      removeEmojiPickers();
    });
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);

  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = (rect.top - picker.offsetHeight - 4) + 'px';
  picker.style.left = rect.left + 'px';

  // Reposition after layout
  requestAnimationFrame(() => {
    const pr = picker.getBoundingClientRect();
    if (pr.top < 4) picker.style.top = (rect.bottom + 4) + 'px';
    if (pr.right > window.innerWidth - 4) picker.style.left = (window.innerWidth - pr.width - 4) + 'px';
  });

  setTimeout(() => document.addEventListener('click', removeEmojiPickers, { once: true }), 0);
}

function removeEmojiPickers() {
  document.querySelectorAll('.emoji-picker').forEach(p => p.remove());
}

// ─── Render Messages ──────────────────────────────────────────────────────────
function renderMessages(convId) {
  const msgs = getConvMessages(convId);
  const listEl = document.getElementById('message-list');
  listEl.innerHTML = '';

  let lastDate = null;
  const conv = getConversationById(convId);

  // Compute the index of the first unread message (mirrors unreadCount logic)
  let firstUnreadIdx = -1;
  const lastMyIdx = msgs.map(m => m.senderId).lastIndexOf(state.currentUserId);
  const unreadStartIdx = lastMyIdx === -1 ? 0 : lastMyIdx + 1;
  for (let j = unreadStartIdx; j < msgs.length; j++) {
    if (!msgs[j].isRead && msgs[j].senderId !== state.currentUserId) {
      firstUnreadIdx = j;
      break;
    }
  }

  msgs.forEach((msg, i) => {
    // Insert "last read" divider just before the first unread message
    if (i === firstUnreadIdx) {
      const unreadDivider = document.createElement('div');
      unreadDivider.className = 'date-divider unread-divider';
      unreadDivider.textContent = 'New';
      listEl.appendChild(unreadDivider);
    }

    const msgDate = new Date(msg.timestamp).toDateString();
    if (msgDate !== lastDate) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = formatDateLabel(msg.timestamp);
      listEl.appendChild(divider);
      lastDate = msgDate;
    }

    const isSent = msg.senderId === state.currentUserId;
    const sender = getUserById(msg.senderId);

    const prevMsg = msgs[i - 1];
    const nextMsg = msgs[i + 1];
    const FIVE_MIN = 5 * 60 * 1000;
    const isFirstInGroup = !prevMsg
      || prevMsg.senderId !== msg.senderId
      || (new Date(msg.timestamp) - new Date(prevMsg.timestamp)) > FIVE_MIN;
    const isLastInGroup = !nextMsg
      || nextMsg.senderId !== msg.senderId
      || (new Date(nextMsg.timestamp) - new Date(msg.timestamp)) > FIVE_MIN;

    const row = document.createElement('div');
    row.className = `message-row ${isSent ? 'sent' : 'received'}${!isFirstInGroup ? ' grouped' : ''}`;
    row.setAttribute('role', 'listitem');
    row.dataset.msgId = msg.id;

    // Hover action bar (Teams-style floating pill) — built into contentEl for correct positioning
    const actionBar = document.createElement('div');
    actionBar.className = `message-action-bar${isSent ? ' sent' : ''}`;
    actionBar.setAttribute('role', 'toolbar');
    actionBar.setAttribute('aria-label', 'Message actions');

    // Emoji react button
    const emojiBtn = document.createElement('button');
    emojiBtn.className = 'msg-action-btn';
    emojiBtn.id = 'msg-react-' + msg.id;
    emojiBtn.title = 'React';
    emojiBtn.setAttribute('aria-label', 'React to message');
    emojiBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M7 11.5c.5 1.5 5.5 1.5 6 0"/><circle cx="7.5" cy="8.5" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8.5" r="1" fill="currentColor" stroke="none"/></svg>`;
    emojiBtn.addEventListener('click', e => { e.stopPropagation(); showEmojiPicker(msg.id, emojiBtn); });

    // Reply button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'msg-action-btn';
    replyBtn.id = 'msg-reply-' + msg.id;
    replyBtn.title = 'Reply';
    replyBtn.setAttribute('aria-label', 'Reply to message');
    replyBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5L4 10l5 5"/><path d="M4 10h8a4 4 0 010 8h-1"/></svg>`;
    replyBtn.addEventListener('click', e => { e.stopPropagation(); setReplyTo(msg.id); });

    // Edit button (pen icon) — only for own messages
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.id = 'msg-edit-' + msg.id;
    editBtn.title = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 3.5a2.121 2.121 0 013 3L7 16H4v-3L13.5 3.5z"/></svg>`;
    editBtn.style.display = isSent ? '' : 'none';
    editBtn.addEventListener('click', e => { e.stopPropagation(); startEditMessage(msg.id); });

    // More (three-dot) button
    const moreBtn = document.createElement('button');
    moreBtn.className = 'msg-action-btn';
    moreBtn.id = 'msg-more-' + msg.id;
    moreBtn.title = 'More actions';
    moreBtn.setAttribute('aria-label', 'More actions');
    moreBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg>`;
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showMsgContextMenu(e, msg.id);
    });

    // 4 quick-react emoji buttons
    ['👍', '❤️', '😂', '😮'].forEach(emoji => {
      const qBtn = document.createElement('button');
      qBtn.className = 'msg-action-btn msg-quick-emoji';
      qBtn.title = emoji;
      qBtn.textContent = emoji;
      qBtn.addEventListener('click', e => { e.stopPropagation(); toggleReaction(msg.id, emoji); });
      actionBar.appendChild(qBtn);
    });

    actionBar.appendChild(emojiBtn);
    actionBar.appendChild(replyBtn);
    actionBar.appendChild(editBtn);
    actionBar.appendChild(moreBtn);

    if (!isSent) {
      const avatarEl = document.createElement('div');
      avatarEl.className = `message-sender-avatar${isFirstInGroup ? '' : ' hidden'}`;
      avatarEl.style.background = sender ? sender.color : '#888';
      avatarEl.textContent = sender ? sender.initials : '?';
      row.appendChild(avatarEl);
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    // Timestamp + name only on first message of a group
    if (isFirstInGroup) {
      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      if (!isSent && sender) {
        timeEl.innerHTML = `<span class="message-sender-name">${sender.name}</span>${formatFullTime(msg.timestamp)}`;
      } else {
        timeEl.textContent = formatFullTime(msg.timestamp);
      }
      contentEl.appendChild(timeEl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (msg.replyToId) {
      const quotedMsg = state.messages.find(m => m.id === msg.replyToId);
      if (quotedMsg) {
        const quoteSender = getUserById(quotedMsg.senderId);
        const previewText = (quotedMsg.bodyText || quotedMsg.body.replace(/<[^>]+>/g, '')).slice(0, 120);
        const quoteEl = document.createElement('div');
        quoteEl.className = 'reply-quote';
        quoteEl.innerHTML = `
          <div class="reply-quote-header">
            <span class="reply-quote-author">${quoteSender ? quoteSender.name : 'Unknown'}</span>
            <span class="reply-quote-time">${formatTime(quotedMsg.timestamp)}</span>
          </div>
          <span class="reply-quote-body">${previewText}</span>`;
        quoteEl.addEventListener('click', () => scrollToMessage(quotedMsg.id));
        bubble.appendChild(quoteEl);
      }
    }

    // body may be stored HTML (new messages) or plain text (seed data) — detect by presence of tags
    const bodyEl = document.createElement('div');
    if (/<[a-z]/i.test(msg.body)) {
      bodyEl.innerHTML = msg.body;
    } else {
      bodyEl.innerHTML = renderMarkdown(msg.body);
    }
    bubble.appendChild(bodyEl);
    contentEl.appendChild(bubble);
    contentEl.appendChild(actionBar);

    row.appendChild(contentEl);
    listEl.appendChild(row);

    // Render existing reactions
    renderMessageReactions(msg.id);
  });

  // Typing indicator slot
  const typingEl = document.createElement('div');
  typingEl.id = 'typing-indicator';
  typingEl.className = 'typing-indicator';
  typingEl.style.display = 'none';
  listEl.appendChild(typingEl);

  listEl.scrollTop = listEl.scrollHeight;
}

function scrollToMessage(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-flash');
    setTimeout(() => el.classList.remove('highlight-flash'), 1500);
  }
}

// ─── Typing Indicator ────────────────────────────────────────────────────────
let typingTimer = null;

function showTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (!el || !state.activeConversationId) return;
  const conv = getConversationById(state.activeConversationId);
  if (!conv) return;

  // Pick a random other participant
  const others = conv.participantIds.filter(id => id !== state.currentUserId);
  if (others.length === 0) return;
  const randomId = others[Math.floor(Math.random() * others.length)];
  const person = getUserById(randomId);
  if (!person) return;

  el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span> <span class="typing-name">${person.name} is typing…</span>`;
  el.style.display = 'flex';
  const list = document.getElementById('message-list');
  if (list) list.scrollTop = list.scrollHeight;

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ─── Open Conversation ────────────────────────────────────────────────────────
function openConversation(convId) {
  const conv = getConversationById(convId);
  if (!conv) return;

  state.activeConversationId = convId;
  cancelReply();

  const hadUnread = conv.unreadCount;

  // Show chat pane
  document.getElementById('chat-welcome').style.display = 'none';
  document.getElementById('chat-active').style.display = 'flex';

  renderChatHeader(conv);
  // Render BEFORE clearing unread so the "New" divider appears
  renderMessages(convId);

  // Now clear unread state
  conv.unreadCount = 0;
  state.messages.forEach(m => {
    if (m.conversationId === convId && !m.isRead && m.senderId !== state.currentUserId) {
      m.isRead = true;
    }
  });
  renderConvList();

  focusInput();

  logEvent({ type: 'conversation_opened', conversationId: convId, hadUnread });
  saveState();
}

// ─── Send Message ─────────────────────────────────────────────────────────────
function sendMessage() {
  const text = getInputText();
  const html = getInputHTML();
  if (!text || !state.activeConversationId) return;

  const inputEl = document.getElementById('message-input');
  const editingMsgId = inputEl.dataset.editingMsgId;

  if (editingMsgId) {
    const msg = state.messages.find(m => m.id === editingMsgId);
    if (msg) {
      msg.body = html;
      msg.bodyText = text;
    }
    delete inputEl.dataset.editingMsgId;
    clearInput();
    document.getElementById('send-btn').disabled = true;
    document.getElementById('input-hint').style.display = 'none';
    renderMessages(state.activeConversationId);
    renderConvList();
    saveState();
    return;
  }

  const msg = {
    id: `msg-${Date.now()}`,
    conversationId: state.activeConversationId,
    senderId: state.currentUserId,
    body: html,
    bodyText: text,
    timestamp: new Date().toISOString(),
    isRead: true,
    replyToId: state.replyingToMsgId || null
  };

  state.messages.push(msg);
  clearInput();
  document.getElementById('send-btn').disabled = true;
  document.getElementById('input-hint').style.display = 'none';
  cancelReply();

  renderMessages(state.activeConversationId);
  renderConvList();

  // Simulate someone typing back after a short delay (only in active conversation)
  const conv = getConversationById(state.activeConversationId);
  if (conv && conv.participantIds.length > 1) {
    const delay = 800 + Math.random() * 1200;
    setTimeout(showTypingIndicator, delay);
  }

  logEvent({ type: 'message_sent', conversationId: state.activeConversationId, messageId: msg.id, body: text, replyToId: msg.replyToId });
  saveState();
}

// ─── Toggle Favorite ──────────────────────────────────────────────────────────
function toggleFavorite() {
  if (!state.activeConversationId) return;
  toggleFavoriteById(state.activeConversationId);
}

function toggleFavoriteById(convId) {
  const conv = getConversationById(convId);
  if (!conv) return;

  conv.isFavorite = !conv.isFavorite;

  if (convId === state.activeConversationId) {
    const favBtn = document.getElementById('favorite-btn');
    favBtn.classList.toggle('is-favorite', conv.isFavorite);
    favBtn.title = conv.isFavorite ? 'Remove from favorites' : 'Add to favorites';
  }

  renderConvList();
  showToast(conv.isFavorite ? 'Added to Favorites' : 'Removed from Favorites');

  logEvent({ type: 'conversation_favorited', conversationId: conv.id, isFavorite: conv.isFavorite });
  saveState();
}

// ─── Toast Notification ───────────────────────────────────────────────────────
function showToast(message, duration = 2500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Search ───────────────────────────────────────────────────────────────────
let searchDebounceTimer = null;

function handleSearchInput(e) {
  const query = e.target.value;
  state.searchQuery = query;

  const clearBtn = document.getElementById('search-clear-btn');
  clearBtn.style.display = query ? 'flex' : 'none';

  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (query.trim()) {
      logEvent({ type: 'search_performed', query: query.trim() });
    }
    renderConvList();
  }, 300);
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  state.searchQuery = '';
  document.getElementById('search-clear-btn').style.display = 'none';
  logEvent({ type: 'search_cleared' });
  renderConvList();
  input.focus();
}

// ─── Section Toggle ───────────────────────────────────────────────────────────
function setupSectionToggles() {
  document.querySelectorAll('.conv-section-header').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.conv-section');
      section.classList.toggle('collapsed');
    });
  });
}

// ─── Markdown Renderer ───────────────────────────────────────────────────────
function renderMarkdown(text) {
  // Escape HTML first to prevent XSS
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Block: quote lines (> text)
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Inline code (must come before bold/italic to avoid mangling backtick content)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold+italic ***text***
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  // Italic _text_ or *text*
  s = s.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+?)_/g, '<em>$1</em>');
  // Strikethrough ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Unordered list lines
  s = s.replace(/^- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Ordered list lines
  s = s.replace(/^\d+\.\s(.+)$/gm, '<li>$1</li>');

  // Newlines → <br>
  s = s.replace(/\n/g, '<br>');

  return s;
}


const INPUT_EMOJIS = [
  '😊','😂','😍','🥰','😎','🤔','😅','😭','🤣','😇',
  '😜','😏','😤','🙄','😬','🥳','🤩','😴','🤗','😮',
  '👍','👎','👏','🙌','👋','🤝','🙏','💪','✌️','🤞',
  '❤️','🧡','💛','💚','💙','💜','🖤','💔','💯','✨',
  '🔥','⭐','🎉','🎊','🎈','🏆','🚀','💡','📌','🔔',
  '😱','😳','🤯','😡','🤬','😈','👻','💀','🤡','🐱',
  '🐶','🦊','🐻','🐼','🦁','🐸','🐷','🐵','🌸','🌈',
  '🍕','🍔','🍦','☕','🍺','🎂','🍎','🥑','🌮','🍣',
];

function setupMessageInput() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const inputHint = document.getElementById('input-hint');

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.innerText.trim();
    inputHint.style.display = input.innerText ? 'flex' : 'none';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
    if (e.key === 'Escape') cancelReply();
  });

  input.addEventListener('focus', () => {
    if (input.innerText.trim()) inputHint.style.display = 'flex';
  });
  input.addEventListener('blur', () => {
    inputHint.style.display = 'none';
  });

  sendBtn.addEventListener('click', sendMessage);
  document.getElementById('reply-cancel-btn').addEventListener('click', cancelReply);

  // Toolbar toggles
  document.getElementById('toolbar-emoji').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEmojiInputPanel();
  });
  document.getElementById('toolbar-format').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFormatPanel();
  });

  // Format buttons — use execCommand so formatting shows live in the editor
  const fmtCmds = {
    'fmt-bold':      () => document.execCommand('bold'),
    'fmt-italic':    () => document.execCommand('italic'),
    'fmt-underline': () => document.execCommand('underline'),
    'fmt-strike':    () => document.execCommand('strikeThrough'),
  };
  Object.entries(fmtCmds).forEach(([id, fn]) => {
    document.getElementById(id).addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in editor
      fn();
      input.dispatchEvent(new Event('input'));
    });
  });

  // Build emoji panel once
  const emojiPanel = document.getElementById('emoji-panel');
  INPUT_EMOJIS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'ep-btn';
    btn.textContent = em;
    btn.setAttribute('aria-label', 'Insert ' + em);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      input.focus();
      document.execCommand('insertText', false, em);
      closeInputPanels();
    });
    emojiPanel.appendChild(btn);
  });

  // Close panels on outside click — use mousedown so text-selection drags don't trigger it
  document.addEventListener('mousedown', (e) => {
    const area = document.querySelector('.message-input-area');
    const ep = document.getElementById('emoji-panel');
    if (area && !area.contains(e.target) && ep && !ep.contains(e.target)) {
      closeInputPanels();
    }
  });
}

function toggleEmojiInputPanel() {
  const ep = document.getElementById('emoji-panel');
  const emojiBtn = document.getElementById('toolbar-emoji');
  const isOpen = ep.style.display !== 'none';
  closeInputPanels();
  if (!isOpen) {
    ep.style.display = 'grid';
    emojiBtn.classList.add('active');
  }
}

function toggleFormatPanel() {
  const fb = document.getElementById('format-bar');
  const fmtBtn = document.getElementById('toolbar-format');
  const isOpen = fb.style.display !== 'none';
  closeInputPanels();
  if (!isOpen) {
    fb.style.display = 'flex';
    fmtBtn.classList.add('active');
  }
}

function closeInputPanels() {
  const ep = document.getElementById('emoji-panel');
  const fb = document.getElementById('format-bar');
  if (ep) ep.style.display = 'none';
  if (fb) fb.style.display = 'none';
  document.getElementById('toolbar-emoji').classList.remove('active');
  document.getElementById('toolbar-format').classList.remove('active');
}

// ─── Input helpers (contenteditable) ─────────────────────────────────────────
function getInputText() {
  const el = document.getElementById('message-input');
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.input-quote-block').forEach(n => n.remove());
  return clone.innerText.replace(/\u200B/g, '').trim();
}

function getInputHTML() {
  const el = document.getElementById('message-input');
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.input-quote-block').forEach(n => n.remove());
  // Strip zero-width spaces from text nodes
  clone.innerHTML = clone.innerHTML.replace(/\u200B/g, '');
  return clone.innerHTML;
}

function clearInput() {
  const el = document.getElementById('message-input');
  if (el) el.innerHTML = '';
}

function focusInput() {
  const el = document.getElementById('message-input');
  if (!el) return;
  el.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─── My Avatar ────────────────────────────────────────────────────────────────
function setupMyAvatar() {
  const me = getUserById(state.currentUserId);
  if (me) {
    const el = document.getElementById('my-avatar');
    el.textContent = me.initials;
    el.title = me.name;
    el.style.background = me.color;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();

    state.users = data.users;
    state.conversations = data.conversations;
    // Shift all message timestamps so the latest message aligns to current time
    const offset = data.timestampOffsetMs || 0;
    state.messages = data.messages.map(m => ({
      ...m,
      timestamp: new Date(new Date(m.timestamp).getTime() + offset).toISOString()
    }));
    state.currentUserId = data.currentUserId;
    state.reactions = data.reactions || {};

    // Derive unreadCount from messages: count isRead=false messages that come
    // after the last message sent by the current user in each conversation.
    state.conversations.forEach(conv => {
      const msgs = state.messages.filter(m => m.conversationId === conv.id);
      const lastMyMsgIdx = msgs.map(m => m.senderId).lastIndexOf(state.currentUserId);
      // Messages after our last reply are candidates; if we never replied, all messages count
      const candidates = lastMyMsgIdx === -1 ? msgs : msgs.slice(lastMyMsgIdx + 1);
      conv.unreadCount = candidates.filter(m => !m.isRead && m.senderId !== state.currentUserId).length;
    });

    setupMyAvatar();
    setupSectionToggles();
    setupMessageInput();

    document.getElementById('search-input').addEventListener('input', handleSearchInput);
    document.getElementById('search-clear-btn').addEventListener('click', clearSearch);
    document.getElementById('favorite-btn').addEventListener('click', toggleFavorite);
    document.getElementById('mute-btn').addEventListener('click', () => {
      if (state.activeConversationId) toggleMute(state.activeConversationId);
    });

    // Nav buttons (visual switching)
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    renderConvList();
  } catch (err) {
    console.error('Failed to initialize app:', err);
  }
}

init();
