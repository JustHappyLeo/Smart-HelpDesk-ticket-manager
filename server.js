const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const sessionCookieName = 'helpdesk_session';
const secureCookies = process.env.NODE_ENV === 'production';
const databaseUser = process.env.DB_USER;
const databasePassword = process.env.DB_PASSWORD;
const databaseName = process.env.DB_NAME;

if (!databaseUser || !databasePassword || !databaseName) {
  throw new Error('Set DB_USER, DB_PASSWORD, and DB_NAME before starting the server.');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: databaseUser,
  password: databasePassword,
  database: databaseName,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

const statuses = ['New', 'Open', 'Scheduled', 'In Progress', 'Waiting for feedback', 'Resolved', 'Closed'];
const priorities = ['Low', 'Normal', 'High', 'Critical'];
const loginAttempts = new Map();
const dummyPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb', strict: true }));

// Validate browser mutation origins and require JSON for API writes.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();

  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Cross-origin request rejected.' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
  }

  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Requests must use application/json.' });
  }
  next();
});

// Convert rejected async route handlers into Express errors.
function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Save an auditable ticket event without storing message bodies in the activity log.
async function recordTicketEvent(ticketId, actorId, eventType, details) {
  await pool.execute(
    'INSERT INTO ticket_events (ticket_id, actor_id, event_type, details) VALUES (?, ?, ?, ?)',
    [ticketId, actorId, eventType, details]
  );
}

// Parse a named cookie without accepting malformed URL-encoded values.
function readCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.find(item => item.trim().startsWith(`${name}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.trim().slice(name.length + 1));
  } catch {
    return null;
  }
}

// Set or clear the opaque, HttpOnly session cookie.
function setSessionCookie(res, token, maxAge) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  if (secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Hash a session token before storing or looking it up in MySQL.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Return only non-secret account fields to the browser.
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    surname: user.surname,
    email: user.email,
    phone: user.phone || '',
    department: user.department || null,
    departmentId: user.departmentId ?? null,
    role: user.role,
    canManageUsers: Boolean(user.canManageUsers)
  };
}

// Require a valid, unexpired session and attach its user to the request.
const authenticate = route(async (req, res, next) => {
  const token = readCookie(req, sessionCookieName);
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.surname, u.email, u.phone, u.department_id AS departmentId, d.name AS department, u.role,
       (u.role = 'Administrator' OR EXISTS (
         SELECT 1 FROM group_roles gr
         JOIN ticket_groups g ON g.id = gr.group_id
         WHERE gr.user_id = u.id AND g.name = 'Human Resources'
       )) AS canManageUsers
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
       AND u.is_active = TRUE AND u.is_removed = FALSE`,
    [hashToken(token)]
  );
  if (!rows.length) {
    setSessionCookie(res, '', 0);
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  req.user = rows[0];
  next();
});

// Restrict an API route to administrator accounts.
function requireAdministrator(req, res, next) {
  if (req.user.role !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

// Permit user management to administrators and current Human Resources members.
const requireUserManager = route(async (req, res, next) => {
  if (req.user.role === 'Administrator') return next();
  const [rows] = await pool.execute(
    `SELECT 1 FROM group_roles gr
    JOIN ticket_groups g ON g.id = gr.group_id
    WHERE gr.user_id = ? AND g.name = 'Human Resources'`,
    [req.user.id]
  );
  if (!rows.length) return res.status(403).json({ error: 'Human Resources group membership or Administrator role required.' });
  next();
});

// Record failed sign-in attempts by IP and limit repeated guesses.
function isLoginRateLimited(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
    loginAttempts.set(ip, { startedAt: now, count: 0 });
    return false;
  }
  return attempt.count >= 10;
}

// Query ticket rows authorized for the caller's requested list view.
async function listTicketsForUser(user, view) {
  const select = `SELECT t.id, t.subject, t.description, t.requester_id AS requesterId,
      t.assignee_id AS assigneeId, t.group_id AS groupId, g.name AS department,
      t.status, t.priority, t.created_at AS createdAt, t.due_date AS dueDate,
      t.tags, requester.name AS requesterName, requester.surname AS requesterSurname,
      assignee.name AS assigneeName, assignee.surname AS assigneeSurname
    FROM tickets t
    LEFT JOIN ticket_groups g ON g.id = t.group_id
    JOIN users requester ON requester.id = t.requester_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id`;

  if (view === 'mine') {
    const [rows] = await pool.execute(
      `${select} WHERE t.requester_id = ? OR t.assignee_id = ? ORDER BY t.created_at DESC`,
      [user.id, user.id]
    );
    return rows;
  }

  if (user.role === 'Administrator' || user.role === 'Ticket Manager') {
    const [rows] = await pool.execute(`${select} ORDER BY t.created_at DESC`);
    return rows;
  }

  const [rows] = await pool.execute(
    `${select}
     JOIN group_roles gr ON gr.group_id = t.group_id AND gr.user_id = ?
     ORDER BY t.created_at DESC`,
    [user.id]
  );
  return rows;
}

// Check whether a ticket is visible to a user before returning or changing it.
async function findAccessibleTicket(ticketId, user) {
  const [rows] = await pool.execute(
    `SELECT t.id, t.subject, t.description, t.requester_id AS requesterId,
       t.assignee_id AS assigneeId, t.group_id AS groupId, g.name AS department,
       t.status, t.priority, t.created_at AS createdAt, t.due_date AS dueDate,
       t.tags, requester.name AS requesterName, requester.surname AS requesterSurname,
       assignee.name AS assigneeName, assignee.surname AS assigneeSurname
     FROM tickets t
     LEFT JOIN ticket_groups g ON g.id = t.group_id
     JOIN users requester ON requester.id = t.requester_id
     LEFT JOIN users assignee ON assignee.id = t.assignee_id
     WHERE t.id = ?
       AND (
         ? IN ('Administrator', 'Ticket Manager')
         OR t.requester_id = ?
         OR t.assignee_id = ?
         OR EXISTS (
           SELECT 1 FROM group_roles gr
           WHERE gr.user_id = ? AND gr.group_id = t.group_id
         )
       )`,
    [ticketId, user.role, user.id, user.id, user.id]
  );
  return rows[0] || null;
}

// Identify ticket viewers who are support staff rather than requesters.
async function canUseAgentTicketTools(ticket, user) {
  if (user.role === 'Administrator' || user.role === 'Ticket Manager' || ticket.assigneeId === user.id) {
    return true;
  }
  return ticket.groupId !== null && userBelongsToGroup(user.id, ticket.groupId);
}

// Match the ticket status controls to the roles accepted by the status route.
async function canChangeTicketStatus(ticket, user) {
  if (user.role === 'Administrator' || user.role === 'Ticket Manager' || ticket.assigneeId === user.id) {
    return true;
  }
  return ticket.groupId !== null
    && await getUserGroupRole(user.id, ticket.groupId) === 'Team Leader';
}

// Return a simplified ticket object without exposing internal database names.
function toTicket(row) {
  let tags = row.tags;
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    requesterId: row.requesterId,
    requesterName: row.requesterName,
    requesterSurname: row.requesterSurname,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName || 'Unassigned',
    assigneeSurname: row.assigneeSurname || '',
    groupId: row.groupId,
    department: row.department || 'Unassigned',
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    dueDate: row.dueDate,
    tags: Array.isArray(tags) ? tags : []
  };
}

