#!/usr/bin/env node
'use strict';

const VERSION = '2.2.0';

const fs = require('fs');
const path = require('path');

const WORKARENA_ROOT = path.join(__dirname, '..');
const SITES = ['outlook', 'scrumboard', 'teams', 'gmail'];

const DEFAULTS = {
	outlook: {
		snapshot: path.join(WORKARENA_ROOT, 'outlook', 'localStorage_snapshot.json'),
		events: path.join(WORKARENA_ROOT, 'outlook', 'event_log.ndjson'),
		db: path.join(WORKARENA_ROOT, 'outlook', 'db_initial.json'),
	},
	scrumboard: {
		snapshot: path.join(WORKARENA_ROOT, 'scrumboard', 'localStorage_snapshot.json'),
		events: path.join(WORKARENA_ROOT, 'scrumboard', 'event_log.ndjson'),
		db: path.join(WORKARENA_ROOT, 'scrumboard', 'db_initial.json'),
	},
	teams: {
		snapshot: path.join(WORKARENA_ROOT, 'teams', 'localStorage_snapshot.json'),
		events: path.join(WORKARENA_ROOT, 'teams', 'event_log.ndjson'),
		db: path.join(WORKARENA_ROOT, 'teams', 'db_initial.json'),
	},
	gmail: {
		snapshot: path.join(WORKARENA_ROOT, 'gmail', 'db_initial.json'),
		events: path.join(WORKARENA_ROOT, 'gmail', 'event_log.ndjson'),
		db: path.join(WORKARENA_ROOT, 'gmail', 'db_initial.json'),
	},
};

function getArgValue(args, flag) {
	const index = args.indexOf(flag);
	if (index === -1) return null;
	const value = args[index + 1];
	return value && !value.startsWith('--') ? value : null;
}

function loadJson(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, 'utf8').trim();
		if (!raw) return null;
		return JSON.parse(raw);
	} catch (error) {
		console.warn(`[WARN] Failed to parse JSON at ${filePath}: ${error.message}`);
		return null;
	}
}

