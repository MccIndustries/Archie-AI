(function () {
  let supabase;
  let session;
  let clientsCache = [];
  let activeClientId = null;

  const toast = (msg, isErr) => {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 3200);
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api/admin' + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      // The cached local session looked valid but the server rejected it
      // (e.g. the account was deleted, or isn't an admin) -- sign out to
      // clear it, otherwise admin-login.html's own local-only session check
      // just bounces back here, forever.
      await supabase.auth.signOut();
      window.location.href = '/admin-login.html';
      throw new Error('Session expired or not authorized');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
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

  // ---------- Clients list ----------
  async function loadClients() {
    const body = document.getElementById('clientsBody');
    body.innerHTML = '<tr><td colspan="7" class="loading">Loading…</td></tr>';
    try {
      const { clients } = await api('/clients');
      clientsCache = clients || [];
      body.innerHTML = clientsCache.length
        ? clientsCache
            .map(
              (c) => `
        <tr>
          <td>${c.name}</td>
          <td class="muted">${c.email || '—'}</td>
          <td class="mono">${c.ghl_location_id || '<span class="muted">—</span>'}</td>
          <td><span class="badge${c.connected ? ' connected' : ''}">${c.connected ? 'Connected' : 'Not Connected'}</span></td>
          <td class="muted">${new Date(c.created_at).toLocaleDateString()}</td>
          <td><span class="link" data-manage="${c.id}">Manage</span></td>
          <td><span class="link" data-impersonate="${c.id}">Switch to Account</span></td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="7" class="muted">No clients yet — accounts appear here once a shop submits the signup form.</td></tr>';
      body.querySelectorAll('[data-manage]').forEach((el) => {
        el.addEventListener('click', () => openClientDetail(el.dataset.manage));
      });
      body.querySelectorAll('[data-impersonate]').forEach((el) => {
        el.addEventListener('click', () => switchToAccount(el.dataset.impersonate));
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="7">${err.message}</td></tr>`;
    }
  }

  async function switchToAccount(clientId) {
    try {
      const { actionLink } = await api(`/clients/${clientId}/impersonate`, { method: 'POST' });
      window.open(actionLink, '_blank');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- Client detail ----------
  function renderConnectionBadge(client) {
    const connected = Boolean(client.ghl_location_id && client.ghl_api_token && client.ghl_calendar_id);
    const badge = document.getElementById('cdConnectionBadge');
    badge.textContent = connected ? 'Connected' : 'Not Connected';
    badge.className = 'badge' + (connected ? ' connected' : '');
  }

  async function openClientDetail(id) {
    activeClientId = id;
    try {
      const { client } = await api(`/clients/${id}`);
      document.getElementById('cdName').textContent = client.name;
      const contactBits = [client.contact_name, client.email, client.phone].filter(Boolean);
      document.getElementById('cdContact').textContent = contactBits.length ? contactBits.join(' · ') : 'No contact info on file.';
      renderConnectionBadge(client);
      document.getElementById('cdLocationId').value = client.ghl_location_id || '';
      const tokenInput = document.getElementById('cdToken');
      tokenInput.value = client.ghl_api_token || '';
      // The GET here returns a masked token (unless Reveal is clicked) --
      // track that so Save/Fetch Calendars never mistake the mask itself
      // for a real token to send anywhere.
      tokenInput.dataset.masked = client.ghl_api_token ? 'true' : 'false';
      document.getElementById('cdCalendarId').innerHTML = client.ghl_calendar_id
        ? `<option value="${client.ghl_calendar_id}" selected>Current: ${client.ghl_calendar_id}</option>`
        : '<option value="">Enter Location ID + Token, then Fetch Calendars</option>';
      document.getElementById('cdPipelineId').value = client.ghl_pipeline_id || '';
      document.getElementById('cdNotes').value = client.notes || '';
      document.getElementById('cdNewEmail').value = '';
      openModal('clientDetailModal');
      loadClientUsers(id);
    } catch (err) {
      toast(err.message, true);
    }
  }

  document.getElementById('cdToken').addEventListener('input', (e) => {
    e.target.dataset.masked = 'false';
  });

  document.getElementById('cdRevealBtn').addEventListener('click', async () => {
    try {
      const { client } = await api(`/clients/${activeClientId}?reveal=true`);
      const tokenInput = document.getElementById('cdToken');
      tokenInput.value = client.ghl_api_token;
      tokenInput.dataset.masked = 'false';
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('cdFetchCalendarsBtn').addEventListener('click', async () => {
    const ghlLocationId = document.getElementById('cdLocationId').value.trim();
    const tokenInput = document.getElementById('cdToken');
    const ghlApiToken = tokenInput.value.trim();
    const sel = document.getElementById('cdCalendarId');
    if (!ghlLocationId || !ghlApiToken) return toast('Enter both Location ID and Token first.', true);
    if (tokenInput.dataset.masked === 'true') return toast('Click "Reveal" first, or paste in a new token.', true);
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
      const { calendars } = await api('/ghl/calendars', {
        method: 'POST',
        body: JSON.stringify({ ghlLocationId, ghlApiToken }),
      });
      sel.innerHTML = calendars.length
        ? calendars.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')
        : '<option value="">No calendars found in this location</option>';
    } catch (err) {
      sel.innerHTML = '<option value="">Could not load calendars</option>';
      toast(err.message, true);
    }
  });

  document.getElementById('cdSave').addEventListener('click', async () => {
    try {
      const tokenInput = document.getElementById('cdToken');
      const payload = {
        ghlLocationId: document.getElementById('cdLocationId').value.trim(),
        ghlCalendarId: document.getElementById('cdCalendarId').value.trim(),
        ghlPipelineId: document.getElementById('cdPipelineId').value.trim(),
        notes: document.getElementById('cdNotes').value.trim(),
      };
      // Never send the masked placeholder back as if it were a real token --
      // only include it when the VA actually revealed or retyped it.
      if (tokenInput.dataset.masked !== 'true' && tokenInput.value.trim()) {
        payload.ghlApiToken = tokenInput.value.trim();
      }
      const { client } = await api(`/clients/${activeClientId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      renderConnectionBadge(client);
      toast('Client updated.');
      loadClients();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('cdDelete').addEventListener('click', async () => {
    try {
      await api(`/clients/${activeClientId}`, { method: 'DELETE' });
      closeModal('clientDetailModal');
      toast('Client deleted.');
      loadClients();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function loadClientUsers(id) {
    const box = document.getElementById('cdUsers');
    box.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const { users } = await api(`/clients/${id}/users`);
      box.innerHTML = users.length
        ? users.map((u) => `<div class="userrow"><span>${u.email}</span><span class="muted">${new Date(u.createdAt).toLocaleDateString()}</span></div>`).join('')
        : '<span class="muted">No logins created yet.</span>';
    } catch (err) {
      box.innerHTML = `<span class="muted">${err.message}</span>`;
    }
  }

  document.getElementById('cdCreateUser').addEventListener('click', async () => {
    const email = document.getElementById('cdNewEmail').value.trim();
    if (!email) return toast('Enter an email.', true);
    try {
      await api(`/clients/${activeClientId}/users`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      document.getElementById('cdNewEmail').value = '';
      toast('Invite sent.');
      loadClientUsers(activeClientId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Boot ----------
  async function boot() {
    const cfgRes = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey, brandName } = await cfgRes.json();
    if (brandName) {
      document.title = `${brandName} Admin`;
      document.getElementById('brandName').textContent = brandName;
    }
    if (!supabaseUrl || !supabaseAnonKey) {
      toast('Server is not configured (missing Supabase env vars).', true);
      return;
    }
    supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
    const { data } = await supabase.auth.getSession();
    session = data.session;
    if (!session || session.user.app_metadata?.role !== 'admin') {
      window.location.href = '/admin-login.html';
      return;
    }

    document.getElementById('signOut').addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/admin-login.html';
    });

    loadClients();
    loadAdmins();
  }

  // ---------- Admin users ----------
  async function loadAdmins() {
    const body = document.getElementById('adminsBody');
    body.innerHTML = '<tr><td colspan="2" class="loading">Loading…</td></tr>';
    try {
      const { admins } = await api('/admins');
      body.innerHTML = admins.length
        ? admins
            .map(
              (a) => `
        <tr>
          <td>${a.email}</td>
          <td class="muted">${new Date(a.createdAt).toLocaleDateString()}</td>
        </tr>`
            )
            .join('')
        : '<tr><td colspan="2" class="muted">No admins yet.</td></tr>';
    } catch (err) {
      body.innerHTML = `<tr><td colspan="2">${err.message}</td></tr>`;
    }
  }

  document.getElementById('addAdminBtn').addEventListener('click', () => {
    document.getElementById('aaEmail').value = '';
    openModal('addAdminModal');
  });

  document.getElementById('aaSave').addEventListener('click', async () => {
    const email = document.getElementById('aaEmail').value.trim();
    if (!email) return toast('Enter an email.', true);
    try {
      await api('/admins', { method: 'POST', body: JSON.stringify({ email }) });
      closeModal('addAdminModal');
      toast('Invite sent.');
      loadAdmins();
    } catch (err) {
      toast(err.message, true);
    }
  });

  boot();
})();