// Serve only the intended browser assets; API internals and SQL remain private.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));

// Verify credentials, create a random server-tracked token, and issue its cookie.
app.post('/api/auth/login', route(async (req, res) => {
  const ip = req.ip;
  if (isLoginRateLimited(ip)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });

  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.surname, u.email, u.phone, u.password_hash, u.department_id AS departmentId, d.name AS department, u.role,
       (u.role = 'Administrator' OR EXISTS (
         SELECT 1 FROM group_roles gr
         JOIN ticket_groups g ON g.id = gr.group_id
         WHERE gr.user_id = u.id AND g.name = 'Human Resources'
       )) AS canManageUsers
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.email = ? AND u.is_active = TRUE AND u.is_removed = FALSE`,
    [email]
  );
  const validPassword = await bcrypt.compare(password, rows[0]?.password_hash || dummyPasswordHash);
  if (!validPassword) {
    const attempt = loginAttempts.get(ip);
    if (attempt) attempt.count += 1;
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  loginAttempts.delete(ip);
  const user = rows[0];
  const existingToken = readCookie(req, sessionCookieName);
  if (existingToken) {
    await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(existingToken)]);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))`,
    [hashToken(token), user.id]
  );
  setSessionCookie(res, token, Math.floor(sessionLifetimeMs / 1000));
  res.json({ user: publicUser(user) });
}));

// Revoke the current session token and clear the browser cookie.
app.post('/api/auth/logout', authenticate, route(async (req, res) => {
  const token = readCookie(req, sessionCookieName);
  await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  setSessionCookie(res, '', 0);
  res.json({ success: true });
}));

// Return the user identity resolved from the current cookie token.
app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Change the signed-in user's password after verifying their current password.
app.patch('/api/auth/password', authenticate, route(async (req, res) => {
  const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 12 || newPassword.length > 200) {
    return res.status(400).json({ error: 'Use a password between 12 and 200 characters.' });
  }
  const [rows] = await pool.execute('SELECT password_hash AS passwordHash FROM users WHERE id = ?', [req.user.id]);
  if (!rows.length || !await bcrypt.compare(currentPassword, rows[0].passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const token = readCookie(req, sessionCookieName);
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);
  await pool.execute(
    'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?',
    [req.user.id, hashToken(token)]
  );
  res.json({ success: true });
}));

// Return queue or personal tickets using server-side group and identity filters.
app.get('/api/tickets', authenticate, route(async (req, res) => {
  const view = req.query.view === 'mine' ? 'mine' : 'queue';
  const rows = await listTicketsForUser(req.user, view);
  res.json({ tickets: rows.map(toTicket) });
}));

