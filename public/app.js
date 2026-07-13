(function () {
  let supabase;
  let session;
  let tenant = { connected: true, businessName: '' };
  let contactsCache = [];
  let contactTagsCache = null;
  const contactFilters = { tags: [], dateFrom: '', dateTo: '' };

  const toast = (msg, isErr) => {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '') ;
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 3200);
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) {
      // The cached local session looked valid but the server rejected it
      // (e.g. the account was deleted) -- sign out to clear it, otherwise
      // login.html's own local-only session check just bounces back here,
      // forever.
      await supabase.auth.signOut();
      window.location.href = '/login.html';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.error === 'not_connected') {
        applyConnectionGate(false);
        throw new Error('Your account is not connected. Please contact your agency.');
      }
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // ---------- Tabs ----------
  function switchTab(tab) {
    const pill = document.querySelector(`.pill[data-tab="${tab}"]`);
    if (!pill || pill.classList.contains('soon')) return;
    document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'contacts') { loadContactTags(); loadContacts(); }
    if (tab === 'jobs') loadJobsTab();
    if (tab === 'calendar') loadCalendarTab();
    if (tab === 'reporting') loadReportingTab();
    if (tab === 'conversations') loadConversationsTab();
    else stopConvoPolling();
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill');
    if (!btn || !btn.dataset.tab) return;
    switchTab(btn.dataset.tab);
  });

  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-tab-link]');
    if (link) switchTab(link.dataset.tabLink);
  });

  // ---------- Dashboard ----------
  const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  let dashRange = { days: '', from: '', to: '' };
  let dashPipelinesLoaded = false;

  function computeRangeDates() {
    if (dashRange.days === 'custom') {
      return { from: dashRange.from || undefined, to: dashRange.to || undefined };
    }
    if (!dashRange.days) return { from: undefined, to: undefined };
    const to = new Date();
    const from = new Date(to.getTime() - Number(dashRange.days) * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  document.getElementById('rangebar').addEventListener('click', (e) => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    document.querySelectorAll('.rbtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const isCustom = btn.dataset.range === 'custom';
    document.getElementById('rangeFrom').style.display = isCustom ? 'inline-block' : 'none';
    document.getElementById('rangeSep').style.display = isCustom ? 'inline' : 'none';
    document.getElementById('rangeTo').style.display = isCustom ? 'inline-block' : 'none';
    dashRange.days = btn.dataset.range;
    if (!isCustom) loadDashboard();
  });

  ['rangeFrom', 'rangeTo'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      dashRange.from = document.getElementById('rangeFrom').value ? new Date(document.getElementById('rangeFrom').value).toISOString() : '';
      dashRange.to = document.getElementById('rangeTo').value ? new Date(document.getElementById('rangeTo').value).toISOString() : '';
      if (dashRange.from && dashRange.to) loadDashboard();
    });
  });

  document.getElementById('apptCalendarSelect').addEventListener('change', loadDashboard);
  document.getElementById('attentionPipelineSelect').addEventListener('change', loadDashboard);

  async function loadDashboard() {
    try {
      if (!dashPipelinesLoaded) {
        const [{ pipelines }, { calendars }] = await Promise.all([api('/pipelines'), api('/calendars')]);
        const pSel = document.getElementById('attentionPipelineSelect');
        pSel.innerHTML = '<option value="">All pipelines</option>' + pipelines.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
        const cSel = document.getElementById('apptCalendarSelect');
        cSel.innerHTML = '<option value="">All calendars</option>' + calendars.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
        dashPipelinesLoaded = true;
      }

      const { from, to } = computeRangeDates();
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const pipelineId = document.getElementById('attentionPipelineSelect').value;
      if (pipelineId) params.set('pipelineId', pipelineId);
      const calendarId = document.getElementById('apptCalendarSelect').value;
      if (calendarId) params.set('calendarId', calendarId);

      const dash = await api('/dashboard?' + params.toString());
      const kpis = document.getElementById('kpis').children;
      kpis[0].querySelector('.val').textContent = money(dash.totalRevenue);
      kpis[1].querySelector('.val').textContent = dash.newLeadsToday;
      kpis[2].querySelector('.val').textContent = money(dash.pipelineValue);
      kpis[3].querySelector('.val').textContent = dash.appointmentsBooked;

      const pipelineBox = document.getElementById('dashPipelineOverviews');
      pipelineBox.innerHTML = (dash.pipelineOverviews || [])
        .map(
          (p) => `
        <div class="dash-pipeline-block">
          <div class="ph">${p.pipelineName} <span class="muted">(${p.totalJobs} job${p.totalJobs === 1 ? '' : 's'})</span></div>
          <div class="stagebar">
            ${p.stageCounts.map((s) => `<div class="stagechip"><span class="n">${s.count}</span>${s.stageName}</div>`).join('') || '<span class="muted">No stages.</span>'}
          </div>
        </div>`
        )
        .join('') || '<span class="muted">No pipelines found.</span>';

      const apptBox = document.getElementById('dashUpcomingAppts');
      apptBox.innerHTML = (dash.upcomingAppointments || [])
        .map(
          (a) => `
        <div class="dash-row">
          <div><div class="name">${a.title || 'Appointment'}</div><div class="sub">${a.calendarName || ''}</div></div>
          <div class="sub">${new Date(a.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>`
        )
        .join('') || '<span class="muted">No upcoming appointments.</span>';

      loadDashboardUnreadConvos();

      const attentionBody = document.getElementById('attentionBody');
      attentionBody.innerHTML = '';
      if (!dash.jobsNeedingAttention?.length) {
        attentionBody.innerHTML = '<tr><td colspan="4" class="muted">No jobs need attention.</td></tr>';
      } else {
        dash.jobsNeedingAttention.forEach((j) => {
          const vehicle = [j.carMake, j.carModel].filter(Boolean).join(' ');
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>#${j.id}</td>
            <td>${j.customerName || '—'}${vehicle ? `<div class="muted" style="font-size:12px">${vehicle}</div>` : ''}</td>
            <td>${money(j.value)}</td>
            <td>${j.stageName || '—'}</td>
          `;
          attentionBody.appendChild(tr);
        });
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function loadDashboardUnreadConvos() {
    const box = document.getElementById('dashUnreadConvos');
    try {
      const { conversations } = await api('/conversations');
      const unread = (conversations || [])
        .filter((c) => c.unreadCount > 0)
        .sort((a, b) => new Date(b.lastMessageDate) - new Date(a.lastMessageDate))
        .slice(0, 5);
      box.innerHTML = unread.length
        ? unread
            .map(
              (c) => `
        <div class="dash-row" data-convo-jump="${c.id}">
          <div><div class="name">${c.contactName || c.fullName || 'Unknown'}</div><div class="sub">${c.phone || ''}</div></div>
          <span class="badge">${c.unreadCount}</span>
        </div>`
            )
            .join('')
        : '<span class="muted">No unread messages.</span>';
      box.querySelectorAll('[data-convo-jump]').forEach((el) => {
        el.addEventListener('click', async () => {
          switchTab('conversations');
          await loadConversationsTab();
          selectConversation(el.dataset.convoJump);
        });
      });
    } catch (err) {
      box.innerHTML = `<span class="muted">${err.message}</span>`;
    }
  }

  // ---------- Contacts ----------
  function contactName(c) {
    return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '(no name)';
  }

  let lastContactQuery = '';
  const selectedContactIds = new Set();

  function updateDeleteContactsUI() {
    const btn = document.getElementById('deleteContactsBtn');
    btn.style.display = selectedContactIds.size ? 'inline-flex' : 'none';
    document.getElementById('deleteContactsCount').textContent = selectedContactIds.size;
    const selectAll = document.getElementById('contactSelectAll');
    selectAll.checked = contactsCache.length > 0 && selectedContactIds.size === contactsCache.length;
  }

  async function loadContacts(query) {
    if (query !== undefined) lastContactQuery = query;
    selectedContactIds.clear();
    const body = document.getElementById('contactsBody');
    body.innerHTML = '<tr><td colspan="5" class="loading">Loading…</td></tr>';
    try {
      const params = new URLSearchParams();
      if (lastContactQuery) params.set('query', lastContactQuery);
      if (contactFilters.tags.length) params.set('tags', contactFilters.tags.join(','));
      if (contactFilters.dateFrom) params.set('dateFrom', contactFilters.dateFrom);
      if (contactFilters.dateTo) params.set('dateTo', contactFilters.dateTo);
      const qs = params.toString();
      const data = await api('/contacts' + (qs ? `?${qs}` : ''));
      contactsCache = data.contacts || [];
      body.innerHTML = '';
      updateDeleteContactsUI();
      if (!contactsCache.length) {
        body.innerHTML = '<tr><td colspan="5" class="muted">No contacts found.</td></tr>';
        return;
      }
      contactsCache.forEach((c) => {
        const tr = document.createElement('tr');
        tr.className = 'rowlink';
        tr.innerHTML = `
          <td><input type="checkbox" class="contact-check" data-id="${c.id}" /></td>
          <td>${contactName(c)}</td>
          <td>${c.email || '<span class="muted">—</span>'}</td>
          <td>${c.phone || '<span class="muted">—</span>'}</td>
          <td>${(c.tags || []).map((t) => `<span class="chip">${t}</span>`).join('') || '<span class="muted">—</span>'}</td>
        `;
        tr.addEventListener('click', (e) => {
          if (e.target.classList.contains('contact-check')) return;
          openContactDetail(c.id);
        });
        tr.querySelector('.contact-check').addEventListener('change', (e) => {
          if (e.target.checked) selectedContactIds.add(c.id);
          else selectedContactIds.delete(c.id);
          updateDeleteContactsUI();
        });
        body.appendChild(tr);
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="5">${err.message}</td></tr>`;
    }
  }

  document.getElementById('contactSelectAll').addEventListener('change', (e) => {
    selectedContactIds.clear();
    if (e.target.checked) contactsCache.forEach((c) => selectedContactIds.add(c.id));
    document.querySelectorAll('.contact-check').forEach((cb) => (cb.checked = e.target.checked));
    updateDeleteContactsUI();
  });

  document.getElementById('deleteContactsBtn').addEventListener('click', async () => {
    const ids = Array.from(selectedContactIds);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} contact${ids.length > 1 ? 's' : ''}? This can't be undone.`)) return;

    const results = await Promise.allSettled(ids.map((id) => api(`/contacts/${id}`, { method: 'DELETE' })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    toast(
      failed ? `Deleted ${succeeded}, ${failed} failed.` : `Deleted ${succeeded} contact${succeeded > 1 ? 's' : ''}.`,
      Boolean(failed)
    );
    loadContacts(lastContactQuery);
  });

  let searchDebounce;
  document.getElementById('contactSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadContacts(e.target.value.trim()), 300);
  });

  // ---------- Contacts filter panel (tags + created-date, GHL "smart list" style) ----------
  async function loadContactTags() {
    if (contactTagsCache) return;
    const box = document.getElementById('contactTagOptions');
    try {
      const { tags } = await api('/contacts/tags');
      contactTagsCache = tags || [];
      box.innerHTML = contactTagsCache.length
        ? contactTagsCache
            .map((t) => `<span class="fp-tag-opt" data-tag="${t.name}">${t.name}</span>`)
            .join('')
        : '<span class="muted" style="font-size:12.5px">No tags yet.</span>';
      box.querySelectorAll('.fp-tag-opt').forEach((el) => {
        el.addEventListener('click', () => el.classList.toggle('sel'));
      });
    } catch (err) {
      box.innerHTML = `<span class="muted" style="font-size:12.5px">${err.message}</span>`;
    }
  }

  function presetRange(preset) {
    const now = new Date();
    const toISODate = (d) => d.toISOString().slice(0, 10);
    if (preset === 'today') {
      return { from: toISODate(now), to: toISODate(now) };
    }
    if (preset === 'week') {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      return { from: toISODate(start), to: toISODate(now) };
    }
    if (preset === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toISODate(start), to: toISODate(now) };
    }
    return { from: '', to: '' };
  }

  const filterBtn = document.getElementById('contactFilterBtn');
  const filterPanel = document.getElementById('contactFilterPanel');
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!filterPanel.contains(e.target) && e.target !== filterBtn) filterPanel.classList.remove('open');
  });
  filterPanel.addEventListener('click', (e) => e.stopPropagation());

  document.querySelectorAll('.fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const { from, to } = presetRange(btn.dataset.preset);
      document.getElementById('contactDateFrom').value = from;
      document.getElementById('contactDateTo').value = to;
    });
  });
  ['contactDateFrom', 'contactDateTo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('.fp-preset').forEach((b) => b.classList.remove('sel'));
    });
  });

  function renderContactFilterChips() {
    const row = document.getElementById('contactFilterChips');
    const chips = [];
    contactFilters.tags.forEach((t) => {
      chips.push({ label: `Tag: ${t}`, onRemove: () => { contactFilters.tags = contactFilters.tags.filter((x) => x !== t); syncFilterUI(); applyContactFilters(); } });
    });
    if (contactFilters.dateFrom || contactFilters.dateTo) {
      const label = `Created: ${contactFilters.dateFrom || '…'} → ${contactFilters.dateTo || '…'}`;
      chips.push({ label, onRemove: () => { contactFilters.dateFrom = ''; contactFilters.dateTo = ''; syncFilterUI(); applyContactFilters(); } });
    }
    row.innerHTML = '';
    chips.forEach((c) => {
      const span = document.createElement('span');
      span.className = 'fchip';
      span.innerHTML = `${c.label}<button type="button">×</button>`;
      span.querySelector('button').addEventListener('click', c.onRemove);
      row.appendChild(span);
    });
    const countEl = document.getElementById('contactFilterCount');
    countEl.textContent = chips.length ? `(${chips.length})` : '';
  }

  function syncFilterUI() {
    document.querySelectorAll('.fp-tag-opt').forEach((el) => {
      el.classList.toggle('sel', contactFilters.tags.includes(el.dataset.tag));
    });
    document.getElementById('contactDateFrom').value = contactFilters.dateFrom;
    document.getElementById('contactDateTo').value = contactFilters.dateTo;
    document.querySelectorAll('.fp-preset').forEach((b) => b.classList.remove('sel'));
  }

  function applyContactFilters() {
    renderContactFilterChips();
    loadContacts(lastContactQuery);
  }

  document.getElementById('contactFilterApply').addEventListener('click', () => {
    contactFilters.tags = Array.from(document.querySelectorAll('.fp-tag-opt.sel')).map((el) => el.dataset.tag);
    contactFilters.dateFrom = document.getElementById('contactDateFrom').value;
    contactFilters.dateTo = document.getElementById('contactDateTo').value;
    filterPanel.classList.remove('open');
    applyContactFilters();
  });

  document.getElementById('contactFilterClear').addEventListener('click', () => {
    contactFilters.tags = [];
    contactFilters.dateFrom = '';
    contactFilters.dateTo = '';
    syncFilterUI();
    filterPanel.classList.remove('open');
    applyContactFilters();
  });

  document.getElementById('addContactBtn').addEventListener('click', () => {
    ['cFirst', 'cLast', 'cEmail', 'cPhone', 'cTags'].forEach((id) => (document.getElementById(id).value = ''));
    openModal('contactModal');
  });

  document.getElementById('cSave').addEventListener('click', async () => {
    const tags = document.getElementById('cTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      await api('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          firstName: document.getElementById('cFirst').value.trim(),
          lastName: document.getElementById('cLast').value.trim(),
          email: document.getElementById('cEmail').value.trim(),
          phone: document.getElementById('cPhone').value.trim(),
          tags,
        }),
      });
      closeModal('contactModal');
      toast('Contact created.');
      loadContacts();
    } catch (err) {
      toast(err.message, true);
    }
  });

  let activeContactId = null;

  function renderTagEdit(tags) {
    const box = document.getElementById('dTags');
    box.innerHTML = '';
    (tags || []).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t;
      chip.title = 'Click to remove';
      chip.addEventListener('click', () => removeTag(t));
      box.appendChild(chip);
    });
  }

  async function openContactDetail(id) {
    try {
      const { contact } = await api('/contacts/' + id);
      activeContactId = contact.id;
      document.getElementById('dName').textContent = contactName(contact);
      document.getElementById('dFirst').value = contact.firstName || '';
      document.getElementById('dLast').value = contact.lastName || '';
      document.getElementById('dEmail').value = contact.email || '';
      document.getElementById('dPhone').value = contact.phone || '';
      renderTagEdit(contact.tags);
      openModal('detailModal');
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('dSave').addEventListener('click', async () => {
    try {
      await api('/contacts/' + activeContactId, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: document.getElementById('dFirst').value.trim(),
          lastName: document.getElementById('dLast').value.trim(),
          email: document.getElementById('dEmail').value.trim(),
          phone: document.getElementById('dPhone').value.trim(),
        }),
      });
      toast('Contact updated.');
      closeModal('detailModal');
      loadContacts();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function removeTag(tag) {
    try {
      await api(`/contacts/${activeContactId}/tags`, {
        method: 'DELETE',
        body: JSON.stringify({ tags: [tag] }),
      });
      toast(`Tag "${tag}" removed.`);
      openContactDetail(activeContactId);
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('dNewTag').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const tag = e.target.value.trim();
    if (!tag) return;
    try {
      await api(`/contacts/${activeContactId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tags: [tag] }),
      });
      e.target.value = '';
      toast(`Tag "${tag}" added.`);
      openContactDetail(activeContactId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Jobs ----------
  let pipelinesCacheAll = [];
  let selectedPipelineId = null;
  let jobsCache = [];

  async function loadJobsTab() {
    const board = document.getElementById('board');
    board.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const needsContacts = !contactsCache.length;
      const [pipelinesRes, contactsRes] = await Promise.all([
        api('/pipelines'),
        needsContacts ? api('/contacts') : Promise.resolve(null),
      ]);
      if (contactsRes) contactsCache = contactsRes.contacts || [];
      pipelinesCacheAll = pipelinesRes.pipelines || [];

      const sel = document.getElementById('pipelineSelect');
      if (!pipelinesCacheAll.length) {
        sel.innerHTML = '<option value="">No pipelines yet</option>';
        board.innerHTML = '<div class="muted">No pipelines exist yet — click "+ New Pipeline" to create one.</div>';
        return;
      }
      if (!selectedPipelineId || !pipelinesCacheAll.some((p) => p.id === selectedPipelineId)) {
        selectedPipelineId = pipelinesCacheAll[0].id;
      }
      sel.innerHTML = pipelinesCacheAll.map((p) => `<option value="${p.id}" ${p.id === selectedPipelineId ? 'selected' : ''}>${p.name}</option>`).join('');

      await renderBoard();
    } catch (err) {
      board.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  document.getElementById('pipelineSelect').addEventListener('change', (e) => {
    selectedPipelineId = e.target.value;
    renderBoard();
  });

  async function renderBoard() {
    const jobsRes = await api('/jobs?pipelineId=' + encodeURIComponent(selectedPipelineId));
    jobsCache = jobsRes.jobs || [];
    renderBoardFromCache();
  }

  // Renders purely from the in-memory jobsCache -- no API call. Used after a
  // stage move so the UI reflects the PUT response (always immediately
  // correct) instead of re-querying GHL's /opportunities/search endpoint,
  // which lags a few seconds behind writes (same eventual-consistency
  // behavior seen on contacts search and freshly created pipelines).
  function renderBoardFromCache() {
    const board = document.getElementById('board');
    const pipeline = pipelinesCacheAll.find((p) => p.id === selectedPipelineId);
    const stages = pipeline?.stages || [];

    board.innerHTML = '';
    if (!stages.length) {
      board.innerHTML = '<div class="muted">This pipeline has no stages.</div>';
      return;
    }
    stages.forEach((stage) => {
      const col = document.createElement('div');
      col.className = 'col';
      col.dataset.stageId = stage.id;
      const stageJobs = jobsCache.filter((j) => j.stageId === stage.id);
      col.innerHTML = `<h4>${stage.name}<span class="n">${stageJobs.length}</span></h4>`;
      stageJobs.forEach((job) => {
        const card = document.createElement('div');
        card.className = 'jobcard';
        card.draggable = true;
        card.dataset.jobId = job.id;
        const contact = contactsCache.find((c) => c.id === job.contactId);
        const vehicle = [job.carMake, job.carModel].filter(Boolean).join(' ');
        card.innerHTML = `
          <div class="jn">${contact ? contactName(contact) : job.contactId || ''}</div>
          <div class="jc">${vehicle || job.name}</div>
          ${job.damageDescription ? `<div class="jd">${job.damageDescription}</div>` : ''}
          <div class="case">Case #${job.id}</div>
        `;
        card.addEventListener('click', () => openJobDetail(job.id));
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', job.id);
          e.dataTransfer.effectAllowed = 'move';
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        col.appendChild(card);
      });
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const jobId = e.dataTransfer.getData('text/plain');
        const job = jobsCache.find((j) => j.id === jobId);
        if (job && job.stageId !== col.dataset.stageId) moveJobStage(jobId, col.dataset.stageId);
      });
      board.appendChild(col);
    });
  }

  async function moveJobStage(jobId, stageId) {
    try {
      const { job } = await api('/jobs/' + jobId, { method: 'PUT', body: JSON.stringify({ stageId }) });
      toast('Job stage updated.');
      const idx = jobsCache.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobsCache[idx] = { ...jobsCache[idx], ...job };
      renderBoardFromCache();
    } catch (err) {
      toast(err.message, true);
      renderBoard();
    }
  }

  async function updateJobStatus(jobId, status) {
    try {
      const { job } = await api('/jobs/' + jobId, { method: 'PUT', body: JSON.stringify({ status }) });
      toast('Job status updated.');
      const idx = jobsCache.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobsCache[idx] = { ...jobsCache[idx], ...job };
    } catch (err) {
      toast(err.message, true);
    }
  }

  let activeJobId = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderJobCustomFields(fields) {
    const section = document.getElementById('jdCustomFieldsSection');
    const box = document.getElementById('jdCustomFields');
    if (!fields || !fields.length) {
      section.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    section.style.display = 'block';
    box.innerHTML = fields
      .map((f) => {
        let valueHtml;
        if (f.dataType === 'FILE_UPLOAD') {
          const urls = Array.isArray(f.value) ? f.value : [f.value];
          valueHtml = urls
            .map((u, i) => `<a href="${encodeURI(String(u).trim())}" target="_blank" rel="noopener">View file${urls.length > 1 ? ` ${i + 1}` : ''}</a>`)
            .join(', ');
        } else if (Array.isArray(f.value)) {
          valueHtml = escapeHtml(f.value.join(', '));
        } else {
          const raw = String(f.value);
          const isUrl = /^https?:\/\//.test(raw.trim());
          valueHtml = isUrl
            ? `<a href="${encodeURI(raw.trim())}" target="_blank" rel="noopener">View file</a>`
            : escapeHtml(raw);
        }
        return `<div class="fieldrow"><span class="fname">${escapeHtml(f.name)}</span><span class="fval">${valueHtml}</span></div>`;
      })
      .join('');
  }

  async function openJobDetail(jobId) {
    const cached = jobsCache.find((j) => j.id === jobId);
    if (!cached) return;
    activeJobId = jobId;

    document.getElementById('jdCase').textContent = `Case #${jobId}`;
    const statusSel = document.getElementById('jdStatus');
    statusSel.value = cached.status || 'open';
    statusSel.onchange = (e) => updateJobStatus(jobId, e.target.value);
    document.getElementById('jdUploadForm').style.display = 'none';

    try {
      const { job } = await api('/jobs/' + jobId);
      const idx = jobsCache.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobsCache[idx] = { ...jobsCache[idx], ...job };
      const contact = contactsCache.find((c) => c.id === job.contactId);

      document.getElementById('jdContact').textContent = contact ? contactName(contact) : job.contactId || '';
      document.getElementById('jdVehicle').textContent = [job.carMake, job.carModel].filter(Boolean).join(' ') || '—';
      document.getElementById('jdDamage').textContent = job.damageDescription || '—';
      statusSel.value = job.status || 'open';
      renderJobCustomFields(job.customFieldsDisplay);
    } catch (err) {
      toast(err.message, true);
    }

    await loadJobFiles(jobId);
    openModal('jobDetailModal');
  }

  async function loadJobFiles(jobId) {
    const box = document.getElementById('jdFiles');
    box.innerHTML = '<span class="muted">Loading files…</span>';
    try {
      const { files } = await api(`/jobs/${jobId}/files`);
      if (!files.length) {
        box.innerHTML = '<span class="muted">No files uploaded.</span>';
        return;
      }
      const groups = new Map();
      files.forEach((f) => {
        const cat = f.category || 'Photos';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(f);
      });
      box.innerHTML = '';
      for (const [category, group] of groups) {
        const section = document.createElement('div');
        section.className = 'filegroup';
        const isImageGroup = group.every((f) => (f.content_type || '').startsWith('image/'));
        section.innerHTML = `<div class="filegroup-label">${category}</div>` +
          (isImageGroup
            ? `<div class="photogrid">${group.map((f) => `<a href="${f.url}" target="_blank"><img src="${f.url}" /></a>`).join('')}</div>`
            : group.map((f) => `<div class="filerow">📄 <a href="${f.url}" target="_blank">${f.path.split('/').pop()}</a></div>`).join(''));
        box.appendChild(section);
      }
    } catch {
      box.innerHTML = '<span class="muted">Could not load files.</span>';
    }
  }

  document.getElementById('jdUploadBtn').addEventListener('click', () => {
    document.getElementById('jdCategory').value = 'Insurance Documents';
    document.getElementById('jdCustomCategory').style.display = 'none';
    document.getElementById('jdCustomCategory').value = '';
    document.getElementById('jdFileInput').value = '';
    document.getElementById('jdUploadForm').style.display = 'block';
  });

  document.getElementById('jdUploadCancel').addEventListener('click', () => {
    document.getElementById('jdUploadForm').style.display = 'none';
  });

  document.getElementById('jdCategory').addEventListener('change', (e) => {
    document.getElementById('jdCustomCategory').style.display = e.target.value === '__custom' ? 'block' : 'none';
  });

  document.getElementById('jdUploadSave').addEventListener('click', async () => {
    const catSel = document.getElementById('jdCategory').value;
    const category = catSel === '__custom' ? document.getElementById('jdCustomCategory').value.trim() : catSel;
    const files = document.getElementById('jdFileInput').files;
    if (!category) return toast('Enter a category name.', true);
    if (!files.length) return toast('Choose at least one file.', true);

    const fd = new FormData();
    fd.append('category', category);
    for (const f of files) fd.append('files', f);

    try {
      const res = await fetch(`/api/jobs/${activeJobId}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: fd,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      toast(`${body.uploadedCount} file(s) uploaded.` + (body.warnings?.length ? ` ${body.warnings.length} warning(s).` : ''));
      document.getElementById('jdUploadForm').style.display = 'none';
      await loadJobFiles(activeJobId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Pipeline creation ----------
  document.getElementById('newPipelineBtn').addEventListener('click', () => {
    document.getElementById('pName').value = '';
    const stagesBox = document.getElementById('pStages');
    stagesBox.innerHTML = '';
    ['Intake', 'In Progress', 'Done'].forEach(addStageRow);
    openModal('pipelineModal');
  });

  function addStageRow(value = '') {
    const row = document.createElement('div');
    row.className = 'stagerow';
    row.innerHTML = `<input value="${value}" placeholder="Stage name" /><button type="button">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    document.getElementById('pStages').appendChild(row);
  }

  document.getElementById('pAddStage').addEventListener('click', () => addStageRow());

  document.getElementById('pSave').addEventListener('click', async () => {
    const name = document.getElementById('pName').value.trim();
    const stageNames = [...document.querySelectorAll('#pStages input')].map((i) => i.value.trim()).filter(Boolean);
    if (!name) return toast('Pipeline name is required.', true);
    if (!stageNames.length) return toast('Add at least one stage.', true);
    try {
      await api('/pipelines', { method: 'POST', body: JSON.stringify({ name, stageNames }) });
      closeModal('pipelineModal');
      toast('Pipeline created.');
      selectedPipelineId = null;
      loadJobsTab();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Calendar ----------
  let calendarsCache = [];
  let appointmentsCache = [];

  async function loadCalendarTab() {
    const list = document.getElementById('appointmentsList');
    try {
      if (!calendarsCache.length) {
        const { calendars } = await api('/calendars');
        calendarsCache = calendars || [];
        document.getElementById('calendarSelect').innerHTML = calendarsCache.length
          ? calendarsCache.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')
          : '<option value="">No calendars found</option>';
      }
      // No default date -- an empty date field means "show everything."
      await loadAppointments();
    } catch (err) {
      list.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  async function loadAppointments() {
    const list = document.getElementById('appointmentsList');
    const calendarId = document.getElementById('calendarSelect').value;
    const dateStr = document.getElementById('calendarDate').value;
    if (!calendarId) {
      list.innerHTML = '<div class="muted">Select a calendar.</div>';
      return;
    }
    list.innerHTML = '<div class="loading">Loading…</div>';
    // GHL's /calendars/events endpoint expects startTime/endTime as epoch
    // milliseconds -- ISO strings are silently accepted (200 OK) but match
    // nothing. When no date is picked, omit them entirely so the backend's
    // wide default window applies (i.e. "show all").
    let query = '';
    if (dateStr) {
      const dayStart = new Date(dateStr + 'T00:00:00').getTime();
      const dayEnd = new Date(dateStr + 'T23:59:59').getTime();
      query = `?start=${dayStart}&end=${dayEnd}`;
    }
    try {
      const { appointments } = await api(`/calendars/${calendarId}/appointments${query}`);
      appointmentsCache = appointments || [];
      if (!appointmentsCache.length) {
        list.innerHTML = `<div class="muted">No appointments booked${dateStr ? ' for this day' : ''}.</div>`;
        return;
      }
      appointmentsCache.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      list.innerHTML = appointmentsCache
        .map(
          (a) => `
        <div class="appt-row" data-appt="${a.id}">
          <span>${a.title || 'Appointment'}</span>
          <span class="t">${new Date(a.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>`
        )
        .join('');
      list.querySelectorAll('.appt-row').forEach((row) => {
        row.addEventListener('click', () => openAppointmentDetail(row.dataset.appt));
      });
    } catch (err) {
      list.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  // GHL exposes no named timezone anywhere -- only the raw UTC offset baked
  // into each ISO datetime string. Parsing that literally (rather than via
  // `new Date().toLocaleString()`, which converts to the *viewer's* local
  // timezone) shows the appointment's actual booked wall-clock time, not a
  // possibly-misleading conversion.
  function parseIsoParts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/.exec(iso || '');
    if (!m) return null;
    const [, y, mo, d, h, mi, , offset] = m;
    return { y: +y, mo: +mo, d: +d, h: +h, mi, offset };
  }
  function fmt12h(h, mi) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${mi} ${ampm}`;
  }

  async function openAppointmentDetail(apptId) {
    const appt = appointmentsCache.find((a) => a.id === apptId);
    if (!appt) return;
    const calendar = calendarsCache.find((c) => c.id === appt.calendarId);

    document.getElementById('adTitle').textContent = appt.title || 'Appointment';
    document.getElementById('adCalendar').textContent = calendar?.name || appt.calendarId;
    document.getElementById('adStatus').textContent = appt.appointmentStatus || appt.status || '—';

    const startParts = parseIsoParts(appt.startTime);
    const endParts = parseIsoParts(appt.endTime);
    if (startParts) {
      const dateStr = new Date(startParts.y, startParts.mo - 1, startParts.d)
        .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      document.getElementById('adTime').textContent =
        `${dateStr}, ${fmt12h(startParts.h, startParts.mi)} – ${endParts ? fmt12h(endParts.h, endParts.mi) : ''} (UTC${startParts.offset})`;
    } else {
      document.getElementById('adTime').textContent =
        `${new Date(appt.startTime).toLocaleString()} – ${new Date(appt.endTime).toLocaleTimeString()}`;
    }

    const locConfig = calendar?.teamMembers?.[0]?.locationConfigurations?.[0];
    document.getElementById('adLocation').textContent =
      appt.address || locConfig?.location || (locConfig?.kind && locConfig.kind !== 'custom' ? locConfig.kind : null) || 'Not specified';

    const contactBox = document.getElementById('adContact');
    contactBox.innerHTML = '<span class="muted">Loading contact…</span>';
    openModal('appointmentDetailModal');

    try {
      const { contact } = await api(`/contacts/${appt.contactId}`);
      contactBox.innerHTML = `
        <div style="font-weight:700">${contactName(contact)}</div>
        <div class="muted">${contact.email || '—'}</div>
        <div class="muted">${contact.phone || '—'}</div>
        ${(contact.tags || []).map((t) => `<span class="chip">${t}</span>`).join('')}
      `;
    } catch (err) {
      contactBox.innerHTML = `<span class="muted">Could not load contact: ${err.message}</span>`;
    }
  }

  document.getElementById('calendarSelect').addEventListener('change', loadAppointments);
  document.getElementById('calendarDate').addEventListener('change', loadAppointments);

  // ---------- Reporting ----------
  function toCsv(rows, columns) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = columns.map((c) => esc(c.label)).join(',');
    const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(',')).join('\n');
    return `${header}\n${body}`;
  }

  function downloadCsv(filename, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  let reportContactsCache = [];
  let reportPipelineJobsCache = [];
  let reportSalesCache = [];
  let reportPipelinesLoaded = false;

  async function loadReportingTab() {
    try {
      const [revenue, contactsRes] = await Promise.all([api('/reports/revenue'), api('/reports/contacts')]);

      const kpis = document.getElementById('revenueKpis').children;
      kpis[0].querySelector('.val').textContent = money(revenue.totalRevenue);
      kpis[1].querySelector('.val').textContent = money(revenue.pipelineValue);
      kpis[2].querySelector('.val').textContent = `${revenue.wonCount} / ${revenue.openCount} / ${revenue.lostCount}`;

      reportContactsCache = contactsRes.contacts || [];
      const cBody = document.getElementById('repContactsBody');
      cBody.innerHTML = reportContactsCache.length
        ? reportContactsCache
            .map(
              (c) => `
        <tr>
          <td>${contactName(c)}</td>
          <td>${c.email || '—'}</td>
          <td>${c.phone || '—'}</td>
          <td>${(c.tags || []).map((t) => `<span class="chip">${t}</span>`).join('') || '—'}</td>
          <td>${c.dateAdded ? new Date(c.dateAdded).toLocaleDateString() : '—'}</td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="5" class="muted">No contacts found.</td></tr>';

      if (!reportPipelinesLoaded) {
        const { pipelines } = await api('/pipelines');
        const sel = document.getElementById('repPipelineSelect');
        sel.innerHTML = pipelines.map((p) => `<option value="${p.id}">${p.name}</option>`).join('') || '<option value="">No pipelines</option>';
        reportPipelinesLoaded = true;
      }
      await loadPipelineReport();

      const { rows } = await api('/reports/sales-by-month');
      reportSalesCache = rows || [];
      const sBody = document.getElementById('repSalesBody');
      sBody.innerHTML = reportSalesCache.length
        ? reportSalesCache.map((r) => `<tr><td>${r.month}</td><td>${money(r.revenue)}</td><td>${r.count}</td></tr>`).join('')
        : '<tr><td colspan="3" class="muted">No won jobs yet.</td></tr>';
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function loadPipelineReport() {
    const pipelineId = document.getElementById('repPipelineSelect').value;
    if (!pipelineId) return;
    const { pipeline, stages, jobs } = await api('/reports/pipeline?pipelineId=' + encodeURIComponent(pipelineId));
    reportPipelineJobsCache = (jobs || []).map((j) => ({
      ...j,
      stageName: (stages || []).find((s) => s.stageId === j.stageId)?.stageName || j.stageId,
    }));

    const bar = document.getElementById('repStageBar');
    bar.innerHTML = (stages || [])
      .map((s) => `<div class="stagechip"><span class="n">${s.count}</span>${s.stageName} · ${money(s.value)}</div>`)
      .join('') || '<span class="muted">No stages.</span>';

    const body = document.getElementById('repPipelineBody');
    body.innerHTML = reportPipelineJobsCache.length
      ? reportPipelineJobsCache
          .map(
            (j) => `
      <tr>
        <td>#${j.id}</td>
        <td>${j.customerName || '—'}</td>
        <td>${[j.carMake, j.carModel].filter(Boolean).join(' ') || '—'}</td>
        <td>${money(j.value)}</td>
        <td>${j.stageName}</td>
      </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="muted">No jobs in ${pipeline?.name || 'this pipeline'}.</td></tr>`;
  }

  document.getElementById('repPipelineSelect').addEventListener('change', loadPipelineReport);

  document.getElementById('exportContactsBtn').addEventListener('click', () => {
    const csv = toCsv(reportContactsCache, [
      { label: 'Name', get: contactName },
      { label: 'Email', get: (c) => c.email },
      { label: 'Phone', get: (c) => c.phone },
      { label: 'Tags', get: (c) => (c.tags || []).join('; ') },
      { label: 'Date Added', get: (c) => c.dateAdded },
    ]);
    downloadCsv('contacts.csv', csv);
  });

  document.getElementById('exportPipelineBtn').addEventListener('click', () => {
    const csv = toCsv(reportPipelineJobsCache, [
      { label: 'Case #', get: (j) => j.id },
      { label: 'Customer', get: (j) => j.customerName },
      { label: 'Vehicle', get: (j) => [j.carMake, j.carModel].filter(Boolean).join(' ') },
      { label: 'Value', get: (j) => j.value },
      { label: 'Stage', get: (j) => j.stageName },
    ]);
    downloadCsv('pipeline-report.csv', csv);
  });

  document.getElementById('exportSalesBtn').addEventListener('click', () => {
    const csv = toCsv(reportSalesCache, [
      { label: 'Month', get: (r) => r.month },
      { label: 'Revenue', get: (r) => r.revenue },
      { label: 'Jobs Won', get: (r) => r.count },
    ]);
    downloadCsv('sales-by-month.csv', csv);
  });

  // ---------- Conversations ----------
  let convosCache = [];
  let activeConvoId = null;
  let convoPollTimer = null;
  let phoneNumbersCache = [];

  function stopConvoPolling() {
    if (convoPollTimer) clearInterval(convoPollTimer);
    convoPollTimer = null;
  }

  async function loadConversationsTab() {
    if (!phoneNumbersCache.length) {
      try {
        const { phoneNumbers } = await api('/conversations/numbers');
        phoneNumbersCache = phoneNumbers || [];
        document.getElementById('convoFromNumber').innerHTML = phoneNumbersCache
          .map((n) => `<option value="${n.value}">${n.title || n.value}</option>`)
          .join('') || '<option value="">Default number</option>';
      } catch {
        document.getElementById('convoFromNumber').innerHTML = '<option value="">Default number</option>';
      }
    }
    await refreshConvoList();
    stopConvoPolling();
    // Polling stands in for real-time inbound delivery: this app has no
    // public webhook endpoint (localhost), so a short refetch interval is
    // the fallback the spec itself calls for.
    convoPollTimer = setInterval(async () => {
      await refreshConvoList();
      if (activeConvoId) await loadConvoMessages(activeConvoId, { silent: true });
    }, 8000);
  }

  async function refreshConvoList() {
    const box = document.getElementById('convoList');
    try {
      const { conversations } = await api('/conversations');
      convosCache = conversations || [];
      renderConvoList();
    } catch (err) {
      box.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  function renderConvoList() {
    const box = document.getElementById('convoList');
    if (!convosCache.length) {
      box.innerHTML = '<div class="muted" style="padding:12px">No conversations yet.</div>';
      return;
    }
    box.innerHTML = convosCache
      .map(
        (c) => `
      <div class="convo-item ${c.id === activeConvoId ? 'active' : ''}" data-convo="${c.id}">
        <div class="cn">${c.contactName || c.fullName || 'Unknown'} ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}</div>
        <div class="cs">${c.lastMessageBody || c.phone || ''}</div>
        <div class="ct">${c.lastMessageDate ? new Date(c.lastMessageDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>
      </div>`
      )
      .join('');
    box.querySelectorAll('.convo-item').forEach((el) => {
      el.addEventListener('click', () => selectConversation(el.dataset.convo));
    });
  }

  async function selectConversation(id) {
    activeConvoId = id;
    renderConvoList();
    document.getElementById('convoReplyBox').style.display = 'flex';
    await loadConvoMessages(id);
  }

  async function loadConvoMessages(id, { silent } = {}) {
    const thread = document.getElementById('convoThread');
    const convo = convosCache.find((c) => c.id === id);
    const header = document.getElementById('convoThreadHeader');
    if (convo) {
      header.className = 'convo-header';
      header.innerHTML = `
        <div class="name">${convo.contactName || convo.fullName || 'Unknown'}</div>
        <div class="meta">
          ${convo.phone ? `<span>📞 ${convo.phone}</span>` : ''}
          ${convo.email ? `<span>✉ ${convo.email}</span>` : ''}
        </div>
        ${(convo.tags || []).length ? `<div class="tags">${convo.tags.map((t) => `<span class="chip">${t}</span>`).join('')}</div>` : ''}
      `;
    } else {
      header.className = 'convo-header muted';
      header.textContent = 'Conversation';
    }
    if (!silent) thread.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const { messages } = await api(`/conversations/${id}/messages`);
      const real = (messages || []).filter((m) => m.messageType === 'TYPE_SMS' || m.messageType === 'TYPE_EMAIL');
      if (!real.length) {
        thread.innerHTML = '<div class="muted">No messages yet.</div>';
        return;
      }
      thread.innerHTML = real
        .slice()
        .reverse()
        .map((m) => {
          const failed = m.status === 'failed';
          const cls = failed ? 'failed' : m.direction === 'outbound' ? 'outbound' : 'inbound';
          const time = new Date(m.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<div class="msg-bubble ${cls}">${m.body || ''}<div class="mt">${failed ? `⚠ ${m.error || 'Failed to send'}` : time}</div></div>`;
        })
        .join('');
      thread.scrollTop = thread.scrollHeight;
    } catch (err) {
      if (!silent) thread.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  async function sendConvoReply() {
    const input = document.getElementById('convoReplyInput');
    const message = input.value.trim();
    if (!message || !activeConvoId) return;
    const convo = convosCache.find((c) => c.id === activeConvoId);
    if (!convo) return;
    input.value = '';
    const fromNumber = document.getElementById('convoFromNumber').value;
    try {
      await api(`/conversations/${activeConvoId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ contactId: convo.contactId, message, fromNumber }),
      });
      await loadConvoMessages(activeConvoId);
      await refreshConvoList();
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('startConvoBtn').addEventListener('click', () => {
    ['scName', 'scPhone', 'scEmail'].forEach((id) => (document.getElementById(id).value = ''));
    openModal('startConvoModal');
  });

  document.getElementById('scSave').addEventListener('click', async () => {
    const name = document.getElementById('scName').value.trim();
    const phone = document.getElementById('scPhone').value.trim();
    const email = document.getElementById('scEmail').value.trim();
    if (!phone) return toast('Phone is required.', true);
    try {
      const { contact, conversation } = await api('/conversations', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email }),
      });
      closeModal('startConvoModal');

      // Use the write's own response directly rather than refetching --
      // /conversations has the same search-index lag documented elsewhere
      // in this app, so a just-created conversation might not show up yet.
      const convoEntry = {
        id: conversation.id,
        contactId: contact.id,
        contactName: contactName(contact),
        phone: contact.phone,
        email: contact.email,
        tags: contact.tags,
        unreadCount: 0,
        lastMessageBody: '',
        lastMessageDate: null,
      };
      const idx = convosCache.findIndex((c) => c.id === convoEntry.id);
      if (idx !== -1) convosCache[idx] = { ...convosCache[idx], ...convoEntry };
      else convosCache.unshift(convoEntry);
      renderConvoList();
      await selectConversation(conversation.id);
      toast('Conversation started.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('convoSendBtn').addEventListener('click', sendConvoReply);
  document.getElementById('convoReplyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendConvoReply();
  });

  // ---------- Not-connected gating ----------
  // A brand-new account has a login before the agency has added its GHL
  // credentials in the Admin portal. The backend is the real gate (every
  // GHL-backed route 409s with "not_connected" until then) -- this just
  // keeps the obvious mutating entry points from inviting a click that can
  // only fail.
  const GATED_ELEMENT_IDS = [
    'addContactBtn', 'newPipelineBtn', 'newJobLink', 'jdUploadBtn', 'jdStatus',
    'convoSendBtn', 'cSave', 'dSave', 'jdUploadSave',
  ];

  function applyConnectionGate(connected) {
    tenant.connected = connected;
    document.getElementById('notConnectedBanner').style.display = connected ? 'none' : 'block';
    GATED_ELEMENT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('gate-disabled', !connected);
      if ('disabled' in el) el.disabled = !connected;
    });
  }

  // ---------- Boot ----------
  async function boot() {
    const cfgRes = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey, brandName } = await cfgRes.json();
    if (brandName) {
      document.title = `${brandName} — Portal`;
      document.getElementById('brandName').textContent = brandName;
    }
    if (!supabaseUrl || !supabaseAnonKey) {
      toast('Server is not configured (missing Supabase env vars).', true);
      return;
    }
    supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
    const { data } = await supabase.auth.getSession();
    session = data.session;
    if (!session) {
      window.location.href = '/login.html';
      return;
    }
    document.getElementById('userEmail').textContent = session.user.email;
    document.getElementById('avatar').textContent = session.user.email.slice(0, 2).toUpperCase();

    document.getElementById('signOut').addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    });

    try {
      const me = await api('/me');
      tenant = me.tenant;
    } catch {
      tenant = { connected: true, businessName: '' };
    }
    applyConnectionGate(tenant.connected);
    document.getElementById('welcomeLine').textContent = tenant.businessName ? `Welcome back, ${tenant.businessName}` : '';

    loadDashboard();
  }

  boot();
})();
