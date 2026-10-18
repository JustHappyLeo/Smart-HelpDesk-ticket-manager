const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

if (!process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
  throw new Error('Set DB_USER, DB_PASSWORD, and DB_NAME before seeding the database.');
}

const databaseOptions = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true
};

const seedGroups = [
  [1, 'IT Support'],
  [2, 'Sales'],
  [3, 'Operations'],
  [4, 'Human Resources']
];

const seedDepartments = [
  [1, 'IT'],
  [2, 'Sales'],
  [3, 'Operations'],
  [4, 'Human Resources'],
  [5, 'Marketing']
];

const seedUsers = [
  [1, 'Alice', 'Doe', 'employee@company.com', 'Sales', 'Employee'],
  [2, 'Marco', 'Rossi', 'agent@company.com', 'IT Support', 'Employee'],
  [3, 'Sofia', 'Neri', 'manager@company.com', 'Operations', 'Ticket Manager'],
  [4, 'David', 'King', 'admin@company.com', 'Admin', 'Administrator']
];

const seedMemberships = [
  [1, 2, 'Member'],
  [2, 1, 'Team Leader'],
  [2, 2, 'Team Leader'],
  [3, 3, 'Member']
];

const seedTickets = [
  [101, 'VPN not connecting from home office', 'After the latest update, remote employees cannot access the VPN from the laptop.', 1, 2, 1, 'In Progress', 'High', '2026-10-10 09:20:00', '2026-10-14', JSON.stringify(['network', 'remote'])],
  [102, 'New printer driver request', 'Need a new printer driver installed for the storefront hardware.', 1, 2, 1, 'Waiting for feedback', 'Normal', '2026-10-08 11:05:00', '2026-10-16', JSON.stringify(['printer'])],
  [103, 'CRM export delayed', 'Sales team cannot export leads, the operation times out repeatedly.', 3, 2, 2, 'Open', 'Critical', '2026-10-13 08:10:00', '2026-10-13', JSON.stringify(['crm', 'sales'])]
];

const seedComments = [
  [1, 101, 1, 'The issue started this morning after the VPN client updated.', 'public'],
  [2, 101, 2, 'Investigating NAT and VPN access logs.', 'internal'],
  [3, 102, 1, 'Please confirm if we need a driver for Windows 11.', 'public'],
  [4, 103, 3, 'We need this escalated to the support queue.', 'internal']
];