// Return all tickets visible to the current user for dashboard and calendar views.
app.get('/api/calendar', authenticate, route(async (req, res) => {
  const [queueRows, personalRows] = await Promise.all([
    listTicketsForUser(req.user, 'queue'),
    listTicketsForUser(req.user, 'mine')
  ]);
  const tickets = new Map();
  for (const row of [...queueRows, ...personalRows]) tickets.set(row.id, toTicket(row));
  const ticketIds = [...tickets.keys()];
  let activities = [];
  let workActivities = [];
  if (ticketIds.length) {
    const placeholders = ticketIds.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT c.id, c.ticket_id AS ticketId, c.created_at AS date,
         CONCAT(u.name, ' ', u.surname) AS title, 'comment' AS type
       FROM comments c JOIN users u ON u.id = c.author_id
       JOIN tickets t ON t.id = c.ticket_id
       WHERE c.ticket_id IN (${placeholders})
         AND (
           c.type = 'public'
           OR ? IN ('Administrator', 'Ticket Manager')
           OR EXISTS (
             SELECT 1 FROM group_roles gr
             WHERE gr.user_id = ? AND gr.group_id = t.group_id
           )
         )
       ORDER BY c.created_at`,
      [...ticketIds, req.user.role, req.user.id]
    );
    activities = rows;

    const [workRows] = await pool.execute(
      `SELECT a.id, a.ticket_id AS ticketId, a.operator_id AS operatorId,
        a.time_used_minutes AS timeUsedMinutes, a.activity_date AS activityDate,
        a.start_minute AS startMinute, a.description,
        CONCAT(u.name, ' ', u.surname) AS operator
      FROM ticket_activities a
      JOIN tickets t ON t.id = a.ticket_id
      JOIN users u ON u.id = a.operator_id
      WHERE a.ticket_id IN (${placeholders})
        AND (
          ? IN ('Administrator', 'Ticket Manager')
          OR t.assignee_id = ?
          OR EXISTS (
            SELECT 1 FROM group_roles gr
            WHERE gr.user_id = ? AND gr.group_id = t.group_id
          )
        )
      ORDER BY a.activity_date, a.start_minute, a.id`,
      [...ticketIds, req.user.role, req.user.id, req.user.id]
    );
    workActivities = workRows;
  }
  res.json({ tickets: [...tickets.values()], activities, workActivities });
}));

// Provide a limited active-user directory to authenticated users.
app.get('/api/directory', authenticate, route(async (req, res) => {
  const [users] = await pool.execute(
    `SELECT u.id, u.name, u.surname, u.email, u.phone, d.name AS department
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = TRUE ORDER BY u.name, u.surname`
  );
  res.json({ users });
}));

// Return ticket details and comments only after checking ticket visibility.
app.get('/api/tickets/:id', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const agentView = await canUseAgentTicketTools(ticket, req.user);

  const [comments] = await pool.execute(
    `SELECT c.id, c.ticket_id AS ticketId, c.author_id AS authorId,
       CONCAT(u.name, ' ', u.surname) AS author, c.text, c.type, c.created_at AS createdAt
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.ticket_id = ?
       AND (c.type = 'public' OR ? = TRUE)
     ORDER BY c.created_at`,
    [ticket.id, agentView]
  );
  const [events] = await pool.execute(
    `SELECT e.id, e.event_type AS eventType, e.details, e.created_at AS createdAt,
       CONCAT(u.name, ' ', u.surname) AS actor
     FROM ticket_events e JOIN users u ON u.id = e.actor_id
     WHERE e.ticket_id = ?
       AND (
         e.event_type <> 'comment'
         OR e.details <> 'Added an internal note'
         OR ? = TRUE
       )
     ORDER BY e.created_at DESC, e.id DESC`,
    [ticket.id, agentView]
  );
  const canChangeStatus = await canChangeTicketStatus(ticket, req.user);
  const canClose = ticket.requesterId === req.user.id && ticket.status !== 'Closed';
  let activities = [];
  if (agentView) {
    const [rows] = await pool.execute(
      `SELECT a.id, a.operator_id AS operatorId, a.time_used_minutes AS timeUsedMinutes,
         a.activity_date AS activityDate, a.description,
         CONCAT(u.name, ' ', u.surname) AS operator
       FROM ticket_activities a JOIN users u ON u.id = a.operator_id
       WHERE a.ticket_id = ?
       ORDER BY a.activity_date DESC, a.id DESC`,
      [ticket.id]
    );
    activities = rows;
  }
  res.json({
    ticket: { ...toTicket(ticket), agentView, canChangeStatus, canClose },
    comments,
    events,
    activities
  });
}));

// Create a ticket for the authenticated requester and an existing group.
app.post('/api/tickets', authenticate, route(async (req, res) => {
  const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const groupId = Number(req.body.groupId);
  const priority = req.body.priority;
  if (!subject || subject.length > 120 || !description || description.length > 2000
      || !Number.isSafeInteger(groupId) || !priorities.includes(priority)) {
    return res.status(400).json({ error: 'Provide a subject, description, valid group, and priority.' });
  }

  const [groupRows] = await pool.execute('SELECT id FROM ticket_groups WHERE id = ?', [groupId]);
  if (!groupRows.length) return res.status(400).json({ error: 'Ticket group does not exist.' });

  const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const [result] = await pool.execute(
    `INSERT INTO tickets (subject, description, requester_id, group_id, status, priority, due_date, tags)
     VALUES (?, ?, ?, ?, 'New', ?, ?, JSON_ARRAY('new'))`,
    [subject, description, req.user.id, groupId, priority, dueDate]
  );
  await recordTicketEvent(result.insertId, req.user.id, 'created', 'Ticket created');
  res.status(201).json({ id: result.insertId });
}));

// Change status only for authorized group workers or a requester closing a ticket.
app.patch('/api/tickets/:id/status', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const status = req.body.status;
  if (!statuses.includes(status)) return res.status(400).json({ error: 'Invalid ticket status.' });

  const isPrivileged = req.user.role === 'Administrator' || req.user.role === 'Ticket Manager';
  const groupRole = ticket.groupId === null ? null : await getUserGroupRole(req.user.id, ticket.groupId);
  const isTeamLeader = groupRole === 'Team Leader';
  const isAssignee = ticket.assigneeId === req.user.id;
  const isRequesterClosing = ticket.requesterId === req.user.id && status === 'Closed';
  if (!isPrivileged && !isTeamLeader && !isAssignee && !isRequesterClosing) {
    return res.status(403).json({ error: 'You cannot change this ticket status.' });
  }

  if (ticket.status !== status) {
    await pool.execute('UPDATE tickets SET status = ? WHERE id = ?', [status, ticket.id]);
    await recordTicketEvent(ticket.id, req.user.id, 'status', `Status changed from ${ticket.status} to ${status}`);
  }
  res.json({ success: true });
}));

// Record support work against a visible ticket; requesters cannot view or add work logs.
app.post('/api/tickets/:id/activities', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (!await canUseAgentTicketTools(ticket, req.user)) {
    return res.status(403).json({ error: 'Only support staff can record ticket activities.' });
  }

  const timeUsedMinutes = Number(req.body.timeUsedMinutes);
  const activityDate = typeof req.body.activityDate === 'string' ? req.body.activityDate : '';
  const startMinute = req.body.startMinute === undefined ? 540 : Number(req.body.startMinute);
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(activityDate);
  const validDate = dateParts
    && Number(dateParts[1]) >= 1000
    && Number(dateParts[2]) >= 1 && Number(dateParts[2]) <= 12
    && Number(dateParts[3]) >= 1
    && Number(dateParts[3]) <= new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]), 0)).getUTCDate();
  if (!Number.isSafeInteger(timeUsedMinutes) || timeUsedMinutes < 1 || timeUsedMinutes > 1440
      || !Number.isSafeInteger(startMinute) || startMinute < 0 || startMinute + timeUsedMinutes > 1440
      || !validDate || !description || description.length > 1000) {
    return res.status(400).json({
      error: 'Provide a valid date and start time, a description of up to 1000 characters, and a duration that fits within the day.'
    });
  }

  const [result] = await pool.execute(
    `INSERT INTO ticket_activities
       (ticket_id, operator_id, time_used_minutes, activity_date, start_minute, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ticket.id, req.user.id, timeUsedMinutes, activityDate, startMinute, description]
  );
  res.status(201).json({ id: result.insertId });
}));