function loadEvents(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return [];
	try {
		const raw = fs.readFileSync(filePath, 'utf8').trim();
		if (!raw) return [];
		return raw
			.split('\n')
			.filter(Boolean)
			.map(line => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

function stripHtml(value) {
	return String(value || '')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>');
}

function normalizeText(value) {
	return stripHtml(value)
		.toLowerCase()
		.replace(/[^a-z0-9/$%+.-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function textContainsAny(text, variants) {
	const normalized = normalizeText(text);
	return variants.some(variant => normalized.includes(normalizeText(variant)));
}

function textContainsAllGroups(text, groups) {
	return groups.every(group => textContainsAny(text, group));
}

function matchedGroupCount(text, groups) {
	return groups.filter(group => textContainsAny(text, group)).length;
}

function pass(message, checks) {
	return { pass: true, message, checks: checks || [] };
}

function fail(message, checks) {
	return { pass: false, message, checks: checks || [] };
}

function createCheck(label, passed, failDetail, passDetail) {
	return {
		label,
		pass: Boolean(passed),
		detail: passed ? (passDetail || label) : failDetail,
	};
}

function finalizeChecks(checks, successMessage) {
	const failed = checks.filter(check => !check.pass);
	if (failed.length === 0) {
		return pass(successMessage, checks);
	}
	return fail(failed.map(check => check.detail).join(' '), checks);
}

function resolveArtifactOptions(args) {
	const explicitOutputDir = getArgValue(args, '--output-dir');
	if (explicitOutputDir) {
		return {
			outputDir: path.resolve(process.cwd(), explicitOutputDir),
			allowDefaultArtifacts: false,
		};
	}

	const snapshotPath = getArgValue(args, '--snapshot');
	if (snapshotPath) {
		const resolved = path.resolve(process.cwd(), snapshotPath);
		return {
			outputDir: fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
				? resolved
				: path.dirname(path.dirname(resolved)),
			allowDefaultArtifacts: false,
		};
	}

	return {
		outputDir: WORKARENA_ROOT,
		allowDefaultArtifacts: true,
	};
}

function loadBundle(outputDir, allowDefaultArtifacts = true) {
	return SITES.reduce((bundle, site) => {
		const siteDir = path.join(outputDir, site);
		bundle[site] = {
			snapshot: loadJson(path.join(siteDir, 'localStorage_snapshot.json')) || (allowDefaultArtifacts ? loadJson(DEFAULTS[site].snapshot) : null),
			events: loadEvents(path.join(siteDir, 'event_log.ndjson')),
			db: loadJson(DEFAULTS[site].db),
		};
		if (allowDefaultArtifacts && bundle[site].events.length === 0) {
			bundle[site].events = loadEvents(DEFAULTS[site].events);
		}
		return bundle;
	}, {});
}

function getScrumTask(snapshot, taskId) {
	return (snapshot?.tasks || []).find(task => task.id === taskId) || null;
}

function getOutlookEmail(snapshot, emailId) {
	return (snapshot?.emails || []).find(email => email.id === emailId) || null;
}

function getGmailEmail(snapshot, emailId) {
	return (snapshot?.emails || []).find(email => email.id === emailId) || null;
}

function getTeamsMessage(snapshot, messageId) {
	return (snapshot?.messages || []).find(message => message.id === messageId) || null;
}

function getTeamsConversation(snapshot, conversationId) {
	return (snapshot?.conversations || []).find(conversation => conversation.id === conversationId) || null;
}

function findCalendarEventById(snapshot, eventId) {
	return (snapshot?.calendarEvents || []).find(event => event.id === eventId) || null;
}

function findCalendarEventByTitle(snapshot, predicate) {
	return (snapshot?.calendarEvents || []).find(event => predicate(event)) || null;
}

function getSeedEvent(db, title) {
	return (db?.events || []).find(event => event.title === title) || null;
}

function getEmailBySubject(snapshot, subjectFragment) {
	return (snapshot?.emails || []).find(email => normalizeText(email.subject).includes(normalizeText(subjectFragment))) || null;
}

function getFolderByName(snapshot, folderName) {
	return (snapshot?.folders || []).find(folder => normalizeText(folder.name) === normalizeText(folderName)) || null;
}

function getLabelByName(snapshot, labelName) {
	return (snapshot?.labels || []).find(label => normalizeText(label.name) === normalizeText(labelName)) || null;
}

function emailHasRecipient(email, recipient) {
	const recipients = Array.isArray(email?.to) ? email.to : [];
	return recipients.some(entry => {
		if (typeof entry === 'string') return entry.toLowerCase() === recipient.toLowerCase();
		return String(entry.email || '').toLowerCase() === recipient.toLowerCase();
	});
}

function eventHasRecipient(event, recipient) {
	return Array.isArray(event?.to) && event.to.some(entry => String(entry).toLowerCase() === recipient.toLowerCase());
}

function findOutlookEmailByEvent(siteData, predicate) {
	const candidates = findOutlookEmailCandidatesByEvent(siteData, predicate);
	return candidates[candidates.length - 1] || null;
}

function findOutlookEmailCandidatesByEvent(siteData, predicate) {
	const candidates = siteData.events
		.filter(event => event.type === 'email_sent')
		.map(event => ({ event, email: getOutlookEmail(siteData.snapshot, event.emailId) }))
		.filter(candidate => candidate.email && predicate(candidate.email, candidate.event));
	return candidates;
}

function findGmailEmailByEvent(siteData, predicate) {
	const candidates = findGmailEmailCandidatesByEvent(siteData, predicate);
	return candidates[candidates.length - 1] || null;
}

function findGmailEmailCandidatesByEvent(siteData, predicate) {
	const candidates = siteData.events
		.filter(event => event.type === 'email_sent')
		.map(event => ({ event, email: getGmailEmail(siteData.snapshot, event.emailId) }))
		.filter(candidate => candidate.email && predicate(candidate.email, candidate.event));
	return candidates;
}

function findTeamsMessageByEvent(siteData, predicate) {
	const candidates = findTeamsMessageCandidatesByEvent(siteData, predicate);
	return candidates[candidates.length - 1] || null;
}

function findTeamsMessageCandidatesByEvent(siteData, predicate) {
	const candidates = siteData.events
		.filter(event => event.type === 'message_sent')
		.map(event => ({ event, message: getTeamsMessage(siteData.snapshot, event.messageId) }))
		.filter(candidate => candidate.message && predicate(candidate.message, candidate.event));
	return candidates;
}

function findTeamsForwardedMessage(siteData, predicate) {
	const candidates = findTeamsForwardedMessageCandidates(siteData, predicate);
	return candidates[candidates.length - 1] || null;
}

function findTeamsForwardedMessageCandidates(siteData, predicate) {
	const candidates = siteData.events
		.filter(event => event.type === 'message_forwarded')
		.map(event => ({ event, message: getTeamsMessage(siteData.snapshot, event.messageId) }))
		.filter(candidate => candidate.message && predicate(candidate.message, candidate.event));
	return candidates;
}

function wasConversationMarkedUnread(siteData, conversationId) {
	return Boolean(findEvent(siteData.events, event =>
		event.type === 'conversation_marked_unread' && event.conversationId === conversationId
	));
}

function getNewSnapshotItems(snapshotItems, seedItems) {
	const seedIds = new Set((seedItems || []).map(item => item.id));
	return (snapshotItems || []).filter(item => !seedIds.has(item.id));
}

function findNewOutlookEmails(siteData, predicate) {
	return getNewSnapshotItems(siteData.snapshot?.emails, siteData.db?.emails).filter(predicate);
}

function findNewGmailEmails(siteData, predicate) {
	return getNewSnapshotItems(siteData.snapshot?.emails, siteData.db?.emails).filter(predicate);
}

function findNewTeamsMessages(siteData, predicate) {
	return getNewSnapshotItems(siteData.snapshot?.messages, siteData.db?.messages).filter(predicate);
}

function findCreatedCalendarEvents(siteData, predicate) {
	return getNewSnapshotItems(siteData.snapshot?.calendarEvents, siteData.db?.events).filter(predicate);
}

function findCandidateWithGroups(candidates, groups, textSelector) {
	return candidates.find(candidate => eventMentionsAll(textSelector(candidate), groups)) || null;
}

function findCreatedTask(siteData, predicate) {
	const created = siteData.events
		.filter(event => event.type === 'card_created' && event.data)
		.map(event => ({ event, task: getScrumTask(siteData.snapshot, event.data.taskId) }))
		.filter(candidate => candidate.task && predicate(candidate.task, candidate.event));

	if (created.length > 0) return created[created.length - 1];

	const seedIds = new Set((siteData.db?.tasks || []).map(task => task.id));
	const newTasks = (siteData.snapshot?.tasks || []).filter(task => !seedIds.has(task.id));
	const fallback = [...newTasks].reverse().find(task => predicate(task, null));
	return fallback ? { event: null, task: fallback } : null;
}

function findTask(siteData, taskId) {
	return (siteData.snapshot?.tasks || []).find(task => task.id === taskId) || null;
}

function findSubtask(siteData, parentId, title) {
	return (siteData.snapshot?.tasks || []).find(task => task.parentId === parentId && normalizeText(task.title) === normalizeText(title)) || null;
}

function countSubtasks(siteData, parentId, title) {
	return (siteData.snapshot?.tasks || []).filter(task => task.parentId === parentId && normalizeText(task.title) === normalizeText(title)).length;
}

function findEvent(events, predicate) {
	return events.find(predicate) || null;
}

function countEvents(events, predicate) {
	return events.filter(predicate).length;
}

function taskHasLink(task, targetId, linkType) {
	return (task?.linkedIssues || []).some(link => link.targetId === targetId && link.linkType === linkType);
}

function taskHasStatusEvent(events, taskId, status) {
	return events.some(event => {
		if (event.type === 'card_created') {
			return event.data?.taskId === taskId && event.data?.status === status;
		}
		if (event.type === 'card_moved') {
			return event.data?.taskId === taskId && event.data?.toStatus === status;
		}
		if (event.type === 'card_edited') {
			return event.data?.taskId === taskId && event.data?.changes?.status?.to === status;
		}
		return false;
	});
}

function eventMentionsAll(eventText, groups) {
	return textContainsAllGroups(eventText, groups);
}

const TASKS = {
	'EVAL-01': {
		desc: 'Turn Jordan\'s CI/CD migration thread into an owned handoff.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['jenkins', 'github actions'],
				['cutover', 'migration', 'ci/cd', 'pipeline'],
			]));

			const emailCandidate = findOutlookEmailByEvent(outlook, (email, event) =>
				eventHasRecipient(event, 'jordan.kim@contoso.com') && emailHasRecipient(email, 'jordan.kim@contoso.com')
			);

			const emailText = emailCandidate ? `${emailCandidate.email.subject} ${emailCandidate.email.body}` : '';

			return finalizeChecks([
				createCheck(
					'Created a new Jenkins-to-GitHub-Actions cutover task',
					Boolean(taskCandidate),
					'No newly created ScrumBoard task clearly tied to the Jenkins-to-GitHub-Actions cutover was found.'
				),
				createCheck(
					'Set the task to Sprint 3, high priority, assigned to Frank Lee, with the devops tag',
					Boolean(taskCandidate?.task) && taskCandidate.task.sprintId === 'sprint-3' && taskCandidate.task.priority === 'high' && taskCandidate.task.assigneeId === 'user-6' && (taskCandidate.task.tags || []).includes('tag-10'),
					!taskCandidate?.task
						? 'The CI/CD cutover task was not found in the ScrumBoard snapshot.'
						: `Expected Sprint 3 / high / Frank Lee / devops, got sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Emailed Jordan with the 47-job scope, the 2-week parallel run, and the $48k renewal risk',
					Boolean(emailCandidate) && eventMentionsAll(emailText, [
						['47'],
						['2 week', '2-week', '2 weeks'],
						['48k', '$48k', '48,000', '48000'],
					]),
					!emailCandidate
						? 'No sent email to jordan.kim@contoso.com was found in the event log and snapshot.'
						: 'The email to Jordan Kim is missing one or more required facts: 47 pipeline jobs, the 2-week parallel run, or the $48k renewal risk.'
				),
			], 'Jordan\'s CI/CD thread was converted into an owned Sprint 3 task and a written handoff email.');
		},
	},

	'EVAL-02': {
		desc: 'Cross-mail triage: categorize and download in Outlook, label and forward in Gmail.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const gmail = bundle.gmail;

			const auditEmail = getOutlookEmail(outlook.snapshot, 'email-052');
			const categoryEvent = findEvent(outlook.events, event => event.type === 'email_categorized' && event.emailId === 'email-052' && normalizeText(event.category) === 'purple');
			const dl1 = findEvent(outlook.events, event => event.type === 'attachment_downloaded' && event.emailId === 'email-052' && normalizeText(event.filename) === normalizeText('Accessibility_Audit_Report_v2.8.pdf'));
			const dl2 = findEvent(outlook.events, event => event.type === 'attachment_downloaded' && event.emailId === 'email-052' && normalizeText(event.filename) === normalizeText('WCAG_Violations_List.xlsx'));
			const forwardedOutlook = findOutlookEmailByEvent(outlook, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === 'email-052'
				&& eventHasRecipient(event, 'jennifer.park@contoso.com')
				&& emailHasRecipient(email, 'jennifer.park@contoso.com')
			);
			const fwdOutlookText = forwardedOutlook ? `${forwardedOutlook.email.subject} ${forwardedOutlook.email.body}` : '';

			const gmailEmail014 = getGmailEmail(gmail.snapshot, 'email-014');
			const gmailEmail022 = getGmailEmail(gmail.snapshot, 'email-022');
			const label014 = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === 'email-014' && event.labelId === 'label-work');
			const label022 = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === 'email-022' && event.labelId === 'label-work');
			const forwardedGmail = findGmailEmailByEvent(gmail, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === 'email-014'
				&& event.to?.includes('sarah.mitchell@techcorp.com')
				&& emailHasRecipient(email, 'sarah.mitchell@techcorp.com')
			);
			const fwdGmailText = forwardedGmail ? `${forwardedGmail.email.subject} ${forwardedGmail.email.body}` : '';

			return finalizeChecks([
				createCheck(
					'Categorized the accessibility audit email as purple and downloaded both attachments',
					Boolean(auditEmail) && normalizeText(auditEmail.category || '') === 'purple' && Boolean(categoryEvent) && Boolean(dl1) && Boolean(dl2),
					!auditEmail
						? 'The accessibility audit email (email-052) was not found in Outlook.'
						: normalizeText(auditEmail.category || '') !== 'purple'
							? 'The accessibility audit email is not categorized as purple in Outlook.'
							: !categoryEvent
								? 'No email_categorized event marked the audit email as purple.'
								: 'One or both attachment downloads were not recorded for the accessibility audit email.'
				),
				createCheck(
					'Forwarded the accessibility audit to Jennifer Park with the 4 critical issues and 18-hour estimate',
					Boolean(forwardedOutlook) && eventMentionsAll(fwdOutlookText, [
						['4 critical'],
						['18 hour', '18-hour', '18 hours'],
					]),
					!forwardedOutlook
						? 'No forward of the accessibility audit to jennifer.park@contoso.com was found.'
						: 'The forward to Jennifer Park is missing the 4 critical issues or 18-hour remediation estimate.'
				),
				createCheck(
					'Applied the Work label to the architecture notes and the all-hands agenda in Gmail',
					Boolean(gmailEmail014) && (gmailEmail014.labels || []).includes('label-work') && Boolean(label014)
						&& Boolean(gmailEmail022) && (gmailEmail022.labels || []).includes('label-work') && Boolean(label022),
					!gmailEmail014 || !gmailEmail022
						? 'The architecture notes or all-hands agenda email was not found in Gmail.'
						: 'The Work label was not applied to both emails with matching email_labeled events.'
				),
				createCheck(
					'Forwarded the architecture notes to Sarah Mitchell mentioning microservices and Kubernetes',
					Boolean(forwardedGmail) && eventMentionsAll(fwdGmailText, [
						['microservices'],
						['kubernetes'],
					]),
					!forwardedGmail
						? 'No forward of the architecture notes to sarah.mitchell@techcorp.com was found in Gmail.'
						: 'The forward to Sarah Mitchell is missing the microservices or Kubernetes decision.'
				),
			], 'The cross-mail triage was completed with categorization, downloads, labeling, and targeted forwards.');
		},
	},

	'EVAL-03': {
		desc: 'Combine the dependency audit and auth incident into one urgent response.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const teams = bundle.teams;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['jsonwebtoken'],
				['signing key', 'auth exposure', 'jwt'],
			]));

			const messageCandidates = findNewTeamsMessages(teams, message => message.conversationId === 'conv-g3');
			const messageCandidate = findCandidateWithGroups(messageCandidates, [
				['jsonwebtoken'],
				['cve-2025-12001'],
				['27 minute', '27-minute', '27 minutes'],
				['14,200', '14200', '14.2k'],
			], message => `${message.bodyText || ''} ${message.body || ''}`);

			return finalizeChecks([
				createCheck(
					'Created a new jsonwebtoken auth-exposure bug',
					Boolean(taskCandidate),
					'No newly created ScrumBoard bug for the jsonwebtoken signing-key exposure was found.'
				),
				createCheck(
					'Set the bug to Sprint 2, critical, assigned to Alice Chen, tagged security, and moved it to In Progress',
					Boolean(taskCandidate?.task) && taskCandidate.task.type === 'bug' && taskCandidate.task.sprintId === 'sprint-2' && taskCandidate.task.priority === 'critical' && taskCandidate.task.assigneeId === 'user-1' && (taskCandidate.task.tags || []).includes('tag-7') && taskCandidate.task.status === 'inprogress',
					!taskCandidate?.task
						? 'The jsonwebtoken auth-exposure bug was not found in the ScrumBoard snapshot.'
						: `Expected bug / Sprint 2 / critical / Alice / security / inprogress, got type=${taskCandidate.task.type}, sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}, status=${taskCandidate.task.status}.`
				),
				createCheck(
					'Alerted Incident Response with jsonwebtoken, CVE-2025-12001, 27 minutes, and 14,200 sessions',
					Boolean(messageCandidate),
					!messageCandidate
						? 'No new Incident Response Team message was found for the auth incident.'
						: 'The Incident Response Team message is missing one or more required auth-incident facts.'
				),
			], 'The auth incident was converted into an urgent Sprint 2 bug and the incident room got the concrete impact details.');
		},
	},

	'EVAL-04': {
		desc: 'Complete Sprint 2, move backlog items to Sprint 3, and announce in Teams.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const teams = bundle.teams;

			const sprint2 = (scrum.snapshot?.sprints || []).find(s => s.id === 'sprint-2') || null;
			const scrum024 = findTask(scrum, 'SCRUM-024');
			const scrum031 = findTask(scrum, 'SCRUM-031');
			const scrum032 = findTask(scrum, 'SCRUM-032');
			const unexpectedSprintMoves = (scrum.db?.tasks || [])
				.filter(task => !['SCRUM-024', 'SCRUM-031', 'SCRUM-032'].includes(task.id))
				.filter(task => findTask(scrum, task.id)?.sprintId !== task.sprintId)
				.map(task => task.id);

			const teamsMessages = findNewTeamsMessages(teams, message => message.conversationId === 'conv-g4');
			const teamsMessage = findCandidateWithGroups(teamsMessages, [
				['sprint 2'],
				['sprint 3'],
				['scrum-024', '024'],
				['scrum-031', '031'],
				['scrum-032', '032'],
			], message => `${message.bodyText || ''} ${message.body || ''}`);

			return finalizeChecks([
				createCheck(
					'Completed Sprint 2',
					Boolean(sprint2) && sprint2.status === 'completed',
					!sprint2
						? 'Sprint 2 was not found in the ScrumBoard snapshot.'
						: 'Sprint 2 is not marked completed in the ScrumBoard snapshot.'
				),
				createCheck(
					'Moved SCRUM-024, SCRUM-031, and SCRUM-032 into Sprint 3',
					scrum024?.sprintId === 'sprint-3' && scrum031?.sprintId === 'sprint-3' && scrum032?.sprintId === 'sprint-3',
					'One or more of SCRUM-024, SCRUM-031, SCRUM-032 were not moved to Sprint 3.'
				),
				createCheck(
					'Set SCRUM-031 story points to 8 and reassigned it to Alice Chen',
					Boolean(scrum031) && scrum031.storyPoints === 8 && scrum031.assigneeId === 'user-1',
					!scrum031
						? 'SCRUM-031 was not found in the ScrumBoard snapshot.'
						: `Expected storyPoints=8 and assignee=Alice Chen, got storyPoints=${scrum031.storyPoints}, assignee=${scrum031.assigneeId}.`
				),
				createCheck(
					'Left other backlog items in their original sprints',
					unexpectedSprintMoves.length === 0,
					`Unexpected sprint changes were detected for: ${unexpectedSprintMoves.join(', ')}.`
				),
				createCheck(
					'Posted the Sprint 2 closure and Sprint 3 planning update in announcements, mentioning carried-over items',
					Boolean(teamsMessage),
					!teamsMessage
						? 'No new message was found in the Teams announcements channel.'
						: 'The announcements message is missing Sprint 2/3 reference or the carried-over item IDs (SCRUM-024, SCRUM-031, SCRUM-032).'
				),
			], 'Sprint 2 was completed, backlog items moved to Sprint 3, and the team was notified in announcements.');
		},
	},

	'EVAL-05': {
		desc: 'Multi-RSVP calendar triage and reschedule with Teams DMs to affected attendees.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			const q2Planning = findCalendarEventById(outlook.snapshot, 'event-031');
			const securityTraining = findCalendarEventById(outlook.snapshot, 'event-033');
			const archReview = findCalendarEventById(outlook.snapshot, 'event-035');

			const contentGroups = [
				['q2 planning', 'q2 kickoff', 'kickoff'],
				['declin', 'declined'],
				['architecture review', 'arch review'],
				['11:30', '11 30'],
			];

			// Morgan Chen DM (conv-2)
			const morganMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-2'),
				contentGroups,
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			// Avery Thompson DM (conv-6)
			const averyMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-6'),
				contentGroups,
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Declined the Q2 Planning kickoff and accepted Security Training',
					Boolean(q2Planning) && normalizeText(q2Planning.rsvp || '') === 'declined'
						&& Boolean(securityTraining) && normalizeText(securityTraining.rsvp || '') === 'accepted',
					!q2Planning || !securityTraining
						? 'The Q2 Planning or Security Training event was not found in Outlook.'
						: normalizeText(q2Planning.rsvp || '') !== 'declined'
							? 'The Q2 Planning event was not declined.'
							: 'The Security Training event was not accepted.'
				),
				createCheck(
					'Rescheduled the Architecture Review to 11:30-13:00',
					Boolean(archReview) && archReview.startTime === '11:30' && archReview.endTime === '13:00',
					!archReview
						? 'The Architecture Review event was not found in Outlook.'
						: `Expected 11:30-13:00, got ${archReview.startTime}-${archReview.endTime}.`
				),
				createCheck(
					'Sent Morgan Chen a DM about the calendar changes',
					Boolean(morganMsg),
					!morganMsg
						? 'No new Teams DM to Morgan Chen was found.'
						: 'The DM to Morgan Chen is missing the Q2 planning decline, architecture review, or the 11:30 reschedule detail.'
				),
				createCheck(
					'Sent Avery Thompson a DM about the calendar changes',
					Boolean(averyMsg),
					!averyMsg
						? 'No new Teams DM to Avery Thompson was found.'
						: 'The DM to Avery Thompson is missing the Q2 planning decline, architecture review, or the 11:30 reschedule detail.'
				),
			], 'The calendar was triaged with multi-RSVP and a reschedule, and both affected attendees were notified via DM.');
		},
	},

	'EVAL-06': {
		desc: 'Build the observability recommendation packet before the VP SLA review.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['observability renewal'],
				['recommendation'],
			]));

			const slaReview = getSeedEvent(outlook.db, 'SLA Breach Review with VP Eng');
			const eventRecord = findCreatedCalendarEvents(outlook, calendarEvent =>
				calendarEvent.title === 'Observability Renewal Review'
				&& calendarEvent.date === slaReview?.date
				&& calendarEvent.startTime === '13:00'
				&& calendarEvent.endTime === '13:45'
			)[0] || null;

			const emailCandidates = findNewOutlookEmails(outlook, email =>
				emailHasRecipient(email, 'sarah.kim@contoso.com')
				&& normalizeText(email.subject).includes(normalizeText('Observability renewal recommendation'))
			);
			const emailCandidate = findCandidateWithGroups(emailCandidates, [
				['grafana'],
				['90k', '$90k', '90,000', '90000'],
			], email => `${email.subject || ''} ${email.body || ''}`);

			const notes = eventRecord ? eventRecord.notes : '';
			const attendees = new Set(eventRecord?.attendees || []);

			return finalizeChecks([
				createCheck(
					'Created the observability renewal recommendation task',
					Boolean(taskCandidate),
					'No newly created ScrumBoard task titled around finalizing the observability renewal recommendation was found.'
				),
				createCheck(
					'Set the task to Sprint 2, high priority, assigned to Frank Lee, with the devops tag',
					Boolean(taskCandidate?.task) && taskCandidate.task.sprintId === 'sprint-2' && taskCandidate.task.priority === 'high' && taskCandidate.task.assigneeId === 'user-6' && (taskCandidate.task.tags || []).includes('tag-10'),
					!taskCandidate?.task
						? 'The observability renewal task was not found in the ScrumBoard snapshot.'
						: `Expected Sprint 2 / high / Frank Lee / devops, got sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Scheduled Observability Renewal Review before the VP SLA review with Sarah Kim and Tom Nguyen',
					Boolean(eventRecord) && attendees.has('sarah.kim@contoso.com') && attendees.has('tom.nguyen@contoso.com'),
					!eventRecord
						? 'No new Outlook event named "Observability Renewal Review" was created on the SLA review date from 1:00 PM to 1:45 PM.'
						: 'Observability Renewal Review is missing Sarah Kim or Tom Nguyen as attendees.'
				),
				createCheck(
					'Captured Datadog $186,000, the 18% increase, 2.4 TB/day, and the ~$90k hybrid option in the event notes',
					Boolean(eventRecord) && eventMentionsAll(notes, [
						['186,000', '186000', '186k'],
						['18%', '18 percent'],
						['2.4 tb/day', '2.4 tb', '2.4tb/day'],
						['90k', '$90k', '90,000', '90000'],
					]),
					!eventRecord
						? 'Observability Renewal Review was not created, so its notes cannot be verified.'
						: 'Observability Renewal Review notes are missing one or more required observability-renewal facts.'
				),
				createCheck(
					'Emailed Sarah Kim with the observability recommendation and the Grafana / hybrid option',
					Boolean(emailCandidate),
					!emailCandidate
						? 'No sent email to sarah.kim@contoso.com with subject "Observability renewal recommendation" was found.'
						: 'The email to Sarah Kim is missing Grafana Cloud or the ~$90k hybrid option.'
				),
			], 'The observability recommendation packet was created, scheduled, and sent before the VP SLA review.');
		},
	},

	'EVAL-07': {
		desc: 'Create a board-prep engineering follow-up from revenue, experiment, and metrics data.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['board discussion', 'board prep', 'board'],
				['/charges', 'charges'],
			]));

			const emailCandidate = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email => emailHasRecipient(email, 'marcus.thompson@contoso.com')),
				[['/charges', 'charges'], ['2.14', '2.14%']],
				email => `${email.subject || ''} ${email.body || ''}`
			);

			const messageCandidate = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g1'),
				[['5.686m', '5,686,000', '5,686'], ['20.8', '20.8%'], ['43,200', '43200', '43.2k']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Created the board-discussion /charges verification task',
					Boolean(taskCandidate),
					'No newly created ScrumBoard task for board-discussion /charges verification was found.'
				),
				createCheck(
					'Set the task to Sprint 2, high priority, assigned to Bob Martinez, with backend and docs tags',
					Boolean(taskCandidate?.task) && taskCandidate.task.sprintId === 'sprint-2' && taskCandidate.task.priority === 'high' && taskCandidate.task.assigneeId === 'user-2' && (taskCandidate.task.tags || []).includes('tag-2') && (taskCandidate.task.tags || []).includes('tag-9'),
					!taskCandidate?.task
						? 'The board-discussion /charges verification task was not found in the ScrumBoard snapshot.'
						: `Expected Sprint 2 / high / Bob / backend+docs, got sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Emailed Marcus Thompson to verify the /charges numbers before the board discussion',
					Boolean(emailCandidate),
					!emailCandidate
						? 'No new email to marcus.thompson@contoso.com was found for board prep.'
						: 'The email to Marcus Thompson is missing the /charges verification request or the 2.14% error rate.'
				),
				createCheck(
					'Posted the $5.686M revenue, +20.8% lift, and $43,200/month impact in Engineering Leads',
					Boolean(messageCandidate),
					!messageCandidate
						? 'No new Engineering Leads message was found for board-prep follow-through.'
						: 'The Engineering Leads message is missing one or more required board-prep headline numbers.'
				),
			], 'The board-prep engineering follow-up was captured in ScrumBoard, email, and Teams.');
		},
	},

	'EVAL-08': {
		desc: 'Lock down one launch-blocker owner path.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['launch blockers', 'launch blocker review', 'onboarding launch blockers'],
				['enterprise onboarding', 'onboarding'],
			]));

			const abReview = getSeedEvent(outlook.db, 'A/B Test Review: Checkout Experiment CKO-42');
			const eventRecord = outlook.events
				.filter(event => event.type === 'cal_event_created')
				.map(event => ({ event, calendarEvent: findCalendarEventById(outlook.snapshot, event.eventId) }))
				.find(candidate => {
					const calendarEvent = candidate.calendarEvent;
					return Boolean(calendarEvent)
						&& calendarEvent.title === 'Launch Blocker Review'
						&& calendarEvent.date === abReview?.date
						&& calendarEvent.startTime === '13:30'
						&& calendarEvent.endTime === '14:15';
				}) || null;

			const attendees = new Set(eventRecord?.calendarEvent?.attendees || []);
			const notes = eventRecord?.calendarEvent?.notes || '';

			return finalizeChecks([
				createCheck(
					'Created the enterprise onboarding launch blockers task',
					Boolean(taskCandidate),
					'No newly created ScrumBoard task for closing the enterprise onboarding launch blockers was found.'
				),
				createCheck(
					'Set the task to Sprint 3, critical priority, assigned to Alice Chen, with frontend and testing tags',
					Boolean(taskCandidate?.task) && taskCandidate.task.sprintId === 'sprint-3' && taskCandidate.task.priority === 'critical' && taskCandidate.task.assigneeId === 'user-1' && (taskCandidate.task.tags || []).includes('tag-1') && (taskCandidate.task.tags || []).includes('tag-6'),
					!taskCandidate?.task
						? 'The launch blockers task was not found in the ScrumBoard snapshot.'
						: `Expected Sprint 3 / critical / Alice / frontend+testing, got sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Scheduled Launch Blocker Review on the A/B review day with Sarah Kim, Nina Ross, and Jordan Lee',
					Boolean(eventRecord) && attendees.has('sarah.kim@contoso.com') && attendees.has('nina.ross@contoso.com') && attendees.has('jordan.lee@contoso.com'),
					!eventRecord
						? 'No new Outlook event named "Launch Blocker Review" was created on the A/B review date from 1:30 PM to 2:15 PM.'
						: 'Launch Blocker Review is missing Sarah Kim, Nina Ross, or Jordan Lee as attendees.'
				),
				createCheck(
					'Captured localization 82%, the missing support runbook owner, Northstar $210K, webhook 41%, and SSO/SAML 33% in the event notes',
					Boolean(eventRecord) && eventMentionsAll(notes, [
						['82', '82%'],
						['support runbook'],
						['northstar'],
						['210k', '$210k', '210,000', '210000'],
						['41', '41%'],
						['33', '33%'],
					]),
					!eventRecord
						? 'Launch Blocker Review was not created, so its notes cannot be verified.'
						: 'Launch Blocker Review notes are missing one or more required launch-blocker facts.'
				),
			], 'The launch blocker owner path was captured in a Sprint 3 task and a dedicated review event.');
		},
	},

	'EVAL-09': {
		desc: 'Build Taylor\'s ROI review packet.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const taskCandidate = findCreatedTask(scrum, task => textContainsAllGroups(`${task.title} ${task.description || ''}`, [
				['headcount roi review packet', 'roi review packet'],
				['platform', 'headcount'],
			]));

			const boardMeeting = getSeedEvent(outlook.db, 'Board Meeting');
			const eventRecord = outlook.events
				.filter(event => event.type === 'cal_event_created')
				.map(event => ({ event, calendarEvent: findCalendarEventById(outlook.snapshot, event.eventId) }))
				.find(candidate => {
					const calendarEvent = candidate.calendarEvent;
					return Boolean(calendarEvent)
						&& calendarEvent.title === 'Platform Headcount ROI Review'
						&& calendarEvent.date === boardMeeting?.date
						&& calendarEvent.startTime === '13:00'
						&& calendarEvent.endTime === '13:30';
				}) || null;

			const emailCandidate = findOutlookEmailByEvent(outlook, (email, event) =>
				eventHasRecipient(event, 'taylor.brooks@contoso.com')
					&& emailHasRecipient(email, 'taylor.brooks@contoso.com')
			);

			const attendees = new Set(eventRecord?.calendarEvent?.attendees || []);
			const emailText = emailCandidate ? `${emailCandidate.email.subject} ${emailCandidate.email.body}` : '';

			return finalizeChecks([
				createCheck(
					'Created the platform headcount ROI review packet task',
					Boolean(taskCandidate),
					'No newly created ScrumBoard task called out the platform headcount ROI review packet.'
				),
				createCheck(
					'Set the task to Sprint 3, high priority, assigned to Emma Johnson, with the docs tag',
					Boolean(taskCandidate?.task) && taskCandidate.task.sprintId === 'sprint-3' && taskCandidate.task.priority === 'high' && taskCandidate.task.assigneeId === 'user-5' && (taskCandidate.task.tags || []).includes('tag-9'),
					!taskCandidate?.task
						? 'The headcount ROI review task was not found in the ScrumBoard snapshot.'
						: `Expected Sprint 3 / high / Emma / docs, got sprint=${taskCandidate.task.sprintId}, priority=${taskCandidate.task.priority}, assignee=${taskCandidate.task.assigneeId}, tags=${(taskCandidate.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Scheduled Platform Headcount ROI Review on the Board Meeting day with Taylor Brooks and Sarah Kim',
					Boolean(eventRecord) && attendees.has('taylor.brooks@contoso.com') && attendees.has('sarah.kim@contoso.com'),
					!eventRecord
						? 'No new Outlook event named "Platform Headcount ROI Review" was created on the Board Meeting date from 1:00 PM to 1:30 PM.'
						: 'Platform Headcount ROI Review is missing Taylor Brooks or Sarah Kim as attendees.'
				),
				createCheck(
					'Emailed Taylor with the 3 FTE request, $900k/year cost, 18-month break-even, and 6-month contractor comparison',
					Boolean(emailCandidate) && eventMentionsAll(emailText, [
						['3 fte', '3 engineers', 'three fte'],
						['900k', '$900k', '900,000', '900000'],
						['18 month', '18-month', '18 months'],
						['6 month', '6-month', '6 months'],
					]),
					!emailCandidate
						? 'No new email to taylor.brooks@contoso.com was found.'
						: 'The email to Taylor Brooks is missing one or more required ROI-model facts.'
				),
			], 'Taylor\'s ROI review packet was captured in ScrumBoard, on the calendar, and in email.');
		},
	},

	'EVAL-10': {
		desc: 'Reply-all to the hiring pipeline with Cc, then filter and link bugs in ScrumBoard.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;

			const hiringReplyCandidates = findOutlookEmailCandidatesByEvent(outlook, (email, event) =>
				event.replyToId === 'email-062'
				&& ['replyAll', 'reply-all'].includes(event.mode)
				&& eventHasRecipient(event, 'rachel.green@contoso.com')
				&& emailHasRecipient(email, 'rachel.green@contoso.com')
			);
			const hiringReply = hiringReplyCandidates.find(candidate => {
				const replyText = `${candidate.email.subject || ''} ${candidate.email.body || ''}`;
				const hasCc = (Array.isArray(candidate.email.cc) && candidate.email.cc.some(entry => {
					const addr = typeof entry === 'string' ? entry : (entry.email || '');
					return addr.toLowerCase() === 'tom.nguyen@contoso.com';
				}))
					|| (Array.isArray(candidate.event.cc) && candidate.event.cc.some(addr => addr.toLowerCase() === 'tom.nguyen@contoso.com'));
				return hasCc && eventMentionsAll(replyText, [
					['senior backend'],
					['3 onsite', 'no offer', '3 candidates'],
				]);
			}) || hiringReplyCandidates[hiringReplyCandidates.length - 1] || null;
			const replyText = hiringReply ? `${hiringReply.email.subject} ${hiringReply.email.body}` : '';
			const hasCc = hiringReply && (
				(Array.isArray(hiringReply.email.cc) && hiringReply.email.cc.some(entry => {
					const addr = typeof entry === 'string' ? entry : (entry.email || '');
					return addr.toLowerCase() === 'tom.nguyen@contoso.com';
				}))
				|| (Array.isArray(hiringReply.event.cc) && hiringReply.event.cc.some(addr => addr.toLowerCase() === 'tom.nguyen@contoso.com'))
			);

			const bugFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'type' && normalizeText(event.data?.value || '') === 'bug');
			const scrum003 = findTask(scrum, 'SCRUM-003');

			return finalizeChecks([
				createCheck(
					'Replied to the hiring pipeline update with Cc to Tom Nguyen, mentioning the Senior Backend role',
					Boolean(hiringReply) && hasCc && eventMentionsAll(replyText, [
						['senior backend'],
						['3 onsite', '3 candidates'],
						['no offer', '0 offer', 'no offer yet'],
					]),
					!hiringReply
						? 'No reply to Rachel Green\'s hiring pipeline update (email-062) was found.'
						: !hasCc
							? 'The reply to Rachel Green does not include tom.nguyen@contoso.com in Cc.'
							: 'The reply is missing the Senior Backend recommendation, the 3 onsite-candidate fact, or the no-offer detail.'
				),
				createCheck(
					'Applied the bug type filter in ScrumBoard',
					Boolean(bugFilter),
					'No ScrumBoard filter_applied event for the bug type was found.'
				),
				createCheck(
					'Set SCRUM-003 story points to 13',
					Boolean(scrum003) && scrum003.storyPoints === 13,
					!scrum003
						? 'SCRUM-003 was not found in the ScrumBoard snapshot.'
						: `Expected storyPoints=13, got ${scrum003.storyPoints}.`
				),
				createCheck(
					'Linked SCRUM-003 to SCRUM-009 as blocks',
					Boolean(scrum003) && taskHasLink(scrum003, 'SCRUM-009', 'blocks'),
					!scrum003
						? 'SCRUM-003 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-003 is not linked to SCRUM-009 as blocks in the snapshot.'
				),
			], 'The hiring pipeline got a Cc\'d reply and the ScrumBoard bug dependencies were updated.');
		},
	},

	'EVAL-11': {
		desc: 'Build the enterprise escalation packet in Outlook and Teams.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			const escalationFolder = getFolderByName(outlook.snapshot, 'Enterprise Escalations');
			const seedEscalationFolder = getFolderByName({ folders: outlook.db?.folders || [] }, 'Enterprise Escalations');
			const requiredMoveIds = ['email-053', 'email-059', 'email-060'];
			const movedAllRequired = Boolean(escalationFolder) && requiredMoveIds.every(emailId => {
				const email = getOutlookEmail(outlook.snapshot, emailId);
				return email && email.folder === escalationFolder.id;
			});
			const folderId = escalationFolder?.id || null;
			const unexpectedFolderMoves = (outlook.db?.emails || [])
				.filter(email => !requiredMoveIds.includes(email.id))
				.filter(email => getOutlookEmail(outlook.snapshot, email.id)?.folder !== email.folder)
				.map(email => email.id);
			const extraFolderContents = folderId
				? (outlook.snapshot?.emails || []).filter(email => email.folder === folderId && !requiredMoveIds.includes(email.id)).map(email => email.id)
				: [];

			const forwardedEmailEventCandidates = findOutlookEmailCandidatesByEvent(outlook, (email, event) =>
				eventHasRecipient(event, 'marcus.thompson@contoso.com')
				&& emailHasRecipient(email, 'marcus.thompson@contoso.com')
			);
			const forwardedEmailSnapshotCandidates = findNewOutlookEmails(outlook, email =>
				emailHasRecipient(email, 'marcus.thompson@contoso.com')
			).map(email => ({ event: null, email }));
			const forwardedEmail = findCandidateWithGroups(
				[...forwardedEmailEventCandidates, ...forwardedEmailSnapshotCandidates].filter(candidate => {
					const subjectText = candidate.email?.subject || '';
					const bodyText = candidate.email?.body || '';
					return candidate.event?.mode === 'forward'
						|| candidate.event?.replyToId === 'email-060'
						|| candidate.email?.replyToId === 'email-060'
						|| (/^fwd:/i.test(subjectText) && normalizeText(bodyText).includes('forwarded message'));
				}),
				[
					['acme'],
					['124k', '$124k', '124,000', '124000'],
					['/api/v2/charges', 'charges'],
					['2.14', '2.14%'],
					['142 gb', '142gb', '142'],
				],
				candidate => `${candidate.email.subject || ''} ${candidate.email.body || ''}`
			);
			const watchlistMessage = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g3'),
				[['acme'], ['globaltech']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Created the Enterprise Escalations folder and moved all three required Outlook emails into it',
					Boolean(escalationFolder) && !seedEscalationFolder && movedAllRequired,
					!escalationFolder
						? 'The Enterprise Escalations folder was not found in the Outlook snapshot.'
						: seedEscalationFolder
							? 'Enterprise Escalations already exists in the seed data, so the create-folder requirement cannot be distinguished.'
							: !movedAllRequired
								? 'One or more required emails were not moved into Enterprise Escalations.'
								: 'Expected the Enterprise Escalations triage to be complete.'
				),
				createCheck(
					'Forwarded Jordan\'s escalation report to Marcus Thompson with the ARR, error-rate, and orders-table facts',
					Boolean(forwardedEmail),
					!forwardedEmail
						? 'No forwarded Outlook email to marcus.thompson@contoso.com tied to Jordan Lee\'s report was found.'
						: 'The Marcus Thompson forward is missing Acme, ARR, the failing /api/v2/charges endpoint, the 2.14% error rate, or the 142 GB orders-table fact.'
				),
				createCheck(
					'Posted the Acme and GlobalTech watchlist summary in Incident Response Team',
					Boolean(watchlistMessage),
					!watchlistMessage
						? 'No new Incident Response Team message was found for the escalation watchlist.'
						: 'The Incident Response Team message is missing Acme or GlobalTech.'
				),
				createCheck(
					'Only the three required Outlook emails were moved into the escalation folder',
					extraFolderContents.length === 0 && unexpectedFolderMoves.length === 0,
					extraFolderContents.length > 0
						? `Unexpected emails were moved into Enterprise Escalations: ${extraFolderContents.join(', ')}.`
						: `Unexpected folder changes were detected for: ${unexpectedFolderMoves.join(', ')}.`
				),
			], 'The enterprise escalation packet was organized in Outlook and summarized in Incident Response Team.');
		},
	},

	'EVAL-12': {
		desc: 'Convert Priya\'s dependency audit into subtasks under SCRUM-001.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;

			const priyaReply = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email =>
					email.replyToId === 'email-061' && emailHasRecipient(email, 'priya.sharma@contoso.com')
				),
				[['approve', 'approved'], ['jsonwebtoken'], ['cve-2025-12001'], ['2 hour', '2-hour', '2 hours']],
				email => `${email.subject || ''} ${email.body || ''}`
			);
			const upgradeSubtask = findSubtask(scrum, 'SCRUM-001', 'Upgrade jsonwebtoken to 9.0.3');
			const blastRadiusSubtask = findSubtask(scrum, 'SCRUM-001', 'Review tenant-by-tenant blast radius');

			return finalizeChecks([
				createCheck(
					'Replied to Priya approving the jsonwebtoken patch with the CVE and 2-hour ETA',
					Boolean(priyaReply),
					!priyaReply
						? 'No reply to Priya Sharma\'s dependency audit email was found.'
						: 'The reply to Priya is missing approval language, jsonwebtoken, CVE-2025-12001, or the 2-hour ETA.'
				),
				createCheck(
					'Created both required SCRUM-001 subtasks',
					Boolean(upgradeSubtask) && Boolean(blastRadiusSubtask),
					'One or both required SCRUM-001 subtasks were not found in the ScrumBoard snapshot.'
				),
				createCheck(
					'Marked the jsonwebtoken upgrade subtask done',
					Boolean(upgradeSubtask) && upgradeSubtask.status === 'done',
					!upgradeSubtask
						? 'The jsonwebtoken upgrade subtask was not found.'
						: 'The jsonwebtoken upgrade subtask is not marked done in the ScrumBoard snapshot.'
				),
			], 'Priya\'s audit now has an explicit approval reply and concrete subtasks under SCRUM-001.');
		},
	},

	'EVAL-13': {
		desc: 'Turn Jordan\'s timeout concern into a quoted Teams reply and a concrete Scrum follow-up.',
		verify(bundle) {
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;

			const quotedReply = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-1' && message.replyToId === 'msg-1-12'),
				[['2 week', '2-week', '2 weeks'], ['matrix job', 'matrix jobs'], ['sign off', 'sign-off', 'signoff']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);
			const scrum012 = findTask(scrum, 'SCRUM-012');
			const subtask = findSubtask(scrum, 'SCRUM-012', 'Split nightly regression suite into matrix jobs');

			return finalizeChecks([
				createCheck(
					'Replied directly to Jordan\'s 6-hour timeout message with the 2-week run and matrix-jobs plan',
					Boolean(quotedReply),
					!quotedReply
						? 'No direct quoted reply to Jordan\'s 6-hour timeout message was found in Teams.'
						: 'The quoted reply to Jordan is missing the sign-off language, 2-week run, or matrix-jobs detail.'
				),
				createCheck(
					'Raised SCRUM-012 to critical priority',
					Boolean(scrum012) && scrum012.priority === 'critical',
					!scrum012
						? 'SCRUM-012 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-012 is not critical in the ScrumBoard snapshot.'
				),
				createCheck(
					'Added the matrix-jobs subtask under SCRUM-012',
					Boolean(subtask),
					'The matrix-jobs subtask under SCRUM-012 was not found.'
				),
			], 'Jordan\'s timeout concern now has a quoted Teams reply and a concrete Scrum follow-up.');
		},
	},

	'EVAL-14': {
		desc: 'Forward the Phoenix blocker through Gmail and tie it to the right dashboard dependency in ScrumBoard.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const scrum = bundle.scrumboard;

			const phoenixEmail = getEmailBySubject(gmail.snapshot, 'Project Phoenix - Weekly Status Update');
			const forwardedEmail = findGmailEmailByEvent(gmail, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === phoenixEmail?.id
				&& event.to?.includes('emily.rodriguez@ux.studio')
				&& emailHasRecipient(email, 'emily.rodriguez@ux.studio')
			);
			const forwardedText = forwardedEmail ? `${forwardedEmail.email.subject} ${forwardedEmail.email.body}` : '';
			const scrum008 = findTask(scrum, 'SCRUM-008');
			const linkEvent = findEvent(scrum.events, event => event.type === 'issue_linked' && event.data?.sourceId === 'SCRUM-008' && event.data?.targetId === 'SCRUM-002' && event.data?.linkType === 'isBlockedBy');
			const subtask = findSubtask(scrum, 'SCRUM-008', 'Collect final Phoenix dashboard mockups from UX');
			const subtaskEvent = findEvent(scrum.events, event => event.type === 'subtask_created' && event.data?.parentId === 'SCRUM-008' && normalizeText(event.data?.title) === 'collect final phoenix dashboard mockups from ux');

			return finalizeChecks([
				createCheck(
					'Forwarded the Phoenix update to Emily Rodriguez with the blocker and prioritization note',
					Boolean(forwardedEmail) && eventMentionsAll(forwardedText, [
						['missing mockup', 'missing mockups'],
						['prioritized this week', 'prioritize this week'],
						['blocker'],
					]),
					!forwardedEmail
						? 'No Gmail forward tied to the Project Phoenix update was found for emily.rodriguez@ux.studio.'
						: 'The Phoenix forward is missing the blocker, mockups, or this-week prioritization detail.'
				),
				createCheck(
					'Linked SCRUM-008 to SCRUM-002 as isBlockedBy',
					Boolean(scrum008) && taskHasLink(scrum008, 'SCRUM-002', 'isBlockedBy') && Boolean(linkEvent),
					!scrum008
						? 'SCRUM-008 was not found in the ScrumBoard snapshot.'
						: !taskHasLink(scrum008, 'SCRUM-002', 'isBlockedBy')
							? 'SCRUM-008 is not linked to SCRUM-002 as isBlockedBy in the ScrumBoard snapshot.'
							: 'No issue_linked event linked SCRUM-008 to SCRUM-002 as isBlockedBy.'
				),
				createCheck(
					'Added the Phoenix UX mockups subtask under SCRUM-008',
					Boolean(subtask) && Boolean(subtaskEvent),
					!subtask
						? 'The Phoenix UX mockups subtask was not found under SCRUM-008.'
						: 'No subtask_created event was recorded for the Phoenix UX mockups subtask.'
				),
			], 'The Phoenix blocker was forwarded to UX and tied to a concrete Scrum dependency.');
		},
	},

	'EVAL-15': {
		desc: 'Group the vendor-review threads in Gmail and notify Taylor in Teams.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;

			const vendorLabel = getLabelByName(gmail.snapshot, 'Vendor Review');
			const renewalEmail = getGmailEmail(gmail.snapshot, 'email-039');
			const budgetEmail = getEmailBySubject(gmail.snapshot, 'Budget Approval for Q2 Marketing Campaign');
			const createLabelEvent = findEvent(gmail.events, event => event.type === 'label_created' && normalizeText(event.name) === 'vendor review');
			const renewalLabelEvent = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === renewalEmail?.id && event.labelId === vendorLabel?.id);
			const budgetLabelEvent = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === budgetEmail?.id && event.labelId === vendorLabel?.id);
			const starredEvent = findEvent(gmail.events, event => event.type === 'email_starred' && event.emailId === renewalEmail?.id);
			const teamsMessage = findTeamsMessageByEvent(teams, (message, event) => event.conversationId === 'conv-3' && message.conversationId === 'conv-3');
			const teamsText = teamsMessage ? `${teamsMessage.event.body} ${teamsMessage.message.body}` : '';

			return finalizeChecks([
				createCheck(
					'Created the Vendor Review label and applied it to both target Gmail threads',
					Boolean(vendorLabel) && Boolean(createLabelEvent)
						&& (renewalEmail?.labels || []).includes(vendorLabel.id)
						&& (budgetEmail?.labels || []).includes(vendorLabel.id)
						&& Boolean(renewalLabelEvent)
						&& Boolean(budgetLabelEvent),
					!vendorLabel
						? 'The Vendor Review label was not found in Gmail.'
						: !createLabelEvent
							? 'No label_created event was recorded for Vendor Review.'
							: 'Vendor Review was not applied to both the contract renewal and Q2 budget approval emails with matching email_labeled events.'
				),
				createCheck(
					'Starred the contract renewal email',
					Boolean(renewalEmail) && renewalEmail.starred === true && Boolean(starredEvent),
					!renewalEmail
						? 'The contract renewal email was not found in Gmail.'
						: renewalEmail.starred !== true
							? 'The contract renewal email is not starred in Gmail.'
							: 'No email_starred event was recorded for the contract renewal email.'
				),
				createCheck(
					'Sent Taylor Brooks the renewal summary in Teams',
					Boolean(teamsMessage) && eventMentionsAll(teamsText, [
						['15%', '15 percent'],
						['3 year', '3-year', '3 years'],
					]),
					!teamsMessage
						? 'No new Teams message to Taylor Brooks was found.'
						: 'The Teams message to Taylor Brooks is missing the 15% increase or 3-year term.'
				),
			], 'The vendor-review threads were grouped in Gmail and summarized to Taylor in Teams.');
		},
	},

	'EVAL-16': {
		desc: 'Archive the Promotions inbox noise in Gmail without touching non-promotions mail.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;

			const promoSeeds = (gmail.db?.emails || []).filter(email => email.folder === 'inbox' && email.category === 'promotions');
			const allPromotionsArchived = promoSeeds.every(seedEmail => {
				const current = getGmailEmail(gmail.snapshot, seedEmail.id);
				return current && current.folder !== 'inbox';
			});
			const archiveEventsCoverAll = countEvents(gmail.events, event => event.type === 'email_archived' && promoSeeds.some(seedEmail => seedEmail.id === event.emailId)) === promoSeeds.length;
			const bulkArchiveEvent = findEvent(gmail.events, event => event.type === 'bulk_action' && event.action === 'archive' && Number(event.count) >= promoSeeds.length);
			const contractRenewal = getGmailEmail(gmail.snapshot, 'email-039');
			const nonPromoSeeds = (gmail.db?.emails || []).filter(email => email.folder === 'inbox' && email.category !== 'promotions');
			const nonPromoStillInbox = nonPromoSeeds.every(seedEmail => {
				const current = getGmailEmail(gmail.snapshot, seedEmail.id);
				return current && current.folder === 'inbox';
			});
			const teamsMessage = findTeamsMessageByEvent(teams, (message, event) => event.conversationId === 'conv-g1' && message.conversationId === 'conv-g1');
			const teamsText = teamsMessage ? `${teamsMessage.event.body} ${teamsMessage.message.body}` : '';

			return finalizeChecks([
				createCheck(
					'Archived every Promotions email that started in the inbox',
					promoSeeds.length > 0 && allPromotionsArchived && (archiveEventsCoverAll || Boolean(bulkArchiveEvent)),
					promoSeeds.length === 0
						? 'No seed Promotions inbox emails were available to validate.'
						: !allPromotionsArchived
							? 'At least one Promotions email remained in the inbox.'
							: 'No matching bulk archive or per-email archive events were recorded for the Promotions cleanup.'
				),
				createCheck(
					'Left all non-Promotions inbox emails untouched',
					nonPromoStillInbox,
					'One or more non-Promotions inbox emails were moved out of the inbox, but they should have remained untouched.'
				),
				createCheck(
					'Posted the cleanup summary in Engineering Leads',
					Boolean(teamsMessage) && eventMentionsAll(teamsText, [
						['cleanup', 'promo cleanup'],
						['contract renewal'],
						['untouched'],
					]),
					!teamsMessage
						? 'No new Engineering Leads message was found for the Gmail cleanup.'
						: 'The Engineering Leads message is missing the cleanup completion or untouched-contract-renewal detail.'
				),
			], 'The Promotions inbox cleanup was completed without disturbing the contract renewal thread.');
		},
	},

	'EVAL-17': {
		desc: 'Clean up Gmail promo noise, apply Finance labels, and create an Outlook calendar event from a vendor email.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const outlook = bundle.outlook;

			const bestbuy = getGmailEmail(gmail.snapshot, 'email-006');
			const udemy = getGmailEmail(gmail.snapshot, 'email-015');
			const figma = getGmailEmail(gmail.snapshot, 'email-013');
			const boa = getGmailEmail(gmail.snapshot, 'email-018');
			const trashBB = findEvent(gmail.events, event => (event.type === 'email_trashed' || event.type === 'email_moved') && event.emailId === 'email-006');
			const trashUdemy = findEvent(gmail.events, event => (event.type === 'email_trashed' || event.type === 'email_moved') && event.emailId === 'email-015');
			const labelFigma = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === 'email-013' && event.labelId === 'label-finance');
			const labelBoa = findEvent(gmail.events, event => event.type === 'email_labeled' && event.emailId === 'email-018' && event.labelId === 'label-finance');

			const budgetSync = getSeedEvent(outlook.db, 'Budget Sync with Sarah');
			const newEvent = outlook.events
				.filter(event => event.type === 'cal_event_created')
				.map(event => ({ event, calendarEvent: findCalendarEventById(outlook.snapshot, event.eventId) }))
				.find(candidate => {
					const ce = candidate.calendarEvent;
					return Boolean(ce)
						&& normalizeText(ce.title).includes('contract review sync')
						&& ce.date === budgetSync?.date
						&& ce.startTime === '14:00'
						&& ce.endTime === '14:30';
				}) || null;
			const eventNotes = newEvent ? (newEvent.calendarEvent.notes || '') : '';
			const attendees = new Set(newEvent?.calendarEvent?.attendees || []);

			return finalizeChecks([
				createCheck(
					'Moved the BestBuy and Udemy promo emails to trash in Gmail',
					Boolean(bestbuy) && bestbuy.folder === 'trash' && Boolean(udemy) && udemy.folder === 'trash'
						&& Boolean(trashBB) && Boolean(trashUdemy),
					!bestbuy || !udemy
						? 'The BestBuy or Udemy email was not found in Gmail.'
						: bestbuy.folder !== 'trash' || udemy.folder !== 'trash'
							? 'The BestBuy or Udemy email was not moved to trash.'
							: 'Missing email_trashed events for the BestBuy or Udemy emails.'
				),
				createCheck(
					'Applied the Finance label to the Figma invoice and the bank statement',
					Boolean(figma) && (figma.labels || []).includes('label-finance') && Boolean(labelFigma)
						&& Boolean(boa) && (boa.labels || []).includes('label-finance') && Boolean(labelBoa),
					!figma || !boa
						? 'The Figma invoice or bank statement email was not found in Gmail.'
						: 'The Finance label was not applied to both emails with matching email_labeled events.'
				),
				createCheck(
					'Created Contract Review Sync on the Budget Sync day at 2:00 PM with Sarah Mitchell and Tom Bradley',
					Boolean(newEvent) && attendees.has('sarah.mitchell@contoso.com') && attendees.has('tom.bradley@cloudvendor.com'),
					!newEvent
						? 'No new Outlook event named "Contract Review Sync" was created on the Budget Sync date at 14:00-14:30.'
						: 'The Contract Review Sync event is missing Sarah Mitchell or Tom Bradley as attendees.'
				),
				createCheck(
					'Captured the 200TB and 99.999% uptime SLA from the vendor proposal in the event notes',
					Boolean(newEvent) && eventMentionsAll(eventNotes, [
						['200tb', '200 tb'],
						['99.999'],
					]),
					!newEvent
						? 'Contract Review Sync was not created, so its notes cannot be verified.'
						: 'The event notes are missing the 200TB capacity or 99.999% uptime SLA from the vendor proposal.'
				),
			], 'Gmail noise was cleaned up, Finance labels applied, and a vendor review event was created in Outlook.');
		},
	},

	'EVAL-18': {
		desc: 'Search and forward the launch matrix, then pull the right backlog items into Sprint 2.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;

			const launchMatrix = getOutlookEmail(outlook.snapshot, 'email-067');
			const unexpectedSprintMoves = (scrum.db?.tasks || [])
				.filter(task => !['SCRUM-024', 'SCRUM-029'].includes(task.id))
				.filter(task => findTask(scrum, task.id)?.sprintId !== task.sprintId)
				.map(task => task.id);

			const forwardedEmail = findCandidateWithGroups(
				findOutlookEmailCandidatesByEvent(outlook, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === launchMatrix?.id
				&& eventHasRecipient(event, 'marcus.thompson@contoso.com')
				&& emailHasRecipient(email, 'marcus.thompson@contoso.com')
				),
				[['82', '82%'], ['support runbook'], ['payments rollback drill', 'rollback drill']],
				candidate => `${candidate.email.subject || ''} ${candidate.email.body || ''}`
			);
			const scrum024 = findTask(scrum, 'SCRUM-024');
			const scrum029 = findTask(scrum, 'SCRUM-029');

			return finalizeChecks([
				createCheck(
					'Forwarded the March Launch Readiness Matrix to Marcus Thompson with the required launch details',
					Boolean(forwardedEmail),
					!forwardedEmail
						? 'No forward of the March Launch Readiness Matrix to Marcus Thompson was found.'
						: 'The Marcus Thompson forward is missing localization 82%, the support runbook owner, or the payments rollback drill.'
				),
				createCheck(
					'Added SCRUM-024 and SCRUM-029 to Sprint 2',
					Boolean(scrum024) && Boolean(scrum029) && scrum024.sprintId === 'sprint-2' && scrum029.sprintId === 'sprint-2',
					!scrum024 || !scrum029
						? 'SCRUM-024 or SCRUM-029 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-024 and SCRUM-029 were not both added to Sprint 2.'
				),
				createCheck(
					'Reassigned SCRUM-024 to Alice Chen',
					Boolean(scrum024) && scrum024.assigneeId === 'user-1',
					!scrum024
						? 'SCRUM-024 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-024 is not assigned to Alice Chen in the ScrumBoard snapshot.'
				),
				createCheck(
					'Left other backlog items in their original sprints',
					unexpectedSprintMoves.length === 0,
					`Unexpected sprint changes were detected for: ${unexpectedSprintMoves.join(', ')}.`
				),
			], 'The launch matrix was searched and forwarded, and the right backlog items were pulled into Sprint 2.');
		},
	},

	'EVAL-19': {
		desc: 'Pin the compliance and observability threads and follow up in Outlook.',
		verify(bundle) {
			const teams = bundle.teams;
			const outlook = bundle.outlook;

			const rileyConversation = getTeamsConversation(teams.snapshot, 'conv-5');
			const samConversation = getTeamsConversation(teams.snapshot, 'conv-8');
			const rileyOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-5'));
			const samOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-8'));
			const summaryMessage = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g1'),
				[['90k', '$90k', '90,000', '90000'], ['hybrid', 'grafana', 'datadog'], ['1,284', '1284'], ['365 day', '365-day', '365 days'], ['retention', 'policy gap', 'gdpr']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);
			const mayaReply = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email => email.replyToId === 'email-064' && emailHasRecipient(email, 'maya.patel@contoso.com')),
				[['540 day', '540-day', '540 days'], ['cleanup plan', 'cleanup']],
				email => `${email.subject || ''} ${email.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Opened Riley Patel\'s and Sam Lee\'s Teams conversations',
					rileyOpened && samOpened,
					!rileyOpened && !samOpened
						? 'Neither Riley Patel\'s nor Sam Lee\'s conversation was opened in Teams.'
						: !rileyOpened
							? 'Riley Patel\'s conversation was not opened in Teams.'
							: 'Sam Lee\'s conversation was not opened in Teams.'
				),
				createCheck(
					'Favorited Riley Patel\'s and Sam Lee\'s Teams conversations',
					rileyConversation?.isFavorite === true && samConversation?.isFavorite === true,
					'Riley Patel\'s or Sam Lee\'s conversation is not favorited in the Teams snapshot.'
				),
				createCheck(
					'Posted the observability and GDPR follow-up summary in Engineering Leads',
					Boolean(summaryMessage),
					!summaryMessage
						? 'No new Engineering Leads message was found for the compliance and observability summary.'
						: 'The Engineering Leads message is missing the hybrid observability recommendation or the GDPR backlog-versus-policy-gap detail.'
				),
				createCheck(
					'Replied to Maya Patel promising cleanup for the 540-day retention gap',
					Boolean(mayaReply),
					!mayaReply
						? 'No reply to Maya Patel\'s retention audit email was found.'
						: 'The reply to Maya Patel is missing the 540-day retention gap or cleanup-plan commitment.'
				),
			], 'The observability and compliance threads were pinned in Teams and followed up in Outlook.');
		},
	},

	'EVAL-20': {
		desc: 'Assemble the platform-risk planning bundle across ScrumBoard and Outlook.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const sprint3 = (scrum.snapshot?.sprints || []).find(sprint => sprint.id === 'sprint-3') || null;
			const scrum032 = findTask(scrum, 'SCRUM-032');
			const scrum035 = findTask(scrum, 'SCRUM-035');
			const scrum036 = findTask(scrum, 'SCRUM-036');
			const unexpectedSprintMoves = (scrum.db?.tasks || [])
				.filter(task => !['SCRUM-032', 'SCRUM-035', 'SCRUM-036'].includes(task.id))
				.filter(task => findTask(scrum, task.id)?.sprintId !== task.sprintId)
				.map(task => task.id);
			const riskTask = findCreatedTask(scrum, task => normalizeText(task.title) === normalizeText('Platform risk review follow-up'));
			const reviewSubtask = findSubtask(scrum, riskTask?.task?.id, 'Review SSO certificate rotation path');
			const forwardedEmail = findCandidateWithGroups(
				findOutlookEmailCandidatesByEvent(outlook, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === 'email-055'
				&& eventHasRecipient(event, 'tom.nguyen@contoso.com')
				&& emailHasRecipient(email, 'tom.nguyen@contoso.com')
				),
				[['99.91'], ['99.72'], ['81 minute', '81-minute', '81 minutes']],
				candidate => `${candidate.email.subject || ''} ${candidate.email.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Started Sprint 3 and added SCRUM-032, SCRUM-035, and SCRUM-036 to it',
					sprint3?.status === 'active'
						&& scrum032?.sprintId === 'sprint-3'
						&& scrum035?.sprintId === 'sprint-3'
						&& scrum036?.sprintId === 'sprint-3',
					sprint3?.status !== 'active'
							? 'Sprint 3 is not active in the ScrumBoard snapshot.'
							: 'SCRUM-032, SCRUM-035, and SCRUM-036 were not all added to Sprint 3.'
				),
				createCheck(
					'Created the critical Platform risk review follow-up task in progress with the required owner and tags',
					Boolean(riskTask?.task)
						&& riskTask.task.sprintId === 'sprint-3'
						&& riskTask.task.priority === 'critical'
						&& riskTask.task.assigneeId === 'user-4'
						&& riskTask.task.status === 'inprogress'
						&& (riskTask.task.tags || []).includes('tag-2')
						&& (riskTask.task.tags || []).includes('tag-10')
						&& (riskTask.task.tags || []).includes('tag-7'),
					!riskTask?.task
						? 'No new ScrumBoard task titled "Platform risk review follow-up" was found.'
						: `Expected Sprint 3 / critical / David Kim / backend+devops+security / inprogress, got sprint=${riskTask.task.sprintId}, priority=${riskTask.task.priority}, assignee=${riskTask.task.assigneeId}, status=${riskTask.task.status}, tags=${(riskTask.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Added the SSO certificate rotation subtask and linked the new task so it blocks SCRUM-036',
					Boolean(reviewSubtask) && Boolean(riskTask?.task) && taskHasLink(riskTask.task, 'SCRUM-036', 'blocks'),
					!reviewSubtask
						? 'The SSO certificate rotation subtask was not found under the platform risk review task.'
						: 'The platform risk review task is not linked to SCRUM-036 as blocks in the ScrumBoard snapshot.'
				),
				createCheck(
					'Forwarded the Monthly SLA Report to Tom Nguyen with the breached uptime numbers and 81-minute incident',
					Boolean(forwardedEmail),
					!forwardedEmail
						? 'No forward of the Monthly SLA Report to tom.nguyen@contoso.com was found.'
						: 'The Tom Nguyen forward is missing API Gateway 99.91%, Web Application 99.72%, or the 81-minute incident.'
				),
				createCheck(
					'Left other backlog items in their original sprints',
					unexpectedSprintMoves.length === 0,
					`Unexpected sprint changes were detected for: ${unexpectedSprintMoves.join(', ')}.`
				),
			], 'The platform-risk planning bundle was assembled across Sprint 3 and Outlook.');
		},
	},

	'EVAL-21': {
		desc: 'Triage the database and retention evidence before tech-debt prioritization.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;

			const dbEmail = getOutlookEmail(outlook.snapshot, 'email-059');
			const auditEmail = getOutlookEmail(outlook.snapshot, 'email-064');
			const downloadEvent = findEvent(outlook.events, event => event.type === 'attachment_downloaded' && event.emailId === 'email-059' && normalizeText(event.filename) === normalizeText('Slow_Query_Log_Top50.csv'));
			const backendFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'tag' && event.data?.value === 'tag-2');
			const scrum009 = findTask(scrum, 'SCRUM-009');
			const subtask = findSubtask(scrum, 'SCRUM-009', 'Assess orders-table partitioning before Q2 planning');

			return finalizeChecks([
				createCheck(
					'Pinned Daniel Lee\'s performance report',
					Boolean(dbEmail) && dbEmail.pinned === true,
					!dbEmail
						? 'Daniel Lee\'s database performance report was not found in Outlook.'
						: 'Daniel Lee\'s database performance report is not pinned in Outlook.'
				),
				createCheck(
					'Categorized Maya Patel\'s retention-audit email as red and downloaded the slow-query attachment from Daniel\'s report',
					Boolean(auditEmail) && normalizeText(auditEmail.category || '') === 'red' && Boolean(downloadEvent),
					!auditEmail
						? 'Maya Patel\'s retention-audit email was not found in Outlook.'
						: normalizeText(auditEmail.category || '') !== 'red'
							? 'Maya Patel\'s retention-audit email is not categorized as red in Outlook.'
							: 'No attachment_downloaded event was recorded for Slow_Query_Log_Top50.csv from Daniel Lee\'s report.'
				),
				createCheck(
					'Applied the backend filter, raised SCRUM-009 to high priority, and added the orders-table partitioning subtask',
					Boolean(backendFilter) && Boolean(scrum009) && scrum009.priority === 'high' && Boolean(subtask),
					!backendFilter
						? 'No ScrumBoard filter_applied event for the backend tag was found.'
						: !scrum009
							? 'SCRUM-009 was not found in the ScrumBoard snapshot.'
							: scrum009.priority !== 'high'
								? 'SCRUM-009 is not high priority in the ScrumBoard snapshot.'
								: 'The orders-table partitioning subtask was not found under SCRUM-009.'
				),
			], 'The database and retention evidence was triaged across Outlook and ScrumBoard before tech-debt planning.');
		},
	},

	'EVAL-22': {
		desc: 'Route Jordan\'s CI/CD charter note through Teams and ScrumBoard without losing thread state.',
		verify(bundle) {
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;

			const forwarded = findTeamsForwardedMessage(teams, (message, event) =>
				event.originalMessageId === 'msg-1-16'
				&& event.targetConversationId === 'conv-g1'
				&& message.conversationId === 'conv-g1'
			);
			const forwardedText = forwarded ? `${forwarded.event.body} ${forwarded.message.body}` : '';
			const jordanConversation = getTeamsConversation(teams.snapshot, 'conv-1');
			const jordanMarkedUnread = wasConversationMarkedUnread(teams, 'conv-1');
			const devopsFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'tag' && event.data?.value === 'tag-10');
			const subtask = findSubtask(scrum, 'SCRUM-012', 'Review project charter dependencies before guild kickoff');

			return finalizeChecks([
				createCheck(
					'Found Jordan Kim\'s charter note and forwarded the Confluence path to Engineering Leads',
					Boolean(forwarded) && eventMentionsAll(forwardedText, [
						['eng/projects/ci-cd-migration'],
						['before friday'],
						['charter'],
					]),
					!forwarded
						? 'No message_forwarded event was found for Jordan Kim\'s Confluence charter note into Engineering Leads.'
						: 'The forwarded charter note is missing the Eng/Projects/CI-CD-Migration path or the before-Friday review request.'
				),
				createCheck(
					'Marked Jordan\'s conversation unread and muted it',
					Boolean(jordanConversation) && Boolean(jordanMarkedUnread) && jordanConversation.unreadCount > 0 && jordanConversation.isMuted === true,
					!jordanConversation
						? 'Jordan Kim\'s Teams conversation was not found in the snapshot.'
						: !jordanMarkedUnread
							? 'No conversation_marked_unread event was recorded for Jordan Kim\'s Teams conversation.'
						: jordanConversation.unreadCount <= 0
							? 'Jordan Kim\'s Teams conversation is not marked unread in the snapshot.'
							: 'Jordan Kim\'s Teams conversation is not muted in the snapshot.'
				),
				createCheck(
					'Applied the devops filter and added the charter-dependencies subtask under SCRUM-012',
					Boolean(devopsFilter) && Boolean(subtask),
					!devopsFilter
						? 'No ScrumBoard filter_applied event for the devops tag was found.'
						: 'The charter-dependencies subtask was not found under SCRUM-012.'
				),
			], 'Jordan\'s CI/CD charter note was forwarded, the thread state was preserved, and the Scrum follow-up was added.');
		},
	},

	'EVAL-23': {
		desc: 'Keep the two finance threads separate while preserving follow-up state.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;

			const budgetEmail = getGmailEmail(gmail.snapshot, 'email-007');
			const renewalEmail = getGmailEmail(gmail.snapshot, 'email-039');
			const budgetOpened = findEvent(gmail.events, event => event.type === 'email_opened' && event.emailId === 'email-007');
			const renewalOpened = findEvent(gmail.events, event => event.type === 'email_opened' && event.emailId === 'email-039');
			const snoozeEvent = findEvent(gmail.events, event => event.type === 'email_snoozed' && event.emailId === 'email-007');
			const unreadEvent = findEvent(gmail.events, event => event.type === 'email_unread' && event.emailId === 'email-039');
			const teamsMessage = findTeamsMessageByEvent(teams, (message, event) => event.conversationId === 'conv-3' && message.conversationId === 'conv-3');
			const teamsText = teamsMessage ? `${teamsMessage.event.body} ${teamsMessage.message.body}` : '';

			return finalizeChecks([
				createCheck(
					'Opened both the approved budget and contract renewal emails in Gmail',
					Boolean(budgetOpened) && Boolean(renewalOpened),
					!budgetOpened || !renewalOpened
						? 'The Q2 budget approval email and contract renewal email were not both opened in Gmail.'
						: 'Expected both finance threads to be opened in Gmail.'
				),
				createCheck(
					'Snoozed the approved budget thread and marked the contract renewal thread unread',
					Boolean(budgetEmail) && budgetEmail.snoozed === true && Boolean(snoozeEvent) && Boolean(renewalEmail) && renewalEmail.read === false && Boolean(unreadEvent),
					!budgetEmail || !renewalEmail
						? 'The Gmail finance threads were not found in the snapshot.'
						: budgetEmail.snoozed !== true
							? 'The approved budget thread is not snoozed in Gmail.'
							: !snoozeEvent
								? 'No email_snoozed event was recorded for the approved budget thread.'
								: renewalEmail.read !== false
									? 'The contract renewal thread is not unread in Gmail.'
									: 'No email_unread event was recorded for the contract renewal thread.'
				),
				createCheck(
					'Sent Taylor Brooks the budget-approved versus renewal-still-pending summary in Teams',
					Boolean(teamsMessage) && eventMentionsAll(teamsText, [
						['50,000', '50000', '$50,000', '$50k'],
						['15%', '15 percent'],
						['3 year', '3-year', '3 years'],
					]),
					!teamsMessage
						? 'No new Teams message to Taylor Brooks was found.'
						: 'The Teams summary to Taylor Brooks is missing the approved $50,000 budget, 15% increase, or 3-year term.'
				),
			], 'The finance queue was triaged without collapsing the approved budget and renewal follow-ups into one thread.');
		},
	},

	'EVAL-24': {
		desc: 'Update the board calendar trail and broadcast the change.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			const appViewEvent = findEvent(outlook.events, event => event.type === 'app_view_changed' && normalizeText(event.view || '') === 'calendar');
			const calViewEvent = findEvent(outlook.events, event => event.type === 'cal_view_changed' && normalizeText(event.view || '') === 'week');
			const boardMeeting = findCalendarEventById(outlook.snapshot, 'event-021');
			const techDebtMeeting = findCalendarEventById(outlook.snapshot, 'event-049');
			const teamsMessage = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g1'),
				[['roi'], ['launch blocker', 'launch blockers']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Switched Outlook into Calendar week view',
					Boolean(appViewEvent) && Boolean(calViewEvent),
					!appViewEvent
						? 'No Outlook app_view_changed event switching into Calendar was found.'
						: 'No Outlook cal_view_changed event switching to week view was found.'
				),
				createCheck(
					'Updated the Board Meeting notes with the expansion-forecast ROI case and launch blockers',
					Boolean(boardMeeting) && eventMentionsAll(boardMeeting.notes || '', [
						['northstar', '$210k', '210k', '210,000', '210000'],
						['heliobank', '$160k', '160k', '160,000', '160000'],
						['41%', '41 percent', 'webhook'],
						['33%', '33 percent', 'sso', 'saml'],
						['82%', '82 percent', 'localization'],
						['support runbook', 'missing owner'],
						['rollback drill', 'payments rollback'],
					]),
					!boardMeeting
						? 'The Board Meeting event was not found in the Outlook snapshot.'
						: 'The Board Meeting notes are missing the expansion-forecast ROI details or the launch-readiness blockers from the specified source emails.'
				),
				createCheck(
					'Accepted the Tech Debt Prioritization meeting',
					Boolean(techDebtMeeting) && techDebtMeeting.rsvp === 'accepted',
					!techDebtMeeting
						? 'The Tech Debt Prioritization event was not found in the Outlook snapshot.'
						: `Expected Tech Debt Prioritization RSVP to be accepted, got ${techDebtMeeting.rsvp || 'none'}.`
				),
				createCheck(
					'Posted the combined ROI-and-launch-blocker update in Engineering Leads',
					Boolean(teamsMessage),
					!teamsMessage
						? 'No new Engineering Leads message was found for the board packet update.'
						: 'The Engineering Leads message is missing the ROI or launch-blocker update.'
				),
			], 'The board calendar trail was updated in Outlook and summarized to Engineering Leads.');
		},
	},

	'EVAL-25': {
		desc: 'Review Phoenix through existing artifacts instead of creating another ticket.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const scrum = bundle.scrumboard;

			const phoenixEmail = getEmailBySubject(gmail.snapshot, 'Project Phoenix - Weekly Status Update');
			const openEvent = findEvent(gmail.events, event => event.type === 'email_opened' && event.emailId === phoenixEmail?.id);
			const frontendFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'tag' && event.data?.value === 'tag-1');
			const storyFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'type' && normalizeText(event.data?.value || '') === 'story');
			const scrum008 = findTask(scrum, 'SCRUM-008');
			const statusEvent = findEvent(scrum.events, event => (
				event.type === 'card_moved' && event.data?.taskId === 'SCRUM-008' && event.data?.toStatus === 'inreview'
			) || (
				event.type === 'card_edited' && event.data?.taskId === 'SCRUM-008' && event.data?.changes?.status?.to === 'inreview'
			));
			const subtask = findSubtask(scrum, 'SCRUM-008', 'Confirm UX mockup handoff before sign-off');
			const subtaskEvent = findEvent(scrum.events, event => event.type === 'subtask_created' && event.data?.parentId === 'SCRUM-008' && normalizeText(event.data?.title) === normalizeText('Confirm UX mockup handoff before sign-off'));

			return finalizeChecks([
				createCheck(
					'Opened the Project Phoenix weekly status update in Gmail',
					Boolean(phoenixEmail) && Boolean(openEvent),
					!phoenixEmail
						? 'The Project Phoenix weekly status update was not found in Gmail.'
						: 'No email_opened event was recorded for the Project Phoenix weekly status update.'
				),
				createCheck(
					'Applied the frontend and story filters, moved SCRUM-008 to In Review, and added the UX-handoff subtask',
					Boolean(frontendFilter) && Boolean(storyFilter) && Boolean(scrum008) && scrum008.status === 'inreview' && Boolean(statusEvent) && Boolean(subtask),
					!frontendFilter || !storyFilter
						? 'One or both required ScrumBoard filter_applied events for frontend and story were missing.'
						: !scrum008
							? 'SCRUM-008 was not found in the ScrumBoard snapshot.'
							: scrum008.status !== 'inreview'
								? 'SCRUM-008 is not in review in the ScrumBoard snapshot.'
								: !statusEvent
									? 'No card_moved or card_edited event moved SCRUM-008 to In Review.'
									: !subtask || !subtaskEvent
										? 'The UX-handoff subtask was not created under SCRUM-008 with a matching subtask_created event.'
										: 'Expected the Phoenix review changes to be reflected in ScrumBoard.'
				),
			], 'The Phoenix follow-up was handled via existing Gmail and ScrumBoard artifacts instead of a net-new ticket.');
		},
	},

	'EVAL-26': {
		desc: 'Triage mixed Outlook and Gmail queues without losing the right follow-ups.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const gmail = bundle.gmail;

			const abEmail = getOutlookEmail(outlook.snapshot, 'email-054');
			const pinEvent = findEvent(outlook.events, event => event.type === 'email_pinned' && event.emailId === 'email-054' && event.pinned === true);
			const downloadEvent = findEvent(outlook.events, event => event.type === 'attachment_downloaded' && event.emailId === 'email-054' && normalizeText(event.filename) === normalizeText('CKO42_AB_Test_Full_Report.pdf'));
			const updatesTab = findEvent(gmail.events, event => event.type === 'tab_switched' && normalizeText(event.category || '') === 'updates');
			const indieEmail = getGmailEmail(gmail.snapshot, 'email-016');
			const indieOpen = findEvent(gmail.events, event => event.type === 'email_opened' && event.emailId === 'email-016');
			const indieSnooze = findEvent(gmail.events, event => event.type === 'email_snoozed' && event.emailId === 'email-016');

			return finalizeChecks([
				createCheck(
					'Pinned the A/B test email in Outlook and downloaded the CKO-42 report attachment',
					Boolean(abEmail) && abEmail.pinned === true && Boolean(pinEvent) && Boolean(downloadEvent),
					!abEmail
						? 'The A/B Test Results email was not found in Outlook.'
						: abEmail.pinned !== true
							? 'The A/B Test Results email is not pinned in Outlook.'
							: !pinEvent || !downloadEvent
								? 'The A/B Test Results email is missing the required pin or attachment-download event.'
								: 'Expected the Outlook review queue to be triaged.'
				),
				createCheck(
					'Switched Gmail to Updates, opened the IndieDev confirmation, and snoozed it until tomorrow morning',
					Boolean(updatesTab) && Boolean(indieEmail) && Boolean(indieOpen) && indieEmail.snoozed === true && Boolean(indieSnooze),
					!updatesTab
						? 'No Gmail tab_switched event for Updates was found.'
						: !indieEmail
							? 'The IndieDev Conference confirmation was not found in Gmail.'
							: !indieOpen
								? 'No email_opened event was recorded for the IndieDev Conference confirmation.'
								: indieEmail.snoozed !== true || !indieSnooze
									? 'The IndieDev Conference confirmation was not snoozed with a matching email_snoozed event.'
									: 'Expected the Gmail updates queue to be triaged.'
				),
			], 'The mixed Outlook and Gmail reading queues were cleaned up without losing the important follow-up items.');
		},
	},

	'EVAL-27': {
		desc: 'Surface Sam\'s hybrid recommendation without losing your place in the Teams thread.',
		verify(bundle) {
			const teams = bundle.teams;
			const outlook = bundle.outlook;

			const forwarded = findTeamsForwardedMessage(teams, (message, event) =>
				event.originalMessageId === 'msg-8-15'
				&& event.targetConversationId === 'conv-g1'
				&& message.conversationId === 'conv-g1'
			);
			const forwardedText = forwarded ? `${forwarded.event.body} ${forwarded.message.body}` : '';
			const samConversation = getTeamsConversation(teams.snapshot, 'conv-8');
			const samMarkedUnread = wasConversationMarkedUnread(teams, 'conv-8');
			const lindaReply = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email => email.replyToId === 'email-065' && emailHasRecipient(email, 'linda.chen@contoso.com')),
				[['186,000', '186000', '186k'], ['hybrid'], ['vp sla review', 'sla review']],
				email => `${email.subject || ''} ${email.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Found Sam Lee\'s hybrid message and forwarded the ~$90k recommendation to Engineering Leads',
					Boolean(forwarded) && eventMentionsAll(forwardedText, [
						['90k', '$90k', '90,000', '90000'],
						['decision this week', 'decision by end of this week'],
						['hybrid'],
					]),
					!forwarded
						? 'No message_forwarded event was found for Sam Lee\'s ~$90k hybrid recommendation into Engineering Leads.'
						: 'The forwarded hybrid recommendation is missing the ~$90k figure or the decision-this-week note.'
				),
				createCheck(
					'Marked Sam Lee\'s conversation unread after forwarding the message',
					Boolean(samConversation) && Boolean(samMarkedUnread) && samConversation.unreadCount > 0,
					!samConversation
						? 'Sam Lee\'s Teams conversation was not found in the snapshot.'
						: !samMarkedUnread
							? 'No conversation_marked_unread event was recorded for Sam Lee\'s Teams conversation.'
							: 'Sam Lee\'s Teams conversation is not marked unread in the snapshot.'
				),
				createCheck(
					'Replied to Linda Chen comparing Datadog at $186,000 against the hybrid option before the VP SLA review',
					Boolean(lindaReply),
					!lindaReply
						? 'No reply to Linda Chen\'s vendor-renewal email was found.'
						: 'The reply to Linda Chen is missing the $186,000 Datadog comparison, hybrid option, or VP SLA review reference.'
				),
			], 'Sam\'s hybrid recommendation was surfaced in Teams and tied back into the Outlook renewal thread.');
		},
	},

	'EVAL-28': {
		desc: 'Handle Priya\'s auth follow-up as a draft-and-send recovery flow.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;

			const draftEvent = findEvent(outlook.events, event => event.type === 'draft_saved');
			const priyaReply = findOutlookEmailByEvent(outlook, (email, event) =>
				event.replyToId === 'email-063'
				&& event.mode === 'reply'
				&& eventHasRecipient(event, 'priya.sharma@contoso.com')
				&& emailHasRecipient(email, 'priya.sharma@contoso.com')
			);
			const priyaText = priyaReply ? `${priyaReply.email.subject} ${priyaReply.email.body}` : '';
			const securityFilter = findEvent(scrum.events, event => event.type === 'filter_applied' && event.data?.filterType === 'tag' && event.data?.value === 'tag-7');
			const subtask = findSubtask(scrum, 'SCRUM-001', 'Schedule blast-radius review after key rotation');
			const subtaskEvent = findEvent(scrum.events, event => event.type === 'subtask_created' && event.data?.parentId === 'SCRUM-001' && normalizeText(event.data?.title) === normalizeText('Schedule blast-radius review after key rotation'));

			return finalizeChecks([
				createCheck(
					'Saved an Outlook draft reply before sending the final auth-incident follow-up to Priya',
					Boolean(draftEvent) && Boolean(priyaReply) && eventMentionsAll(priyaText, [
						['27 minute', '27-minute', '27 minutes'],
						['blast radius', 'tenant by tenant', 'tenant-by-tenant'],
					]),
					!draftEvent
						? 'No Outlook draft_saved event was recorded before the auth-incident reply.'
						: !priyaReply
							? 'No final reply to Priya\'s auth incident recap was found.'
							: 'The reply to Priya is missing the 27-minute exposure or tenant-by-tenant blast-radius review.'
				),
				createCheck(
					'Applied the security filter and added the blast-radius-review subtask under SCRUM-001',
					Boolean(securityFilter) && Boolean(subtask),
					!securityFilter
						? 'No ScrumBoard filter_applied event for the security tag was found.'
						: !subtask || !subtaskEvent
							? 'The blast-radius-review subtask was not created under SCRUM-001 with a matching subtask_created event.'
							: 'Expected the auth follow-up to be reflected in ScrumBoard.'
				),
			], 'The auth follow-up was handled as a real draft-and-send recovery flow and turned into a concrete Scrum subtask.');
		},
	},

	'EVAL-29': {
		desc: 'Save and resume the conference-deck reply before nudging leadership in Teams.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;

			const draftEvent = findEvent(gmail.events, event => event.type === 'draft_saved');
			const slidesReply = findGmailEmailByEvent(gmail, (email, event) =>
				event.replyToId === 'email-050'
				&& event.mode === 'reply'
				&& event.to?.includes('marcus.thompson@devteam.io')
				&& emailHasRecipient(email, 'marcus.thompson@devteam.io')
			);
			const slidesText = slidesReply ? `${slidesReply.email.subject} ${slidesReply.email.body}` : '';
			const forwarded = findTeamsForwardedMessage(teams, (message, event) =>
				event.originalMessageId === 'msg-1-18'
				&& event.targetConversationId === 'conv-3'
				&& message.conversationId === 'conv-3'
			);
			const forwardedText = forwarded ? `${forwarded.event.body} ${forwarded.message.body}` : '';

			return finalizeChecks([
				createCheck(
					'Saved a Gmail draft reply before sending the final conference-slides response to Marcus Thompson',
					Boolean(draftEvent) && Boolean(slidesReply) && eventMentionsAll(slidesText, [
						['microservices migration story', 'migration story'],
						['lessons learned'],
					]),
					!draftEvent
						? 'No Gmail draft_saved event was recorded before replying to Marcus Thompson\'s conference slides email.'
						: !slidesReply
							? 'No final Gmail reply to Marcus Thompson\'s conference slides email was found.'
							: 'The final reply to Marcus Thompson is missing the migration-story or lessons-learned guidance.'
				),
				createCheck(
					'Found Jordan Kim\'s Jenkins renewal message in Teams and forwarded it to Taylor Brooks',
					Boolean(forwarded) && eventMentionsAll(forwardedText, [
						['48k', '$48k', '48,000', '48000'],
						['jenkins'],
						['renewal'],
					]),
					!forwarded
						? 'No message_forwarded event was found forwarding the $48k/year Jenkins renewal note to Taylor Brooks.'
						: 'The forwarded Jenkins renewal note is missing the $48k/year amount or the Jenkins renewal context.'
				),
			], 'The conference-deck reply was saved and resumed correctly, and the Jenkins renewal note was escalated in Teams.');
		},
	},

	'EVAL-30': {
		desc: 'Reduce the active queue while preserving the one conference thread that still matters.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;

			const primaryTab = findEvent(gmail.events, event => event.type === 'tab_switched' && normalizeText(event.category || '') === 'primary');
			const markAllEvent = findEvent(gmail.events, event => event.type === 'mark_all_read' && normalizeText(event.folder || '') === 'inbox' && normalizeText(event.category || '') === 'primary');
			const primaryUnread = (gmail.snapshot?.emails || []).filter(email => email.folder === 'inbox' && email.category === 'primary' && email.read !== true);
			const slidesOpen = findEvent(gmail.events, event => event.type === 'email_opened' && event.emailId === 'email-050');
			const teamsMessage = findTeamsMessageByEvent(teams, (message, event) => event.conversationId === 'conv-1' && message.conversationId === 'conv-1');
			const teamsText = teamsMessage ? `${teamsMessage.event.body} ${teamsMessage.message.body}` : '';

			return finalizeChecks([
				createCheck(
					'Switched to Gmail Primary and marked all Primary inbox mail as read',
					Boolean(primaryTab) && Boolean(markAllEvent) && primaryUnread.length === 0,
					!primaryTab
						? 'No Gmail tab_switched event for the Primary tab was found.'
						: !markAllEvent
							? 'No Gmail mark_all_read event was recorded for the Primary inbox.'
							: `Some Primary inbox emails are still unread in Gmail: ${primaryUnread.map(email => email.id).join(', ')}.`
				),
				createCheck(
					'Found and reopened Marcus Thompson\'s conference slides email',
					Boolean(slidesOpen),
					'No email_opened event was recorded for Marcus Thompson\'s conference slides thread.'
				),
				createCheck(
					'Sent Jordan Kim the migration-story reminder in Teams',
					Boolean(teamsMessage) && eventMentionsAll(teamsText, [
						['migration story', 'migration-story'],
						['before submission', 'before we submit', 'before submit'],
					]),
					!teamsMessage
						? 'No new Teams message to Jordan Kim was found.'
						: 'The Teams reminder to Jordan Kim is missing the migration-story or before-submission wording.'
				),
			], 'The active Gmail queue was reduced while the conference slides thread stayed surfaced for follow-up.');
		},
	},

	'EVAL-31': {
		desc: 'Compose a Gmail status email to Priya and raise the payment test priority in ScrumBoard.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const scrum = bundle.scrumboard;

			const emailCandidate = findGmailEmailByEvent(gmail, (email, event) =>
				event.mode === 'new'
				&& event.to?.includes('priya.sharma@devteam.io')
				&& emailHasRecipient(email, 'priya.sharma@devteam.io')
			);
			const emailText = emailCandidate ? `${emailCandidate.email.subject} ${emailCandidate.email.body}` : '';

			const assigneeFilter = findEvent(scrum.events, event =>
				event.type === 'filter_applied' && event.data?.filterType === 'assignee' && event.data?.value === 'user-5'
			);

			const task005 = findTask(scrum, 'SCRUM-005');

			return finalizeChecks([
				createCheck(
					'Composed a new Gmail email to Priya about the payment PR test status',
					Boolean(emailCandidate) && normalizeText(emailText).includes('payment') && eventMentionsAll(emailText, [
						['hold', 'wait', 'block'],
						['test', 'unit test', 'verification'],
					]),
					!emailCandidate
						? 'No new email to priya.sharma@devteam.io was found in Gmail.'
						: 'The email to Priya is missing the payment test status or hold-the-merge guidance.'
				),
				createCheck(
					'Filtered ScrumBoard by assignee Emma Johnson',
					Boolean(assigneeFilter),
					'No filter_applied event for assignee Emma Johnson (user-5) was found in ScrumBoard.'
				),
				createCheck(
					'Raised SCRUM-005 to Critical priority',
					Boolean(task005) && task005.priority === 'critical',
					!task005
						? 'SCRUM-005 was not found in the ScrumBoard snapshot.'
						: `Expected SCRUM-005 priority critical, got ${task005.priority}.`
				),
			], 'Priya got the test-status email and SCRUM-005 was escalated to critical after filtering by Emma Johnson.');
		},
	},

	'EVAL-32': {
		desc: 'Flag the escalation report, archive the lunch RSVP, and react to Morgan in Teams.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			const escalationEmail = getOutlookEmail(outlook.snapshot, 'email-060');
			const lunchEmail = getOutlookEmail(outlook.snapshot, 'email-007');
			const morganOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-2'));
			const morganUser = (teams.db?.users || []).find(user => normalizeText(user.name) === 'morgan chen') || null;
			const lastMorganMessage = (teams.snapshot?.messages || [])
				.filter(message => message.conversationId === 'conv-2' && message.senderId === morganUser?.id)
				.reduce((latest, current) => {
					if (!latest) return current;
					return new Date(current.timestamp).getTime() > new Date(latest.timestamp).getTime() ? current : latest;
				}, null);
			const reactionEvent = findEvent(teams.events, event =>
				event.type === 'reaction_toggled' && event.emoji === '👍' && event.messageId === lastMorganMessage?.id
			);
			const lastMorganReactionUsers = teams.snapshot?.reactions?.[lastMorganMessage?.id]?.['👍'] || [];

			return finalizeChecks([
				createCheck(
					'Opened Morgan Chen\'s conversation in Teams',
					morganOpened,
					'Morgan Chen\'s Teams conversation was not opened.'
				),
				createCheck(
					'Flagged the customer escalation trends report in Outlook',
					Boolean(escalationEmail) && escalationEmail.flagged === true,
					!escalationEmail
						? 'The customer escalation trends email (email-060) was not found in Outlook.'
						: 'The customer escalation trends email is not flagged.'
				),
				createCheck(
					'Archived the team lunch RSVP from Rachel Green',
					Boolean(lunchEmail) && lunchEmail.folder === 'archive',
					!lunchEmail
						? 'The team lunch RSVP email (email-007) was not found in Outlook.'
						: `Expected folder archive, got ${lunchEmail.folder}.`
				),
				createCheck(
					'Reacted to Morgan Chen\'s last message with 👍 in Teams',
					Boolean(lastMorganMessage) && Boolean(reactionEvent) && lastMorganReactionUsers.includes(teams.snapshot?.currentUserId || 'user-me'),
					!lastMorganMessage
						? 'Morgan Chen\'s latest message was not found in the Teams snapshot.'
						: !reactionEvent
							? 'No reaction_toggled event with 👍 was found for Morgan Chen\'s last message.'
							: 'The final Teams state is missing the current user\'s 👍 reaction on Morgan Chen\'s last message.'
				),
			], 'Inbox was triaged and Morgan\'s update was acknowledged with a reaction.');
		},
	},

	'EVAL-33': {
		desc: 'Trash Gmail Social tab, switch ScrumBoard theme, filter by priority, and change issue type.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const scrum = bundle.scrumboard;

			const socialEmails = (gmail.snapshot?.emails || []).filter(email => email.category === 'social');
			const allTrashed = socialEmails.length > 0 && socialEmails.every(email => email.folder === 'trash');

			const themeEvent = findEvent(scrum.events, event =>
				event.type === 'theme_changed' && event.theme === 'dark'
			);
			const priorityFilter = findEvent(scrum.events, event =>
				event.type === 'filter_applied' && event.data?.filterType === 'priority' && normalizeText(event.data?.value || '') === 'critical'
			);
			const task003 = findTask(scrum, 'SCRUM-003');

			return finalizeChecks([
				createCheck(
					'Trashed all Gmail Social tab emails',
					allTrashed,
					socialEmails.length === 0
						? 'No Social tab emails were found in Gmail.'
						: `Not all Social emails are trashed: ${socialEmails.filter(e => e.folder !== 'trash').map(e => e.id).join(', ')}.`
				),
				createCheck(
					'Switched to Midnight Dark theme in ScrumBoard',
					Boolean(themeEvent),
					'No theme_changed event to dark was found in ScrumBoard.'
				),
				createCheck(
					'Filtered by Critical priority in ScrumBoard',
					Boolean(priorityFilter),
					'No filter_applied event for Critical priority was found in ScrumBoard.'
				),
				createCheck(
					'Changed SCRUM-003 issue type to Bug',
					Boolean(task003) && task003.type === 'bug',
					!task003
						? 'SCRUM-003 was not found in the ScrumBoard snapshot.'
						: `Expected SCRUM-003 type bug, got ${task003.type}.`
				),
			], 'Social noise was cleared, board theme updated, and SCRUM-003 was reclassified as a bug.');
		},
	},

	'EVAL-34': {
		desc: 'Search Teams for GDPR context, then trash stale Outlook mail and clean Junk.',
		verify(bundle) {
			const teams = bundle.teams;
			const outlook = bundle.outlook;

			const searchEvent = findEvent(teams.events, event =>
				event.type === 'search_performed' && normalizeText(event.query || '').includes('gdpr')
			);
			const openEvent = findEvent(teams.events, event =>
				event.type === 'conversation_opened' && event.conversationId === 'conv-5'
			);
			const lunchEmail = getOutlookEmail(outlook.snapshot, 'email-007');
			const junkEmails = (outlook.snapshot?.emails || []).filter(email => email.folder === 'junk');
			const snapshotEmailIds = new Set((outlook.snapshot?.emails || []).map(email => email.id));
			const missingNonJunkIds = (outlook.db?.emails || [])
				.filter(email => email.folder !== 'junk' && email.id !== 'email-007')
				.map(email => email.id)
				.filter(emailId => !snapshotEmailIds.has(emailId));

			return finalizeChecks([
				createCheck(
					'Searched for GDPR in Teams',
					Boolean(searchEvent),
					'No search_performed event with query containing "GDPR" was found in Teams.'
				),
				createCheck(
					'Opened Riley Patel\'s conversation in Teams',
					Boolean(openEvent),
					'Riley Patel\'s Teams conversation was not opened.'
				),
				createCheck(
					'Trashed the team lunch RSVP in Outlook',
					Boolean(lunchEmail) && (lunchEmail.folder === 'deleted' || lunchEmail.folder === 'trash'),
					!lunchEmail
						? 'The team lunch RSVP (email-007) was not found.'
						: `Expected folder deleted/trash, got ${lunchEmail.folder}.`
				),
				createCheck(
					'Permanently deleted everything in Junk Email',
					junkEmails.length === 0,
					`${junkEmails.length} email(s) still remain in the Junk folder: ${junkEmails.map(e => e.id).join(', ')}.`
				),
				createCheck(
					'Left non-Junk Outlook mail intact aside from the targeted lunch RSVP',
					missingNonJunkIds.length === 0,
					`Non-Junk email(s) were removed unexpectedly: ${missingNonJunkIds.join(', ')}.`
				),
			], 'GDPR context was retrieved from Teams and stale Outlook mail was cleaned up.');
		},
	},

	'EVAL-35': {
		desc: 'Update test scope, unlink migration, create Sprint 4, and send a rich-text email.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;

			const task005 = findTask(scrum, 'SCRUM-005');
			const seedTask005 = (scrum.db?.tasks || []).find(task => task.id === 'SCRUM-005') || null;
			const descUpdated = Boolean(task005) && normalizeText(task005.description || '').includes('checkout');
			const linkRemoved = Boolean(task005) && !(task005.linkedIssues || []).some(link => link.targetId === 'SCRUM-006');
			const sprint4 = (scrum.snapshot?.sprints || []).find(sprint => normalizeText(sprint.name) === 'sprint 4') || null;

			const emailCandidate = findNewOutlookEmails(outlook, email =>
				emailHasRecipient(email, 'emma.johnson@contoso.com') && normalizeText(email.subject || '').includes('updated test plan')
			).find(email => /<(b|strong)[^>]*>[^<]*checkout[^<]*endpoint[^<]*<\/(b|strong)>/i.test(email.body || '')) || null;
			const emailBody = emailCandidate ? stripHtml(emailCandidate.body || '') : '';
			const emailRawBody = emailCandidate ? (emailCandidate.body || '') : '';
			const hasBold = /<(b|strong)[^>]*>[^<]*checkout[^<]*endpoint[^<]*<\/(b|strong)>/i.test(emailRawBody);

			return finalizeChecks([
				createCheck(
					'Updated SCRUM-005 description to mention the checkout endpoint',
					descUpdated,
					!task005
						? 'SCRUM-005 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-005 description does not mention checkout.'
				),
				createCheck(
					'Removed the relates-to link between SCRUM-005 and SCRUM-006',
					linkRemoved,
					'SCRUM-005 still has a link to SCRUM-006.'
				),
				createCheck(
					'Created Sprint 4 with goal mentioning bug fixes and polish',
					Boolean(sprint4) && eventMentionsAll(sprint4.goal || '', [
						['bug fix', 'bug fixes'],
						['polish'],
					]),
					!sprint4
						? 'Sprint 4 was not found in the ScrumBoard snapshot.'
						: 'Sprint 4 does not have a goal mentioning bug fixes and polish.'
				),
				createCheck(
					'Kept SCRUM-005 in its original sprint while changing only scope and linkage',
					Boolean(task005) && task005.sprintId === seedTask005?.sprintId,
					!task005
						? 'SCRUM-005 was not found in the ScrumBoard snapshot.'
						: `Expected SCRUM-005 to stay in sprint ${seedTask005?.sprintId}, got ${task005.sprintId}.`
				),
				createCheck(
					'Emailed Emma Johnson with subject "Updated Test Plan" and bold checkout-endpoint text',
					Boolean(emailCandidate) && normalizeText(emailCandidate.subject || '').includes('updated test plan') && normalizeText(emailBody).includes('checkout') && hasBold,
					!emailCandidate
						? 'No email sent to emma.johnson@contoso.com was found in Outlook.'
						: !normalizeText(emailCandidate.subject || '').includes('updated test plan')
							? `Expected subject containing "Updated Test Plan", got "${emailCandidate.subject}".`
							: !normalizeText(emailBody).includes('checkout')
							? 'The email body does not mention checkout.'
							: 'The email body does not have checkout endpoint in bold formatting.'
				),
			], 'Test scope was updated, migration unlinked, Sprint 4 created, and Emma got a rich-text heads-up.');
		},
	},

	'EVAL-36': {
		desc: 'Search Gmail for Phoenix, forward Teams vendor note to DM, and add backlog to Sprint 3.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;

			const searchEvent = findEvent(gmail.events, event =>
				event.type === 'search_performed' && normalizeText(event.query || '').includes('phoenix')
			);
			const phoenixOpened = findEvent(gmail.events, event =>
				event.type === 'email_opened' && event.emailId === 'email-005'
			);

			const forwarded = findTeamsForwardedMessage(teams, (message, event) =>
				event.targetConversationId === 'conv-3' && message.conversationId === 'conv-3'
			);
			const fwdText = forwarded ? `${forwarded.event.body} ${forwarded.message.body}` : '';

			const task033 = findTask(scrum, 'SCRUM-033');
			const task037 = findTask(scrum, 'SCRUM-037');

			return finalizeChecks([
				createCheck(
					'Searched Gmail for Project Phoenix and opened the status update',
					Boolean(searchEvent) && Boolean(phoenixOpened),
					!searchEvent
						? 'No Gmail search for Phoenix was found.'
						: 'The Project Phoenix status update email was not opened.'
				),
				createCheck(
					'Forwarded Sam Lee\'s observability message to Taylor Brooks in Teams',
					Boolean(forwarded) && eventMentionsAll(fwdText, [
						['hybrid', 'observability', 'vendor', 'cost'],
					]),
					!forwarded
						? 'No forwarded message to Taylor Brooks (conv-3) was found in Teams.'
						: 'The forwarded message does not reference the observability vendor comparison.'
				),
				createCheck(
					'Added SCRUM-033 and SCRUM-037 to Sprint 3',
					Boolean(task033) && task033.sprintId === 'sprint-3' && Boolean(task037) && task037.sprintId === 'sprint-3',
					(!task033 || !task037)
						? 'SCRUM-033 or SCRUM-037 was not found in the ScrumBoard snapshot.'
						: `Expected both in sprint-3. SCRUM-033 sprint=${task033.sprintId}, SCRUM-037 sprint=${task037.sprintId}.`
				),
			], 'Phoenix context was surfaced, vendor note was forwarded to Taylor, and backlog items were scheduled.');
		},
	},

	'EVAL-37': {
		desc: 'All-four-site cleanup: archive Outlook externals, compose Gmail, Teams search + post, ScrumBoard priority filter + description.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const gmail = bundle.gmail;
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;

			const externalIds = ['email-011', 'email-012', 'email-013', 'email-015', 'email-017', 'email-016'];
			const externalEmails = externalIds.map(id => getOutlookEmail(outlook.snapshot, id)).filter(Boolean);
			const allArchived = externalEmails.length === externalIds.length && externalEmails.every(email => email.folder === 'archive');

			const gmailEmail = findGmailEmailByEvent(gmail, (email, event) =>
				event.mode === 'new'
				&& event.to?.some(r => normalizeText(r).includes('robert.chen@devteam.io'))
			);
			const gmailText = gmailEmail ? `${gmailEmail.email.subject} ${gmailEmail.email.body}` : '';

			const searchEvent = findEvent(teams.events, event =>
				event.type === 'search_performed' && normalizeText(event.query || '').includes('ci/cd')
			);
			const sprintPlanMsg = findTeamsMessageByEvent(teams, (message, event) =>
				event.conversationId === 'conv-g2' && message.conversationId === 'conv-g2'
			);
			const sprintPlanText = sprintPlanMsg ? `${sprintPlanMsg.event.body} ${sprintPlanMsg.message.body}` : '';

			const priorityFilter = findEvent(scrum.events, event =>
				event.type === 'filter_applied' && event.data?.filterType === 'priority' && normalizeText(event.data?.value || '') === 'critical'
			);
			const task014 = findTask(scrum, 'SCRUM-014');
			const descHasSignoff = Boolean(task014) && normalizeText(task014.description || '').includes('security sign-off');

			return finalizeChecks([
				createCheck(
					'Archived all external newsletter and notification emails in Outlook',
					allArchived,
					`Not all external emails are archived. Status: ${externalEmails.map(e => `${e.id}=${e.folder}`).join(', ')}.`
				),
				createCheck(
					'Composed a new Gmail email about the architecture review with microservices and Kubernetes',
					Boolean(gmailEmail) && eventMentionsAll(gmailText, [
						['microservices'],
						['kubernetes'],
					]),
					!gmailEmail
						? 'No new Gmail email about the architecture review was found.'
						: 'The architecture follow-up email is missing microservices or Kubernetes.'
				),
				createCheck(
					'Searched Teams for CI/CD and posted in Product Sprint Planning',
					Boolean(searchEvent) && Boolean(sprintPlanMsg) && eventMentionsAll(sprintPlanText, [
						['ci/cd', 'migration', 'charter'],
					]),
					!searchEvent
						? 'No Teams search for CI/CD was found.'
						: !sprintPlanMsg
							? 'No message was posted in Product Sprint Planning.'
							: 'The Product Sprint Planning message does not reference the CI/CD migration charter.'
				),
				createCheck(
					'Filtered ScrumBoard by Critical priority and updated SCRUM-014 description',
					Boolean(priorityFilter) && descHasSignoff,
					!priorityFilter
						? 'No filter_applied event for Critical priority was found in ScrumBoard.'
						: !descHasSignoff
							? 'SCRUM-014 description does not contain "security sign-off".'
							: 'SCRUM-014 was not found.'
				),
			], 'Cross-functional cleanup completed across all four sites.');
		},
	},

	'EVAL-38': {
		desc: 'Read Taylor\'s ROI model in Teams, summarize to Engineering Leads, and update ScrumBoard description.',
		verify(bundle) {
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;
			const taylorOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-3'));
			const currentUserId = teams.snapshot?.currentUserId || 'user-me';
			const engLeadsMessages = findNewTeamsMessages(teams, message =>
				message.conversationId === 'conv-g1' && message.senderId === currentUserId
			);
			const engLeadsSummaryText = engLeadsMessages
				.map(message => `${message.bodyText || ''} ${message.body || ''}`.trim())
				.filter(Boolean)
				.join(' ');

			const engLeadsSummaryPosted = engLeadsMessages.length > 0;
			const engLeadsSummaryComplete = engLeadsSummaryPosted && eventMentionsAll(engLeadsSummaryText, [
				['3 fte', '3 engineers', 'three fte'],
				['900k', '$900k', '900,000', '900000', 'annual cost'],
				['18 month', '18-month', '18 months'],
			]);

			const task007 = findTask(scrum, 'SCRUM-007');
			const descUpdated = Boolean(task007) && textContainsAny(task007.description || '', ['roi', 'platform investment', 'headcount']);

			return finalizeChecks([
				createCheck(
					'Opened Taylor Brooks\'s Teams conversation',
					taylorOpened,
					'Taylor Brooks\'s Teams conversation was not opened.'
				),
				createCheck(
					'Posted Taylor\'s ROI summary in Engineering Leads with headcount, cost, and break-even',
					engLeadsSummaryComplete,
					!engLeadsSummaryPosted
						? 'No new message was posted in Engineering Leads.'
						: 'The Engineering Leads message is missing the 3 FTE request, roughly $900k annual cost, or the 18-month break-even timeline.'
				),
				createCheck(
					'Updated SCRUM-007 description to reference the ROI model',
					descUpdated,
					!task007
						? 'SCRUM-007 was not found in the ScrumBoard snapshot.'
						: 'SCRUM-007 description does not reference ROI, platform investment, or headcount.'
				),
				createCheck(
					'Reassigned SCRUM-007 to Bob Martinez',
					Boolean(task007) && task007.assigneeId === 'user-2',
					!task007
						? 'SCRUM-007 was not found.'
						: `Expected assignee user-2 (Bob Martinez), got ${task007.assigneeId}.`
				),
			], 'Taylor\'s ROI model was read, summarized for leadership, and connected to sprint work.');
		},
	},

	'EVAL-39': {
		desc: 'Reply to vendor proposal with Cc, flag renewal, and triage Gmail.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const gmail = bundle.gmail;

			const replyCandidate = findOutlookEmailByEvent(outlook, (email, event) =>
				event.mode === 'reply'
				&& event.replyToId === 'email-023'
				&& emailHasRecipient(email, 'tom.bradley@cloudvendor.com')
			);
			const replyText = replyCandidate ? `${replyCandidate.email.subject} ${replyCandidate.email.body}` : '';
			const replyCc = replyCandidate?.event?.cc || replyCandidate?.email?.cc || [];
			const hasCc = Array.isArray(replyCc) && replyCc.some(c => {
				const addr = typeof c === 'string' ? c : (c.email || '');
				return addr.toLowerCase() === 'linda.chen@contoso.com';
			});

			const renewalEmail = getOutlookEmail(outlook.snapshot, 'email-065');

			const gmailContract = getGmailEmail(gmail.snapshot, 'email-039');
			const gmailFreelance = getGmailEmail(gmail.snapshot, 'email-027');

			return finalizeChecks([
				createCheck(
					'Replied to Tom Bradley\'s vendor proposal with capacity and SLA details, Cc\'d Linda Chen',
					Boolean(replyCandidate) && hasCc && eventMentionsAll(replyText, [
						['capacity', 'storage', 'tb', 'terabyte'],
						['uptime', 'sla', '99.9'],
					]),
					!replyCandidate
						? 'No reply to Tom Bradley\'s vendor proposal (email-023) was found.'
						: !hasCc
							? 'Linda Chen was not Cc\'d on the reply.'
							: 'The reply is missing the capacity offering or uptime SLA from the vendor proposal.'
				),
				createCheck(
					'Flagged Linda Chen\'s vendor renewal summary in Outlook',
					Boolean(renewalEmail) && renewalEmail.flagged === true,
					!renewalEmail
						? 'Linda Chen\'s vendor renewal email (email-065) was not found.'
						: 'The vendor renewal email is not flagged.'
				),
				createCheck(
					'Starred the contract renewal and marked the freelance inquiry as read in Gmail',
					Boolean(gmailContract) && gmailContract.starred === true
						&& Boolean(gmailFreelance) && gmailFreelance.read === true,
					(!gmailContract || !gmailFreelance)
						? 'The contract renewal or freelance inquiry email was not found in Gmail.'
						: !gmailContract?.starred
							? 'The contract renewal email is not starred in Gmail.'
							: 'Chris Nguyen\'s freelance inquiry is not marked as read.'
				),
			], 'Vendor proposal was answered with context, renewal flagged, and Gmail queue was tidied.');
		},
	},

	'EVAL-40': {
		desc: 'Search Gmail for Phoenix, forward status, then search ScrumBoard and add subtask.',
		verify(bundle) {
			const gmail = bundle.gmail;
			const scrum = bundle.scrumboard;

			const searchEvent = findEvent(gmail.events, event =>
				event.type === 'search_performed' && normalizeText(event.query || '').includes('phoenix')
			);
			const forwardedGmail = findGmailEmailByEvent(gmail, (email, event) =>
				event.mode === 'forward'
				&& event.replyToId === 'email-005'
				&& event.to?.includes('tom.bradley@startup.vc')
				&& emailHasRecipient(email, 'tom.bradley@startup.vc')
			);
			const fwdText = forwardedGmail ? `${forwardedGmail.email.subject} ${forwardedGmail.email.body}` : '';

			const scrumSearch = findEvent(scrum.events, event =>
				event.type === 'filter_applied' && event.data?.filterType === 'search' && normalizeText(event.data?.value || '').includes('authentication')
			);
			const task001 = findTask(scrum, 'SCRUM-001');
			const typeChanged = Boolean(task001) && task001.type === 'story';
			const subtask = (scrum.snapshot?.tasks || []).find(t =>
				t.parentId === 'SCRUM-001' && normalizeText(t.title).includes('oauth2') && normalizeText(t.title).includes('token refresh')
			);

			return finalizeChecks([
				createCheck(
					'Searched Gmail for Phoenix and forwarded the status update to Tom Bradley',
					Boolean(searchEvent) && Boolean(forwardedGmail) && eventMentionsAll(fwdText, [
						['api integration', 'api'],
						['database migration', 'migration'],
					]),
					!searchEvent
						? 'No Gmail search for Phoenix was found.'
						: !forwardedGmail
							? 'No forward to tom.bradley@startup.vc was found for the Phoenix status update.'
							: 'The forward is missing the API integration or database migration progress.'
				),
				createCheck(
					'Searched ScrumBoard for authentication',
					Boolean(scrumSearch),
					'No search filter for "authentication" was found in ScrumBoard.'
				),
				createCheck(
					'Changed SCRUM-001 issue type to Story',
					typeChanged,
					!task001
						? 'SCRUM-001 was not found in the ScrumBoard snapshot.'
						: `Expected SCRUM-001 type story, got ${task001.type}.`
				),
				createCheck(
					'Added OAuth2 token refresh tests subtask under SCRUM-001',
					Boolean(subtask),
					'No subtask containing "OAuth2 token refresh tests" was found under SCRUM-001.'
				),
			], 'Phoenix status was forwarded, authentication task was updated, and subtask was added.');
		},
	},
	'EVAL-41': {
		desc: 'Delete a superseded calendar event, add attendees, RSVP tentative, message Teams, and update ScrumBoard.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;

			const searchEvent = findEvent(outlook.events, event =>
				event.type === 'search_performed' && normalizeText(event.query || '').includes('sprint planning')
			);

			const sprintPlanningDeleted = !(outlook.snapshot?.calendarEvents || []).some(event =>
				normalizeText(event.title) === 'sprint planning' && event.date === '2026-03-13'
			);

			// Customer Success Review (event-038) should have priya added and RSVP tentative
			const custReview = findCalendarEventById(outlook.snapshot, 'event-038');
			const seedCustReview = findCalendarEventById({ calendarEvents: outlook.db?.events || [] }, 'event-038');
			const hasPriya = custReview && (custReview.attendees || []).some(a => normalizeText(a) === normalizeText('priya.patel@contoso.com'));
			const isTentative = custReview && normalizeText(custReview.rsvp || '') === 'tentative';
			const expectedCustReviewAttendees = new Set([...(seedCustReview?.attendees || []), 'priya.patel@contoso.com']);
			const actualCustReviewAttendees = new Set(custReview?.attendees || []);
			const custReviewAttendeesMatch = expectedCustReviewAttendees.size === actualCustReviewAttendees.size
				&& [...expectedCustReviewAttendees].every(attendee => actualCustReviewAttendees.has(attendee));

			// Teams message to Quinn Martinez (conv-7)
			const quinnMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-7'),
				[['sprint planning', 'march 13'], ['ci/cd', 'migration sync'], ['do you want', 'want to use it', 'would you like', 'should we use it']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			// ScrumBoard SCRUM-022 story points and subtask
			const scrum022 = findTask(scrum, 'SCRUM-022');
			const subtask = findSubtask(scrum, 'SCRUM-022', 'Run Lighthouse audit on checkout flow');

			return finalizeChecks([
				createCheck(
					'Searched the Outlook calendar for Sprint Planning',
					Boolean(searchEvent),
					'No Outlook search_performed event for "Sprint Planning" was found.'
				),
				createCheck(
					'Deleted the superseded March 13 Sprint Planning event',
					sprintPlanningDeleted,
					'The March 13 Sprint Planning event (event-040) still exists in the calendar.'
				),
				createCheck(
					'Added Priya as attendee to Customer Success Review and set RSVP tentative',
					hasPriya && isTentative && custReviewAttendeesMatch,
					!custReview
						? 'The Customer Success Review event was not found.'
						: !hasPriya
							? 'Priya Patel was not added as an attendee to the Customer Success Review.'
							: !isTentative
								? 'The Customer Success Review RSVP is not set to tentative.'
								: 'The Customer Success Review attendees do not match the original list plus Priya Patel.'
				),
				createCheck(
					'Messaged Quinn Martinez about the freed sprint planning slot',
					Boolean(quinnMsg),
					!quinnMsg
						? 'No message was sent to Quinn Martinez in Teams.'
						: 'The message to Quinn is missing the sprint planning slot, the CI/CD migration sync reference, or the ask to use the slot.'
				),
				createCheck(
					'Set SCRUM-022 story points to 5 and added the Lighthouse audit subtask',
					Boolean(scrum022) && scrum022.storyPoints === 5 && Boolean(subtask),
					!scrum022
						? 'SCRUM-022 was not found in the ScrumBoard snapshot.'
						: scrum022.storyPoints !== 5
							? `Expected storyPoints=5, got ${scrum022.storyPoints}.`
							: 'The Lighthouse audit subtask was not found under SCRUM-022.'
				),
			], 'Calendar was cleaned up, Customer Success Review updated, Quinn notified, and ScrumBoard updated.');
		},
	},

	'EVAL-42': {
		desc: 'Read postmortem action items from Teams, create 3 ScrumBoard bugs, email summary.',
		verify(bundle) {
			const teams = bundle.teams;
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;
			const incidentRoomOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-g3'));

			// 3 bugs created: null-check (Alice/backend), canary (Frank/devops), runbook (Emma/docs)
			const nullCheckBug = findCreatedTask(scrum, task =>
				task.type === 'bug' && normalizeText(task.title) === normalizeText('Add null-check guard in PaymentValidationService')
			);
			const canaryBug = findCreatedTask(scrum, task =>
				task.type === 'bug' && normalizeText(task.title) === normalizeText('Implement canary deployment strategy with Argo Rollouts')
			);
			const runbookBug = findCreatedTask(scrum, task =>
				task.type === 'bug' && normalizeText(task.title) === normalizeText('Define SEV-1 escalation runbook')
			);

			// Email to priya.sharma@contoso.com
			const emailCandidate = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email =>
					emailHasRecipient(email, 'priya.sharma@contoso.com')
					&& normalizeText(email.subject) === normalizeText('Postmortem action items assigned')
				),
				[['alice', 'paymentvalidationservice', 'null-check', 'null check'], ['frank', 'argo', 'canary'], ['emma', 'sev-1', 'runbook']],
				email => `${email.subject || ''} ${email.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Opened the Incident Response Team conversation in Teams',
					incidentRoomOpened,
					'The Incident Response Team conversation was not opened in Teams.'
				),
				createCheck(
					'Created the null-check guard bug assigned to Alice Chen with backend tag',
					Boolean(nullCheckBug?.task) && nullCheckBug.task.priority === 'critical' && nullCheckBug.task.sprintId === 'sprint-2'
						&& nullCheckBug.task.assigneeId === 'user-1' && (nullCheckBug.task.tags || []).includes('tag-2'),
					!nullCheckBug?.task
						? 'No bug for the null-check guard was found in ScrumBoard.'
						: `Expected critical / Sprint 2 / Alice (user-1) / backend, got priority=${nullCheckBug.task.priority}, sprint=${nullCheckBug.task.sprintId}, assignee=${nullCheckBug.task.assigneeId}, tags=${(nullCheckBug.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Created the canary deployment bug assigned to Frank Lee with devops tag, and the SEV-1 runbook bug assigned to Emma Johnson with docs tag',
					Boolean(canaryBug?.task) && canaryBug.task.priority === 'critical' && canaryBug.task.sprintId === 'sprint-2'
						&& canaryBug.task.assigneeId === 'user-6' && (canaryBug.task.tags || []).includes('tag-10')
						&& Boolean(runbookBug?.task) && runbookBug.task.priority === 'critical' && runbookBug.task.sprintId === 'sprint-2'
						&& runbookBug.task.assigneeId === 'user-5' && (runbookBug.task.tags || []).includes('tag-9'),
					!canaryBug?.task
						? 'No bug for the canary deployment strategy was found in ScrumBoard.'
						: !runbookBug?.task
							? 'No bug for the SEV-1 escalation runbook was found in ScrumBoard.'
							: `Canary: assignee=${canaryBug.task.assigneeId}, tags=${(canaryBug.task.tags || []).join(', ')}. Runbook: assignee=${runbookBug.task.assigneeId}, tags=${(runbookBug.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Emailed Priya with the postmortem assignment summary',
					Boolean(emailCandidate),
					!emailCandidate
						? 'No email with subject "Postmortem action items assigned" was sent to priya.sharma@contoso.com.'
						: 'The email is missing the assignment details for Alice, Frank, Emma, or the runbook item.'
				),
			], 'Postmortem action items were read, assigned as ScrumBoard bugs, and summarized in an email to Priya.');
		},
	},

	'EVAL-43': {
		desc: 'Mark unread alert emails read, flag SSL cert, update ScrumBoard priority and subtask, alert Teams.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;
			const teams = bundle.teams;

			const alertIds = ['email-008', 'email-010', 'email-030'];
			const alertEmails = alertIds.map(id => getOutlookEmail(outlook.snapshot, id)).filter(Boolean);
			const allRead = alertEmails.length === alertIds.length && alertEmails.every(email => email.read === true);

			const sslEmail = getOutlookEmail(outlook.snapshot, 'email-010');
			const sslFlagged = sslEmail && sslEmail.flagged === true;

			const scrum006 = findTask(scrum, 'SCRUM-006');
			const subtask = findSubtask(scrum, 'SCRUM-006', 'Validate pg_dump backup before cutover');
			const teamsMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g1'),
				[['ssl', 'certificate'], ['14 day', '14-day', '14 days', 'march 17'], ['database migration', 'postgresql', 'blocker']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Marked all three automated alert emails as read',
					allRead,
					!allRead
						? `Not all alert emails are read. ${alertEmails.map(e => `${e.id}=read:${e.read}`).join(', ')}.`
						: 'Expected all alert emails to be read.'
				),
				createCheck(
					'Flagged the SSL certificate expiry email',
					sslFlagged,
					!sslEmail
						? 'The SSL certificate expiry email (email-010) was not found.'
						: 'The SSL certificate expiry email is not flagged.'
				),
				createCheck(
					'Changed SCRUM-006 to Critical priority and added the pg_dump subtask',
					Boolean(scrum006) && scrum006.priority === 'critical'
						&& Boolean(subtask),
					!scrum006
						? 'SCRUM-006 was not found in the ScrumBoard snapshot.'
						: scrum006.priority !== 'critical'
							? `Expected priority critical, got ${scrum006.priority}.`
							: !subtask
								? 'The pg_dump backup validation subtask was not created under SCRUM-006.'
								: 'Expected SCRUM-006 changes to be complete.'
				),
				createCheck(
					'Posted the SSL cert + database migration blocker alert in Engineering Leads',
					Boolean(teamsMsg),
					!teamsMsg
						? 'No new Engineering Leads message was found.'
						: 'The Engineering Leads message is missing the SSL cert expiry, 14-day timeline, or database migration blocker detail.'
				),
			], 'Alert noise was cleared, SSL cert flagged, database migration escalated, and team was notified.');
		},
	},

	'EVAL-44': {
		desc: 'Rebalance sprint assignments, modify calendar attendees, decline event, and notify in Teams.',
		verify(bundle) {
			const scrum = bundle.scrumboard;
			const outlook = bundle.outlook;
			const teams = bundle.teams;

			// SCRUM-011 reassigned to Alice Chen, priority changed to High
			const scrum011 = findTask(scrum, 'SCRUM-011');
			// SCRUM-007 reassigned to Bob Martinez
			const scrum007 = findTask(scrum, 'SCRUM-007');

			// Retrospective (event-028): remove jordan.lee from attendees
			const retro = findCalendarEventById(outlook.snapshot, 'event-028');
			const retroHasJordan = retro && (retro.attendees || []).some(a => normalizeText(a).includes('jordan'));
			const seedRetro = findCalendarEventById({ calendarEvents: outlook.db?.events || [] }, 'event-028');
			const expectedRetroAttendees = (seedRetro?.attendees || []).filter(attendee => normalizeText(attendee) !== normalizeText('jordan.lee@contoso.com'));
			const retroAttendeesPreserved = Boolean(retro)
				&& expectedRetroAttendees.length === (retro.attendees || []).length
				&& expectedRetroAttendees.every(attendee => (retro.attendees || []).includes(attendee));

			// Happy Hour (event-029): declined
			const happyHour = findCalendarEventById(outlook.snapshot, 'event-029');

			// Teams message to Jordan Kim (conv-1)
			const jordanMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-1'),
				[['sprint 2', 'tasks'], ['redistribut', 'reassign', 'rebalanc'], ['out', 'pto', 'while you\'re out'], ['david', 'workload', 'lightened', 'lighter']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Reassigned SCRUM-011 to Alice Chen and changed priority to High',
					Boolean(scrum011) && scrum011.assigneeId === 'user-1' && scrum011.priority === 'high',
					!scrum011
						? 'SCRUM-011 was not found in the ScrumBoard snapshot.'
						: `Expected assignee user-1 / priority high, got assignee=${scrum011.assigneeId}, priority=${scrum011.priority}.`
				),
				createCheck(
					'Reassigned SCRUM-007 to Bob Martinez',
					Boolean(scrum007) && scrum007.assigneeId === 'user-2',
					!scrum007
						? 'SCRUM-007 was not found in the ScrumBoard snapshot.'
						: `Expected assignee user-2 (Bob Martinez), got ${scrum007.assigneeId}.`
				),
				createCheck(
					'Removed Jordan Lee from the Retrospective and declined the Happy Hour',
					!retroHasJordan && retroAttendeesPreserved && Boolean(happyHour) && normalizeText(happyHour.rsvp || '') === 'declined',
					retroHasJordan
						? 'Jordan Lee is still listed as a Retrospective attendee.'
						: !retroAttendeesPreserved
							? 'The Retrospective attendees were changed beyond removing Jordan Lee.'
						: !happyHour
							? 'The Happy Hour event was not found.'
							: 'The Happy Hour event was not declined.'
				),
				createCheck(
					'Notified Jordan Kim in Teams about the sprint redistribution',
					Boolean(jordanMsg),
					!jordanMsg
						? 'No new Teams message to Jordan Kim was found.'
						: 'The Teams message is missing the sprint redistribution, Jordan\'s time out, or the David Kim workload context.'
				),
			], 'Sprint was rebalanced, calendar was updated, and Jordan was notified.');
		},
	},

	'EVAL-45': {
		desc: 'Escalate GDPR gaps from Teams to Outlook with Cc, then create ScrumBoard remediation plan.',
		verify(bundle) {
			const teams = bundle.teams;
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;
			const rileyOpened = Boolean(findEvent(teams.events, event => event.type === 'conversation_opened' && event.conversationId === 'conv-5'));

			// Email to tom.nguyen@contoso.com with Cc sarah.kim@contoso.com
			const emailCandidate = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email =>
					emailHasRecipient(email, 'tom.nguyen@contoso.com')
					&& normalizeText(email.subject) === normalizeText('GDPR Compliance Gaps — Board Briefing Required')
				),
				[['data retention', 'retention violation'], ['erasure', 'right to erasure'], ['helios'], ['8.5 sprint', '8.5-sprint', '8.5 sprints']],
				email => `${email.subject || ''} ${email.body || ''}`
			);
			const emailText = emailCandidate ? `${emailCandidate.subject} ${emailCandidate.body}` : '';
			const hasCc = emailCandidate && (
				(Array.isArray(emailCandidate.cc) && emailCandidate.cc.some(entry => {
					const addr = typeof entry === 'string' ? entry : (entry.email || '');
					return addr.toLowerCase() === 'sarah.kim@contoso.com';
				}))
			);

			// ScrumBoard task
			const gdprTask = findCreatedTask(scrum, task =>
				textContainsAllGroups(`${task.title} ${task.description || ''}`, [
					['gdpr'],
					['compliance', 'remediation'],
				])
			);

			const auditSubtask = findSubtask(scrum, gdprTask?.task?.id, 'Audit data retention policies across all services');
			const heliosSubtask = findSubtask(scrum, gdprTask?.task?.id, 'Escalate Helios Payments DPA to legal');
			const auditSubtaskCount = countSubtasks(scrum, gdprTask?.task?.id, 'Audit data retention policies across all services');
			const heliosSubtaskCount = countSubtasks(scrum, gdprTask?.task?.id, 'Escalate Helios Payments DPA to legal');

			return finalizeChecks([
				createCheck(
					'Opened Riley Patel\'s Teams conversation',
					rileyOpened,
					'Riley Patel\'s Teams conversation was not opened.'
				),
				createCheck(
					'Emailed Tom Nguyen the GDPR gaps with data retention, erasure, Helios DPA, and 8.5-sprint estimate, Cc\'d Sarah Kim',
					Boolean(emailCandidate) && hasCc,
					!emailCandidate
						? 'No email with subject containing "GDPR" was sent to tom.nguyen@contoso.com.'
						: !hasCc
							? 'Sarah Kim was not Cc\'d on the GDPR escalation email.'
							: 'The email is missing data retention, erasure cascade, Helios DPA, or 8.5-sprint estimate.'
				),
				createCheck(
					'Created the GDPR compliance remediation plan task as critical in Sprint 2 assigned to David Kim with security and backend tags',
					Boolean(gdprTask?.task)
						&& gdprTask.task.type === 'story'
						&& gdprTask.task.priority === 'critical'
						&& gdprTask.task.sprintId === 'sprint-2'
						&& gdprTask.task.assigneeId === 'user-4'
						&& (gdprTask.task.tags || []).includes('tag-7')
						&& (gdprTask.task.tags || []).includes('tag-2'),
					!gdprTask?.task
						? 'No ScrumBoard task for GDPR compliance remediation was found.'
						: `Expected story / critical / Sprint 2 / David Kim / security+backend, got type=${gdprTask.task.type}, priority=${gdprTask.task.priority}, sprint=${gdprTask.task.sprintId}, assignee=${gdprTask.task.assigneeId}, tags=${(gdprTask.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Added both GDPR subtasks: data retention audit and Helios DPA escalation',
					Boolean(auditSubtask) && Boolean(heliosSubtask) && auditSubtaskCount === 1 && heliosSubtaskCount === 1,
					!auditSubtask && !heliosSubtask
						? 'Neither GDPR subtask was found under the remediation plan task.'
						: !auditSubtask
							? 'The data retention audit subtask was not found.'
							: !heliosSubtask
								? 'The Helios DPA escalation subtask was not found.'
								: 'Expected exactly one copy of each GDPR subtask under the remediation plan task.'
				),
			], 'Riley\'s GDPR findings were escalated by email with Cc, and a concrete remediation plan was created in ScrumBoard.');
		},
	},

	'EVAL-46': {
		desc: 'Reply to performance review email, delete cancelled event, create ScrumBoard task, post in Teams.',
		verify(bundle) {
			const outlook = bundle.outlook;
			const scrum = bundle.scrumboard;
			const teams = bundle.teams;

			// Reply to Linda Chen's performance review email (email-009)
			const lindaReply = findCandidateWithGroups(
				findNewOutlookEmails(outlook, email => email.replyToId === 'email-009' && emailHasRecipient(email, 'linda.chen@contoso.com')),
				[['march 20', '20th'], ['priya'], ['daniel'], ['orientation']],
				email => `${email.subject || ''} ${email.body || ''}`
			);

			// Lunch & Learn event (event-036) should be deleted
			const lunchLearnDeleted = !findCalendarEventById(outlook.snapshot, 'event-036');

			// ScrumBoard: check for performance tag filter attempt
			const perfFilter = findEvent(scrum.events, event =>
				event.type === 'filter_applied' && event.data?.filterType === 'tag' && event.data?.value === 'tag-8'
			);

			// ScrumBoard task for performance self-assessments
			const perfTask = findCreatedTask(scrum, task =>
				normalizeText(task.title) === normalizeText('Complete Q1 performance self-assessments')
			);

			// Teams message in Product Sprint Planning (conv-g2)
			const sprintPlanMsg = findCandidateWithGroups(
				findNewTeamsMessages(teams, message => message.conversationId === 'conv-g2'),
				[['performance review', 'self-assessment'], ['march 10']],
				message => `${message.bodyText || ''} ${message.body || ''}`
			);

			return finalizeChecks([
				createCheck(
					'Replied to Linda Chen confirming March 20 deadline and orientation meetings for Priya and Daniel',
					Boolean(lindaReply),
					!lindaReply
						? 'No reply to Linda Chen\'s performance review email (email-009) was found.'
						: 'The reply is missing the March 20 deadline, the Priya/Daniel mention, or the orientation meeting commitment.'
				),
				createCheck(
					'Deleted the Lunch & Learn: AI Tools event',
					lunchLearnDeleted,
					'The Lunch & Learn: AI Tools event (event-036) still exists in the calendar.'
				),
				createCheck(
					'Filtered by performance tag in ScrumBoard',
					Boolean(perfFilter),
					'No filter_applied event for the performance tag was found in ScrumBoard.'
				),
				createCheck(
					'Created the performance self-assessments task in Sprint 2 with medium priority, no assignee, and docs tag',
					Boolean(perfTask?.task)
						&& perfTask.task.sprintId === 'sprint-2'
						&& perfTask.task.priority === 'medium'
						&& (!perfTask.task.assigneeId || perfTask.task.assigneeId === '')
						&& (perfTask.task.tags || []).includes('tag-9'),
					!perfTask?.task
						? 'No ScrumBoard task for performance self-assessments was found.'
						: `Expected Sprint 2 / medium / unassigned / docs tag, got sprint=${perfTask.task.sprintId}, priority=${perfTask.task.priority}, assignee=${perfTask.task.assigneeId || 'none'}, tags=${(perfTask.task.tags || []).join(', ')}.`
				),
				createCheck(
					'Posted in Product Sprint Planning about performance reviews opening March 10',
					Boolean(sprintPlanMsg),
					!sprintPlanMsg
						? 'No message was posted in Product Sprint Planning.'
						: 'The Product Sprint Planning message is missing the performance review or March 10 detail.'
				),
			], 'Performance review follow-up was completed across Outlook reply, calendar cleanup, ScrumBoard, and Teams.');
		},
	},
};

function runTask(taskId, bundle) {
	const task = TASKS[taskId];
	if (!task) return fail(`Unknown task: ${taskId}`);
	try {
		return task.verify(bundle);
	} catch (error) {
		return fail(`Evaluator error for ${taskId}: ${error.message}`);
	}
}

function printChecks(result) {
	if (!Array.isArray(result.checks) || result.checks.length === 0) return;
	console.log('checks:');
	for (const check of result.checks) {
		console.log(`  ${check.pass ? 'PASS' : 'FAIL'} - ${check.label}`);
	}
}

function main() {
	const args = process.argv.slice(2);
	const runAll = args.includes('--all');
	const taskId = runAll ? null : args[0];

	if (!runAll && !taskId) {
		console.error('Usage: node evaluator.js EVAL-01 --output-dir <dir>');
		console.error('   or: node evaluator.js --all --output-dir <dir>');
		process.exit(1);
	}

	const { outputDir, allowDefaultArtifacts } = resolveArtifactOptions(args);
	const bundle = loadBundle(outputDir, allowDefaultArtifacts);

	console.log(`cross_site evaluator v${VERSION}`);

	if (runAll) {
		let failed = 0;
		for (const [id, task] of Object.entries(TASKS)) {
			const result = runTask(id, bundle);
			console.log(`\n${id} - ${task.desc}`);
			printChecks(result);
			console.log(`result: ${result.pass ? 'pass' : 'fail'}`);
			console.log(`message: ${result.message}`);
			if (!result.pass) failed += 1;
		}
		process.exit(failed > 0 ? 1 : 0);
	}

	const result = runTask(taskId, bundle);
	printChecks(result);
	console.log(`result: ${result.pass ? 'pass' : 'fail'}`);
	console.log(`message: ${result.message}`);
	if (result.checks && result.checks.length > 0) {
		const passed = result.checks.filter(c => c.pass).length;
		const score = (passed / result.checks.length).toFixed(2);
		console.log(`score: ${score} (${passed}/${result.checks.length})`);
	} else {
		console.log(`score: ${result.pass ? '1.00' : '0.00'}`);
	}
	process.exit(result.pass ? 0 : 1);
}

module.exports = {
	TASKS,
	runTask,
	loadBundle,
	normalizeText,
};

if (require.main === module) {
	main();
}
