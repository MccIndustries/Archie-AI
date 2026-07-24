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
      // the login page's own local-only session check just bounces back
      // here, forever.
      await supabase.auth.signOut();
      window.location.href = '/login';
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
    const item = document.querySelector(`.navitem[data-tab="${tab}"]`);
    if (!item) return;
    document.querySelectorAll('.navitem[data-tab]').forEach((p) => p.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'contacts') { loadContactTags(); loadContacts(); loadSmartLists(); }
    if (tab === 'jobs') loadJobsTab();
    if (tab === 'calendar') loadCalendarTab();
    if (tab === 'reporting') loadReportingTab();
    if (tab === 'conversations') loadConversationsTab();
    else stopConvoPolling();
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.navitem[data-tab]');
    if (!btn || !btn.dataset.tab) return;
    switchTab(btn.dataset.tab);
  });

  // "Won" is GHL's own stage/status vocabulary (and the API value job.status
  // uses) -- left alone on the wire. Only the displayed text becomes
  // "Completed", everywhere a stage or status name is shown to the user.
  function displayStageName(name) {
    return /^won$/i.test((name || '').trim()) ? 'Completed' : name;
  }

  // GHL's real opportunity id is a 20-char random string -- fine as the
  // actual identifier (used everywhere for lookups/clicks unchanged), but
  // ugly as a displayed "case number". Shows just the last 6 characters,
  // uppercased, purely cosmetic -- every click handler still keys off the
  // full id via data attributes, never this shortened text.
  function shortCaseId(id) {
    return id ? String(id).slice(-6).toUpperCase() : '';
  }

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

  document.getElementById('attentionPipelineSelect').addEventListener('change', loadDashboard);

  function daysChipClass(days) {
    if (days > 20) return 'red';
    if (days >= 10) return 'amber';
    return 'green';
  }

  // ---------- KPI detail popups ----------
  let lastDashboardData = null;

  const KPI_CONFIG = {
    revenueRecovered: { title: 'Revenue Recovered', dataKey: 'revenueJobs', emptyMsg: 'No revenue recovered in this range.' },
    jobsInShopValue: { title: 'Jobs In Shop Value', dataKey: 'pipelineValueJobs', emptyMsg: 'No open jobs in this range.' },
    closedThisMonth: { title: 'Closed This Month', dataKey: 'closedThisMonthJobs', emptyMsg: 'No jobs closed this month yet.' },
    activeJobs: { title: 'Active Jobs', dataKey: 'activeJobsList', emptyMsg: 'No active jobs right now.' },
    jobsNeedingAttention: { title: 'Jobs Needing Attention', dataKey: 'jobsNeedingAttention', emptyMsg: 'No jobs need attention.', daysCol: true },
    callsDone: { title: 'Calls Done', dataKey: 'recentCalls', emptyMsg: 'No AI calls yet.', type: 'calls' },
  };

  function openKpiDetail(kpiKey) {
    const cfg = KPI_CONFIG[kpiKey];
    if (!cfg) return;
    document.getElementById('kpiModalTitle').textContent = cfg.title;
    const body = document.getElementById('kpiModalBody');

    if (cfg.placeholder) {
      body.innerHTML = '<div class="empty-panel">Not tracked yet for this account.</div>';
      openModal('kpiDetailModal');
      return;
    }

    const items = (lastDashboardData && lastDashboardData[cfg.dataKey]) || [];
    if (!items.length) {
      body.innerHTML = `<div class="empty-panel">${cfg.emptyMsg}</div>`;
      openModal('kpiDetailModal');
      return;
    }

    if (cfg.type === 'calls') {
      body.innerHTML = items
        .map(
          (c) => `
        <div class="dash-row" data-open-kpi-call="${c.id}">
          <div><div class="name">${escapeHtml(c.contactName || c.phone || 'Unknown')}</div><div class="sub">${escapeHtml(c.summary ? c.summary.slice(0, 90) + (c.summary.length > 90 ? '…' : '') : '')}</div></div>
          <div class="sub">${new Date(c.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>`
        )
        .join('');
      body.querySelectorAll('[data-open-kpi-call]').forEach((row) => {
        const call = items.find((c) => c.id === row.dataset.openKpiCall);
        row.addEventListener('click', () => {
          closeModal('kpiDetailModal');
          openCallDetail({
            messageId: call.messageId,
            contactId: call.contactId,
            direction: null,
            status: null,
            duration: call.duration,
            dateAdded: call.createdAt,
          });
        });
      });
      openModal('kpiDetailModal');
      return;
    }

    const jobs = items;
    body.innerHTML = `
      <table>
        <thead><tr><th>Case #</th><th>Customer</th><th>Vehicle</th><th>Value</th><th>Stage</th>${cfg.daysCol ? '<th>Days In Stage</th>' : ''}</tr></thead>
        <tbody>
          ${jobs
            .map(
              (j) => `
          <tr class="rowlink" data-open-kpi-job="${j.id}">
            <td>#${shortCaseId(j.id)}</td>
            <td>${j.customerName || '—'}</td>
            <td>${[j.carMake, j.carModel].filter(Boolean).join(' ') || '—'}</td>
            <td>${money(j.value)}</td>
            <td>${displayStageName(j.stageName) || '—'}</td>
            ${cfg.daysCol ? `<td><span class="days-chip ${daysChipClass(j.daysInStage)}">${j.daysInStage}d</span></td>` : ''}
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('[data-open-kpi-job]').forEach((row) => {
      row.addEventListener('click', () => {
        closeModal('kpiDetailModal');
        openJobDetail(row.dataset.openKpiJob);
      });
    });
    openModal('kpiDetailModal');
  }

  document.getElementById('kpis').addEventListener('click', (e) => {
    const card = e.target.closest('.kpi[data-kpi-card]');
    if (!card) return;
    openKpiDetail(card.dataset.kpiCard);
  });

  async function loadDashboard() {
    try {
      if (!dashPipelinesLoaded) {
        const { pipelines } = await api('/pipelines');
        const pSel = document.getElementById('attentionPipelineSelect');
        pSel.innerHTML = '<option value="">All pipelines</option>' + pipelines.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
        dashPipelinesLoaded = true;
      }

      const { from, to } = computeRangeDates();
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const pipelineId = document.getElementById('attentionPipelineSelect').value;
      if (pipelineId) params.set('pipelineId', pipelineId);

      const dash = await api('/dashboard?' + params.toString());
      lastDashboardData = dash;
      document.querySelector('[data-kpi="revenueRecovered"]').textContent = money(dash.totalRevenue);
      document.querySelector('[data-kpi="jobsInShopValue"]').textContent = money(dash.pipelineValue);
      document.querySelector('[data-kpi="closedThisMonth"]').textContent = money(dash.closedThisMonth);
      document.querySelector('[data-kpi="activeJobs"]').textContent = dash.activeJobsCount;
      const attnCount = dash.jobsNeedingAttention?.length || 0;
      const attnEl = document.querySelector('[data-kpi="jobsNeedingAttention"]');
      attnEl.textContent = attnCount;
      attnEl.classList.toggle('attn', attnCount > 0);

      const pipelineBox = document.getElementById('dashPipelineOverviews');
      pipelineBox.innerHTML = (dash.pipelineOverviews || [])
        .map(
          (p) => `
        <div class="dash-pipeline-block">
          <div class="ph">${p.pipelineName} <span class="muted">(${p.totalJobs} job${p.totalJobs === 1 ? '' : 's'})</span></div>
          <div class="stagebar">
            ${p.stageCounts.map((s) => `<div class="stagechip${/^won$/i.test(s.stageName) ? ' completed' : ''}"><span class="n">${s.count}</span>${displayStageName(s.stageName)}<span class="v">${money(s.value)}</span></div>`).join('') || '<span class="muted">No stages.</span>'}
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
      loadDashboardCallsKpi();

      const attentionBody = document.getElementById('attentionBody');
      attentionBody.innerHTML = '';
      if (!dash.jobsNeedingAttention?.length) {
        attentionBody.innerHTML = '<tr><td colspan="5" class="muted">No jobs need attention.</td></tr>';
      } else {
        dash.jobsNeedingAttention.forEach((j) => {
          const vehicle = [j.carMake, j.carModel].filter(Boolean).join(' ');
          const tr = document.createElement('tr');
          tr.className = 'rowlink';
          tr.innerHTML = `
            <td>#${shortCaseId(j.id)}</td>
            <td>${j.customerName || '—'}${vehicle ? `<div class="muted" style="font-size:12px">${vehicle}</div>` : ''}</td>
            <td>${money(j.value)}</td>
            <td>${displayStageName(j.stageName) || '—'}</td>
            <td><span class="days-chip ${daysChipClass(j.daysInStage)}">${j.daysInStage}d</span></td>
          `;
          tr.addEventListener('click', () => openJobDetail(j.id));
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

  // Feeds the "Calls Done" KPI card -- the count comes from GHL's own
  // pagination total (all AI calls this location has ever logged), while the
  // full call list (newest first) rides along on the same response and gets
  // stashed on lastDashboardData for openKpiDetail's click-through to use,
  // same as every other KPI's detail list. The KPI modal's own scroll (same
  // shared .modal max-height as every other KPI detail) handles however
  // long that list gets.
  async function loadDashboardCallsKpi() {
    const el = document.querySelector('[data-kpi="callsDone"]');
    try {
      const { calls, total } = await api('/calls/recent');
      if (lastDashboardData) lastDashboardData.recentCalls = calls;
      el.textContent = total;
    } catch {
      el.textContent = '–';
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
    await ensureContactFieldDefs();
    renderContactsHead();
    const cols = contactColumnDefs();
    const totalCols = 2 + cols.length;
    body.innerHTML = `<tr><td colspan="${totalCols}" class="loading">Loading…</td></tr>`;
    try {
      const params = new URLSearchParams();
      if (lastContactQuery) params.set('query', lastContactQuery);
      if (contactFilters.tags.length) params.set('tags', contactFilters.tags.join(','));
      if (contactFilters.dateFrom) params.set('dateFrom', contactFilters.dateFrom);
      if (contactFilters.dateTo) params.set('dateTo', contactFilters.dateTo);
      const qs = params.toString();
      const needsJobs = cols.some((c) => c.key === 'activeJobs');
      const [data, jobs] = await Promise.all([
        api('/contacts' + (qs ? `?${qs}` : '')),
        needsJobs ? ensureAllJobsCache().catch(() => []) : Promise.resolve([]),
      ]);
      contactsCache = data.contacts || [];
      const activeJobCounts = new Map();
      (jobs || []).forEach((j) => {
        if (j.status !== 'open') return;
        activeJobCounts.set(j.contactId, (activeJobCounts.get(j.contactId) || 0) + 1);
      });
      body.innerHTML = '';
      updateDeleteContactsUI();
      if (!contactsCache.length) {
        body.innerHTML = `<tr><td colspan="${totalCols}" class="muted">No contacts found.</td></tr>`;
        return;
      }
      contactsCache.forEach((c) => {
        const tr = document.createElement('tr');
        tr.className = 'rowlink';
        const cellsHtml = cols
          .map((col) => {
            if (col.key === 'email') return `<td>${c.email || '<span class="muted">—</span>'}</td>`;
            if (col.key === 'phone') return `<td>${c.phone || '<span class="muted">—</span>'}</td>`;
            if (col.key === 'tags') return `<td>${(c.tags || []).map((t) => `<span class="chip">${t}</span>`).join('') || '<span class="muted">—</span>'}</td>`;
            if (col.key === 'activeJobs') return `<td>${activeJobCounts.get(c.id) || 0}</td>`;
            if (col.custom) {
              const val = getContactFieldValue(c, col.fieldId);
              return `<td>${val != null && val !== '' ? escapeHtml(String(val)) : '<span class="muted">—</span>'}</td>`;
            }
            return '<td>—</td>';
          })
          .join('');
        tr.innerHTML = `
          <td><input type="checkbox" class="contact-check" data-id="${c.id}" /></td>
          <td>${contactName(c)}</td>
          ${cellsHtml}
        `;
        tr.addEventListener('click', (e) => {
          if (e.target.classList.contains('contact-check')) return;
          showContactPage(c.id);
        });
        tr.querySelector('.contact-check').addEventListener('change', (e) => {
          if (e.target.checked) selectedContactIds.add(c.id);
          else selectedContactIds.delete(c.id);
          updateDeleteContactsUI();
        });
        body.appendChild(tr);
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="${totalCols}">${err.message}</td></tr>`;
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

  document.querySelectorAll('#contactDatePresets .fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#contactDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const { from, to } = presetRange(btn.dataset.preset);
      document.getElementById('contactDateFrom').value = from;
      document.getElementById('contactDateTo').value = to;
    });
  });
  ['contactDateFrom', 'contactDateTo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('#contactDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
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
    document.querySelectorAll('#contactTagOptions .fp-tag-opt').forEach((el) => {
      el.classList.toggle('sel', contactFilters.tags.includes(el.dataset.tag));
    });
    document.getElementById('contactDateFrom').value = contactFilters.dateFrom;
    document.getElementById('contactDateTo').value = contactFilters.dateTo;
    document.querySelectorAll('#contactDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
  }

  function applyContactFilters() {
    renderContactFilterChips();
    loadContacts(lastContactQuery);
  }

  document.getElementById('contactFilterApply').addEventListener('click', () => {
    contactFilters.tags = Array.from(document.querySelectorAll('#contactTagOptions .fp-tag-opt.sel')).map((el) => el.dataset.tag);
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

  // ---------- Smart Lists ----------
  let smartListsCache = [];
  let activeSmartListId = null;

  async function loadSmartLists() {
    try {
      const { smartLists } = await api('/contacts/smart-lists');
      smartListsCache = smartLists || [];
      renderSmartLists();
    } catch {
      // Non-critical -- the "All" pill and manual filters still work fine
      // even if this fails to load.
    }
  }

  function renderSmartLists() {
    const row = document.getElementById('smartListRow');
    const addBtn = document.getElementById('addSmartListBtn');
    row.querySelectorAll('.sl-pill:not(.sl-add):not([data-smartlist=""])').forEach((el) => el.remove());
    smartListsCache.forEach((sl) => {
      const pill = document.createElement('span');
      pill.className = 'sl-pill' + (activeSmartListId === sl.id ? ' active' : '');
      pill.dataset.smartlistId = sl.id;
      pill.innerHTML = `<span data-apply="${sl.id}">${sl.name}</span>` +
        (activeSmartListId === sl.id
          ? `<span class="sl-icon" data-rename="${sl.id}" title="Rename">✎</span><span class="sl-icon" data-delete="${sl.id}" title="Delete">×</span>`
          : '');
      row.insertBefore(pill, addBtn);
    });
    row.querySelectorAll('[data-apply]').forEach((el) => {
      el.addEventListener('click', () => applySmartList(el.dataset.apply));
    });
    row.querySelectorAll('[data-rename]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); renameSmartList(el.dataset.rename); });
    });
    row.querySelectorAll('[data-delete]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); deleteSmartList(el.dataset.delete); });
    });
  }

  document.getElementById('smartListRow').addEventListener('click', (e) => {
    if (e.target.dataset.smartlist === '') applySmartList(null);
  });

  function applySmartList(id) {
    activeSmartListId = id;
    document.querySelectorAll('.sl-pill').forEach((el) => el.classList.remove('active'));
    if (id === null) {
      document.querySelector('.sl-pill[data-smartlist=""]').classList.add('active');
      contactFilters.tags = [];
      contactFilters.dateFrom = '';
      contactFilters.dateTo = '';
    } else {
      const sl = smartListsCache.find((s) => s.id === id);
      if (!sl) return;
      contactFilters.tags = sl.filters?.tags || [];
      contactFilters.dateFrom = sl.filters?.dateFrom || '';
      contactFilters.dateTo = sl.filters?.dateTo || '';
    }
    renderSmartLists();
    syncFilterUI();
    applyContactFilters();
  }

  document.getElementById('addSmartListBtn').addEventListener('click', async () => {
    document.getElementById('slName').value = '';
    document.getElementById('slDateFrom').value = '';
    document.getElementById('slDateTo').value = '';
    document.querySelectorAll('#slDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));

    const box = document.getElementById('slTagOptions');
    box.innerHTML = '<span class="muted" style="font-size:12.5px">Loading…</span>';
    openModal('smartListModal');
    try {
      await loadContactTags();
      box.innerHTML = contactTagsCache.length
        ? contactTagsCache.map((t) => `<span class="fp-tag-opt" data-tag="${t.name}">${t.name}</span>`).join('')
        : '<span class="muted" style="font-size:12.5px">No tags yet.</span>';
      box.querySelectorAll('.fp-tag-opt').forEach((el) => {
        el.addEventListener('click', () => el.classList.toggle('sel'));
      });
    } catch (err) {
      box.innerHTML = `<span class="muted" style="font-size:12.5px">${err.message}</span>`;
    }
  });

  document.querySelectorAll('#slDatePresets .fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#slDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const { from, to } = presetRange(btn.dataset.preset);
      document.getElementById('slDateFrom').value = from;
      document.getElementById('slDateTo').value = to;
    });
  });
  ['slDateFrom', 'slDateTo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('#slDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
    });
  });

  document.getElementById('slSave').addEventListener('click', async () => {
    const name = document.getElementById('slName').value.trim();
    if (!name) return toast('Name is required.', true);
    const filters = {
      tags: Array.from(document.querySelectorAll('#slTagOptions .fp-tag-opt.sel')).map((el) => el.dataset.tag),
      dateFrom: document.getElementById('slDateFrom').value,
      dateTo: document.getElementById('slDateTo').value,
    };
    try {
      const { smartList } = await api('/contacts/smart-lists', {
        method: 'POST',
        body: JSON.stringify({ name, filters }),
      });
      smartListsCache.push(smartList);
      closeModal('smartListModal');
      applySmartList(smartList.id);
      toast('Smart list saved.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function renameSmartList(id) {
    const sl = smartListsCache.find((s) => s.id === id);
    if (!sl) return;
    const name = prompt('Rename smart list:', sl.name);
    if (!name || !name.trim() || name.trim() === sl.name) return;
    try {
      const { smartList } = await api(`/contacts/smart-lists/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
      const idx = smartListsCache.findIndex((s) => s.id === id);
      if (idx !== -1) smartListsCache[idx] = smartList;
      renderSmartLists();
      toast('Smart list renamed.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteSmartList(id) {
    if (!confirm('Delete this smart list? Its saved filters (not the contacts) will be removed.')) return;
    try {
      await api(`/contacts/smart-lists/${id}`, { method: 'DELETE' });
      smartListsCache = smartListsCache.filter((s) => s.id !== id);
      if (activeSmartListId === id) applySmartList(null);
      else renderSmartLists();
      toast('Smart list deleted.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- Manage Fields (which columns show in the Contacts table) ----------
  // Persisted per-browser via localStorage -- a display preference, not
  // account data, so this doesn't need a server round trip or Supabase table.
  const CONTACT_COLUMNS_KEY = 'flowsuite.contactColumns';
  const CONTACT_FIXED_FIELDS = [
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'tags', label: 'Tags' },
    { key: 'activeJobs', label: 'Active Jobs' },
  ];
  let contactColumns = null;
  let contactFieldDefsCache = null;

  function loadContactColumns() {
    if (contactColumns) return contactColumns;
    try {
      const stored = JSON.parse(localStorage.getItem(CONTACT_COLUMNS_KEY) || 'null');
      contactColumns = Array.isArray(stored) ? stored : CONTACT_FIXED_FIELDS.map((f) => f.key);
    } catch {
      contactColumns = CONTACT_FIXED_FIELDS.map((f) => f.key);
    }
    return contactColumns;
  }

  async function ensureContactFieldDefs() {
    if (contactFieldDefsCache) return contactFieldDefsCache;
    try {
      const { fieldDefs } = await api('/contacts/field-defs');
      contactFieldDefsCache = fieldDefs || [];
    } catch {
      contactFieldDefsCache = [];
    }
    return contactFieldDefsCache;
  }

  function contactColumnDefs() {
    const active = loadContactColumns();
    const fixed = CONTACT_FIXED_FIELDS.filter((f) => active.includes(f.key));
    const custom = (contactFieldDefsCache || [])
      .filter((f) => active.includes('cf_' + f.id))
      .map((f) => ({ key: 'cf_' + f.id, label: f.name, custom: true, fieldId: f.id }));
    return [...fixed, ...custom];
  }

  function getContactFieldValue(contact, fieldId) {
    const f = (contact.customFields || []).find((cf) => cf.id === fieldId);
    if (!f) return null;
    let val = f.value ?? f.fieldValue ?? f.fieldValueString ?? f.fieldValueNumber ?? null;
    if (Array.isArray(val)) val = val.join(', ');
    return val;
  }

  function renderContactsHead() {
    const tr = document.getElementById('contactsHeadRow');
    tr.querySelectorAll('[data-dyn]').forEach((el) => el.remove());
    contactColumnDefs().forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c.label;
      th.dataset.dyn = '1';
      tr.appendChild(th);
    });
  }

  document.getElementById('manageFieldsBtn').addEventListener('click', async () => {
    const body = document.getElementById('manageFieldsBody');
    body.innerHTML = '<div class="loading">Loading…</div>';
    openModal('manageFieldsModal');
    await ensureContactFieldDefs();
    const active = loadContactColumns();
    const rows = [
      { key: 'name', label: 'Contact Name', locked: true },
      ...CONTACT_FIXED_FIELDS,
      ...(contactFieldDefsCache || []).map((f) => ({ key: 'cf_' + f.id, label: f.name })),
    ];
    body.innerHTML = rows
      .map(
        (f) => `
      <label style="display:flex;align-items:center;gap:10px;margin:0 0 10px;font-weight:600;font-size:13.5px;color:var(--ink)">
        <input type="checkbox" data-field="${f.key}" ${f.locked || active.includes(f.key) ? 'checked' : ''} ${f.locked ? 'disabled' : ''} />
        ${f.label}
      </label>`
      )
      .join('');
  });

  document.getElementById('manageFieldsApply').addEventListener('click', () => {
    const checked = Array.from(document.querySelectorAll('#manageFieldsBody input[type=checkbox]:checked'))
      .map((el) => el.dataset.field)
      .filter((k) => k !== 'name');
    contactColumns = checked;
    localStorage.setItem(CONTACT_COLUMNS_KEY, JSON.stringify(checked));
    closeModal('manageFieldsModal');
    renderContactsHead();
    loadContacts(lastContactQuery);
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

  // ---------- Contact full page ----------
  let cpContactId = null;
  let cpConvoId = null;
  let cpPhoneNumbersLoaded = false;

  function showSection(id) {
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  async function showContactPage(contactId) {
    showSection('tab-contact-view');
    document.querySelectorAll('.navitem[data-tab]').forEach((p) => p.classList.remove('active'));
    document.querySelector('.navitem[data-tab="contacts"]').classList.add('active');
    await loadContactPage(contactId);
  }

  document.getElementById('cpBack').addEventListener('click', () => switchTab('contacts'));

  function renderCpTagEdit(tags) {
    const box = document.getElementById('cpTags');
    box.innerHTML = '';
    (tags || []).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t;
      chip.title = 'Click to remove';
      chip.addEventListener('click', () => removeCpTag(t));
      box.appendChild(chip);
    });
  }

  async function loadContactPage(contactId) {
    cpContactId = contactId;
    cpConvoId = null;
    document.getElementById('cpNoteForm').style.display = 'none';
    document.getElementById('cpJobs').innerHTML = '<div class="loading">Loading…</div>';
    document.getElementById('cpNotesList').innerHTML = '<div class="loading">Loading…</div>';
    document.getElementById('cpConvoThread').innerHTML = '';
    document.getElementById('cpConvoHeader').textContent = 'Loading…';
    document.getElementById('cpConvoHeader').className = 'convo-header muted';
    document.getElementById('cpConvoReplyBox').style.display = 'none';
    document.getElementById('cpConvoStart').style.display = 'none';

    try {
      const [{ contact }] = await Promise.all([api('/contacts/' + contactId), ensureContactFieldDefs()]);
      document.getElementById('cpName').textContent = contactName(contact);
      document.getElementById('cpFirst').value = contact.firstName || '';
      document.getElementById('cpLast').value = contact.lastName || '';
      document.getElementById('cpEmail').value = contact.email || '';
      document.getElementById('cpPhone').value = contact.phone || '';
      renderCpTagEdit(contact.tags);
      renderCpCustomFields(contact);
    } catch (err) {
      toast(err.message, true);
    }

    loadCpJobs(contactId);
    loadCpNotes(contactId);
    loadCpConversation(contactId);
  }

  // Shows every custom field defined on this GHL account for contacts, not
  // just the ones selected in Manage Fields (that only controls the
  // Contacts table's columns) -- matches GHL's own contact detail view:
  // name + value always, blank inputs included, so anything can be filled
  // in and saved even if it was never set before.
  function renderCpCustomFields(contact) {
    const section = document.getElementById('cpCustomFieldsSection');
    const box = document.getElementById('cpCustomFields');
    const defs = contactFieldDefsCache || [];
    if (!defs.length) {
      section.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    section.style.display = 'block';
    const valueById = new Map(
      (contact.customFields || []).map((f) => {
        let v = f.value ?? f.fieldValue ?? f.fieldValueString ?? '';
        if (Array.isArray(v)) v = v.join(', ');
        return [f.id, v];
      })
    );
    box.innerHTML = defs
      .map(
        (f) => `
      <label>${escapeHtml(f.name)}</label>
      <input data-cf-id="${f.id}" value="${escapeHtml(String(valueById.get(f.id) ?? ''))}" />`
      )
      .join('');
  }

  document.getElementById('cpSave').addEventListener('click', async () => {
    try {
      const customFields = Array.from(document.querySelectorAll('#cpCustomFields [data-cf-id]')).map((el) => ({
        id: el.dataset.cfId,
        value: el.value,
      }));
      await api('/contacts/' + cpContactId, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: document.getElementById('cpFirst').value.trim(),
          lastName: document.getElementById('cpLast').value.trim(),
          email: document.getElementById('cpEmail').value.trim(),
          phone: document.getElementById('cpPhone').value.trim(),
          customFields,
        }),
      });
      toast('Contact updated.');
      document.getElementById('cpName').textContent =
        [document.getElementById('cpFirst').value, document.getElementById('cpLast').value].filter(Boolean).join(' ') || 'Contact';
      // Save Changes doesn't otherwise touch tags at all -- if the VA typed
      // a tag but clicked Save instead of pressing Enter, flush it here too
      // rather than silently dropping it (this is exactly what looked like
      // "adding a tag does nothing").
      const pendingTag = document.getElementById('cpNewTag').value.trim();
      if (pendingTag) await addCpTag(pendingTag);
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('cpDelete').addEventListener('click', async () => {
    if (!confirm('Delete this contact? This can\'t be undone.')) return;
    try {
      await api('/contacts/' + cpContactId, { method: 'DELETE' });
      toast('Contact deleted.');
      switchTab('contacts');
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function removeCpTag(tag) {
    try {
      // Use the write's own response (GHL returns the full updated tags
      // list directly) instead of a separate GET re-fetch -- that re-fetch
      // occasionally lands before GHL's read path catches up with the
      // write, showing stale tags right after a successful change (same
      // eventual-consistency class of bug already hit elsewhere in this app).
      const result = await api(`/contacts/${cpContactId}/tags`, { method: 'DELETE', body: JSON.stringify({ tags: [tag] }) });
      toast(`Tag "${tag}" removed.`);
      renderCpTagEdit(result.tags);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function addCpTag(tag) {
    try {
      const result = await api(`/contacts/${cpContactId}/tags`, { method: 'POST', body: JSON.stringify({ tags: [tag] }) });
      document.getElementById('cpNewTag').value = '';
      toast(`Tag "${tag}" added.`);
      renderCpTagEdit(result.tags);
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('cpNewTag').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = e.target.value.trim();
    if (tag) addCpTag(tag);
  });

  document.getElementById('cpAddTagBtn').addEventListener('click', () => {
    const tag = document.getElementById('cpNewTag').value.trim();
    if (tag) addCpTag(tag);
    else document.getElementById('cpNewTag').focus();
  });

  // All jobs across every pipeline -- used for the Contacts table's "Active
  // Jobs" count column and this page's linked-jobs list. Cached for the
  // session; refreshed whenever a job write happens elsewhere.
  let allJobsCache = null;
  async function ensureAllJobsCache(force) {
    if (allJobsCache && !force) return allJobsCache;
    const { jobs } = await api('/jobs');
    allJobsCache = jobs || [];
    return allJobsCache;
  }

  function jobStatusBadgeClass(status) {
    if (status === 'open') return 'amber';
    if (/^won$/i.test(status || '')) return 'green';
    return 'red';
  }

  async function loadCpJobs(contactId) {
    const box = document.getElementById('cpJobs');
    try {
      const jobs = await ensureAllJobsCache();
      const linked = jobs.filter((j) => j.contactId === contactId);
      if (!linked.length) {
        box.innerHTML = '<div class="muted" style="font-size:13px">No jobs for this contact.</div>';
        return;
      }
      box.innerHTML = linked
        .map(
          (j) => `
        <div class="dash-row" data-open-job="${j.id}">
          <div><div class="name">Case #${shortCaseId(j.id)}</div><div class="sub">${[j.carMake, j.carModel].filter(Boolean).join(' ') || j.name || ''}</div></div>
          <span class="status-badge ${jobStatusBadgeClass(j.status)}">${displayStageName(j.stageName) || j.status}</span>
        </div>`
        )
        .join('');
      box.querySelectorAll('[data-open-job]').forEach((el) => {
        el.addEventListener('click', () => openJobDetail(el.dataset.openJob));
      });
    } catch (err) {
      box.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  // ---------- Contact page: conversation ----------
  async function loadCpConversation(contactId) {
    const header = document.getElementById('cpConvoHeader');
    const thread = document.getElementById('cpConvoThread');
    const replyBox = document.getElementById('cpConvoReplyBox');
    const startBox = document.getElementById('cpConvoStart');
    try {
      if (!cpPhoneNumbersLoaded) {
        try {
          const { phoneNumbers } = await api('/conversations/numbers');
          document.getElementById('cpFromNumber').innerHTML = (phoneNumbers || [])
            .map((n) => `<option value="${n.value}">${n.title || n.value}</option>`)
            .join('') || '<option value="">Default number</option>';
        } catch {
          document.getElementById('cpFromNumber').innerHTML = '<option value="">Default number</option>';
        }
        cpPhoneNumbersLoaded = true;
      }

      const { conversations } = await api('/conversations');
      const convo = (conversations || []).find((c) => c.contactId === contactId);
      if (!convo) {
        header.className = 'convo-header muted';
        header.textContent = 'Conversation';
        thread.innerHTML = '';
        startBox.style.display = 'block';
        return;
      }
      cpConvoId = convo.id;
      header.className = 'convo-header';
      header.innerHTML = `
        <div class="name">${convo.contactName || convo.fullName || 'Unknown'}</div>
        <div class="meta">
          ${convo.phone ? `<span>📞 ${convo.phone}</span>` : ''}
          ${convo.email ? `<span>✉ ${convo.email}</span>` : ''}
        </div>`;
      replyBox.style.display = 'flex';
      await loadCpMessages();
    } catch (err) {
      header.className = 'convo-header muted';
      header.textContent = err.message;
    }
  }

  async function loadCpMessages() {
    const thread = document.getElementById('cpConvoThread');
    if (!cpConvoId) return;
    thread.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const { messages } = await api(`/conversations/${cpConvoId}/messages`);
      // GHL logs a booked appointment as an activity message on the same
      // conversation timeline as SMS/email (confirmed live, with the same
      // few-seconds eventual-consistency delay seen elsewhere in this app)
      // -- shown here as a distinct row, clickable through to the same
      // appointment detail popup used on the Calendar tab.
      const relevant = (messages || []).filter(
        (m) =>
          m.messageType === 'TYPE_SMS' ||
          m.messageType === 'TYPE_EMAIL' ||
          m.messageType === 'TYPE_ACTIVITY_APPOINTMENT' ||
          m.messageType === 'TYPE_CALL'
      );
      if (!relevant.length) {
        thread.innerHTML = '<div class="muted">No messages yet.</div>';
        return;
      }
      const emailMessages = [];
      thread.innerHTML = relevant
        .slice()
        .reverse()
        .map((m) => {
          if (m.messageType === 'TYPE_ACTIVITY_APPOINTMENT') {
            const apptId = m.activity?.data?.id || '';
            const title = m.activity?.data?.appointmentTitle || m.body || 'Appointment';
            const when = m.activity?.data?.timestamp
              ? new Date(m.activity.data.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : '';
            return `<div class="msg-activity" data-appt-activity="${apptId}">📅 Appointment booked: <strong>${escapeHtml(title)}</strong>${when ? ` — ${when}` : ''}</div>`;
          }
          if (m.messageType === 'TYPE_CALL') return renderCallRow(m);
          if (m.messageType === 'TYPE_EMAIL') {
            emailMessages.push(m);
            return renderEmailRow(m, emailMessages.length - 1);
          }
          const failed = m.status === 'failed';
          const cls = failed ? 'failed' : m.direction === 'outbound' ? 'outbound' : 'inbound';
          const time = new Date(m.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<div class="msg-bubble ${cls}">${escapeHtml(m.body || '')}<div class="mt">${failed ? `⚠ ${m.error || 'Failed to send'}` : time}</div></div>`;
        })
        .join('');
      thread.querySelectorAll('[data-appt-activity]').forEach((el) => {
        if (el.dataset.apptActivity) el.addEventListener('click', () => openAppointmentDetail(el.dataset.apptActivity));
      });
      wireCallRows(thread);
      wireEmailBodies(thread, emailMessages);
      thread.scrollTop = thread.scrollHeight;
    } catch (err) {
      thread.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  document.getElementById('cpConvoStartBtn').addEventListener('click', async () => {
    const phone = document.getElementById('cpPhone').value.trim();
    if (!phone) return toast('Add a phone number for this contact first.', true);
    try {
      const { conversation } = await api('/conversations', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('cpName').textContent,
          phone,
          email: document.getElementById('cpEmail').value.trim(),
        }),
      });
      cpConvoId = conversation.id;
      document.getElementById('cpConvoStart').style.display = 'none';
      document.getElementById('cpConvoReplyBox').style.display = 'flex';
      toast('Conversation started.');
      await loadCpMessages();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function sendCpConvoReply() {
    const input = document.getElementById('cpConvoReplyInput');
    const message = input.value.trim();
    if (!message || !cpConvoId) return;
    input.value = '';
    const fromNumber = document.getElementById('cpFromNumber').value;
    try {
      await api(`/conversations/${cpConvoId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ contactId: cpContactId, message, fromNumber }),
      });
      await loadCpMessages();
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('cpConvoSendBtn').addEventListener('click', sendCpConvoReply);
  document.getElementById('cpConvoReplyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCpConvoReply();
  });

  // ---------- Contact page: notes ----------
  function renderNoteItem(n) {
    const isJob = n.source === 'job';
    const time = new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="note-card" data-note="${n.id}">
        <div class="note-head">
          <span class="status-badge ${isJob ? 'amber' : 'green'}">${isJob ? 'Job' : 'Contact'}</span>
          <span class="muted" style="font-size:11px">${time}</span>
        </div>
        <div class="note-body">${escapeHtml(n.body)}</div>
        ${isJob ? `<div class="link" data-open-job-note="${n.job_id}" style="font-size:12px;margin-top:4px">View Job #${n.job_id} →</div>` : ''}
        <div class="note-actions">
          <span class="link" data-edit-note="${n.id}">Edit</span>
          <span class="link" data-del-note="${n.id}" style="color:var(--red)">Delete</span>
        </div>
      </div>`;
  }

  async function loadCpNotes(contactId) {
    const box = document.getElementById('cpNotesList');
    try {
      const { notes } = await api(`/contacts/${contactId}/notes`);
      if (!notes.length) {
        box.innerHTML = '<div class="muted" style="font-size:13px">No notes yet.</div>';
        return;
      }
      box.innerHTML = notes.map(renderNoteItem).join('');
      box.querySelectorAll('[data-open-job-note]').forEach((el) => {
        el.addEventListener('click', () => openJobDetail(el.dataset.openJobNote));
      });
      box.querySelectorAll('[data-edit-note]').forEach((el) => {
        el.addEventListener('click', () => startEditCpNote(el.dataset.editNote, notes));
      });
      box.querySelectorAll('[data-del-note]').forEach((el) => {
        el.addEventListener('click', () => deleteCpNote(el.dataset.delNote));
      });
    } catch (err) {
      box.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  let cpEditingNoteId = null;

  document.getElementById('cpAddNoteBtn').addEventListener('click', () => {
    cpEditingNoteId = null;
    document.getElementById('cpNoteInput').value = '';
    document.getElementById('cpNoteForm').style.display = 'block';
  });

  function startEditCpNote(id, notes) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    cpEditingNoteId = id;
    document.getElementById('cpNoteInput').value = note.body;
    document.getElementById('cpNoteForm').style.display = 'block';
  }

  document.getElementById('cpNoteCancel').addEventListener('click', () => {
    document.getElementById('cpNoteForm').style.display = 'none';
  });

  document.getElementById('cpNoteSave').addEventListener('click', async () => {
    const body = document.getElementById('cpNoteInput').value.trim();
    if (!body) return toast('Note can\'t be empty.', true);
    try {
      let warning;
      if (cpEditingNoteId) {
        ({ warning } = await api(`/notes/${cpEditingNoteId}`, { method: 'PUT', body: JSON.stringify({ body }) }));
      } else {
        ({ warning } = await api(`/contacts/${cpContactId}/notes`, { method: 'POST', body: JSON.stringify({ body }) }));
      }
      document.getElementById('cpNoteForm').style.display = 'none';
      toast(warning || 'Note saved.', Boolean(warning));
      loadCpNotes(cpContactId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function deleteCpNote(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      toast('Note deleted.');
      loadCpNotes(cpContactId);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- Jobs ----------
  let pipelinesCacheAll = [];
  let selectedPipelineId = null;
  let jobsCache = [];
  let jobSearchQuery = '';
  let jobSortOrder = 'newest';
  const jobFilters = { dateFrom: '', dateTo: '' };
  const COL_ACCENTS = ['navy', 'red', 'green', 'amber'];

  function sortJobs(jobs) {
    const sorted = [...jobs];
    if (jobSortOrder === 'oldest') sorted.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    else if (jobSortOrder === 'value_desc') sorted.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    else if (jobSortOrder === 'value_asc') sorted.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
    else sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted;
  }

  function jobMatchesSearch(job, contact) {
    if (!jobSearchQuery) return true;
    const q = jobSearchQuery.toLowerCase();
    const vehicle = [job.carMake, job.carModel].filter(Boolean).join(' ');
    const haystack = [job.id, job.name, vehicle, job.damageDescription, contact ? contactName(contact) : '']
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  }

  function jobMatchesDateFilter(job) {
    if (!jobFilters.dateFrom && !jobFilters.dateTo) return true;
    if (!job.createdAt) return false;
    const created = new Date(job.createdAt).getTime();
    if (jobFilters.dateFrom && created < new Date(jobFilters.dateFrom + 'T00:00:00').getTime()) return false;
    if (jobFilters.dateTo && created > new Date(jobFilters.dateTo + 'T23:59:59').getTime()) return false;
    return true;
  }

  async function loadJobsTab() {
    const board = document.getElementById('board');
    board.innerHTML = '<div class="loading">Loading…</div>';
    document.getElementById('jobsCountBadge').textContent = '';
    try {
      const needsContacts = !contactsCache.length;
      const [pipelinesRes, contactsRes] = await Promise.all([
        api('/pipelines'),
        needsContacts ? api('/contacts') : Promise.resolve(null),
      ]);
      if (contactsRes) contactsCache = contactsRes.contacts || [];
      pipelinesCacheAll = pipelinesRes.pipelines || [];

      const label = document.getElementById('pipelineLabel');
      if (!pipelinesCacheAll.length) {
        label.textContent = '';
        board.innerHTML = '<div class="muted">No "Repair Status" pipeline connected — contact your agency.</div>';
        return;
      }
      selectedPipelineId = pipelinesCacheAll[0].id;
      label.textContent = pipelinesCacheAll[0].name;

      await renderBoard();
    } catch (err) {
      board.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  let jobSearchDebounce;
  document.getElementById('jobSearch').addEventListener('input', (e) => {
    clearTimeout(jobSearchDebounce);
    jobSearchDebounce = setTimeout(() => {
      jobSearchQuery = e.target.value.trim();
      renderBoardFromCache();
    }, 300);
  });

  document.getElementById('jobSortSelect').addEventListener('change', (e) => {
    jobSortOrder = e.target.value;
    renderBoardFromCache();
  });

  const jobFilterBtn = document.getElementById('jobFilterBtn');
  const jobFilterPanel = document.getElementById('jobFilterPanel');
  jobFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    jobFilterPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!jobFilterPanel.contains(e.target) && e.target !== jobFilterBtn) jobFilterPanel.classList.remove('open');
  });
  jobFilterPanel.addEventListener('click', (e) => e.stopPropagation());

  document.querySelectorAll('#jobDatePresets .fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#jobDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const { from, to } = presetRange(btn.dataset.preset);
      document.getElementById('jobDateFrom').value = from;
      document.getElementById('jobDateTo').value = to;
    });
  });
  ['jobDateFrom', 'jobDateTo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('#jobDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
    });
  });

  function renderJobFilterChips() {
    const row = document.getElementById('jobFilterChips');
    const chips = [];
    if (jobFilters.dateFrom || jobFilters.dateTo) {
      const label = `Created: ${jobFilters.dateFrom || '…'} → ${jobFilters.dateTo || '…'}`;
      chips.push({ label, onRemove: () => { jobFilters.dateFrom = ''; jobFilters.dateTo = ''; syncJobFilterUI(); applyJobFilters(); } });
    }
    row.innerHTML = '';
    chips.forEach((c) => {
      const span = document.createElement('span');
      span.className = 'fchip';
      span.innerHTML = `${c.label}<button type="button">×</button>`;
      span.querySelector('button').addEventListener('click', c.onRemove);
      row.appendChild(span);
    });
    const countEl = document.getElementById('jobFilterCount');
    countEl.textContent = chips.length ? `(${chips.length})` : '';
  }

  function syncJobFilterUI() {
    document.getElementById('jobDateFrom').value = jobFilters.dateFrom;
    document.getElementById('jobDateTo').value = jobFilters.dateTo;
    document.querySelectorAll('#jobDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
  }

  function applyJobFilters() {
    renderJobFilterChips();
    renderBoardFromCache();
  }

  document.getElementById('jobFilterApply').addEventListener('click', () => {
    jobFilters.dateFrom = document.getElementById('jobDateFrom').value;
    jobFilters.dateTo = document.getElementById('jobDateTo').value;
    jobFilterPanel.classList.remove('open');
    applyJobFilters();
  });

  document.getElementById('jobFilterClear').addEventListener('click', () => {
    jobFilters.dateFrom = '';
    jobFilters.dateTo = '';
    syncJobFilterUI();
    jobFilterPanel.classList.remove('open');
    applyJobFilters();
  });

  async function renderBoard() {
    const [jobsRes] = await Promise.all([
      api('/jobs?pipelineId=' + encodeURIComponent(selectedPipelineId)),
      loadJobCardWidgetData(),
    ]);
    jobsCache = jobsRes.jobs || [];
    renderBoardFromCache();
  }

  // Bulk (one-call-each, not per-card) data behind the conversation/
  // appointment job-card icons -- reloaded whenever the board is explicitly
  // (re)loaded, then read synchronously by every card during render.
  let convosByContactCache = new Map();
  let apptsByContactCache = new Map();
  async function loadJobCardWidgetData() {
    try {
      const { conversations } = await api('/conversations');
      convosByContactCache = new Map((conversations || []).map((c) => [c.contactId, c]));
    } catch {
      convosByContactCache = new Map();
    }
    try {
      const { appointments } = await api('/calendars/default/appointments');
      const map = new Map();
      (appointments || []).forEach((a) => {
        if (!a.contactId) return;
        if (!map.has(a.contactId)) map.set(a.contactId, []);
        map.get(a.contactId).push(a);
      });
      apptsByContactCache = map;
    } catch {
      apptsByContactCache = new Map();
    }
  }

  // Renders purely from the in-memory jobsCache -- no API call. Used after a
  // stage move so the UI reflects the PUT response (always immediately
  // correct) instead of re-querying GHL's /opportunities/search endpoint,
  // which lags a few seconds behind writes (same eventual-consistency
  // behavior seen on contacts search and freshly created pipelines).
  // Flat outline SVGs (not emoji) so job-card icons match the rest of the
  // app's monochrome symbol style instead of clashing as colorful glyphs.
  const ICON_TAG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.5 3.17L3 3v6.5a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83Z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
  const ICON_NOTE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>';
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>';
  const ICON_CALENDAR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

  function renderBoardFromCache() {
    const board = document.getElementById('board');
    const pipeline = pipelinesCacheAll.find((p) => p.id === selectedPipelineId);
    const stages = pipeline?.stages || [];

    board.innerHTML = '';
    if (!stages.length) {
      board.innerHTML = '<div class="muted">This pipeline has no stages.</div>';
      return;
    }

    const matchesFilters = (j) => {
      const contact = contactsCache.find((c) => c.id === j.contactId);
      return jobMatchesSearch(j, contact) && jobMatchesDateFilter(j);
    };
    const totalMatching = jobsCache.filter(matchesFilters).length;
    const countBadge = document.getElementById('jobsCountBadge');
    if (countBadge) countBadge.textContent = `${totalMatching} job${totalMatching === 1 ? '' : 's'}`;

    stages.forEach((stage, idx) => {
      const col = document.createElement('div');
      col.className = 'col accent-' + COL_ACCENTS[idx % COL_ACCENTS.length];
      col.dataset.stageId = stage.id;
      const stageJobs = sortJobs(jobsCache.filter((j) => j.stageId === stage.id && matchesFilters(j)));
      const stageValue = stageJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0);
      col.innerHTML = `
        <h4>${displayStageName(stage.name)}</h4>
        <div class="col-meta"><span>${stageJobs.length} job${stageJobs.length === 1 ? '' : 's'}</span><span>${money(stageValue)}</span></div>
      `;
      stageJobs.forEach((job) => {
        const card = document.createElement('div');
        card.className = 'jobcard';
        card.draggable = true;
        card.dataset.jobId = job.id;
        // job.customerName comes straight from GHL's opportunity response --
        // more reliable than cross-referencing contactsCache, which is
        // capped at a page of contacts and can miss one on larger accounts
        // (falling back to a raw GHL id there looked exactly like a case #).
        const contact = contactsCache.find((c) => c.id === job.contactId);
        const displayName = job.customerName || (contact ? contactName(contact) : null) || 'Unknown Contact';
        const vehicle = [job.carMake, job.carModel].filter(Boolean).join(' ');
        const tagCount = (job.tags || []).length;
        const convo = convosByContactCache.get(job.contactId);
        const convoUnread = convo?.unreadCount || 0;
        const apptCount = (apptsByContactCache.get(job.contactId) || []).length;
        card.innerHTML = `
          <div class="jn">${displayName}</div>
          <div class="jc">${vehicle || job.name}</div>
          <div class="jval">Value: ${money(job.value)}</div>
          ${job.damageDescription ? `<div class="jd">${job.damageDescription}</div>` : ''}
          <div class="jcard-icons">
            <span class="jcard-icon" data-job-convo title="Conversation">${ICON_CHAT}${convoUnread ? `<span class="badge navy">${convoUnread}</span>` : ''}</span>
            <span class="jcard-icon" data-job-appt title="Appointments">${ICON_CALENDAR}${apptCount ? `<span class="badge navy">${apptCount}</span>` : ''}</span>
            <span class="jcard-icon" data-job-tags title="Tags">${ICON_TAG}${tagCount ? `<span class="badge navy">${tagCount}</span>` : ''}</span>
            <span class="jcard-icon" data-job-notes title="Notes">${ICON_NOTE}<span class="badge navy" data-notes-badge style="display:none">0</span></span>
          </div>
        `;
        card.querySelector('[data-job-tags]').addEventListener('click', (e) => {
          e.stopPropagation();
          showTagsPopover(e.currentTarget, job);
        });
        card.querySelector('[data-job-notes]').addEventListener('click', (e) => {
          e.stopPropagation();
          showNotesPopover(e.currentTarget, job);
        });
        card.querySelector('[data-job-convo]').addEventListener('click', (e) => {
          e.stopPropagation();
          showConvoPopover(e.currentTarget, job);
        });
        card.querySelector('[data-job-appt]').addEventListener('click', (e) => {
          e.stopPropagation();
          showApptPopover(e.currentTarget, job);
        });
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
    hydrateJobCardNoteBadges();
  }

  // Notes counts aren't in the opportunity payload GHL already gives us for
  // free (unlike tags, which ride along on opportunity.contact.tags) -- each
  // is its own cheap local-only Supabase lookup (no GHL round trip), fired
  // in parallel after the board's already visible so typing in the job
  // search box never blocks on them. Cached per job so re-renders triggered
  // by search/sort/filter don't refire the same fetch; invalidated whenever
  // a job note is actually added/edited/deleted.
  const jobNotesCountCache = new Map();
  function hydrateJobCardNoteBadges() {
    document.querySelectorAll('.jobcard [data-job-notes]').forEach(async (el) => {
      const card = el.closest('.jobcard');
      const jobId = card?.dataset.jobId;
      if (!jobId) return;
      const badge = el.querySelector('[data-notes-badge]');
      if (jobNotesCountCache.has(jobId)) {
        const count = jobNotesCountCache.get(jobId);
        if (count) { badge.textContent = count; badge.style.display = 'inline-block'; }
        return;
      }
      try {
        const { notes } = await api(`/jobs/${jobId}/notes`);
        jobNotesCountCache.set(jobId, notes.length);
        if (notes.length) { badge.textContent = notes.length; badge.style.display = 'inline-block'; }
      } catch {
        // leave the badge hidden -- a failed count fetch isn't worth a toast
      }
    });
  }

  // ---------- Job card icon popovers (tags / notes) ----------
  let iconPopoverEl = null;
  function closeIconPopover() {
    if (iconPopoverEl) { iconPopoverEl.remove(); iconPopoverEl = null; }
  }
  document.addEventListener('click', (e) => {
    if (iconPopoverEl && !iconPopoverEl.contains(e.target) && !e.target.closest('.jcard-icon')) closeIconPopover();
  });

  function openIconPopover(anchorEl, title, bodyHtml) {
    closeIconPopover();
    const pop = document.createElement('div');
    pop.className = 'icon-popover';
    pop.innerHTML = `<h5>${escapeHtml(title)}</h5>${bodyHtml}`;
    document.body.appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    let left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12);
    let top = rect.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 10) top = Math.max(10, rect.top - pop.offsetHeight - 6);
    pop.style.left = `${Math.max(10, left)}px`;
    pop.style.top = `${top}px`;
    iconPopoverEl = pop;
    return pop;
  }

  function showTagsPopover(anchorEl, job) {
    const tags = job.tags || [];
    const body = tags.length
      ? `<div>${tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>`
      : '<div class="ip-empty">No tags.</div>';
    openIconPopover(anchorEl, 'Tags', body);
  }

  async function showNotesPopover(anchorEl, job) {
    const pop = openIconPopover(anchorEl, 'Notes', '<div class="ip-empty">Loading…</div>');
    try {
      const { notes } = await api(`/jobs/${job.id}/notes`);
      if (iconPopoverEl !== pop) return; // closed or replaced while this was in flight
      jobNotesCountCache.set(job.id, notes.length);
      pop.innerHTML = notes.length
        ? `<h5>Notes</h5>${notes
            .map(
              (n) => `<div class="ip-note">${escapeHtml(n.body.length > 140 ? n.body.slice(0, 140) + '…' : n.body)}<div class="muted" style="font-size:11px;margin-top:3px">${new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div></div>`
            )
            .join('')}`
        : '<h5>Notes</h5><div class="ip-empty">No notes yet.</div>';
    } catch (err) {
      if (iconPopoverEl === pop) pop.innerHTML = `<h5>Notes</h5><div class="ip-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function showConvoPopover(anchorEl, job) {
    const convo = convosByContactCache.get(job.contactId);
    if (!convo) {
      openIconPopover(anchorEl, 'Conversation', '<div class="ip-empty">No conversation yet.</div>');
      return;
    }
    const time =
      convo.lastMessageDate && convo.lastMessageBody
        ? new Date(convo.lastMessageDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
    const preview = convo.lastMessageBody
      ? escapeHtml(convo.lastMessageBody.length > 160 ? convo.lastMessageBody.slice(0, 160) + '…' : convo.lastMessageBody)
      : '<span class="muted">No messages yet.</span>';
    const pop = openIconPopover(
      anchorEl,
      'Conversation',
      `<div class="ip-note">${preview}${time ? `<div class="muted" style="font-size:11px;margin-top:3px">${time}</div>` : ''}</div>
       <div class="link" data-goto-convo style="margin-top:8px;display:inline-block">View full conversation →</div>`
    );
    pop.querySelector('[data-goto-convo]')?.addEventListener('click', async () => {
      closeIconPopover();
      switchTab('conversations');
      await loadConversationsTab();
      selectConversation(convo.id);
    });
  }

  function showApptPopover(anchorEl, job) {
    const appts = (apptsByContactCache.get(job.contactId) || [])
      .slice()
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    if (!appts.length) {
      openIconPopover(anchorEl, 'Appointments', '<div class="ip-empty">No appointments.</div>');
      return;
    }
    const now = Date.now();
    const next = appts.find((a) => new Date(a.startTime).getTime() >= now) || appts[appts.length - 1];
    const time = new Date(next.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const pop = openIconPopover(
      anchorEl,
      'Appointments',
      `<div class="ip-note">
         <strong>${escapeHtml(next.title || 'Appointment')}</strong>
         <div class="muted" style="font-size:11px;margin-top:3px">${time}</div>
         ${next.appointmentStatus || next.status ? `<div class="muted" style="font-size:11px;text-transform:capitalize">${escapeHtml(next.appointmentStatus || next.status)}</div>` : ''}
       </div>
       ${appts.length > 1 ? `<div class="muted" style="font-size:11.5px;margin-top:6px">+${appts.length - 1} more</div>` : ''}
       <div class="link" data-goto-appt style="margin-top:8px;display:inline-block">View details →</div>`
    );
    pop.querySelector('[data-goto-appt]')?.addEventListener('click', () => {
      closeIconPopover();
      openAppointmentDetail(next.id);
    });
  }

  async function moveJobStage(jobId, stageId) {
    try {
      const { job } = await api('/jobs/' + jobId, { method: 'PUT', body: JSON.stringify({ stageId }) });
      toast('Job stage updated.');
      const idx = jobsCache.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobsCache[idx] = { ...jobsCache[idx], ...job };
      allJobsCache = null;
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
      allJobsCache = null;
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

  let activeJobContactId = null;

  async function openJobDetail(jobId) {
    const cached = jobsCache.find((j) => j.id === jobId) || (allJobsCache || []).find((j) => j.id === jobId);
    activeJobId = jobId;
    activeJobContactId = cached?.contactId || null;

    document.getElementById('jdCase').textContent = `Case #${shortCaseId(jobId)}`;
    const statusSel = document.getElementById('jdStatus');
    statusSel.value = cached?.status || 'open';
    statusSel.onchange = (e) => updateJobStatus(jobId, e.target.value);
    document.getElementById('jdUploadForm').style.display = 'none';
    document.getElementById('jdNoteForm').style.display = 'none';
    openModal('jobDetailModal');

    try {
      const { job } = await api('/jobs/' + jobId);
      activeJobContactId = job.contactId;
      const idx = jobsCache.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobsCache[idx] = { ...jobsCache[idx], ...job };
      let contact = contactsCache.find((c) => c.id === job.contactId);
      if (!contact && job.contactId) {
        try {
          contact = (await api('/contacts/' + job.contactId)).contact;
        } catch {
          contact = null;
        }
      }

      document.getElementById('jdContact').textContent = contact ? contactName(contact) : job.contactId || '';
      document.getElementById('jdVehicle').textContent = [job.carMake, job.carModel].filter(Boolean).join(' ') || '—';
      document.getElementById('jdValue').textContent = money(job.value);
      document.getElementById('jdDamage').textContent = job.damageDescription || '—';
      statusSel.value = job.status || 'open';
      renderJobCustomFields(job.customFieldsDisplay);
    } catch (err) {
      toast(err.message, true);
    }

    await loadJobFiles(jobId);
    await loadJobNotes(jobId);
  }

  document.getElementById('jdViewContact').addEventListener('click', () => {
    if (!activeJobContactId) return toast('No contact linked to this job.', true);
    closeModal('jobDetailModal');
    switchTab('contacts');
    showContactPage(activeJobContactId);
  });

  async function loadJobNotes(jobId) {
    const box = document.getElementById('jdNotes');
    box.innerHTML = '<div class="muted" style="font-size:13px">Loading…</div>';
    try {
      const { notes } = await api(`/jobs/${jobId}/notes`);
      if (!notes.length) {
        box.innerHTML = '<div class="muted" style="font-size:13px">No notes yet.</div>';
        return;
      }
      box.innerHTML = notes
        .map(
          (n) => `
        <div class="note-card" data-note="${n.id}">
          <div class="note-head">
            <span class="muted" style="font-size:11px">${new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div class="note-body">${escapeHtml(n.body)}</div>
          <div class="note-actions">
            <span class="link" data-edit-jnote="${n.id}">Edit</span>
            <span class="link" data-del-jnote="${n.id}" style="color:var(--red)">Delete</span>
          </div>
        </div>`
        )
        .join('');
      box.querySelectorAll('[data-edit-jnote]').forEach((el) => {
        el.addEventListener('click', () => startEditJobNote(el.dataset.editJnote, notes));
      });
      box.querySelectorAll('[data-del-jnote]').forEach((el) => {
        el.addEventListener('click', () => deleteJobNote(el.dataset.delJnote));
      });
    } catch (err) {
      box.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  let jdEditingNoteId = null;

  document.getElementById('jdAddNoteBtn').addEventListener('click', () => {
    jdEditingNoteId = null;
    document.getElementById('jdNoteInput').value = '';
    document.getElementById('jdNoteForm').style.display = 'block';
  });

  function startEditJobNote(id, notes) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    jdEditingNoteId = id;
    document.getElementById('jdNoteInput').value = note.body;
    document.getElementById('jdNoteForm').style.display = 'block';
  }

  document.getElementById('jdNoteCancel').addEventListener('click', () => {
    document.getElementById('jdNoteForm').style.display = 'none';
  });

  document.getElementById('jdNoteSave').addEventListener('click', async () => {
    const body = document.getElementById('jdNoteInput').value.trim();
    if (!body) return toast('Note can\'t be empty.', true);
    try {
      let warning;
      if (jdEditingNoteId) {
        ({ warning } = await api(`/notes/${jdEditingNoteId}`, { method: 'PUT', body: JSON.stringify({ body }) }));
      } else {
        ({ warning } = await api(`/jobs/${activeJobId}/notes`, { method: 'POST', body: JSON.stringify({ body }) }));
      }
      document.getElementById('jdNoteForm').style.display = 'none';
      toast(warning || 'Note saved.', Boolean(warning));
      jobNotesCountCache.delete(activeJobId);
      loadJobNotes(activeJobId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function deleteJobNote(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      toast('Note deleted.');
      jobNotesCountCache.delete(activeJobId);
      loadJobNotes(activeJobId);
    } catch (err) {
      toast(err.message, true);
    }
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
    // Reuse the Calendar tab's cache when available; otherwise (e.g. opened
    // from a contact's conversation, which never visited the Calendar tab)
    // fetch the appointment and calendar list directly.
    let appt = appointmentsCache.find((a) => a.id === apptId);
    if (!appt) {
      try {
        ({ appointment: appt } = await api(`/calendars/appointment/${apptId}`));
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (!calendarsCache.length) {
      try {
        const { calendars } = await api('/calendars');
        calendarsCache = calendars || [];
      } catch {
        // Fall through -- calendar name will just show the raw id below.
      }
    }
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

  // ---------- Calls (SMS/Email conversation timeline also carries TYPE_CALL
  // entries for every phone call GHL logs against a contact -- AI-agent or
  // human-dialed, inbound or outbound) ----------
  const CALL_STATUS_LABEL = {
    completed: 'Call completed',
    'no-answer': 'No answer',
    voicemail: 'Voicemail',
    busy: 'Busy',
    failed: 'Call failed',
  };

  function renderCallRow(m) {
    const dir = m.direction === 'outbound' ? 'outbound' : 'inbound';
    const status = m.meta?.call?.status || m.status || '';
    const duration = m.meta?.call?.duration;
    const durStr = duration ? ` (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})` : '';
    const time = new Date(m.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const label = CALL_STATUS_LABEL[status] || 'Call';
    return `<div class="msg-activity" data-call="${m.id}" data-call-contact="${m.contactId}" data-call-dir="${dir}" data-call-status="${escapeHtml(status)}" data-call-duration="${duration || ''}" data-call-time="${m.dateAdded}">📞 ${dir === 'outbound' ? 'Outbound' : 'Inbound'} ${label}${durStr} — ${time}</div>`;
  }

  // ---------- Emails (shown as an envelope card, not a chat bubble, same
  // distinction GHL's own conversation view makes) ----------
  function renderEmailRow(m, idx) {
    const dir = m.direction === 'outbound' ? 'outbound' : 'inbound';
    const subject = m.meta?.email?.subject || m.subject || '(no subject)';
    const time = new Date(m.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="msg-email ${dir}">
      <div class="msg-email-head">
        <span class="dir">${dir === 'outbound' ? '📤 Sent' : '📥 Received'}</span>
        <span class="subj">${escapeHtml(subject)}</span>
        <span class="mt">${time}</span>
      </div>
      <div class="msg-email-body" data-email-body="${idx}"></div>
    </div>`;
  }

  // Email bodies come back as raw (often externally-sourced) HTML -- never
  // innerHTML this directly. A fully sandboxed iframe (no allow-scripts, no
  // allow-forms, no allow-top-navigation) renders the formatting safely with
  // zero script-execution surface; allow-same-origin alone is safe here
  // specifically because allow-scripts is never granted, so there's nothing
  // for it to execute -- it's only there so we can read scrollHeight back to
  // auto-size the frame.
  function wireEmailBodies(thread, emailMessages) {
    thread.querySelectorAll('[data-email-body]').forEach((slot) => {
      const m = emailMessages[Number(slot.dataset.emailBody)];
      if (!m) return;
      if ((m.contentType || '').includes('html')) {
        const frame = document.createElement('iframe');
        frame.className = 'email-body-frame';
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = m.body || '';
        frame.addEventListener('load', () => {
          try {
            frame.style.height = `${frame.contentDocument.documentElement.scrollHeight}px`;
          } catch {
            frame.style.height = '120px';
          }
        });
        slot.appendChild(frame);
      } else {
        const pre = document.createElement('pre');
        pre.textContent = m.body || '';
        slot.appendChild(pre);
      }
    });
  }

  function wireCallRows(thread) {
    thread.querySelectorAll('[data-call]').forEach((el) => {
      el.addEventListener('click', () =>
        openCallDetail({
          messageId: el.dataset.call,
          contactId: el.dataset.callContact,
          direction: el.dataset.callDir,
          status: el.dataset.callStatus,
          duration: el.dataset.callDuration ? Number(el.dataset.callDuration) : null,
          dateAdded: el.dataset.callTime,
        })
      );
    });
  }

  async function openCallDetail(call) {
    document.getElementById('cdTitle').textContent = call.direction === 'outbound' ? 'Outbound Call' : 'Inbound Call';
    document.getElementById('cdTime').textContent = call.dateAdded
      ? new Date(call.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    document.getElementById('cdDirection').textContent = call.direction === 'outbound' ? 'Outbound' : 'Inbound';
    document.getElementById('cdStatus').textContent = call.status || '—';
    document.getElementById('cdDuration').textContent = call.duration
      ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, '0')}`
      : '—';

    const audio = document.getElementById('cdAudio');
    audio.removeAttribute('src');
    document.getElementById('cdRecordingWrap').style.display = 'none';
    document.getElementById('cdSummaryWrap').style.display = 'none';
    document.getElementById('cdTranscript').innerHTML = '<span class="muted">Loading…</span>';

    const contactWrap = document.getElementById('cdContactWrap');
    const contactBox = document.getElementById('cdContact');
    if (call.contactId) {
      contactWrap.style.display = 'block';
      contactBox.innerHTML = '<span class="muted">Loading contact…</span>';
      api(`/contacts/${call.contactId}`)
        .then(({ contact }) => {
          contactBox.innerHTML = `
            <div style="font-weight:700">${escapeHtml(contactName(contact))}</div>
            <div class="muted">${escapeHtml(contact.email || '—')}</div>
            <div class="muted">${escapeHtml(contact.phone || '—')}</div>
            ${(contact.tags || []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}
          `;
        })
        .catch((err) => {
          contactBox.innerHTML = `<span class="muted">Could not load contact: ${escapeHtml(err.message)}</span>`;
        });
    } else {
      contactWrap.style.display = 'none';
    }

    openModal('callDetailModal');

    // Recording is best-effort -- not every call has one available.
    fetch(`/api/calls/${call.messageId}/recording`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const blob = await res.blob();
        audio.src = URL.createObjectURL(blob);
        document.getElementById('cdRecordingWrap').style.display = 'block';
      })
      .catch(() => {});

    const transcriptBox = document.getElementById('cdTranscript');
    try {
      const { voiceAi, transcription } = await api(`/calls/${call.messageId}/detail?contactId=${call.contactId || ''}`);
      if (voiceAi) {
        if (voiceAi.summary) {
          document.getElementById('cdSummary').textContent = voiceAi.summary;
          document.getElementById('cdSummaryWrap').style.display = 'block';
        }
        if (voiceAi.transcript) {
          transcriptBox.innerHTML = voiceAi.transcript
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const isBot = /^bot:/i.test(line);
              const text = line.replace(/^(bot|human):/i, '').trim();
              return `<div class="transcript-line ${isBot ? 'bot' : 'human'}"><strong>${isBot ? 'Agent:' : 'Caller:'}</strong>${escapeHtml(text)}</div>`;
            })
            .join('');
        } else {
          transcriptBox.innerHTML = '<span class="muted">Transcript not available for this call.</span>';
        }
      } else if (transcription) {
        // Shape not confirmed live (this GHL account's Voice Intelligence
        // add-on has never returned a successful transcription) -- render
        // defensively against the few plausible shapes rather than assume.
        const segments =
          transcription.transcriptions || transcription.segments || (Array.isArray(transcription) ? transcription : null);
        if (segments && segments.length) {
          transcriptBox.innerHTML = segments
            .map((s) => `<div class="transcript-line">${escapeHtml(s.transcript || s.sentence || s.text || JSON.stringify(s))}</div>`)
            .join('');
        } else {
          transcriptBox.innerHTML = '<span class="muted">Transcript not available for this call.</span>';
        }
      } else {
        transcriptBox.innerHTML = '<span class="muted">Transcript not available for this call.</span>';
      }
    } catch (err) {
      transcriptBox.innerHTML = `<span class="muted">${err.message}</span>`;
    }
  }
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
      .map((s) => `<div class="stagechip${/^won$/i.test(s.stageName) ? ' completed' : ''}"><span class="n">${s.count}</span>${displayStageName(s.stageName)} · ${money(s.value)}</div>`)
      .join('') || '<span class="muted">No stages.</span>';

    const body = document.getElementById('repPipelineBody');
    body.innerHTML = reportPipelineJobsCache.length
      ? reportPipelineJobsCache
          .map(
            (j) => `
      <tr>
        <td>#${shortCaseId(j.id)}</td>
        <td>${j.customerName || '—'}</td>
        <td>${[j.carMake, j.carModel].filter(Boolean).join(' ') || '—'}</td>
        <td>${money(j.value)}</td>
        <td>${displayStageName(j.stageName)}</td>
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
  let convoFilterMode = 'unread';
  let convoSortOrder = 'latest';
  const convoFilters = { dateFrom: '', dateTo: '', tags: [], direction: '' };

  document.getElementById('convoFilterTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.cf-tab');
    if (!btn) return;
    document.querySelectorAll('.cf-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    convoFilterMode = btn.dataset.filter;
    renderConvoList();
  });

  document.getElementById('convoSortSelect').addEventListener('change', (e) => {
    convoSortOrder = e.target.value;
    renderConvoList();
  });

  // ---------- Conversations: filters panel ----------
  const convoFilterBtn = document.getElementById('convoFilterBtn');
  const convoFilterPanel = document.getElementById('convoFilterPanel');
  convoFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Tags are drawn from whatever's already loaded in convosCache -- no
    // separate endpoint needed, since every conversation already carries
    // its contact's tags.
    const allTags = new Set();
    convosCache.forEach((c) => (c.tags || []).forEach((t) => allTags.add(t)));
    const box = document.getElementById('convoTagOptions');
    box.innerHTML = allTags.size
      ? [...allTags].map((t) => `<span class="fp-tag-opt${convoFilters.tags.includes(t) ? ' sel' : ''}" data-tag="${t}">${t}</span>`).join('')
      : '<span class="muted" style="font-size:12.5px">No tags yet.</span>';
    box.querySelectorAll('.fp-tag-opt').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('sel'));
    });
    convoFilterPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!convoFilterPanel.contains(e.target) && e.target !== convoFilterBtn) convoFilterPanel.classList.remove('open');
  });
  convoFilterPanel.addEventListener('click', (e) => e.stopPropagation());

  document.querySelectorAll('#convoDatePresets .fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#convoDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const { from, to } = presetRange(btn.dataset.preset);
      document.getElementById('convoDateFrom').value = from;
      document.getElementById('convoDateTo').value = to;
    });
  });
  ['convoDateFrom', 'convoDateTo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('#convoDatePresets .fp-preset').forEach((b) => b.classList.remove('sel'));
    });
  });

  let convoDirectionChoice = '';
  document.querySelectorAll('#convoDirectionPresets .fp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#convoDirectionPresets .fp-preset').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      convoDirectionChoice = btn.dataset.direction;
    });
  });

  function renderConvoFilterChips() {
    const row = document.getElementById('convoFilterChips');
    const chips = [];
    if (convoFilters.dateFrom || convoFilters.dateTo) {
      chips.push({
        label: `Last msg: ${convoFilters.dateFrom || '…'} → ${convoFilters.dateTo || '…'}`,
        onRemove: () => { convoFilters.dateFrom = ''; convoFilters.dateTo = ''; renderConvoFilterChips(); renderConvoList(); },
      });
    }
    convoFilters.tags.forEach((t) => {
      chips.push({ label: `Tag: ${t}`, onRemove: () => { convoFilters.tags = convoFilters.tags.filter((x) => x !== t); renderConvoFilterChips(); renderConvoList(); } });
    });
    if (convoFilters.direction) {
      chips.push({
        label: convoFilters.direction === 'inbound' ? 'Last msg: Lead' : 'Last msg: You',
        onRemove: () => { convoFilters.direction = ''; renderConvoFilterChips(); renderConvoList(); },
      });
    }
    row.innerHTML = '';
    chips.forEach((c) => {
      const span = document.createElement('span');
      span.className = 'fchip';
      span.innerHTML = `${c.label}<button type="button">×</button>`;
      span.querySelector('button').addEventListener('click', c.onRemove);
      row.appendChild(span);
    });
    const countEl = document.getElementById('convoFilterCount');
    countEl.textContent = chips.length ? `(${chips.length})` : '';
  }

  document.getElementById('convoFilterApply').addEventListener('click', () => {
    convoFilters.dateFrom = document.getElementById('convoDateFrom').value;
    convoFilters.dateTo = document.getElementById('convoDateTo').value;
    convoFilters.tags = Array.from(document.querySelectorAll('#convoTagOptions .fp-tag-opt.sel')).map((el) => el.dataset.tag);
    convoFilters.direction = convoDirectionChoice;
    convoFilterPanel.classList.remove('open');
    renderConvoFilterChips();
    renderConvoList();
  });

  document.getElementById('convoFilterClear').addEventListener('click', () => {
    convoFilters.dateFrom = '';
    convoFilters.dateTo = '';
    convoFilters.tags = [];
    convoFilters.direction = '';
    convoDirectionChoice = '';
    document.getElementById('convoDateFrom').value = '';
    document.getElementById('convoDateTo').value = '';
    document.querySelectorAll('#convoDatePresets .fp-preset, #convoDirectionPresets .fp-preset').forEach((b) => b.classList.remove('sel'));
    convoFilterPanel.classList.remove('open');
    renderConvoFilterChips();
    renderConvoList();
  });

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

  function filteredConvos() {
    let list = [...convosCache];

    if (convoFilterMode === 'unread') list = list.filter((c) => c.unreadCount > 0);
    else if (convoFilterMode === 'starred') list = list.filter((c) => c.starred);

    if (convoFilters.dateFrom || convoFilters.dateTo) {
      list = list.filter((c) => {
        if (!c.lastMessageDate) return false;
        const t = new Date(c.lastMessageDate).getTime();
        if (convoFilters.dateFrom && t < new Date(convoFilters.dateFrom + 'T00:00:00').getTime()) return false;
        if (convoFilters.dateTo && t > new Date(convoFilters.dateTo + 'T23:59:59').getTime()) return false;
        return true;
      });
    }
    if (convoFilters.tags.length) {
      list = list.filter((c) => convoFilters.tags.some((t) => (c.tags || []).includes(t)));
    }
    if (convoFilters.direction) {
      list = list.filter((c) => c.lastMessageDirection === convoFilters.direction);
    }

    list.sort((a, b) => {
      const diff = new Date(b.lastMessageDate || 0) - new Date(a.lastMessageDate || 0);
      return convoSortOrder === 'oldest' ? -diff : diff;
    });

    if (convoFilterMode === 'recent') list = list.slice(0, 20);
    return list;
  }

  function renderConvoList() {
    const box = document.getElementById('convoList');
    const list = filteredConvos();
    if (!convosCache.length) {
      box.innerHTML = '<div class="muted" style="padding:12px">No conversations yet.</div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = `<div class="muted" style="padding:12px">No ${convoFilterMode} conversations.</div>`;
      return;
    }
    box.innerHTML = list
      .map(
        (c) => `
      <div class="convo-item ${c.id === activeConvoId ? 'active' : ''}" data-convo="${c.id}">
        <div class="cn">
          <span>${c.contactName || c.fullName || 'Unknown'} ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}</span>
          <span class="star-toggle${c.starred ? ' active' : ''}" data-star="${c.id}" title="${c.starred ? 'Unstar' : 'Star'}">${c.starred ? '★' : '☆'}</span>
        </div>
        <div class="cs">${c.lastMessageBody || c.phone || ''}</div>
        <div class="ct">${c.lastMessageDate ? new Date(c.lastMessageDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>
      </div>`
      )
      .join('');
    box.querySelectorAll('.convo-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-star]')) return;
        selectConversation(el.dataset.convo);
      });
    });
    box.querySelectorAll('[data-star]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStarred(el.dataset.star);
      });
    });
  }

  async function toggleStarred(convoId) {
    const convo = convosCache.find((c) => c.id === convoId);
    if (!convo) return;
    const wasStarred = convo.starred;
    convo.starred = !wasStarred; // optimistic
    renderConvoList();
    try {
      if (wasStarred) await api(`/conversations/${convoId}/star`, { method: 'DELETE' });
      else await api(`/conversations/${convoId}/star`, { method: 'POST', body: JSON.stringify({ contactId: convo.contactId }) });
    } catch (err) {
      convo.starred = wasStarred; // revert on failure
      renderConvoList();
      toast(err.message, true);
    }
  }

  async function selectConversation(id) {
    activeConvoId = id;
    renderConvoList();
    document.getElementById('convoReplyBox').style.display = 'flex';
    await loadConvoMessages(id);
    const convo = convosCache.find((c) => c.id === id);
    loadConvoContactPanel(convo);
  }

  // ---------- Conversations: right-hand contact details panel ----------
  async function loadConvoContactPanel(convo) {
    const body = document.getElementById('convoContactBody');
    const fullProfileLink = document.getElementById('convoViewFullProfile');
    if (!convo?.contactId) {
      body.innerHTML = '<div class="muted" style="font-size:13px">No contact linked to this conversation.</div>';
      fullProfileLink.style.display = 'none';
      return;
    }
    fullProfileLink.style.display = 'inline';
    fullProfileLink.onclick = () => showContactPage(convo.contactId);
    body.innerHTML = '<div class="loading">Loading…</div>';

    try {
      const [{ contact }, jobs, appts] = await Promise.all([
        api('/contacts/' + convo.contactId),
        ensureAllJobsCache().catch(() => []),
        api('/contacts/' + convo.contactId + '/appointments').catch(() => ({ appointments: [] })),
      ]);

      const linkedJobs = jobs.filter((j) => j.contactId === convo.contactId);
      const upcoming = (appts.appointments || []).filter((a) => new Date(a.startTime) >= new Date());

      body.innerHTML = `
        <div style="font-size:15px;font-weight:800;margin-bottom:10px">${contactName(contact)}</div>
        <div class="fieldlist" style="margin-top:0">
          <div class="fieldrow"><span class="fname">Email</span><span class="fval">${contact.email || '—'}</span></div>
          <div class="fieldrow"><span class="fname">Phone</span><span class="fval">${contact.phone || '—'}</span></div>
        </div>
        ${(contact.tags || []).length ? `<div class="tagedit" style="margin-top:10px">${contact.tags.map((t) => `<span class="chip">${t}</span>`).join('')}</div>` : ''}

        <h3 style="margin-top:20px;font-size:13px">Active Jobs</h3>
        ${
          linkedJobs.length
            ? linkedJobs
                .map(
                  (j) => `
          <div class="dash-row" data-open-job="${j.id}">
            <div><div class="name">Case #${shortCaseId(j.id)}</div><div class="sub">${[j.carMake, j.carModel].filter(Boolean).join(' ') || j.name || ''}</div></div>
            <span class="status-badge ${jobStatusBadgeClass(j.status)}">${displayStageName(j.stageName) || j.status}</span>
          </div>`
                )
                .join('')
            : '<div class="muted" style="font-size:13px">No jobs for this contact.</div>'
        }

        <h3 style="margin-top:20px;font-size:13px">Appointments</h3>
        ${
          upcoming.length
            ? upcoming
                .map(
                  (a) => `
          <div class="dash-row">
            <div><div class="name">${a.title || 'Appointment'}</div><div class="sub">${a.calendarName || ''}</div></div>
            <div class="sub">${new Date(a.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>`
                )
                .join('')
            : '<div class="muted" style="font-size:13px">No upcoming appointments.</div>'
        }
      `;
      body.querySelectorAll('[data-open-job]').forEach((el) => {
        el.addEventListener('click', () => openJobDetail(el.dataset.openJob));
      });
    } catch (err) {
      body.innerHTML = `<div class="muted">${err.message}</div>`;
    }
  }

  async function loadConvoMessages(id, { silent } = {}) {
    const thread = document.getElementById('convoThread');
    const convo = convosCache.find((c) => c.id === id);
    const header = document.getElementById('convoThreadHeader');
    if (convo) {
      header.className = 'convo-header';
      header.innerHTML = `
        <div class="name">
          <span>${convo.contactName || convo.fullName || 'Unknown'}</span>
          <span class="star-toggle${convo.starred ? ' active' : ''}" data-star="${convo.id}" title="${convo.starred ? 'Unstar' : 'Star'}">${convo.starred ? '★' : '☆'}</span>
        </div>
        <div class="meta">
          ${convo.phone ? `<span>📞 ${convo.phone}</span>` : ''}
          ${convo.email ? `<span>✉ ${convo.email}</span>` : ''}
        </div>
        ${(convo.tags || []).length ? `<div class="tags">${convo.tags.map((t) => `<span class="chip">${t}</span>`).join('')}</div>` : ''}
      `;
      header.querySelector('[data-star]')?.addEventListener('click', () => toggleStarred(convo.id));
    } else {
      header.className = 'convo-header muted';
      header.textContent = 'Conversation';
    }
    if (!silent) thread.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const { messages } = await api(`/conversations/${id}/messages`);
      const real = (messages || []).filter(
        (m) => m.messageType === 'TYPE_SMS' || m.messageType === 'TYPE_EMAIL' || m.messageType === 'TYPE_CALL'
      );
      if (!real.length) {
        thread.innerHTML = '<div class="muted">No messages yet.</div>';
        return;
      }
      const emailMessages = [];
      thread.innerHTML = real
        .slice()
        .reverse()
        .map((m) => {
          if (m.messageType === 'TYPE_CALL') return renderCallRow(m);
          if (m.messageType === 'TYPE_EMAIL') {
            emailMessages.push(m);
            return renderEmailRow(m, emailMessages.length - 1);
          }
          const failed = m.status === 'failed';
          const cls = failed ? 'failed' : m.direction === 'outbound' ? 'outbound' : 'inbound';
          const time = new Date(m.dateAdded).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<div class="msg-bubble ${cls}">${escapeHtml(m.body || '')}<div class="mt">${failed ? `⚠ ${m.error || 'Failed to send'}` : time}</div></div>`;
        })
        .join('');
      wireCallRows(thread);
      wireEmailBodies(thread, emailMessages);
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

  let scMode = 'existing';
  let scSelectedContact = null;

  function scSetMode(mode) {
    scMode = mode;
    document.querySelectorAll('.sc-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('scExistingPane').style.display = mode === 'existing' ? 'block' : 'none';
    document.getElementById('scNewPane').style.display = mode === 'new' ? 'block' : 'none';
  }

  document.getElementById('scToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.sc-toggle-btn');
    if (btn) scSetMode(btn.dataset.mode);
  });

  function scShowSelected(contact) {
    scSelectedContact = contact;
    document.getElementById('scSearch').style.display = 'none';
    document.getElementById('scResults').innerHTML = '';
    document.getElementById('scSelectedName').textContent = contactName(contact);
    document.getElementById('scSelectedDetail').textContent = [contact.phone, contact.email].filter(Boolean).join(' · ') || 'No phone or email on file';
    document.getElementById('scSelected').style.display = 'block';
  }

  document.getElementById('scClearSelected').addEventListener('click', () => {
    scSelectedContact = null;
    document.getElementById('scSelected').style.display = 'none';
    document.getElementById('scSearch').style.display = 'block';
    document.getElementById('scSearch').value = '';
    document.getElementById('scSearch').focus();
  });

  let scSearchDebounce;
  document.getElementById('scSearch').addEventListener('input', (e) => {
    clearTimeout(scSearchDebounce);
    const q = e.target.value.trim();
    const results = document.getElementById('scResults');
    if (!q) {
      results.innerHTML = '';
      return;
    }
    scSearchDebounce = setTimeout(async () => {
      try {
        const { contacts } = await api('/contacts?query=' + encodeURIComponent(q));
        results.innerHTML = (contacts || [])
          .slice(0, 8)
          .map(
            (c) => `
          <div class="sc-result-item" data-contact='${JSON.stringify(c).replace(/'/g, '&apos;')}'>
            <div class="rn">${contactName(c)}</div>
            <div class="rd">${[c.phone, c.email].filter(Boolean).join(' · ') || 'No phone or email'}</div>
          </div>`
          )
          .join('') || '<div class="sc-result-item muted">No contacts found.</div>';
        results.querySelectorAll('[data-contact]').forEach((el) => {
          el.addEventListener('click', () => scShowSelected(JSON.parse(el.dataset.contact)));
        });
      } catch (err) {
        results.innerHTML = `<div class="sc-result-item muted">${err.message}</div>`;
      }
    }, 300);
  });

  document.getElementById('startConvoBtn').addEventListener('click', () => {
    ['scName', 'scPhone', 'scEmail', 'scSearch'].forEach((id) => (document.getElementById(id).value = ''));
    document.getElementById('scSearch').style.display = 'block';
    document.getElementById('scResults').innerHTML = '';
    document.getElementById('scSelected').style.display = 'none';
    scSelectedContact = null;
    scSetMode('existing');
    openModal('startConvoModal');
  });

  document.getElementById('scSave').addEventListener('click', async () => {
    const name = document.getElementById('scName').value.trim();
    const phone = document.getElementById('scPhone').value.trim();
    const email = document.getElementById('scEmail').value.trim();
    if (scMode === 'existing' && !scSelectedContact) return toast('Search and select a contact first.', true);
    if (scMode === 'new' && !phone) return toast('Phone is required.', true);
    try {
      const body = scMode === 'existing' ? { contactId: scSelectedContact.id } : { name, phone, email };
      const { contact, conversation } = await api('/conversations', {
        method: 'POST',
        body: JSON.stringify(body),
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
    'addContactBtn', 'newJobLink', 'jdUploadBtn', 'jdStatus',
    'convoSendBtn', 'cSave', 'jdUploadSave', 'jdAddNoteBtn', 'jdNoteSave',
    'cpSave', 'cpDelete', 'cpAddNoteBtn', 'cpNoteSave', 'cpConvoSendBtn', 'cpConvoStartBtn',
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
      document.title = brandName;
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
      window.location.href = '/login';
      return;
    }
    document.getElementById('userEmail').textContent = session.user.email;

    document.getElementById('signOut').addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/login';
    });

    try {
      const me = await api('/me');
      tenant = me.tenant;
    } catch {
      tenant = { connected: true, businessName: '', contactName: '' };
    }
    applyConnectionGate(tenant.connected);
    document.getElementById('welcomeLine').textContent = tenant.businessName ? `Welcome back, ${tenant.businessName}` : '';
    document.getElementById('sidebarShop').textContent = tenant.businessName || '—';
    document.getElementById('sidebarOwner').textContent = tenant.contactName || '';

    loadDashboard();
  }

  boot();
})();