// Reschedule support work while keeping its ticket visibility and staff permissions.
app.patch('/api/activities/:id', authenticate, route(async (req, res) => {
  const activityId = Number(req.params.id);
  const timeUsedMinutes = Number(req.body.timeUsedMinutes);
  const startMinute = Number(req.body.startMinute);
  const activityDate = typeof req.body.activityDate === 'string' ? req.body.activityDate : '';
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(activityDate);
  const validDate = dateParts
    && Number(dateParts[1]) >= 1000
    && Number(dateParts[2]) >= 1 && Number(dateParts[2]) <= 12
    && Number(dateParts[3]) >= 1
    && Number(dateParts[3]) <= new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]), 0)).getUTCDate();
  if (!Number.isSafeInteger(activityId) || activityId <= 0
      || !Number.isSafeInteger(timeUsedMinutes) || timeUsedMinutes < 1 || timeUsedMinutes > 1440
      || !Number.isSafeInteger(startMinute) || startMinute < 0 || startMinute + timeUsedMinutes > 1440
      || !validDate) {
    return res.status(400).json({ error: 'Provide a valid activity ID, date, start time, and duration within the day.' });
  }

  const [rows] = await pool.execute('SELECT ticket_id AS ticketId FROM ticket_activities WHERE id = ?', [activityId]);
  if (!rows.length) return res.status(404).json({ error: 'Activity not found.' });
  const ticket = await findAccessibleTicket(rows[0].ticketId, req.user);
  if (!ticket) return res.status(404).json({ error: 'Activity not found.' });
  if (!await canUseAgentTicketTools(ticket, req.user)) {
    return res.status(403).json({ error: 'Only support staff can reschedule ticket activities.' });
  }
  await pool.execute(
    `UPDATE ticket_activities
     SET activity_date = ?, start_minute = ?, time_used_minutes = ?
     WHERE id = ? AND ticket_id = ?`,
    [activityDate, startMinute, timeUsedMinutes, activityId, ticket.id]
  );
  res.json({ success: true });
}));

