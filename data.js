(function (global) {
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

  const users = [
    { id: 1, name: 'Alice', surname: 'Doe', email: 'employee@company.com', department: 'Sales', role: 'Employee', manager: 3 },
    { id: 2, name: 'Marco', surname: 'Rossi', email: 'agent@company.com', department: 'IT Support', role: 'Support', manager: 3 },
    { id: 3, name: 'Sofia', surname: 'Neri', email: 'manager@company.com', department: 'Operations', role: 'Ticket Manager', manager: 4 },
    { id: 4, name: 'David', surname: 'King', email: 'admin@company.com', department: 'Admin', role: 'Administrator' }
  ];

  const demoTickets = [
    {
      id: 101,
      subject: 'VPN not connecting from home office',
      description: 'After the latest update, remote employees cannot access the VPN from the laptop.',
      requesterId: 1,
      assigneeId: 2,
      department: 'IT Support',
      status: 'In Progress',
      priority: 'High',
      createdAt: '2026-10-10T09:20:00',
      dueDate: '2026-10-14',
      tags: ['network', 'remote']
    },
    {
      id: 102,
      subject: 'New printer driver request',
      description: 'Need a new printer driver installed for the storefront hardware.',
      requesterId: 1,
      assigneeId: 2,
      department: 'IT Support',
      status: 'Waiting for feedback',
      priority: 'Normal',
      createdAt: '2026-10-08T11:05:00',
      dueDate: '2026-10-16',
      tags: ['printer']
    },
    {
      id: 103,
      subject: 'CRM export delayed',
      description: 'Sales team cannot export leads, the operation times out repeatedly.',
      requesterId: 3,
      assigneeId: 2,
      department: 'Sales',
      status: 'Open',
      priority: 'Critical',
      createdAt: '2026-10-13T08:10:00',
      dueDate: '2026-10-13',
      tags: ['crm', 'sales']
    }
  ];

  const demoComments = [
    {
      id: 1,
      ticketId: 101,
      authorId: 1,
      author: 'Alice Doe',
      text: 'The issue started this morning after the VPN client updated.',
      type: 'public'
    },
    {
      id: 2,
      ticketId: 101,
      authorId: 2,
      author: 'Marco Rossi',
      text: 'Investigating NAT and VPN access logs.',
      type: 'internal'
    },
    {
      id: 3,
      ticketId: 102,
      authorId: 1,
      author: 'Alice Doe',
      text: 'Please confirm if we need a driver for Windows 11.',
      type: 'public'
    },
    {
      id: 4,
      ticketId: 103,
      authorId: 3,
      author: 'Sofia Neri',
      text: 'We need this escalated to the support queue.',
      type: 'internal'
    }
  ];

  const appData = {
    STORAGE_KEY: 'smart-helpdesk-demo',
    statusList,
    priorityList,
    users,
    demoTickets,
    demoComments
  };

  global.ticketData = appData;
})(window);
