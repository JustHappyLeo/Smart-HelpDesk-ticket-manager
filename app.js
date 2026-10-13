(function () {
  const { STORAGE_KEY, statusList, priorityList, users, demoTickets, demoComments } = window.ticketData;

  const app = document.getElementById('app');

  const state = {
    userEmail: null,
    page: 'tickets',
    selectedTicketId: demoTickets[0].id,
    tickets: loadTickets(),
    comments: demoComments.map(comment => ({ ...comment })),
    form: {
      subject: '',
      description: '',
      priority: 'Normal',
      department: 'IT Support'
    }
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeValue(value, maxLength = 500) {
    return escapeHtml(String(value ?? '')).slice(0, maxLength).trim();
  }

  function getCurrentUser() {
    return users.find(user => user.email === state.userEmail) || null;
  }

  function userRole() {
    return getCurrentUser()?.role || 'Employee';
  }

  function getUserById(id) {
    return users.find(user => user.id === id) || { name: 'Unknown', surname: '' };
  }

  function loadTickets() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Array.isArray(saved.tickets) && saved.tickets.length > 0) {
        return saved.tickets;
      }
    } catch (error) {
      console.warn('Unable to read saved ticket data.', error);
    }

    return JSON.parse(JSON.stringify(demoTickets));
  }

  function saveTickets() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tickets: state.tickets }));
    } catch (error) {
      console.warn('Unable to persist ticket data.', error);
    }
  }

  function normalizeStatus(status) {
    return String(status || '').toLowerCase().replace(/\s+/g, '-');
  }

  function ticketCounts() {
    return {
      total: state.tickets.length,
      open: state.tickets.filter(ticket => ['Open', 'In Progress', 'Waiting for feedback', 'Scheduled'].includes(ticket.status)).length,
      resolved: state.tickets.filter(ticket => ['Resolved', 'Closed'].includes(ticket.status)).length,
      critical: state.tickets.filter(ticket => ticket.priority === 'Critical').length
    };
  }

  function validateCreateTicket(subject, description) {
    const cleanedSubject = sanitizeValue(subject, 120);
    const cleanedDescription = sanitizeValue(description, 2000);

    if (!cleanedSubject || !cleanedDescription) {
      return { valid: false, message: 'Please provide both a subject and a description.' };
    }

    return {
      valid: true,
      subject: cleanedSubject,
      description: cleanedDescription
    };
  }

  function buildLoginView() {
    app.innerHTML = `
      <div class="page">
        <div class="card login-box">
          <h2>Sign in</h2>
          <div class="form-grid">
            <label class="field">
              <span>Email</span>
              <select id="login-user">
                ${users.map(user => `<option value="${user.email}">${escapeHtml(user.name)} ${escapeHtml(user.surname)} · ${escapeHtml(user.role)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span>Password</span>
              <input type="password" value="demo123" readonly aria-label="Password input" />
            </label>
            <button class="primary" id="login-button" type="button">Sign in</button>
          </div>
        </div>
      </div>
    `;

    const loginButton = document.getElementById('login-button');
    loginButton.addEventListener('click', () => {
      const selectedUser = document.getElementById('login-user').value;
      state.userEmail = selectedUser;
      state.page = 'tickets';
      render();
    });
  }

  function buildShell() {
    const currentUser = getCurrentUser();
    app.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand">Smart HelpDesk</div>
          <div class="user-badge">${escapeHtml(currentUser.name)} ${escapeHtml(currentUser.surname)} · ${escapeHtml(currentUser.role)}</div>
        </header>
        <nav class="navbar" aria-label="Main navigation">
          <button type="button" class="${state.page === 'tickets' ? 'active' : ''}" data-page="tickets">My tickets</button>
          <button type="button" class="${state.page === 'queue' ? 'active' : ''}" data-page="queue">Team queue</button>
          <button type="button" class="${state.page === 'ticket' ? 'active' : ''}" data-page="ticket">Ticket details</button>
          <button type="button" class="${state.page === 'new-ticket' ? 'active' : ''}" data-page="new-ticket">Create ticket</button>
          ${userRole() === 'Administrator' || userRole() === 'Ticket Manager' ? '<button type="button" class="' + (state.page === 'admin' ? 'active' : '') + '" data-page="admin">Admin</button>' : ''}
          <button type="button" class="secondary" data-action="logout">Log out</button>
        </nav>
        <main class="page">
          ${renderPageContent()}
        </main>
      </div>
    `;

    app.querySelectorAll('[data-page]').forEach(button => {
      button.addEventListener('click', () => {
        const page = button.dataset.page;
        if (page) {
          state.page = page;
          if (page === 'ticket' && !state.selectedTicketId) {
            state.selectedTicketId = state.tickets[0]?.id || null;
          }
          render();
        }
      });
    });

    app.querySelectorAll('[data-action="logout"]').forEach(button => {
      button.addEventListener('click', () => {
        state.userEmail = null;
        state.page = 'tickets';
        render();
      });
    });

    app.querySelectorAll('[data-action="open-ticket"]').forEach(button => {
      button.addEventListener('click', () => {
        const ticketId = Number(button.dataset.ticketId);
        state.selectedTicketId = ticketId;
        state.page = 'ticket';
        render();
      });
    });

    app.querySelectorAll('[data-action="change-status"]').forEach(button => {
      button.addEventListener('click', () => {
        const ticketId = Number(button.dataset.ticketId);
        const ticket = state.tickets.find(item => item.id === ticketId);
        if (!ticket) return;

        const nextStatus = statusList[Math.min(statusList.indexOf(ticket.status) + 1, statusList.length - 1)];
        ticket.status = nextStatus;
        saveTickets();
        render();
      });
    });

    app.querySelectorAll('[data-action="save-status"]').forEach(button => {
      button.addEventListener('click', () => {
        const ticketId = Number(button.dataset.ticketId);
        const selectedStatus = app.querySelector('#status-select-ticket')?.value;
        const ticket = state.tickets.find(item => item.id === ticketId);
        if (!ticket || !selectedStatus) return;

        ticket.status = selectedStatus;
        saveTickets();
        render();
      });
    });

    app.querySelectorAll('[data-action="assign-ticket"]').forEach(button => {
      button.addEventListener('click', () => {
        const ticketId = Number(button.dataset.ticketId);
        const ticket = state.tickets.find(item => item.id === ticketId);
        if (!ticket) return;

        ticket.assigneeId = getCurrentUser().id;
        saveTickets();
        render();
      });
    });

    app.querySelectorAll('[data-action="create-ticket"]').forEach(button => {
      button.addEventListener('click', () => {
        const subject = app.querySelector('#ticket-subject')?.value || '';
        const description = app.querySelector('#ticket-description')?.value || '';
        const priority = app.querySelector('#ticket-priority')?.value || 'Normal';
        const department = app.querySelector('#ticket-department')?.value || 'IT Support';

        const validation = validateCreateTicket(subject, description);
        if (!validation.valid) {
          alert(validation.message);
          return;
        }

        const currentUser = getCurrentUser();
        const newTicket = {
          id: Date.now(),
          subject: validation.subject,
          description: validation.description,
          requesterId: currentUser.id,
          assigneeId: currentUser.id,
          department,
          status: 'New',
          priority,
          createdAt: new Date().toISOString(),
          dueDate: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
          tags: ['new']
        };

        state.tickets.unshift(newTicket);
        state.form = { subject: '', description: '', priority: 'Normal', department: 'IT Support' };
        state.page = 'tickets';
        saveTickets();
        render();
      });
    });

    app.querySelectorAll('[data-action="add-comment"]').forEach(button => {
      button.addEventListener('click', () => {
        const ticketId = Number(button.dataset.ticketId);
        const textBox = app.querySelector('#new-comment');
        const text = sanitizeValue(textBox?.value || '', 1000);

        if (!text) {
          alert('Please type a reply before sending.');
          return;
        }

        const currentUser = getCurrentUser();
        state.comments.push({
          id: Date.now(),
          ticketId,
          authorId: currentUser.id,
          author: `${currentUser.name} ${currentUser.surname}`,
          text,
          type: currentUser.role === 'Employee' ? 'public' : 'internal'
        });

        textBox.value = '';
        render();
      });
    });
  }

  function renderPageContent() {
    switch (state.page) {
      case 'queue':
        return renderQueuePage();
      case 'ticket':
        return renderTicketDetailPage();
      case 'new-ticket':
        return renderNewTicketPage();
      case 'admin':
        return renderAdminPage();
      default:
        return renderTicketListPage();
    }
  }

  function renderTicketListPage() {
    const counts = ticketCounts();
    const currentUser = getCurrentUser();
    const visibleTickets = state.tickets.filter(ticket => {
      if (!currentUser) return false;
      if (currentUser.role === 'Administrator' || currentUser.role === 'Ticket Manager') return true;
      if (currentUser.role === 'Support') {
        return ticket.department === currentUser.department || ticket.assigneeId === currentUser.id || ticket.requesterId === currentUser.id;
      }
      return ticket.requesterId === currentUser.id;
    });

    return `
      <section class="stat-grid">
        <div class="stat">
          <span>Total tickets</span>
          <strong>${counts.total}</strong>
        </div>
        <div class="stat">
          <span>Open</span>
          <strong>${counts.open}</strong>
        </div>
        <div class="stat">
          <span>Resolved</span>
          <strong>${counts.resolved}</strong>
        </div>
        <div class="stat">
          <span>Critical</span>
          <strong>${counts.critical}</strong>
        </div>
      </section>

      <section class="card" style="padding:1rem;">
        <h3>My tickets</h3>
        <div class="ticket-list">
          ${visibleTickets.map(ticket => {
            const requester = getUserById(ticket.requesterId);
            const assignee = getUserById(ticket.assigneeId);
            return `
              <article class="ticket-item" data-ticket-id="${ticket.id}">
                <div class="row">
                  <div>
                    <strong>#${ticket.id} ${escapeHtml(ticket.subject)}</strong>
                  </div>
                  <div class="inline-actions">
                    <span class="badge priority-${String(ticket.priority || 'normal').toLowerCase()}">${escapeHtml(ticket.priority)}</span>
                    <span class="badge status-${normalizeStatus(ticket.status)}">${escapeHtml(ticket.status)}</span>
                  </div>
                </div>
                <div class="row">
                  <span>Requester: ${escapeHtml(requester.name)} ${escapeHtml(requester.surname)}</span>
                  <span>Assignee: ${escapeHtml(assignee.name)} ${escapeHtml(assignee.surname)}</span>
                </div>
                <div class="row">
                  <span>Department: ${escapeHtml(ticket.department)}</span>
                  <span>Due: ${escapeHtml(ticket.dueDate)}</span>
                </div>
                <div class="inline-actions">
                  <button type="button" class="secondary" data-action="open-ticket" data-ticket-id="${ticket.id}">View</button>
                  <button type="button" data-action="change-status" data-ticket-id="${ticket.id}">Update status</button>
                </div>
              </article>
            `;
          }).join('') || '<p>No tickets available for this account.</p>'}
        </div>
      </section>
    `;
  }

  function renderQueuePage() {
    const currentUser = getCurrentUser();
    const visibleTickets = state.tickets.filter(ticket => {
      if (!currentUser) return false;
      return currentUser.role === 'Administrator' || currentUser.role === 'Ticket Manager' || currentUser.role === 'Support' || currentUser.department === ticket.department;
    });

    return `
      <section class="card" style="padding:1rem;">
        <h3>Team queue</h3>
        <div class="ticket-list">
          ${visibleTickets.map(ticket => `
            <article class="ticket-item" data-ticket-id="${ticket.id}">
              <div class="row">
                <strong>#${ticket.id} ${escapeHtml(ticket.subject)}</strong>
                <span class="badge status-${normalizeStatus(ticket.status)}">${escapeHtml(ticket.status)}</span>
              </div>
              <div class="row">
                <span>${escapeHtml(ticket.department)}</span>
                <span class="badge priority-${String(ticket.priority || 'normal').toLowerCase()}">${escapeHtml(ticket.priority)}</span>
              </div>
              <div class="inline-actions">
                <button type="button" class="secondary" data-action="open-ticket" data-ticket-id="${ticket.id}">Open</button>
                <button type="button" data-action="assign-ticket" data-ticket-id="${ticket.id}">Assign to me</button>
              </div>
            </article>
          `).join('') || '<p>No team queue items.</p>'}
        </div>
      </section>
    `;
  }

  function renderTicketDetailPage() {
    const ticket = state.tickets.find(item => item.id === state.selectedTicketId) || state.tickets[0];
    if (!ticket) {
      return '<p>No ticket selected.</p>';
    }

    const comments = state.comments.filter(item => item.ticketId === ticket.id);

    return `
      <section class="detail-layout">
        <div class="panel">
          <h3>#${ticket.id} ${escapeHtml(ticket.subject)}</h3>
          <div class="inline-actions" style="margin-bottom:1rem;">
            <span class="badge priority-${String(ticket.priority || 'normal').toLowerCase()}">${escapeHtml(ticket.priority)}</span>
            <span class="badge status-${normalizeStatus(ticket.status)}">${escapeHtml(ticket.status)}</span>
          </div>
          <p>${escapeHtml(ticket.description)}</p>
          <h4>Conversation</h4>
          <div class="message-list">
            ${comments.map(comment => `
              <div class="message">
                <strong>${escapeHtml(comment.author)} · ${escapeHtml(comment.type)}</strong>
                <div>${escapeHtml(comment.text)}</div>
              </div>
            `).join('') || '<p>No comments yet.</p>'}
          </div>
          <div style="margin-top:1rem;">
            <textarea id="new-comment" placeholder="Write a reply..."></textarea>
            <div style="margin-top:0.5rem;">
              <button type="button" class="primary" data-action="add-comment" data-ticket-id="${ticket.id}">Send</button>
            </div>
          </div>
        </div>

        <aside class="panel">
          <h4>Ticket info</h4>
          <ul class="meta-list">
            <li><strong>Requester:</strong> ${escapeHtml(getUserById(ticket.requesterId).name)} ${escapeHtml(getUserById(ticket.requesterId).surname)}</li>
            <li><strong>Assignee:</strong> ${escapeHtml(getUserById(ticket.assigneeId).name)} ${escapeHtml(getUserById(ticket.assigneeId).surname)}</li>
            <li><strong>Department:</strong> ${escapeHtml(ticket.department)}</li>
            <li><strong>Created:</strong> ${escapeHtml(new Date(ticket.createdAt).toLocaleDateString())}</li>
            <li><strong>Due date:</strong> ${escapeHtml(ticket.dueDate)}</li>
            <li><strong>Tags:</strong> ${escapeHtml((ticket.tags || []).join(', '))}</li>
          </ul>
          <div style="margin-top:1rem;">
            <label class="field">
              <span>Change status</span>
              <select id="status-select-ticket">
                ${statusList.map(status => `<option value="${status}" ${status === ticket.status ? 'selected' : ''}>${escapeHtml(status)}</option>`).join('')}
              </select>
            </label>
            <div style="margin-top:0.5rem;">
              <button type="button" class="primary" data-action="save-status" data-ticket-id="${ticket.id}">Save status</button>
            </div>
          </div>
        </aside>
      </section>
    `;
  }

  function renderNewTicketPage() {
    return `
      <section class="card" style="padding:1rem;">
        <h3>Create ticket</h3>
        <div class="form-grid">
          <label class="field">
            <span>Subject</span>
            <input id="ticket-subject" value="${escapeHtml(state.form.subject)}" placeholder="Ex: Printer unavailable in HR office" maxlength="120" />
          </label>
          <label class="field">
            <span>Description</span>
            <textarea id="ticket-description" placeholder="Describe the issue..." maxlength="2000">${escapeHtml(state.form.description)}</textarea>
          </label>
          <div class="grid-two">
            <label class="field">
              <span>Priority</span>
              <select id="ticket-priority">
                ${priorityList.map(priority => `<option value="${priority}" ${state.form.priority === priority ? 'selected' : ''}>${escapeHtml(priority)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span>Department</span>
              <select id="ticket-department">
                ${['IT Support', 'Sales', 'Operations', 'HR'].map(dep => `<option value="${dep}" ${state.form.department === dep ? 'selected' : ''}>${escapeHtml(dep)}</option>`).join('')}
              </select>
            </label>
          </div>
          <button type="button" class="primary" data-action="create-ticket">Submit ticket</button>
        </div>
      </section>
    `;
  }

  function renderAdminPage() {
    return `
      <section class="card" style="padding:1rem;">
        <h3>Admin / settings</h3>
        <div class="ticket-list">
          ${users.map(user => `
            <article class="ticket-item">
              <div class="row">
                <strong>${escapeHtml(user.name)} ${escapeHtml(user.surname)}</strong>
                <span class="badge">${escapeHtml(user.role)}</span>
              </div>
              <div class="row">
                <span>${escapeHtml(user.email)}</span>
                <span>${escapeHtml(user.department)}</span>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    `;
  }

  function render() {
    if (!state.userEmail) {
      buildLoginView();
      return;
    }

    const currentUser = getCurrentUser();
    if (!currentUser) {
      state.userEmail = null;
      render();
      return;
    }

    buildShell();
  }

  render();
})();
