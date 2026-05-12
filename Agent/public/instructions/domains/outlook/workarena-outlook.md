# Navigation Guide: Email & Calendar Application

## Site Overview
A web-based email and calendar management application that allows users to compose and organize emails, manage folders, view different calendar perspectives, and schedule events.

## Navigation Structure

### Depth 0: /
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#btn-new-email` | Open new email composer | → Depth 1: / (After btn new email) |
| fill | `[aria-label="Search mail"]` | Search mail | → Depth 1: / (After Search mail) |
| click | `#folder-list > li.folder-item.active:nth-of-type(1)` | Select active inbox folder | Stays on page |
| click | `#folder-list > li.folder-item:nth-of-type(2)` | Select sent folder | → Depth 1: / (After folder list) #1 |
| click | `#folder-list > li.folder-item:nth-of-type(3)` | Select drafts folder | → Depth 1: / (After folder list) #2 |
| click | `#folder-list > li.folder-item:nth-of-type(4)` | Select starred/important folder | → Depth 1: / (After folder list) #3 |
| click | `#ribbon-reply` | Reply to selected email | → Depth 1: / (After ribbon move) |
| click | `#ribbon-reply-all` | Reply all to email | → Depth 1: / (After ribbon move) |
| click | `#ribbon-forward` | Forward selected email | → Depth 1: / (After ribbon move) |
| click | `#ribbon-delete` | Delete selected email | → Depth 1: / (After ribbon move) |
| click | `#ribbon-archive` | Archive selected email | → Depth 1: / (After ribbon move) |
| click | `#ribbon-move` | Move email to folder | → Depth 1: / (After ribbon move) |
| click | `text="Calendar"` | Switch to calendar view | → Depth 1: / (After Calendar) |
| click | `text="Mail"` | Return to mail view | → Depth 1: / (After btn discard) |
| click | `#btn-profile-avatar` | Open user profile menu | → Depth 1: / (After btn profile avatar) |

### Depth 1: / (After btn new email)
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#btn-send` | Send composed email | → Depth 2: / (After btn send) |
| fill | `#compose-to` | Enter recipient email address | → Depth 2: / (After compose to) |
| fill | `#compose-subject` | Enter email subject line | → Depth 2: / (After compose subject) |
| fill | `#compose-cc` | Add CC recipients | → Depth 2: / (After compose cc) |
| click | `#btn-discard` | Cancel and close composer | → Depth 1: / (After btn discard) |

### Depth 1: / (After Search mail)
Mail search interface opened on the homepage. The search overlay is active and ready for query input.

### Depth 1: / (After folder list) #1
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#today-emails > div.email-card.read:nth-of-type(1)` | Open first today's email | → Depth 2: / (After today emails) #1 |
| click | `#today-emails > div.email-card.read:nth-of-type(2)` | Open second today's email | → Depth 2: / (After today emails) #2 |
| click | `#today-emails > div.email-card.read:nth-of-type(3)` | Open third today's email | → Depth 2: / (After today emails) #3 |
| click | `#older-emails > div.email-card.read:nth-of-type(1)` | Open first older email | → Depth 2: / (After older emails) #1 |
| click | `#older-emails > div.email-card.read:nth-of-type(2)` | Open second older email | → Depth 2: / (After older emails) #2 |
| click | `#older-emails > div.email-card.read:nth-of-type(3)` | Open third older email | → Depth 2: / (After older emails) #3 |
| click | `#older-emails > div.email-card.read:nth-of-type(4)` | Open fourth older email | → Depth 2: / (After older emails) #4 |
| click | `#older-emails > div.email-card.read:nth-of-type(5)` | Open fifth older email | → Depth 2: / (After older emails) #5 |
| click | `#older-emails > div.email-card.read:nth-of-type(6)` | Open sixth older email | → Depth 2: / (After older emails) #6 |
| click | `#older-emails > div.email-card.read:nth-of-type(7)` | Open seventh older email | → Depth 2: / (After older emails) #7 |
| click | `#older-emails > div.email-card.read:nth-of-type(8)` | Open eighth older email | → Depth 2: / (After older emails) #8 |
| click | `#older-emails > div.email-card.read:nth-of-type(9)` | Open ninth older email | → Depth 2: / (After older emails) #9 |
| click | `#older-emails > div.email-card.read:nth-of-type(10)` | Open tenth older email | → Depth 2: / (After older emails) #10 |