// Check whether a user belongs to a specific group.
async function userBelongsToGroup(userId, groupId) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM group_roles gr JOIN users u ON u.id = gr.user_id
     WHERE gr.user_id = ? AND gr.group_id = ? AND u.is_active = TRUE`,
    [userId, groupId]
  );
  return rows.length > 0;
}

// Return the user's authorization role for one group, or null if they are not a member.
async function getUserGroupRole(userId, groupId) {
  const [rows] = await pool.execute(
    `SELECT gr.role FROM group_roles gr JOIN users u ON u.id = gr.user_id
     WHERE gr.user_id = ? AND gr.group_id = ? AND u.is_active = TRUE`,
    [userId, groupId]
  );
  return rows[0]?.role || null;
}

// Assign to self, or let group leaders and global ticket managers assign group members.
app.patch('/api/tickets/:id/assignee', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const privileged = req.user.role === 'Administrator' || req.user.role === 'Ticket Manager';
  const groupRole = ticket.groupId === null ? null : await getUserGroupRole(req.user.id, ticket.groupId);
  const canManageGroup = groupRole === 'Team Leader';

  const assigneeId = req.body.assigneeId === null ? null : Number(req.body.assigneeId);
  if (!privileged && !canManageGroup && !groupRole) {
    return res.status(403).json({ error: 'You cannot assign this ticket.' });
  }
  if (!privileged && !canManageGroup && assigneeId !== req.user.id) {
    return res.status(403).json({ error: 'Members may only assign tickets to themselves or request another member’s approval.' });
  }
  if (assigneeId === null && !privileged && !canManageGroup) {
    return res.status(403).json({ error: 'Only a Team Leader or global ticket manager can unassign a ticket.' });
  }
  if (assigneeId !== null) {
    if (!Number.isSafeInteger(assigneeId) || ticket.groupId === null
        || !await userBelongsToGroup(assigneeId, ticket.groupId)) {
      return res.status(400).json({ error: 'Assignee must be a member of the ticket group.' });
    }
  }
  if (ticket.assigneeId !== assigneeId) {
    let detail = 'Ticket unassigned';
    if (assigneeId !== null) {
      const [assigneeRows] = await pool.execute(
        'SELECT CONCAT(name, " ", surname) AS name FROM users WHERE id = ? AND is_active = TRUE',
        [assigneeId]
      );
      detail = `Assigned to ${assigneeRows[0].name}`;
    }
    await pool.execute('UPDATE tickets SET assignee_id = ? WHERE id = ?', [assigneeId, ticket.id]);
    await recordTicketEvent(ticket.id, req.user.id, 'assignment', detail);
  }
  await pool.execute(
    "UPDATE ticket_assignment_requests SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP() WHERE ticket_id = ? AND status = 'Pending'",
    [ticket.id]
  );
  res.json({ success: true });
}));

// Let a group member request that another member accept ownership of a ticket.
app.post('/api/tickets/:id/assignment-requests', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const targetUserId = Number(req.body.targetUserId);
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0 || targetUserId === req.user.id
      || ticket.groupId === null || !await userBelongsToGroup(req.user.id, ticket.groupId)
      || !await userBelongsToGroup(targetUserId, ticket.groupId)) {
    return res.status(400).json({ error: 'Choose another active member of the ticket group.' });
  }

  const [pending] = await pool.execute(
    `SELECT id FROM ticket_assignment_requests
     WHERE ticket_id = ? AND target_user_id = ? AND status = 'Pending'`,
    [ticket.id, targetUserId]
  );
  if (pending.length) return res.status(409).json({ error: 'An assignment request to this user is already pending.' });
  const [result] = await pool.execute(
    `INSERT INTO ticket_assignment_requests (ticket_id, requested_by, target_user_id)
     VALUES (?, ?, ?)`,
    [ticket.id, req.user.id, targetUserId]
  );
  res.status(201).json({ id: result.insertId });
}));

// List assignment requests involving the current user.
app.get('/api/assignment-requests', authenticate, route(async (req, res) => {
  const [requests] = await pool.execute(
    `SELECT ar.id, ar.ticket_id AS ticketId, t.subject, ar.requested_by AS requestedBy,
       CONCAT(requester.name, ' ', requester.surname) AS requesterName,
       ar.target_user_id AS targetUserId, CONCAT(target.name, ' ', target.surname) AS targetName,
       ar.status, ar.created_at AS createdAt
     FROM ticket_assignment_requests ar
     JOIN tickets t ON t.id = ar.ticket_id
     JOIN users requester ON requester.id = ar.requested_by
     JOIN users target ON target.id = ar.target_user_id
     WHERE ar.requested_by = ? OR ar.target_user_id = ?
     ORDER BY ar.created_at DESC`,
    [req.user.id, req.user.id]
  );
  res.json({ requests });
}));

// Only the requested assignee can accept or decline a pending assignment request.
app.patch('/api/assignment-requests/:id', authenticate, route(async (req, res) => {
  const requestId = Number(req.params.id);
  const decision = req.body.decision;
  if (!Number.isSafeInteger(requestId) || requestId <= 0 || !['Accepted', 'Declined'].includes(decision)) {
    return res.status(400).json({ error: 'Provide a valid request ID and decision.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT ar.id, ar.ticket_id AS ticketId, ar.target_user_id AS targetUserId,
         t.group_id AS groupId
       FROM ticket_assignment_requests ar
       JOIN tickets t ON t.id = ar.ticket_id
       WHERE ar.id = ? AND ar.status = 'Pending'
       FOR UPDATE`,
      [requestId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Pending assignment request not found.' });
    }
    const request = rows[0];
    if (request.targetUserId !== req.user.id) {
      await connection.rollback();
      return res.status(403).json({ error: 'Only the requested assignee can approve or decline this request.' });
    }

    if (decision === 'Accepted') {
      const [membership] = await connection.execute(
        `SELECT 1 FROM group_roles gr JOIN users u ON u.id = gr.user_id
         WHERE gr.user_id = ? AND gr.group_id = ? AND u.is_active = TRUE`,
        [req.user.id, request.groupId]
      );
      if (!request.groupId || !membership.length) {
        await connection.rollback();
        return res.status(409).json({ error: 'You are no longer an active member of the ticket group.' });
      }
      await connection.execute('UPDATE tickets SET assignee_id = ? WHERE id = ?', [req.user.id, request.ticketId]);
      await connection.execute(
        `INSERT INTO ticket_events (ticket_id, actor_id, event_type, details)
         VALUES (?, ?, 'assignment', 'Accepted an assignment request')`,
        [request.ticketId, req.user.id]
      );
      await connection.execute(
        `UPDATE ticket_assignment_requests SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP()
         WHERE ticket_id = ? AND status = 'Pending' AND id <> ?`,
        [request.ticketId, requestId]
      );
    }
    await connection.execute(
      'UPDATE ticket_assignment_requests SET status = ?, resolved_at = UTC_TIMESTAMP() WHERE id = ?',
      [decision, requestId]
    );
    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Add a public or internal comment after checking the caller can view the ticket.
app.post('/api/tickets/:id/comments', authenticate, route(async (req, res) => {
  const ticket = await findAccessibleTicket(req.params.id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 1000) return res.status(400).json({ error: 'Reply must contain 1 to 1000 characters.' });
  const type = req.body.type === 'internal' ? 'internal' : req.body.type === 'public' ? 'public' : null;
  if (!type) return res.status(400).json({ error: 'Choose whether this is a public comment or an internal note.' });
  if (type === 'internal' && !await canUseAgentTicketTools(ticket, req.user)) {
    return res.status(403).json({ error: 'Only support staff can add internal notes.' });
  }
  await pool.execute(
    'INSERT INTO comments (ticket_id, author_id, text, type) VALUES (?, ?, ?, ?)',
    [ticket.id, req.user.id, text, type]
  );
  await recordTicketEvent(
    ticket.id,
    req.user.id,
    'comment',
    type === 'internal' ? 'Added an internal note' : 'Added a public comment'
  );
  res.status(201).json({ success: true });
}));

// List group names needed by authenticated users to submit a ticket.
app.get('/api/groups', authenticate, route(async (req, res) => {
  const [groups] = await pool.execute('SELECT id, name FROM ticket_groups ORDER BY name');
  res.json({ groups });
}));

