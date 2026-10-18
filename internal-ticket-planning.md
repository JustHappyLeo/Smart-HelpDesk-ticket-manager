# Internal Ticketing System - Planning Canvas

Use this document to sketch the product before implementation. Replace the prompts with your decisions; rough notes and diagrams are welcome. We can refine it together.

## 1. Purpose

- **Company/team using it:** customizable hierarchy with something like "Manager", "Project manager", "team manager" and "technician". Every hierarchy might be customized for more "proects", e.g. there is a proect manager for help desk and one for networking 
- **Problem this system should solve:** 
- **What is out of scope for the first version:** Database with user and tickets data, web page protected with login and view based on role 

## 2. People and permissions

List each kind of user and what they can do.

| Role | Create tickets | View tickets | Assign tickets | Change status | Manage users/settings |
|---|---|---|---|---|---|
| Employee/requester | Y | Y | N | not all status | N |
| Group Member | Y in his group | Y in his group | Self-assign or request another member's approval | Assigned tickets only | N |
| Group Team Leader | Y in his group | Y in his group | Y in his group | Y in his group | N |
| TicketManager | Y | Y | Y | Y | N |
| Administrator | Y | Y | Y | Y | Y |

Add, remove, or rename roles to match your company.

## 3. Ticket workflow

- **Statuses** (for example: New -> Open -> In progress -> Waiting -> Resolved -> Closed):
    New, Open, Scheduled, In Progress, Waiting for feedback, Resolved, Closed
- **Who can move a ticket between statuses?**
    End user can only switch manually to closed, whenever user answer to a ticked in "waiting for feedback" state it switches to In Progress. Only admin can change state from closed or resolved to something else.
- **Can a closed ticket be reopened? Under what conditions?**
    Only from user with that permisison (by default project amanger or above)
- **Priority levels and definitions:**
    Critical = It block or might blocks in the near future the workflow of the entire company
    High = It completely blocks the workflow of one or more users
    Normal = Activities that do not completely block operativity of the company but slow down the operativity of just a few users
    Low = Minor improvements of the workflow
    In customized projects there might be custom deifitions for the priority
- **Teams, categories, or queues:** Every group/subgroup has its queue of tickets
- **Assignment rules:** members can assign tickets to themselves or request that another member take a ticket; the target member must approve. Team Leaders can assign or unassign tickets for anyone in their group.
- **What counts as a successful resolution?** The problem has been identified and resolved

## 4. Main workflows

End user create ticket --> Ticket manager fix the ticket info's (priority, description of the problem...) and assign it to the department/project --> Members of department can see the queue with the ticket and assign it --> Techinician close ticket

### Submit a ticket
1. Who submits it? every user
2. What information must they provide? When the problem started, what does the problem affect, description of the problem
3. What happens after submission? The ticket appears in the Ticket manager queue to be analyzed, adjusted and assigned to projects

### Work on a ticket
1. How does an agent find and claim/receive work? It appears on the queue of the team/department, it might assign it to himself or get it assigned to him by some superiors
2. How are notes, replies, and status changes recorded? End user/agent chat is only on the website, in the ticket. There is a tab for chat with user and one tab for status changes 
3. How is the requester notified? It's notified by browser alert or email if browser notification for the website arent working (or after 10 minutes if the in-web notification worked but the ticket hasn't been checked after that)

### Close or reopen a ticket
1. Who can close it? Everyone
2. Does the requester need to confirm resolution? Yes, otherwise after X time of inactivity
3. What happens if the issue returns? new ticket, it can be linked to the old one

## 5. Pages and navigation

List the pages the website needs and what each page should help the user do.

| Page | Audience | Main information/actions |
|---|---|---|
| Sign in | everyone | authenticate |
| My tickets | everyone | list all tickets assigned/created for that user |
| Team queue / ticket list | technicians | list all tickets assigned to the group of the user |
| Ticket details | everyone | dispay all info about a ticket |
| Create ticket | everyone | create the ticket based on a template |
| Admin / settings | admin,manager | manage users, roles and projects of the website/proect based on level of permissions |

### Rough screen sketches

Add plain-text layouts, screenshots, or links to designs here.

```text
Example: Ticket details
+--------------------------------------------------+
| Ticket title                         Status     |
|      Priority      Assignee      Requester       |
|       Start date/hour         End date/hour      |
|--------------------------------------------------|
| Description                                        |
|--------------------------------------------------|
| Conversation          | internal notes           |
|--------------------------------------------------|
| Reply box                         [Send]           |
+--------------------------------------------------+
```

## 6. Ticket fields

Mark fields as required or optional and note who can see/edit them.

| Field | Required? | Who can see/edit it? | Notes |
|---|---|---|---|
| Subject | Y | everyone | |
| Description | Y | everyone | |
| Requester | Y | everyone | |
| Status | Y | everyone | |
| Priority | N | agents | |
| Due date | Y | everyone | end user must specify the reason of due date |
| Location | N | everyone | |
| Department | N | agents | |
| Assignee | N | everyone | |
| Attachments | N | everyone | |
| Tags | N | agents | used by agents to categorize the ticket |

Other fields :

## 7. MySQL data model sketch