### Depth 1: / (After folder list) #2
Drafts folder selected showing saved draft emails. The folder contains draft messages that are currently being composed or saved for later.

### Depth 1: / (After folder list) #3
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#pinned-emails > div.email-card.read` | Open pinned starred email | → Depth 2: / (After pinned emails) #1 |

### Depth 1: / (After ribbon move)
Email action overlay displayed on the homepage. A modal or dropdown for moving, replying, or forwarding the selected email is now visible.

### Depth 1: / (After Calendar)
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#ribbon-cal-new-event` | Create new calendar event | → Depth 2: / (After ribbon cal new event) |
| click | `#ribbon-cal-home > div.ribbon-group:nth-of-type(3) > div.ribbon-group-btns:nth-of-type(1) > button.ribbon-btn.cal-ribbon-view-btn:nth-of-type(1)` | Switch to day view | → Depth 2: / (After cal view switcher) #1 |
| click | `#ribbon-cal-home > div.ribbon-group:nth-of-type(3) > div.ribbon-group-btns:nth-of-type(1) > button.ribbon-btn.cal-ribbon-view-btn:nth-of-type(2)` | Switch to week view | Stays on page |
| click | `#ribbon-cal-home > div.ribbon-group:nth-of-type(3) > div.ribbon-group-btns:nth-of-type(1) > button.ribbon-btn.cal-ribbon-view-btn:nth-of-type(3)` | Switch to work week | → Depth 2: / (After cal view switcher) #2 |
| click | `#ribbon-cal-home > div.ribbon-group:nth-of-type(3) > div.ribbon-group-btns:nth-of-type(1) > button.ribbon-btn.cal-ribbon-view-btn:nth-of-type(4)` | Switch to month view | → Depth 2: / (After cal view switcher) #3 |
| click | `#ribbon-cal-today` | Jump to today's calendar | Stays on page |
| click | `#cal-mini-prev` | Previous month in mini calendar | → Depth 2: / (After cal mini prev) |
| click | `#cal-mini-next` | Next month in mini calendar | → Depth 2: / (After cal mini next) |
| click | `#btn-cal-today` | Jump to today in calendar | Stays on page |
| click | `#btn-cal-prev` | Previous time period in calendar | → Depth 2: / (After btn cal prev) |
| click | `#btn-cal-next` | Next time period in calendar | → Depth 2: / (After btn cal next) |
| click | `#cal-view-switcher > button.cal-view-btn:nth-of-type(1)` | Switch calendar to month view | → Depth 2: / (After cal view switcher) #3 |
| click | `#cal-view-switcher > button.cal-view-btn:nth-of-type(2)` | Switch calendar to week view | → Depth 2: / (After cal view switcher) #2 |
| click | `#cal-view-switcher > button.cal-view-btn:nth-of-type(3)` | Switch calendar to day view | → Depth 2: / (After cal view switcher) #1 |
| click | `#cal-mini-grid > div.cal-mini-day-wrap:nth-of-type(13) > button.cal-mini-day.today` | Select today in mini calendar | Stays on page |

### Depth 1: / (After btn discard)
| Action | Selector | Description | Result |
|--------|----------|-------------|--------|
| click | `#pinned-emails > div.email-card.unread:nth-of-type(1)` | Open first unread pinned email | → Depth 2: / (After pinned emails) #2 |
| click | `#today-emails > div.email-card.unread:nth-of-type(1)` | Open first unread today email | → Depth 2: / (After today emails) #4 |
| click | `#today-emails > div.email-card.unread:nth-of-type(2)` | Open second unread today email | → Depth 2: / (After today emails) #5 |
| click | `#today-emails > div.email-card.unread:nth-of-type(6)` | Open sixth unread today email | → Depth 2: / (After today emails) #6 |
| click | `#today-emails > div.email-card.unread:nth-of-type(7)` | Open seventh unread today email | → Depth 2: / (After today emails) #7 |
| click | `#pinned-emails > div.email-card.read:nth-of-type(2)` | Open second read pinned email | → Depth 2: / (After pinned emails) #3 |
| click | `#pinned-emails > div.email-card.read:nth-of-type(3)` | Open third read pinned email | → Depth 2: / (After pinned emails) #4 |
| click | `#today-emails > div.email-card.read:nth-of-type(5)` | Open fifth read today email | → Depth 2: / (After today emails) #8 |
| click | `#today-emails > div.email-card.read:nth-of-type(4)` | Open fourth read today email | → Depth 2: / (After today emails) #9 |
| click | `#today-emails > div.email-card.read:nth-of-type(8)` | Open eighth read today email | → Depth 2: / (After today emails) #10 |
| click | `#today-emails > div.email-card.read:nth-of-type(9)` | Open ninth read today email | → Depth 2: / (After today emails) #11 |

