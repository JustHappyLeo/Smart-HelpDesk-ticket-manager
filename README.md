# Smart HelpDesk

## One-click Windows startup

Install dependencies once with `npm install`, then put the database settings in the git-ignored `Password` file. Double-click `Start-HelpDesk.cmd` to start MySQL if needed, verify the database connection, start the web app, and open `http://localhost:3000`. Keep the database password in `Password`, not in this README. The launcher assumes the MySQL Windows service is named `MySQL80`.

The browser app is served by the Node.js API. The API resolves the user's identity from an opaque session token in an HttpOnly cookie and enforces ticket and group permissions in MySQL-backed requests.

The primary navigation provides a dashboard with assigned-ticket counts and a compact calendar, a calendar of visible ticket deadlines, comments, and logged work activities, searchable/filterable ticket previews (click to open full-screen details), a user directory, and account settings. All signed-in users can browse active user profiles, including email, department, and optional phone number. Users with user-management permission also see controls to add, clone, edit, disable, and remove accounts. The monthly calendar shows due-ticket and work-activity counts. Selecting a day shows its events separately from a compact activity list and a 24-hour daily schedule. Each scheduled activity is sized to its start and end time; drag an activity to change its time or date and drag either edge to adjust its duration. Schedule changes are saved to MySQL. Settings includes self-service password changes; additional preferences are planned for a future update.

## Local setup

Requirements: Node.js 20+, MySQL 8+.

1. Create a MySQL database and a dedicated database user with access to it.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Set database connection variables in PowerShell:

   ```powershell
   $env:DB_HOST = "127.0.0.1"
   $env:DB_PORT = "3306"
   $env:DB_NAME = "smart_helpdesk"
   $env:DB_USER = "helpdesk_app"
   $env:DB_PASSWORD = "<keep this secret in the ignored Password file>"
   ```

4. Create the schema and demo records, then start the API:

   ```powershell
   npm run seed
   npm start
   ```

5. Open `http://localhost:3000`.

Demo accounts seeded by `npm run seed` use the password `demo123`:

- `employee@company.com`
- `agent@company.com`
- `manager@company.com`
- `admin@company.com`
- `bryan.cranston@company.com` \ `bryan.cranston@company.com`

Do not use the demo accounts or demo password in a deployed environment. Seeded passwords are stored as bcrypt hashes; no password is returned to the browser.

## Session and authorization behavior

- Successful sign-in creates a cryptographically random 256-bit session token. Only its SHA-256 hash is stored in the `sessions` table.
- The raw token is returned only as an `HttpOnly`, `SameSite=Strict` cookie with an eight-hour lifetime. Production mode also marks the cookie `Secure`.
- Each protected API request resolves the token to its user in MySQL. Client-side UI visibility is not used as authorization.
- Administrator and Ticket Manager queue queries return tickets across groups. Other queue queries join `group_roles`, returning only tickets belonging to the user's groups.
- Each group membership has its own `Member` or `Team Leader` role in `group_roles`. Members can assign tickets to themselves and request that another group member take a ticket; the target must approve before the assignment changes. Team Leaders can update ticket status and assign or unassign tickets for anyone in their group. Administrator and Ticket Manager privileges remain global.
- Ticket detail, status updates, assignment requests, comments, and group-management routes perform their own server-side access checks.
- The calendar and dashboard use only tickets visible to the authenticated user. Calendar items include ticket creation dates, due dates, and comment activity.
- Signed-in users can browse active user profiles in Users. User-management controls are shown only to users with user-management permission (HR group members and Administrators).
- User management provides a selectable user list, clone/add flows, read-only profiles that must be explicitly switched to edit, reversible account disabling, and soft removal that preserves history. Profiles include the latest 10 tickets opened by that user that the current manager is allowed to view.
- Users can change their own password from Settings after confirming the current password. Phone numbers are optional and are available on directory profiles.
- Ticket detail views show requester, assignee, and group under the title; due date is displayed with status and priority. Staff can change status from its badge, log work in minutes, and see the total time logged. Requesters do not receive work-log data. The Comments & Notes tab distinguishes public comments from internal notes, Activities lists staff work logs, and History combines ticket events, visible messages, and staff activities. Creation, status, assignment, and comment events are recorded in `ticket_events`; the seed migration adds a creation entry for existing tickets.
- Members of the `Human Resources` group and users with the `Administrator` role can manage user profiles. Only Administrators can set passwords or assign the Administrator and Ticket Manager roles; group management stays Administrator-only.
- Departments are maintained separately from ticket groups. HR group members and Administrators can create, rename, and delete departments from the Departments tab; user profiles select from this department list.
- New user profiles created by HR have a random, undisclosed password hash until an Administrator sets an initial password from the Users tab. Removing an account deactivates it and revokes sessions while retaining ticket/comment history.
- The seed script migrates legacy `user_groups` memberships into `group_roles`; previous Support accounts become Employee accounts and their existing group memberships become Team Leaders.
- Set `NODE_ENV=production` only behind HTTPS so session cookies are marked `Secure`.
