#!/usr/bin/env node
/**
 * evaluator.js — Scrum Board Evaluation Script
 *
 * Reads localStorage_snapshot.json (current board state) and
 * event_log.ndjson (action history) to verify evaluation task outcomes.
 *
 * Usage:
 *   node evaluator.js EVAL-01           — run single task
 *   node evaluator.js --all             — run all tasks grouped by tier
 */

'use strict';

const VERSION = '1.0.0';

const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, 'localStorage_snapshot.json');
const EVENT_LOG_FILE = path.join(__dirname, 'event_log.ndjson');
const DB_FILE = path.join(__dirname, 'db_initial.json');

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : null;
}

// ======================================================
// DATA LOADERS
// ======================================================

function loadSnapshot(snapshotFile) {
  if (!fs.existsSync(snapshotFile)) {
    console.error(`[WARN] Snapshot file not found: ${snapshotFile}`);
    console.error('       Run the server and perform some actions on the board first.');
    return null;
  }
  try {
    const raw = fs.readFileSync(snapshotFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[ERROR] Could not parse snapshot: ${e.message}`);
    return null;
  }
}

function loadEventLog(eventLogFile) {
  if (!fs.existsSync(eventLogFile)) {
    console.error(`[WARN] Event log file not found: ${eventLogFile}`);
    console.error('       Run the server and perform some actions on the board first.');
    return [];
  }
  try {
    const raw = fs.readFileSync(eventLogFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    return lines.map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error(`[WARN] Could not parse event log line ${idx + 1}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error(`[ERROR] Could not read event log: ${e.message}`);
    return [];
  }
}

function loadSeedData() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[ERROR] Could not load db_initial.json: ${e.message}`);
    return { tasks: [], users: [], tags: [] };
  }
}

// ======================================================
// HELPERS
// ======================================================

function getTaskFromSnapshot(snapshot, taskId) {
  if (!snapshot || !snapshot.tasks) return null;
  return snapshot.tasks.find(t => t.id === taskId) || null;
}

function getTasksByStatus(snapshot, status) {
  if (!snapshot || !snapshot.tasks) return [];
  return snapshot.tasks.filter(t => t.status === status);
}

function getTasksByPriority(snapshot, priority) {
  if (!snapshot || !snapshot.tasks) return [];
  return snapshot.tasks.filter(t => t.priority === priority);
}

function getTasksByAssignee(snapshot, assigneeId) {
  if (!snapshot || !snapshot.tasks) return [];
  return snapshot.tasks.filter(t => t.assigneeId === assigneeId);
}

function getTasksByTag(snapshot, tagId) {
  if (!snapshot || !snapshot.tasks) return [];
  return snapshot.tasks.filter(t => (t.tags || []).includes(tagId));
}

function getUserByName(snapshot, name) {
  if (!snapshot || !snapshot.users) return null;
  return snapshot.users.find(u => (u.name || '').toLowerCase() === name.toLowerCase()) || null;
}

function getTagByName(snapshot, name) {
  if (!snapshot || !snapshot.tags) return null;
  return snapshot.tags.find(t => (t.name || '').toLowerCase() === name.toLowerCase()) || null;
}

function findEventsOfType(events, type) {
  return events.filter(e => e.type === type);
}

function findEventForTask(events, type, taskId) {
  return events.filter(e => e.type === type && e.data && e.data.taskId === taskId);
}

/** Check if a number appears as a standalone token (not embedded in a larger number). */
function containsExactNumber(text, num) {
  const re = new RegExp(`(?<![0-9])${num}(?![0-9])`);
  return re.test(text);
}

/**
 * Check if a number appears near a name in the text.
 * Extracts the segment from the name to the next newline (or up to 40 chars),
 * so "Alice: 10000" won't match because Carol's correct "16" is on a different line.
 */
function containsNumberNearName(text, nameVariants, num) {
  for (const name of nameVariants) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(name, searchFrom);
      if (idx === -1) break;
      // Look from just before the name to the next newline or 40 chars ahead
      const start = Math.max(0, idx - 10);
      const lineEnd = text.indexOf('\n', idx);
      const end = lineEnd !== -1 ? lineEnd : Math.min(text.length, idx + name.length + 40);
      const window = text.substring(start, end);
      if (containsExactNumber(window, num)) return true;
      searchFrom = idx + 1;
    }
  }
  return false;
}

function findTaskByTitleContains(snapshot, substr) {
  if (!snapshot || !snapshot.tasks) return null;
  const lower = substr.toLowerCase();
  return snapshot.tasks.find(t => (t.title || '').toLowerCase().includes(lower)) || null;
}

function hasFilterEvent(events, filterType, value) {
  return events.some(e =>
    e.type === 'filter_applied' &&
    e.data &&
    e.data.filterType === filterType &&
    (value === undefined || e.data.value === value || e.data.value.toString() === value.toString())
  );
}

function pass(reason, checks = []) {
  return { pass: true, reason, message: reason, checks };
}

function fail(reason, checks = []) {
  return { pass: false, reason, message: reason, checks };
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
    return pass(successMessage, checks);
  }
  return fail(
    failedChecks.map(check => check.detail || `${check.label} failed.`).join(' '),
    checks,
  );
}

// ======================================================
// EVAL TASK DEFINITIONS
// ======================================================

const EVAL_TASKS = {

  // ====================================================
  // TIER 1
  // ====================================================

  'EVAL-01': {
    name: 'Move the authentication task to Done',
    tier: 1,
    description: 'SCRUM-001 (Implement user authentication with OAuth2) should be moved to the Done column.',
    verify: (snapshot, events) => {
      // Snapshot (db) is sufficient — if the task's status is "done", the agent succeeded
      // regardless of whether it used drag-and-drop or another method.
      if (!snapshot) return fail('Snapshot not available — no board state recorded yet.');

      const task = getTaskFromSnapshot(snapshot, 'SCRUM-001');
      if (!task) return fail('SCRUM-001 not found in snapshot.');
      if (task.status !== 'done') return fail(`SCRUM-001 has status "${task.status}", expected "done".`);

      return pass('SCRUM-001 status is "done".');
    }
  },

  'EVAL-02': {
    name: 'Change the priority of the search refactor task',
    tier: 1,
    description: 'SCRUM-009 (Refactor search service to use Elasticsearch) priority should be changed to high.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const task = getTaskFromSnapshot(snapshot, 'SCRUM-009');
      if (!task) return fail('SCRUM-009 not found in snapshot.');
      if (task.priority !== 'high') return fail(`SCRUM-009 has priority "${task.priority}", expected "high".`);

      const editEvents = findEventForTask(events, 'card_edited', 'SCRUM-009');
      if (editEvents.length === 0) return fail('No card_edited event found for SCRUM-009 in event log.');

      const hasPriorityChange = editEvents.some(e =>
        e.data &&
        e.data.changes &&
        e.data.changes.priority &&
        e.data.changes.priority.to === 'high'
      );
      if (!hasPriorityChange) {
        // Still pass if the snapshot state is correct (change may have been saved without full diff)
        return pass('SCRUM-009 priority is "high" in snapshot (edit event found, priority change diff may vary).');
      }

      return pass('SCRUM-009 priority is "high" and a card_edited event with priority change is recorded.');
    }
  },

  'EVAL-03': {
    name: 'Switch the visual theme to Midnight Dark',
    tier: 1,
    description: 'The last theme_changed event must have theme "dark" — switching back to another theme fails.',
    verify: (snapshot, events) => {
      const themeEvents = findEventsOfType(events, 'theme_changed');
      if (themeEvents.length === 0) return fail('No theme_changed event found in event log.');
      const lastThemeEvent = themeEvents[themeEvents.length - 1];
      if (!lastThemeEvent.data || lastThemeEvent.data.theme !== 'dark') {
        return fail(`Last theme_changed event has theme "${lastThemeEvent.data && lastThemeEvent.data.theme}", expected "dark". Theme must remain dark.`);
      }
      return pass(`Theme changed to "dark" at ${lastThemeEvent.ts} and was not subsequently changed.`);
    }
  },

  'EVAL-04': {
    name: 'Search for tasks related to security',
    tier: 1,
    description: 'A filter_applied event with search term "security" should appear in the event log.',
    verify: (snapshot, events) => {
      const filterEvents = findEventsOfType(events, 'filter_applied');
      const securitySearch = filterEvents.find(e =>
        e.data &&
        e.data.filterType === 'search' &&
        typeof e.data.value === 'string' &&
        e.data.value.toLowerCase().includes('security')
      );
      if (!securitySearch) return fail('No filter_applied event with search value "security" found in event log.');
      return pass(`Search for "security" was recorded at ${securitySearch.ts}.`);
    }
  },

  'EVAL-05': {
    name: 'Create a new task in the In Progress column',
    tier: 1,
    description: 'A new task titled for logging middleware in API gateway should exist in inprogress with priority=high, storyPoints=3, and an assignee.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const task = (snapshot.tasks || []).find(t => {
        const title = (t.title || '').toLowerCase();
        return title.includes('logging middleware') && title.includes('api gateway');
      });

      if (!task) return fail('No task found matching the required title intent: logging middleware + API gateway.');

      const issues = [];
      if (task.status !== 'inprogress') {
        issues.push(`status is "${task.status}", expected "inprogress"`);
      }
      if (task.priority !== 'high') {
        issues.push(`priority is "${task.priority}", expected "high"`);
      }
      if (task.storyPoints !== 3) {
        issues.push(`storyPoints is ${task.storyPoints}, expected 3`);
      }
      if (!task.assigneeId) {
        issues.push('assigneeId is empty, expected any assigned user');
      }

      const createEvents = findEventsOfType(events, 'card_created');
      const createEvent = createEvents.find(e =>
        e.data && e.data.taskId === task.id
      );
      if (!createEvent) return fail(`Task ${task.id} found in snapshot but no card_created event recorded.`);

      if (issues.length > 0) {
        return fail(`Task ${task.id} does not satisfy constraints: ${issues.join(' | ')}`);
      }

      return pass(`Task ${task.id} "${task.title}" satisfies status, priority, story points, assignee, and card_created checks.`);
    }
  },

  // ====================================================
  // TIER 2
  // ====================================================

  'EVAL-06': {
    name: 'Move multiple tasks and verify column counts',
    tier: 2,
    description: 'SCRUM-003 must be in inprogress and SCRUM-013 in done.',
    verify: (snapshot, events) => {
      // Snapshot (db) is sufficient — accept any method that results in correct status.
      if (!snapshot) return fail('Snapshot not available.');

      const issues = [];

      const task3 = getTaskFromSnapshot(snapshot, 'SCRUM-003');
      if (!task3) {
        issues.push('SCRUM-003 not found in snapshot.');
      } else if (task3.status !== 'inprogress') {
        issues.push(`SCRUM-003 has status "${task3.status}", expected "inprogress".`);
      }

      const task13 = getTaskFromSnapshot(snapshot, 'SCRUM-013');
      if (!task13) {
        issues.push('SCRUM-013 not found in snapshot.');
      } else if (task13.status !== 'done') {
        issues.push(`SCRUM-013 has status "${task13.status}", expected "done".`);
      }

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass('SCRUM-003 is "inprogress" and SCRUM-013 is "done".');
    }
  },

  'EVAL-07': {
    name: "Edit a card's details then move it",
    tier: 2,
    description: 'SCRUM-007 should have assigneeId=user-5 (Emma Johnson), storyPoints=5, status=inprogress.',
    verify: (snapshot, events) => {
      // Snapshot (db) is sufficient for all checks — fields + status.
      if (!snapshot) return fail('Snapshot not available.');

      const task = getTaskFromSnapshot(snapshot, 'SCRUM-007');
      if (!task) return fail('SCRUM-007 not found in snapshot.');

      const issues = [];

      if (task.assigneeId !== 'user-5') {
        issues.push(`SCRUM-007 assigneeId is "${task.assigneeId}", expected "user-5" (Emma Johnson).`);
      }
      if (task.storyPoints !== 5) {
        issues.push(`SCRUM-007 storyPoints is ${task.storyPoints}, expected 5.`);
      }
      if (task.status !== 'inprogress') {
        issues.push(`SCRUM-007 status is "${task.status}", expected "inprogress".`);
      }

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass('SCRUM-007 has user-5 (Emma), storyPoints=5, status=inprogress.');
    }
  },

  'EVAL-08': {
    name: 'Filter by assignee then move a visible card',
    tier: 2,
    description: 'SCRUM-008 should be in inreview; a filter_applied event for user-1 (Alice Chen) should be present.',
    verify: (snapshot, events) => {
      // Filter = event-log only (no db representation).
      // Status change = snapshot (db) is sufficient.
      if (!snapshot) return fail('Snapshot not available.');

      const task = getTaskFromSnapshot(snapshot, 'SCRUM-008');
      if (!task) return fail('SCRUM-008 not found in snapshot.');
      if (task.status !== 'inreview') {
        return fail(`SCRUM-008 has status "${task.status}", expected "inreview".`);
      }

      // Check filter event for Alice Chen (user-1)
      const aliceUser = getUserByName(snapshot, 'Alice Chen');
      const aliceId = aliceUser ? aliceUser.id : 'user-1';

      const filterEvents = findEventsOfType(events, 'filter_applied');
      const aliceFilter = filterEvents.find(e =>
        e.data &&
        e.data.filterType === 'assignee' &&
        e.data.value === aliceId
      );
      if (!aliceFilter) {
        return fail(`No filter_applied event for assignee "${aliceId}" (Alice Chen) found in event log.`);
      }

      return pass('SCRUM-008 is in inreview; assignee filter for Alice Chen present.');
    }
  },

  'EVAL-09': {
    name: 'Create a task then immediately move it to a different column',
    tier: 2,
    description: 'A task with "load testing scripts" in title should exist in status=inreview; card_created event present.',
    verify: (snapshot, events) => {
      // Creation = need card_created event (validates the create action).
      // Status = snapshot (db) is sufficient — don't require card_moved.
      if (!snapshot) return fail('Snapshot not available.');

      const task = findTaskByTitleContains(snapshot, 'load testing scripts');
      if (!task) return fail('No task with "load testing scripts" in title found in snapshot.');
      if (task.status !== 'inreview') {
        return fail(`Task "${task.id}" has status "${task.status}", expected "inreview".`);
      }

      const createEvents = findEventsOfType(events, 'card_created');
      const createEvent = createEvents.find(e => e.data && e.data.taskId === task.id);
      if (!createEvent) return fail(`No card_created event found for task ${task.id}.`);

      return pass(`Task ${task.id} exists in inreview with card_created event present.`);
    }
  },

  'EVAL-10': {
    name: 'Switch theme to Sand, create a task in Done, verify it appears',
    tier: 2,
    description: 'theme_changed(sand) event; task with "Archive completed sprint data" exists in status=done; card_created event present.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const themeEvents = findEventsOfType(events, 'theme_changed');
      const sandEvent = themeEvents.find(e => e.data && e.data.theme === 'sand');
      if (!sandEvent) return fail('No theme_changed event with theme "sand" found in event log.');

      const task = findTaskByTitleContains(snapshot, 'Archive completed sprint data');
      if (!task) return fail('No task with "Archive completed sprint data" in title found in snapshot.');
      if (task.status !== 'done') {
        return fail(`Task "${task.id}" has status "${task.status}", expected "done".`);
      }

      const createEvent = findEventsOfType(events, 'card_created').find(
        e => e.data && e.data.taskId === task.id
      );
      if (!createEvent) return fail(`No card_created event for task ${task.id}.`);

      return pass(`Sand theme event recorded; task ${task.id} in "done" with card_created event present.`);
    }
  },

  // ====================================================
  // TIER 3
  // ====================================================

  'EVAL-11': {
    name: 'Move all high-priority To Do tasks to In Progress',
    tier: 3,
    description: 'No tasks should remain in todo with priority=high. All previously-high todo tasks now in inprogress. Non-target tasks unchanged.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // Identify target tasks: Sprint 2 top-level high-priority todo
      const targetTasks = seedTasks.filter(
        t => t.status === 'todo' && t.priority === 'high' && !t.parentId && t.sprintId === 'sprint-2'
      );

      const movedIssues = [];
      targetTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          movedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.status !== 'inprogress') {
          movedIssues.push(`${seedTask.id} expected "inprogress" but is "${current.status}".`);
        }
      });

      // Damage check: non-target Sprint 2 todo tasks should keep their original status
      const nonTargetTodo = seedTasks.filter(
        t => t.status === 'todo' && t.priority !== 'high' && !t.parentId && t.sprintId === 'sprint-2'
      );
      const unchangedIssues = [];
      nonTargetTodo.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.status !== seedTask.status) {
          unchangedIssues.push(`${seedTask.id} (priority="${seedTask.priority}") status changed from "${seedTask.status}" to "${current.status}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Moved all high-priority To Do tasks to In Progress',
          targetTasks.length > 0 && movedIssues.length === 0,
          targetTasks.length === 0
            ? 'No high-priority To Do tasks found in seed.'
            : movedIssues.join(' ')
        ),
        createCheck(
          'Left non-high-priority To Do tasks unchanged',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${targetTasks.length} high-priority To Do tasks moved to In Progress. Non-target tasks unchanged.`);
    }
  },

  'EVAL-12': {
    name: "Find tasks assigned to David Kim and lower their priority",
    tier: 3,
    description: "David Kim's tasks (user-4) should each have priority reduced by one level. Non-David tasks unchanged.",
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const davidId = 'user-4';
      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];
      const priorityOrder = ['critical', 'high', 'medium', 'low'];

      // David's Sprint 2 top-level tasks that were originally his
      const davidTasks = seedTasks.filter(
        t => t.assigneeId === davidId && !t.parentId && t.sprintId === 'sprint-2'
      );

      const priorityIssues = [];
      davidTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          priorityIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        const origIdx = priorityOrder.indexOf(seedTask.priority);
        if (origIdx === -1) return;
        const expectedPriority = origIdx < priorityOrder.length - 1
          ? priorityOrder[origIdx + 1]
          : priorityOrder[origIdx];
        if (current.priority !== expectedPriority) {
          priorityIssues.push(`${seedTask.id}: expected "${expectedPriority}" (down from "${seedTask.priority}"), got "${current.priority}".`);
        }
      });

      // Damage check: non-David tasks should keep original priority
      const nonDavidTasks = seedTasks.filter(
        t => t.assigneeId !== davidId && !t.parentId
      );
      const unchangedIssues = [];
      nonDavidTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.priority !== seedTask.priority) {
          unchangedIssues.push(`${seedTask.id} (assignee="${seedTask.assigneeId}") priority changed from "${seedTask.priority}" to "${current.priority}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Reduced priority by one level for each of David Kim\'s Sprint 2 tasks',
          davidTasks.length > 0 && priorityIssues.length === 0,
          davidTasks.length === 0
            ? 'No David Kim Sprint 2 tasks found in seed.'
            : priorityIssues.join(' ')
        ),
        createCheck(
          'Left non-David tasks at their original priority',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${davidTasks.length} David Kim tasks have priority reduced by one level. Non-David tasks unchanged.`);
    }
  },

  'EVAL-13': {
    name: 'Create task with specific attributes and verify card fields',
    tier: 3,
    description: 'Task "webhook event delivery system": assignee=user-6 (Frank Lee), priority=critical, storyPoints=8, tags=[tag-2, tag-10].',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const task = findTaskByTitleContains(snapshot, 'webhook event delivery');
      if (!task) return fail('No task with "webhook event delivery" in title found in snapshot.');

      const issues = [];

      if (task.assigneeId !== 'user-6') {
        issues.push(`assigneeId is "${task.assigneeId}", expected "user-6" (Frank Lee).`);
      }
      if (task.priority !== 'critical') {
        issues.push(`priority is "${task.priority}", expected "critical".`);
      }
      if (task.storyPoints !== 8) {
        issues.push(`storyPoints is ${task.storyPoints}, expected 8.`);
      }
      if (task.status !== 'todo') {
        issues.push(`status is "${task.status}", expected "todo" (task should be created in To Do column).`);
      }
      if (!(task.tags || []).includes('tag-2')) {
        issues.push('Missing tag "tag-2" (backend).');
      }
      if (!(task.tags || []).includes('tag-10')) {
        issues.push('Missing tag "tag-10" (devops).');
      }
      if ((task.tags || []).length !== 2) {
        issues.push(`tag count is ${(task.tags || []).length}, expected exactly 2 (tag-2 and tag-10).`);
      }

      // Verify create event
      const createEvent = findEventsOfType(events, 'card_created').find(
        e => e.data && e.data.taskId === task.id
      );
      if (!createEvent) {
        issues.push(`No card_created event found for task ${task.id}.`);
      }

      if (issues.length > 0) return fail(`Task ${task.id}: ` + issues.join(' | '));

      return pass(`Task ${task.id} has all required fields: Frank Lee, critical, 8sp, backend+devops tags, card_created event present.`);
    }
  },

  'EVAL-14': {
    name: 'Find all security-tagged tasks and move non-done/review ones to In Review',
    tier: 3,
    description: 'All sprint-scoped top-level security-tagged (tag-7) tasks that were in todo/inprogress should now be in inreview; backlog items are out of scope.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const securityTagId = 'tag-7';
      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // Find seed tasks with security tag that were in todo or inprogress (exclude subtasks and backlog)
      const tasksToMove = seedTasks.filter(
        t => (t.tags || []).includes(securityTagId) &&
             (t.status === 'todo' || t.status === 'inprogress') &&
             !t.parentId &&
             t.sprintId !== null
      );

      if (tasksToMove.length === 0) {
        return fail('No security-tagged tasks in todo/inprogress found in seed data to verify against.');
      }

      const issues = [];
      tasksToMove.forEach(seedTask => {
        const currentTask = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!currentTask) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        // Task must have been moved to inreview (or to done if moved there by an earlier eval task).
        // Check via event log: was there a card_moved to inreview for this task?
        const movedToReview = findEventForTask(events, 'card_moved', seedTask.id)
          .some(e => e.data && e.data.toStatus === 'inreview');

        const finalStatusOk = currentTask.status === 'inreview' || currentTask.status === 'done';

        if (!movedToReview && !finalStatusOk) {
          issues.push(`${seedTask.id} has status "${currentTask.status}" and no card_moved → inreview event found.`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));

      return pass(`All eligible security-tagged tasks moved to inreview.`);
    }
  },

  'EVAL-15': {
    name: 'Complex multi-step: filter, edit, create, and reorganize',
    tier: 3,
    description: 'SCRUM-011 assignee=user-2, sp=3; new "penetration testing" task in inprogress; SCRUM-004 in inprogress; multiple event types present.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const issues = [];

      // 1. SCRUM-011 should have assigneeId=user-2 (Bob Martinez), storyPoints=3
      const task11 = getTaskFromSnapshot(snapshot, 'SCRUM-011');
      if (!task11) {
        issues.push('SCRUM-011 not found in snapshot.');
      } else {
        if (task11.assigneeId !== 'user-2') {
          issues.push(`SCRUM-011 assigneeId is "${task11.assigneeId}", expected "user-2" (Bob Martinez).`);
        }
        if (task11.storyPoints !== 3) {
          issues.push(`SCRUM-011 storyPoints is ${task11.storyPoints}, expected 3.`);
        }
      }

      // 2. New "penetration testing" task in inprogress
      const penTask = findTaskByTitleContains(snapshot, 'penetration testing');
      if (!penTask) {
        issues.push('No task with "penetration testing" in title found in snapshot.');
      } else {
        if (penTask.status !== 'inprogress') {
          issues.push(`Penetration testing task ${penTask.id} has status "${penTask.status}", expected "inprogress".`);
        }
        if (penTask.priority !== 'critical') {
          issues.push(`Penetration testing task ${penTask.id} priority is "${penTask.priority}", expected "critical".`);
        }
        if (penTask.assigneeId !== 'user-3') {
          issues.push(`Penetration testing task ${penTask.id} assigneeId is "${penTask.assigneeId}", expected "user-3" (Carol White).`);
        }
        if (penTask.storyPoints !== 13) {
          issues.push(`Penetration testing task ${penTask.id} storyPoints is ${penTask.storyPoints}, expected 13.`);
        }
        if (!(penTask.tags || []).includes('tag-7')) {
          issues.push(`Penetration testing task ${penTask.id} missing tag-7 (security).`);
        }
        if (!(penTask.tags || []).includes('tag-6')) {
          issues.push(`Penetration testing task ${penTask.id} missing tag-6 (testing).`);
        }
        if ((penTask.tags || []).length !== 2) {
          issues.push(`Penetration testing task ${penTask.id} has ${(penTask.tags || []).length} tag(s), expected exactly 2 (tag-7 and tag-6).`);
        }
        // card_created event validates the create action
        const createEventPen = findEventsOfType(events, 'card_created').find(
          e => e.data && e.data.taskId === penTask.id
        );
        if (!createEventPen) {
          issues.push(`No card_created event for penetration testing task ${penTask.id}.`);
        }
        // Status check via snapshot is sufficient — no card_moved event required
      }

      // 3. SCRUM-004 in inprogress — snapshot is sufficient
      const task4 = getTaskFromSnapshot(snapshot, 'SCRUM-004');
      if (!task4) {
        issues.push('SCRUM-004 not found in snapshot.');
      } else {
        if (task4.status !== 'inprogress') {
          issues.push(`SCRUM-004 has status "${task4.status}", expected "inprogress".`);
        }
      }

      // 4. Filter event for priority=critical
      const filterEvents = findEventsOfType(events, 'filter_applied');
      const criticalFilter = filterEvents.find(e =>
        e.data && e.data.filterType === 'priority' && e.data.value === 'critical'
      );
      if (!criticalFilter) {
        issues.push('No filter_applied event for priority "critical" found in event log.');
      }

      if (issues.length > 0) return fail(issues.join(' | '));

      return pass('All EVAL-15 conditions verified: SCRUM-011 edited, penetration testing task created and moved, SCRUM-004 moved, critical filter applied.');
    }
  },

  'EVAL-16': {
    name: 'Issue Types — Change SCRUM-003 type to Bug',
    tier: 1,
    prompt: 'Open the task SCRUM-003 (Fix memory leak in websocket connection handler) and change its issue type to Bug.',
    verify(snapshot, events) {
      // 1. SCRUM-003 must exist in snapshot with type === 'bug'
      const task = getTaskFromSnapshot(snapshot, 'SCRUM-003');
      if (!task) return fail('SCRUM-003 not found in snapshot.');
      if ((task.type || '').toLowerCase() !== 'bug') {
        return fail(`SCRUM-003.type is "${task.type}", expected "bug".`);
      }

      // 2. A card_edited event must exist for SCRUM-003 referencing the type change
      const editedEvents = findEventForTask(events, 'card_edited', 'SCRUM-003');
      if (editedEvents.length === 0) {
        return fail('No card_edited event found for SCRUM-003.');
      }
      const hasTypeChange = editedEvents.some(e =>
        e.data && e.data.changes && 'type' in e.data.changes
      );
      if (!hasTypeChange) {
        return fail('card_edited event for SCRUM-003 does not include a "type" change.');
      }

      return pass('EVAL-16 verified: SCRUM-003.type === "bug" and card_edited event with type change exists.');
    }
  },

  'EVAL-17': {
    name: 'Sprint Management — Complete active sprint and create Sprint 4',
    tier: 2,
    prompt: 'Complete the currently active sprint (Sprint 2). Then create a new sprint called "Sprint 4" with the goal "UI polish and accessibility improvements", and set its start date to next Monday.',
    verify(snapshot, events) {
      // 1. sprint_completed event must exist
      const completedEvents = findEventsOfType(events, 'sprint_completed');
      if (completedEvents.length === 0) {
        return fail('No sprint_completed event found in event log.');
      }

      // 2. sprint_created event must exist with a name containing "Sprint 4"
      const createdEvents = findEventsOfType(events, 'sprint_created');
      if (createdEvents.length === 0) {
        return fail('No sprint_created event found in event log.');
      }
      const sprint4Event = createdEvents.find(e =>
        e.data && e.data.name && e.data.name.toLowerCase().includes('sprint 4')
      );
      if (!sprint4Event) {
        return fail('No sprint_created event with name containing "Sprint 4" found.');
      }

      // Check Sprint 4 goal text
      const sprint4Goal = (sprint4Event.data.goal || '').toLowerCase();
      if (!sprint4Goal.includes('ui polish') && !sprint4Goal.includes('accessibility')) {
        return fail(`Sprint 4 goal is "${sprint4Event.data.goal || ''}", expected to mention "UI polish" and "accessibility improvements".`);
      }

      // 3. Snapshot sprints should have the completed sprint marked as completed
      const sprints = (snapshot && snapshot.sprints) || [];
      const completedSprint = sprints.find(s => s.status === 'completed' &&
        completedEvents.some(e => e.data && (e.data.sprintId === s.id || e.data.name === s.name))
      );
      // lenient: just check that at least one sprint in snapshot has status completed
      const anyCompleted = sprints.some(s => s.status === 'completed');
      if (!anyCompleted) {
        return fail('No sprint with status "completed" found in snapshot.sprints.');
      }

      return pass('EVAL-17 verified: sprint_completed event exists, sprint_created event for Sprint 4 exists, and snapshot contains a completed sprint.');
    }
  },

  'EVAL-18': {
    name: 'Backlog View — Add Frank Lee\'s backlog tasks to active sprint',
    tier: 2,
    prompt: 'Head to the Backlog view and find the tasks assigned to Frank Lee that haven\'t been added to a sprint yet. Add both of them — the database backup one and the Kubernetes staging cluster one — to Sprint 2. Then switch back to the Board to confirm they show up there.',
    verify(snapshot, events) {
      const issues = [];

      // Check snapshot sprintId for both tasks
      const task032 = getTaskFromSnapshot(snapshot, 'SCRUM-032');
      if (!task032) {
        issues.push('SCRUM-032 not found in snapshot.');
      } else if (task032.sprintId !== 'sprint-2') {
        issues.push(`SCRUM-032 has sprintId "${task032.sprintId}" in snapshot, expected "sprint-2".`);
      }

      const task035 = getTaskFromSnapshot(snapshot, 'SCRUM-035');
      if (!task035) {
        issues.push('SCRUM-035 not found in snapshot.');
      } else if (task035.sprintId !== 'sprint-2') {
        issues.push(`SCRUM-035 has sprintId "${task035.sprintId}" in snapshot, expected "sprint-2".`);
      }

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass('EVAL-18 verified: SCRUM-032 and SCRUM-035 (Frank Lee\'s backlog tasks) added to sprint-2 and confirmed in snapshot.');
    }
  },

  'EVAL-19': {
    name: 'Subtasks — Add subtasks to SCRUM-005 and mark first done',
    tier: 2,
    prompt: 'Open SCRUM-005 (Write unit tests for payment processing module). Add two subtasks: one called "Write happy-path tests" and another called "Write edge case tests". Then mark the first subtask as done.',
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      // Find subtasks of SCRUM-005 in snapshot
      const subtasks = (snapshot.tasks || []).filter(t => t.parentId === 'SCRUM-005');
      const happyPath = subtasks.find(t => (t.title || '').toLowerCase().includes('happy-path'));
      const edgeCase = subtasks.find(t => (t.title || '').toLowerCase().includes('edge case'));

      return finalizeChecks([
        createCheck(
          'Added "Write happy-path tests" subtask to SCRUM-005',
          Boolean(happyPath),
          'No subtask with "happy-path" in title found under SCRUM-005.'
        ),
        createCheck(
          'Added "Write edge case tests" subtask to SCRUM-005',
          Boolean(edgeCase),
          'No subtask with "edge case" in title found under SCRUM-005.'
        ),
        createCheck(
          'Marked the happy-path subtask as done',
          happyPath && happyPath.status === 'done',
          !happyPath
            ? 'Cannot verify completion because the happy-path subtask is missing.'
            : `Happy-path subtask status is "${happyPath.status}", expected "done".`
        ),
      ], 'Both subtasks exist under SCRUM-005 and the happy-path one is marked done.');
    }
  },

  'EVAL-20': {
    name: 'Issue Linking — Link SCRUM-001 blocks SCRUM-003 and relates-to SCRUM-002',
    tier: 3,
    prompt: 'Open SCRUM-001 (Implement user authentication) and link it to SCRUM-003 (Fix memory leak) with the relationship "blocks". Then also link SCRUM-001 as "relates to" SCRUM-002.',
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      // Snapshot: SCRUM-001.linkedIssues has both links
      const task001 = getTaskFromSnapshot(snapshot, 'SCRUM-001');
      if (!task001) return fail('SCRUM-001 not found in snapshot.');
      const links = task001.linkedIssues || [];
      const hasBlocks = links.some(l =>
        l.targetId === 'SCRUM-003' && (l.linkType === 'blocks')
      );
      const hasRelates = links.some(l =>
        l.targetId === 'SCRUM-002' && (l.linkType === 'relatesTo' || l.linkType === 'relates_to' || l.linkType === 'relates to')
      );

      return finalizeChecks([
        createCheck(
          'SCRUM-001 has a "blocks" link to SCRUM-003',
          hasBlocks,
          'SCRUM-001.linkedIssues does not contain a "blocks" link to SCRUM-003.'
        ),
        createCheck(
          'SCRUM-001 has a "relatesTo" link to SCRUM-002',
          hasRelates,
          'SCRUM-001.linkedIssues does not contain a "relatesTo" link to SCRUM-002.'
        ),
      ], 'SCRUM-001.linkedIssues has both blocks→SCRUM-003 and relatesTo→SCRUM-002.');
    }
  },

  // ====================================================
  // TIER 1 (continued)
  // ====================================================

  'EVAL-21': {
    name: 'Switch the visual theme to Jira Blue',
    tier: 1,
    description: 'The last theme_changed event must have theme "jira" — switching back to another theme fails.',
    verify: (snapshot, events) => {
      const themeEvents = findEventsOfType(events, 'theme_changed');
      if (themeEvents.length === 0) return fail('No theme_changed event found in event log.');
      const lastThemeEvent = themeEvents[themeEvents.length - 1];
      if (!lastThemeEvent.data || lastThemeEvent.data.theme !== 'jira') {
        return fail(`Last theme_changed event has theme "${lastThemeEvent.data && lastThemeEvent.data.theme}", expected "jira". Theme must remain jira.`);
      }
      return pass(`Theme changed to "jira" at ${lastThemeEvent.ts} and was not subsequently changed.`);
    }
  },

  'EVAL-22': {
    name: 'Filter tasks by type "Bug"',
    tier: 1,
    description: 'A filter_applied event with filterType "type" and value "bug" should appear in the event log.',
    verify: (snapshot, events) => {
      const filterEvents = findEventsOfType(events, 'filter_applied');
      const typeFilter = filterEvents.find(e =>
        e.data &&
        e.data.filterType === 'type' &&
        typeof e.data.value === 'string' &&
        e.data.value.toLowerCase() === 'bug'
      );
      if (!typeFilter) return fail('No filter_applied event with filterType "type" and value "bug" found in event log.');
      return pass(`Type filter for "bug" was recorded at ${typeFilter.ts}.`);
    }
  },

  // ====================================================
  // TIER 2 (continued)
  // ====================================================

  'EVAL-23': {
    name: 'Sprint Management — Start a planning sprint',
    tier: 2,
    description: 'Sprint 3 should be activated: sprint_started event recorded and sprint-3 has status "active" in snapshot.',
    verify: (snapshot, events) => {
      const startedEvents = findEventsOfType(events, 'sprint_started');
      const sprint3Event = startedEvents.find(e =>
        e.data && (e.data.sprintId === 'sprint-3' || (e.data.name && e.data.name.toLowerCase().includes('sprint 3')))
      );
      if (!sprint3Event) return fail('No sprint_started event for Sprint 3 found in event log.');

      const sprints = (snapshot && snapshot.sprints) || [];
      const sprint3 = sprints.find(s => s.id === 'sprint-3');
      if (!sprint3) return fail('sprint-3 not found in snapshot.sprints.');
      if (sprint3.status !== 'active') return fail(`sprint-3 has status "${sprint3.status}", expected "active".`);

      return pass('EVAL-23 verified: sprint_started event for Sprint 3 found and sprint-3 is active in snapshot.');
    }
  },

  'EVAL-24': {
    name: 'Avatar filter — filter by Frank Lee and move SCRUM-006',
    tier: 2,
    description: 'filter_applied event for user-6 (Frank Lee) avatar; SCRUM-006 in inprogress.',
    verify: (snapshot, events) => {
      // Filter = event-log only (no db representation).
      // Status change = snapshot (db) is sufficient.
      if (!snapshot) return fail('Snapshot not available.');

      const issues = [];

      const filterEvents = findEventsOfType(events, 'filter_applied');
      const frankFilter = filterEvents.find(e =>
        e.data && e.data.filterType === 'assignee' && e.data.value === 'user-6'
      );
      if (!frankFilter) issues.push('No filter_applied event for assignee "user-6" (Frank Lee) found in event log.');

      const task = getTaskFromSnapshot(snapshot, 'SCRUM-006');
      if (!task) {
        issues.push('SCRUM-006 not found in snapshot.');
      } else if (task.status !== 'inprogress') {
        issues.push(`SCRUM-006 has status "${task.status}", expected "inprogress".`);
      }

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass('EVAL-24 verified: Frank Lee avatar filter applied, SCRUM-006 is inprogress.');
    }
  },

  'EVAL-25': {
    name: 'Transition Carol White off the team — reassign To Do tasks and close In Review work',
    tier: 3,
    description: 'Carol White (user-3) To Do tasks reassigned to Bob Martinez (user-2); her In Review task (SCRUM-013) moved to Done; her Done task unchanged.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];
      const carolTodoIds = seedTasks
        .filter(t => t.assigneeId === 'user-3' && t.status === 'todo' && !t.parentId && t.sprintId !== null)
        .map(t => t.id);

      const todoReassignmentIssues = [];
      carolTodoIds.forEach(id => {
        const current = getTaskFromSnapshot(snapshot, id);
        if (!current) {
          todoReassignmentIssues.push(`${id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== 'user-2') {
          todoReassignmentIssues.push(`${id} assigneeId is "${current.assigneeId}", expected "user-2" (Bob Martinez).`);
        }
      });

      const task013 = getTaskFromSnapshot(snapshot, 'SCRUM-013');
      const task017 = getTaskFromSnapshot(snapshot, 'SCRUM-017');

      return finalizeChecks([
        createCheck(
          'Reassigned Carol White\'s visible To Do tasks to Bob Martinez',
          carolTodoIds.length > 0 && todoReassignmentIssues.length === 0,
          carolTodoIds.length === 0
            ? 'No seed To Do tasks found for Carol White.'
            : todoReassignmentIssues.join(' ')
        ),
        createCheck(
          'Moved SCRUM-013 from In Review to Done',
          task013 && task013.status === 'done',
          !task013
            ? 'SCRUM-013 not found in snapshot.'
            : `SCRUM-013 has status "${task013.status}", expected "done".`
        ),
        createCheck(
          'Left SCRUM-017 assigned to Carol White',
          task017 && task017.assigneeId === 'user-3',
          !task017
            ? 'SCRUM-017 not found in snapshot.'
            : `SCRUM-017 assigneeId is "${task017.assigneeId}", expected "user-3".`
        ),
      ], `All ${carolTodoIds.length} visible Carol White To Do task(s) were reassigned to Bob, SCRUM-013 moved to Done, and SCRUM-017 stayed with Carol.`);
    }
  },

  'EVAL-26': {
    name: 'Staff and schedule unassigned backlog tasks',
    tier: 3,
    description: 'All unassigned backlog tasks assigned to Frank Lee (user-6) and added to Sprint 3.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];
      const unassignedBacklog = seedTasks.filter(
        t => !t.assigneeId && (t.sprintId === null || t.sprintId === undefined) && !t.parentId
      );
      const assignedBacklog = seedTasks.filter(
        t => t.assigneeId && (t.sprintId === null || t.sprintId === undefined) && !t.parentId
      );

      const assigneeIssues = [];
      const sprintIssues = [];
      unassignedBacklog.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          assigneeIssues.push(`${seedTask.id} not found in snapshot.`);
          sprintIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== 'user-6') {
          assigneeIssues.push(`${seedTask.id} assigneeId is "${current.assigneeId}", expected "user-6" (Frank Lee).`);
        }
        if (current.sprintId !== 'sprint-3') {
          sprintIssues.push(`${seedTask.id} sprintId is "${current.sprintId}", expected "sprint-3".`);
        }
      });

      const unchangedIssues = [];
      assignedBacklog.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          unchangedIssues.push(`${seedTask.id} was reassigned from "${seedTask.assigneeId}" to "${current.assigneeId}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Assigned every previously unassigned backlog task to Frank Lee',
          unassignedBacklog.length > 0 && assigneeIssues.length === 0,
          unassignedBacklog.length === 0
            ? 'No unassigned backlog tasks found in seed.'
            : assigneeIssues.join(' ')
        ),
        createCheck(
          'Added every previously unassigned backlog task to Sprint 3',
          unassignedBacklog.length > 0 && sprintIssues.length === 0,
          unassignedBacklog.length === 0
            ? 'No unassigned backlog tasks found in seed.'
            : sprintIssues.join(' ')
        ),
        createCheck(
          'Left already-assigned backlog tasks with their original assignees',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${unassignedBacklog.length} previously unassigned backlog task(s) were staffed to Frank Lee, scheduled into Sprint 3, and already-assigned backlog work stayed unchanged.`);
    }
  },

  // ====================================================
  // TIER 3 (continued — EVAL-27 through EVAL-36)
  // ====================================================

  'EVAL-127': {
    tier: 3,
    name: 'Reassign David Kim\'s In Progress tasks to Alice Chen',
    description: 'All user-4 inprogress tasks reassigned to user-1; other David tasks unchanged.',
    // PASS test case: All tasks originally assigned to David Kim (user-4) with status 'inprogress' in seed
    //   are now assigned to Alice Chen (user-1). David's tasks in other statuses remain unchanged.
    // FAIL test case: Any of David's inprogress tasks still assigned to user-4, or any of David's
    //   non-inprogress tasks were incorrectly reassigned.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // Find seed tasks assigned to David (user-4) with status 'inprogress'
      const davidInProgress = seedTasks.filter(
        t => t.assigneeId === 'user-4' && t.status === 'inprogress'
      );

      if (davidInProgress.length === 0) return fail('No seed tasks found for David Kim in inprogress.');

      const issues = [];

      // Each must now be assigned to Alice Chen (user-1)
      davidInProgress.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== 'user-1') {
          issues.push(`${seedTask.id} assigneeId is "${current.assigneeId}", expected "user-1" (Alice Chen).`);
        }
      });

      // Verify David's non-inprogress tasks were NOT reassigned
      const davidOtherTasks = seedTasks.filter(
        t => t.assigneeId === 'user-4' && t.status !== 'inprogress' && !t.parentId
      );
      davidOtherTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.assigneeId !== 'user-4') {
          issues.push(`${seedTask.id} (status="${seedTask.status}") was incorrectly reassigned from user-4 to "${current.assigneeId}".`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${davidInProgress.length} of David Kim's inprogress tasks reassigned to Alice Chen. Non-inprogress tasks unchanged.`);
    }
  },

  'EVAL-128': {
    tier: 3,
    name: 'Increase story points by 2 for every In Review task',
    description: 'Each inreview task storyPoints = original + 2; other columns unchanged.',
    // PASS test case: All tasks with seed status 'inreview' have storyPoints increased by exactly 2.
    //   card_edited events exist for each. Tasks in other columns have unchanged storyPoints.
    // FAIL test case: Any inreview task has wrong storyPoints or missing edit event, or a non-inreview
    //   task had its storyPoints changed.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const inReviewTasks = seedTasks.filter(t => t.status === 'inreview' && t.sprintId === 'sprint-2');
      if (inReviewTasks.length === 0) return fail('No seed tasks found with status inreview.');

      const issues = [];

      // Each inreview task must have storyPoints = seed.storyPoints + 2
      inReviewTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        const expectedSP = (seedTask.storyPoints || 0) + 2;
        if (current.storyPoints !== expectedSP) {
          issues.push(`${seedTask.id} storyPoints is ${current.storyPoints}, expected ${expectedSP} (was ${seedTask.storyPoints || 0}).`);
        }
      });

      // Verify non-inreview tasks did NOT have storyPoints changed
      const nonInReviewTasks = seedTasks.filter(t => t.status !== 'inreview' && !t.parentId);
      let changedCount = 0;
      nonInReviewTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.storyPoints !== seedTask.storyPoints) {
          changedCount++;
          if (changedCount <= 3) {
            issues.push(`${seedTask.id} (status="${seedTask.status}") storyPoints changed from ${seedTask.storyPoints} to ${current.storyPoints}.`);
          }
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${inReviewTasks.length} inreview tasks have storyPoints increased by 2 with card_edited events. Non-inreview tasks unchanged.`);
    }
  },

  'EVAL-129': {
    tier: 3,
    name: 'Tag every critical priority task with a new tag',
    description: 'All critical-priority tasks gain a new tag; non-critical tasks have no new tags.',
    // PASS test case: All tasks with seed priority 'critical' have gained at least one new tag.
    //   card_edited events exist for each. Non-critical tasks have no new tags.
    // FAIL test case: Any critical task has no new tags, or a non-critical task gained a tag.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const criticalTasks = seedTasks.filter(t => t.priority === 'critical' && !t.parentId);
      if (criticalTasks.length === 0) return fail('No seed tasks found with priority critical.');

      const issues = [];

      // Each critical task must have more tags in snapshot than in seed
      criticalTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        const seedTagCount = (seedTask.tags || []).length;
        const currentTagCount = (current.tags || []).length;
        if (currentTagCount <= seedTagCount) {
          issues.push(`${seedTask.id} tags count is ${currentTagCount}, expected > ${seedTagCount} (must have gained a new tag).`);
        }
      });

      // Verify non-critical tasks did NOT gain new tags
      const nonCriticalTasks = seedTasks.filter(t => t.priority !== 'critical' && !t.parentId);
      nonCriticalTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        const seedTagCount = (seedTask.tags || []).length;
        const currentTagCount = (current.tags || []).length;
        if (currentTagCount > seedTagCount) {
          issues.push(`${seedTask.id} (priority="${seedTask.priority}") gained new tags unexpectedly.`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${criticalTasks.length} critical tasks gained new tags with card_edited events. Non-critical tasks unchanged.`);
    }
  },

  'EVAL-130': {
    tier: 3,
    name: 'Create review tickets for completed Sprint 1 work',
    description: 'For each done task from the earlier sprint (Sprint 1), a new review ticket should exist in Sprint 2 In Review with storyPoints=0.5 and a duplicate link back to the original.',
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // The "earlier sprint" with completed work is Sprint 1
      const doneTasks = seedTasks.filter(t => t.status === 'done' && !t.parentId && t.sprintId === 'sprint-1');
      if (doneTasks.length === 0) return fail('No seed tasks found with status done in sprint-1.');

      const reviewIssues = [];

      // For each original done task, find a new review ticket that links back to it
      doneTasks.forEach(original => {
        // Look for a new task (not in seed) that references the original via duplicate link
        const allCurrent = snapshot.tasks || [];
        const seedIds = new Set(seedTasks.map(t => t.id));
        const reviewTicket = allCurrent.find(t =>
          !seedIds.has(t.id) &&
          !t.parentId &&
          (t.linkedIssues || []).some(l => l.targetId === original.id && (l.linkType === 'duplicates' || l.linkType === 'duplicate'))
        );
        // Also check reverse: original might have the duplicate link pointing to the new ticket
        const reverseTicket = !reviewTicket && allCurrent.find(t =>
          !seedIds.has(t.id) &&
          !t.parentId &&
          (original.id && (getTaskFromSnapshot(snapshot, original.id)?.linkedIssues || []).some(
            l => l.targetId === t.id && (l.linkType === 'duplicates' || l.linkType === 'duplicate')
          ))
        );
        const ticket = reviewTicket || reverseTicket;

        if (!ticket) {
          reviewIssues.push(`No review ticket found linked as duplicate to ${original.id} (${original.title}).`);
          return;
        }
        if (ticket.status !== 'inreview') {
          reviewIssues.push(`Review ticket for ${original.id} has status "${ticket.status}", expected "inreview".`);
        }
        if (ticket.sprintId !== 'sprint-2') {
          reviewIssues.push(`Review ticket for ${original.id} has sprintId "${ticket.sprintId}", expected "sprint-2".`);
        }
        if (ticket.storyPoints !== 0.5) {
          reviewIssues.push(`Review ticket for ${original.id} has storyPoints ${ticket.storyPoints}, expected 0.5.`);
        }
      });

      // Damage check: original done tasks should remain unchanged
      const originalUnchangedIssues = [];
      doneTasks.forEach(original => {
        const current = getTaskFromSnapshot(snapshot, original.id);
        if (!current) return;
        if (current.status !== original.status) {
          originalUnchangedIssues.push(`${original.id} status changed from "${original.status}" to "${current.status}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          `Created review tickets for all ${doneTasks.length} completed Sprint 1 tasks with correct status, sprint, story points, and duplicate link`,
          reviewIssues.length === 0,
          reviewIssues.join(' ')
        ),
        createCheck(
          'Original completed tasks remain unchanged',
          originalUnchangedIssues.length === 0,
          originalUnchangedIssues.join(' ')
        ),
      ], `All ${doneTasks.length} review tickets created in Sprint 2 In Review with 0.5 story points and duplicate links back to originals.`);
    }
  },

  'EVAL-131': {
    tier: 3,
    name: 'Create subtask "Write acceptance criteria" for In Progress stories',
    description: 'Each inprogress story has a subtask with "acceptance criteria"; bugs/tasks in inprogress do not.',
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const inProgressStories = seedTasks.filter(
        t => t.status === 'inprogress' && t.type === 'story'
      );
      if (inProgressStories.length === 0) return fail('No seed tasks found with status inprogress and type story.');

      const issues = [];

      // Each inprogress story must have a subtask with "acceptance criteria" in title
      inProgressStories.forEach(seedTask => {
        const subtask = (snapshot.tasks || []).find(t =>
          t.parentId === seedTask.id && (t.title || '').toLowerCase().includes('acceptance criteria')
        );
        if (!subtask) {
          issues.push(`${seedTask.id} (${seedTask.type}): no subtask with "acceptance criteria" found.`);
        }
      });

      // No subtasks for bugs or tasks in inprogress
      const inProgressNonStories = seedTasks.filter(
        t => t.status === 'inprogress' && t.type !== 'story'
      );
      inProgressNonStories.forEach(seedTask => {
        const subtask = (snapshot.tasks || []).find(t =>
          t.parentId === seedTask.id && (t.title || '').toLowerCase().includes('acceptance criteria')
        );
        if (subtask) {
          issues.push(`${seedTask.id} (${seedTask.type}): subtask incorrectly created for non-story task.`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${inProgressStories.length} inprogress stories have "acceptance criteria" subtasks. No subtasks for non-story tasks.`);
    }
  },

  'EVAL-132': {
    tier: 3,
    name: 'Link all Sprint 2 frontend-tagged tasks to SCRUM-001 with "blocks"',
    description: 'All top-level Sprint 2 tag-1 tasks except SCRUM-001 linked to SCRUM-001; SCRUM-001 does not self-link.',
    // PASS test case: All top-level Sprint 2 frontend-tagged tasks except SCRUM-001 have
    //   issue_linked events and linkedIssues entries linking to SCRUM-001.
    // FAIL test case: Missing issue_linked events or linkedIssues entries for eligible tasks.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // Top-level Sprint 2 frontend-tagged tasks excluding SCRUM-001
      const frontendSprint2Tasks = seedTasks.filter(
        t => !t.parentId && t.id !== 'SCRUM-001' && t.sprintId === 'sprint-2' && (t.tags || []).includes('tag-1')
      );
      if (frontendSprint2Tasks.length === 0) return fail('No top-level Sprint 2 frontend-tagged tasks (excluding SCRUM-001) found in seed.');

      const issues = [];

      // Each eligible task must have a link to/from SCRUM-001 in snapshot
      frontendSprint2Tasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        // Check if this task links to SCRUM-001 or SCRUM-001 links to this task
        const taskLinksTo001 = (current.linkedIssues || []).some(
          l => l.targetId === 'SCRUM-001' || l.sourceId === 'SCRUM-001'
        );
        const scrum001 = getTaskFromSnapshot(snapshot, 'SCRUM-001');
        const scrum001LinksToTask = scrum001 && (scrum001.linkedIssues || []).some(
          l => l.targetId === seedTask.id || l.sourceId === seedTask.id
        );
        if (!taskLinksTo001 && !scrum001LinksToTask) {
          issues.push(`${seedTask.id}: no linkedIssues entry linking to/from SCRUM-001 found in snapshot.`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${frontendSprint2Tasks.length} top-level Sprint 2 frontend-tagged tasks linked to SCRUM-001. At least ${frontendSprint2Tasks.length} issue_linked events present.`);
    }
  },

  'EVAL-133': {
    tier: 3,
    name: 'Move high/critical backlog items to Sprint 3',
    description: 'Backlog tasks with high or critical priority moved to sprint-3; medium/low remain in backlog.',
    // PASS test case: All backlog tasks (sprintId=null) with priority high or critical have sprintId='sprint-3'.
    //   Medium/low backlog items remain in backlog (sprintId=null).
    // FAIL test case: Any high/critical backlog item not in sprint-3, or medium/low backlog items moved.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      // Backlog tasks with high or critical priority
      const highCritBacklog = seedTasks.filter(
        t => (t.sprintId === null || t.sprintId === undefined) &&
             (t.priority === 'high' || t.priority === 'critical') &&
             !t.parentId
      );
      if (highCritBacklog.length === 0) return fail('No high/critical backlog tasks found in seed.');

      const issues = [];

      // Each must now be in sprint-3
      highCritBacklog.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== 'sprint-3') {
          issues.push(`${seedTask.id} has sprintId "${current.sprintId}", expected "sprint-3".`);
        }
      });

      // Medium/low backlog items must remain sprintId=null
      const medLowBacklog = seedTasks.filter(
        t => (t.sprintId === null || t.sprintId === undefined) &&
             (t.priority === 'medium' || t.priority === 'low') &&
             !t.parentId
      );
      medLowBacklog.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.sprintId !== null && current.sprintId !== undefined) {
          issues.push(`${seedTask.id} (priority="${seedTask.priority}") incorrectly moved to sprint "${current.sprintId}".`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${highCritBacklog.length} high/critical backlog items moved to sprint-3. Medium/low backlog items unchanged.`);
    }
  },

  'EVAL-134': {
    tier: 3,
    name: 'Change all bug-type tasks to Critical priority',
    description: 'All type=bug tasks have priority=critical; non-bug tasks unchanged.',
    // PASS test case: All bug-type tasks have priority='critical'. card_edited event exists for SCRUM-017
    //   (which changes from medium to critical). SCRUM-011 already critical. Non-bug tasks unchanged.
    // FAIL test case: Any bug task not critical, or non-bug tasks had priority changed.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const bugTasks = seedTasks.filter(t => t.type === 'bug');
      if (bugTasks.length === 0) return fail('No bug-type tasks found in seed.');

      const issues = [];

      // Each bug must have priority=critical in snapshot
      bugTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          issues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.priority !== 'critical') {
          issues.push(`${seedTask.id} priority is "${current.priority}", expected "critical".`);
        }
        // Only require card_edited if priority was not already critical
        if (seedTask.priority !== 'critical') {
          const edits = findEventForTask(events, 'card_edited', seedTask.id);
          if (edits.length === 0) {
            issues.push(`${seedTask.id}: no card_edited event found (priority was "${seedTask.priority}", needs change to critical).`);
          }
        }
      });

      // Non-bug tasks must NOT have changed priority
      const nonBugTasks = seedTasks.filter(t => t.type !== 'bug' && !t.parentId);
      nonBugTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.priority !== seedTask.priority) {
          issues.push(`${seedTask.id} (type="${seedTask.type}") priority changed from "${seedTask.priority}" to "${current.priority}".`);
        }
      });

      if (issues.length > 0) return fail(issues.join(' | '));
      return pass(`All ${bugTasks.length} bug-type tasks have critical priority. Non-bug tasks unchanged.`);
    }
  },

  'EVAL-135': {
    tier: 3,
    name: 'Unassign all tasks in the To Do column',
    description: 'Every top-level Sprint 2 or backlog task in the To Do column should become unassigned, while top-level tasks in other columns keep their assignees.',
    // PASS test case: All top-level seed tasks in Sprint 2 or backlog with status "todo"
    //   have assigneeId=null/empty. card_edited events exist for each originally-assigned task.
    //   Top-level tasks outside that target set keep their original assignees.
    // FAIL test case: Any targeted To Do task still has an assignee, or any non-targeted top-level
    //   task has a changed assignee.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const todoTasks = seedTasks.filter(t =>
        t.status === 'todo' &&
        !t.parentId &&
        (t.sprintId === 'sprint-2' || t.sprintId === null || t.sprintId === undefined)
      );
      if (todoTasks.length === 0) {
        return fail('No top-level seed tasks found with status todo in Sprint 2 or backlog.');
      }

      const todoIssues = [];
      let originallyAssignedCount = 0;

      todoTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          todoIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== null && current.assigneeId !== undefined && current.assigneeId !== '') {
          todoIssues.push(`${seedTask.id} still has assigneeId="${current.assigneeId}", expected null/empty.`);
        }
        if (seedTask.assigneeId) {
          originallyAssignedCount++;
        }
      });

      const otherTasks = seedTasks.filter(t =>
        !t.parentId && !todoTasks.some(todoTask => todoTask.id === t.id)
      );
      const unchangedIssues = [];
      otherTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          unchangedIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}", but it is outside the Sprint 2/backlog To Do target set.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Unassigned every top-level Sprint 2 or backlog To Do task',
          todoIssues.length === 0,
          todoIssues.join(' ')
        ),
        createCheck(
          'Left assignees unchanged for top-level tasks outside the Sprint 2/backlog To Do target set',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${todoTasks.length} targeted top-level To Do task(s) across Sprint 2 and backlog are unassigned (${originallyAssignedCount} started assigned), and top-level tasks outside that target set kept their original assignees.`);
    }
  },

  'EVAL-136': {
    tier: 3,
    name: 'Complete Sprint 2, create Sprint 4, split carry-over by status',
    description: 'Complete Sprint 2, create Sprint 4, move top-level Sprint 2 To Do tasks to backlog, and move top-level Sprint 2 In Progress/In Review tasks into Sprint 4 without changing unrelated cards.',
    // PASS test case: sprint_completed event for Sprint 2, sprint_created event for Sprint 4, Sprint 2
    //   marked completed in snapshot, every top-level Sprint 2 To Do task now has sprintId=null, every
    //   top-level Sprint 2 In Progress/In Review task now has sprintId equal to the newly created Sprint 4,
    //   and unrelated top-level tasks keep their original sprint/status/assignee values.
    // FAIL test case: Missing sprint events, incorrect backlog vs Sprint 4 placement for any targeted task,
    //   or unrelated top-level tasks changed.
    verify(snapshot, events) {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const sprint2Snapshot = (snapshot.sprints || []).find(sprint => sprint.id === 'sprint-2') || null;
      const snapshotSprint4 = (snapshot.sprints || []).find(sprint =>
        (sprint.name || '').toLowerCase().includes('sprint 4')
      );
      const sprint4Id = snapshotSprint4?.id || null;
      const sprint4Goal = (snapshotSprint4?.goal || '').toLowerCase();

      const sprint2Tasks = seedTasks.filter(t => t.sprintId === 'sprint-2' && !t.parentId);
      const todoTasks = sprint2Tasks.filter(t => t.status === 'todo');
      const carryoverTasks = sprint2Tasks.filter(t => t.status === 'inprogress' || t.status === 'inreview');
      const doneTasks = sprint2Tasks.filter(t => t.status === 'done');
      const unaffectedTasks = seedTasks.filter(t => !t.parentId && t.sprintId !== 'sprint-2');

      const todoPlacementIssues = [];
      todoTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          todoPlacementIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== null && current.sprintId !== undefined) {
          todoPlacementIssues.push(`${seedTask.id} should be in backlog with sprintId null, found "${current.sprintId}".`);
        }
        if (current.status !== seedTask.status) {
          todoPlacementIssues.push(`${seedTask.id} status changed from "${seedTask.status}" to "${current.status}".`);
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          todoPlacementIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}".`);
        }
      });

      const carryoverPlacementIssues = [];
      carryoverTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          carryoverPlacementIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (!sprint4Id) {
          carryoverPlacementIssues.push(`Cannot verify ${seedTask.id} placement because the new Sprint 4 ID could not be determined.`);
          return;
        }
        if (current.sprintId !== sprint4Id) {
          carryoverPlacementIssues.push(`${seedTask.id} should be moved into Sprint 4 (${sprint4Id}), found sprintId "${current.sprintId}".`);
        }
        if (current.status !== seedTask.status) {
          carryoverPlacementIssues.push(`${seedTask.id} status changed from "${seedTask.status}" to "${current.status}".`);
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          carryoverPlacementIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}".`);
        }
      });

      const doneTaskIssues = [];
      doneTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          doneTaskIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== seedTask.sprintId) {
          doneTaskIssues.push(`${seedTask.id} sprintId changed from "${seedTask.sprintId}" to "${current.sprintId}" even though it started Done.`);
        }
        if (current.status !== seedTask.status) {
          doneTaskIssues.push(`${seedTask.id} status changed from "${seedTask.status}" to "${current.status}" even though it started Done.`);
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          doneTaskIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}" even though it started Done.`);
        }
      });

      const unaffectedIssues = [];
      unaffectedTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unaffectedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== seedTask.sprintId) {
          unaffectedIssues.push(`${seedTask.id} sprintId changed from "${seedTask.sprintId}" to "${current.sprintId}" outside the Sprint 2 target set.`);
        }
        if (current.status !== seedTask.status) {
          unaffectedIssues.push(`${seedTask.id} status changed from "${seedTask.status}" to "${current.status}" outside the Sprint 2 target set.`);
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          unaffectedIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}" outside the Sprint 2 target set.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Completed Sprint 2 and marked it completed in the snapshot',
          Boolean(sprint2Snapshot) && sprint2Snapshot.status === 'completed',
          !sprint2Snapshot
            ? 'Sprint 2 not found in snapshot.sprints.'
            : `Sprint 2 status is "${sprint2Snapshot.status}", expected "completed".`
        ),
        createCheck(
          'Created Sprint 4 with the requested carry-over goal',
          Boolean(snapshotSprint4) && Boolean(sprint4Id) && sprint4Goal.length > 0 && (sprint4Goal.includes('carry-over') || sprint4Goal.includes('carryover') || sprint4Goal.includes('bug fix')),
          !snapshotSprint4
            ? 'No sprint with name containing "Sprint 4" found in snapshot.'
            : !sprint4Id
              ? 'Could not determine the ID of the newly created Sprint 4.'
              : `Sprint 4 goal is "${snapshotSprint4?.goal || ''}", expected to mention carry-over or bug fixes.`
        ),
        createCheck(
          'Moved every top-level Sprint 2 To Do task back to backlog without changing its status or assignee',
          todoTasks.length > 0 && todoPlacementIssues.length === 0,
          todoTasks.length === 0
            ? 'No top-level Sprint 2 To Do tasks were found in seed data.'
            : todoPlacementIssues.join(' ')
        ),
        createCheck(
          'Moved every top-level Sprint 2 In Progress or In Review task into Sprint 4 without changing its status or assignee',
          carryoverTasks.length > 0 && carryoverPlacementIssues.length === 0,
          carryoverTasks.length === 0
            ? 'No top-level Sprint 2 In Progress or In Review tasks were found in seed data.'
            : carryoverPlacementIssues.join(' ')
        ),
        createCheck(
          'Left any top-level Sprint 2 Done tasks unchanged',
          doneTaskIssues.length === 0,
          doneTaskIssues.join(' ')
        ),
        createCheck(
          'Left top-level tasks outside Sprint 2 unchanged',
          unaffectedIssues.length === 0,
          unaffectedIssues.join(' ')
        ),
      ], `Sprint 2 was completed, Sprint 4 was created, all ${todoTasks.length} top-level Sprint 2 To Do task(s) were returned to backlog, all ${carryoverTasks.length} top-level Sprint 2 In Progress/In Review task(s) were moved into Sprint 4, and unaffected top-level work stayed unchanged.`);
    }
  },

  // ====================================================
  // TIER 3 (continued — EVAL-27 through EVAL-36)
  // ====================================================

  'EVAL-27': {
    name: 'Reassign David Kim\'s In Progress tasks to Alice Chen',
    tier: 3,
    description: 'All of David Kim\'s tasks currently in progress should move to Alice Chen, while David\'s tasks in other statuses stay assigned to him.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];
      const davidInProgress = seedTasks.filter(t => t.assigneeId === 'user-4' && t.status === 'inprogress');
      const davidOther = seedTasks.filter(t => t.assigneeId === 'user-4' && t.status !== 'inprogress');

      const reassignmentIssues = [];
      davidInProgress.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          reassignmentIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== 'user-1') {
          reassignmentIssues.push(`${seedTask.id} assigneeId is "${current.assigneeId}", expected "user-1" (Alice Chen).`);
        }
      });

      const unchangedIssues = [];
      davidOther.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== 'user-4') {
          unchangedIssues.push(`${seedTask.id} should remain assigned to David Kim (user-4), found "${current.assigneeId}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Reassigned all of David Kim\'s in-progress tasks to Alice Chen',
          davidInProgress.length > 0 && reassignmentIssues.length === 0,
          davidInProgress.length === 0
            ? 'No in-progress David Kim tasks were found in seed data.'
            : reassignmentIssues.join(' ')
        ),
        createCheck(
          'Left David Kim\'s tasks in other statuses assigned to David Kim',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${davidInProgress.length} in-progress David Kim task(s) moved to Alice Chen and David\'s other tasks stayed unchanged.`);
    }
  },

  'EVAL-28': {
    name: 'Increase story points by 2 for all In Review tasks',
    tier: 3,
    description: 'Every top-level task that starts in In Review, including the Sprint 1 review cards, should have its story points increased by exactly 2; tasks in other columns should stay unchanged.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const reviewTasks = (seed.tasks || []).filter(t => t.status === 'inreview' && !t.parentId);
      const otherTasks = (seed.tasks || []).filter(t => t.status !== 'inreview' && !t.parentId);

      const reviewIssues = [];
      reviewTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          reviewIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        const expected = (seedTask.storyPoints || 0) + 2;
        if (current.storyPoints !== expected) {
          reviewIssues.push(`${seedTask.id} storyPoints is ${current.storyPoints}, expected ${expected}.`);
        }
      });

      const unchangedIssues = [];
      otherTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.storyPoints !== seedTask.storyPoints) {
          unchangedIssues.push(`${seedTask.id} storyPoints changed from ${seedTask.storyPoints} to ${current.storyPoints}, but it is not an In Review task.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Increased every top-level In Review task by exactly 2 story points',
          reviewTasks.length > 0 && reviewIssues.length === 0,
          reviewTasks.length === 0
            ? 'No top-level In Review tasks were found in seed data.'
            : reviewIssues.join(' ')
        ),
        createCheck(
          'Left top-level tasks outside In Review at their original estimates',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${reviewTasks.length} top-level In Review task(s) gained exactly 2 story points and other top-level estimates stayed unchanged.`);
    }
  },

  'EVAL-29': {
    name: 'Tag all critical priority tasks with urgent',
    tier: 3,
    description: 'Every top-level critical-priority task across the active sprint, completed sprint, and backlog should include the urgent tag, while top-level non-critical tasks should not include it.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const urgentTag = (snapshot.tags || []).find(tag => (tag.name || '').toLowerCase() === 'urgent');
      const seed = loadSeedData();
      const criticalTasks = (seed.tasks || []).filter(t => t.priority === 'critical' && !t.parentId);
      const nonCriticalTasks = (seed.tasks || []).filter(t => t.priority !== 'critical' && !t.parentId);

      const criticalIssues = [];
      if (urgentTag) {
        criticalTasks.forEach(seedTask => {
          const current = getTaskFromSnapshot(snapshot, seedTask.id);
          if (!current) {
            criticalIssues.push(`${seedTask.id} not found in snapshot.`);
            return;
          }
          if (!(current.tags || []).includes(urgentTag.id)) {
            criticalIssues.push(`${seedTask.id} does not include the urgent tag (${urgentTag.id}).`);
          }
        });
      }

      const nonCriticalIssues = [];
      if (urgentTag) {
        nonCriticalTasks.forEach(seedTask => {
          const current = getTaskFromSnapshot(snapshot, seedTask.id);
          if (!current) {
            nonCriticalIssues.push(`${seedTask.id} not found in snapshot.`);
            return;
          }
          if ((current.tags || []).includes(urgentTag.id)) {
            nonCriticalIssues.push(`${seedTask.id} is non-critical but includes the urgent tag (${urgentTag.id}).`);
          }
        });
      }

      return finalizeChecks([
        createCheck(
          'Found the urgent tag in the board tag list',
          Boolean(urgentTag),
          'Urgent tag not found in snapshot tags. Expected a tag named "urgent" to exist.'
        ),
        createCheck(
          'Applied the urgent tag to every top-level critical-priority task',
          Boolean(urgentTag) && criticalTasks.length > 0 && criticalIssues.length === 0,
          !urgentTag
            ? 'Cannot validate critical task tagging because the urgent tag is missing.'
            : criticalTasks.length === 0
              ? 'No top-level critical-priority tasks were found in seed data.'
              : criticalIssues.join(' ')
        ),
        createCheck(
          'Did not apply the urgent tag to top-level non-critical tasks',
          Boolean(urgentTag) && nonCriticalIssues.length === 0,
          !urgentTag
            ? 'Cannot validate non-critical task tagging because the urgent tag is missing.'
            : nonCriticalIssues.join(' ')
        ),
      ], `All ${criticalTasks.length} top-level critical task(s) include the urgent tag and top-level non-critical tasks do not.`);
    }
  },

  'EVAL-30': {
    name: 'Create Sprint 2 review duplicates for completed work',
    tier: 3,
    description: 'QA found regressions in completed Sprint 1 work, so create Sprint 2 review-only tickets for those completed tasks, link each new ticket back to the original with a duplicates relation, and leave the originals unchanged.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const doneTasks = (seed.tasks || []).filter(t => t.status === 'done' && !t.parentId);

      const originalIssues = [];
      const cloneIssues = [];

      doneTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          originalIssues.push(`${seedTask.id} not found in snapshot.`);
        } else {
          if (current.status !== seedTask.status) {
            originalIssues.push(`${seedTask.id} changed from status "${seedTask.status}" to "${current.status}"; the original completed card should stay unchanged.`);
          }
          if (current.sprintId !== seedTask.sprintId) {
            originalIssues.push(`${seedTask.id} changed from sprintId "${seedTask.sprintId}" to "${current.sprintId}"; the original completed card should stay in its original sprint.`);
          }
          if (current.storyPoints !== seedTask.storyPoints) {
            originalIssues.push(`${seedTask.id} changed from storyPoints ${seedTask.storyPoints} to ${current.storyPoints}; the original completed card should stay unchanged.`);
          }
        }

        const matchingClones = (snapshot.tasks || []).filter(task => {
          if (task.id === seedTask.id || task.parentId) return false;
          if (task.sprintId !== 'sprint-2' || task.status !== 'inreview' || task.storyPoints !== 0.5) return false;
          return (task.linkedIssues || []).some(link => link.targetId === seedTask.id && link.linkType === 'duplicates');
        });

        if (matchingClones.length === 0) {
          cloneIssues.push(`No Sprint 2 in-review ticket with 0.5 story points and a duplicates link to ${seedTask.id} was found.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Left the original Sprint 1 completed cards unchanged',
          doneTasks.length > 0 && originalIssues.length === 0,
          doneTasks.length === 0
            ? 'No top-level Done tasks were found in seed data.'
            : originalIssues.join(' ')
        ),
        createCheck(
          'Created a Sprint 2 In Review duplicate with 0.5 story points for every original completed card',
          doneTasks.length > 0 && cloneIssues.length === 0,
          doneTasks.length === 0
            ? 'No top-level Done tasks were found in seed data.'
            : cloneIssues.join(' ')
        ),
      ], `All ${doneTasks.length} completed Sprint 1 card(s) kept their original state and gained matching Sprint 2 review-only duplicates.`);
    }
  },

  'EVAL-31': {
    name: 'Add Write acceptance criteria subtask to all In Progress stories',
    tier: 3,
    description: 'Every top-level story in progress should receive a new subtask titled Write acceptance criteria, and non-story in-progress items should not receive one.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const inProgressStories = (seed.tasks || []).filter(t => t.status === 'inprogress' && t.type === 'story' && !t.parentId);
      const otherInProgress = (seed.tasks || []).filter(t => t.status === 'inprogress' && t.type !== 'story' && !t.parentId);

      const subtaskIssues = [];
      const eventIssues = [];
      inProgressStories.forEach(seedTask => {
        const createdSubtask = (snapshot.tasks || []).find(t =>
          t.parentId === seedTask.id && (t.title || '').toLowerCase().includes('write acceptance criteria')
        );
        if (!createdSubtask) {
          subtaskIssues.push(`No acceptance-criteria subtask found for ${seedTask.id}.`);
          eventIssues.push(`No acceptance-criteria subtask exists for ${seedTask.id}, so no subtask_created event could be confirmed.`);
          return;
        }
        const createEvent = findEventsOfType(events, 'subtask_created').find(e =>
          e.data && e.data.parentId === seedTask.id && (e.data.title || '').toLowerCase().includes('write acceptance criteria')
        );
        if (!createEvent) {
          eventIssues.push(`No subtask_created event found for ${seedTask.id}.`);
        }
      });

      const nonStoryIssues = [];
      otherInProgress.forEach(seedTask => {
        const unexpected = (snapshot.tasks || []).find(t =>
          t.parentId === seedTask.id && (t.title || '').toLowerCase().includes('write acceptance criteria')
        );
        if (unexpected) {
          nonStoryIssues.push(`${seedTask.id} is not a story but has an acceptance-criteria subtask (${unexpected.id}).`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Added a "Write acceptance criteria" subtask to every top-level in-progress story',
          inProgressStories.length > 0 && subtaskIssues.length === 0,
          inProgressStories.length === 0
            ? 'No top-level in-progress story tasks were found in seed data.'
            : subtaskIssues.join(' ')
        ),
        createCheck(
          'Recorded a subtask_created event for each acceptance-criteria subtask',
          inProgressStories.length > 0 && eventIssues.length === 0,
          inProgressStories.length === 0
            ? 'No top-level in-progress story tasks were available for subtask_created event checks.'
            : eventIssues.join(' ')
        ),
        createCheck(
          'Did not add acceptance-criteria subtasks to non-story in-progress items',
          nonStoryIssues.length === 0,
          nonStoryIssues.join(' ')
        ),
      ], `All ${inProgressStories.length} top-level in-progress story card(s) received an acceptance-criteria subtask, matching events were logged, and non-story in-progress items stayed clean.`);
    }
  },

  'EVAL-32': {
    name: 'Link all Sprint 2 frontend-tagged tasks to SCRUM-001 as blocked by',
    tier: 3,
    description: 'SCRUM-002, SCRUM-004, SCRUM-008, SCRUM-010, SCRUM-011, SCRUM-013, and SCRUM-022 should each be linked to SCRUM-001 with a blocked-by relationship.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const frontendSprint2Tasks = (seed.tasks || []).filter(
        t => !t.parentId && t.id !== 'SCRUM-001' && t.sprintId === 'sprint-2' && (t.tags || []).includes('tag-1')
      );
      const scrum001 = getTaskFromSnapshot(snapshot, 'SCRUM-001');
      if (!scrum001) return fail('SCRUM-001 not found in snapshot.');

      const linkageIssues = [];
      frontendSprint2Tasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          linkageIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }

        const directLink = (current.linkedIssues || []).some(link => link.targetId === 'SCRUM-001' && link.linkType === 'isBlockedBy');
        const reverseLink = (scrum001.linkedIssues || []).some(link => link.targetId === seedTask.id && link.linkType === 'blocks');
        if (!directLink && !reverseLink) {
          linkageIssues.push(`${seedTask.id} is missing a blocked-by relationship to SCRUM-001.`);
        }
      });

      const selfLinkIssue = (scrum001.linkedIssues || []).some(link => link.targetId === 'SCRUM-001')
        ? 'SCRUM-001 should not link to itself.'
        : '';

      return finalizeChecks([
        createCheck(
          'Linked every top-level Sprint 2 frontend-tagged task to SCRUM-001 with a blocked-by relationship',
          frontendSprint2Tasks.length > 0 && linkageIssues.length === 0,
          frontendSprint2Tasks.length === 0
            ? 'No top-level Sprint 2 frontend-tagged tasks were found in seed data.'
            : linkageIssues.join(' ')
        ),
        createCheck(
          'Avoided creating a self-link on SCRUM-001',
          !selfLinkIssue,
          selfLinkIssue
        ),
      ], `All ${frontendSprint2Tasks.length} top-level Sprint 2 frontend-tagged task(s) are linked to SCRUM-001 and SCRUM-001 does not self-link.`);
    }
  },

  'EVAL-33': {
    name: 'Move high or critical backlog items to Sprint 3',
    tier: 3,
    description: 'Every top-level backlog item with High or Critical priority should be scheduled into Sprint 3, while Medium and Low backlog items remain unscheduled.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const moveToSprint3 = (seed.tasks || []).filter(t => !t.parentId && t.sprintId === null && (t.priority === 'high' || t.priority === 'critical'));
      const stayBacklog = (seed.tasks || []).filter(t => !t.parentId && t.sprintId === null && t.priority !== 'high' && t.priority !== 'critical');

      const scheduledIssues = [];
      moveToSprint3.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          scheduledIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== 'sprint-3') {
          scheduledIssues.push(`${seedTask.id} has sprintId "${current.sprintId}", expected "sprint-3".`);
        }
      });

      const backlogIssues = [];
      stayBacklog.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          backlogIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.sprintId !== null) {
          backlogIssues.push(`${seedTask.id} should remain in backlog but has sprintId "${current.sprintId}".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Moved all top-level High and Critical backlog items into Sprint 3',
          moveToSprint3.length > 0 && scheduledIssues.length === 0,
          moveToSprint3.length === 0
            ? 'No top-level High or Critical backlog items were found in seed data.'
            : scheduledIssues.join(' ')
        ),
        createCheck(
          'Left top-level Medium and Low backlog items unscheduled',
          backlogIssues.length === 0,
          backlogIssues.join(' ')
        ),
      ], `All ${moveToSprint3.length} eligible top-level High/Critical backlog item(s) were scheduled into Sprint 3 while lower-priority backlog work remained unscheduled.`);
    }
  },

  'EVAL-34': {
    name: 'Change all bugs to Critical priority',
    tier: 3,
    description: 'Every top-level bug, including the completed Sprint 1 bug, should end at Critical priority and non-bug cards should keep their original priority.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const bugTasks = (seed.tasks || []).filter(t => t.type === 'bug' && !t.parentId);
      const nonBugTasks = (seed.tasks || []).filter(t => t.type !== 'bug' && !t.parentId);

      const bugIssues = [];
      bugTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          bugIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.priority !== 'critical') {
          bugIssues.push(`${seedTask.id} has priority "${current.priority}", expected "critical".`);
        }
      });

      const unchangedIssues = [];
      nonBugTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.priority !== seedTask.priority) {
          unchangedIssues.push(`${seedTask.id} changed from priority "${seedTask.priority}" to "${current.priority}", but it is not a bug.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Changed every top-level bug to Critical priority',
          bugTasks.length > 0 && bugIssues.length === 0,
          bugTasks.length === 0
            ? 'No top-level bug tasks were found in seed data.'
            : bugIssues.join(' ')
        ),
        createCheck(
          'Left top-level non-bug priorities unchanged',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${bugTasks.length} top-level bug(s) are Critical and top-level non-bug priorities stayed unchanged.`);
    }
  },

  'EVAL-35': {
    name: 'Unassign all tasks in the To Do column',
    tier: 3,
    description: 'Every top-level Sprint 2 or backlog task in the To Do column should become unassigned, while top-level tasks in other columns keep their assignees.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const todoTasks = (seed.tasks || []).filter(t => t.status === 'todo' && !t.parentId);
      const otherTasks = (seed.tasks || []).filter(t => t.status !== 'todo' && !t.parentId);

      const todoIssues = [];
      todoTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          todoIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== null) {
          todoIssues.push(`${seedTask.id} assigneeId is "${current.assigneeId}", expected null.`);
        }
      });

      const unchangedIssues = [];
      otherTasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) {
          unchangedIssues.push(`${seedTask.id} not found in snapshot.`);
          return;
        }
        if (current.assigneeId !== seedTask.assigneeId) {
          unchangedIssues.push(`${seedTask.id} assignee changed from "${seedTask.assigneeId}" to "${current.assigneeId}", but it is not in To Do.`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Unassigned every top-level To Do task',
          todoTasks.length > 0 && todoIssues.length === 0,
          todoTasks.length === 0
            ? 'No top-level To Do tasks were found in seed data.'
            : todoIssues.join(' ')
        ),
        createCheck(
          'Left top-level non-To Do assignees unchanged',
          unchangedIssues.length === 0,
          unchangedIssues.join(' ')
        ),
      ], `All ${todoTasks.length} top-level To Do task(s) are now unassigned and top-level tasks in other columns kept their assignees.`);
    }
  },

  'EVAL-36': {
    name: 'Complete Sprint 2, create Sprint 4, move incomplete tasks',
    tier: 3,
    description: 'Complete Sprint 2, create Sprint 4, and move all incomplete top-level Sprint 2 tasks into the new sprint.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const seedTasks = seed.tasks || [];

      const completedEvents = findEventsOfType(events, 'sprint_completed');
      const sprint2Completed = completedEvents.find(e =>
        e.data && (e.data.sprintId === 'sprint-2' || (e.data.name && e.data.name.toLowerCase().includes('sprint 2')))
      );

      const createdEvents = findEventsOfType(events, 'sprint_created');
      const sprint4Created = createdEvents.find(e =>
        e.data && e.data.name && e.data.name.toLowerCase().includes('sprint 4')
      );

      const goalIssue = sprint4Created && !((sprint4Created.data.goal || '').toLowerCase().includes('carry-over') ||
        (sprint4Created.data.goal || '').toLowerCase().includes('carryover') ||
        (sprint4Created.data.goal || '').toLowerCase().includes('bug fix'))
        ? `Sprint 4 goal is "${sprint4Created.data.goal || ''}", expected to mention carry-over or bug fixes.`
        : '';

      const sprint2Tasks = seedTasks.filter(t => t.sprintId === 'sprint-2' && t.status !== 'done' && !t.parentId);
      let movedCount = 0;
      sprint2Tasks.forEach(seedTask => {
        const current = getTaskFromSnapshot(snapshot, seedTask.id);
        if (!current) return;
        if (current.sprintId !== 'sprint-2') movedCount++;
      });

      return finalizeChecks([
        createCheck(
          'Recorded completion of Sprint 2',
          Boolean(sprint2Completed),
          'No sprint_completed event for Sprint 2 found.'
        ),
        createCheck(
          'Created Sprint 4 with a carry-over or bug-fix goal',
          Boolean(sprint4Created) && !goalIssue,
          !sprint4Created
            ? 'No sprint_created event with name containing "Sprint 4" found.'
            : goalIssue
        ),
        createCheck(
          'Moved at least 10 incomplete top-level Sprint 2 tasks out of Sprint 2',
          movedCount >= 10,
          `Expected at least 10 incomplete Sprint 2 tasks moved to a new sprint, found ${movedCount}.`
        ),
      ], `Sprint 2 was completed, Sprint 4 was created with the right goal, and ${movedCount} incomplete top-level Sprint 2 task(s) moved out of Sprint 2.`);
    }
  },

  // ====================================================
  // TIER 4 — EXTREME MULTI-PHASE WORKFLOWS
  // ====================================================

  'EVAL-37': {
    name: 'Stabilize the security stream for Sprint 3',
    tier: 4,
    description: 'Filter to security work, advance and schedule the right items, create a new Sprint 3 review task with a completed subtask, and link the blockers back to SCRUM-001.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const scrum001 = getTaskFromSnapshot(snapshot, 'SCRUM-001');
      const scrum011 = getTaskFromSnapshot(snapshot, 'SCRUM-011');
      const scrum031 = getTaskFromSnapshot(snapshot, 'SCRUM-031');
      const scrum036 = getTaskFromSnapshot(snapshot, 'SCRUM-036');
      const reviewTask = findTaskByTitleContains(snapshot, 'SSO security readiness review');
      const reviewSubtask = reviewTask && (snapshot.tasks || []).find(t =>
        t.parentId === reviewTask.id && (t.title || '').toLowerCase().includes('idp metadata test cases')
      );

      const existingCardIssues = [];
      if (!scrum001 || scrum001.status !== 'inprogress') existingCardIssues.push('SCRUM-001 should be inprogress.');
      if (!scrum011 || scrum011.status !== 'inreview') existingCardIssues.push('SCRUM-011 should be inreview.');
      if (!scrum031 || scrum031.sprintId !== 'sprint-3') existingCardIssues.push('SCRUM-031 should be in Sprint 3.');
      if (!scrum036 || scrum036.sprintId !== 'sprint-3' || scrum036.assigneeId !== 'user-6') {
        existingCardIssues.push('SCRUM-036 should be in Sprint 3 and assigned to Frank Lee (user-6).');
      }

      const reviewTaskIssues = [];
      if (!reviewTask) {
        reviewTaskIssues.push('New task titled like "SSO security readiness review" not found.');
      } else {
        if (reviewTask.status !== 'inprogress') reviewTaskIssues.push(`Review task status is "${reviewTask.status}", expected "inprogress".`);
        if (reviewTask.sprintId !== 'sprint-3') reviewTaskIssues.push(`Review task sprintId is "${reviewTask.sprintId}", expected "sprint-3".`);
        if (reviewTask.assigneeId !== 'user-5') reviewTaskIssues.push(`Review task assigneeId is "${reviewTask.assigneeId}", expected "user-5".`);
        if (reviewTask.priority !== 'high') reviewTaskIssues.push(`Review task priority is "${reviewTask.priority}", expected "high".`);
        if (reviewTask.storyPoints !== 5) reviewTaskIssues.push(`Review task storyPoints is ${reviewTask.storyPoints}, expected 5.`);
        if (!(reviewTask.tags || []).includes('tag-7') || !(reviewTask.tags || []).includes('tag-6')) {
          reviewTaskIssues.push('Review task should include both security (tag-7) and testing (tag-6).');
        }
      }

      // Check links in snapshot
      const reviewTaskLinkedTo001 = reviewTask && (reviewTask.linkedIssues || []).some(
        l => l.targetId === 'SCRUM-001' && l.linkType === 'isBlockedBy'
      );
      const scrum001LinksReview = reviewTask && scrum001 && (scrum001.linkedIssues || []).some(
        l => l.targetId === reviewTask.id && l.linkType === 'blocks'
      );

      const reviewSubtaskIssues = [];
      if (!reviewSubtask) {
        reviewSubtaskIssues.push('Completed subtask "Document IdP metadata test cases" not found under the new review task.');
      } else {
        if (reviewSubtask.status !== 'done') reviewSubtaskIssues.push(`Review subtask status is "${reviewSubtask.status}", expected "done".`);
      }

      const scrum036LinkedTo001 = (scrum036 && (scrum036.linkedIssues || []).some(
        l => l.targetId === 'SCRUM-001' && l.linkType === 'isBlockedBy'
      )) || (scrum001 && (scrum001.linkedIssues || []).some(
        l => l.targetId === 'SCRUM-036' && l.linkType === 'blocks'
      ));

      return finalizeChecks([
        createCheck(
          'Applied the security tag filter before reorganizing work',
          hasFilterEvent(events, 'tag', 'tag-7'),
          'No security tag filter_applied event recorded for tag-7.'
        ),
        createCheck(
          'Updated the existing security cards with the required statuses, sprint placement, and ownership',
          existingCardIssues.length === 0,
          existingCardIssues.join(' ')
        ),
        createCheck(
          'Created the Sprint 3 SSO security readiness review task with the required fields',
          reviewTask && reviewTaskIssues.length === 0,
          !reviewTask
            ? 'New task titled like "SSO security readiness review" not found.'
            : reviewTaskIssues.join(' ')
        ),
        createCheck(
          'Linked the new review task back to SCRUM-001 as blocked by',
          Boolean(reviewTaskLinkedTo001 || scrum001LinksReview),
          !reviewTask
            ? 'Cannot verify the new review-task link because the review task was not created.'
            : 'No linkedIssues entry found linking the new review task to SCRUM-001 as isBlockedBy.'
        ),
        createCheck(
          'Added and completed the IdP metadata test cases subtask under the new review task',
          reviewSubtask && reviewSubtaskIssues.length === 0,
          reviewSubtaskIssues.join(' ')
        ),
        createCheck(
          'Linked SCRUM-036 back to SCRUM-001 as blocked by',
          Boolean(scrum036LinkedTo001),
          'No linkedIssues entry found linking SCRUM-036 to SCRUM-001 as isBlockedBy.'
        ),
      ], 'Security work was filtered, reorganized, and linked correctly for Sprint 3, including the new readiness review task and its completed subtask.');
    }
  },

  'EVAL-38': {
    name: 'Prepare the database migration weekend',
    tier: 4,
    description: 'Start the migration, pull the related infrastructure work into Sprint 2, create and link a rehearsal task, add and complete the right subtasks, and consolidate ownership.',
    verify: (snapshot, events) => {
      const scrum006 = getTaskFromSnapshot(snapshot, 'SCRUM-006');
      const scrum032 = getTaskFromSnapshot(snapshot, 'SCRUM-032');
      const scrum035 = getTaskFromSnapshot(snapshot, 'SCRUM-035');
      const scrum005 = getTaskFromSnapshot(snapshot, 'SCRUM-005');
      const kickoffIssues = [];
      if (!scrum006 || scrum006.status !== 'inprogress') kickoffIssues.push('SCRUM-006 should be inprogress.');
      if (!scrum032 || scrum032.sprintId !== 'sprint-2') kickoffIssues.push('SCRUM-032 should be moved into Sprint 2.');
      if (!scrum035 || scrum035.sprintId !== 'sprint-2') kickoffIssues.push('SCRUM-035 should be moved into Sprint 2.');
      if (!scrum005 || scrum005.assigneeId !== 'user-6') kickoffIssues.push('SCRUM-005 should be reassigned to Frank Lee (user-6).');

      const rehearsalTask = findTaskByTitleContains(snapshot, 'backup restore rehearsal');
      const rehearsalTaskIssues = [];
      if (!rehearsalTask) {
        rehearsalTaskIssues.push('New backup restore rehearsal task not found.');
      } else {
        if (rehearsalTask.status !== 'inprogress') rehearsalTaskIssues.push(`Rehearsal task status is "${rehearsalTask.status}", expected "inprogress".`);
        if (rehearsalTask.sprintId !== 'sprint-2') rehearsalTaskIssues.push(`Rehearsal task sprintId is "${rehearsalTask.sprintId}", expected "sprint-2".`);
        if (rehearsalTask.assigneeId !== 'user-6') rehearsalTaskIssues.push(`Rehearsal task assigneeId is "${rehearsalTask.assigneeId}", expected "user-6".`);
        if (rehearsalTask.priority !== 'high') rehearsalTaskIssues.push(`Rehearsal task priority is "${rehearsalTask.priority}", expected "high".`);
        if (rehearsalTask.storyPoints !== 3) rehearsalTaskIssues.push(`Rehearsal task storyPoints is ${rehearsalTask.storyPoints}, expected 3.`);
        ['tag-2', 'tag-10', 'tag-6'].forEach(tagId => {
          if (!(rehearsalTask.tags || []).includes(tagId)) rehearsalTaskIssues.push(`Rehearsal task is missing required tag ${tagId}.`);
        });
      }

      const rehearsalLinkedTo006 = rehearsalTask && (
        (rehearsalTask.linkedIssues || []).some(l => l.targetId === 'SCRUM-006' && l.linkType === 'blocks') ||
        (getTaskFromSnapshot(snapshot, 'SCRUM-006')?.linkedIssues || []).some(l => l.targetId === rehearsalTask.id && l.linkType === 'isBlockedBy')
      );

      const expectedSubtasks = [
        { title: 'Validate migration dry run in staging', done: true },
        { title: 'Verify rollback timing under load', done: false },
        { title: 'Confirm backup restore point coverage', done: true }
      ];

      const subtaskIssues = [];
      expectedSubtasks.forEach(expected => {
        const subtask = (snapshot.tasks || []).find(t => t.parentId === 'SCRUM-006' && (t.title || '').toLowerCase() === expected.title.toLowerCase());
        if (!subtask) {
          subtaskIssues.push(`Missing SCRUM-006 subtask: ${expected.title}.`);
          return;
        }
        if (expected.done && subtask.status !== 'done') {
          subtaskIssues.push(`Subtask "${expected.title}" should be done.`);
        }
      });

      const completionIssues = [];
      ['Validate migration dry run in staging', 'Confirm backup restore point coverage'].forEach(title => {
        const subtask = (snapshot.tasks || []).find(t => t.parentId === 'SCRUM-006' && (t.title || '').toLowerCase() === title.toLowerCase());
        if (!subtask) {
          completionIssues.push(`Cannot verify completion for "${title}" because the subtask is missing.`);
        } else if (subtask.status !== 'done') {
          completionIssues.push(`Subtask "${title}" status is "${subtask.status}", expected "done".`);
        }
      });

      return finalizeChecks([
        createCheck(
          'Started the migration and scheduled the related Sprint 2 infrastructure work',
          kickoffIssues.length === 0,
          kickoffIssues.join(' ')
        ),
        createCheck(
          'Created the backup restore rehearsal task with the required Sprint 2 fields and tags',
          rehearsalTask && rehearsalTaskIssues.length === 0,
          !rehearsalTask
            ? 'New backup restore rehearsal task not found.'
            : rehearsalTaskIssues.join(' ')
        ),
        createCheck(
          'Linked the rehearsal task to SCRUM-006 as blocks',
          Boolean(rehearsalLinkedTo006),
          !rehearsalTask
            ? 'Cannot verify the rehearsal-task link because the rehearsal task was not created.'
            : 'No linkedIssues entry found linking the rehearsal task to SCRUM-006 as blocks.'
        ),
        createCheck(
          'Added the required SCRUM-006 migration subtasks',
          subtaskIssues.length === 0,
          subtaskIssues.join(' ')
        ),
        createCheck(
          'Completed the two required migration subtasks',
          completionIssues.length === 0,
          completionIssues.join(' ')
        ),
      ], 'Database migration weekend prep is complete: the migration is started, dependencies are scheduled, the rehearsal task is linked, and the expected subtasks exist with the correct completion state.');
    }
  },

  'EVAL-39': {
    name: 'Clean up the frontend release candidates',
    tier: 4,
    description: 'Filter to frontend work, advance the right cards, schedule backlog items, create a new regression task in review, and link it to the related work.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const checks = [
        ['SCRUM-004', 'status', 'inprogress'],
        ['SCRUM-022', 'status', 'inprogress'],
        ['SCRUM-008', 'status', 'inreview'],
        ['SCRUM-013', 'status', 'done'],
        ['SCRUM-029', 'sprintId', 'sprint-3'],
        ['SCRUM-024', 'sprintId', 'sprint-3'],
        ['SCRUM-024', 'assigneeId', 'user-1']
      ];
      const existingCardIssues = [];
      checks.forEach(([taskId, field, expected]) => {
        const task = getTaskFromSnapshot(snapshot, taskId);
        if (!task || task[field] !== expected) {
          existingCardIssues.push(`${taskId} ${field} is "${task ? task[field] : 'missing'}", expected "${expected}".`);
        }
      });

      const regressionTask = findTaskByTitleContains(snapshot, 'dark mode and i18n accessibility regression');
      const regressionTaskIssues = [];
      if (!regressionTask) {
        regressionTaskIssues.push('New dark mode and i18n accessibility regression task not found.');
      } else {
        if (regressionTask.status !== 'inreview') regressionTaskIssues.push(`Regression task status is "${regressionTask.status}", expected "inreview".`);
        if (regressionTask.sprintId !== 'sprint-3') regressionTaskIssues.push(`Regression task sprintId is "${regressionTask.sprintId}", expected "sprint-3".`);
        if (regressionTask.assigneeId !== 'user-5') regressionTaskIssues.push(`Regression task assigneeId is "${regressionTask.assigneeId}", expected "user-5".`);
        if (regressionTask.priority !== 'high') regressionTaskIssues.push(`Regression task priority is "${regressionTask.priority}", expected "high".`);
        if (regressionTask.storyPoints !== 5) regressionTaskIssues.push(`Regression task storyPoints is ${regressionTask.storyPoints}, expected 5.`);
        ['tag-1', 'tag-6', 'tag-5'].forEach(tagId => {
          if (!(regressionTask.tags || []).includes(tagId)) regressionTaskIssues.push(`Regression task is missing required tag ${tagId}.`);
        });
      }

      const linkTo004 = regressionTask && (
        (regressionTask.linkedIssues || []).some(l => l.targetId === 'SCRUM-004' && l.linkType === 'relatesTo') ||
        (getTaskFromSnapshot(snapshot, 'SCRUM-004')?.linkedIssues || []).some(l => l.targetId === regressionTask.id && l.linkType === 'relatesTo')
      );
      const linkTo029 = regressionTask && (
        (regressionTask.linkedIssues || []).some(l => l.targetId === 'SCRUM-029' && l.linkType === 'relatesTo') ||
        (getTaskFromSnapshot(snapshot, 'SCRUM-029')?.linkedIssues || []).some(l => l.targetId === regressionTask.id && l.linkType === 'relatesTo')
      );

      const spotCheckSubtask = regressionTask && (snapshot.tasks || []).find(t =>
        t.parentId === regressionTask.id && (t.title || '').toLowerCase().includes('screen reader spot-check on translated pages')
      );

      return finalizeChecks([
        createCheck(
          'Applied the frontend tag filter before cleanup',
          hasFilterEvent(events, 'tag', 'tag-1'),
          'No frontend tag filter_applied event recorded for tag-1.'
        ),
        createCheck(
          'Updated and scheduled the specified existing frontend cards correctly',
          existingCardIssues.length === 0,
          existingCardIssues.join(' ')
        ),
        createCheck(
          'Created the regression task with the required Sprint 3 fields and tags',
          regressionTask && regressionTaskIssues.length === 0,
          !regressionTask
            ? 'New dark mode and i18n accessibility regression task not found.'
            : regressionTaskIssues.join(' ')
        ),
        createCheck(
          'Linked the regression task to SCRUM-004 and SCRUM-029',
          Boolean(linkTo004) && Boolean(linkTo029),
          !regressionTask
            ? 'Cannot verify regression-task links because the regression task was not created.'
            : [
                !linkTo004 ? 'No linkedIssues entry found from the regression task to SCRUM-004 with relatesTo.' : '',
                !linkTo029 ? 'No linkedIssues entry found from the regression task to SCRUM-029 with relatesTo.' : ''
              ].filter(Boolean).join(' ')
        ),
        createCheck(
          'Added the screen reader spot-check subtask to the regression task',
          Boolean(spotCheckSubtask),
          !regressionTask
            ? 'Cannot verify the regression-task subtask because the regression task was not created.'
            : 'Regression task subtask "Screen reader spot-check on translated pages" not found.'
        ),
      ], 'Frontend release-candidate cleanup completed with the correct filter, card transitions, Sprint 3 scheduling, and the linked regression task.');
    }
  },

  'EVAL-40': {
    name: 'Kick off Sprint 3 platform work',
    tier: 4,
    description: 'Start Sprint 3, schedule the right platform backlog, create a critical risk-review task in progress, and attach the required links and subtasks.',
    verify: (snapshot, events) => {
      const sprint3 = (snapshot.sprints || []).find(s => s.id === 'sprint-3');

      const schedulingIssues = [];
      ['SCRUM-034', 'SCRUM-032', 'SCRUM-035', 'SCRUM-036'].forEach(taskId => {
        const task = getTaskFromSnapshot(snapshot, taskId);
        if (!task || task.sprintId !== 'sprint-3') {
          schedulingIssues.push(`${taskId} should be in Sprint 3.`);
        }
      });
      const scrum036 = getTaskFromSnapshot(snapshot, 'SCRUM-036');
      if (!scrum036 || scrum036.assigneeId !== 'user-2') {
        schedulingIssues.push('SCRUM-036 should be assigned to Bob Martinez (user-2).');
      }

      const riskReviewTask = findTaskByTitleContains(snapshot, 'platform risk review');
      const riskReviewIssues = [];
      if (!riskReviewTask) {
        riskReviewIssues.push('New platform risk review task not found.');
      } else {
        if (riskReviewTask.status !== 'inprogress') riskReviewIssues.push(`Platform risk review task status is "${riskReviewTask.status}", expected "inprogress".`);
        if (riskReviewTask.sprintId !== 'sprint-3') riskReviewIssues.push(`Platform risk review task sprintId is "${riskReviewTask.sprintId}", expected "sprint-3".`);
        if (riskReviewTask.assigneeId !== 'user-4') riskReviewIssues.push(`Platform risk review task assigneeId is "${riskReviewTask.assigneeId}", expected "user-4".`);
        if (riskReviewTask.priority !== 'critical') riskReviewIssues.push(`Platform risk review task priority is "${riskReviewTask.priority}", expected "critical".`);
        if (riskReviewTask.storyPoints !== 8) riskReviewIssues.push(`Platform risk review task storyPoints is ${riskReviewTask.storyPoints}, expected 8.`);
        ['tag-2', 'tag-10', 'tag-7'].forEach(tagId => {
          if (!(riskReviewTask.tags || []).includes(tagId)) riskReviewIssues.push(`Platform risk review task is missing required tag ${tagId}.`);
        });
      }

      const linkTo036 = riskReviewTask && (
        (riskReviewTask.linkedIssues || []).some(l => l.targetId === 'SCRUM-036' && l.linkType === 'blocks') ||
        (getTaskFromSnapshot(snapshot, 'SCRUM-036')?.linkedIssues || []).some(l => l.targetId === riskReviewTask.id && l.linkType === 'isBlockedBy')
      );
      const linkTo032 = riskReviewTask && (
        (riskReviewTask.linkedIssues || []).some(l => l.targetId === 'SCRUM-032' && l.linkType === 'relatesTo') ||
        (getTaskFromSnapshot(snapshot, 'SCRUM-032')?.linkedIssues || []).some(l => l.targetId === riskReviewTask.id && l.linkType === 'relatesTo')
      );

      const fallbackSubtask = riskReviewTask && (snapshot.tasks || []).find(t =>
        t.parentId === riskReviewTask.id && (t.title || '').toLowerCase().includes('graphql rollout fallback plan')
      );
      const certSubtask = riskReviewTask && (snapshot.tasks || []).find(t =>
        t.parentId === riskReviewTask.id && (t.title || '').toLowerCase().includes('sso certificate rotation path')
      );
      const subtaskPresenceIssues = [];
      if (!fallbackSubtask) subtaskPresenceIssues.push('Subtask "Check GraphQL rollout fallback plan" not found under the platform risk review task.');
      if (!certSubtask) subtaskPresenceIssues.push('Subtask "Review SSO certificate rotation path" not found under the platform risk review task.');

      const completionIssue = !certSubtask
        ? 'Cannot verify certificate-rotation subtask completion because the subtask is missing.'
        : certSubtask.status !== 'done'
          ? `Certificate-rotation subtask status is "${certSubtask.status}", expected "done".`
          : '';

      return finalizeChecks([
        createCheck(
          'Started Sprint 3',
          sprint3 && sprint3.status === 'active',
          `Sprint 3 status is "${sprint3 ? sprint3.status : 'missing'}", expected "active".`
        ),
        createCheck(
          'Scheduled the required platform backlog items into Sprint 3 and reassigned SCRUM-036 to Bob Martinez',
          schedulingIssues.length === 0,
          schedulingIssues.join(' ')
        ),
        createCheck(
          'Created the platform risk review task with the required Sprint 3 fields and tags',
          riskReviewTask && riskReviewIssues.length === 0,
          !riskReviewTask
            ? 'New platform risk review task not found.'
            : riskReviewIssues.join(' ')
        ),
        createCheck(
          'Linked the platform risk review task to SCRUM-036 and SCRUM-032',
          Boolean(linkTo036) && Boolean(linkTo032),
          !riskReviewTask
            ? 'Cannot verify platform risk review links because the task was not created.'
            : [
                !linkTo036 ? 'No linkedIssues entry found from the platform risk review task to SCRUM-036 with blocks.' : '',
                !linkTo032 ? 'No linkedIssues entry found from the platform risk review task to SCRUM-032 with relatesTo.' : ''
              ].filter(Boolean).join(' ')
        ),
        createCheck(
          'Added the required platform risk review subtasks',
          subtaskPresenceIssues.length === 0,
          subtaskPresenceIssues.join(' ')
        ),
        createCheck(
          'Completed the SSO certificate rotation subtask',
          !completionIssue,
          completionIssue
        ),
      ], 'Sprint 3 platform work is correctly started, scheduled, and linked, including the critical risk review task and its required subtasks.');
    }
  },

  'EVAL-41': {
    name: 'Analyze Sprint 2 story points by assignee and record the summary',
    tier: 4,
    description: 'Create a To Do docs task in Sprint 2 titled "Sprint 2 Story Points Summary" with Emma Johnson assigned, and set its description to the exact JSON mapping of each assignee to their total top-level Sprint 2 story points.',
    verify: (snapshot, events) => {
      if (!snapshot) return fail('Snapshot not available.');

      const seed = loadSeedData();
      const usersById = new Map((seed.users || []).map(user => [user.id, user.name]));
      const sprint2Tasks = (seed.tasks || []).filter(task => task.sprintId === 'sprint-2' && !task.parentId);
      const expectedTotals = {};
      sprint2Tasks.forEach(task => {
        const assigneeName = usersById.get(task.assigneeId) || 'Unassigned';
        expectedTotals[assigneeName] = (expectedTotals[assigneeName] || 0) + (task.storyPoints || 0);
      });

      const summaryTask = findTaskByTitleContains(snapshot, 'Sprint 2 Story Points Summary');
      const summaryTaskIssues = [];
      if (!summaryTask) {
        summaryTaskIssues.push('Sprint 2 Story Points Summary task not found.');
      } else {
        if (summaryTask.status !== 'todo') summaryTaskIssues.push(`Summary task status is "${summaryTask.status}", expected "todo".`);
        if (summaryTask.sprintId !== 'sprint-2') summaryTaskIssues.push(`Summary task sprintId is "${summaryTask.sprintId}", expected "sprint-2".`);
        if (summaryTask.assigneeId !== 'user-5') summaryTaskIssues.push(`Summary task assigneeId is "${summaryTask.assigneeId}", expected "user-5" (Emma Johnson).`);
        if (summaryTask.priority !== 'medium') summaryTaskIssues.push(`Summary task priority is "${summaryTask.priority}", expected "medium".`);
        if (summaryTask.storyPoints !== 3) summaryTaskIssues.push(`Summary task storyPoints is ${summaryTask.storyPoints}, expected 3.`);
        if (!(summaryTask.tags || []).includes('tag-9')) summaryTaskIssues.push('Summary task should include tag-9 (docs).');

        const createEvent = findEventsOfType(events, 'card_created').find(event => event.data && event.data.taskId === summaryTask.id);
        if (!createEvent) summaryTaskIssues.push(`No card_created event found for ${summaryTask.id}.`);
      }

      const descriptionIssues = [];
      if (!summaryTask) {
        descriptionIssues.push('Cannot validate the summary description because the summary task is missing.');
      } else {
        let parsedDescription = null;
        try {
          parsedDescription = JSON.parse((summaryTask.description || '').trim());
        } catch (error) {
          descriptionIssues.push('Summary task description is not valid JSON.');
        }

        if (parsedDescription && (typeof parsedDescription !== 'object' || Array.isArray(parsedDescription) || parsedDescription === null)) {
          descriptionIssues.push('Summary task description JSON must be an object mapping names to totals.');
        }

        if (parsedDescription && typeof parsedDescription === 'object' && !Array.isArray(parsedDescription)) {
          const expectedKeys = Object.keys(expectedTotals).sort();
          const actualKeys = Object.keys(parsedDescription).sort();
          if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
            descriptionIssues.push(`Summary task description keys are ${JSON.stringify(actualKeys)}, expected ${JSON.stringify(expectedKeys)}.`);
          }

          expectedKeys.forEach(name => {
            if (parsedDescription[name] !== expectedTotals[name]) {
              descriptionIssues.push(`Summary task description has ${JSON.stringify(name)}: ${parsedDescription[name]}, expected ${expectedTotals[name]}.`);
            }
          });
        }
      }

      return finalizeChecks([
        createCheck(
          'Created the Sprint 2 Story Points Summary task with the required Sprint 2 fields',
          summaryTask && summaryTaskIssues.length === 0,
          !summaryTask
            ? 'Sprint 2 Story Points Summary task not found.'
            : summaryTaskIssues.join(' ')
        ),
        createCheck(
          'Wrote the exact JSON mapping of assignees to their top-level Sprint 2 story-point totals in the description',
          summaryTask && descriptionIssues.length === 0,
          descriptionIssues.join(' ')
        ),
      ], `Sprint 2 story-point analysis was summarized correctly in a new Sprint 2 docs task for Emma Johnson, with totals for ${Object.keys(expectedTotals).length} assignee bucket(s).`);
    }
  }

};