// Return group members only to administrators or members of that group.
app.get('/api/groups/:id/members', authenticate, route(async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId)) return res.status(400).json({ error: 'Invalid group ID.' });
  const isPrivileged = req.user.role === 'Administrator' || req.user.role === 'Ticket Manager';
  if (!isPrivileged && !await userBelongsToGroup(req.user.id, groupId)) {
    return res.status(403).json({ error: 'You cannot view this group membership.' });
  }
  const [members] = await pool.execute(
    `SELECT u.id, u.name, u.surname, gr.role AS groupRole
     FROM users u JOIN group_roles gr ON gr.user_id = u.id
     WHERE gr.group_id = ? AND u.is_active = TRUE ORDER BY u.name, u.surname`,
    [groupId]
  );
  res.json({ members });
}));

// List departments for users authorized to manage them.
app.get('/api/departments', authenticate, requireUserManager, route(async (req, res) => {
  const [departments] = await pool.execute('SELECT id, name FROM departments ORDER BY name');
  res.json({ departments });
}));

// Validate department names consistently across create and update routes.
function validateDepartmentName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 80 ? name : null;
}

// Create a department independently from ticket groups.
app.post('/api/departments', authenticate, requireUserManager, route(async (req, res) => {
  const name = validateDepartmentName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Department name must contain 1 to 80 characters.' });
  const [result] = await pool.execute('INSERT INTO departments (name) VALUES (?)', [name]);
  res.status(201).json({ id: result.insertId, name });
}));

// Rename a department without changing any group names.
app.patch('/api/departments/:id', authenticate, requireUserManager, route(async (req, res) => {
  const departmentId = Number(req.params.id);
  const name = validateDepartmentName(req.body?.name);
  if (!Number.isSafeInteger(departmentId) || departmentId <= 0 || !name) {
    return res.status(400).json({ error: 'Provide a valid department ID and name.' });
  }
  const [result] = await pool.execute('UPDATE departments SET name = ? WHERE id = ?', [name, departmentId]);
  if (!result.affectedRows) {
    const [existing] = await pool.execute('SELECT id FROM departments WHERE id = ?', [departmentId]);
    if (!existing.length) return res.status(404).json({ error: 'Department not found.' });
  }
  res.json({ success: true });
}));

// Delete a department independently; users referencing it become unassigned.
app.delete('/api/departments/:id', authenticate, requireUserManager, route(async (req, res) => {
  const departmentId = Number(req.params.id);
  if (!Number.isSafeInteger(departmentId) || departmentId <= 0) {
    return res.status(400).json({ error: 'Invalid department ID.' });
  }
  const [result] = await pool.execute('DELETE FROM departments WHERE id = ?', [departmentId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Department not found.' });
  res.json({ success: true });
}));

// List active user accounts and their group memberships for authorized managers.
app.get('/api/users', authenticate, requireUserManager, route(async (req, res) => {
  const includeDisabled = req.query.includeDisabled === 'true';
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.surname, u.email, u.phone, u.department_id AS departmentId, d.name AS department,
       u.role, u.is_active AS isActive, u.is_removed AS isRemoved,
       g.id AS groupId, g.name AS groupName, gr.role AS groupRole
     FROM users u LEFT JOIN group_roles gr ON gr.user_id = u.id
     LEFT JOIN ticket_groups g ON g.id = gr.group_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_removed = FALSE AND (u.is_active = TRUE OR ? = TRUE)
     ORDER BY u.id, g.name`,
    [includeDisabled]
  );
  const users = new Map();
  for (const row of rows) {
    if (!users.has(row.id)) {
      users.set(row.id, {
        ...publicUser(row),
        isActive: Boolean(row.isActive),
        isRemoved: Boolean(row.isRemoved),
        groups: []
      });
    }
    if (row.groupId !== null) {
      users.get(row.id).groups.push({ id: row.groupId, name: row.groupName, role: row.groupRole });
    }
  }
  res.json({ users: [...users.values()] });
}));

// List the latest tickets requested by a user that the manager can also view.
app.get('/api/users/:id/tickets', authenticate, requireUserManager, route(async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID.' });
  }
  const [tickets] = await pool.execute(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at AS createdAt,
       t.due_date AS dueDate, g.name AS groupName,
       CONCAT(assignee.name, ' ', assignee.surname) AS assignee
     FROM tickets t
     LEFT JOIN ticket_groups g ON g.id = t.group_id
     LEFT JOIN users assignee ON assignee.id = t.assignee_id
     WHERE t.requester_id = ?
       AND (
         ? IN ('Administrator', 'Ticket Manager')
         OR t.requester_id = ?
         OR t.assignee_id = ?
         OR EXISTS (
           SELECT 1 FROM group_roles gr
           WHERE gr.user_id = ? AND gr.group_id = t.group_id
         )
       )
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT 10`,
    [userId, req.user.role, req.user.id, req.user.id, req.user.id]
  );
  res.json({ tickets });
}));

// Validate the editable profile fields shared by user creation and updates.
function validateUserProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const surname = typeof body.surname === 'string' ? body.surname.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const departmentId = body.departmentId === null || body.departmentId === ''
    ? null
    : Number(body.departmentId);
  const role = body.role;
  const groupIds = Array.isArray(body.groupIds) ? [...new Set(body.groupIds.map(Number))] : null;
  const roles = ['Employee', 'Ticket Manager', 'Administrator'];
  if (!name || name.length > 80 || !surname || surname.length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || phone.length > 30
      || (departmentId !== null && (!Number.isSafeInteger(departmentId) || departmentId <= 0))
      || !roles.includes(role)
      || !groupIds || groupIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return null;
  }
  return { name, surname, email, phone, departmentId, role, groupIds };
}

// Verify a selected department exists before starting a profile transaction.
async function departmentExists(departmentId) {
  if (departmentId === null) return true;
  const [rows] = await pool.execute('SELECT 1 FROM departments WHERE id = ?', [departmentId]);
  return rows.length > 0;
}

