// Keep UI state in memory while the server owns identity, sessions, and stored records.
(function () {
  const statusList = [
    'New',
    'Open',
    'Scheduled',
    'In Progress',
    'Waiting for feedback',
    'Resolved',
    'Closed'
  ];
  const priorityList = ['Low', 'Normal', 'High', 'Critical'];
  const app = document.getElementById('app');
  const state = {
    user: null,
    page: 'dashboard',
    tickets: [],
    calendarTickets: [],
    calendarActivities: [],
    calendarWorkActivities: [],
    ticketsExpanded: false,
    ticketFilters: { query: '', priority: '', status: '', sort: 'created-desc' },
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selectedCalendarDate: '',
    groups: [],
    departments: [],
    users: [],
    managedUserId: null,
    managedUserTickets: [],
    managedUserEditing: false,
    selectedManagementUserIds: [],
    showDisabledUsers: false,
    clonedUser: null,
    groupMembers: {},
    assignmentRequests: [],
    selectedTicket: null,
    previousTicketPage: 'my-tickets',
    comments: [],
    ticketEvents: [],
    ticketActivities: [],
    ticketTab: 'comments',
    error: '',
    success: ''
  };

  // Escape dynamic values before inserting them into generated HTML.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Send a same-origin API request and surface server error messages to callers.
  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const payload = response.status === 204 ? {} : await response.json();
    if (response.status === 401 && state.user && url !== '/api/auth/login') {
      state.user = null;
      state.page = 'dashboard';
      state.selectedTicket = null;
    }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  // Format dates returned from MySQL for display in ticket cards and details.
  function displayDate(value) {
    if (!value) return 'Not set';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      const [year, month, day] = String(value).split('-').map(Number);
      return new Date(year, month - 1, day).toLocaleDateString();
    }
    return escapeHtml(new Date(value).toLocaleDateString());
  }

  // Convert status labels to CSS badge class names.
  function statusClass(status) {
    return String(status || '').toLowerCase().replace(/\s+/g, '-');
  }

  // Render an error message returned by the API without hiding the current view.
  function renderError() {
    return `${state.error ? `<p class="error-message" role="alert">${escapeHtml(state.error)}</p>` : ''}${state.success ? `<p class="success-message" role="status">${escapeHtml(state.success)}</p>` : ''}`;
  }

  // Render the sign-in form and request a server-issued session on submit.
  function renderLogin() {
    app.innerHTML = `
      <div class="page">
        <div class="card login-box">
          <h2>Sign in</h2>
          ${renderError()}
          <form id="login-form" class="form-grid">
            <label class="field">
              <span>Email</span>
              <input id="login-email" type="email" autocomplete="username" required />
            </label>
            <label class="field">
              <span>Password</span>
              <input id="login-password" type="password" autocomplete="current-password" required />
            </label>
            <button class="primary" type="submit">Sign in</button>
          </form>
          </div>
      </div>
    `;
    app.querySelector('#login-form').addEventListener('submit', async event => {
      event.preventDefault();
      state.error = '';
      try {
        const email = app.querySelector('#login-email').value;
        const password = app.querySelector('#login-password').value;
        const result = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password })
        });
        state.user = result.user;
        state.page = 'dashboard';
        await loadPageData();
        render();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
  }

  // Fetch all data required by the current view from authorized API endpoints.
  async function loadPageData() {
    state.error = '';
    if (state.page === 'dashboard' || state.page === 'calendar') {
      const result = await api('/api/calendar');
      state.calendarTickets = result.tickets;
      state.calendarActivities = result.activities;
      state.calendarWorkActivities = result.workActivities;
      if (state.page === 'dashboard') {
        state.tickets = result.tickets.filter(ticket => ticket.assigneeId === state.user.id);
      }
    } else if (state.page === 'my-tickets' || state.page === 'team-queue') {
      const view = state.page === 'my-tickets' ? 'mine' : 'queue';
      const result = await api(`/api/tickets?view=${view}`);
      state.tickets = result.tickets;
      if (state.page === 'team-queue') {
        const groupIds = [...new Set(state.tickets.map(ticket => ticket.groupId).filter(Boolean))];
        const members = await Promise.all(groupIds.map(async id => {
          const result = await api(`/api/groups/${id}/members`);
          return [id, result.members];
        }));
        state.groupMembers = Object.fromEntries(members);
      }
    } else if (state.page === 'ticket-detail' && state.selectedTicket) {
      const result = await api(`/api/tickets/${state.selectedTicket.id}`);
      state.selectedTicket = result.ticket;
      state.comments = result.comments;
      state.ticketEvents = result.events;
      state.ticketActivities = result.activities;
    } else if (state.page === 'assignments') {
      const result = await api('/api/assignment-requests');
      state.assignmentRequests = result.requests;
    } else if (state.page === 'user-management' || state.page === 'user-detail') {
      const directoryResult = await api('/api/directory');
      state.directoryUsers = directoryResult.users;
      if (state.page === 'user-detail') {
        state.selectedUser = state.directoryUsers.find(user => user.id === Number(state.selectedUser?.id)) || null;
      }
      if (state.user.canManageUsers) {
        const [groupResult, userResult, departmentResult] = await Promise.all([
          api('/api/groups'),
          api('/api/users?includeDisabled=true'),
          api('/api/departments')
        ]);
        state.groups = groupResult.groups;
        state.users = userResult.users;
        state.departments = departmentResult.departments;
      }
    } else if (['add-ticket', 'user-create', 'managed-user-detail', 'groups'].includes(state.page)) {
      if (['user-create', 'managed-user-detail'].includes(state.page) && !state.user.canManageUsers) return;
      const result = await api('/api/groups');
      state.groups = result.groups;
      if (['managed-user-detail', 'groups'].includes(state.page)) {
        const userResult = await api(`/api/users${state.page === 'managed-user-detail' ? '?includeDisabled=true' : ''}`);
        state.users = userResult.users;
      }
      if (['user-create', 'managed-user-detail'].includes(state.page)) {
        const departmentResult = await api('/api/departments');
        state.departments = departmentResult.departments;
      }
      if (state.page === 'managed-user-detail') {
        const userId = Number(state.managedUserId);
        if (!state.users.some(user => user.id === userId)) {
          state.managedUserId = null;
          state.managedUserTickets = [];
        } else {
          const result = await api(`/api/users/${userId}/tickets`);
          state.managedUserTickets = result.tickets;
        }
      }
    } else if (state.page === 'departments') {
      const result = await api('/api/departments');
      state.departments = result.departments;
    }
  }

  // Load another page's server data and show any authorization or API error.
  async function navigate(page) {
    state.page = page;
    if (!['my-tickets', 'team-queue', 'add-ticket', 'ticket-detail', 'assignments'].includes(page)) {
      state.ticketsExpanded = false;
    }
    state.error = '';
    try {
      await loadPageData();
    } catch (error) {
      state.error = error.message;
    }
    render();
  }

  // Render a ticket card consistently in personal and queue lists.
  function renderTicketCard(ticket, queue = false) {
    const requester = `${ticket.requesterName || ''} ${ticket.requesterSurname || ''}`.trim() || 'Unknown';
    const assignee = `${ticket.assigneeName || ''} ${ticket.assigneeSurname || ''}`.trim() || 'Unassigned';
    const members = state.groupMembers[ticket.groupId] || [];
    const currentMembership = members.find(member => member.id === state.user.id);
    const canManageGroup = state.user.role === 'Administrator' || state.user.role === 'Ticket Manager'
      || currentMembership?.groupRole === 'Team Leader';
    return `
      <article class="ticket-item ticket-preview" data-ticket-id="${ticket.id}" tabindex="0" role="group" aria-label="Ticket ${ticket.id}: ${escapeHtml(ticket.subject)}">
        <div class="row">
          <strong>#${ticket.id} ${escapeHtml(ticket.subject)}</strong>
          <div class="inline-actions">
            <span class="badge priority-${String(ticket.priority).toLowerCase()}">${escapeHtml(ticket.priority)}</span>
            <span class="badge status-${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>
          </div>
        </div>
        <div class="row">
          <span>Requester: ${escapeHtml(requester)}</span>
          <span>Assignee: ${escapeHtml(assignee)}</span>
        </div>
        <div class="row">
          <span>Group: ${escapeHtml(ticket.department || 'Unassigned')}</span>
          <span>Due: ${displayDate(ticket.dueDate)}</span>
        </div>
        <div class="inline-actions">
          ${queue ? '' : '<span class="open-hint">Click to open</span>'}
          ${queue && canManageGroup ? `
            <label class="field assignee-control">
              <span>Assignee</span>
              <select id="assignee-${ticket.id}" aria-label="Assignee for ticket ${ticket.id}">
                <option value="">Unassigned</option>
                ${members.map(member => `<option value="${member.id}" ${member.id === ticket.assigneeId ? 'selected' : ''}>${escapeHtml(member.name)} ${escapeHtml(member.surname)}</option>`).join('')}
              </select>
            </label>
            <button type="button" data-action="assign-ticket" data-ticket-id="${ticket.id}">Save assignee</button>
          ` : ''}
          ${queue && currentMembership && !canManageGroup ? `
            ${ticket.assigneeId === state.user.id ? '' : `<button type="button" data-action="assign-self" data-ticket-id="${ticket.id}">Assign to me</button>`}
            ${members.some(member => member.id !== state.user.id && member.id !== ticket.assigneeId) ? `
              <label class="field assignee-control">
                <span>Request assignment to</span>
                <select id="request-assignee-${ticket.id}">
                  ${members.filter(member => member.id !== state.user.id && member.id !== ticket.assigneeId)
                    .map(member => `<option value="${member.id}">${escapeHtml(member.name)} ${escapeHtml(member.surname)}</option>`).join('')}
                </select>
              </label>
              <button type="button" data-action="request-assignment" data-ticket-id="${ticket.id}">Request approval</button>
            ` : ''}
          ` : ''}
        </div>
      </article>
    `;
  }

  // Display logged work in a compact hours-and-minutes format.
  function formatDuration(minutes) {
    const value = Number(minutes) || 0;
    const hours = Math.floor(value / 60);
    const remainder = value % 60;
    if (!hours) return `${remainder} min`;
    return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }

  // Apply the current search, filter, and sort options to the visible ticket list.
  function visibleTickets() {
    const filters = state.ticketFilters;
    return [...state.tickets]
      .filter(ticket => !filters.query || `${ticket.id} ${ticket.subject} ${ticket.description}`.toLowerCase().includes(filters.query.toLowerCase()))
      .filter(ticket => !filters.priority || ticket.priority === filters.priority)
      .filter(ticket => !filters.status || ticket.status === filters.status)
      .sort((left, right) => {
        if (filters.sort === 'id-asc') return Number(left.id) - Number(right.id);
        if (filters.sort === 'id-desc') return Number(right.id) - Number(left.id);
        if (filters.sort === 'priority-desc') return priorityList.indexOf(right.priority) - priorityList.indexOf(left.priority);
        if (filters.sort === 'due-asc') return String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'));
        return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
      });
  }

  // Render filtered ticket previews that open their full-screen detail with one click.
  function renderTicketList(queue = false) {
    const tickets = visibleTickets();
    return `
      <section class="page-heading">
        <div><p class="eyebrow">TICKETS</p><h1>${queue ? 'Team Queue' : 'My Tickets'}</h1></div>
        <button type="button" class="primary" data-page="add-ticket">＋ Add ticket</button>
      </section>
      <section class="card ticket-filters">
        <label class="field"><span>Search tickets</span><input id="ticket-search" value="${escapeHtml(state.ticketFilters.query)}" placeholder="ID, subject or description" /></label>
        <label class="field"><span>Priority</span><select id="ticket-priority-filter"><option value="">All priorities</option>${priorityList.map(item => `<option ${state.ticketFilters.priority === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
        <label class="field"><span>Status</span><select id="ticket-status-filter"><option value="">All statuses</option>${statusList.map(item => `<option ${state.ticketFilters.status === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
        <label class="field"><span>Sort by</span><select id="ticket-sort"><option value="created-desc" ${state.ticketFilters.sort === 'created-desc' ? 'selected' : ''}>Recently created</option><option value="id-asc" ${state.ticketFilters.sort === 'id-asc' ? 'selected' : ''}>ID ascending</option><option value="id-desc" ${state.ticketFilters.sort === 'id-desc' ? 'selected' : ''}>ID descending</option><option value="priority-desc" ${state.ticketFilters.sort === 'priority-desc' ? 'selected' : ''}>Priority</option><option value="due-asc" ${state.ticketFilters.sort === 'due-asc' ? 'selected' : ''}>Expiration date</option></select></label>
      </section>
      <section class="ticket-list ticket-preview-list">
        ${tickets.map(ticket => renderTicketCard(ticket, queue)).join('') || '<p class="empty-state">No tickets match these filters.</p>'}
      </section>
    `;
  }

  function calendarEventMap() {
    const events = new Map();
    const add = (date, event) => {
      if (!date) return;
      const key = String(date).slice(0, 10);
      if (!events.has(key)) events.set(key, []);
      events.get(key).push(event);
    };
    state.calendarTickets.forEach(ticket => {
      add(ticket.createdAt, { type: 'created', label: `Ticket #${ticket.id} created`, ticketId: ticket.id });
      add(ticket.dueDate, { type: 'due', label: `Ticket #${ticket.id} due`, ticketId: ticket.id });
    });
    state.calendarActivities.forEach(activity => {
      add(activity.date, { type: 'activity', label: `${activity.title}: ticket #${activity.ticketId}`, ticketId: activity.ticketId });
    });
    state.calendarWorkActivities.forEach(activity => {
      add(activity.activityDate, {
        type: 'work',
        label: `Work log: ticket #${activity.ticketId}`,
        ticketId: activity.ticketId
      });
    });
    return events;
  }

  function formatCalendarTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function renderCalendarDay(date) {
    const activities = state.calendarWorkActivities
      .filter(activity => activity.activityDate === date)
      .sort((left, right) => left.startMinute - right.startMinute);
    const activityList = activities.map(activity => `
      <button type="button" class="calendar-activity-list-item calendar-draggable-activity"
        data-action="open-event-ticket" data-activity-id="${activity.id}" data-ticket-id="${activity.ticketId}"
        data-start-minute="${activity.startMinute}" data-duration="${activity.timeUsedMinutes}">
        <span class="calendar-activity-list-meta">
          <strong>Ticket #${activity.ticketId}</strong>
          <span>${formatCalendarTime(activity.startMinute)} · ${formatDuration(activity.timeUsedMinutes)}</span>
        </span>
        <span>${escapeHtml(activity.description)}</span>
        <small>${escapeHtml(activity.operator)}</small>
      </button>
    `).join('');
    const weekStart = new Date(`${date}T12:00:00`);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekDays = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + index);
      const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      return `<button type="button" class="${dayKey === date ? 'active' : ''}" data-action="calendar-select-day" data-calendar-drop-date="${dayKey}"><strong>${day.toLocaleDateString(undefined, { weekday: 'short' })}</strong><span>${day.getDate()}</span></button>`;
    }).join('');
    const hourHeight = 60;
    const rows = Array.from({ length: 24 }, (_, hour) => `
      <div class="calendar-hour" style="top:${hour * hourHeight}px">
        <span>${formatCalendarTime(hour * 60)}</span><div></div>
      </div>
    `).join('');
    const overlappingGroups = [];
    activities.forEach(activity => {
      const startMinute = Number(activity.startMinute);
      const duration = Number(activity.timeUsedMinutes);
      const endMinute = Math.min(startMinute + duration, 1440);
      let group = overlappingGroups[overlappingGroups.length - 1];
      if (!group || group.endMinute <= startMinute) {
        group = { endMinute, items: [] };
        overlappingGroups.push(group);
      } else {
        group.endMinute = Math.max(group.endMinute, endMinute);
      }
      group.items.push({ activity, startMinute, endMinute });
    });
    const blocks = overlappingGroups.map(group => {
      const laneEnds = [];
      group.items.forEach(item => {
        let lane = laneEnds.findIndex(end => end <= item.startMinute);
        if (lane === -1) lane = laneEnds.length;
        item.lane = lane;
        laneEnds[lane] = item.endMinute;
      });
      const laneCount = laneEnds.length;
      return group.items.map(({ activity, startMinute, endMinute, lane }) => {
        const height = endMinute - startMinute;
        return `
          <button type="button" class="calendar-activity calendar-draggable-activity" data-action="open-event-ticket"
            data-activity-id="${activity.id}" data-ticket-id="${activity.ticketId}"
            data-start-minute="${startMinute}" data-duration="${activity.timeUsedMinutes}"
            aria-label="Ticket ${activity.ticketId}: ${escapeHtml(activity.description)}, ${formatCalendarTime(startMinute)} for ${formatDuration(activity.timeUsedMinutes)}"
            style="top:${startMinute}px;height:${height}px;left:${lane * 100 / laneCount}%;width:calc(${100 / laneCount}% - 6px)">
            <span class="activity-resize-handle activity-resize-top" data-resize="top" aria-hidden="true"></span>
            <strong>#${activity.ticketId} · ${formatCalendarTime(startMinute)}–${formatCalendarTime(endMinute)}</strong>
            <span class="calendar-activity-description">${escapeHtml(activity.description)}</span>
            <small>${escapeHtml(activity.operator)} · ${formatDuration(activity.timeUsedMinutes)}</small>
            <span class="activity-resize-handle activity-resize-bottom" data-resize="bottom" aria-hidden="true"></span>
          </button>
        `;
      }).join('');
    }).join('');
    const events = calendarEventMap().get(date) || [];
    return `
      <section class="calendar-day-panel">
        <div class="calendar-day-strip" aria-label="Select or drag to another day">${weekDays}</div>
        <section class="calendar-events" aria-label="Events for ${displayDate(date)}">
          <h2>Events · ${displayDate(date)}</h2>
            ${events.map(event => `<button type="button" class="calendar-event" data-action="open-event-ticket" data-ticket-id="${event.ticketId}"><span class="event-dot ${event.type}"></span>${escapeHtml(event.label)}</button>`).join('') || '<p class="empty-state">No events for this day.</p>'}
        </section>
        <div class="calendar-day-details">
          <aside class="calendar-activity-list" aria-label="Work activities for ${displayDate(date)}">
            <div class="calendar-activity-list-heading">
              <h2>Activities</h2>
              <span>${activities.length}</span>
            </div>
            <p class="calendar-activity-list-hint">Drag an activity onto a calendar day to reschedule it.</p>
            <div class="calendar-activity-list-items">
              ${activityList || '<p class="empty-state">No work activities logged for this day.</p>'}
            </div>
          </aside>
          <section class="calendar-day-view" aria-label="24-hour activity schedule for ${displayDate(date)}">
            <div class="calendar-day-heading">
              <h2>${displayDate(date)} · Daily view</h2>
              <p>Drag an activity to change its time. Drag the top or bottom edge to change its start or end.</p>
            </div>
            <div class="calendar-time-scroll">
              <div class="calendar-time-grid" data-calendar-time-grid style="height:${24 * hourHeight}px">
                ${rows}<div class="calendar-activity-lanes">${blocks}</div>
              </div>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  // Render a month calendar with ticket creation, due dates, and visible comments.
  function renderCalendarGrid(month, compact = false) {
    const events = calendarEventMap();
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const firstDay = new Date(year, monthIndex, 1);
    const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const selectedKey = state.selectedCalendarDate || '';
    const cells = [];
    for (let index = 0; index < offset; index++) cells.push('<div class="calendar-cell calendar-blank"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayEvents = events.get(key) || [];
      const dueCount = dayEvents.filter(event => event.type === 'due').length;
      const activityCount = dayEvents.filter(event => event.type === 'work').length;
      const countLabel = [
        dueCount ? `${dueCount} due` : '',
        activityCount ? `${activityCount} ${activityCount === 1 ? 'activity' : 'activities'}` : ''
      ].filter(Boolean).join(' · ');
      cells.push(`<button type="button" title="${escapeHtml([countLabel, dayEvents.length > dueCount + activityCount ? `${dayEvents.length - dueCount - activityCount} other events` : ''].filter(Boolean).join(', '))}" class="calendar-cell ${dayEvents.length ? 'has-events' : ''} ${selectedKey === key ? 'selected' : ''}" data-action="calendar-day" data-date="${key}" data-calendar-drop-date="${key}"><span>${day}</span>${countLabel ? `<small>${escapeHtml(countLabel)}</small>` : ''}</button>`);
    }
    return `
      <section class="calendar-panel ${compact ? 'compact-calendar' : ''}">
        <div class="calendar-heading">
          ${compact ? '' : `<button type="button" data-action="calendar-previous" aria-label="Previous month">‹</button>`}
          <strong>${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
          ${compact ? '' : `<button type="button" data-action="calendar-next" aria-label="Next month">›</button>`}
        </div>
        <div class="calendar-grid calendar-weekdays">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<span>${day}</span>`).join('')}</div>
        <div class="calendar-grid">${cells.join('')}</div>
        ${!compact && selectedKey ? `${renderCalendarDay(selectedKey)}` : ''}
      </section>
    `;
  }

  // Show the current user's open assigned work, quick counts, and compact calendar.
  function renderDashboard() {
    const openAssigned = state.calendarTickets.filter(ticket =>
      ticket.assigneeId === state.user.id && !['Resolved', 'Closed'].includes(ticket.status));
    const dueSoon = openAssigned.filter(ticket => ticket.dueDate && ticket.dueDate >= new Date().toISOString().slice(0, 10))
      .sort((left, right) => String(left.dueDate).localeCompare(String(right.dueDate))).slice(0, 4);
    const highPriority = openAssigned.filter(ticket => ['High', 'Critical'].includes(ticket.priority)).length;
    return `
      <section class="page-heading"><div><p class="eyebrow">OVERVIEW</p><h1>Dashboard</h1><p>Welcome back, ${escapeHtml(state.user.name)}.</p></div><button type="button" class="primary" data-page="add-ticket">＋ Add ticket</button></section>
      <section class="stat-grid dashboard-stats">
        <div class="stat"><span>Open assigned</span><strong>${openAssigned.length}</strong></div>
        <div class="stat"><span>Due soon</span><strong>${dueSoon.length}</strong></div>
        <div class="stat"><span>High priority</span><strong>${highPriority}</strong></div>
      </section>
      <section class="dashboard-grid">
        <div class="card dashboard-section"><div class="section-heading"><h2>Open assigned tickets</h2><button type="button" data-page="my-tickets">All my tickets</button></div>
          <div class="ticket-list">${openAssigned.slice(0, 5).map(ticket => renderTicketCard(ticket)).join('') || '<p class="empty-state">No open tickets assigned to you.</p>'}</div>
        </div>
        <div class="card dashboard-section"><div class="section-heading"><h2>Calendar</h2><button type="button" data-page="calendar">Open calendar</button></div>
          ${renderCalendarGrid(state.calendarMonth, true)}
          <h3>Upcoming due dates</h3>
          <div class="upcoming-list">${dueSoon.map(ticket => `<button type="button" data-action="open-event-ticket" data-ticket-id="${ticket.id}"><strong>#${ticket.id}</strong> ${escapeHtml(ticket.subject)} <span>${displayDate(ticket.dueDate)}</span></button>`).join('') || '<p>No upcoming due dates.</p>'}</div>
        </div>
      </section>
    `;
  }

  // Render the current user's visible ticket queue and assignment controls.
  function renderQueue() {
    return renderTicketList(true);
  }

  // Render a full monthly calendar and the events selected for a specific day.
  function renderCalendar() {
    return `<section class="page-heading"><div><p class="eyebrow">SCHEDULE</p><h1>Calendar</h1><p>Ticket due dates and visible activity.</p></div></section>${renderCalendarGrid(state.calendarMonth)}`;
  }

  // Render personal password controls and a placeholder for future preferences.
  function renderSettings() {
    return `
      <section class="page-heading"><div><p class="eyebrow">ACCOUNT</p><h1>Settings</h1><p>Manage your sign-in and personal preferences.</p></div></section>
      <section class="settings-grid">
        <form id="password-form" class="card settings-card form-grid">
          <h2>Change password</h2><p>Choose a password with at least 12 characters.</p>
          <label class="field"><span>Current password</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
          <label class="field"><span>New password</span><input name="newPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password" required /></label>
          <label class="field"><span>Confirm new password</span><input name="confirmPassword" type="password" minlength="12" maxlength="200" autocomplete="new-password" required /></label>
          <button type="submit" class="primary">Update password</button>
        </form>
        <section class="card settings-card"><h2>Preferences</h2><p>Personal preferences will be available here in a future update.</p><button type="button" disabled>Preferences coming soon</button></section>
        ${state.user.canManageUsers ? `<section class="card settings-card"><h2>Administration</h2><div class="inline-actions"><button type="button" data-page="departments">Departments</button>${state.user.role === 'Administrator' ? '<button type="button" data-page="groups">Groups</button>' : ''}</div></section>` : ''}
        ${state.user.role === 'Administrator' || state.user.role === 'Ticket Manager' ? '<section class="card settings-card"><h2>Assignment requests</h2><button type="button" data-page="assignments">Review assignment requests</button></section>' : ''}
      </section>
    `;
  }

  // Render incoming assignment approvals and the current user's outgoing requests.
  function renderAssignmentRequests() {
    return `
      <section class="card" style="padding:1rem;">
        <h3>Assignment requests</h3>
        <div class="ticket-list">
          ${state.assignmentRequests.map(request => {
            const incoming = request.targetUserId === state.user.id;
            return `
              <article class="ticket-item">
                <div class="row">
                  <strong>#${request.ticketId} ${escapeHtml(request.subject)}</strong>
                  <span class="badge">${escapeHtml(request.status)}</span>
                </div>
                <p>${incoming
                  ? `${escapeHtml(request.requesterName)} asks you to take this ticket.`
                  : `You asked ${escapeHtml(request.targetName)} to take this ticket.`}</p>
                ${incoming && request.status === 'Pending' ? `
                  <div class="inline-actions">
                    <button type="button" class="primary" data-action="decide-assignment" data-request-id="${request.id}" data-decision="Accepted">Accept</button>
                    <button type="button" data-action="decide-assignment" data-request-id="${request.id}" data-decision="Declined">Decline</button>
                  </div>
                ` : ''}
              </article>
            `;
          }).join('') || '<p>No assignment requests.</p>'}
        </div>
      </section>
    `;
  }

  // Render ticket details, requester-visible conversation, staff work logs, and history.
  function renderTicketDetail() {
    const ticket = state.selectedTicket;
    if (!ticket) return '<p>No ticket selected.</p>';
    if (!ticket.agentView && state.ticketTab === 'activities') state.ticketTab = 'history';
    const totalMinutes = state.ticketActivities.reduce((total, activity) => total + Number(activity.timeUsedMinutes), 0);
    const history = [
      ...state.ticketEvents.filter(item => item.eventType !== 'comment').map(item => ({
        date: item.createdAt,
        label: item.details,
        actor: item.actor,
        kind: item.eventType
      })),
      ...state.comments.map(comment => ({
        date: comment.createdAt,
        label: `${comment.type === 'internal' ? 'Internal note' : 'Public comment'}: ${comment.text}`,
        actor: comment.author,
        kind: comment.type === 'internal' ? 'note' : 'comment'
      })),
      ...state.ticketActivities.map(activity => ({
        date: activity.activityDate,
        label: `Work logged (${formatDuration(activity.timeUsedMinutes)}): ${activity.description}`,
        actor: activity.operator,
        kind: 'activity'
      }))
    ].sort((left, right) => new Date(right.date) - new Date(left.date));
    return `
      <section class="ticket-fullscreen">
        <button type="button" class="back-link" data-action="back-from-ticket">← Back to tickets</button>
        <header class="ticket-detail-header">
          <div class="ticket-title-block">
            <span class="ticket-id">Ticket #${escapeHtml(ticket.id)}</span>
            <h1>${escapeHtml(ticket.subject)}</h1>
            <div class="ticket-primary-meta">
              <span><strong>Requester</strong>${escapeHtml(ticket.requesterName)} ${escapeHtml(ticket.requesterSurname)}</span>
              <span><strong>Assignee</strong>${escapeHtml(ticket.assigneeName)} ${escapeHtml(ticket.assigneeSurname)}</span>
              <span><strong>Group</strong>${escapeHtml(ticket.department)}</span>
            </div>
            <p class="ticket-created-meta">Created ${displayDate(ticket.createdAt)}</p>
          </div>
          <aside class="ticket-status-panel">
            <span class="detail-label">STATUS</span>
            ${ticket.canChangeStatus || ticket.canClose ? `
              <details class="ticket-status-menu">
                <summary class="badge status-${statusClass(ticket.status)}">${escapeHtml(ticket.status)} <span aria-hidden="true">▾</span></summary>
                <div class="ticket-status-options" role="group" aria-label="Change ticket status">
                  ${(ticket.canChangeStatus ? statusList : ['Closed']).map(status => `<button type="button" data-action="save-status" data-status="${escapeHtml(status)}" ${status === ticket.status ? 'aria-current="true"' : ''}>${escapeHtml(status)}</button>`).join('')}
                </div>
              </details>
            ` : `<span class="badge status-${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>`}
            <span class="detail-label">PRIORITY</span>
            <span class="badge priority-${String(ticket.priority).toLowerCase()}">${escapeHtml(ticket.priority)}</span>
            <span class="detail-label">DUE DATE</span>
            <span class="badge due-date-tag">${displayDate(ticket.dueDate)}</span>
            <span class="detail-label">TAGS</span>
            <div class="ticket-tag-list">${(ticket.tags || []).map(tag => `<span class="badge status-tag">${escapeHtml(tag)}</span>`).join('') || '<span class="muted">No tags</span>'}</div>
            ${ticket.agentView ? `<div class="ticket-time-total"><span>Total time logged</span><strong>${formatDuration(totalMinutes)}</strong></div>` : ''}
          </aside>
        </header>
        <section class="panel ticket-description">
          <div class="detail-section-heading"><div><span class="eyebrow">PROBLEM</span><h2>Description</h2></div></div>
          <p>${escapeHtml(ticket.description)}</p>
        </section>
        <section class="ticket-conversation panel">
          <div class="ticket-tabs" role="tablist" aria-label="Ticket conversation and history">
            <button type="button" role="tab" aria-selected="${state.ticketTab === 'comments'}" class="${state.ticketTab === 'comments' ? 'active' : ''}" data-action="ticket-tab" data-tab="comments">Comments &amp; notes <span>${state.comments.length}</span></button>
            ${ticket.agentView ? `<button type="button" role="tab" aria-selected="${state.ticketTab === 'activities'}" class="${state.ticketTab === 'activities' ? 'active' : ''}" data-action="ticket-tab" data-tab="activities">Activities <span>${state.ticketActivities.length}</span></button>` : ''}
            <button type="button" role="tab" aria-selected="${state.ticketTab === 'history'}" class="${state.ticketTab === 'history' ? 'active' : ''}" data-action="ticket-tab" data-tab="history">History <span>${history.length}</span></button>
          </div>
          ${state.ticketTab === 'comments' ? `
            <div class="message-list">
              ${state.comments.map(comment => `
                <article class="message ${comment.type === 'internal' ? 'internal-note' : ''}">
                  <div class="message-meta"><strong>${escapeHtml(comment.author)}</strong><span>${comment.type === 'internal' ? 'Internal note' : 'Comment'}</span><time>${displayDate(comment.createdAt)}</time></div>
                  <div>${escapeHtml(comment.text)}</div>
                </article>
              `).join('') || '<p class="empty-state">No comments or notes yet.</p>'}
            </div>
            <div class="comment-composer">
              <label class="field"><span>${ticket.agentView ? 'Message type' : 'Comment to requester'}</span>
                ${ticket.agentView ? '<select id="comment-type"><option value="public">Public comment — visible to requester</option><option value="internal">Internal note — support staff only</option></select>' : '<input id="comment-type" type="hidden" value="public" />'}
              </label>
              <label class="field"><span>${ticket.agentView ? 'Message' : 'Comment'}</span><textarea id="new-comment" maxlength="1000" placeholder="${ticket.agentView ? 'Write a public comment or internal note...' : 'Write a comment for the support team...'}"></textarea></label>
              <button type="button" class="primary" data-action="add-comment">Send</button>
            </div>
          ` : state.ticketTab === 'activities' && ticket.agentView ? `
            <div class="activity-log-list">
              ${state.ticketActivities.map(activity => `
                <article class="work-activity">
                  <div class="message-meta"><strong>${escapeHtml(activity.operator)}</strong><span>${formatDuration(activity.timeUsedMinutes)}</span><time>${displayDate(activity.activityDate)}</time></div>
                  <p>${escapeHtml(activity.description)}</p>
                </article>
              `).join('') || '<p class="empty-state">No work activities have been logged yet.</p>'}
            </div>
            <form class="activity-composer" id="activity-form">
              <label class="field"><span>Operator</span><input value="${escapeHtml(`${state.user.name} ${state.user.surname}`)}" disabled /></label>
              <label class="field"><span>Time used (minutes)</span><input name="timeUsedMinutes" type="number" min="1" max="1440" step="1" required /></label>
              <label class="field"><span>Date</span><input name="activityDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></label>
              <label class="field"><span>Start time</span><input name="startTime" type="time" value="09:00" required /></label>
              <label class="field activity-description-field"><span>Description</span><textarea name="description" maxlength="1000" required></textarea></label>
              <button type="submit" class="primary">Log activity</button>
            </form>
          ` : `
            <ol class="ticket-timeline">
              ${history.map(item => `
                <li class="timeline-item event-${escapeHtml(item.kind)}">
                  <span class="timeline-marker"></span>
                  <div><strong>${escapeHtml(item.label)}</strong><p>By ${escapeHtml(item.actor)}</p></div>
                  <time>${/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))
                    ? displayDate(item.date)
                    : escapeHtml(new Date(item.date).toLocaleString())}</time>
                </li>
              `).join('') || '<li class="empty-state">No ticket history has been recorded yet.</li>'}
            </ol>
          `}
        </section>
      </section>
    `;
  }

  // Render the ticket form using groups supplied by the authenticated API.
  function renderNewTicket() {
    return `
      <section class="page-heading"><div><p class="eyebrow">TICKETS</p><h1>Add Ticket</h1><p>Describe the issue and choose the support group.</p></div></section>
      <section class="card create-ticket-card" style="padding:1rem;">
        <div class="form-grid">
          <label class="field"><span>Subject</span><input id="ticket-subject" maxlength="120" required /></label>
          <label class="field"><span>Description</span><textarea id="ticket-description" maxlength="2000" required></textarea></label>
          <div class="grid-two">
            <label class="field">
              <span>Priority</span>
              <select id="ticket-priority">${priorityList.map(item => `<option>${escapeHtml(item)}</option>`).join('')}</select>
            </label>
            <label class="field">
              <span>Group</span>
              <select id="ticket-group">${state.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join('')}</select>
            </label>
          </div>
          <button type="button" class="primary" data-action="create-ticket">Submit ticket</button>
        </div>
      </section>
    `;
  }

  function renderUserManagement() {
    const users = state.user.canManageUsers
      ? state.users.filter(user => state.showDisabledUsers || user.isActive)
      : state.directoryUsers;
    const selectableUsers = users.filter(user => user.id !== state.user.id
      && (state.user.role === 'Administrator' || !['Administrator', 'Ticket Manager'].includes(user.role)));
    const allVisibleSelected = users.length > 0
      && selectableUsers.length > 0
      && selectableUsers.every(user => state.selectedManagementUserIds.includes(user.id));
    return `
      <section class="page-heading user-management-heading">
        <div><p class="eyebrow">PEOPLE</p><h1>Users</h1><p>Browse user profiles and contact information.</p></div>
      </section>
      <section class="card user-management-list">
        <div class="user-list-toolbar">
          ${state.user.canManageUsers ? `<label><input type="checkbox" data-action="select-all-managed-users" ${allVisibleSelected ? 'checked' : ''} /> Select all</label>` : ''}
          <span>${users.length} ${users.length === 1 ? 'user' : 'users'}</span>
          ${state.user.canManageUsers ? `<div class="user-management-actions">
            <button type="button" class="primary" data-action="add-managed-user">＋ Add user</button>
            <details class="user-more-menu">
              <summary aria-label="Advanced user management settings">···</summary>
              <div class="user-more-options">
                <button type="button" data-action="clone-managed-user" ${state.selectedManagementUserIds.length === 1 ? '' : 'disabled'}>Clone selected user</button>
                <label><input type="checkbox" data-action="toggle-disabled-users" ${state.showDisabledUsers ? 'checked' : ''} /> Show disabled users</label>
                <button type="button" class="danger-button" data-action="batch-remove-users" ${state.selectedManagementUserIds.length ? '' : 'disabled'}>Remove selected (${state.selectedManagementUserIds.length})</button>
              </div>
            </details>
          </div>` : ''}
        </div>
        <div class="managed-user-list" role="list">
          ${users.map(user => `
            <div class="managed-user-row ${state.user.canManageUsers ? '' : 'directory-user-row'}" role="listitem">
              ${state.user.canManageUsers ? `<label class="managed-user-select" aria-label="Select ${escapeHtml(user.name)} ${escapeHtml(user.surname)}">
                <input type="checkbox" data-action="select-managed-user" data-user-id="${user.id}" ${state.selectedManagementUserIds.includes(user.id) ? 'checked' : ''} ${user.id === state.user.id || (state.user.role !== 'Administrator' && ['Administrator', 'Ticket Manager'].includes(user.role)) ? 'disabled' : ''} />
              </label>` : ''}
              <button type="button" class="managed-user-open ${state.user.canManageUsers ? '' : 'directory-user-open'}" data-action="${state.user.canManageUsers ? 'open-managed-user' : 'open-user'}" data-user-id="${user.id}">
                <span class="managed-user-avatar">${escapeHtml(`${user.name[0] || ''}${user.surname[0] || ''}`.toUpperCase())}</span>
                <span class="managed-user-primary"><strong>${escapeHtml(user.name)} ${escapeHtml(user.surname)}</strong><small>${escapeHtml(user.email)}</small></span>
                <span class="managed-user-secondary">${escapeHtml(user.department || 'No department')}</span>
                ${state.user.canManageUsers ? `<span class="badge">${escapeHtml(user.role)}</span><span class="badge ${user.isActive ? 'user-active' : 'user-disabled'}">${user.isActive ? 'Active' : 'Disabled'}</span>` : ''}
                <span class="managed-user-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          `).join('') || '<p class="empty-state">No users match this view.</p>'}
        </div>
      </section>
    `;
  }

  function renderUserDetail() {
    const user = state.selectedUser;
    if (!user) return '<section class="page-heading"><div><h1>User not found</h1></div></section><button type="button" class="back-link" data-page="user-management">← Back to users</button>';
    return `
      <section class="page-heading"><div><p class="eyebrow">USER PROFILE</p><h1>${escapeHtml(user.name)} ${escapeHtml(user.surname)}</h1><p>Contact and department information.</p></div><button type="button" class="back-link" data-page="user-management">← Back to users</button></section>
      <section class="card user-profile-card">
        <span class="avatar avatar-large">${escapeHtml(`${user.name[0] || ''}${user.surname[0] || ''}`.toUpperCase())}</span>
        <dl class="profile-details">
          <dt>Email</dt><dd><a href="mailto:${escapeHtml(user.email)}">${escapeHtml(user.email)}</a></dd>
          <dt>Department</dt><dd>${escapeHtml(user.department || 'Not set')}</dd>
          <dt>Phone</dt><dd>${user.phone ? `<a href="tel:${escapeHtml(user.phone)}">${escapeHtml(user.phone)}</a>` : 'Not set'}</dd>
        </dl>
      </section>
    `;
  }

  function renderManagedUserCreate() {
    if (!state.user.canManageUsers) return '<p>Human Resources group membership or Administrator role required.</p>';
    const clone = state.clonedUser;
    const roles = state.user.role === 'Administrator'
      ? ['Employee', 'Ticket Manager', 'Administrator']
      : ['Employee'];
    const role = roles.includes(clone?.role) ? clone.role : 'Employee';
    return `
      <section class="page-heading"><div><p class="eyebrow">USER MANAGEMENT</p><h1>${clone ? 'Clone user' : 'Add user'}</h1><p>${clone ? `Creating a new profile based on ${escapeHtml(clone.name)} ${escapeHtml(clone.surname)}.` : 'Create a new user profile.'}</p></div></section>
      <button type="button" class="back-link" data-page="user-management">← Back to users</button>
      <form id="managed-user-create-form" class="card user-create-card">
        <div class="grid-two">
          <label class="field"><span>First name</span><input name="name" maxlength="80" value="${escapeHtml(clone?.name || '')}" required /></label>
          <label class="field"><span>Last name</span><input name="surname" maxlength="80" value="${escapeHtml(clone?.surname || '')}" required /></label>
        </div>
        <label class="field"><span>Email</span><input name="email" type="email" maxlength="254" placeholder="Enter a unique email address" required /></label>
        <label class="field"><span>Phone number</span><input name="phone" type="tel" maxlength="30" value="${escapeHtml(clone?.phone || '')}" /></label>
        <div class="grid-two">
          <label class="field"><span>Department</span><select name="departmentId">
            <option value="">No department</option>
            ${state.departments.map(department => `<option value="${department.id}" ${department.id === clone?.departmentId ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Role</span><select name="role">${roles.map(item => `<option value="${escapeHtml(item)}" ${item === role ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Groups</span><select name="groupIds" multiple size="5">
          ${state.groups.map(group => `<option value="${group.id}" ${clone?.groups?.some(item => item.id === group.id) ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
        </select><small>New memberships start as Members. Group roles can be changed in Groups.</small></label>
        <div class="user-create-footer"><span>New users cannot sign in until an Administrator sets their initial password.</span><button type="submit" class="primary">Create user</button></div>
      </form>
    `;
  }

  function renderManagedUserDetail() {
    if (!state.user.canManageUsers) return '<p>Human Resources group membership or Administrator role required.</p>';
    const user = state.users.find(item => item.id === Number(state.managedUserId));
    if (!user) return `<section class="page-heading"><div><h1>User not found</h1></div></section><button type="button" class="back-link" data-page="user-management">← Back to users</button>`;
    const editing = state.managedUserEditing;
    const protectedAccount = state.user.role !== 'Administrator'
      && ['Administrator', 'Ticket Manager'].includes(user.role);
    const roles = state.user.role === 'Administrator'
      ? ['Employee', 'Ticket Manager', 'Administrator']
      : ['Employee'];
    const role = roles.includes(user.role) ? user.role : 'Employee';
    const field = (label, name, value, type = 'text') => `
      <label class="field user-profile-field"><span>${label}</span>
        <input name="${name}" type="${type}" value="${escapeHtml(value || '')}" ${editing && !protectedAccount ? '' : 'disabled'} ${name === 'phone' ? '' : 'required'} />
      </label>
    `;
    return `
      <section class="page-heading"><div><p class="eyebrow">USER PROFILE</p><h1>${escapeHtml(user.name)} ${escapeHtml(user.surname)}</h1><p>Account details and recent tickets opened by this user.</p></div><button type="button" class="back-link" data-page="user-management">← Back to users</button></section>
      <div class="managed-user-detail-layout">
        <form id="managed-user-edit-form" class="managed-user-detail-main">
          <section class="card managed-user-info">
            <div class="managed-user-section-heading"><div><p class="eyebrow">PROFILE</p><h2>Personal information</h2></div><span class="badge ${user.isActive ? 'user-active' : 'user-disabled'}">${user.isActive ? 'Active' : 'Disabled'}</span></div>
            <div class="grid-two">
              ${field('First name', 'name', user.name)}
              ${field('Last name', 'surname', user.surname)}
              ${field('Email', 'email', user.email, 'email')}
              ${field('Phone number', 'phone', user.phone, 'tel')}
            </div>
            <div class="grid-two">
              <label class="field user-profile-field"><span>Department</span><select name="departmentId" ${editing && !protectedAccount ? '' : 'disabled'}>
                <option value="">No department</option>${state.departments.map(department => `<option value="${department.id}" ${department.id === user.departmentId ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}
              </select></label>
              <label class="field user-profile-field"><span>Account role</span><select name="role" ${editing && !protectedAccount ? '' : 'disabled'}>
                ${roles.map(item => `<option value="${escapeHtml(item)}" ${item === role ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
              </select></label>
            </div>
          </section>
          <section class="card managed-user-groups">
            <div class="managed-user-section-heading"><div><p class="eyebrow">MEMBERSHIP</p><h2>Groups</h2></div></div>
            ${editing && !protectedAccount ? `<label class="field"><span>Select group memberships</span><select name="groupIds" multiple size="5">${state.groups.map(group => `<option value="${group.id}" ${user.groups.some(item => item.id === group.id) ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select></label>` : `<div class="user-group-chips">${user.groups.map(group => `<span class="badge">${escapeHtml(group.name)} · ${escapeHtml(group.role)}</span>`).join('') || '<span class="empty-state">No group memberships.</span>'}</div>`}
          </section>
          <section class="card managed-user-tickets">
            <div class="managed-user-section-heading"><div><p class="eyebrow">HISTORY</p><h2>Latest tickets opened</h2></div><span>${state.managedUserTickets.length} / 10</span></div>
            <div class="managed-user-ticket-list">
              ${state.managedUserTickets.map(ticket => `
                <button type="button" class="managed-user-ticket" data-action="open-managed-ticket" data-ticket-id="${ticket.id}">
                  <span><strong>#${ticket.id} · ${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(ticket.groupName || 'Unassigned')} · ${displayDate(ticket.createdAt)}</small></span>
                  <span class="badge priority-${String(ticket.priority).toLowerCase()}">${escapeHtml(ticket.priority)}</span>
                  <span class="badge status-${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>
                </button>
              `).join('') || '<p class="empty-state">No visible tickets opened by this user.</p>'}
            </div>
            ${editing && !protectedAccount ? '<div class="managed-user-save"><button type="submit" class="primary">Save changes</button></div>' : ''}
          </section>
        </form>
        <aside class="card managed-user-actions-panel">
          <p class="eyebrow">ACTIONS</p>
          <button type="button" class="primary" data-action="toggle-user-edit" ${protectedAccount ? 'disabled title="Only Administrators can edit privileged accounts."' : ''}>${editing ? 'Cancel edit' : 'Edit user'}</button>
          ${state.user.role === 'Administrator' ? `
            <label class="field"><span>Set password (12+ characters)</span><input id="managed-user-password" type="password" minlength="12" maxlength="200" autocomplete="new-password" /></label>
            <button type="button" data-action="set-managed-user-password" data-user-id="${user.id}">Set password</button>
          ` : ''}
          ${!user.isRemoved ? `<button type="button" data-action="toggle-user-active" data-user-id="${user.id}" data-active="${user.isActive ? 'false' : 'true'}" ${protectedAccount || user.id === state.user.id ? 'disabled' : ''}>${user.isActive ? 'Disable user' : 'Enable user'}</button>` : ''}
          <button type="button" class="danger-button" data-action="remove-managed-user" data-user-id="${user.id}" ${protectedAccount || user.isRemoved || user.id === state.user.id ? 'disabled' : ''}>Remove user</button>
          ${protectedAccount ? '<small>Only Administrators can change privileged accounts.</small>' : ''}
        </aside>
      </div>
    `;
  }

  // Render group creation/deletion controls for Administrators.
  function renderGroups() {
    if (state.user.role !== 'Administrator') return '<p>Administrator access required.</p>';
    return `
      <section class="card" style="padding:1rem;">
        <h3>Group management</h3>
        <p>Members can take tickets themselves or request another member’s approval. Team Leaders can manage every ticket in their group.</p>
        <div class="inline-actions group-create">
          <label class="field"><span>New group name</span><input id="group-name" maxlength="80" /></label>
          <button type="button" class="primary" data-action="create-group">Create group</button>
        </div>
        <div class="ticket-list group-list">
          ${state.groups.map(group => {
            const members = state.users.filter(user => user.groups.some(item => item.id === group.id));
            const available = state.users.filter(user => !user.groups.some(item => item.id === group.id));
            return `
              <article class="ticket-item">
                <div class="row">
                  <strong>${escapeHtml(group.name)}</strong>
                  <button type="button" data-action="delete-group" data-group-id="${group.id}">Delete group</button>
                </div>
                <div class="group-members">
                  ${members.map(user => `
                    <div class="row">
                      <span>${escapeHtml(user.name)} ${escapeHtml(user.surname)} · ${escapeHtml(user.role)}</span>
                      <label class="field group-role-control">
                        <span>Group role</span>
                        <select id="member-role-${group.id}-${user.id}">
                          ${['Member', 'Team Leader'].map(role => `
                            <option value="${role}" ${user.groups.find(item => item.id === group.id)?.role === role ? 'selected' : ''}>${role}</option>
                          `).join('')}
                        </select>
                      </label>
                      <button type="button" data-action="save-member-role" data-group-id="${group.id}" data-user-id="${user.id}">Save role</button>
                      <button type="button" data-action="remove-member" data-group-id="${group.id}" data-user-id="${user.id}">Remove</button>
                    </div>
                  `).join('') || '<p>No users in this group.</p>'}
                </div>
                ${available.length ? `
                  <div class="inline-actions">
                    <label class="field">
                      <span>Add user</span>
                      <select id="group-user-${group.id}">
                        ${available.map(user => `<option value="${user.id}">${escapeHtml(user.name)} ${escapeHtml(user.surname)} · ${escapeHtml(user.role)}</option>`).join('')}
                      </select>
                    </label>
                    <label class="field">
                      <span>Group role</span>
                      <select id="group-role-${group.id}">
                        <option value="Member">Member</option>
                        <option value="Team Leader">Team Leader</option>
                      </select>
                    </label>
                    <button type="button" data-action="add-member" data-group-id="${group.id}">Add to group</button>
                  </div>
                ` : ''}
              </article>
            `;
          }).join('') || '<p>No groups yet. Create one to get started.</p>'}
        </div>
      </section>
    `;
  }

  // Render CRUD controls for the department records, separate from ticket groups.
  function renderDepartments() {
    if (!state.user.canManageUsers) return '<p>Human Resources group membership or Administrator role required.</p>';
    return `
      <section class="card" style="padding:1rem;">
        <h3>Department management</h3>
        <form id="new-department-form" class="inline-actions group-create">
          <label class="field"><span>New department name</span><input name="name" maxlength="80" required /></label>
          <button type="submit" class="primary">Create department</button>
        </form>
        <div class="ticket-list department-list">
          ${state.departments.map(department => `
            <form class="ticket-item department-form" data-department-id="${department.id}">
              <label class="field">
                <span>Department name</span>
                <input name="name" maxlength="80" value="${escapeHtml(department.name)}" required />
              </label>
              <div class="inline-actions">
                <button type="submit" class="primary">Save changes</button>
                <button type="button" data-action="delete-department" data-department-id="${department.id}">Delete department</button>
              </div>
            </form>
          `).join('') || '<p>No departments yet. Create one to get started.</p>'}
        </div>
      </section>
    `;
  }

  // Render the shared navigation and content for the selected page.
  function renderShell() {
    const content = {
      dashboard: renderDashboard,
      calendar: renderCalendar,
      'my-tickets': () => renderTicketList(false),
      'team-queue': renderQueue,
      assignments: renderAssignmentRequests,
      'ticket-detail': renderTicketDetail,
      'add-ticket': renderNewTicket,
      settings: renderSettings,
      'user-management': renderUserManagement,
      'user-detail': renderUserDetail,
      'user-create': renderManagedUserCreate,
      'managed-user-detail': renderManagedUserDetail,
      groups: renderGroups,
      departments: renderDepartments
    }[state.page] || renderTicketList;
    const ticketPage = ['my-tickets', 'team-queue', 'add-ticket', 'ticket-detail', 'assignments'].includes(state.page);
    app.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <button type="button" class="brand" data-page="dashboard"><span class="brand-mark">H</span><span>HelpDesk<span class="brand-light">Portal</span></span></button>
          <div class="topbar-right"><span class="user-badge">${escapeHtml(state.user.name)} ${escapeHtml(state.user.surname)}</span><button type="button" class="avatar avatar-small" data-page="settings" aria-label="Account settings">${escapeHtml(`${state.user.name[0] || ''}${state.user.surname[0] || ''}`.toUpperCase())}</button></div>
        </header>
        <nav class="main-navigation" aria-label="Main navigation">
          <button type="button" data-page="dashboard" class="${state.page === 'dashboard' ? 'active' : ''}"><span>◫</span> Dashboard</button>
          <button type="button" data-page="calendar" class="${state.page === 'calendar' ? 'active' : ''}"><span>▦</span> Calendar</button>
          <button type="button" data-action="toggle-tickets" aria-expanded="${state.ticketsExpanded || ticketPage}"><span>▤</span> Tickets <span class="nav-chevron">⌄</span></button>
          <button type="button" data-page="user-management" class="${['user-management', 'user-detail', 'user-create', 'managed-user-detail'].includes(state.page) ? 'active' : ''}"><span>♙</span> Users</button>
          <button type="button" data-page="settings" class="${['settings', 'groups', 'departments'].includes(state.page) ? 'active' : ''}"><span>⚙</span> Settings</button>
        </nav>
        ${state.ticketsExpanded || ticketPage ? `
          <nav class="ticket-subnav" aria-label="Ticket pages">
            <button type="button" data-page="my-tickets" class="${state.page === 'my-tickets' ? 'active' : ''}">My Tickets</button>
            <button type="button" data-page="team-queue" class="${state.page === 'team-queue' ? 'active' : ''}">Team Queue</button>
            <button type="button" data-page="add-ticket" class="${state.page === 'add-ticket' ? 'active' : ''}">Add Ticket</button>
            <button type="button" data-page="assignments" class="${state.page === 'assignments' ? 'active' : ''}">Assignment Requests</button>
          </nav>` : ''}
        <main class="page">${renderError()}${content()}</main>
        <footer class="app-footer"><span>HelpDesk Portal</span><span>${escapeHtml(state.user.role)}</span><button type="button" data-action="logout">Log out</button></footer>
      </div>
    `;
    wireEvents();
  }

  let calendarDrag = null;
  let suppressedActivityClick = null;

  function finishCalendarDrag(event, save) {
    const drag = calendarDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    calendarDrag = null;
    drag.activityElement.style.visibility = '';
    drag.preview.remove();
    document.body.classList.remove('calendar-dragging');
    if (!save || !drag.didMove) return;

    suppressedActivityClick = String(drag.activityId);
    (async () => {
      state.error = '';
      try {
        await api(`/api/activities/${drag.activityId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            activityDate: drag.targetDate,
            startMinute: drag.startMinute,
            timeUsedMinutes: drag.duration
          })
        });
        state.selectedCalendarDate = drag.targetDate;
        state.calendarMonth = new Date(
          Number(drag.targetDate.slice(0, 4)),
          Number(drag.targetDate.slice(5, 7)) - 1,
          1
        );
        await loadPageData();
      } catch (error) {
        state.error = error.message;
      }
      render();
    })();
  }

  function wireCalendarDragging() {
    app.querySelectorAll('.calendar-draggable-activity').forEach(activityElement => {
      activityElement.addEventListener('pointerdown', event => {
        if (event.button !== 0 || calendarDrag) return;
        const rect = activityElement.getBoundingClientRect();
        const activity = state.calendarWorkActivities.find(item => String(item.id) === activityElement.dataset.activityId);
        if (!activity) return;
        const resizeHandle = event.target.closest('[data-resize]');
        const preview = activityElement.cloneNode(true);
        preview.classList.add('calendar-activity-preview');
        preview.setAttribute('aria-hidden', 'true');
        preview.style.position = 'fixed';
        preview.style.left = `${rect.left}px`;
        preview.style.top = `${rect.top}px`;
        preview.style.width = `${rect.width}px`;
        preview.style.height = `${rect.height}px`;
        preview.style.pointerEvents = 'none';
        document.body.append(preview);
        activityElement.style.visibility = 'hidden';
        document.body.classList.add('calendar-dragging');
        calendarDrag = {
          activityElement,
          activityId: activity.id,
          pointerId: event.pointerId,
          initialY: event.clientY,
          initialStart: Number(activity.startMinute),
          initialDuration: Number(activity.timeUsedMinutes),
          startMinute: Number(activity.startMinute),
          duration: Number(activity.timeUsedMinutes),
          targetDate: activity.activityDate,
          resize: resizeHandle?.dataset.resize || '',
          isScheduleActivity: activityElement.classList.contains('calendar-activity'),
          preview,
          rect,
          didMove: false,
          lastMonthDirection: 0
        };
        event.preventDefault();
      });
    });
  }

  window.addEventListener('pointermove', event => {
    const drag = calendarDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientY - drag.initialY;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const timeGrid = target?.closest('[data-calendar-time-grid]');
    if (Math.abs(delta) > 3) drag.didMove = true;
    if (drag.didMove) {
      const snap = value => Math.round(value / 15) * 15;
      if (drag.isScheduleActivity && timeGrid) {
        if (drag.resize === 'top') {
          const end = drag.initialStart + drag.initialDuration;
          drag.startMinute = Math.max(0, Math.min(end - 15, snap(drag.initialStart + delta)));
          drag.duration = end - drag.startMinute;
        } else if (drag.resize === 'bottom') {
          drag.startMinute = drag.initialStart;
          drag.duration = Math.max(15, Math.min(1440 - drag.initialStart, snap(drag.initialDuration + delta)));
        } else {
          drag.duration = drag.initialDuration;
          drag.startMinute = Math.max(0, Math.min(1440 - drag.duration, snap(drag.initialStart + delta)));
        }
      } else {
        drag.startMinute = drag.initialStart;
        drag.duration = drag.initialDuration;
      }
      const previewOffset = drag.resize === 'top' && drag.isScheduleActivity && timeGrid
        ? drag.startMinute - drag.initialStart
        : delta;
      drag.preview.style.top = `${drag.rect.top + previewOffset}px`;
      drag.preview.style.height = `${drag.duration}px`;
    }

    if (state.page !== 'calendar') return;
    const dayCell = target?.closest('[data-calendar-drop-date]');
    if (dayCell) drag.targetDate = dayCell.dataset.calendarDropDate;

    const arrow = target?.closest('[data-action="calendar-previous"], [data-action="calendar-next"]');
    if (!arrow) {
      drag.lastMonthDirection = 0;
      return;
    }
    const direction = arrow.dataset.action === 'calendar-next' ? 1 : -1;
    if (drag.lastMonthDirection === direction) return;
    drag.lastMonthDirection = direction;
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() + direction,
      1
    );
    render();
  });

  window.addEventListener('pointerup', event => finishCalendarDrag(event, true));
  window.addEventListener('pointercancel', event => finishCalendarDrag(event, false));

  // Refresh the current page after a mutation and show explicit API errors.
  async function refreshAfter(action) {
    state.error = '';
    try {
      await action();
      await loadPageData();
    } catch (error) {
      state.error = error.message;
    }
    render();
  }

  // Connect visible controls to API calls; the server enforces every permission.
  function wireEvents() {
    app.querySelectorAll('[data-page]').forEach(button => {
      button.addEventListener('click', async () => {
        await navigate(button.dataset.page);
      });
    });

    app.querySelector('[data-action="toggle-tickets"]')?.addEventListener('click', () => {
      state.ticketsExpanded = !state.ticketsExpanded;
      render();
    });

    app.querySelectorAll('.ticket-preview').forEach(preview => {
      const openTicket = async () => {
        state.selectedTicket = { id: Number(preview.dataset.ticketId) };
        state.previousTicketPage = state.page;
        await navigate('ticket-detail');
      };
      preview.addEventListener('click', event => {
        if (event.target.closest('button, select, input, a, label, .inline-actions')) return;
        openTicket();
      });
      preview.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.target.closest('button, select, input, a')) openTicket();
      });
    });

    app.querySelectorAll('[data-action="open-event-ticket"]').forEach(button => {
      button.addEventListener('click', async () => {
        if (button.dataset.activityId === suppressedActivityClick) {
          suppressedActivityClick = null;
          return;
        }
        state.selectedTicket = { id: Number(button.dataset.ticketId) };
        state.previousTicketPage = state.page;
        await navigate('ticket-detail');
      });
    });

    app.querySelectorAll('[data-action="open-managed-user"]').forEach(button => {
      button.addEventListener('click', async () => {
        state.managedUserId = Number(button.dataset.userId);
        state.managedUserEditing = false;
        await navigate('managed-user-detail');
      });
    });

    app.querySelectorAll('[data-action="open-user"]').forEach(button => {
      button.addEventListener('click', async () => {
        state.selectedUser = state.directoryUsers.find(user => user.id === Number(button.dataset.userId)) || null;
        await navigate('user-detail');
      });
    });

    app.querySelectorAll('[data-action="open-managed-ticket"]').forEach(button => {
      button.addEventListener('click', async () => {
        state.selectedTicket = { id: Number(button.dataset.ticketId) };
        state.previousTicketPage = state.page;
        await navigate('ticket-detail');
      });
    });

    app.querySelector('[data-action="back-from-ticket"]')?.addEventListener('click', async () => {
      await navigate(state.previousTicketPage || 'my-tickets');
    });

    app.querySelectorAll('[data-action="ticket-tab"]').forEach(button => {
      button.addEventListener('click', () => {
        state.ticketTab = button.dataset.tab;
        render();
      });
    });

    app.querySelectorAll('[data-action="calendar-day"]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedCalendarDate = button.dataset.date;
        render();
      });
    });
    app.querySelectorAll('[data-action="calendar-select-day"]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedCalendarDate = button.dataset.calendarDropDate;
        state.calendarMonth = new Date(
          Number(state.selectedCalendarDate.slice(0, 4)),
          Number(state.selectedCalendarDate.slice(5, 7)) - 1,
          1
        );
        render();
      });
    });
    app.querySelector('[data-action="calendar-previous"]')?.addEventListener('click', () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
      state.selectedCalendarDate = '';
      render();
    });
    app.querySelector('[data-action="calendar-next"]')?.addEventListener('click', () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
      state.selectedCalendarDate = '';
      render();
    });
    wireCalendarDragging();

    ['ticket-search', 'ticket-priority-filter', 'ticket-status-filter', 'ticket-sort'].forEach(id => {
      const control = app.querySelector(`#${id}`);
      control?.addEventListener(id === 'ticket-search' ? 'input' : 'change', () => {
        const cursor = id === 'ticket-search' ? control.selectionStart : null;
        state.ticketFilters = {
          query: app.querySelector('#ticket-search')?.value || '',
          priority: app.querySelector('#ticket-priority-filter')?.value || '',
          status: app.querySelector('#ticket-status-filter')?.value || '',
          sort: app.querySelector('#ticket-sort')?.value || 'created-desc'
        };
        render();
        if (id === 'ticket-search') {
          const search = app.querySelector('#ticket-search');
          search.focus();
          search.setSelectionRange(cursor, cursor);
        }
      });
    });

    app.querySelector('#password-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
        state.error = 'New password and confirmation do not match.';
        render();
        return;
      }
      refreshAfter(async () => {
        await api('/api/auth/password', {
          method: 'PATCH',
          body: JSON.stringify({
            currentPassword: form.elements.currentPassword.value,
            newPassword: form.elements.newPassword.value
          })
        });
        state.success = 'Your password was updated successfully.';
      });
    });

    app.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
        state.user = null;
        state.selectedTicket = null;
        state.page = 'dashboard';
        render();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });

    app.querySelectorAll('[data-action="save-status"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        await api(`/api/tickets/${state.selectedTicket.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: button.dataset.status })
        });
      }));
    });

    app.querySelectorAll('[data-action="assign-ticket"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        const ticketId = button.dataset.ticketId;
        const value = app.querySelector(`#assignee-${ticketId}`).value;
        await api(`/api/tickets/${ticketId}/assignee`, {
          method: 'PATCH',
          body: JSON.stringify({ assigneeId: value ? Number(value) : null })
        });
      }));
    });

    app.querySelectorAll('[data-action="assign-self"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        await api(`/api/tickets/${button.dataset.ticketId}/assignee`, {
          method: 'PATCH',
          body: JSON.stringify({ assigneeId: state.user.id })
        });
      }));
    });

    app.querySelectorAll('[data-action="request-assignment"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        const targetUserId = Number(app.querySelector(`#request-assignee-${button.dataset.ticketId}`).value);
        await api(`/api/tickets/${button.dataset.ticketId}/assignment-requests`, {
          method: 'POST',
          body: JSON.stringify({ targetUserId })
        });
      }));
    });

    app.querySelectorAll('[data-action="decide-assignment"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        await api(`/api/assignment-requests/${button.dataset.requestId}`, {
          method: 'PATCH',
          body: JSON.stringify({ decision: button.dataset.decision })
        });
      }));
    });

    app.querySelector('[data-action="create-ticket"]')?.addEventListener('click', () => refreshAfter(async () => {
      await api('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({
          subject: app.querySelector('#ticket-subject').value,
          description: app.querySelector('#ticket-description').value,
          priority: app.querySelector('#ticket-priority').value,
          groupId: Number(app.querySelector('#ticket-group').value)
        })
      });
      state.page = 'my-tickets';
    }));

    app.querySelector('[data-action="add-comment"]')?.addEventListener('click', () => refreshAfter(async () => {
      await api(`/api/tickets/${state.selectedTicket.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: app.querySelector('#new-comment').value,
          type: app.querySelector('#comment-type').value
        })
      });
    }));

    app.querySelector('#activity-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      refreshAfter(async () => {
        await api(`/api/tickets/${state.selectedTicket.id}/activities`, {
          method: 'POST',
          body: JSON.stringify({
            timeUsedMinutes: Number(form.elements.timeUsedMinutes.value),
            activityDate: form.elements.activityDate.value,
            startMinute: form.elements.startTime.value.split(':').reduce((hours, part) => hours * 60 + Number(part), 0),
            description: form.elements.description.value
          })
        });
      });
    });

    app.querySelector('[data-action="create-group"]')?.addEventListener('click', () => refreshAfter(async () => {
      const name = app.querySelector('#group-name').value;
      await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
    }));

    app.querySelectorAll('[data-action="delete-group"]').forEach(button => {
      button.addEventListener('click', () => {
        const group = state.groups.find(item => item.id === Number(button.dataset.groupId));
        if (!group || !confirm(`Delete "${group.name}" and remove its memberships?`)) return;
        refreshAfter(async () => {
          await api(`/api/groups/${group.id}`, { method: 'DELETE', body: '{}' });
        });
      });
    });

    app.querySelectorAll('[data-action="add-member"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        const groupId = button.dataset.groupId;
        const userId = app.querySelector(`#group-user-${groupId}`).value;
        const role = app.querySelector(`#group-role-${groupId}`).value;
        await api(`/api/groups/${groupId}/members`, {
          method: 'POST',
          body: JSON.stringify({ userId: Number(userId), role })
        });
      }));
    });

    app.querySelectorAll('[data-action="save-member-role"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        const role = app.querySelector(`#member-role-${button.dataset.groupId}-${button.dataset.userId}`).value;
        await api(`/api/groups/${button.dataset.groupId}/members/${button.dataset.userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ role })
        });
      }));
    });

    app.querySelectorAll('[data-action="remove-member"]').forEach(button => {
      button.addEventListener('click', () => refreshAfter(async () => {
        await api(`/api/groups/${button.dataset.groupId}/members/${button.dataset.userId}`, {
          method: 'DELETE',
          body: '{}'
        });
      }));
    });

    app.querySelector('[data-action="add-managed-user"]')?.addEventListener('click', async () => {
      state.clonedUser = null;
      await navigate('user-create');
    });

    app.querySelector('[data-action="clone-managed-user"]')?.addEventListener('click', async () => {
      const user = state.users.find(item => item.id === state.selectedManagementUserIds[0]);
      if (!user) return;
      state.clonedUser = {
        ...user,
        groups: user.groups.map(group => ({ ...group }))
      };
      state.selectedManagementUserIds = [];
      await navigate('user-create');
    });

    app.querySelector('[data-action="toggle-disabled-users"]')?.addEventListener('change', event => {
      state.showDisabledUsers = event.currentTarget.checked;
      render();
    });

    app.querySelector('[data-action="select-all-managed-users"]')?.addEventListener('change', event => {
      const visibleIds = state.users
        .filter(user => (state.showDisabledUsers || user.isActive)
          && user.id !== state.user.id
          && (state.user.role === 'Administrator' || !['Administrator', 'Ticket Manager'].includes(user.role)))
        .map(user => user.id);
      state.selectedManagementUserIds = event.currentTarget.checked
        ? [...new Set([...state.selectedManagementUserIds, ...visibleIds])]
        : state.selectedManagementUserIds.filter(id => !visibleIds.includes(id));
      render();
    });

    app.querySelectorAll('[data-action="select-managed-user"]').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const userId = Number(event.currentTarget.dataset.userId);
        state.selectedManagementUserIds = event.currentTarget.checked
          ? [...new Set([...state.selectedManagementUserIds, userId])]
          : state.selectedManagementUserIds.filter(id => id !== userId);
        render();
      });
    });

    app.querySelector('[data-action="batch-remove-users"]')?.addEventListener('click', () => {
      const count = state.selectedManagementUserIds.length;
      if (!count || !confirm(`Remove ${count} selected ${count === 1 ? 'user' : 'users'}? Their ticket history will be retained.`)) return;
      refreshAfter(async () => {
        await api('/api/users', {
          method: 'DELETE',
          body: JSON.stringify({ userIds: state.selectedManagementUserIds })
        });
        state.selectedManagementUserIds = [];
      });
    });

    app.querySelector('#managed-user-create-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const groupIds = [...form.elements.groupIds.selectedOptions].map(option => Number(option.value));
      refreshAfter(async () => {
        await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            name: form.elements.name.value,
            surname: form.elements.surname.value,
            email: form.elements.email.value,
            phone: form.elements.phone.value,
            departmentId: form.elements.departmentId.value || null,
            role: form.elements.role.value,
            groupIds
          })
        });
        state.clonedUser = null;
        state.page = 'user-management';
      });
    });

    app.querySelector('[data-action="toggle-user-edit"]')?.addEventListener('click', () => {
      state.managedUserEditing = !state.managedUserEditing;
      render();
    });

    app.querySelector('#managed-user-edit-form')?.addEventListener('submit', event => {
      event.preventDefault();
      if (!state.managedUserEditing) return;
      const form = event.currentTarget;
      const groupIds = [...form.elements.groupIds.selectedOptions].map(option => Number(option.value));
      refreshAfter(async () => {
        await api(`/api/users/${state.managedUserId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.elements.name.value,
            surname: form.elements.surname.value,
            email: form.elements.email.value,
            phone: form.elements.phone.value,
            departmentId: form.elements.departmentId.value || null,
            role: form.elements.role.value,
            groupIds
          })
        });
        state.managedUserEditing = false;
      });
    });

    app.querySelector('[data-action="toggle-user-active"]')?.addEventListener('click', button => {
      const user = state.users.find(item => item.id === Number(button.currentTarget.dataset.userId));
      if (!user) return;
      const isActive = button.currentTarget.dataset.active === 'true';
      if (!confirm(`${isActive ? 'Enable' : 'Disable'} ${user.name} ${user.surname}?`)) return;
      refreshAfter(async () => {
        await api(`/api/users/${user.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive })
        });
      });
    });

    app.querySelector('[data-action="remove-managed-user"]')?.addEventListener('click', button => {
      const user = state.users.find(item => item.id === Number(button.currentTarget.dataset.userId));
      if (!user || !confirm(`Remove ${user.name} ${user.surname}? Their ticket history will be retained.`)) return;
      refreshAfter(async () => {
        await api(`/api/users/${user.id}`, { method: 'DELETE', body: '{}' });
        state.managedUserId = null;
        state.managedUserTickets = [];
        state.managedUserEditing = false;
        state.page = 'user-management';
      });
    });

    app.querySelector('[data-action="set-managed-user-password"]')?.addEventListener('click', button => {
      const password = app.querySelector('#managed-user-password').value;
      if (password.length < 12) {
        state.error = 'Use a password between 12 and 200 characters.';
        render();
        return;
      }
      (async () => {
        state.error = '';
        await api(`/api/users/${button.currentTarget.dataset.userId}/password`, {
          method: 'PATCH',
          body: JSON.stringify({ password })
        });
        state.success = 'Password updated. The user must sign in with the new password.';
        render();
      })().catch(error => {
        state.error = error.message;
        render();
      });
    });

    app.querySelector('#new-department-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const name = event.currentTarget.elements.name.value;
      refreshAfter(async () => {
        await api('/api/departments', { method: 'POST', body: JSON.stringify({ name }) });
      });
    });

    app.querySelectorAll('.department-form').forEach(form => {
      form.addEventListener('submit', event => {
        event.preventDefault();
        refreshAfter(async () => {
          await api(`/api/departments/${form.dataset.departmentId}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: form.elements.name.value })
          });
        });
      });
    });

    app.querySelectorAll('[data-action="delete-department"]').forEach(button => {
      button.addEventListener('click', () => {
        const department = state.departments.find(item => item.id === Number(button.dataset.departmentId));
        if (!department || !confirm(`Delete "${department.name}"? Users assigned to it will have no department.`)) return;
        refreshAfter(async () => {
          await api(`/api/departments/${department.id}`, { method: 'DELETE', body: '{}' });
        });
      });
    });
  }

  // Initialize the session from its HttpOnly cookie and load the initial ticket view.
  async function initialize() {
    try {
      const result = await api('/api/auth/me');
      state.user = result.user;
      await loadPageData();
      render();
    } catch (error) {
      if (error.message !== 'Authentication required.' && error.message !== 'Session expired or invalid.') {
        state.error = error.message;
      }
      render();
    }
  }

  // Choose the login or authenticated application view.
  function render() {
    if (!state.user) renderLogin();
    else renderShell();
  }

  initialize();
})();
