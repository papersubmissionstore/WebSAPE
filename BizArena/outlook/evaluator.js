#!/usr/bin/env node
'use strict';

const VERSION = '1.0.0';

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, 'localStorage_snapshot.json');
const EVENT_LOG_PATH = path.join(__dirname, 'event_log.ndjson');

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : null;
}

/* ===== LOAD DATA ===== */
function loadSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadEvents(eventLogPath) {
  if (!fs.existsSync(eventLogPath)) return [];
  const lines = fs.readFileSync(eventLogPath, 'utf8')
    .split('\n')
    .filter(l => l.trim());
  return lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function normalizeText(htmlOrText) {
  return String(htmlOrText || '')
    .replace(/<\/[^>]+>/g, '')   // remove closing tags (no space, keeps punctuation attached)
    .replace(/<[^>]+>/g, ' ')    // replace opening/void tags with space (word boundaries)
    .replace(/\s+/g, ' ')
    .trim();
}

function notesContainAny(text, variants) {
  return variants.some(variant => text.includes(variant));
}

/**
 * Filter email_sent events by recipient.
 * Returns { matched, wrongDomain } where matched has the correct full address
 * and wrongDomain has the right local part but wrong domain.
 */
function filterEmailsByRecipient(events, fullAddress) {
  const localPart = fullAddress.split('@')[0];
  const matched = events.filter(e =>
    e.type === 'email_sent' &&
    Array.isArray(e.to) && e.to.some(addr => addr.includes(fullAddress))
  );
  const wrongDomain = events.filter(e =>
    e.type === 'email_sent' &&
    Array.isArray(e.to) && e.to.some(addr => addr.includes(localPart) && !addr.includes(fullAddress))
  );
  return { matched, wrongDomain };
}

function recipientErrorDetail(fullAddress, matched, wrongDomain) {
  if (matched.length === 0 && wrongDomain.length > 0) {
    return `Email was sent to ${fullAddress.split('@')[0]} but at the wrong domain (expected ${fullAddress}).`;
  }
  return `No email was sent to ${fullAddress}.`;
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'db.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadSeedDb() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'db_initial.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadTaskIntents() {
  const datasetPath = path.join(__dirname, '..', 'outlook_v2.jsonl');
  if (!fs.existsSync(datasetPath)) return {};

  try {
    return fs.readFileSync(datasetPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .reduce((acc, line) => {
        try {
          const row = JSON.parse(line);
          if (row && row.task_id != null && typeof row.intent === 'string') {
            acc[`EVAL-${row.task_id}`] = row.intent.trim();
          }
        } catch (e) {
          // Ignore malformed dataset rows and keep evaluating the rest.
        }
        return acc;
      }, {});
  } catch (e) {
    return {};
  }
}

function normalizeChecklistItem(item) {
  return String(item || '')
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    .trim();
}

function buildChecklistFromIntent(source, fallbackDesc) {
  const text = normalizeChecklistItem(source || fallbackDesc || '');
  if (!text) return [];

  const segmented = text
    .replace(/\s+(Then|After that|Finally|Also|But first)\b/gi, '. $1')
    .replace(/:\s+/g, ': ');

  const items = segmented
    .split(/\.\s+/)
    .map(item => normalizeChecklistItem(item))
    .filter(Boolean);

  return items.length > 0 ? items : [text];
}

const TASK_INTENTS = loadTaskIntents();

function getTaskChecklist(taskId, task) {
  if (Array.isArray(task.checks) && task.checks.length > 0) {
    return task.checks;
  }
  return buildChecklistFromIntent(TASK_INTENTS[taskId], task.desc);
}

function printTaskChecklist(taskId, task, result, indent = '') {
  if (result && Array.isArray(result.checks) && result.checks.length > 0) {
    console.log(`${indent}${BOLD}Checks:${RESET}`);
    for (const check of result.checks) {
      const icon = check.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`${indent}  ${icon} ${check.label}`);
    }
    return;
  }

  const checks = getTaskChecklist(taskId, task);
  if (checks.length === 0) return;

  console.log(`${indent}${BOLD}Checks:${RESET}`);
  for (const check of checks) {
    console.log(`${indent}  ${DIM}•${RESET} ${check}`);
  }
}

function getFolderByName(snapshot, name) {
  return (snapshot.folders || []).find(folder =>
    String(folder.name || '').toLowerCase() === String(name).toLowerCase()
  );
}

function getEmail(snapshot, id) {
  return (snapshot.emails || []).find(email => email.id === id);
}

// Get email from db.json (server-side truth) with snapshot fallback.
// Use for server-side fields like flagged, read, pinned, folder.
function getDbEmail(id) {
  const db = loadDb();
  if (db) {
    const email = (db.emails || []).find(e => e.id === id);
    if (email) return email;
  }
  return null;
}

function getCalendarEvent(snapshot, id) {
  return (snapshot.calendarEvents || []).find(event => event.id === id);
}

function createCheck(label, passCondition, failDetail, passDetail) {
  return {
    label,
    pass: Boolean(passCondition),
    detail: passCondition ? passDetail : failDetail,
  };
}

function finalizeChecks(checks, successMessage) {
  const failedChecks = checks.filter(check => !check.pass);
  if (failedChecks.length === 0) {
    return { pass: true, message: successMessage, checks };
  }

  return {
    pass: false,
    message: failedChecks.map(check => check.detail || `${check.label} failed.`).join(' '),
    checks,
  };
}

function selectBestCandidate(candidates, evaluateCandidate) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const scored = candidates.map(candidate => {
    const checks = evaluateCandidate(candidate);
    return {
      candidate,
      checks,
      passed: checks.filter(Boolean).length,
    };
  });

  scored.sort((left, right) => right.passed - left.passed);
  return scored[0] || null;
}

/* ===== TASK DEFINITIONS ===== */
const TASKS = {

  // ─── TIER 1 ─────────────────────────────────────────────────────────────

  'EVAL-01': {
    tier: 1,
    desc: 'Mark Sarah Mitchell\'s "Q4 Budget Review" email as read',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found. Run the app first.');
      const email = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'sarah.mitchell@contoso.com' &&
        e.subject && e.subject.includes('Q4 Budget Review')
      );
      if (!email) return fail('Cannot find email from Sarah Mitchell about Q4 Budget Review.');
      if (!email.read) return fail(`Email "${email.subject}" is still marked unread.`);
      return pass(`Email "${email.subject}" is marked read.`);
    },
  },

  'EVAL-02': {
    tier: 1,
    // FIX: email-003 now starts unflagged in db_initial.json, so this is meaningful.
    desc: 'Flag the Marcus Thompson "Project Phoenix – Status Update" email',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const email = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'marcus.thompson@contoso.com' &&
        e.subject && e.subject.includes('Project Phoenix')
      );
      if (!email) return fail('Cannot find email from Marcus Thompson about Project Phoenix.');
      const dbEmail = getDbEmail(email.id);
      const flagged = dbEmail ? dbEmail.flagged : email.flagged;
      if (!flagged) return fail(`Email "${email.subject}" is not flagged.`);
      return pass(`Email "${email.subject}" is flagged.`);
    },
  },

  'EVAL-03': {
    tier: 1,
    desc: 'Switch to the "Other" tab then back to "Focused"',
    verify(snapshot, events) {
      const switchedToOther = events.find(e => e.type === 'tab_switched' && e.tab === 'other');
      if (!switchedToOther) return fail('No tab_switched event with tab="other" found.');
      const otherTime = new Date(switchedToOther.ts).getTime();
      const laterFocused = events.find(e =>
        e.type === 'tab_switched' && e.tab === 'focused' &&
        new Date(e.ts).getTime() > otherTime
      );
      if (!laterFocused) return fail('Switched to Other but no tab_switched to "focused" found after that.');
      // Final tab switch must be to "focused"
      const lastTabSwitch = [...events].reverse().find(e => e.type === 'tab_switched');
      if (lastTabSwitch && lastTabSwitch.tab !== 'focused') {
        return fail(`The last tab switch was to "${lastTabSwitch.tab}", not "focused". Make sure to end on the Focused tab.`);
      }
      return pass('Tab switched to Other and back to Focused.');
    },
  },

  'EVAL-04': {
    tier: 1,
    desc: 'Open the Sent Items folder and read an email there',
    verify(snapshot, events) {
      const folderEv = events.find(e => e.type === 'folder_selected' && e.folder === 'sent');
      if (!folderEv) return fail('No folder_selected event with folder="sent" found.');
      if (!snapshot) return fail('No snapshot found.');
      const sentFolderTime = new Date(folderEv.ts).getTime();
      // Any email_read event after navigating to sent, OR any sent email that is read
      const readAfter = events.find(e =>
        e.type === 'email_read' && new Date(e.ts).getTime() >= sentFolderTime
      );
      const sentReadEmails = (snapshot.emails || []).filter(e => e.folder === 'sent' && e.read);
      if (!readAfter && sentReadEmails.length === 0) {
        return fail('Navigated to Sent Items but no email was read there.');
      }
      return pass(`Sent Items folder opened. ${sentReadEmails.length} sent email(s) are read.`);
    },
  },

  'EVAL-05': {
    tier: 1,
    desc: 'Unpin HR "New Employee Onboarding" email and pin Marcus "Project Phoenix" email instead',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const errors = [];

      // Check HR email (email-004) is unpinned
      const hrEmail = (snapshot.emails || []).find(e => e.id === 'email-004');
      if (!hrEmail) return fail('Cannot find HR onboarding email (email-004) in snapshot.');
      if (hrEmail.pinned) errors.push(`HR email "${hrEmail.subject}" is still pinned.`);
      const unpinEv = events.find(e => e.type === 'email_pinned' && e.emailId === 'email-004' && e.pinned === false);
      if (!unpinEv) errors.push('No email_pinned event (pinned=false) logged for HR email.');

      // Check Marcus email (email-003) is pinned
      const marcusEmail = (snapshot.emails || []).find(e => e.id === 'email-003');
      if (!marcusEmail) return fail('Cannot find Project Phoenix email (email-003) in snapshot.');
      if (!marcusEmail.pinned) errors.push(`Marcus email "${marcusEmail.subject}" is not pinned.`);
      const pinEv = events.find(e => e.type === 'email_pinned' && e.emailId === 'email-003' && e.pinned === true);
      if (!pinEv) errors.push('No email_pinned event (pinned=true) logged for Marcus email.');

      if (errors.length > 0) return fail(errors.join(' '));
      return pass(`HR email unpinned, Project Phoenix email pinned.`);
    },
  },

  // ─── TIER 2 ─────────────────────────────────────────────────────────────

  'EVAL-06': {
    tier: 2,
    desc: 'Find the "Board Meeting" event on this Thursday, rename it to "Board Meeting - Rescheduled", and move it to 2:00 PM–3:00 PM',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const original = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'jennifer.park@contoso.com' &&
        e.subject && e.subject.includes('Sprint Planning')
      );
      if (!original) return fail('Cannot find Sprint Planning email from Jennifer Park.');

      const allReplies = events.filter(e => e.type === 'email_sent' && e.replyToId === original.id);
      if (allReplies.length === 0) return fail('No email_sent event found replying to the Sprint Planning email.');

      const correctReply = allReplies.find(ev => {
        const sent = (snapshot.emails || []).find(e => e.id === ev.emailId);
        if (!sent) return false;
        return normalizeText(sent.body).toLowerCase() === "i'll be there on thursday!";
      });
      const wrongReplies = allReplies.filter(ev => ev !== correctReply);
      const wrongNote = wrongReplies.length ? ` (${wrongReplies.length} other reply attempt(s) with wrong text)` : '';

      if (!correctReply) {
        const lastReply = allReplies[allReplies.length - 1];
        const lastEmail = (snapshot.emails || []).find(e => e.id === lastReply.emailId);
        const preview = lastEmail ? `"${normalizeText(lastEmail.body).slice(0, 120)}"` : '(not found)';
        return fail(`${allReplies.length} reply/replies sent but none contains "I'll be there on Thursday!". Last reply body: ${preview}.`);
      }
      return pass(`Reply with "I'll be there on Thursday!" sent to Jennifer Park.${wrongNote} Event logged at ${correctReply.ts}.`);
    },
  },

  'EVAL-07': {
    tier: 2,
    desc: 'Delete Automated Alerts "Critical: Production Server Down" and verify in Deleted Items',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const deleteEv = events.find(e =>
        e.type === 'email_deleted' &&
        e.subject && e.subject.includes('Production Server Down')
      );
      if (!deleteEv) return fail('No email_deleted event found for the Production Server Down email.');
      const email = (snapshot.emails || []).find(e => e.id === deleteEv.emailId);
      if (email && email.folder !== 'deleted') {
        return fail(`Email "${email.subject}" is in folder "${email.folder}", expected "deleted".`);
      }
      const folderVisited = events.find(e => e.type === 'folder_selected' && e.folder === 'deleted');
      if (!folderVisited) return fail('Deleted Items folder was never opened to verify.');
      return pass('Email deleted (soft delete to Deleted Items). Deleted Items folder was visited.');
    },
  },

  'EVAL-08': {
    tier: 2,
    desc: 'Compose new email to sarah.mitchell with subject "Re: Q4 Action Items", body with sign-off, "Thursday" bold+italic, then send',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const allSent = events.filter(e =>
        e.type === 'email_sent' &&
        e.replyToId === null &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('sarah.mitchell@contoso.com'))
      );
      if (allSent.length === 0) return fail('No email_sent event to sarah.mitchell@contoso.com found.');

      // Check for bold+italic "thursday" in either nesting order
      function hasBoldItalicThursday(html) {
        // <strong><em>Thursday</em></strong> or <em><strong>Thursday</strong></em>
        // also <b><i> variants
        return (
          /<(strong|b)[^>]*>\s*<(em|i)[^>]*>[^<]*thursday[^<]*<\/(em|i)>\s*<\/(strong|b)>/i.test(html) ||
          /<(em|i)[^>]*>\s*<(strong|b)[^>]*>[^<]*thursday[^<]*<\/(strong|b)>\s*<\/(em|i)>/i.test(html)
        );
      }

      let correctSent = null;
      const attemptNotes = [];
      for (const sentEv of allSent) {
        const sent = (snapshot.emails || []).find(e => e.id === sentEv.emailId);
        if (!sent) { attemptNotes.push('(sent email missing from snapshot)'); continue; }
        const issues = [];
        if (sent.subject.trim().toLowerCase() !== 're: q4 action items') issues.push('subject is not exactly "Re: Q4 Action Items"');
        const bodyText = normalizeText(sent.body).toLowerCase();
        if (!bodyText.includes("hi sarah, i'll have the sign-off to you by thursday.")) {
          issues.push('body does not include required sentence "Hi Sarah, I\'ll have the sign-off to you by Thursday."');
        }
        if (!hasBoldItalicThursday(sent.body)) issues.push('"Thursday" not bold+italic');
        if (issues.length === 0) { correctSent = sentEv; break; }
        attemptNotes.push(`Attempt "${sent.subject}": ${issues.join(', ')}`);
      }

      const wrongNote = allSent.length > 1 ? ` (${allSent.length - (correctSent ? 1 : 0)} other send attempt(s))` : '';

      if (!correctSent) {
        const note = attemptNotes.length ? ` Issues found: ${attemptNotes.join(' | ')}` : '';
        return fail(`${allSent.length} email(s) sent to Sarah Mitchell but none fully matched requirements.${note}`);
      }
      const sentEmail = (snapshot.emails || []).find(e => e.id === correctSent.emailId);
      return pass(`New email sent to Sarah Mitchell with subject "${sentEmail.subject}", "Thursday" is bold+italic.${wrongNote}`);
    },
  },

  'EVAL-09': {
    tier: 2,
    // FIX: changed from Drafts to Archive — moving a received email to Drafts is not a real workflow.
    desc: 'Move Marcus Thompson\'s "Project Phoenix – Status Update" email to the Archive folder',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const allArchiveMoves = events.filter(e =>
        e.type === 'email_moved' && e.to === 'archive'
      );
      if (allArchiveMoves.length === 0) return fail('No email_moved event moving any email to archive.');

      const correctMove = allArchiveMoves.find(e =>
        e.subject && e.subject.includes('Project Phoenix')
      );
      const wrongMoves = allArchiveMoves.filter(e => e !== correctMove);
      const wrongNote = wrongMoves.length ? ` (also moved ${wrongMoves.length} other email(s) to archive: ${wrongMoves.map(e => `"${e.subject || e.emailId}"`).join(', ')})` : '';

      if (!correctMove) {
        return fail(`Moved ${allArchiveMoves.length} email(s) to archive but none was the Project Phoenix email. Moved: ${allArchiveMoves.map(e=>`"${e.subject||e.emailId}"`).join(', ')}.`);
      }

      const email = (snapshot.emails || []).find(e => e.id === correctMove.emailId);
      if (email && email.folder !== 'archive') {
        return fail(`Email "${email.subject}" is in folder "${email.folder}", expected "archive".`);
      }
      return pass(`Email "${correctMove.subject}" moved to Archive.${wrongNote} Event logged at ${correctMove.ts}.`);
    },
  },

  'EVAL-10': {
    tier: 2,
    desc: 'Search for "budget" and open a search result',
    verify(snapshot, events) {
      const searchEv = events.find(e =>
        e.type === 'search_performed' && e.query && e.query.toLowerCase().includes('budget')
      );
      if (!searchEv) return fail('No search_performed event with query containing "budget" found.');
      if (!snapshot) return fail('No snapshot found.');

      const searchTime = new Date(searchEv.ts).getTime();
      const readAfterSearch = events.find(e =>
        e.type === 'email_read' && new Date(e.ts).getTime() >= searchTime
      );
      const budgetEmails = (snapshot.emails || []).filter(e =>
        e.subject && e.subject.toLowerCase().includes('budget')
      );
      if (budgetEmails.length === 0) return fail('No budget-related emails in snapshot.');
      const anyBudgetRead = budgetEmails.some(e => e.read);

      if (!readAfterSearch && !anyBudgetRead) {
        return fail('Searched for "budget" but no budget email appears to have been opened.');
      }
      return pass(`Searched for "budget". Found ${budgetEmails.length} result(s). A budget email was opened.`);
    },
  },

  // ─── TIER 3 ─────────────────────────────────────────────────────────────

  'EVAL-11': {
    tier: 3,
    desc: 'Search for Marcus Thompson, open an email, reply with "Thanks for the update, Marcus."',
    verify(snapshot, events) {
      const searchEv = events.find(e =>
        e.type === 'search_performed' && e.query && e.query.toLowerCase().includes('marcus')
      );
      if (!searchEv) return fail('No search_performed event with query containing "marcus" found.');
      if (!snapshot) return fail('No snapshot found.');

      const searchTime = new Date(searchEv.ts).getTime();
      const marcusEmails = (snapshot.emails || []).filter(e =>
        e.from && e.from.email === 'marcus.thompson@contoso.com'
      );
      if (marcusEmails.length === 0) return fail('No emails from Marcus Thompson in snapshot.');

      const allReplies = events.filter(e =>
        e.type === 'email_sent' &&
        new Date(e.ts).getTime() > searchTime &&
        marcusEmails.some(m => m.id === e.replyToId)
      );
      if (allReplies.length === 0) return fail('No email_sent event replying to a Marcus Thompson email after the search.');

      const correctReply = allReplies.find(ev => {
        const sent = (snapshot.emails || []).find(e => e.id === ev.emailId);
        return sent && sent.body.replace(/<[^>]+>/g, '').toLowerCase().includes('thanks for the update');
      });
      const wrongReplies = allReplies.filter(ev => ev !== correctReply);
      const wrongNote = wrongReplies.length ? ` (${wrongReplies.length} other reply attempt(s) with wrong text)` : '';

      if (!correctReply) {
        const lastReply = allReplies[allReplies.length - 1];
        const lastEmail = (snapshot.emails || []).find(e => e.id === lastReply.emailId);
        const preview = lastEmail ? `"${lastEmail.body.replace(/<[^>]+>/g,'').slice(0,120)}"` : '(not found)';
        return fail(`${allReplies.length} reply/replies sent but none contains "Thanks for the update". Last reply body: ${preview}.`);
      }
      return pass(`Searched for Marcus, replied with expected text.${wrongNote} Event logged at ${correctReply.ts}.`);
    },
  },

  'EVAL-12': {
    tier: 3,
    desc: 'Delete all 4 Automated Alerts emails',
    // FIX: removed dead/broken deleteEvents variable; improved detection logic; updated count to 4.
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const alertSender = 'alerts@monitoring.contoso.com';

      // Emails from this sender that still exist (should be in deleted) or were permanently removed
      const alertEmailsInSnapshot = (snapshot.emails || []).filter(e =>
        e.from && e.from.email === alertSender
      );
      const alertsInDeleted = alertEmailsInSnapshot.filter(e => e.folder === 'deleted');
      const alertsInOtherFolders = alertEmailsInSnapshot.filter(e => e.folder !== 'deleted');

      // Count delete events for alert emails by emailId or subject keywords
      const alertDeleteEvents = events.filter(e => {
        if (e.type !== 'email_deleted') return false;
        // Match by emailId against known snapshot emails
        const inSnapshot = (snapshot.emails || []).find(em => em.id === e.emailId);
        if (inSnapshot && inSnapshot.from && inSnapshot.from.email === alertSender) return true;
        // Match by subject keywords for emails that may have been permanently deleted
        return e.subject && (
          e.subject.includes('Production Server Down') ||
          e.subject.includes('Disk Usage Warning') ||
          e.subject.includes('SSL Certificate') ||
          e.subject.includes('Rate Limit') ||
          e.subject.includes('Alert')
        );
      });

      if (alertDeleteEvents.length < 4) {
        return fail(`Only ${alertDeleteEvents.length} Automated Alerts email(s) deleted. Expected all 4 (Production Server Down, Disk Usage Warning, SSL Certificate, API Rate Limit).`);
      }
      if (alertsInOtherFolders.length > 0) {
        return fail(`${alertsInOtherFolders.length} Automated Alerts email(s) are still in non-deleted folders: ${alertsInOtherFolders.map(e=>e.folder).join(', ')}.`);
      }

      return pass(`All ${alertDeleteEvents.length} Automated Alert email(s) deleted. ${alertsInDeleted.length} in Deleted Items folder.`);
    },
  },

  'EVAL-13': {
    tier: 3,
    desc: 'Forward Priya Sharma\'s "Code Review Request: Auth Module Refactor" to jennifer.park@contoso.com',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const original = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'priya.sharma@contoso.com' &&
        e.subject && e.subject.toLowerCase().includes('auth module')
      );
      if (!original) return fail('Cannot find Priya Sharma\'s Code Review email.');

      const allForwards = events.filter(e =>
        e.type === 'email_sent' &&
        e.mode === 'forward' &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('jennifer.park@contoso.com'))
      );
      if (allForwards.length === 0) return fail('No email_sent forward event to jennifer.park found.');

      const correctForward = allForwards.find(ev => {
        const sent = (snapshot.emails || []).find(e => e.id === ev.emailId);
        return sent && sent.subject.toLowerCase().includes('auth module');
      });
      const wrongForwards = allForwards.filter(ev => ev !== correctForward);
      const wrongNote = wrongForwards.length
        ? ` Also forwarded wrong email(s) to jennifer.park: ${wrongForwards.map(ev => {
            const s = (snapshot.emails || []).find(e => e.id === ev.emailId);
            return `"${s ? s.subject : ev.emailId}"`;
          }).join(', ')}.`
        : '';

      if (!correctForward) {
        const subjects = allForwards.map(ev => {
          const s = (snapshot.emails || []).find(e => e.id === ev.emailId);
          return `"${s ? s.subject : ev.emailId}"`;
        }).join(', ');
        return fail(`${allForwards.length} email(s) forwarded to jennifer.park but none has the Auth Module subject. Forwarded: ${subjects}.`);
      }
      const sentEmail = (snapshot.emails || []).find(e => e.id === correctForward.emailId);
      return pass(`Priya's Code Review email forwarded to jennifer.park with subject "${sentEmail ? sentEmail.subject : ''}".${wrongNote} Event logged at ${correctForward.ts}.`);
    },
  },

  'EVAL-14': {
    tier: 3,
    desc: 'Pin AND flag Jennifer Park\'s "Sprint Planning Meeting" email',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const email = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'jennifer.park@contoso.com' &&
        e.subject && e.subject.includes('Sprint Planning')
      );
      if (!email) return fail('Cannot find Sprint Planning email from Jennifer Park.');

      const dbEmail = getDbEmail(email.id);
      const issues = [];
      if (!(dbEmail || email).pinned) issues.push('Email is NOT pinned.');
      if (!(dbEmail || email).flagged) issues.push('Email is NOT flagged.');
      if (issues.length > 0) return fail(issues.join(' '));

      return pass(`Sprint Planning email is both pinned and flagged.`);
    },
  },

  'EVAL-15': {
    tier: 3,
    desc: 'Find "Project Phoenix" thread, read the latest reply from Marcus (email-003), reply with sync text',
    // FIX: email-003 is the newest Marcus email in conv-003 (2026-03-04T08:22), not email-022.
    // Both are valid targets since the task says "latest reply from Marcus in the thread".
    // The evaluator now picks the most-recent Marcus email in conv-003 dynamically.
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      // Find the most recent Marcus Thompson email in the Phoenix conversation
      const marcusPhoenixEmails = (snapshot.emails || [])
        .filter(e =>
          e.conversationId === 'conv-003' &&
          e.from && e.from.email === 'marcus.thompson@contoso.com'
        )
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      if (marcusPhoenixEmails.length === 0) {
        return fail('Cannot find any Marcus Thompson email in the Project Phoenix conversation thread.');
      }
      const latestMarcus = marcusPhoenixEmails[0];

      const readEv = events.find(e => e.type === 'email_read' && e.emailId === latestMarcus.id);
      if (!readEv && !latestMarcus.read) {
        return fail(`The latest Marcus reply in the Phoenix thread ("${latestMarcus.subject}") was not read.`);
      }

      const allReplies = events.filter(e =>
        e.type === 'email_sent' && e.replyToId === latestMarcus.id
      );
      if (allReplies.length === 0) return fail(`No email_sent event replying to Marcus's latest Phoenix email (id: ${latestMarcus.id}).`);

      const correctReply = allReplies.find(ev => {
        const sent = (snapshot.emails || []).find(e => e.id === ev.emailId);
        if (!sent) return false;
        const body = sent.body.replace(/<[^>]+>/g, '').toLowerCase();
        return body.includes('sync tomorrow') || body.includes('10am');
      });
      const wrongReplies = allReplies.filter(ev => ev !== correctReply);
      const wrongNote = wrongReplies.length ? ` (${wrongReplies.length} other reply attempt(s) with wrong text)` : '';

      if (!correctReply) {
        const lastReply = allReplies[allReplies.length - 1];
        const lastEmail = (snapshot.emails || []).find(e => e.id === lastReply.emailId);
        const preview = lastEmail ? `"${lastEmail.body.replace(/<[^>]+>/g,'').slice(0,120)}"` : '(not found)';
        return fail(`${allReplies.length} reply/replies sent but none contains "sync tomorrow" or "10am". Last reply body: ${preview}.`);
      }
      return pass(`Project Phoenix latest Marcus reply read, replied with expected text.${wrongNote} Event logged at ${correctReply.ts}.`);
    },
  },

  // ─── TIER 2 — NEW TASKS ──────────────────────────────────────────────────

  'EVAL-16': {
    tier: 2,
    desc: 'Filter the inbox by Unread emails, then open one of the unread emails',
    verify(snapshot, events) {
      // Check that a filter was applied (currently logged as part of state; check via snapshot)
      // The app filters client-side; we verify an unread email was read after the filter was likely applied.
      // Best signal: an email_read event exists for an email that was initially unread.
      if (!snapshot) return fail('No snapshot found.');
      const readEv = events.find(e => e.type === 'email_read');
      if (!readEv) return fail('No email_read event found.');
      // The initially-unread emails include email-001, email-002, email-007, email-008, etc.
      const initiallyUnread = ['email-001', 'email-002', 'email-007', 'email-008', 'email-010',
        'email-013', 'email-017', 'email-025', 'email-030', 'email-052'];
      const readUnread = events.find(e =>
        e.type === 'email_read' && initiallyUnread.includes(e.emailId)
      );
      if (!readUnread) return fail('No unread email was opened. Make sure to use the Unread filter and open a result.');
      const email = (snapshot.emails || []).find(e => e.id === readUnread.emailId);
      return pass(`Unread filter used and email "${email ? email.subject : readUnread.emailId}" was opened and marked read.`);
    },
  },

  'EVAL-17': {
    tier: 2,
    desc: 'Open the Drafts folder, open a draft email, edit the body, and save it',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folderEv = events.find(e => e.type === 'folder_selected' && e.folder === 'drafts');
      if (!folderEv) return fail('No folder_selected event for Drafts folder.');
      const draftSaveEv = events.find(e =>
        e.type === 'draft_saved' && new Date(e.ts).getTime() >= new Date(folderEv.ts).getTime()
      );
      if (!draftSaveEv) return fail('Drafts folder was opened but no draft_saved event was found after that.');
      const draft = (snapshot.emails || []).find(e => e.id === draftSaveEv.draftId);
      if (!draft) return fail('Saved draft not found in snapshot.');
      if (draft.folder !== 'drafts') return fail(`Draft email is in "${draft.folder}" instead of "drafts".`);
      return pass(`Drafts folder opened, draft "${draft.subject}" was saved. Event logged at ${draftSaveEv.ts}.`);
    },
  },

  'EVAL-18': {
    tier: 2,
    desc: 'Apply a category colour (e.g. red) to the email from Rachel Green about "Team Lunch Friday"',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const email = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'rachel.green@contoso.com' &&
        e.subject && e.subject.includes('Team Lunch')
      );
      if (!email) return fail('Cannot find the Team Lunch email from Rachel Green.');
      if (!email.category || email.category === 'none') {
        return fail(`Email "${email.subject}" has no category set (value: "${email.category}").`);
      }
      return pass(`Category "${email.category}" applied to "${email.subject}".`);
    },
  },

  'EVAL-19': {
    tier: 2,
    desc: 'Download the "Q4_Budget_2026.xlsx" attachment from the "Q4 Budget Review" email',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const email = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'sarah.mitchell@contoso.com' &&
        e.subject && e.subject.includes('Q4 Budget Review')
      );
      if (!email) return fail('Cannot find Q4 Budget Review email from Sarah Mitchell.');
      const dlEvs = events.filter(e =>
        e.type === 'attachment_downloaded' && e.emailId === email.id
      );
      if (dlEvs.length === 0) return fail(`No attachment downloaded from "${email.subject}".`);
      const correct = dlEvs.filter(e => e.filename === 'Q4_Budget_2026.xlsx');
      const wrong = dlEvs.filter(e => e.filename !== 'Q4_Budget_2026.xlsx');
      const wrongList = wrong.length ? ` Wrong file(s) also downloaded: ${wrong.map(e => `"${e.filename}"`).join(', ')}.` : '';
      if (correct.length === 0) {
        return fail(`Correct attachment "Q4_Budget_2026.xlsx" was never downloaded.${wrongList}`);
      }
      return pass(`Attachment "Q4_Budget_2026.xlsx" downloaded from "${email.subject}".${wrongList}`);
    },
  },

  // ─── TIER 3 — NEW TASKS ──────────────────────────────────────────────────

  'EVAL-20': {
    tier: 3,
    desc: 'Reply-All to Rachel Green\'s "Team Lunch Friday" email and include a personal note',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const original = (snapshot.emails || []).find(e =>
        e.from && e.from.email === 'rachel.green@contoso.com' &&
        e.subject && e.subject.includes('Team Lunch')
      );
      if (!original) return fail('Cannot find Team Lunch email from Rachel Green.');
      const allReplyAlls = events.filter(e =>
        e.type === 'email_sent' &&
        e.mode === 'reply-all' &&
        e.replyToId === original.id
      );
      if (allReplyAlls.length === 0) {
        // Check if they replied but with wrong mode
        const wrongMode = events.filter(e =>
          e.type === 'email_sent' && e.replyToId === original.id && e.mode !== 'reply-all'
        );
        const wrongNote = wrongMode.length ? ` Found ${wrongMode.length} reply/replies with mode "${wrongMode[0].mode}" instead of reply-all.` : '';
        return fail(`No email_sent event with mode="reply-all" replying to the Team Lunch email.${wrongNote}`);
      }

      // Find the best attempt — the last one that has multiple recipients
      const validReplyAll = allReplyAlls.find(ev => {
        const sent = (snapshot.emails || []).find(e => e.id === ev.emailId);
        if (!sent) return false;
        const recipientCount = ((sent.to || []).length + (sent.cc || []).length);
        const bodyText = normalizeText(sent.body);
        // Require non-trivial personal note text in addition to reply-all recipient set.
        const hasPersonalNote = bodyText.length >= 25 && /\b(i|i'm|i'll|my|me|we|our|us)\b/i.test(bodyText);
        return recipientCount >= 2 && hasPersonalNote;
      });
      const wrongNote = allReplyAlls.length > 1 ? ` (${allReplyAlls.length} reply-all attempts total)` : '';

      if (!validReplyAll) {
        const lastEv = allReplyAlls[allReplyAlls.length - 1];
        const lastEmail = (snapshot.emails || []).find(e => e.id === lastEv.emailId);
        const count = lastEmail ? (lastEmail.to||[]).length + (lastEmail.cc||[]).length : 0;
        const bodyPreview = lastEmail ? normalizeText(lastEmail.body).slice(0, 100) : '';
        return fail(`Reply-All requirement not met. Need at least 2 recipients and a personal note. Last attempt had ${count} recipient(s), body preview: "${bodyPreview}".`);
      }
      const sentEmail = (snapshot.emails || []).find(e => e.id === validReplyAll.emailId);
      const totalRecipients = (sentEmail.to || []).length + (sentEmail.cc || []).length;
      return pass(`Reply-All sent to ${totalRecipients} recipients for "${original.subject}".${wrongNote} Event logged at ${validReplyAll.ts}.`);
    },
  },

  'EVAL-21': {
    tier: 3,
    desc: 'Create a custom folder named "Review", then move all emails from Priya Sharma (Code Review and Accessibility Audit) into it',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folderEv = events.find(e =>
        e.type === 'folder_created' &&
        e.name && e.name.toLowerCase() === 'review'
      );
      if (!folderEv) return fail('No folder_created event with name "Review" found.');

      // Resolve the dynamic folder ID from multiple sources
      const reviewFolder = (snapshot.folders || []).find(f => f.name && f.name.toLowerCase() === 'review');
      const reviewFolderIds = new Set();
      if (folderEv.folderId) reviewFolderIds.add(folderEv.folderId);
      if (reviewFolder && reviewFolder.id) reviewFolderIds.add(reviewFolder.id);

      function isReviewFolder(folderId) {
        if (!folderId) return false;
        if (folderId.toLowerCase() === 'review') return true;
        return reviewFolderIds.has(folderId);
      }

      const priyaEmails = (snapshot.emails || []).filter(e =>
        e.from && e.from.email === 'priya.sharma@contoso.com'
      );
      if (priyaEmails.length < 2) return fail(`Expected at least 2 emails from Priya Sharma, found ${priyaEmails.length}.`);

      const issues = [];
      const notes = [];
      for (const email of priyaEmails) {
        // Get all move events for this email after folder was created
        const moveEvs = events.filter(e =>
          e.type === 'email_moved' &&
          e.emailId === email.id &&
          new Date(e.ts).getTime() >= new Date(folderEv.ts).getTime()
        );
        if (moveEvs.length === 0) {
          issues.push(`No move event for "${email.subject}".`);
          continue;
        }
        // Check if any move landed it in the Review folder
        const correctMove = moveEvs.find(e => isReviewFolder(e.to));
        const wrongMoves = moveEvs.filter(e => e !== correctMove);
        if (wrongMoves.length) notes.push(`"${email.subject}" was also moved to: ${wrongMoves.map(e=>`"${e.to}"`).join(', ')}`);
        if (!correctMove) {
          const lastDest = moveEvs[moveEvs.length - 1].to;
          issues.push(`"${email.subject}" was never moved to Review (last destination: "${lastDest}").`);
          continue;
        }
        // Check final folder state
        if (!isReviewFolder(email.folder)) {
          issues.push(`"${email.subject}" is currently in folder "${email.folder}", expected Review folder.`);
        }
      }
      if (issues.length > 0) return fail(issues.join(' ') + (notes.length ? ' Note: ' + notes.join('; ') : ''));
      const noteStr = notes.length ? ` (Note: ${notes.join('; ')})` : '';
      return pass(`Folder "Review" created and all ${priyaEmails.length} Priya Sharma emails moved into it.${noteStr}`);
    },
  },

  'EVAL-22': {
    tier: 3,
    desc: 'Switch to Calendar view, create a new event titled "Team Sync" on any date, and save it',
    verify(snapshot) {
      if (!snapshot) return fail('No snapshot found.');
      const calEvents = snapshot.calendarEvents || [];
      const event = calEvents.find(e =>
        e.title && e.title.toLowerCase().includes('team sync')
      );
      if (!event) return fail('No calendar event with title "Team Sync" found in snapshot.');
      return pass(`Calendar event "${event.title}" found on ${event.date} (${event.startTime}–${event.endTime}).`);
    },
  },

  'EVAL-23': {
    tier: 3,
    desc: 'Open the Junk folder, permanently delete one junk email (delete it twice), then verify it is gone',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folderEv = events.find(e => e.type === 'folder_selected' && e.folder === 'junk');
      if (!folderEv) return fail('No folder_selected event for Junk folder found.');

      // A permanent delete means the email was deleted once (moved to deleted) then deleted again.
      // The second delete event will have permanent: true.
      const permDeleteEv = events.find(e =>
        e.type === 'email_deleted' &&
        e.permanent === true &&
        new Date(e.ts).getTime() >= new Date(folderEv.ts).getTime()
      );
      // Alternatively: the junk email won't appear in snapshot at all after permanent delete,
      // or it may have been soft-deleted first.
      const junkSenders = ['winner@prizenotify.net', 'noreply@meetdevs-dating.biz', 'delivery@fedex-customs-fees.net'];
      const junkDeleteEv = events.find(e =>
        e.type === 'email_deleted' &&
        new Date(e.ts).getTime() >= new Date(folderEv.ts).getTime() &&
        (
          permDeleteEv ||
          junkSenders.some(() => {
            const em = (snapshot.emails || []).find(em2 => em2.id === e.emailId);
            return em && em.from && junkSenders.includes(em.from.email);
          })
        )
      );

      if (!junkDeleteEv) return fail('Junk folder was opened but no email was deleted from it.');

      // Verify: the email no longer exists in the snapshot (permanently deleted)
      const stillInSnapshot = (snapshot.emails || []).find(e =>
        e.id === junkDeleteEv.emailId && (e.folder === 'junk' || e.folder === 'deleted')
      );
      if (stillInSnapshot && stillInSnapshot.folder !== 'deleted') {
        return fail(`Junk email still appears in folder "${stillInSnapshot.folder}". It should be permanently deleted.`);
      }
      return pass(`Junk folder visited and a junk email was deleted. Event logged at ${junkDeleteEv.ts}.`);
    },
  },

  // ─── TIER 3 — CALENDAR TASKS ─────────────────────────────────────────────

  'EVAL-24': {
    tier: 3,
    desc: 'Switch to Calendar, find the Sprint Demo event (this week or next week), and decline it',
    verify(snapshot, events) {
      // Check via event log that rsvp was changed to declined
      const rsvpEv = events.find(e =>
        e.type === 'event_rsvp_changed' &&
        e.eventId === 'event-023' &&
        e.rsvp === 'declined'
      );
      if (rsvpEv) {
        return pass(`Declined "Sprint Demo" (event-023). RSVP event logged at ${rsvpEv.ts}.`);
      }

      // Fallback: check snapshot
      const calEvents = snapshot ? (snapshot.calendarEvents || []) : [];
      const sprintDemo = calEvents.find(e => e.id === 'event-023');
      if (!sprintDemo) return fail('No event_rsvp_changed event for Sprint Demo (event-023) found, and event missing from snapshot.');
      if (sprintDemo.rsvp !== 'declined') {
        return fail(`The Sprint Demo event RSVP is "${sprintDemo.rsvp}", not "declined". Open the event and click Decline.`);
      }
      return pass(`"Sprint Demo" (event-023) declined. RSVP is now "declined" in snapshot.`);
    },
  },

  'EVAL-25': {
    tier: 3,
    desc: 'Compose a weekly team update synthesizing accessibility, experiment, and dependency audit findings',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allSent = events.filter(e =>
        e.type === 'email_sent' &&
        e.replyToId === null &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('sarah.mitchell@contoso.com'))
      );
      const bestAttempt = selectBestCandidate(allSent, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const subject = String(sent?.subject || '').toLowerCase();
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          subject.includes('weekly team update'),
          body.includes('23') && body.includes('4') && body.includes('critical'),
          (body.includes('20.8') || (body.includes('14.5') && body.includes('12.0'))) && (body.includes('43,200') || body.includes('43200') || body.includes('43.2k')),
          body.includes('jsonwebtoken') && body.includes('cve-2025-12001'),
        ];
      });
      const bestEmail = bestAttempt ? getEmail(snapshot, bestAttempt.candidate.emailId) : null;
      const bestSubject = String(bestEmail?.subject || '');
      const bestBody = normalizeText(bestEmail?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Sent a new email to Sarah Mitchell with subject "Weekly Team Update"',
          allSent.length > 0 && bestAttempt && bestAttempt.checks[0],
          allSent.length === 0
            ? 'No new email to sarah.mitchell@contoso.com was sent.'
            : `A draft/send attempt to Sarah exists, but the subject was "${bestSubject}" instead of "Weekly Team Update".`
        ),
        createCheck(
          'Included the accessibility audit findings (23 issues, 4 Critical)',
          bestAttempt && bestAttempt.checks[1],
          `The best email to Sarah is missing the accessibility audit counts. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Included the CKO-42 conversion lift and revenue impact',
          bestAttempt && bestAttempt.checks[2],
          `The best email to Sarah is missing the CKO-42 lift and revenue impact. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Included the dependency audit package and CVE',
          bestAttempt && bestAttempt.checks[3],
          `The best email to Sarah is missing the jsonwebtoken / CVE-2025-12001 detail. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], 'Weekly team update email sent to Sarah with accessibility, experiment, and dependency audit findings.');
    },
  },

  'EVAL-26': {
    tier: 3,
    desc: 'Switch to Calendar, open the "Board Meeting" on this Thursday, rename it to "Board Meeting - Rescheduled" and change the time to 2:00 PM–3:00 PM',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const editEv = events.find(e =>
        e.type === 'cal_event_edited' &&
        e.eventId === 'event-021'
      );

      const calEvents = snapshot.calendarEvents || [];
      const boardMeeting = calEvents.find(e => e.id === 'event-021');

      const title = boardMeeting ? boardMeeting.title : (editEv?.title || '');
      const startTime = boardMeeting ? boardMeeting.startTime : (editEv ? editEv.startTime : null);
      const endTime = boardMeeting ? boardMeeting.endTime : (editEv ? editEv.endTime : null);

      return finalizeChecks([
        createCheck(
          'Edited the Board Meeting event',
          Boolean(editEv || boardMeeting),
          'Board Meeting (event-021) could not be found in the snapshot and no calendar edit event was recorded.'
        ),
        createCheck(
          'Renamed the event to include "Rescheduled"',
          String(title || '').toLowerCase().includes('rescheduled'),
          `Board Meeting title is "${title}". It should include "Rescheduled".`
        ),
        createCheck(
          'Moved the event to 2:00 PM - 3:00 PM',
          startTime === '14:00' && endTime === '15:00',
          `Board Meeting time is ${startTime || 'unknown'}-${endTime || 'unknown'}, not 14:00-15:00.`
        ),
      ], `Board Meeting updated to "${title}" at ${startTime}-${endTime}.${editEv ? ` Event logged at ${editEv.ts}.` : ''}`);
    },
  },

  // ─── TIER 3 — VIEW / ZOOM / DENSITY TASKS ────────────────────────────────

  'EVAL-27': {
    tier: 3,
    desc: 'Zoom in (View tab), reset zoom to 100%, then change density to Compact and back to Cosy',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const repliesTo052 = events.filter(e => e.type === 'email_sent' && e.replyToId === 'email-052');
      const best052 = selectBestCandidate(repliesTo052, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('4') && (body.includes('critical') || body.includes('prioritize')),
          body.includes('sprint') || body.includes('next'),
        ];
      });

      const repliesTo058 = events.filter(e => e.type === 'email_sent' && e.replyToId === 'email-058');
      const best058 = selectBestCandidate(repliesTo058, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('webhook'),
          body.includes('sso') || body.includes('saml'),
        ];
      });

      const body052 = normalizeText(getEmail(snapshot, best052?.candidate?.emailId)?.body).toLowerCase();
      const body058 = normalizeText(getEmail(snapshot, best058?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Replied to Priya\'s accessibility audit with the 4 Critical issues and next-sprint priority',
          repliesTo052.length > 0 && best052 && best052.checks[0] && best052.checks[1],
          repliesTo052.length === 0
            ? 'No reply to Priya\'s accessibility audit (email-052) was sent.'
            : `The accessibility reply is missing either the 4 Critical reference or the next-sprint priority. Preview: "${body052.slice(0, 120)}".`
        ),
        createCheck(
          'Replied to Nina\'s research summary with webhook setup and SSO/SAML as top priorities',
          repliesTo058.length > 0 && best058 && best058.checks[0] && best058.checks[1],
          repliesTo058.length === 0
            ? 'No reply to Nina\'s user research summary (email-058) was sent.'
            : `The research reply is missing webhook and/or SSO/SAML priority language. Preview: "${body058.slice(0, 120)}".`
        ),
      ], 'Both replies sent: accessibility audit (4 Critical -> sprint) and user research (webhook + SSO priorities).');
    },
  },

  // ─── TIER 3 — ORGANIZE & TRIAGE TASK ────────────────────────────────────

  'EVAL-29': {
    tier: 3,
    desc: 'Create a "Reports" folder, move all report emails into it, then flag only the ones with personal action items',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const folderEv = events.find(e =>
        e.type === 'folder_created' && e.name && e.name.toLowerCase() === 'reports'
      );

      const reportIds = ['email-053', 'email-054', 'email-055', 'email-059', 'email-060', 'email-061'];

      const reportsFolderObj = (snapshot.folders || []).find(f => f.name && f.name.toLowerCase() === 'reports');
      const reportsFolderId = reportsFolderObj ? reportsFolderObj.id : null;

      const notInReports = [];
      for (const id of reportIds) {
        const snap = (snapshot.emails || []).find(e => e.id === id);
        if (!snap) { notInReports.push(`${id} (missing from snapshot)`); continue; }
        if (!reportsFolderId || snap.folder !== reportsFolderId) notInReports.push(`${id} ("${snap.subject}" in "${snap.folder}")`);
      }
      const shouldFlag = ['email-059', 'email-060', 'email-061'];
      const shouldNotFlag = ['email-053', 'email-054', 'email-055'];

      // Check flagged state from db.json (server-side truth) with snapshot as fallback
      const db = loadDb();
      const dbEmails = db ? db.emails : null;

      const notFlagged = [];
      for (const id of shouldFlag) {
        const email = (dbEmails || []).find(e => e.id === id) || (snapshot.emails || []).find(e => e.id === id);
        if (!email) continue;
        if (!email.flagged) notFlagged.push(`${id} ("${email.subject}")`);
      }

      const wronglyFlagged = [];
      for (const id of shouldNotFlag) {
        const email = (dbEmails || []).find(e => e.id === id) || (snapshot.emails || []).find(e => e.id === id);
        if (!email) continue;
        if (email.flagged) wronglyFlagged.push(`${id} ("${email.subject}")`);
      }

      return finalizeChecks([
        createCheck(
          'Created the Reports folder',
          Boolean(folderEv && reportsFolderId),
          'No folder_created event with name "Reports" was found.'
        ),
        createCheck(
          'Moved every report email into Reports',
          notInReports.length === 0,
          `These report emails are not in Reports: ${notInReports.join(', ')}.`
        ),
        createCheck(
          'Flagged the report emails with personal action items',
          notFlagged.length === 0,
          `These action-item reports are not flagged: ${notFlagged.join(', ')}.`
        ),
        createCheck(
          'Left the informational reports unflagged',
          wronglyFlagged.length === 0,
          `These informational reports were incorrectly flagged: ${wronglyFlagged.join(', ')}.`
        ),
      ], `Reports folder created, ${reportIds.length} reports moved in, ${shouldFlag.length} action-item reports flagged. Informational reports not flagged.`);
    },
  },

  // ─── TIER 3 — DIFFICULT TASKS (EVAL-30 through EVAL-39) ────────────────

  'EVAL-30': {
    tier: 3,
    desc: 'Reply to the A/B test results email (email-054) summarizing conversion lift and revenue impact',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allReplies = events.filter(e =>
        e.type === 'email_sent' && e.replyToId === 'email-054'
      );
      if (allReplies.length === 0) return fail('No email_sent event found replying to the A/B Test Results email (email-054).');

      // Must mention: conversion rate lift (+20.8% or "20.8"), and revenue impact ($43,200 or "43,200" or "43200")
      const bestReply = selectBestCandidate(allReplies, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('20.8') || (body.includes('14.5') && body.includes('12.0')),
          body.includes('43,200') || body.includes('43200') || body.includes('43.2k'),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestReply?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Replied to the CKO-42 A/B test results email',
          allReplies.length > 0,
          'No reply was sent for the CKO-42 A/B test results email (email-054).'
        ),
        createCheck(
          'Included the conversion lift percentage',
          bestReply && bestReply.checks[0],
          `The best reply is missing the conversion lift. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Included the estimated monthly revenue impact',
          bestReply && bestReply.checks[1],
          `The best reply is missing the monthly revenue impact. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `Reply to A/B test results correctly mentions conversion lift and revenue impact. Event logged at ${bestReply?.candidate?.ts || bestReply?.candidate?.timestamp || 'unknown time'}.`);
    },
  },

  'EVAL-31': {
    tier: 3,
    desc: 'Flag the Azure billing email and leave it in Inbox, then archive every other external inbox email',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const seedDb = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'db_initial.json'), 'utf8')); } catch (err) { return null; }
      })();
      if (!seedDb) return fail('Cannot read db_initial.json for seed data.');

      const azureSnap = (snapshot.emails || []).find(e => e.id === 'email-014');
      const azureFlagged = azureSnap?.flagged;
      const azureFolder = azureSnap?.folder;
      const otherExternalInbox = (seedDb.emails || []).filter(e =>
        e.id !== 'email-014' && e.isExternal === true && e.folder === 'inbox'
      );

      const notArchived = [];
      for (const seed of otherExternalInbox) {
        const snap = (snapshot.emails || []).find(e => e.id === seed.id);
        if (!snap) { notArchived.push(`${seed.id} (missing)`); continue; }
        if (snap.folder !== 'archive') notArchived.push(`${seed.id} ("${seed.subject}" in "${snap.folder}")`);
      }

      const internalInbox = (seedDb.emails || []).filter(e =>
        e.isExternal === false && e.folder === 'inbox'
      );
      const wronglyMoved = [];
      for (const seed of internalInbox) {
        const snap = (snapshot.emails || []).find(e => e.id === seed.id);
        if (snap && snap.folder === 'archive') wronglyMoved.push(`${seed.id} ("${seed.subject}")`);
      }

      return finalizeChecks([
        createCheck(
          'Flagged the Azure billing invoice and left it in Inbox',
          Boolean(azureFlagged) && azureFolder === 'inbox',
          !azureSnap
            ? 'Azure billing email (email-014) is missing from the snapshot.'
            : !azureFlagged
              ? 'Azure billing email (email-014) is not flagged.'
              : `Azure billing email (email-014) should remain in Inbox, found it in "${azureFolder}".`
        ),
        createCheck(
          'Archived every other external inbox email',
          otherExternalInbox.length > 0 && notArchived.length === 0,
          notArchived.length === 0 ? 'No other external inbox emails were found in the seed data.' : `These external emails were not archived: ${notArchived.join(', ')}.`
        ),
        createCheck(
          'Left internal inbox emails out of Archive',
          wronglyMoved.length === 0,
          `These internal emails were incorrectly archived: ${wronglyMoved.join(', ')}.`
        ),
      ], `Azure billing stayed flagged in Inbox. All ${otherExternalInbox.length} other external emails archived. Internal emails untouched.`);
    },
  },

  'EVAL-32': {
    tier: 3,
    desc: 'Reply to the SLA Report (email-055) mentioning the breached services and their uptime percentages',
    // PASS test case: email_sent event replying to email-055, body contains "api gateway", "web application", "99.91", and "99.72" (the two breached services and their actual uptimes).
    // FAIL test case: Reply missing, or body does not mention both breached services or their exact uptime percentages.
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allReplies = events.filter(e =>
        e.type === 'email_sent' && e.replyToId === 'email-055'
      );
      const bestReply = selectBestCandidate(allReplies, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('api gateway') && body.includes('99.91'),
          body.includes('web application') && body.includes('99.72'),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestReply?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Replied to the SLA report',
          allReplies.length > 0,
          'No reply was sent for the SLA Report (email-055).'
        ),
        createCheck(
          'Included API Gateway at 99.91%',
          bestReply && bestReply.checks[0],
          `The best SLA reply is missing API Gateway at 99.91%. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Included Web Application at 99.72%',
          bestReply && bestReply.checks[1],
          `The best SLA reply is missing Web Application at 99.72%. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `Reply to SLA Report correctly mentions both breached services (API Gateway 99.91%, Web Application 99.72%). Event logged at ${bestReply?.candidate?.ts || 'unknown time'}.`);
    },
  },

  'EVAL-33': {
    tier: 3,
    desc: 'Forward the Dependency Audit (email-061) to marcus.thompson@contoso.com with critical CVE info',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allForwards = events.filter(e =>
        e.type === 'email_sent' &&
        e.mode === 'forward' &&
        e.replyToId === 'email-061' &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('marcus.thompson@contoso.com'))
      );
      const bestForward = selectBestCandidate(allForwards, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('jsonwebtoken'),
          body.includes('cve-2025-12001'),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestForward?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Forwarded Priya\'s dependency audit to Marcus Thompson',
          allForwards.length > 0,
          'No forward based on the Dependency Audit (email-061) was sent to marcus.thompson@contoso.com.'
        ),
        createCheck(
          'Mentioned the affected package: jsonwebtoken',
          bestForward && bestForward.checks[0],
          `The best forward to Marcus is missing "jsonwebtoken". Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Mentioned the CVE: CVE-2025-12001',
          bestForward && bestForward.checks[1],
          `The best forward to Marcus is missing CVE-2025-12001. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `Dependency Audit forwarded to marcus.thompson with jsonwebtoken and CVE-2025-12001 details. Event logged at ${bestForward?.candidate?.ts || 'unknown time'}.`);
    },
  },

  'EVAL-34': {
    tier: 3,
    desc: 'Forward user research summary (email-058) to priya.sharma highlighting Critical-severity onboarding tasks',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allForwards = events.filter(e =>
        e.type === 'email_sent' &&
        e.mode === 'forward' &&
        e.replyToId === 'email-058' &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('priya.sharma@contoso.com'))
      );
      const bestForward = selectBestCandidate(allForwards, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('webhook') && (body.includes('41') || body.includes('41%')),
          (body.includes('sso') || body.includes('saml')) && (body.includes('33') || body.includes('33%')),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestForward?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Forwarded Nina\'s user research summary to Priya Sharma',
          allForwards.length > 0,
          'No forward based on the user research summary (email-058) was sent to priya.sharma@contoso.com.'
        ),
        createCheck(
          'Highlighted webhook setup with its 41% success rate',
          bestForward && bestForward.checks[0],
          `The best forward to Priya is missing webhook setup with the 41% rate. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Highlighted SSO/SAML with its 33% success rate',
          bestForward && bestForward.checks[1],
          `The best forward to Priya is missing SSO/SAML with the 33% rate. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `Research summary forwarded to Priya with webhook (41%) and SSO/SAML (33%) highlighted. Event logged at ${bestForward?.candidate?.ts || 'unknown time'}.`);
    },
  },

  'EVAL-35': {
    tier: 3,
    desc: 'Decline all tentative calendar events, decline the upcoming Sprint Planning, and email Marcus Chen about the conflict',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const tentativeEventIds = [
        { id: 'event-008', title: 'Sprint Planning' },
        { id: 'event-019', title: 'Product Demo Prep' },
        { id: 'event-029', title: 'Happy Hour' },
        { id: 'event-046', title: 'Metrics Deep Dive: Platform Performance' },
      ];

      // The upcoming Sprint Planning (event-040) must also be declined
      const mustDecline = [
        ...tentativeEventIds,
        { id: 'event-040', title: 'Sprint Planning (upcoming)' },
      ];

      const calEvents = snapshot.calendarEvents || [];

      const notDeclined = [];
      for (const seed of mustDecline) {
        const rsvpEv = events.find(e =>
          e.type === 'event_rsvp_changed' &&
          e.eventId === seed.id &&
          e.rsvp === 'declined'
        );
        if (rsvpEv) continue;

        const snap = calEvents.find(e => e.id === seed.id);
        if (snap && snap.rsvp === 'declined') continue;

        const currentRsvp = snap ? snap.rsvp : 'unknown';
        notDeclined.push(`${seed.id} ("${seed.title}" rsvp="${currentRsvp}")`);
      }

      const mustDeclineIds = new Set(mustDecline.map(e => e.id));
      const wronglyChanged = [];
      for (const ev of calEvents) {
        if (mustDeclineIds.has(ev.id)) continue;
        const rsvpEv = events.find(e =>
          e.type === 'event_rsvp_changed' &&
          e.eventId === ev.id &&
          e.rsvp === 'declined'
        );
        if (rsvpEv) wronglyChanged.push(`${ev.id} ("${ev.title}" changed to "declined")`);
      }

      const emailToMarcus = events.filter(e =>
        e.type === 'email_sent' &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('marcus.chen@contoso.com'))
      );
      const bestMarcusEmail = selectBestCandidate(emailToMarcus, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('conflict') || body.includes("can't make") || body.includes('unable') || body.includes('won\'t be able'),
          body.includes('sprint') || body.includes('planning'),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestMarcusEmail?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Declined all four tentative events plus the upcoming Sprint Planning',
          notDeclined.length === 0,
          `These events were not declined: ${notDeclined.join(', ')}.`
        ),
        createCheck(
          'Left other accepted events untouched',
          wronglyChanged.length === 0,
          `These non-target events were incorrectly changed: ${wronglyChanged.join(', ')}.`
        ),
        createCheck(
          'Emailed Marcus Chen about the Sprint Planning conflict',
          emailToMarcus.length > 0 && bestMarcusEmail && bestMarcusEmail.checks[0] && bestMarcusEmail.checks[1],
          emailToMarcus.length === 0
            ? 'No email was sent to marcus.chen@contoso.com about the Sprint Planning conflict.'
            : `The best email to Marcus is missing either the conflict explanation or the Sprint Planning reference. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `All ${tentativeEventIds.length} tentative events declined, upcoming Sprint Planning declined, and email to Marcus about conflict sent.`);
    },
  },

  'EVAL-36': {
    tier: 3,
    desc: 'Forward platform metrics email (email-053) to marcus.thompson with the top error endpoint and its rate',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const allForwards = events.filter(e =>
        e.type === 'email_sent' &&
        e.mode === 'forward' &&
        e.replyToId === 'email-053' &&
        Array.isArray(e.to) && e.to.some(addr => addr.includes('marcus.thompson@contoso.com'))
      );
      const bestForward = selectBestCandidate(allForwards, ev => {
        const sent = getEmail(snapshot, ev.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('charges') || body.includes('/api/v2/charges'),
          body.includes('2.14'),
        ];
      });
      const bestBody = normalizeText(getEmail(snapshot, bestForward?.candidate?.emailId)?.body).toLowerCase();

      return finalizeChecks([
        createCheck(
          'Forwarded the weekly platform metrics email to Marcus Thompson',
          allForwards.length > 0,
          'No forward based on the weekly platform metrics email (email-053) was sent to marcus.thompson@contoso.com.'
        ),
        createCheck(
          'Mentioned the /charges endpoint as the highest-error endpoint',
          bestForward && bestForward.checks[0],
          `The best metrics forward is missing the /charges endpoint. Preview: "${bestBody.slice(0, 150)}".`
        ),
        createCheck(
          'Mentioned the 2.14% error rate',
          bestForward && bestForward.checks[1],
          `The best metrics forward is missing the 2.14% error rate. Preview: "${bestBody.slice(0, 150)}".`
        ),
      ], `Platform metrics forwarded to Marcus with charges endpoint error data. Event logged at ${bestForward?.candidate?.ts || 'unknown time'}.`);
    },
  },

  'EVAL-37': {
    tier: 3,
    desc: 'Cross-folder cleanup: permanently delete Deleted Items from earlier months AND all Junk emails, keep this month\'s deleted items',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const seedDb = loadSeedDb();
      if (!seedDb) return fail('Cannot read db_initial.json for seed data.');

      // Compute the same shift the server uses so we compare against
      // the timestamps the agent actually sees in the UI.
      const SEED_RE = /^email-\d{3}$/;
      const allSeed = (seedDb.emails || []).filter(e => SEED_RE.test(e.id));
      let maxSeedTs = seedDb.anchor ? new Date(seedDb.anchor).getTime() : 0;
      for (const e of allSeed) {
        const t = new Date(e.timestamp).getTime();
        if (t > maxSeedTs) maxSeedTs = t;
      }
      const shiftMs = Date.now() - maxSeedTs;

      function shiftedMonth(ts) {
        const d = new Date(new Date(ts).getTime() + shiftMs);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const deletedEmails = (seedDb.emails || []).filter(email => email.folder === 'deleted');
      const junkEmails = (seedDb.emails || []).filter(email => email.folder === 'junk');

      const recentDeleted = deletedEmails.filter(email => shiftedMonth(email.timestamp) === currentMonth);
      const oldDeleted = deletedEmails.filter(email => shiftedMonth(email.timestamp) !== currentMonth);

      const missingPermanentDeletes = [];
      for (const email of [...oldDeleted, ...junkEmails]) {
        const deleted = events.find(event => event.type === 'email_deleted' && event.emailId === email.id);
        if (!deleted) missingPermanentDeletes.push(`${email.id} ("${email.subject}")`);
      }

      const wronglyRemovedRecent = [];
      for (const email of recentDeleted) {
        const deleted = events.find(event => event.type === 'email_deleted' && event.emailId === email.id);
        if (deleted) wronglyRemovedRecent.push(`${email.id} ("${email.subject}")`);
      }

      const oldDeletedMissing = missingPermanentDeletes.filter(item => oldDeleted.some(email => item.startsWith(email.id)));
      const junkMissing = missingPermanentDeletes.filter(item => junkEmails.some(email => item.startsWith(email.id)));

      return finalizeChecks([
        createCheck(
          'Permanently deleted Deleted Items from earlier months',
          oldDeletedMissing.length === 0,
          `These older Deleted Items emails were not permanently deleted: ${oldDeletedMissing.join(', ')}.`
        ),
        createCheck(
          'Permanently deleted everything in Junk',
          junkMissing.length === 0,
          `These Junk emails were not permanently deleted: ${junkMissing.join(', ')}.`
        ),
        createCheck(
          'Kept this month\'s Deleted Items emails',
          wronglyRemovedRecent.length === 0,
          `These current-month Deleted Items emails were removed even though they should be preserved: ${wronglyRemovedRecent.join(', ')}.`
        ),
      ], `Deleted ${oldDeleted.length} older Deleted Items email(s) and ${junkEmails.length} Junk email(s) while preserving ${recentDeleted.length} current-month Deleted Items email(s).`);
    },
  },

  'EVAL-38': {
    tier: 3,
    desc: 'Reply to escalation email with top customer details',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-060');
      const bestReply = selectBestCandidate(replies, event => {
        const sent = getEmail(snapshot, event.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('acme corp'),
          body.includes('$124k') || body.includes('124k') || body.includes('$124 k'),
        ];
      });
      const preview = normalizeText(getEmail(snapshot, bestReply?.candidate?.emailId)?.body).slice(0, 160);

      return finalizeChecks([
        createCheck(
          'Replied to Jordan Lee\'s escalation report',
          replies.length > 0,
          'No reply was sent for Jordan Lee\'s escalation report (email-060).'
        ),
        createCheck(
          'Mentioned Acme Corp by name',
          bestReply && bestReply.checks[0],
          `The best escalation reply is missing Acme Corp. Preview: "${preview}".`
        ),
        createCheck(
          'Mentioned the $124K ARR',
          bestReply && bestReply.checks[1],
          `The best escalation reply is missing the $124K ARR figure. Preview: "${preview}".`
        ),
      ], 'Reply to the escalation report mentions Acme Corp and $124K ARR.');
    },
  },

  'EVAL-39': {
    tier: 3,
    desc: 'Reply to DB performance report confirming action items',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-059');
      const bestReply = selectBestCandidate(replies, event => {
        const sent = getEmail(snapshot, event.emailId);
        const body = normalizeText(sent?.body).toLowerCase();
        return [
          body.includes('orders') && body.includes('142'),
          body.includes('4 month'),
        ];
      });
      const preview = normalizeText(getEmail(snapshot, bestReply?.candidate?.emailId)?.body).slice(0, 160);

      return finalizeChecks([
        createCheck(
          'Replied to Daniel Lee\'s database performance report',
          replies.length > 0,
          'No reply was sent for Daniel Lee\'s database performance report (email-059).'
        ),
        createCheck(
          'Mentioned the orders table at 142 GB',
          bestReply && bestReply.checks[0],
          `The best database-performance reply is missing the orders table / 142 GB fact. Preview: "${preview}".`
        ),
        createCheck(
          'Mentioned the roughly 4 month performance timeline',
          bestReply && bestReply.checks[1],
          `The best database-performance reply is missing the 4 month timeline. Preview: "${preview}".`
        ),
      ], 'Reply to the DB performance report mentions the orders table, 142 GB, and the performance timeline.');
    },
  },

  'EVAL-40': {
    tier: 3,
    desc: 'Build a launch risk review packet across mail and calendar',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folder = getFolderByName(snapshot, 'Launch Risks');

      const requiredEmails = ['email-053', 'email-055', 'email-060', 'email-061'];
      const wrongFolder = requiredEmails.filter(id => {
        const email = getEmail(snapshot, id);
        return !email || !folder || email.folder !== folder.id;
      });

      const mustBeFlagged = ['email-055', 'email-060', 'email-061'];
      const missingFlags = mustBeFlagged.filter(id => {
        const dbE = getDbEmail(id);
        const email = dbE || getEmail(snapshot, id);
        return !email || !email.flagged;
      });

      const metricsDbEmail = getDbEmail('email-053');
      const metricsEmail = metricsDbEmail || getEmail(snapshot, 'email-053');

      const slaReview = getCalendarEvent(snapshot, 'event-051');

      const createdEvent = (snapshot.calendarEvents || []).find(event =>
        event.title === 'Launch Risk Review' &&
        event.date === slaReview?.date &&
        event.startTime === '14:00' &&
        event.endTime === '15:00'
      );

      const attendees = new Set(createdEvent?.attendees || []);
      const missingAttendees = ['tom.nguyen@contoso.com', 'jordan.lee@contoso.com', 'priya.patel@contoso.com'].filter(email => !attendees.has(email));

      const notes = normalizeText(createdEvent?.notes).toLowerCase();
      const noteChecks = [
        ['api gateway', '99.91'],
        ['web application', '99.72'],
        ['charges', '2.14'],
        ['acme', '124'],
        ['jsonwebtoken', 'cve-2025-12001'],
      ];
      const missingNoteFacts = noteChecks.filter(pair => !pair.every(part => notes.includes(part))).map(pair => pair.join(' + '));

      const folderCreated = events.find(event => event.type === 'folder_created' && String(event.name).toLowerCase() === 'launch risks');
      const movedCount = events.filter(event => event.type === 'email_moved' && event.to === folder.id && requiredEmails.includes(event.emailId)).length;

      return finalizeChecks([
        createCheck(
          'Created the Launch Risks folder and moved the four required emails into it',
          Boolean(folder && folderCreated) && wrongFolder.length === 0 && movedCount >= requiredEmails.length,
          !folder || !folderCreated
            ? 'Launch Risks folder was not created with a matching folder_created event.'
            : wrongFolder.length > 0
              ? `These emails are not in Launch Risks: ${wrongFolder.join(', ')}.`
              : `Expected ${requiredEmails.length} move events into Launch Risks, found ${movedCount}.`
        ),
        createCheck(
          'Flagged the action-item emails and left the platform metrics report unflagged',
          missingFlags.length === 0 && Boolean(metricsEmail) && !metricsEmail.flagged,
          missingFlags.length > 0
            ? `These launch-risk emails are not flagged: ${missingFlags.join(', ')}.`
            : 'The platform metrics report (email-053) should be in Launch Risks but remain unflagged.'
        ),
        createCheck(
          'Scheduled Launch Risk Review for 2:00 PM - 3:00 PM with Tom, Jordan, and Priya',
          Boolean(slaReview) && Boolean(createdEvent) && missingAttendees.length === 0,
          !slaReview
            ? 'Could not find the reference SLA review event (event-051).'
            : !createdEvent
            ? 'Launch Risk Review was not scheduled on the SLA review day from 2:00 PM to 3:00 PM.'
            : `Launch Risk Review is missing attendees: ${missingAttendees.join(', ')}.`
        ),
        createCheck(
          'Captured the SLA, /charges, Acme, and CVE facts in the meeting notes',
          missingNoteFacts.length === 0,
          `Launch Risk Review notes are missing: ${missingNoteFacts.join(', ')}.`
        ),
      ], 'Launch Risks folder, email triage, and Launch Risk Review calendar event all match the required risk packet.');
    },
  },

  'EVAL-41': {
    tier: 3,
    desc: 'Download, pin, and categorize the onboarding evidence before writing Sarah',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const research = getEmail(snapshot, 'email-058');
      const revenue = getEmail(snapshot, 'email-056');

      const researchDownload = events.find(event =>
        event.type === 'attachment_downloaded' &&
        event.emailId === 'email-058' &&
        event.filename === 'Enterprise_Onboarding_Research_Report.pdf'
      );

      const sentToSarah = events.filter(event =>
        event.type === 'email_sent' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('sarah.mitchell@contoso.com'))
      );

      const correctEmail = sentToSarah.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('webhook') &&
          (body.includes('sso') || body.includes('saml')) &&
          body.includes('14') &&
          notesContainAny(body, ['187k', '$187k', '187,000', '187000']);
      });

      return finalizeChecks([
        createCheck(
          'Downloaded the research PDF',
          Boolean(researchDownload),
          'The Enterprise_Onboarding_Research_Report.pdf attachment was not downloaded from Nina Ross\'s research email.'
        ),
        createCheck(
          'Pinned Nina\'s research email and applied a purple category to Sarah\'s revenue dashboard',
          Boolean(research?.pinned) && revenue?.category === 'purple',
          !research?.pinned
            ? 'Nina Ross\'s onboarding research email (email-058) should be pinned.'
            : `Sarah Mitchell\'s revenue dashboard (email-056) should have the purple category, found "${revenue?.category}".`
        ),
        createCheck(
          'Sent Sarah Mitchell the onboarding blocker summary with the churn impact',
          sentToSarah.length > 0 && Boolean(correctEmail),
          sentToSarah.length === 0
            ? 'No summary email was sent to sarah.mitchell@contoso.com.'
            : 'An email was sent to Sarah Mitchell, but it does not summarize webhook, SSO/SAML, and the churn impact facts.'
        ),
      ], 'Nina\'s research was searched and downloaded, the evidence was pinned and categorized, and Sarah received the blocker summary.');
    },
  },

  'EVAL-42': {
    tier: 3,
    desc: 'Summarize Thursday meetings for Marcus Thompson via email (with overlap-adjusted total)',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');

      const { matched: emailsToMarcus, wrongDomain: emailsWrongDomain } = filterEmailsByRecipient(events, 'marcus.thompson@contoso.com');

      const bestEmail = selectBestCandidate(emailsToMarcus, event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return [];
        const body = normalizeText(sent.body).toLowerCase();
        return [
          // Mentions Board Meeting with time
          body.includes('board') && notesContainAny(body, ['10:00', '10 am', '10am']),
          // Mentions A/B Test / experiment review with time and notes overlap
          (body.includes('a/b') || body.includes('test review') || body.includes('checkout') || body.includes('experiment')) && notesContainAny(body, ['11:00', '11 am', '11am']),
          // Mentions overlap between Board Meeting and A/B Test Review
          body.includes('overlap'),
          // Total ~4.5 hours (overlap-adjusted: 30+120+60+60=270min)
          notesContainAny(body, ['4.5 hour', '4.5h', '4 hours 30', '4h30', '4h 30', '270 min']),
        ];
      });

      const checks = [];
      if (bestEmail) {
        checks.push(createCheck('Mentions Board Meeting at 10:00', bestEmail.checks[0], 'Missing Board Meeting or its 10:00 start time'));
        checks.push(createCheck('Mentions A/B Test Review at 11:00', bestEmail.checks[1], 'Missing A/B Test Review or its 11:00 start time'));
        checks.push(createCheck('Notes the overlap', bestEmail.checks[2], 'Does not mention the overlap between Board Meeting and A/B Test Review'));
        checks.push(createCheck('Total meeting time ~4.5 hours (overlap-adjusted)', bestEmail.checks[3], 'Missing or incorrect total meeting hours'));
      } else {
        checks.push(createCheck('Emailed Marcus Thompson at correct address', false,
          recipientErrorDetail('marcus.thompson@contoso.com', emailsToMarcus, emailsWrongDomain)));
      }

      return finalizeChecks(checks, 'Marcus received the Thursday meeting summary with overlap-adjusted total.');
    },
  },

  'EVAL-43': {
    tier: 3,
    desc: 'Pin and categorize Rachel\'s hiring update, then reply-all with the funnel facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const hiringEmail = getEmail(snapshot, 'email-062');

      const replies = events.filter(event =>
        event.type === 'email_sent' &&
        event.replyToId === 'email-062' &&
        event.mode === 'reply-all'
      );

      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('senior backend') &&
          (body.includes('top priority') || body.includes('priority')) &&
          body.includes('98') &&
          body.includes('3') &&
          notesContainAny(body, ['24,000', '24000', '24k']) &&
          notesContainAny(body, ['40,000', '40000', '40k']);
      });

      return finalizeChecks([
        createCheck(
          'Pinned Rachel\'s hiring update and applied a yellow category',
          Boolean(hiringEmail?.pinned) && hiringEmail?.category === 'yellow',
          !hiringEmail?.pinned
            ? 'Rachel Green\'s hiring pipeline email (email-062) should be pinned.'
            : `Rachel Green\'s hiring pipeline email (email-062) should have the yellow category, found "${hiringEmail?.category}".`
        ),
        createCheck(
          'Reply-all to Rachel prioritized Senior Backend with the applicant, onsite, and budget facts',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply-all was sent for Rachel Green\'s hiring pipeline update (email-062).'
            : 'A reply-all was sent to Rachel, but it does not prioritize Senior Backend with the 98 applicants, 3 onsite interviews, and recruiting budget facts.'
        ),
      ], 'Rachel\'s hiring update was pinned, categorized, and answered with the right reply-all.');
    },
  },

  'EVAL-44': {
    tier: 3,
    desc: 'Rework the escalation calendar review and forward the right production data',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folder = getFolderByName(snapshot, 'Enterprise Escalations');

      const missingMoves = ['email-053', 'email-060'].filter(id => {
        const email = getEmail(snapshot, id);
        return !email || !folder || email.folder !== folder.id;
      });

      const customerReview = getCalendarEvent(snapshot, 'event-038');
      const acmeCall = getCalendarEvent(snapshot, 'event-048');

      const attendees = new Set(customerReview?.attendees || []);

      const notes = normalizeText(customerReview?.notes).toLowerCase();
      const missingFacts = [
        {
          label: 'Acme + $124K ARR',
          present: notes.includes('acme') && notesContainAny(notes, ['124k', '$124k', '124 k', '124,000', '124000']),
        },
        {
          label: 'charges + 2.14',
          present: notes.includes('charges') && notesContainAny(notes, ['2.14', '2.14%']),
        },
        {
          label: 'orders + 142',
          present: notes.includes('orders') && notesContainAny(notes, ['142']),
        },
        {
          label: '4 months',
          present: notesContainAny(notes, ['4 month', '4 months', '4-month']),
        },
      ].filter(check => !check.present).map(check => check.label);

      const editEvent = events.find(event => event.type === 'cal_event_edited' && event.eventId === 'event-038');

      const forwards = events.filter(event =>
        event.type === 'email_sent' &&
        event.mode === 'forward' &&
        event.replyToId === 'email-060' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('marcus.thompson@contoso.com'))
      );

      const correctForward = forwards.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('acme') && body.includes('charges') && (body.includes('2.14') || body.includes('18,402') || body.includes('18402'));
      });

      return finalizeChecks([
        createCheck(
          'Created Enterprise Escalations and moved Jordan\'s escalation report plus the metrics report into it',
          Boolean(folder) && missingMoves.length === 0,
          !folder ? 'Folder "Enterprise Escalations" was not created.' : `These emails are not in Enterprise Escalations: ${missingMoves.join(', ')}.`
        ),
        createCheck(
          'Updated Customer Success Review into Enterprise Escalation Review and added Marcus Chen',
          Boolean(customerReview) && Boolean(acmeCall) && Boolean(editEvent) && customerReview.title === 'Enterprise Escalation Review' && customerReview.date === acmeCall.date && customerReview.startTime === '15:00' && customerReview.endTime === '16:00' && attendees.has('marcus.chen@contoso.com'),
          !customerReview || !acmeCall
            ? 'Could not find the reference escalation calendar events (event-038 and event-048).'
            : !editEvent
            ? 'No cal_event_edited event was recorded for event-038.'
            : customerReview.title !== 'Enterprise Escalation Review' || customerReview.date !== acmeCall.date || customerReview.startTime !== '15:00' || customerReview.endTime !== '16:00'
              ? 'event-038 was not updated to "Enterprise Escalation Review" on the Acme call day from 3:00 PM to 4:00 PM.'
              : 'Enterprise Escalation Review is missing Marcus Chen as an attendee.'
        ),
        createCheck(
          'Included the Acme, /charges, and DB timeline facts in the meeting notes',
          missingFacts.length === 0,
          `Enterprise Escalation Review notes are missing: ${missingFacts.join(', ')}.`
        ),
        createCheck(
          'Forwarded Jordan\'s escalation report to Marcus Thompson with the Acme and /charges data',
          forwards.length > 0 && Boolean(correctForward),
          forwards.length === 0
            ? 'No forwarded email based on Jordan\'s escalation report (email-060) was sent to marcus.thompson@contoso.com.'
            : 'An email was sent to Marcus, but it does not highlight Acme and the /charges error data.'
        ),
      ], 'Enterprise escalations were organized, the review event was repurposed correctly, and Marcus received the escalation handoff with the key production data.');
    },
  },

  'EVAL-45': {
    tier: 3,
    desc: 'Reset zoom and density, then reply to Priya with the auth blast-radius facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const zoomEvents = events.filter(event => event.type === 'zoom_changed');
      const densityEvents = events.filter(event => event.type === 'density_changed');

      const zoomInEvent = zoomEvents.find(event => Number(event.zoomLevel) > 100);
      const zoomResetEvent = zoomInEvent
        ? zoomEvents.find(event => Number(event.zoomLevel) === 100 && new Date(event.ts).getTime() > new Date(zoomInEvent.ts).getTime())
        : null;
      const compactEvent = densityEvents.find(event => event.density === 'compact');
      const cosyAfterCompact = compactEvent
        ? densityEvents.find(event => event.density === 'cosy' && new Date(event.ts).getTime() > new Date(compactEvent.ts).getTime())
        : null;

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-063');

      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return (body.includes('blast radius') || body.includes('tenant-by-tenant') || body.includes('tenant by tenant')) &&
          body.includes('sprint planning') &&
          body.includes('27') &&
          notesContainAny(body, ['14,200', '14200', '14.2k']) &&
          body.includes('3') &&
          body.includes('tenant');
      });

      return finalizeChecks([
        createCheck(
          'Zoomed in, reset to 100%, changed density to Compact, and switched back to Cosy',
          Boolean(zoomInEvent) && Boolean(zoomResetEvent) && Boolean(compactEvent) && Boolean(cosyAfterCompact) && (!zoomResetEvent || new Date(compactEvent.ts).getTime() > new Date(zoomResetEvent.ts).getTime()),
          !zoomInEvent
            ? 'No zoom_changed event increased the zoom level above 100%. '
            : !zoomResetEvent
              ? 'The zoom level was increased, but never reset to 100%. '
              : !compactEvent
                ? 'No density_changed event switched the mailbox to Compact.'
                : !cosyAfterCompact
                  ? 'The mailbox was switched to Compact, but never changed back to Cosy.'
                  : 'The density change to Compact should happen after the zoom reset to 100%.'
        ),
        createCheck(
          'Replied to Priya with the 27 minute exposure, 14,200 invalidated sessions, and 3 impacted tenants',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply was sent for Priya\'s auth incident recap (email-063).'
            : 'A reply was sent to Priya, but it does not mention sprint-planning blast-radius review with the 27 minute exposure, 14,200 invalidated sessions, and 3 tenants.'
        ),
      ], 'The mailbox view was reset and Priya received the auth blast-radius reply with the required facts.');
    },
  },

  'EVAL-46': {
    tier: 3,
    desc: 'Mark Daniel\'s DB report unread, pin and categorize Maya\'s audit, then reply with the retention facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const dbReport = getEmail(snapshot, 'email-059');
      const auditEmail = getEmail(snapshot, 'email-064');

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-064');

      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return (body.includes('remediation') || body.includes('plan')) &&
          body.includes('540') &&
          body.includes('365') &&
          notesContainAny(body, ['1,284', '1284', '1.284k']);
      });

      return finalizeChecks([
        createCheck(
          'Marked Daniel\'s database report unread and pinned Maya\'s audit with a red category',
          Boolean(dbReport) && dbReport.read === false && Boolean(auditEmail?.pinned) && auditEmail?.category === 'red',
          dbReport?.read !== false
            ? 'Daniel Lee\'s database performance report (email-059) should be marked unread.'
            : !auditEmail?.pinned
              ? 'Maya Patel\'s retention audit email (email-064) should be pinned.'
              : `Maya Patel\'s retention audit email (email-064) should have the red category, found "${auditEmail?.category}".`
        ),
        createCheck(
          'Replied to Maya Patel with the 540 day gap, 365 day policy target, and 1,284 account backlog',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply was sent for Maya Patel\'s retention audit email (email-064).'
            : 'A reply was sent to Maya, but it does not reference the 540 day gap, the 365 day policy target, and the 1,284 account backlog.'
        ),
      ], 'Daniel\'s report was left unread, Maya\'s audit stayed visible, and Maya received the remediation reply with the retention facts.');
    },
  },

  'EVAL-47': {
    tier: 3,
    desc: 'Download attachment, categorize, and forward Priya\'s dependency audit with the key vulnerability facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const auditEmail = getEmail(snapshot, 'email-061');
      const downloadEvent = events.find(event =>
        event.type === 'attachment_downloaded' &&
        event.emailId === 'email-061' &&
        event.filename === 'Dependency_Audit_Mar2026.xlsx'
      );

      const forwards = events.filter(event =>
        event.type === 'email_sent' &&
        event.replyToId === 'email-061' &&
        event.mode === 'forward' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('marcus.thompson@contoso.com'))
      );

      const correctForward = forwards.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('jsonwebtoken') &&
          body.includes('cve-2025-12001') &&
          (body.includes('2 hour') || body.includes('2-hour') || body.includes('2 hours')) &&
          (body.includes('pr') || body.includes('eta') || body.includes('fix'));
      });

      return finalizeChecks([
        createCheck(
          'Downloaded the spreadsheet and applied an orange category',
          Boolean(downloadEvent) && auditEmail?.category === 'orange',
          !downloadEvent
            ? 'The Dependency_Audit_Mar2026.xlsx attachment was not downloaded from Priya\'s audit email.'
            : `Priya\'s dependency audit email (email-061) should have the orange category, found "${auditEmail?.category}".`
        ),
        createCheck(
          'Forwarded the audit to Marcus Thompson with jsonwebtoken, the CVE, and Priya\'s 2 hour ETA',
          forwards.length > 0 && Boolean(correctForward),
          forwards.length === 0
            ? 'No forwarded email based on Priya\'s dependency audit (email-061) was sent to marcus.thompson@contoso.com.'
            : 'A forward was sent to Marcus, but it does not call out jsonwebtoken, CVE-2025-12001, and Priya\'s 2 hour ETA for the fix PR.'
        ),
      ], 'Priya\'s dependency audit was downloaded, categorized, and forwarded with the key vulnerability facts.');
    },
  },

  'EVAL-48': {
    tier: 3,
    desc: 'Accept Metrics Deep Dive and reply to Jordan with the escalation facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const metricsEvent = getCalendarEvent(snapshot, 'event-046');
      const acceptedEvent = events.find(event =>
        event.type === 'event_rsvp_changed' &&
        event.eventId === 'event-046' &&
        event.rsvp === 'accepted'
      );

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-060');

      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('acme') &&
          notesContainAny(body, ['124k', '$124k', '124,000', '124000']) &&
          (body.includes('429') || body.includes('rate limit'));
      });

      return finalizeChecks([
        createCheck(
          'Accepted Metrics Deep Dive: Platform Performance',
          Boolean(metricsEvent) && (Boolean(acceptedEvent) || metricsEvent.rsvp === 'accepted'),
          !metricsEvent
            ? 'Could not find Metrics Deep Dive: Platform Performance (event-046).'
            : 'Metrics Deep Dive: Platform Performance (event-046) was not accepted.'
        ),
        createCheck(
          'Replied to Jordan Lee referencing Acme Corp, $124K ARR, and 429 errors',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply was sent for Jordan Lee\'s escalation report (email-060).'
            : 'A reply was sent to Jordan, but it does not mention Acme Corp, its $124K ARR, and the 429 errors / rate limiting issue.'
        ),
      ], 'Metrics Deep Dive was accepted and Jordan received the escalation follow-up.');
    },
  },

  'EVAL-49': {
    tier: 3,
    desc: 'Pin the readiness matrix, categorize the escalation report, and email Tom the blockers',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const escalationEmail = getEmail(snapshot, 'email-060');
      const readinessEmail = getEmail(snapshot, 'email-067');

      const emailsToTom = events.filter(event =>
        event.type === 'email_sent' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('tom.nguyen@contoso.com'))
      );

      const correctEmail = emailsToTom.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('82') &&
          body.includes('runbook') &&
          (body.includes('no owner') || body.includes('missing owner')) &&
          body.includes('payments') &&
          body.includes('rollback') &&
          body.includes('acme') &&
          notesContainAny(body, ['124k', '$124k', '124,000', '124000']);
      });

      return finalizeChecks([
        createCheck(
          'Pinned the readiness matrix and applied a blue category to Jordan\'s escalation report',
          Boolean(readinessEmail?.pinned) && escalationEmail?.category === 'blue',
          !readinessEmail?.pinned
            ? 'Sarah Kim\'s March Launch Readiness Matrix (email-067) should be pinned.'
            : `Jordan Lee\'s escalation trends report (email-060) should have the blue category, found "${escalationEmail?.category}".`
        ),
        createCheck(
          'Emailed Tom Nguyen with localization, runbook, payments rollback, and Acme blocker details',
          emailsToTom.length > 0 && Boolean(correctEmail),
          emailsToTom.length === 0
            ? 'No email was sent to tom.nguyen@contoso.com with the launch blockers.'
            : 'An email was sent to Tom, but it does not mention 82% localization, the ownerless support runbook, the open payments rollback drill, and Acme Corp at $124K ARR.'
        ),
      ], 'The key emails were pinned and categorized, and Tom received the blocker summary.');
    },
  },

  'EVAL-50': {
    tier: 3,
    desc: 'Build a vendor cost follow-up packet and clear the rest of the external inbox',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const seedDb = loadSeedDb();
      if (!seedDb) return fail('Cannot read db_initial.json for seed data.');

      const folder = getFolderByName(snapshot, 'Vendor Bills');
      const azureInvoice = getDbEmail('email-014') || getEmail(snapshot, 'email-014');
      const renewalSummary = getDbEmail('email-065') || getEmail(snapshot, 'email-065');

      const misplaced = [['email-014', azureInvoice], ['email-065', renewalSummary]]
        .filter(([, email]) => !email || !folder || email.folder !== folder.id)
        .map(([id]) => id);

      const otherExternalInbox = (seedDb.emails || []).filter(email =>
        email.isExternal === true && email.folder === 'inbox' && email.id !== 'email-014'
      );
      const notArchived = otherExternalInbox
        .filter(seed => {
          const snap = getEmail(snapshot, seed.id);
          return !snap || snap.folder !== 'archive';
        })
        .map(seed => `${seed.id} ("${seed.subject}")`);

      const vendorCall = getCalendarEvent(snapshot, 'event-016');
      const editEvent = events.find(event => event.type === 'cal_event_edited' && event.eventId === 'event-016');
      const attendees = new Set(vendorCall?.attendees || []);
      const notes = normalizeText(vendorCall?.notes).toLowerCase();
      const missingFacts = [
        {
          label: '$1,847.32 invoice amount',
          present: notesContainAny(notes, ['1,847.32', '1847.32', '1847']),
        },
        {
          label: 'March 15 due date',
          present: notesContainAny(notes, ['march 15', 'mar 15', '03/15', '3/15']),
        },
        {
          label: 'Datadog $186,000 renewal',
          present: notes.includes('datadog') && notesContainAny(notes, ['186,000', '186000', '186k']),
        },
        {
          label: '18% increase',
          present: notesContainAny(notes, ['18%', '18 percent']),
        },
      ].filter(check => !check.present).map(check => check.label);

      const emailsToTom = events.filter(event =>
        event.type === 'email_sent' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('tom.nguyen@contoso.com'))
      );
      const correctEmail = emailsToTom.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('azure') && body.includes('datadog') &&
          notesContainAny(body, ['1,847.32', '1847.32', '1847']) &&
          notesContainAny(body, ['186,000', '186000', '186k']);
      });

      return finalizeChecks([
        createCheck(
          'Created Vendor Bills and moved the Azure invoice plus observability renewal summary into it',
          Boolean(folder) && misplaced.length === 0,
          !folder
            ? 'Folder "Vendor Bills" was not created.'
            : `These vendor-cost emails are not in Vendor Bills: ${misplaced.join(', ')}.`
        ),
        createCheck(
          'Flagged the Azure invoice, left the renewal summary unflagged, and archived every other external inbox email',
          Boolean(azureInvoice?.flagged) && Boolean(renewalSummary) && !renewalSummary.flagged && notArchived.length === 0,
          !azureInvoice?.flagged
            ? 'The Azure invoice (email-014) should be flagged in Vendor Bills.'
            : renewalSummary?.flagged
              ? 'The observability renewal summary (email-065) should stay unflagged.'
              : `These external inbox emails were not archived: ${notArchived.join(', ')}.`
        ),
        createCheck(
          'Updated Vendor Call – Azure into Azure Cost Review with Sarah Kim and the billing facts',
          Boolean(vendorCall) && Boolean(editEvent) && vendorCall.title === 'Azure Cost Review' && vendorCall.startTime === '16:00' && vendorCall.endTime === '16:30' && attendees.has('sarah.kim@contoso.com') && missingFacts.length === 0,
          !vendorCall
            ? 'Could not find Vendor Call – Azure (event-016).'
            : !editEvent
              ? 'No cal_event_edited event was recorded for event-016.'
              : vendorCall.title !== 'Azure Cost Review' || vendorCall.startTime !== '16:00' || vendorCall.endTime !== '16:30'
                ? 'event-016 was not updated to "Azure Cost Review" from 4:00 PM to 4:30 PM.'
                : !attendees.has('sarah.kim@contoso.com')
                  ? 'Azure Cost Review is missing Sarah Kim as an attendee.'
                  : `Azure Cost Review notes are missing: ${missingFacts.join(', ')}.`
        ),
        createCheck(
          'Emailed Tom Nguyen about the Azure invoice and observability renewal spend',
          emailsToTom.length > 0 && Boolean(correctEmail),
          emailsToTom.length === 0
            ? 'No email was sent to tom.nguyen@contoso.com for the vendor-cost review.'
            : 'An email was sent to Tom, but it does not mention both the Azure invoice amount and the Datadog renewal cost.'
        ),
      ], 'Vendor bills were organized, other external inbox email was cleared, Azure Cost Review was updated, and Tom received the spend follow-up.');
    },
  },

  'EVAL-51': {
    tier: 3,
    desc: 'Pin the auth recap, categorize Rachel\'s email, and reply-all with the auth-triage context',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const authRecap = getEmail(snapshot, 'email-063');
      const hiringUpdate = getEmail(snapshot, 'email-062');

      const replies = events.filter(event =>
        event.type === 'email_sent' &&
        event.replyToId === 'email-062' &&
        event.mode === 'reply-all'
      );
      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('senior backend') &&
          (body.includes('top priority') || body.includes('priority')) &&
          notesContainAny(body, ['98']) &&
          body.includes('3') &&
          body.includes('27') &&
          (body.includes('auth') || body.includes('triage'));
      });

      return finalizeChecks([
        createCheck(
          'Pinned Priya\'s auth recap and applied a green category to Rachel\'s email',
          Boolean(authRecap?.pinned) && hiringUpdate?.category === 'green',
          !authRecap?.pinned
            ? 'Priya Sharma\'s auth incident recap (email-063) should be pinned.'
            : `Rachel Green\'s hiring update (email-062) should have the green category, found "${hiringUpdate?.category}".`
        ),
        createCheck(
          'Reply-all to Rachel tied Senior Backend priority to the auth triage using the applicant, onsite, and 27 minute exposure facts',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply-all was sent for Rachel Green\'s hiring pipeline update (email-062).'
            : 'A reply-all was sent to Rachel, but it does not connect Senior Backend priority to the auth triage with the 98 applicants, 3 onsite interviews, and 27 minute exposure.'
        ),
      ], 'The auth recap was pinned, and Rachel received the auth-triage reply-all with the right facts.');
    },
  },

  'EVAL-52': {
    tier: 3,
    desc: 'Download both revenue-dashboard attachments, pin the email, and forward it to Nina with the key revenue facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const revenueDashboard = getEmail(snapshot, 'email-056');
      const downloadNames = (events || [])
        .filter(event => event.type === 'attachment_downloaded' && event.emailId === 'email-056')
        .map(event => event.filename);
      const missingDownloads = ['Q4_2025_Revenue_Dashboard.xlsx', 'Churn_Analysis_Q4.pdf']
        .filter(filename => !downloadNames.includes(filename));

      const forwardsToNina = events.filter(event =>
        event.type === 'email_sent' &&
        event.replyToId === 'email-056' &&
        event.mode === 'forward' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('nina.ross@contoso.com'))
      );
      const correctForward = forwardsToNina.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return (body.includes('one-click checkout') || body.includes('checkout')) &&
          notesContainAny(body, ['218k', '$218k', '218,000', '218000']) &&
          body.includes('developer portal') &&
          notesContainAny(body, ['312k', '$312k', '312,000', '312000']) &&
          body.includes('14') &&
          notesContainAny(body, ['187k', '$187k', '187,000', '187000']);
      });

      return finalizeChecks([
        createCheck(
          'Downloaded both revenue-dashboard attachments and pinned Sarah\'s revenue email',
          missingDownloads.length === 0 && Boolean(revenueDashboard?.pinned),
          missingDownloads.length > 0
            ? `These revenue-dashboard attachments were not downloaded: ${missingDownloads.join(', ')}.`
            : 'Sarah Mitchell\'s revenue dashboard email (email-056) should be pinned.'
        ),
        createCheck(
          'Forwarded the revenue dashboard to Nina Ross with one-click checkout, Developer Portal, and churn facts',
          forwardsToNina.length > 0 && Boolean(correctForward),
          forwardsToNina.length === 0
            ? 'No forwarded email based on Sarah Mitchell\'s revenue dashboard (email-056) was sent to nina.ross@contoso.com.'
            : 'A forward was sent to Nina, but it does not mention one-click checkout at $218K, Developer Portal at $312K, and the 14-account / $187K churn impact.'
        ),
      ], 'Sarah\'s revenue dashboard was downloaded and pinned, and Nina received the forward with the key revenue and churn facts.');
    },
  },

  'EVAL-53': {
    tier: 3,
    desc: 'Download Daniel\'s DB-report attachments, mark it unread, and reply to Maya with the DB-backed retention facts',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const dbReport = getEmail(snapshot, 'email-059');
      const downloadNames = (events || [])
        .filter(event => event.type === 'attachment_downloaded' && event.emailId === 'email-059')
        .map(event => event.filename);
      const missingDownloads = ['DB_Performance_Feb2026.pdf', 'Slow_Query_Log_Top50.csv']
        .filter(filename => !downloadNames.includes(filename));

      const replies = events.filter(event => event.type === 'email_sent' && event.replyToId === 'email-064');
      const correctReply = replies.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return notesContainAny(body, ['540']) &&
          notesContainAny(body, ['1,284', '1284', '1.284k']) &&
          body.includes('142') &&
          notesContainAny(body, ['4 month', '4 months', '4-month']) &&
          (body.includes('cleanup') || body.includes('retention') || body.includes('remediation'));
      });

      return finalizeChecks([
        createCheck(
          'Downloaded both database-report attachments and marked Daniel\'s report unread',
          missingDownloads.length === 0 && Boolean(dbReport) && dbReport.read === false,
          missingDownloads.length > 0
            ? `These database-report attachments were not downloaded: ${missingDownloads.join(', ')}.`
            : 'Daniel Lee\'s database performance report (email-059) should be marked unread.'
        ),
        createCheck(
          'Replied to Maya Patel with the 540 day gap, the 1,284 backlog, the 142 GB orders table, and the 4 month timeline',
          replies.length > 0 && Boolean(correctReply),
          replies.length === 0
            ? 'No reply was sent for Maya Patel\'s retention audit email (email-064).'
            : 'A reply was sent to Maya, but it does not connect the retention cleanup to Daniel\'s 142 GB orders table and the ~4 month timeline.'
        ),
      ], 'Daniel\'s report was downloaded and left unread, and Maya received the DB-backed retention cleanup reply.');
    },
  },

  'EVAL-54': {
    tier: 3,
    desc: 'Repurpose the metrics deep dive into a reliability escalation review',
    verify(snapshot, events) {
      if (!snapshot) return fail('No snapshot found.');
      const folder = getFolderByName(snapshot, 'Reliability Escalations');

      const metricsReport = getDbEmail('email-053') || getEmail(snapshot, 'email-053');
      const escalationReport = getDbEmail('email-060') || getEmail(snapshot, 'email-060');
      const renewalSummary = getDbEmail('email-065') || getEmail(snapshot, 'email-065');

      const misplaced = [['email-053', metricsReport], ['email-060', escalationReport], ['email-065', renewalSummary]]
        .filter(([, email]) => !email || !folder || email.folder !== folder.id)
        .map(([id]) => id);

      const reviewEvent = getCalendarEvent(snapshot, 'event-046');
      const editEvent = events.find(event => event.type === 'cal_event_edited' && event.eventId === 'event-046');
      const attendees = new Set(reviewEvent?.attendees || []);
      const notes = normalizeText(reviewEvent?.notes).toLowerCase();
      const missingFacts = [
        { label: '/charges 2.14%', present: notes.includes('charges') && notesContainAny(notes, ['2.14', '2.14%']) },
        { label: 'Acme $124K ARR', present: notes.includes('acme') && notesContainAny(notes, ['124k', '$124k', '124,000', '124000']) },
        { label: 'Datadog $186,000 renewal', present: notes.includes('datadog') && notesContainAny(notes, ['186,000', '186000', '186k']) },
        { label: '18% increase', present: notesContainAny(notes, ['18%', '18 percent']) },
      ].filter(check => !check.present).map(check => check.label);

      const forwards = events.filter(event =>
        event.type === 'email_sent' &&
        event.mode === 'forward' &&
        event.replyToId === 'email-060' &&
        Array.isArray(event.to) && event.to.some(addr => addr.includes('sarah.kim@contoso.com'))
      );
      const correctForward = forwards.find(event => {
        const sent = getEmail(snapshot, event.emailId);
        if (!sent) return false;
        const body = normalizeText(sent.body).toLowerCase();
        return body.includes('acme') && body.includes('datadog') &&
          notesContainAny(body, ['186,000', '186000', '186k']);
      });

      return finalizeChecks([
        createCheck(
          'Created Reliability Escalations, moved the three source emails into it, and flagged only the escalation plus renewal emails',
          Boolean(folder) && misplaced.length === 0 && Boolean(escalationReport?.flagged) && Boolean(renewalSummary?.flagged) && Boolean(metricsReport) && !metricsReport.flagged,
          !folder
            ? 'Folder "Reliability Escalations" was not created.'
            : misplaced.length > 0
              ? `These emails are not in Reliability Escalations: ${misplaced.join(', ')}.`
              : !escalationReport?.flagged || !renewalSummary?.flagged
                ? 'The escalation report and renewal summary should both be flagged.'
                : 'The weekly platform metrics report (email-053) should stay unflagged.'
        ),
        createCheck(
          'Updated Metrics Deep Dive into Reliability Escalation Review and added Sarah Kim',
          Boolean(reviewEvent) && Boolean(editEvent) && reviewEvent.title === 'Reliability Escalation Review' && reviewEvent.startTime === '11:30' && reviewEvent.endTime === '12:15' && attendees.has('sarah.kim@contoso.com'),
          !reviewEvent
            ? 'Could not find Metrics Deep Dive: Platform Performance (event-046).'
            : !editEvent
              ? 'No cal_event_edited event was recorded for event-046.'
              : reviewEvent.title !== 'Reliability Escalation Review' || reviewEvent.startTime !== '11:30' || reviewEvent.endTime !== '12:15'
                ? 'event-046 was not updated to "Reliability Escalation Review" from 11:30 AM to 12:15 PM.'
                : 'Reliability Escalation Review is missing Sarah Kim as an attendee.'
        ),
        createCheck(
          'Captured the /charges, Acme, and renewal-pressure facts in the meeting notes',
          missingFacts.length === 0,
          `Reliability Escalation Review notes are missing: ${missingFacts.join(', ')}.`
        ),
        createCheck(
          'Forwarded Jordan Lee\'s escalation report to Sarah Kim with the Acme and renewal risk callout',
          forwards.length > 0 && Boolean(correctForward),
          forwards.length === 0
            ? 'No forwarded email based on Jordan Lee\'s escalation report (email-060) was sent to sarah.kim@contoso.com.'
            : 'A forward was sent to Sarah Kim, but it does not call out both the Acme risk and the Datadog renewal pressure.'
        ),
      ], 'Reliability escalations were organized, the metrics deep dive was repurposed, and Sarah received the escalation forward with the renewal context.');
    },
  },
};