// Replace user group memberships within the caller's database transaction.
async function replaceUserGroups(connection, userId, groupIds) {
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',');
    const [groups] = await connection.execute(
      `SELECT id FROM ticket_groups WHERE id IN (${placeholders})`,
      groupIds
    );
    if (groups.length !== groupIds.length) return false;
  }
  const keepGroups = groupIds.length
    ? `AND t.group_id NOT IN (${groupIds.map(() => '?').join(',')})`
    : '';
  await connection.execute(
    `UPDATE ticket_assignment_requests ar
     JOIN tickets t ON t.id = ar.ticket_id
     SET ar.status = 'Cancelled', ar.resolved_at = UTC_TIMESTAMP()
     WHERE ar.status = 'Pending' AND (ar.requested_by = ? OR ar.target_user_id = ?) ${keepGroups}`,
    [userId, userId, ...groupIds]
  );
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',');
    await connection.execute(
      `DELETE FROM group_roles WHERE user_id = ? AND group_id NOT IN (${placeholders})`,
      [userId, ...groupIds]
    );
  } else {
    await connection.execute('DELETE FROM group_roles WHERE user_id = ?', [userId]);
  }
  for (const groupId of groupIds) {
    await connection.execute(
      "INSERT IGNORE INTO group_roles (user_id, group_id, role) VALUES (?, ?, 'Member')",
      [userId, groupId]
    );
  }
  return true;
}