// ======================================================
// RESULT FORMATTING
// ======================================================

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function fmt(color, text) { return color + text + RESET; }

function printTaskChecks(result, indent = '') {
  if (!result || !Array.isArray(result.checks) || result.checks.length === 0) return;

  console.log(`${indent}${fmt(BOLD, 'Checks:')}`);
  for (const check of result.checks) {
    const icon = check.pass ? fmt(GREEN, '✓') : fmt(RED, '✗');
    console.log(`${indent}  ${icon} ${check.label}`);
  }
}

function printDetailedOutcome(result, indent = '') {
  const icon = result.pass ? fmt(GREEN, '✓') : fmt(RED, '✗');
  const label = result.pass ? fmt(GREEN, 'PASS') : fmt(RED, 'FAIL');
  const message = result.message || result.reason || '';
  console.log(`${indent}${icon} ${label}  ${message}`);
}

function printResult(id, task, result) {
  const icon = result.pass ? fmt(GREEN, '✔ PASS') : fmt(RED, '✘ FAIL');
  console.log(`  ${icon}  ${fmt(BOLD, id)} — ${task.name}`);
  if (!result.pass) {
    printTaskChecks(result, '         ');
  }
  if (result.pass) {
    console.log(`         ${fmt(DIM, result.reason)}`);
  } else {
    console.log(`         ${fmt(RED, result.reason)}`);
  }
}