For each table, list its purpose, columns, and relationships. Use `users`, `tickets`, and similar names as placeholders; we can normalize and refine the schema together.

### `users`
- Purpose: list all users and their role
- Columns (include type if known): ID (integer), Name (text), Surname (text), Email (text), Department (text, probably there will be a list of departments), Role inside the department (text, another list) 
- Relationships: ID is the primary key, department and role might external key

### `tickets`
- Purpose: collect all infos about the ticket
- Columns (include type if known): ID  (integer), Subject (text), Description (text), Requester (Integer), Status (text, list of value), Assignee (Integer), Hours (Date/hour), Father (Integer)
- Relationships: ID is primary key, Requester and Assignee are external key for users table, Father is external key if this ticket is a sub task

### `comments` or `messages`
- Purpose: tarack communication with user, collect notes for technician who are working on that ticket
- Columns (include type if known):ID (Integer), Text (text), Writer (Integer), Hour (date/hour)
- Relationships:ID is primary key, Writer is external key for user
- Do we need to distinguish public replies from internal notes? Yes

### Other tables

- Attachments:ID (Integer), Ticket (Integer), Attachment (Text, Path to file)
- Teams / departments:ID (Integer), 
- Categories:
- Status or priority history / audit log: ID (Integer), Description (Text)
- Notifications: ID (Integer), Text (text), Recipient (Integer), Hour (date/hour)

### Relationship sketch

```text
users       1 ---- many tickets (requester)
users       1 ---- many tickets (assignee)
teams       1 ---- many tickets
tickets     1 ---- many comments
comments    many - 1    tickets
teams       many - many users
attachments many - 1    tickets
```

Add or change relationships as needed. Note which records must be retained and which may be deleted.

## 8. Notifications and integrations

- **Notification channels:** web notification if website is open or in background, after X time the notification is sent but not read send email
- **Events that send notifications:** New ticket for Ticket Manager or assignee, update on ticket for requester, ticket expiration for requester and assignee
- **Email/identity provider or other integrations:** to be determined

## 9. Security and operational needs

- **Sign-in method:** LDAP integration or email/password for users outside domain
- **Who may see sensitive tickets?** Visbility of tickets is deternmined by hierarchy
- **Audit trail needed?**
- **File upload types/size limits:** 100MB or more with approval, only screenshots
- **Data retention or deletion requirements:** Do not delete infos about tickets
- **Expected number of users/tickets:** 50 users, about 5 to 10 tickets a week
- **Deployment environment:** Windows ISS, MySQL Database

## 10. Decisions and open questions

Record unresolved questions here so we can work through them in order.

- [ ] Calendar for each user and team for tracking and planning tickets
- [ ] Subtask for each ticket (with almost every column an ordinary ticket already has)
- [ ]

## 11. First version priorities

Choose the smallest useful release.

- [3] Sign in and user roles
- [1] Create and view tickets
- [2] Ticket assignment and status workflow
- [ ] Replies and internal notes
- [ ] Search and filtering
- [ ] Notifications
- [4] Admin tools
- [ ] Other:

## 12. Prototype implementation notes: cybersecurity and architecture

The first working prototype should keep a clear separation between:

- Data layer: user lists, ticket seed data, constants, and mock persistence configuration.
- Presentation layer: HTML structure and page sections rendered to the browser.
- Logic layer: state handling, permission checks, input validation, ticket actions, and UI event wiring.

Cybersecurity minimums for this project:

- Use strict input validation on all text fields and reject oversized payloads before saving.
- Escape all user-controlled values before injecting them into HTML to reduce DOM XSS risk.
- Keep role-based access checks in the logic layer instead of trusting the browser alone.
- Use HTTPS in production, never allow plain HTTP, and enforce secure cookies/session settings on the backend.
- Avoid exposing sensitive user data in client-side code; only include the minimum required fields.
- Store passwords only as salted hashes using a strong password hashing algorithm in the server side.
- Apply least-privilege rules for ticket access, assignment, and status changes.
- Log all ticket creation, edits, assignment, and status transitions for auditability.
- Validate file uploads (type, size, malware scanning, and allowed extensions) before storing them.
- Enforce rate limiting, CSRF protection, and secure session management for all authenticated actions.
- Prefer server-side authorization for final enforcement; browser-side checks are only a UX aid.

The current demo uses a same-origin Node.js API and MySQL. The API issues opaque random session tokens as HttpOnly cookies, stores only token hashes, resolves the associated user on each request, and enforces ticket/group permissions server-side. Demo credentials and seed data are for local development only; production requires HTTPS, non-demo credentials, and appropriately restricted database access.

Users in the Human Resources group and users with the Administrator role may manage user profiles. Password changes and group management are Administrator-only; HR authorization is determined by group membership, not by trusting the profile's department label.

Departments are separate records from ticket groups and are managed from their own tab by Human Resources group members and Administrators. User profiles reference a department record; ticket queue visibility and assignment continue to use ticket-group membership.

Each membership has a `Member` or `Team Leader` role in `group_roles`. Administrator and Ticket Manager remain global account roles. Team Leaders can manage group tickets; group statistics are planned but not implemented.