// Create a user profile and memberships; an Administrator must provide the password.
app.post('/api/users', authenticate, requireUserManager, route(async (req, res) => {
  const profile = validateUserProfile(req.body);
  if (!profile) return res.status(400).json({ error: 'Provide valid user details and group IDs.' });
  if (!await departmentExists(profile.departmentId)) return res.status(400).json({ error: 'Selected department does not exist.' });
  if (req.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(profile.role)) {
    return res.status(403).json({ error: 'Only Administrators can create privileged accounts.' });
  }

  const temporaryPasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO users (name, surname, email, phone, password_hash, department_id, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [profile.name, profile.surname, profile.email, profile.phone || null, temporaryPasswordHash, profile.departmentId, profile.role]
    );
    const groupsValid = await replaceUserGroups(connection, result.insertId, profile.groupIds);
    if (!groupsValid) {
      await connection.rollback();
      return res.status(400).json({ error: 'One or more selected groups do not exist.' });
    }
    await connection.commit();
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Edit account profile and memberships without accepting password fields.
app.patch('/api/users/:id', authenticate, requireUserManager, route(async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });
  const profile = validateUserProfile(req.body);
  if (!profile) return res.status(400).json({ error: 'Provide valid user details and group IDs.' });
  if (!await departmentExists(profile.departmentId)) return res.status(400).json({ error: 'Selected department does not exist.' });
  if (req.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(profile.role)) {
    return res.status(403).json({ error: 'Only Administrators can assign privileged roles.' });
  }

  const [targetRows] = await pool.execute(
    'SELECT role FROM users WHERE id = ? AND is_removed = FALSE',
    [userId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(targetRows[0].role)) {
    return res.status(403).json({ error: 'Only Administrators can edit privileged accounts.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'UPDATE users SET name = ?, surname = ?, email = ?, phone = ?, department_id = ?, role = ? WHERE id = ?',
      [profile.name, profile.surname, profile.email, profile.phone || null, profile.departmentId, profile.role, userId]
    );
    const groupsValid = await replaceUserGroups(connection, userId, profile.groupIds);
    if (!groupsValid) {
      await connection.rollback();
      return res.status(400).json({ error: 'One or more selected groups do not exist.' });
    }
    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Enable or temporarily disable an account without removing its profile.
app.patch('/api/users/:id/status', authenticate, requireUserManager, route(async (req, res) => {
  const userId = Number(req.params.id);
  const isActive = req.body.isActive;
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'Provide a valid user ID and active status.' });
  }
  if (userId === req.user.id && !isActive) {
    return res.status(400).json({ error: 'You cannot disable your own account.' });
  }
  const [targetRows] = await pool.execute(
    'SELECT role FROM users WHERE id = ? AND is_removed = FALSE',
    [userId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(targetRows[0].role)) {
    return res.status(403).json({ error: 'Only Administrators can change privileged account status.' });
  }

  await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive, userId]);
  if (!isActive) {
    await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await pool.execute(
      `UPDATE ticket_assignment_requests
       SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP()
       WHERE status = 'Pending' AND (requested_by = ? OR target_user_id = ?)`,
      [userId, userId]
    );
  }
  res.json({ success: true });
}));

// Deactivate an account while preserving ticket and comment history.
app.delete('/api/users/:id', authenticate, requireUserManager, route(async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
  const [targetRows] = await pool.execute(
    'SELECT role FROM users WHERE id = ? AND is_removed = FALSE',
    [userId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(targetRows[0].role)) {
    return res.status(403).json({ error: 'Only Administrators can remove privileged accounts.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE users SET is_active = FALSE, is_removed = TRUE WHERE id = ?', [userId]);
    await connection.execute(
      `UPDATE ticket_assignment_requests
       SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP()
       WHERE status = 'Pending' AND (requested_by = ? OR target_user_id = ?)`,
      [userId, userId]
    );
    await connection.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Remove a selected batch while retaining their ticket history.
app.delete('/api/users', authenticate, requireUserManager, route(async (req, res) => {
  const userIds = req.body.userIds;
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 100
      || userIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    return res.status(400).json({ error: 'Select between 1 and 100 valid user IDs.' });
  }
  const ids = [...new Set(userIds.map(Number))];
  if (ids.length !== userIds.length || ids.includes(req.user.id)) {
    return res.status(400).json({ error: 'Remove a unique selection of users other than your own account.' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const [targets] = await pool.execute(
    `SELECT id, role FROM users WHERE id IN (${placeholders}) AND is_removed = FALSE`,
    ids
  );
  if (targets.length !== ids.length) return res.status(404).json({ error: 'One or more selected users were not found.' });
  if (req.user.role !== 'Administrator'
      && targets.some(target => ['Administrator', 'Ticket Manager'].includes(target.role))) {
    return res.status(403).json({ error: 'Only Administrators can remove privileged accounts.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE users SET is_active = FALSE, is_removed = TRUE WHERE id IN (${placeholders})`,
      ids
    );
    await connection.execute(
      `UPDATE ticket_assignment_requests
       SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP()
       WHERE status = 'Pending'
         AND (requested_by IN (${placeholders}) OR target_user_id IN (${placeholders}))`,
      [...ids, ...ids]
    );
    await connection.execute(`DELETE FROM sessions WHERE user_id IN (${placeholders})`, ids);
    await connection.commit();
    res.json({ success: true, removed: ids.length });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

// Let only Administrators set or reset an account password.
app.patch('/api/users/:id/password', authenticate, requireAdministrator, route(async (req, res) => {
  const userId = Number(req.params.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!Number.isSafeInteger(userId) || userId <= 0 || password.length < 12 || password.length > 200) {
    return res.status(400).json({ error: 'Use a password between 12 and 200 characters.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await pool.execute(
    'UPDATE users SET password_hash = ? WHERE id = ? AND is_removed = FALSE',
    [passwordHash, userId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'User not found.' });
  await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
  res.json({ success: true });
}));

// Create a group using an administrator-authorized request.
app.post('/api/groups', authenticate, requireAdministrator, route(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Group name must contain 1 to 80 characters.' });
  const [result] = await pool.execute('INSERT INTO ticket_groups (name) VALUES (?)', [name]);
  res.status(201).json({ id: result.insertId, name });
}));

// Delete a group and its memberships; related tickets become unassigned.
app.delete('/api/groups/:id', authenticate, requireAdministrator, route(async (req, res) => {
  await pool.execute(
    `UPDATE ticket_assignment_requests SET status = 'Cancelled', resolved_at = UTC_TIMESTAMP()
     WHERE status = 'Pending' AND ticket_id IN (SELECT id FROM tickets WHERE group_id = ?)`,
    [req.params.id]
  );
  const [result] = await pool.execute('DELETE FROM ticket_groups WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Group not found.' });
  res.json({ success: true });
}));

// Add an existing user to a group as an administrator.
app.post('/api/groups/:id/members', authenticate, requireAdministrator, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const role = req.body.role || 'Member';
  if (!Number.isSafeInteger(groupId) || !Number.isSafeInteger(userId)
      || !['Member', 'Team Leader'].includes(role)) {
    return res.status(400).json({ error: 'Valid group and user IDs are required.' });
  }
  await pool.execute(
    'INSERT IGNORE INTO group_roles (user_id, group_id, role) VALUES (?, ?, ?)',
    [userId, groupId, role]
  );
  res.json({ success: true });
}));

// Change a member's role only within the selected group.
app.patch('/api/groups/:id/members/:userId', authenticate, requireAdministrator, route(async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = Number(req.params.userId);
  const role = req.body.role;
  if (!Number.isSafeInteger(groupId) || !Number.isSafeInteger(userId)
      || !['Member', 'Team Leader'].includes(role)) {
    return res.status(400).json({ error: 'Provide valid group and user IDs and a group role.' });
  }
  const [membership] = await pool.execute(
    'SELECT 1 FROM group_roles WHERE group_id = ? AND user_id = ?',
    [groupId, userId]
  );
  if (!membership.length) return res.status(404).json({ error: 'Group membership not found.' });
  await pool.execute('UPDATE group_roles SET role = ? WHERE group_id = ? AND user_id = ?', [role, groupId, userId]);
  res.json({ success: true });
}));

// Remove a user from a group as an administrator.
app.delete('/api/groups/:id/members/:userId', authenticate, requireAdministrator, route(async (req, res) => {
  await pool.execute(
    `UPDATE ticket_assignment_requests ar
     JOIN tickets t ON t.id = ar.ticket_id
     SET ar.status = 'Cancelled', ar.resolved_at = UTC_TIMESTAMP()
     WHERE t.group_id = ? AND (ar.target_user_id = ? OR ar.requested_by = ?) AND ar.status = 'Pending'`,
    [req.params.id, req.params.userId, req.params.userId]
  );
  await pool.execute(
    'DELETE FROM group_roles WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.params.userId]
  );
  res.json({ success: true });
}));

// Return JSON errors without exposing database or internal exception details.
app.use((error, req, res, next) => {
  console.error('Request failed.', error);
  if (res.headersSent) return next(error);
  if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That value already exists.' });
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Related record not found.' });
  res.status(500).json({ error: 'The server could not complete the request.' });
});

// Start listening only after confirming that MySQL is reachable.
async function ensureActivityScheduleColumn() {
  const [columns] = await pool.execute(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'ticket_activities'
       AND column_name = 'start_minute'`,
    [databaseName]
  );
  if (!columns.length) {
    await pool.query(
      'ALTER TABLE ticket_activities ADD COLUMN start_minute SMALLINT UNSIGNED NOT NULL DEFAULT 540 AFTER activity_date'
    );
  }
}

async function ensureUserRemovalColumn() {
  const [columns] = await pool.execute(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'users' AND column_name = 'is_removed'`,
    [databaseName]
  );
  if (!columns.length) {
    await pool.query(
      'ALTER TABLE users ADD COLUMN is_removed BOOLEAN NOT NULL DEFAULT FALSE AFTER is_active'
    );
  }
}

async function startServer() {
  await pool.query('SELECT 1');
  await ensureActivityScheduleColumn();
  await ensureUserRemovalColumn();
  app.listen(port, () => console.log(`Smart HelpDesk is listening on port ${port}.`));
}

startServer().catch(error => {
  console.error('Unable to start the server or connect to MySQL.', error);
  process.exitCode = 1;
});