/* ===== RESULT HELPERS ===== */
function pass(msg) { return { pass: true, message: msg }; }
function fail(msg) { return { pass: false, message: msg }; }

/* ===== COLORS ===== */
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/* ===== RUN TASK ===== */
function runTask(taskId) {
  const task = TASKS[taskId];
  if (!task) {
    console.error(`${RED}Unknown task: ${taskId}${RESET}`);
    process.exit(1);
  }

  const snapshot = loadSnapshot(snapshotPath);
  const events = loadEvents(eventLogPath);

  console.log(`\n${BOLD}${CYAN}${taskId}${RESET} ${DIM}(Tier ${task.tier})${RESET}`);
  console.log(`${DIM}${task.desc}${RESET}`);

  let result;
  try {
    result = task.verify(snapshot, events);
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
function runAll() {
  const snapshot = loadSnapshot(snapshotPath);
  const events = loadEvents(eventLogPath);

  if (!snapshot) {
    console.warn(`${YELLOW}Warning: snapshot not found at ${snapshotPath}. Run the app and interact with it first.${RESET}`);
  }
  if (events.length === 0) {
    console.warn(`${YELLOW}Warning: event log is empty or missing at ${eventLogPath}. Run the app and interact with it first.${RESET}`);
  }

  const tiers = { 1: [], 2: [], 3: [] };
  let passed = 0;
  let failed = 0;

  for (const [taskId, task] of Object.entries(TASKS)) {
    let result;
    try {
      result = task.verify(snapshot, events);
    } catch (e) {
      result = fail(`Evaluator error: ${e.message}`);
    }
    tiers[task.tier].push({ taskId, task, result });
    if (result.pass) passed++; else failed++;
  }

  for (const tier of [1, 2, 3]) {
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
}

/* ===== CLI ENTRY ===== */
const args = process.argv.slice(2);
const snapshotPath = getArgValue(args, '--snapshot') || SNAPSHOT_PATH;
const eventLogPath = getArgValue(args, '--events') || EVENT_LOG_PATH;
if (args.length === 0) {
  console.log('Usage:');
  console.log('  node evaluator.js EVAL-01 [--snapshot path] [--events path]   # run single task');
  console.log('  node evaluator.js --all [--snapshot path] [--events path]      # run all tasks');
  process.exit(0);
}

if (args[0] === '--all') {
  console.log(`outlook evaluator v${VERSION}`);
  runAll();
} else {
  console.log(`outlook evaluator v${VERSION}`);
  const ok = runTask(args[0]);
  process.exit(ok ? 0 : 1);
}