### Depth 1: / (After btn profile avatar)
User profile menu opened on the homepage. The dropdown displays account settings, preferences, and sign-out options.

## Depth 2 Pages

**Email Composition & Form States:**
- **/ (After btn send)** (`/`) - Email sent confirmation state after clicking the send button in the composer
- **/ (After compose to)** (`/`) - Email composer with recipient field populated and focused
- **/ (After compose subject)** (`/`) - Email composer with subject line field populated and focused
- **/ (After compose cc)** (`/`) - Email composer with CC field populated and focused

**Email Detail Views - Sent Folder:**
- **/ (After today emails) #1** (`/`) - First email from today's sent folder opened in reading pane
- **/ (After today emails) #2** (`/`) - Second email from today's sent folder opened in reading pane
- **/ (After today emails) #3** (`/`) - Third email from today's sent folder opened in reading pane
- **/ (After older emails) #1** (`/`) - First older sent email opened in reading pane
- **/ (After older emails) #2** (`/`) - Second older sent email opened in reading pane
- **/ (After older emails) #3** (`/`) - Third older sent email opened in reading pane
- **/ (After older emails) #4** (`/`) - Fourth older sent email opened in reading pane
- **/ (After older emails) #5** (`/`) - Fifth older sent email opened in reading pane
- **/ (After older emails) #6** (`/`) - Sixth older sent email opened in reading pane
- **/ (After older emails) #7** (`/`) - Seventh older sent email opened in reading pane
- **/ (After older emails) #8** (`/`) - Eighth older sent email opened in reading pane
- **/ (After older emails) #9** (`/`) - Ninth older sent email opened in reading pane
- **/ (After older emails) #10** (`/`) - Tenth older sent email opened in reading pane

**Email Detail Views - Starred/Important Folder:**
- **/ (After pinned emails) #1** (`/`) - Read pinned email from starred folder opened in reading pane

**Email Detail Views - Inbox:**
- **/ (After pinned emails) #2** (`/`) - First unread pinned inbox email opened in reading pane
- **/ (After today emails) #4** (`/`) - First unread inbox email from today opened in reading pane
- **/ (After today emails) #5** (`/`) - Second unread inbox email from today opened in reading pane
- **/ (After today emails) #6** (`/`) - Sixth unread inbox email from today opened in reading pane
- **/ (After today emails) #7** (`/`) - Seventh unread inbox email from today opened in reading pane
- **/ (After pinned emails) #3** (`/`) - Second read pinned inbox email opened in reading pane
- **/ (After pinned emails) #4** (`/`) - Third read pinned inbox email opened in reading pane
- **/ (After today emails) #8** (`/`) - Fifth read inbox email from today opened in reading pane
- **/ (After today emails) #9** (`/`) - Fourth read inbox email from today opened in reading pane
- **/ (After today emails) #10** (`/`) - Eighth read inbox email from today opened in reading pane
- **/ (After today emails) #11** (`/`) - Ninth read inbox email from today opened in reading pane

**Calendar Views & Event Management:**
- **/ (After ribbon cal new event)** (`/`) - New calendar event creation form displayed in modal or overlay
- **/ (After cal view switcher) #1** (`/`) - Calendar displayed in day view showing hourly schedule
- **/ (After cal view switcher) #2** (`/`) - Calendar displayed in work week view (Monday-Friday)
- **/ (After cal view switcher) #3** (`/`) - Calendar displayed in month view showing full month grid
- **/ (After cal mini prev)** (`/`) - Mini calendar navigated to previous month
- **/ (After cal mini next)** (`/`) - Mini calendar navigated to next month
- **/ (After btn cal prev)** (`/`) - Main calendar view navigated to previous time period
- **/ (After btn cal next)** (`/`) - Main calendar view navigated to next time period