async function seedDatabase() {
  const connection = await mysql.createConnection(databaseOptions);
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await connection.query(schema);
    const [activityStartColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'ticket_activities'
         AND column_name = 'start_minute'`,
      [process.env.DB_NAME]
    );
    if (!activityStartColumn.length) {
      await connection.query(
        'ALTER TABLE ticket_activities ADD COLUMN start_minute SMALLINT UNSIGNED NOT NULL DEFAULT 540 AFTER activity_date'
      );
    }
    for (const department of seedDepartments) {
      await connection.execute('INSERT IGNORE INTO departments (id, name) VALUES (?, ?)', department);
    }

    const [legacyDepartmentColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'department'`,
      [process.env.DB_NAME]
    );
    const [departmentIdColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'department_id'`,
      [process.env.DB_NAME]
    );
    if (!departmentIdColumn.length) {
      await connection.query('ALTER TABLE users ADD COLUMN department_id BIGINT UNSIGNED NULL');
    }

    if (legacyDepartmentColumn.length) {
      const [legacyDepartments] = await connection.query(
        'SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department <> ?',
        ['Admin']
      );
      for (const legacy of legacyDepartments) {
        const name = legacy.department === 'IT Support' ? 'IT' : legacy.department;
        await connection.execute('INSERT IGNORE INTO departments (name) VALUES (?)', [name]);
      }
      await connection.query(
        `UPDATE users u
         LEFT JOIN departments d ON d.name = CASE
           WHEN u.department = 'IT Support' THEN 'IT'
           WHEN u.department = 'Admin' THEN NULL
           ELSE u.department
         END
         SET u.department_id = d.id`
      );
      await connection.query('ALTER TABLE users DROP COLUMN department');
    }

    const [departmentConstraint] = await connection.execute(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_schema = ? AND table_name = 'users'
         AND constraint_name = 'fk_users_department'`,
      [process.env.DB_NAME]
    );
    if (!departmentConstraint.length) {
      await connection.query(
        `ALTER TABLE users ADD CONSTRAINT fk_users_department
         FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL`
      );
    }
    const [departmentIndex] = await connection.execute(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'users' AND index_name = 'idx_users_department'`,
      [process.env.DB_NAME]
    );
    if (!departmentIndex.length) {
      await connection.query('ALTER TABLE users ADD INDEX idx_users_department (department_id)');
    }

    const [activeColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'is_active'`,
      [process.env.DB_NAME]
    );
    if (!activeColumn.length) {
      await connection.query('ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE');
    }
    const [phoneColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'phone'`,
      [process.env.DB_NAME]
    );
    if (!phoneColumn.length) {
      await connection.query('ALTER TABLE users ADD COLUMN phone VARCHAR(30) NULL');
    }
    const [removedColumn] = await connection.execute(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'users' AND column_name = 'is_removed'`,
      [process.env.DB_NAME]
    );
    if (!removedColumn.length) {
      await connection.query('ALTER TABLE users ADD COLUMN is_removed BOOLEAN NOT NULL DEFAULT FALSE');
    }
    await connection.execute(
      "UPDATE ticket_groups SET name = 'Human Resources' WHERE name = 'HR'"
    );

    const demoPasswordHash = await bcrypt.hash('demo123', 12);
    const [departments] = await connection.query('SELECT id, name FROM departments');
    const departmentIds = new Map(departments.map(department => [department.name, department.id]));
    for (const user of seedUsers) {
      const departmentName = user[4] === 'IT Support' ? 'IT' : user[4] === 'Admin' ? null : user[4];
      const departmentId = departmentName === null ? null : departmentIds.get(departmentName) || null;
      await connection.execute(
        `INSERT IGNORE INTO users (id, name, surname, email, password_hash, department_id, role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [...user.slice(0, 4), demoPasswordHash, departmentId, user[5]]
      );
    }

    for (const group of seedGroups) {
      await connection.execute('INSERT IGNORE INTO ticket_groups (id, name) VALUES (?, ?)', group);
    }

    const [legacyMembershipTable] = await connection.execute(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = ? AND table_name = 'user_groups'`,
      [process.env.DB_NAME]
    );
    if (legacyMembershipTable.length) {
      await connection.query(
        `INSERT IGNORE INTO group_roles (user_id, group_id, role)
         SELECT ug.user_id, ug.group_id,
           CASE WHEN u.role = 'Support' THEN 'Team Leader' ELSE 'Member' END
         FROM user_groups ug JOIN users u ON u.id = ug.user_id`
      );
      await connection.query('DROP TABLE user_groups');
    }

    await connection.query("UPDATE users SET role = 'Employee' WHERE role = 'Support'");
    await connection.query(
      "ALTER TABLE users MODIFY role ENUM('Employee', 'Ticket Manager', 'Administrator') NOT NULL DEFAULT 'Employee'"
    );
    for (const [userId, groupId, role] of seedMemberships) {
      await connection.execute(
        'INSERT IGNORE INTO group_roles (user_id, group_id, role) VALUES (?, ?, ?)',
        [userId, groupId, role]
      );
    }
    for (const ticket of seedTickets) {
      await connection.execute(
        `INSERT IGNORE INTO tickets
         (id, subject, description, requester_id, assignee_id, group_id, status, priority, created_at, due_date, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ticket
      );
    }
    await connection.query(
      `INSERT INTO ticket_events (ticket_id, actor_id, event_type, details, created_at)
       SELECT t.id, t.requester_id, 'created', 'Ticket created', t.created_at
       FROM tickets t
       LEFT JOIN ticket_events e ON e.ticket_id = t.id AND e.event_type = 'created'
       WHERE e.id IS NULL`
    );
    for (const comment of seedComments) {
      await connection.execute(
        'INSERT IGNORE INTO comments (id, ticket_id, author_id, text, type) VALUES (?, ?, ?, ?, ?)',
        comment
      );
    }
    console.log('Database schema and demo records are ready.');
  } finally {
    await connection.end();
  }
}

seedDatabase().catch(error => {
  console.error('Unable to seed the database.', error);
  process.exitCode = 1;
});
