#!/usr/bin/env node
'use strict';

const VERSION = '1.0.0';

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, 'localStorage_snapshot.json');
const EVENT_LOG_PATH = path.join(__dirname, 'event_log.ndjson');
const DB_INITIAL_PATH = path.join(__dirname, 'db_initial.json');

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : null;
}

// ─── Load Data ────────────────────────────────────────────────────────────────
function loadSnapshot(snapshotPath) {
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8').trim();
    if (!raw || raw === '{}') return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadEvents(eventLogPath) {
  try {
    const raw = fs.readFileSync(eventLogPath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_INITIAL_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ─── Query Helpers ───────────────────────────────────────────────────────────
function getUserByName(db, name) {
  return db.users.find(u => u.name.toLowerCase().includes(name.toLowerCase()));
}

function getConvByParticipant(db, userId) {
  return db.conversations.find(c =>
    c.type === 'direct' && c.participantIds.includes('user-me') && c.participantIds.includes(userId)
  );
}

function getConvByName(db, name) {
  return db.conversations.find(c =>
    c.name && c.name.toLowerCase().includes(name.toLowerCase())
  );
}

function getConvDisplayName(db, conv) {
  if (conv.name) return conv.name;
  if (conv.type === 'direct') {
    const otherUserId = conv.participantIds.find(id => id !== 'user-me');
    const otherUser = db.users.find(u => u.id === otherUserId);
    return otherUser ? otherUser.name : conv.id;
  }
  return conv.id;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getConvNameAliases(db, conv) {
  const displayName = getConvDisplayName(db, conv);
  const aliases = new Set([displayName.toLowerCase()]);

  if (conv.type === 'direct') {
    aliases.add(displayName.toLowerCase().split(/\s+/)[0]);
  } else {
    const tokens = displayName.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) aliases.add(tokens[0]);
  }

  return [...aliases].filter(Boolean);
}

function messageMentionsConvWithCount(db, body, conv, unreadCount) {
  const normalizedBody = (body || '').toLowerCase().replace(/\s+/g, ' ');
  return getConvNameAliases(db, conv).some(alias => {
    const namePattern = escapeRegExp(alias);
    const countPattern = escapeRegExp(String(unreadCount));
    const nearName = new RegExp(`${namePattern}.{0,40}\\b${countPattern}\\b`);
    const nearCount = new RegExp(`\\b${countPattern}\\b.{0,40}${namePattern}`);
    return nearName.test(normalizedBody) || nearCount.test(normalizedBody);
  });
}

function getConvFromSnapshot(snapshot, convId) {
  if (!snapshot || !snapshot.conversations) return null;
  return snapshot.conversations.find(c => c.id === convId);
}

function getMessagesByConv(snapshot, convId) {
  if (!snapshot || !snapshot.messages) return [];
  return snapshot.messages.filter(m => m.conversationId === convId);
}

function findEventsOfType(events, type) {
  return events.filter(e => e.type === type);
}

function findEventsForConv(events, convId) {
  return events.filter(e => e.conversationId === convId);
}

function findMessageByBodyContains(messages, body) {
  return messages.find(m => m.body && m.body.toLowerCase().includes(body.toLowerCase()));
}

function findExactMessage(messages, body, senderId) {
  return messages.find(m => m.body === body && (!senderId || m.senderId === senderId));
}

// Compute initial unread count the same way the app does at startup:
// Count isRead=false messages from others that come after the last user-me message.
function getInitialUnreadCount(db, convId) {
  const msgs = db.messages
    .filter(m => m.conversationId === convId)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let lastMyIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].senderId === 'user-me') lastMyIdx = i;
  }
  const candidates = lastMyIdx === -1 ? msgs : msgs.slice(lastMyIdx + 1);
  return candidates.filter(m => !m.isRead && m.senderId !== 'user-me').length;
}

function getUnreadConvs(db, typeFilter) {
  return db.conversations.filter(c => {
    if (typeFilter === 'direct' && c.type !== 'direct') return false;
    if (typeFilter === 'group' && c.type === 'direct') return false;
    return getInitialUnreadCount(db, c.id) > 0;
  });
}

/**
 * Get messages newly sent by user-me in a conversation, identified via event log.
 * Returns snapshot message objects for messages that have a corresponding message_sent event.
 */
function getNewUserMessages(snapshot, events, convId) {
  const sentEvents = events.filter(e =>
    e.type === 'message_sent' && e.conversationId === convId
  );
  const sentMsgIds = new Set(sentEvents.map(e => e.messageId));
  // Also collect body text from events in case snapshot message was overwritten
  const eventBodies = new Map(sentEvents.map(e => [e.messageId, e.body]));

  const snapshotMsgs = getMessagesByConv(snapshot, convId)
    .filter(m => sentMsgIds.has(m.id));

  // For messages in event log but not in snapshot, create stubs from event data
  for (const evt of sentEvents) {
    if (!snapshotMsgs.find(m => m.id === evt.messageId)) {
      snapshotMsgs.push({
        id: evt.messageId,
        conversationId: convId,
        senderId: 'user-me',
        body: evt.body || '',
      });
    }
  }

  return snapshotMsgs;
}

/**
 * Check if user-me sent an exact message in a conversation (via event log).
 */
function findNewExactMessage(snapshot, events, convId, body) {
  const newMsgs = getNewUserMessages(snapshot, events, convId);
  return newMsgs.find(m => m.body === body) || null;
}

/**
 * Check if user-me sent a message containing text in a conversation (via event log).
 */
function findNewMessageContaining(snapshot, events, convId, text) {
  const newMsgs = getNewUserMessages(snapshot, events, convId);
  const lower = text.toLowerCase();
  return newMsgs.find(m => m.body && m.body.toLowerCase().includes(lower)) || null;
}

// ─── Evaluators ──────────────────────────────────────────────────────────────
const evaluators = {

  'EVAL-02': {
    tier: 2,
    desc: 'Send standup-change message to every away/dnd teammate, not to available/busy ones',
    verify(snapshot, events, db) {
      const msg = 'Heads up — standup is moving to 10am tomorrow, check the Engineering Leads chat';
      const offlineStatuses = ['away', 'dnd'];
      const offlineUsers = db.users.filter(u => u.id !== 'user-me' && offlineStatuses.includes(u.status));
      const onlineUsers = db.users.filter(u => u.id !== 'user-me' && !offlineStatuses.includes(u.status));
      const checks = [];

      for (const user of offlineUsers) {
        const conv = getConvByParticipant(db, user.id);
        checks.push(createCheck(
          `Message sent to ${user.name} (${user.status})`,
          conv && findNewExactMessage(snapshot, events, conv.id, msg),
          `Message not found in ${user.name}'s conversation`
        ));
      }

      for (const user of onlineUsers) {
        const conv = getConvByParticipant(db, user.id);
        checks.push(createCheck(
          `Message NOT sent to ${user.name} (${user.status})`,
          !conv || !findNewExactMessage(snapshot, events, conv.id, msg),
          `Message was wrongly sent to ${user.name} (status: ${user.status})`
        ));
      }

      return finalizeChecks(checks, 'Standup message sent to all offline users only.');
    }
  },

  'EVAL-05': {
    tier: 2,
    desc: 'Favorite every conversation (DMs + groups) that has unread messages',
    verify(snapshot, events, db) {
      const unreadConvs = getUnreadConvs(db, null);
      if (unreadConvs.length === 0) return fail('No conversations with unread messages found');
      const checks = [];

      for (const conv of unreadConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = getConvDisplayName(db, conv);
        checks.push(createCheck(
          `"${name}" is favorited`,
          snapConv && snapConv.isFavorite,
          `"${name}" (${conv.id}) is not favorited in snapshot`
        ));
      }

      return finalizeChecks(checks, 'All unread conversations favorited.');
    }
  },

  'EVAL-07': {
    tier: 2,
    desc: 'Read Sam Lee\'s messages and reply "Got it, will review."',
    verify(snapshot, events, db) {
      const user = getUserByName(db, 'Sam Lee');
      if (!user) return fail('Sam Lee not found in db');
      const conv = getConvByParticipant(db, user.id);
      if (!conv) return fail('No direct conversation with Sam Lee');
      const snapConv = getConvFromSnapshot(snapshot, conv.id);
      const msgs = getMessagesByConv(snapshot, conv.id);

      const checks = [
        createCheck('Sam Lee conversation is read (unreadCount = 0)',
          snapConv && snapConv.unreadCount === 0,
          `unreadCount is ${snapConv ? snapConv.unreadCount : 'N/A'}, expected 0`),
        createCheck('Reply "Got it, will review." exists from user-me',
          findNewExactMessage(snapshot, events, conv.id, 'Got it, will review.'),
          'Reply "Got it, will review." not found in Sam Lee\'s conversation'),
      ];

      return finalizeChecks(checks, 'Sam Lee conversation read and replied.');
    }
  },

  'EVAL-08': {
    tier: 2,
    desc: 'Send CI/CD migration message to Morgan Chen and Quinn Martinez (from Jordan\'s DM), not to others',
    verify(snapshot, events, db) {
      const msg = 'Jordan is pulling you in for the CI/CD migration project — check the charter in Confluence.';
      const morgan = getUserByName(db, 'Morgan Chen');
      const quinn = getUserByName(db, 'Quinn Martinez');
      if (!morgan || !quinn) return fail('Morgan Chen or Quinn Martinez not found');
      const morganConv = getConvByParticipant(db, morgan.id);
      const quinnConv = getConvByParticipant(db, quinn.id);
      if (!morganConv || !quinnConv) return fail('Missing DM conversations with targets');

      const checks = [
        createCheck('Message sent to Morgan Chen',
          findNewExactMessage(snapshot, events, morganConv.id, msg),
          'Message not found in Morgan Chen\'s conversation'),
        createCheck('Message sent to Quinn Martinez',
          findNewExactMessage(snapshot, events, quinnConv.id, msg),
          'Message not found in Quinn Martinez\'s conversation'),
      ];

      const targetConvIds = new Set([morganConv.id, quinnConv.id]);
      const otherConvs = db.conversations.filter(c => c.type === 'direct' && !targetConvIds.has(c.id));
      for (const conv of otherConvs) {
        const stray = findNewExactMessage(snapshot, events, conv.id, msg);
        if (stray) {
          checks.push(createCheck(
            `Message NOT sent to ${getConvDisplayName(db, conv)}`,
            false, `Message was wrongly sent to ${conv.id}`));
        }
      }

      return finalizeChecks(checks, 'CI/CD migration message sent to correct targets only.');
    }
  },

  'EVAL-10': {
    tier: 2,
    desc: 'Send "No rush" message to every busy/dnd teammate, not to available/away ones',
    verify(snapshot, events, db) {
      const msg = 'No rush — just flagging that I have something for you when you\'re free.';
      const busyStatuses = ['busy', 'dnd'];
      const busyUsers = db.users.filter(u => u.id !== 'user-me' && busyStatuses.includes(u.status));
      const nonBusyUsers = db.users.filter(u => u.id !== 'user-me' && !busyStatuses.includes(u.status));
      const checks = [];

      for (const user of busyUsers) {
        const conv = getConvByParticipant(db, user.id);
        checks.push(createCheck(
          `Message sent to ${user.name} (${user.status})`,
          conv && findNewExactMessage(snapshot, events, conv.id, msg),
          `Message not found in ${user.name}'s conversation`
        ));
      }

      for (const user of nonBusyUsers) {
        const conv = getConvByParticipant(db, user.id);
        checks.push(createCheck(
          `Message NOT sent to ${user.name} (${user.status})`,
          !conv || !findNewExactMessage(snapshot, events, conv.id, msg),
          `Message was wrongly sent to ${user.name} (status: ${user.status})`
        ));
      }

      return finalizeChecks(checks, 'Message sent to all busy/dnd users only.');
    }
  },

  'EVAL-12': {
    tier: 2,
    desc: 'Send "Quick update from Alex" to every favorited conversation',
    verify(snapshot, events, db) {
      const favConvs = db.conversations.filter(c => c.isFavorite);
      if (favConvs.length === 0) return fail('No favorited conversations found in db');
      const checks = [];

      for (const conv of favConvs) {
        const name = getConvDisplayName(db, conv);
        checks.push(createCheck(
          `Message in "${name}"`,
          findNewExactMessage(snapshot, events, conv.id, 'Quick update from Alex'),
          `Message not found in favorited conversation "${name}"`
        ));
      }

      return finalizeChecks(checks, 'Broadcast sent to all favorited conversations.');
    }
  },

  'EVAL-14': {
    tier: 2,
    desc: 'Search for "Product Sprint Planning" and post "Ready for tomorrow\'s session." in it',
    verify(snapshot, events, db) {
      const searchEvents = findEventsOfType(events, 'search_performed');
      const conv = getConvByName(db, 'Product Sprint Planning');
      if (!conv) return fail('Product Sprint Planning conversation not found in db');

      const checks = [
        createCheck('Search performed for "sprint"',
          searchEvents.find(e => e.query && e.query.toLowerCase().includes('sprint')),
          'No search_performed event with query containing "sprint"'),
        createCheck('Message posted in Product Sprint Planning',
          findNewExactMessage(snapshot, events, conv.id, 'Ready for tomorrow\'s session.'),
          'Message "Ready for tomorrow\'s session." not found in Product Sprint Planning'),
      ];

      return finalizeChecks(checks, 'Searched and posted in Product Sprint Planning.');
    }
  },

  'EVAL-15': {
    tier: 2,
    desc: 'Reply "Saw your message, will follow up." to every unread DM',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No DM conversations with unread messages found');
      const checks = [];

      for (const conv of unreadDMs) {
        const name = getConvDisplayName(db, conv);
        const hasReply = findNewMessageContaining(snapshot, events, conv.id, 'saw your message, will follow up.');
        checks.push(createCheck(
          `Reply in ${name}'s DM`,
          hasReply,
          `Reply "Saw your message, will follow up." not found in ${name}'s conversation`
        ));
      }

      return finalizeChecks(checks, 'Replied to all unread DMs.');
    }
  },

  'EVAL-17': {
    tier: 2,
    desc: 'Clear all unread group chat badges (open every unread group/channel); do not open DMs',
    verify(snapshot, events, db) {
      const unreadGroups = getUnreadConvs(db, 'group');
      if (unreadGroups.length === 0) return fail('No group/channel conversations with unread messages found');
      const checks = [];

      for (const conv of unreadGroups) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = conv.name || conv.id;
        checks.push(createCheck(
          `"${name}" unreadCount cleared to 0`,
          snapConv && snapConv.unreadCount === 0,
          `"${name}" still has unreadCount ${snapConv ? snapConv.unreadCount : 'N/A'}`
        ));
      }

      // No DMs should have been opened
      const openedConvIds = findEventsOfType(events, 'conversation_opened').map(e => e.conversationId);
      const openedDMs = db.conversations.filter(c => c.type === 'direct' && openedConvIds.includes(c.id));
      checks.push(createCheck(
        'No DM conversations were opened',
        openedDMs.length === 0,
        `DM conversation(s) were opened: ${openedDMs.map(c => c.id).join(', ')}`
      ));

      return finalizeChecks(checks, 'All unread group badges cleared, no DMs touched.');
    }
  },

  'EVAL-23': {
    tier: 2,
    desc: 'Mute all non-favorited group chats; leave favorited ones unmuted; don\'t mute DMs',
    verify(snapshot, events, db) {
      const groupConvs = db.conversations.filter(c => c.type !== 'direct');
      const dmConvs = db.conversations.filter(c => c.type === 'direct');
      const checks = [];

      for (const conv of groupConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = conv.name || conv.id;
        if (conv.isFavorite) {
          checks.push(createCheck(
            `Favorited group "${name}" NOT muted`,
            snapConv && snapConv.isMuted !== true,
            `Favorited group "${name}" was muted`
          ));
        } else {
          checks.push(createCheck(
            `Non-favorited group "${name}" is muted`,
            snapConv && snapConv.isMuted === true,
            `Non-favorited group "${name}" is not muted`
          ));
        }
      }

      for (const conv of dmConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        if (snapConv && snapConv.isMuted === true) {
          checks.push(createCheck(`DM ${conv.id} NOT muted`, false, `DM ${conv.id} was muted`));
        }
      }

      return finalizeChecks(checks, 'Non-favorited groups muted, favorited groups and DMs untouched.');
    }
  },

  'EVAL-24': {
    tier: 2,
    desc: 'Favorite DMs with people Jordan mentioned in CI/CD thread (Morgan, Quinn, Avery); no extra favorites',
    verify(snapshot, events, db) {
      const targetNames = ['Morgan Chen', 'Quinn Martinez', 'Avery Thompson'];
      const alreadyFav = new Set(db.conversations.filter(c => c.isFavorite).map(c => c.id));
      const targetConvIds = new Set();
      const checks = [];

      for (const name of targetNames) {
        const user = getUserByName(db, name);
        if (!user) return fail(`${name} not found in db`);
        const conv = getConvByParticipant(db, user.id);
        if (!conv) return fail(`No direct conversation with ${name}`);
        targetConvIds.add(conv.id);

        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        checks.push(createCheck(
          `${name}'s DM is favorited`,
          snapConv && snapConv.isFavorite,
          `${name}'s conversation is not favorited`
        ));
      }

      // Check no unexpected favorites
      for (const conv of db.conversations) {
        if (alreadyFav.has(conv.id) || targetConvIds.has(conv.id)) continue;
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        if (snapConv && snapConv.isFavorite) {
          const name = getConvDisplayName(db, conv);
          checks.push(createCheck(`"${name}" NOT newly favorited`, false, `"${name}" was unexpectedly favorited`));
        }
      }

      return finalizeChecks(checks, 'Correct conversations favorited from Jordan\'s CI/CD thread.');
    }
  },

  'EVAL-26': {
    tier: 2,
    desc: 'Mute every group chat/channel with unread messages; don\'t mute DMs',
    verify(snapshot, events, db) {
      const unreadGroups = getUnreadConvs(db, 'group');
      if (unreadGroups.length === 0) return fail('No group/channel conversations with unread messages found');
      const dmConvs = db.conversations.filter(c => c.type === 'direct');
      const checks = [];

      for (const conv of unreadGroups) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = conv.name || conv.id;
        checks.push(createCheck(
          `Unread group "${name}" is muted`,
          snapConv && snapConv.isMuted === true,
          `"${name}" is not muted`
        ));
      }

      for (const conv of dmConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        if (snapConv && snapConv.isMuted === true) {
          checks.push(createCheck(`DM ${conv.id} NOT muted`, false, `DM ${conv.id} was muted`));
        }
      }

      return finalizeChecks(checks, 'All unread group chats muted, no DMs affected.');
    }
  },

  // ─── Tier 3 ──────────────────────────────────────────────────────────────

  'EVAL-06': {
    tier: 3,
    desc: 'Send status-conditional replies to unread DMs: online→"Looking into this now", offline→"Noted — will review"',
    verify(snapshot, events, db) {
      const onlineMsg = 'Looking into this now \u2014 will follow up shortly.';
      const offlineMsg = 'Noted \u2014 will review and get back to you when you\u2019re back.';
      const onlineStatuses = ['available', 'busy'];
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');
      const checks = [];

      for (const conv of unreadDMs) {
        const otherUserId = conv.participantIds.find(id => id !== 'user-me');
        const user = db.users.find(u => u.id === otherUserId);
        if (!user) return fail(`User not found for ${conv.id}`);
        const isOnline = onlineStatuses.includes(user.status);
        const expectedMsg = isOnline ? onlineMsg : offlineMsg;
        const wrongMsg = isOnline ? offlineMsg : onlineMsg;

        checks.push(createCheck(
          `Correct message in ${user.name}'s DM (${user.status})`,
          findNewExactMessage(snapshot, events, conv.id, expectedMsg),
          `Expected "${expectedMsg}" in ${user.name}'s conversation, not found`
        ));
        checks.push(createCheck(
          `Wrong message NOT in ${user.name}'s DM`,
          !findNewExactMessage(snapshot, events, conv.id, wrongMsg),
          `Wrong message found in ${user.name}'s conversation`
        ));
      }

      return finalizeChecks(checks, 'Status-conditional replies sent correctly.');
    }
  },

  'EVAL-11': {
    tier: 3,
    desc: 'Extract vendor cost estimates from Sam\'s DM and forward summary to Taylor Brooks (≥3 vendor terms)',
    verify(snapshot, events, db) {
      const taylor = getUserByName(db, 'Taylor Brooks');
      if (!taylor) return fail('Taylor Brooks not found in db');
      const conv = getConvByParticipant(db, taylor.id);
      if (!conv) return fail('No direct conversation with Taylor Brooks');
      const userMsgs = getNewUserMessages(snapshot, events, conv.id);
      const vendorTerms = ['datadog', 'new relic', 'grafana', '180', '95', '40', '90', 'hybrid'];

      const checks = [
        createCheck('Message from user-me exists in Taylor\'s DM',
          userMsgs.length > 0,
          'No message from user-me in Taylor Brooks\'s conversation'),
      ];

      if (userMsgs.length > 0) {
        let bestHits = 0;
        for (const msg of userMsgs) {
          const bodyLower = (msg.body || '').toLowerCase();
          const hits = vendorTerms.filter(term => bodyLower.includes(term)).length;
          if (hits > bestHits) bestHits = hits;
        }
        checks.push(createCheck(
          `Summary references ≥3 vendor terms (found ${bestHits})`,
          bestHits >= 3,
          `Only ${bestHits} vendor terms found (need ≥3): ${vendorTerms.join(', ')}`
        ));
      }

      return finalizeChecks(checks, 'Vendor cost summary forwarded to Taylor.');
    }
  },

  'EVAL-18': {
    tier: 3,
    desc: 'Read all unread groups, send Jordan Kim a summary mentioning ≥2 key terms across the groups',
    verify(snapshot, events, db) {
      const unreadGroups = getUnreadConvs(db, 'group');
      if (unreadGroups.length === 0) return fail('No unread group conversations found');
      const checks = [];

      for (const conv of unreadGroups) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = conv.name || conv.id;
        checks.push(createCheck(
          `"${name}" badge cleared`,
          snapConv && snapConv.unreadCount === 0,
          `"${name}" still has unread messages`
        ));
      }

      const jordanUser = getUserByName(db, 'Jordan Kim');
      if (!jordanUser) return fail('Jordan Kim not found in db');
      const jordanConvs = db.conversations.filter(c =>
        c.type === 'direct' && c.participantIds.includes('user-me') && c.participantIds.includes(jordanUser.id)
      );
      if (jordanConvs.length === 0) return fail('No direct conversation with Jordan Kim');

      const summaryKeywords = [
        'service mesh', 'linkerd', 'istio',
        'incident', 'payment', 'postmortem', 'canary', 'runbook', 'argo',
        'ramen', 'lunch', 'random', 'meetup'
      ];

      let bestHits = 0;
      for (const conv of jordanConvs) {
        const userMsgs = getNewUserMessages(snapshot, events, conv.id);
        for (const msg of userMsgs) {
          const bodyLower = (msg.body || '').toLowerCase();
          const hits = summaryKeywords.filter(kw => bodyLower.includes(kw)).length;
          if (hits > bestHits) bestHits = hits;
        }
      }
      checks.push(createCheck(
        `Summary in Jordan's DM references ≥2 key terms (found ${bestHits})`,
        bestHits >= 2,
        `Only ${bestHits} key terms found (need ≥2): ${summaryKeywords.join(', ')}`
      ));

      return finalizeChecks(checks, 'Unread groups summarized to Jordan Kim.');
    }
  },

  'EVAL-19': {
    tier: 3,
    desc: 'Reply only to the DM with the highest unread count; leave others untouched',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');

      let maxCount = -1;
      for (const conv of unreadDMs) {
        const count = getInitialUnreadCount(db, conv.id);
        if (count > maxCount) maxCount = count;
      }
      // All conversations tied at maxCount are valid targets
      const maxConvs = unreadDMs.filter(c => getInitialUnreadCount(db, c.id) === maxCount);
      const maxConvIds = new Set(maxConvs.map(c => c.id));

      // Check that the reply exists in at least one of the tied-max conversations
      let repliedTo = null;
      for (const conv of maxConvs) {
        if (findNewExactMessage(snapshot, events, conv.id, "I'll get back to you on this soon.")) {
          repliedTo = conv;
          break;
        }
      }

      const maxNames = maxConvs.map(c => getConvDisplayName(db, c)).join(' or ');
      const checks = [
        createCheck(`Reply in highest-unread DM (${maxNames}, ${maxCount} unreads)`,
          repliedTo,
          `Reply not found in any of the highest-unread DMs (${maxCount} unreads)`),
      ];

      // No reply in non-max conversations (and not in the other tied-max one if repliedTo is set)
      for (const conv of unreadDMs) {
        if (repliedTo && conv.id === repliedTo.id) continue;
        const stray = findNewExactMessage(snapshot, events, conv.id, "I'll get back to you on this soon.");
        const name = getConvDisplayName(db, conv);
        if (maxConvIds.has(conv.id) && !repliedTo) continue; // Don't penalize tied convs if none got a reply (already failing above)
        checks.push(createCheck(
          `No reply in ${name}'s DM`,
          !stray,
          `Reply was wrongly sent to ${conv.id}`
        ));
      }

      return finalizeChecks(checks, 'Replied only to the busiest unread DM.');
    }
  },

  'EVAL-20': {
    tier: 3,
    desc: 'Reply to each unread DM with a topic-relevant keyword; clear all unread group badges',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');
      const dmKeywords = {
        'conv-1':  ['jenkins', 'github actions', 'pipeline', 'migration', 'ci/cd', 'cicd'],
        'conv-3':  ['headcount', 'roi', 'platform', 'fte', 'contractor', 'hiring', 'budget'],
        'conv-5':  ['gdpr', 'compliance', 'audit', 'data retention', 'erasure', 'consent', 'dpa', 'helios'],
        'conv-8':  ['datadog', 'grafana', 'new relic', 'observability', 'monitoring', 'vendor']
      };
      const checks = [];

      for (const conv of unreadDMs) {
        const keywords = dmKeywords[conv.id];
        if (!keywords) continue;
        const name = getConvDisplayName(db, conv);
        const userMsgs = getNewUserMessages(snapshot, events, conv.id);
        const hasKeyword = userMsgs.some(msg => {
          const bodyLower = (msg.body || '').toLowerCase();
          return keywords.some(kw => bodyLower.includes(kw));
        });
        checks.push(createCheck(
          `Reply in ${name}'s DM references topic`,
          hasKeyword,
          `No keyword-matching reply in ${conv.id}. Expected: ${keywords.join(', ')}`
        ));
      }

      const unreadGroups = getUnreadConvs(db, 'group');
      for (const conv of unreadGroups) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = conv.name || conv.id;
        checks.push(createCheck(
          `"${name}" badge cleared`,
          snapConv && snapConv.unreadCount === 0,
          `"${name}" still has unreadCount ${snapConv ? snapConv.unreadCount : 'N/A'}`
        ));
      }

      return finalizeChecks(checks, 'Topic-relevant replies sent, all group badges cleared.');
    }
  },

  'EVAL-25': {
    tier: 2,
    desc: 'Add a 👍 reaction to the most recent message in each unread DM conversation',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');

      // Find the most recent message in each unread DM (from initial db)
      const targetMsgIds = new Set();
      const targetInfo = {};
      for (const conv of unreadDMs) {
        const msgs = db.messages
          .filter(m => m.conversationId === conv.id)
          .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        const last = msgs[msgs.length - 1];
        if (last) {
          targetMsgIds.add(last.id);
          targetInfo[last.id] = getConvDisplayName(db, conv);
        }
      }

      const checks = [];

      // Check each target message got a 👍 reaction
      for (const [msgId, name] of Object.entries(targetInfo)) {
        const reactionEvents = events.filter(e =>
          e.type === 'reaction_toggled' && e.messageId === msgId
        );
        const hasThumbsUp = reactionEvents.some(e => e.emoji === '👍');
        checks.push(createCheck(
          `👍 reaction on latest message in ${name}'s DM (${msgId})`,
          hasThumbsUp,
          `No 👍 reaction found on ${msgId} in ${name}'s DM`
        ));
      }

      // Check no wrong reactions on non-target messages
      const wrongReactions = events.filter(e =>
        e.type === 'reaction_toggled' && !targetMsgIds.has(e.messageId)
      );
      checks.push(createCheck(
        'No reactions on non-target messages',
        wrongReactions.length === 0,
        `${wrongReactions.length} reaction(s) added to non-target messages: ${wrongReactions.map(e => e.messageId).join(', ')}`
      ));

      return finalizeChecks(checks, '👍 reactions added to most recent message in each unread DM.');
    }
  },

  'EVAL-27': {
    tier: 2,
    desc: 'Reorganize sidebar — remove all DMs from favorites, add all group chats to favorites',
    verify(snapshot, events, db) {
      const checks = [];

      // All DMs should NOT be favorited
      const dmConvs = db.conversations.filter(c => c.type === 'direct');
      for (const conv of dmConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = getConvDisplayName(db, conv);
        checks.push(createCheck(
          `${name}'s DM is not favorited`,
          snapConv && !snapConv.isFavorite,
          `${conv.id} is still favorited`
        ));
      }

      // All group chats should be favorited
      const groupConvs = db.conversations.filter(c => c.type !== 'direct');
      for (const conv of groupConvs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        checks.push(createCheck(
          `${conv.name} is favorited`,
          snapConv && snapConv.isFavorite,
          `${conv.id} (${conv.name}) is not favorited`
        ));
      }

      return finalizeChecks(checks, 'All DMs unfavorited, all group chats favorited.');
    }
  },

  'EVAL-28': {
    tier: 3,
    desc: 'React 👍 to deadline-mentioning messages in unread DMs; no reaction on non-deadline messages',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');

      // Statically tagged deadline messages (mention specific dates, deadlines, or due dates)
      const deadlineMsgIds = new Set([
        'msg-1-17', // "Jenkins contract renewal is in March. If we don't migrate by then we're auto-renewed"
        'msg-3-4',  // "Hopefully by end of next week"
        'msg-3-16', // "VP meeting is scheduled for next Tuesday at 3pm"
        'msg-3-17', // "hiring timeline: JD posted by Week 2, interviews in Week 4-6..."
        'msg-3-21', // "I need your data inputs by EOD tomorrow and your sign-off by Friday"
        'msg-5-13', // "Gaps 1, 2, and 5 are the most urgent"
        'msg-8-17', // "I need a decision by end of this week. Procurement needs 3 weeks lead time"
      ]);

      const reactions = snapshot.reactions || {};
      const checks = [];

      // All unread DMs must be read
      for (const conv of unreadDMs) {
        const snapConv = getConvFromSnapshot(snapshot, conv.id);
        const name = getConvDisplayName(db, conv);
        checks.push(createCheck(
          `${name}'s DM read (unreadCount=0)`,
          snapConv && snapConv.unreadCount === 0,
          `${conv.id} still has unreadCount ${snapConv ? snapConv.unreadCount : 'N/A'}`
        ));
      }

      let deadlineCount = 0, nonDeadlineCount = 0;
      for (const conv of unreadDMs) {
        const msgs = db.messages.filter(m => m.conversationId === conv.id && m.senderId !== 'user-me');
        for (const msg of msgs) {
          const isDeadline = deadlineMsgIds.has(msg.id);
          const msgReactions = reactions[msg.id];
          const thumbsUsers = msgReactions && Array.isArray(msgReactions['👍']) ? msgReactions['👍'] : [];
          const hasThumb = thumbsUsers.includes('user-me');

          if (isDeadline) {
            deadlineCount++;
            checks.push(createCheck(
              `👍 on deadline msg "${(msg.body || '').slice(0, 50)}…"`,
              hasThumb,
              `Deadline message ${msg.id} is missing 👍`
            ));
          } else if (hasThumb) {
            nonDeadlineCount++;
            checks.push(createCheck(
              `No 👍 on non-deadline msg "${(msg.body || '').slice(0, 50)}…"`,
              false,
              `Non-deadline message ${msg.id} was wrongly given 👍`
            ));
          } else {
            nonDeadlineCount++;
          }
        }
      }

      if (deadlineCount === 0) checks.push(createCheck('At least 1 deadline message found', false, 'No deadline messages found'));
      if (nonDeadlineCount === 0) checks.push(createCheck('At least 1 non-deadline message found', false, 'No non-deadline messages found'));

      return finalizeChecks(checks, 'Deadline messages reacted to, non-deadline messages left clean.');
    }
  },

  'EVAL-29': {
    tier: 3,
    desc: 'Send "Let\'s sync this week." to each favorited DM, "Team update: all tasks on track." to each favorited group',
    verify(snapshot, events, db) {
      const dmMsg = "Let's sync this week.";
      const groupMsg = 'Team update: all tasks on track.';
      const favDMs = db.conversations.filter(c => c.type === 'direct' && c.isFavorite);
      const favGroups = db.conversations.filter(c => c.type !== 'direct' && c.isFavorite);
      if (favDMs.length === 0) return fail('No favorited DM conversations found');
      if (favGroups.length === 0) return fail('No favorited group conversations found');
      const checks = [];

      for (const conv of favDMs) {
        const name = getConvDisplayName(db, conv);
        checks.push(createCheck(
          `DM message in ${name}'s conversation`,
          findNewExactMessage(snapshot, events, conv.id, dmMsg),
          `"${dmMsg}" not found in ${conv.id}`
        ));
        checks.push(createCheck(
          `Group message NOT in ${name}'s DM`,
          !findNewExactMessage(snapshot, events, conv.id, groupMsg),
          `Group message wrongly sent to DM ${conv.id}`
        ));
      }
      for (const conv of favGroups) {
        const name = conv.name || conv.id;
        checks.push(createCheck(
          `Group message in "${name}"`,
          findNewExactMessage(snapshot, events, conv.id, groupMsg),
          `"${groupMsg}" not found in ${conv.id}`
        ));
        checks.push(createCheck(
          `DM message NOT in "${name}"`,
          !findNewExactMessage(snapshot, events, conv.id, dmMsg),
          `DM message wrongly sent to group ${conv.id}`
        ));
      }

      return finalizeChecks(checks, 'Type-specific messages sent to all favorited conversations.');
    }
  },

  'EVAL-30': {
    tier: 3,
    desc: 'Compile dollar figures from all unread DMs into a budget summary posted to Engineering Leads (≥4 terms)',
    verify(snapshot, events, db) {
      const conv = getConvByName(db, 'Engineering Leads');
      if (!conv) return fail('Engineering Leads conversation not found');
      const userMsgs = getNewUserMessages(snapshot, events, conv.id);
      const budgetTerms = ['48', '900', '120', '180', '95', '40', '90', 'jenkins', 'headcount', 'datadog', 'grafana'];

      const checks = [
        createCheck('Message from user-me in Engineering Leads',
          userMsgs.length > 0,
          'No message from user-me in Engineering Leads'),
      ];

      if (userMsgs.length > 0) {
        let bestHits = 0;
        for (const msg of userMsgs) {
          const bodyLower = (msg.body || '').toLowerCase();
          const hits = budgetTerms.filter(term => bodyLower.includes(term)).length;
          if (hits > bestHits) bestHits = hits;
        }
        checks.push(createCheck(
          `Budget summary references ≥4 terms (found ${bestHits})`,
          bestHits >= 4,
          `Only ${bestHits} budget terms found (need ≥4): ${budgetTerms.join(', ')}`
        ));
      }

      return finalizeChecks(checks, 'Budget summary posted to Engineering Leads.');
    }
  },

  'EVAL-31': {
    tier: 2,
    desc: 'Send 👍 to the last message in every DM conversation',
    verify(snapshot, events, db) {
      const dmConvs = db.conversations.filter(c => c.type === 'direct');
      if (dmConvs.length === 0) return fail('No DM conversations found');
      const checks = [];
      const reactions = snapshot.reactions || {};

      // Find last message per DM from initial db
      const targetMsgIds = new Set();
      for (const conv of dmConvs) {
        const msgs = db.messages
          .filter(m => m.conversationId === conv.id)
          .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        const last = msgs[msgs.length - 1];
        if (!last) continue;
        targetMsgIds.add(last.id);
        const name = getConvDisplayName(db, conv);
        const msgReactions = reactions[last.id] || {};
        const thumbsUsers = msgReactions['👍'] || [];
        const hasThumbsUp = thumbsUsers.includes('user-me');
        checks.push(createCheck(
          `👍 on last message in ${name}'s DM (${last.id})`,
          hasThumbsUp,
          `No 👍 from user-me on ${last.id} in ${conv.id}`
        ));
      }

      // Ensure no reactions were added to non-target messages
      const wrongReactions = events.filter(e =>
        e.type === 'reaction_toggled' && !targetMsgIds.has(e.messageId)
      );
      checks.push(createCheck(
        'No reactions on non-target messages',
        wrongReactions.length === 0,
        `${wrongReactions.length} reaction(s) on non-target messages: ${wrongReactions.map(e => e.messageId).join(', ')}`
      ));

      return finalizeChecks(checks, 'All DM last messages have 👍 reaction.');
    }
  },

  'EVAL-32': {
    tier: 3,
    desc: 'Send unread-count summary to Engineering Leads listing each unread conversation name and count (exclude Engineering Leads itself)',
    verify(snapshot, events, db) {
      const conv = getConvByName(db, 'Engineering Leads');
      if (!conv) return fail('Engineering Leads conversation not found');
      const userMsgs = getNewUserMessages(snapshot, events, conv.id);
      const unreadConvs = getUnreadConvs(db, null).filter(c => c.id !== conv.id);
      if (unreadConvs.length === 0) return fail('No unread conversations found outside Engineering Leads');

      const checks = [
        createCheck('Message from user-me in Engineering Leads',
          userMsgs.length > 0,
          'No message from user-me in Engineering Leads'),
      ];

      if (userMsgs.length > 0) {
        let bestMsg = null, bestHits = -1;
        for (const msg of userMsgs) {
          const hits = unreadConvs.filter(uc =>
            messageMentionsConvWithCount(db, msg.body || '', uc, getInitialUnreadCount(db, uc.id))
          ).length;
          if (hits > bestHits) { bestHits = hits; bestMsg = msg; }
        }

        for (const uc of unreadConvs) {
          const name = getConvDisplayName(db, uc);
          const count = getInitialUnreadCount(db, uc.id);
          checks.push(createCheck(
            `Summary mentions "${name}" with count ${count}`,
            bestMsg && messageMentionsConvWithCount(db, bestMsg.body || '', uc, count),
            `"${name}" (${count} unreads) not found in summary`
          ));
        }

      }

      return finalizeChecks(checks, 'Unread count summary sent to Engineering Leads.');
    }
  },

  'EVAL-34': {
    tier: 3,
    desc: 'Send meeting prep message to every person who mentioned deadlines/meetings; not to others',
    verify(snapshot, events, db) {
      const msg = "I'll have my inputs ready before the meeting — let me know if you need anything else.";
      const targetNames = ['Taylor Brooks', 'Sam Lee', 'Jordan Kim', 'Riley Patel'];
      const checks = [];
      const targetConvIds = new Set();

      for (const name of targetNames) {
        const user = getUserByName(db, name);
        if (!user) return fail(`${name} not found in db`);
        const conv = getConvByParticipant(db, user.id);
        if (!conv) return fail(`No direct conversation with ${name}`);
        targetConvIds.add(conv.id);
        checks.push(createCheck(
          `Meeting prep message in ${name}'s DM`,
          findNewExactMessage(snapshot, events, conv.id, msg),
          `Message not found in ${name}'s conversation`
        ));
      }

      const otherConvs = db.conversations.filter(c => c.type === 'direct' && !targetConvIds.has(c.id));
      for (const conv of otherConvs) {
        if (findNewExactMessage(snapshot, events, conv.id, msg)) {
          const name = getConvDisplayName(db, conv);
          checks.push(createCheck(`Message NOT in ${name}'s DM`, false, `Message wrongly sent to ${conv.id}`));
        }
      }

      return finalizeChecks(checks, 'Meeting prep messages sent to correct people only.');
    }
  },

  'EVAL-22': {
    tier: 2,
    desc: 'Quote one of Casey Nguyen\'s messages in conv-4 and reply with "Noted, thanks for the context."',
    verify(snapshot, events, db) {
      const convId = 'conv-4';
      const caseyId = 'user-5';
      const expectedReply = 'Noted, thanks for the context.';

      // Casey's original messages (to verify quoting)
      const caseyMsgs = db.messages.filter(m => m.conversationId === convId && m.senderId === caseyId);

      const userMsgs = getNewUserMessages(snapshot, events, convId);
      const checks = [];

      // Check reply contains the expected text
      const hasReply = userMsgs.some(m => (m.body || '').includes(expectedReply));
      checks.push(createCheck(
        `Reply contains "${expectedReply}"`,
        hasReply,
        `No message from user-me in ${convId} contains "${expectedReply}"`
      ));

      // Check that a quote of one of Casey's messages is present (via replyToId in event log)
      const caseyMsgIds = new Set(caseyMsgs.map(m => m.id));
      const sentEvents = events.filter(e =>
        e.type === 'message_sent' && e.conversationId === convId
      );
      const hasQuote = sentEvents.some(e => e.replyToId && caseyMsgIds.has(e.replyToId));
      checks.push(createCheck(
        'Reply quotes one of Casey\'s messages',
        hasQuote,
        'No reply appears to quote any of Casey\'s messages'
      ));

      return finalizeChecks(checks, 'Quoted reply sent to Casey Nguyen.');
    }
  },

  'EVAL-33': {
    tier: 2,
    desc: "Identify 'away' team members, then open each of their conversations to check for messages",
    verify(snapshot, events, db) {
      // Away users: Taylor Brooks (user-4, conv-3), Sam Lee (user-9, conv-8)
      const awayUsers = db.users.filter(u => u.status === 'away');
      const checks = [];

      for (const user of awayUsers) {
        const conv = db.conversations.find(c =>
          c.type === 'direct' && c.participantIds.includes(user.id)
        );
        if (!conv) continue;

        // Opening a conversation clears unreadCount to 0 and logs a conversation-opened event
        const opened = events.some(e =>
          e.type === 'conversation_opened' && e.conversationId === conv.id
        );
        checks.push(createCheck(
          `Opened ${user.name}'s conversation (${conv.id})`,
          opened,
          `${user.name} is 'away' but their conversation ${conv.id} was never opened`
        ));
      }

      if (checks.length === 0) return fail('No away users found in db');
      return finalizeChecks(checks, "All 'away' members' conversations were opened.");
    }
  },

  'EVAL-35': {
    tier: 3,
    desc: 'Send personalized reply (containing recipient\'s first name) to each unread DM',
    verify(snapshot, events, db) {
      const unreadDMs = getUnreadConvs(db, 'direct');
      if (unreadDMs.length === 0) return fail('No unread DM conversations found');
      const checks = [];

      for (const conv of unreadDMs) {
        const otherUserId = conv.participantIds.find(id => id !== 'user-me');
        const user = db.users.find(u => u.id === otherUserId);
        if (!user) continue;
        const firstName = user.name.split(/\s+/)[0].toLowerCase();
        const userMsgs = getNewUserMessages(snapshot, events, conv.id);
        const personalized = userMsgs.find(m => (m.body || '').toLowerCase().includes(firstName));
        checks.push(createCheck(
          `Reply in ${user.name}'s DM contains "${firstName}"`,
          personalized,
          `No personalized reply containing "${firstName}" in ${conv.id}`
        ));
      }

      return finalizeChecks(checks, 'Personalized replies sent to all unread DMs.');
    }
  },
};

