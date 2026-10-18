CREATE TABLE IF NOT EXISTS departments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  surname VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(60) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  role ENUM('Employee', 'Ticket Manager', 'Administrator') NOT NULL DEFAULT 'Employee',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_removed BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  INDEX idx_users_department (department_id)
);

CREATE TABLE IF NOT EXISTS ticket_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS group_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  group_id BIGINT UNSIGNED NOT NULL,
  role ENUM('Member', 'Team Leader') NOT NULL DEFAULT 'Member',
  PRIMARY KEY (user_id, group_id),
  CONSTRAINT fk_group_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_group_roles_group FOREIGN KEY (group_id) REFERENCES ticket_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject VARCHAR(120) NOT NULL,
  description VARCHAR(2000) NOT NULL,
  requester_id BIGINT UNSIGNED NOT NULL,
  assignee_id BIGINT UNSIGNED NULL,
  group_id BIGINT UNSIGNED NULL,
  status ENUM('New', 'Open', 'Scheduled', 'In Progress', 'Waiting for feedback', 'Resolved', 'Closed') NOT NULL DEFAULT 'New',
  priority ENUM('Low', 'Normal', 'High', 'Critical') NOT NULL DEFAULT 'Normal',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_date DATE NULL,
  tags JSON NOT NULL,
  CONSTRAINT fk_tickets_requester FOREIGN KEY (requester_id) REFERENCES users(id),
  CONSTRAINT fk_tickets_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tickets_group FOREIGN KEY (group_id) REFERENCES ticket_groups(id) ON DELETE SET NULL,
  INDEX idx_tickets_group (group_id),
  INDEX idx_tickets_requester (requester_id),
  INDEX idx_tickets_assignee (assignee_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  text VARCHAR(1000) NOT NULL,
  type ENUM('public', 'internal') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_author FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('created', 'status', 'assignment', 'comment') NOT NULL,
  details VARCHAR(1000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ticket_events_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_events_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  INDEX idx_ticket_events_ticket_date (ticket_id, created_at)
);

CREATE TABLE IF NOT EXISTS ticket_activities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  operator_id BIGINT UNSIGNED NOT NULL,
  time_used_minutes SMALLINT UNSIGNED NOT NULL,
  activity_date DATE NOT NULL,
  start_minute SMALLINT UNSIGNED NOT NULL DEFAULT 540,
  description VARCHAR(1000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ticket_activities_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_activities_operator FOREIGN KEY (operator_id) REFERENCES users(id),
  INDEX idx_ticket_activities_ticket_date (ticket_id, activity_date)
);

CREATE TABLE IF NOT EXISTS ticket_assignment_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  target_user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('Pending', 'Accepted', 'Declined', 'Cancelled') NOT NULL DEFAULT 'Pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  CONSTRAINT fk_assignment_requests_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_requests_requester FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_requests_target FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_assignment_requests_target_status (target_user_id, status),
  INDEX idx_assignment_requests_ticket_status (ticket_id, status)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_expiry (expires_at)
);