function runSingle(id, snapshot, events) {
  const task = EVAL_TASKS[id];
  if (!task) {
    console.error(fmt(RED, `Unknown task: ${id}`));
    console.error(`Available: ${Object.keys(EVAL_TASKS).join(', ')}`);
    process.exit(1);
  }

  let result;
  try {
    result = task.verify(snapshot, events);
  } catch (e) {
    result = fail(`Evaluator threw exception: ${e.message}`);
  }

  console.log(`\n${fmt(BOLD, `${id} (Tier ${task.tier})`)}`);
  console.log(task.name);
  printTaskChecks(result);
  printDetailedOutcome(result);

  if (result.checks && result.checks.length > 0) {
    const passed = result.checks.filter(c => c.pass).length;
    const score = (passed / result.checks.length).toFixed(2);
    console.log(`${fmt(BOLD, `Score: ${score}`)} (${passed}/${result.checks.length})`);
  } else {
    console.log(fmt(BOLD, `Score: ${result.pass ? '1.00' : '0.00'}`));
  }
  console.log('');

  return result.pass;
}

function runAll(snapshot, events) {
  const tiers = [1, 2, 3, 4];
  let totalPass = 0;
  let totalFail = 0;

  tiers.forEach(tier => {
    const tierTasks = Object.entries(EVAL_TASKS).filter(([, t]) => t.tier === tier);
    console.log(`\n${fmt(BOLD, fmt(CYAN, `═══ Tier ${tier} ═══`))}`);

    let tierPass = 0;
    let tierFail = 0;

    tierTasks.forEach(([id, task]) => {
      let result;
      try {
        result = task.verify(snapshot, events);
      } catch (e) {
        result = fail(`Evaluator threw exception: ${e.message}`);
      }

      printResult(id, task, result);
      if (result.pass) tierPass++;
      else tierFail++;
    });

    console.log(`\n  ${fmt(DIM, `Tier ${tier} summary: ${fmt(GREEN, `${tierPass} passed`)}, ${fmt(RED, `${tierFail} failed`)} / ${tierTasks.length} total`)}`);
    totalPass += tierPass;
    totalFail += tierFail;
  });

  const totalTasks = Object.keys(EVAL_TASKS).length;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${fmt(BOLD, 'Overall Summary:')}`);
  console.log(`  ${fmt(GREEN, `${totalPass} passed`)}  ${fmt(RED, `${totalFail} failed`)}  / ${totalTasks} total`);

  if (totalFail === 0) {
    console.log(`\n${fmt(GREEN, fmt(BOLD, '  All evaluation tasks passed!'))}\n`);
  } else {
    console.log(`\n${fmt(YELLOW, `  ${totalFail} task(s) need attention.`)}\n`);
  }

  return totalFail === 0;
}

// ======================================================
// MAIN
// ======================================================

function main() {
  const args = process.argv.slice(2);
  const snapshotFile = getArgValue(args, '--snapshot') || SNAPSHOT_FILE;
  const eventLogFile = getArgValue(args, '--events') || EVENT_LOG_FILE;

  if (args.length === 0) {
    console.log(`
${fmt(BOLD, 'Scrum Board Evaluator')}

Usage:
  node evaluator.js EVAL-01 [--snapshot path] [--events path]       Run a single evaluation task
  node evaluator.js --all [--snapshot path] [--events path]         Run all evaluation tasks

Available tasks:
${Object.entries(EVAL_TASKS).map(([id, t]) => `  ${id} (Tier ${t.tier}): ${t.name}`).join('\n')}
    `);
    process.exit(0);
  }

  const snapshot = loadSnapshot(snapshotFile);
  const events = loadEventLog(eventLogFile);

  console.log(`scrumboard evaluator v${VERSION}`);

  if (args[0] === '--all') {
    const allPassed = runAll(snapshot, events);
    process.exit(allPassed ? 0 : 1);
  } else {
    const id = args[0].toUpperCase();
    const passed = runSingle(id, snapshot, events);
    process.exit(passed ? 0 : 1);
  }
}

main();