// ─── Result Helpers ───────────────────────────────────────────────────────────
function pass(message) { return { pass: true, message: message || 'All checks passed.' }; }
function fail(reason) { return { pass: false, message: reason }; }

function createCheck(label, passCondition, failDetail) {
  return { label, pass: Boolean(passCondition), detail: passCondition ? undefined : failDetail };
}

function finalizeChecks(checks, successMessage) {
  const failed = checks.filter(c => !c.pass);
  if (failed.length === 0) return { pass: true, message: successMessage || 'All checks passed.', checks };
  return { pass: false, message: failed.map(c => c.detail || `${c.label} failed.`).join(' '), checks };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runAll = args.includes('--all');
const taskId = args.find(a => a.startsWith('EVAL-'));
const snapshotPath = getArgValue(args, '--snapshot') || SNAPSHOT_PATH;
const eventLogPath = getArgValue(args, '--events') || EVENT_LOG_PATH;

if (!runAll && !taskId) {
  console.error('Usage: node evaluator.js EVAL-XX [--snapshot path] [--events path] | node evaluator.js --all [--snapshot path] [--events path]');
  process.exit(1);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function printTaskChecklist(taskId, task, result, indent = '') {
  if (result && Array.isArray(result.checks) && result.checks.length > 0) {
    console.log(`${indent}${BOLD}Checks:${RESET}`);
    for (const check of result.checks) {
      const icon = check.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`${indent}  ${icon} ${check.label}`);
    }
  }
}

console.log(`teams evaluator v${VERSION}`);

const snapshot = loadSnapshot(snapshotPath);
const events = loadEvents(eventLogPath);
const db = loadDb();

if (!db) {
  console.error('ERROR: Could not load db_initial.json');
  process.exit(1);
}

if (!snapshot) {
  console.error(`ERROR: snapshot is empty or missing at ${snapshotPath}. Run the app and perform some actions first.`);
  process.exit(1);
}

/* ===== RUN TASK ===== */
function runTaskSingle(taskId) {
  const task = evaluators[taskId];
  if (!task) {
    console.error(`${RED}Unknown task: ${taskId}${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}${taskId}${RESET} ${DIM}(Tier ${task.tier})${RESET}`);
  console.log(`${DIM}${task.desc}${RESET}`);

  let result;
  try {
    result = task.verify(snapshot, events, db);
  } catch (e) {
    result = fail(`Evaluator error: ${e.message}`);
  }

  printTaskChecklist(taskId, task, result);

  if (result.pass) {
    console.log(`${GREEN}${BOLD}✓ PASS${RESET}  ${result.message}`);
  } else {
    console.log(`${RED}${BOLD}✗ FAIL${RESET}  ${result.message}`);
  }

  if (result.checks && result.checks.length > 0) {
    const passed = result.checks.filter(c => c.pass).length;
    const score = (passed / result.checks.length).toFixed(2);
    console.log(`${BOLD}Score: ${score}${RESET} (${passed}/${result.checks.length})`);
  } else {
    console.log(`${BOLD}Score: ${result.pass ? '1.00' : '0.00'}${RESET}`);
  }

  return result.pass;
}

/* ===== RUN ALL ===== */
function runAllTasks() {
  const tiers = { 2: [], 3: [] };
  let passed = 0;
  let failed = 0;

  for (const [taskId, task] of Object.entries(evaluators)) {
    let result;
    try {
      result = task.verify(snapshot, events, db);
    } catch (e) {
      result = fail(`Evaluator error: ${e.message}`);
    }
    const tier = task.tier || 2;
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push({ taskId, task, result });
    if (result.pass) passed++; else failed++;
  }

  for (const tier of [2, 3]) {
    if (!tiers[tier] || tiers[tier].length === 0) continue;
    console.log(`\n${BOLD}── Tier ${tier} ──────────────────────────────────────${RESET}`);
    for (const { taskId, task, result } of tiers[tier]) {
      const icon = result.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const status = result.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  ${icon} ${BOLD}${taskId}${RESET} ${status}`);
      console.log(`     ${DIM}${task.desc}${RESET}`);
      printTaskChecklist(taskId, task, result, '     ');
      if (!result.pass) {
        console.log(`     ${RED}→ ${result.message}${RESET}`);
      }
    }
  }

  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const scoreColor = pct >= 80 ? GREEN : pct >= 50 ? YELLOW : RED;
  console.log(`\n${BOLD}Results: ${scoreColor}${passed}/${total} passed (${pct}%)${RESET}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (runAll) {
  runAllTasks();
} else {
  const ok = runTaskSingle(taskId);
  process.exit(ok ? 0 : 1);
}
