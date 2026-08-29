let currentProjectId = null;
let currentProjectData = null;

document.addEventListener('DOMContentLoaded', async () => {
  await checkSession();
  initTheme();
  bindTopbar();
  bindDashboard();
  bindModals();
  bindProjectDetail();
  bindSettings();

  // Handle the redirect back from QuickBooks OAuth
  const params = new URLSearchParams(window.location.search);
  if (params.get('qb_connected')) {
    window.history.replaceState({}, '', '/');
    alert('QuickBooks connected successfully!');
  }

  loadDashboard();
});

async function checkSession() {
  const res = await fetch('/api/session');
  const data = await res.json();
  if (!data.authenticated) window.location.href = '/login.html';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function formatCurrency(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Theme ----
function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('darkModeToggle').textContent = saved === 'dark' ? '☀️' : '🌙';
}

function bindTopbar() {
  document.getElementById('darkModeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    document.getElementById('darkModeToggle').textContent = next === 'dark' ? '☀️' : '🌙';
  });
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
  document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
}

// ================= Dashboard =================
function bindDashboard() {
  document.getElementById('newManualBtn').addEventListener('click', () => {
    document.getElementById('manualProjectForm').reset();
    document.getElementById('manualProjectModal').classList.remove('hidden');
  });
  document.getElementById('newFromQbBtn').addEventListener('click', async () => {
    const status = await fetch('/api/qb/status').then(r => r.json());
    if (!status.connected) { alert('Connect QuickBooks first, in Settings.'); return; }
    document.getElementById('qbSearchInput').value = '';
    document.getElementById('qbSearchResults').innerHTML = '';
    document.getElementById('qbSearchModal').classList.remove('hidden');
  });
  document.getElementById('backToDashboardBtn').addEventListener('click', () => {
    document.getElementById('projectDetailView').classList.add('hidden');
    document.getElementById('dashboardView').classList.remove('hidden');
    loadDashboard();
  });

  document.getElementById('newFromPdfBtn').addEventListener('click', openPdfUploadModal);
}

// ================= PDF upload & review =================
let pdfReviewItems = [];

function openPdfUploadModal() {
  document.getElementById('pdfFileInput').value = '';
  document.getElementById('pdfExtractError').classList.add('hidden');
  document.getElementById('pdfUploadStep').classList.remove('hidden');
  document.getElementById('pdfReviewStep').classList.add('hidden');
  document.getElementById('pdfUploadModal').classList.remove('hidden');
}

async function extractPdf() {
  const fileInput = document.getElementById('pdfFileInput');
  const errorEl = document.getElementById('pdfExtractError');
  errorEl.classList.add('hidden');

  if (!fileInput.files.length) { errorEl.textContent = 'Choose a PDF first.'; errorEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('pdfExtractBtn');
  const original = btn.textContent;
  btn.textContent = 'Extracting…';
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('estimate', fileInput.files[0]);
    const res = await fetch('/api/parse-pdf-estimate', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Extraction failed');

    document.getElementById('pdfProjectName').value = `${data.customerName || 'Project'} — Est. #${data.estimateNumber || ''}`.trim();
    document.getElementById('pdfCustomerName').value = data.customerName || '';
    document.getElementById('pdfCustomerAddress').value = data.customerAddress || '';
    document.getElementById('pdfTotalRevenue').value = data.extractedTotal || 0;

    const warningEl = document.getElementById('pdfTotalWarning');
    if (!data.totalMatches) {
      warningEl.textContent = `Heads up: the extracted line items sum to ${formatCurrency(data.extractedTotal)}, but the PDF states a total of ${data.statedTotal != null ? formatCurrency(data.statedTotal) : 'unknown'}. Double-check the items below before creating this project.`;
      warningEl.classList.remove('hidden');
    } else {
      warningEl.classList.add('hidden');
    }

    pdfReviewItems = data.items.map(i => ({ ...i }));
    renderPdfItemsTable();

    document.getElementById('pdfUploadStep').classList.add('hidden');
    document.getElementById('pdfReviewStep').classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

function renderPdfItemsTable() {
  const container = document.getElementById('pdfItemsTable');
  container.innerHTML = `
    <div class="pdf-item-row pdf-item-row-header">
      <span>Description</span><span>Qty</span><span>Amount</span><span>Category</span><span></span>
    </div>
  ` + pdfReviewItems.map((item, idx) => `
    <div class="pdf-item-row" data-idx="${idx}">
      <input type="text" class="pdf-item-desc" value="${escapeHtml(item.description)}">
      <input type="number" class="pdf-item-qty" value="${item.quantity}" step="0.01">
      <input type="number" class="pdf-item-amount" value="${item.amount}" step="0.01">
      <select class="pdf-item-class">
        <option value="material" ${item.classification === 'material' ? 'selected' : ''}>Material</option>
        <option value="labor_other" ${item.classification === 'labor_other' ? 'selected' : ''}>Labor/Other</option>
      </select>
      <button type="button" class="pdf-item-remove" data-idx="${idx}" title="Remove this item">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.pdf-item-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pdfReviewItems.splice(parseInt(btn.dataset.idx), 1);
      renderPdfItemsTable();
    });
  });
}

function collectPdfItemsFromTable() {
  const rows = document.querySelectorAll('#pdfItemsTable .pdf-item-row[data-idx]');
  return Array.from(rows).map(row => ({
    description: row.querySelector('.pdf-item-desc').value,
    quantity: parseFloat(row.querySelector('.pdf-item-qty').value) || 1,
    amount: parseFloat(row.querySelector('.pdf-item-amount').value) || 0,
    classification: row.querySelector('.pdf-item-class').value
  }));
}

async function confirmCreateFromPdf() {
  const payload = {
    project_name: document.getElementById('pdfProjectName').value,
    customer_name: document.getElementById('pdfCustomerName').value,
    customer_address: document.getElementById('pdfCustomerAddress').value,
    total_revenue: parseFloat(document.getElementById('pdfTotalRevenue').value) || 0,
    items: collectPdfItemsFromTable()
  };
  if (!payload.project_name || !payload.items.length) {
    alert('Project name and at least one line item are required.');
    return;
  }

  const res = await fetch('/api/projects/from-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const project = await res.json();
  if (!res.ok) { alert(project.error || 'Failed to create project'); return; }
  document.getElementById('pdfUploadModal').classList.add('hidden');
  openProjectDetail(project.id);
}

async function loadDashboard() {
  const qbStatus = await fetch('/api/qb/status').then(r => r.json());
  document.getElementById('qbWarning').classList.toggle('hidden', qbStatus.connected);

  const projects = await fetch('/api/projects').then(r => r.json());
  const listEl = document.getElementById('projectList');
  const emptyEl = document.getElementById('emptyState');

  if (!projects.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = projects.map(p => `
    <div class="project-card" data-id="${p.id}">
      <div class="project-card-top">
        <span class="project-card-title">${escapeHtml(p.project_name)}</span>
        <span class="project-card-revenue">${formatCurrency(p.total_revenue)}</span>
      </div>
      <div class="muted-text">${escapeHtml(p.customer_name || '')}${p.qb_estimate_number ? ' — Est. #' + escapeHtml(p.qb_estimate_number) : ''}</div>
    </div>
  `).join('');

  listEl.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', () => openProjectDetail(card.dataset.id));
  });
}

// ================= Modals: new project =================
function bindModals() {
  document.getElementById('closeManualProjectBtn').addEventListener('click', () => document.getElementById('manualProjectModal').classList.add('hidden'));
  document.getElementById('manualProjectModal').addEventListener('click', (e) => { if (e.target.id === 'manualProjectModal') e.target.classList.add('hidden'); });
  document.getElementById('manualProjectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      project_name: document.getElementById('mpName').value,
      customer_name: document.getElementById('mpCustomer').value,
      customer_address: document.getElementById('mpAddress').value,
      total_revenue: parseFloat(document.getElementById('mpRevenue').value) || 0
    };
    const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const project = await res.json();
    document.getElementById('manualProjectModal').classList.add('hidden');
    openProjectDetail(project.id);
  });

  document.getElementById('closeQbSearchBtn').addEventListener('click', () => document.getElementById('qbSearchModal').classList.add('hidden'));
  document.getElementById('qbSearchModal').addEventListener('click', (e) => { if (e.target.id === 'qbSearchModal') e.target.classList.add('hidden'); });
  document.getElementById('qbSearchGoBtn').addEventListener('click', runQbSearch);
  document.getElementById('qbSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runQbSearch(); });

  document.getElementById('closePdfUploadBtn').addEventListener('click', () => document.getElementById('pdfUploadModal').classList.add('hidden'));
  document.getElementById('pdfUploadModal').addEventListener('click', (e) => { if (e.target.id === 'pdfUploadModal') e.target.classList.add('hidden'); });
  document.getElementById('pdfExtractBtn').addEventListener('click', extractPdf);
  document.getElementById('pdfBackBtn').addEventListener('click', () => {
    document.getElementById('pdfReviewStep').classList.add('hidden');
    document.getElementById('pdfUploadStep').classList.remove('hidden');
  });
  document.getElementById('pdfConfirmCreateBtn').addEventListener('click', confirmCreateFromPdf);
}

async function runQbSearch() {
  const q = document.getElementById('qbSearchInput').value.trim();
  const resultsEl = document.getElementById('qbSearchResults');
  resultsEl.innerHTML = '<p class="muted-text">Searching…</p>';
  try {
    const res = await fetch(`/api/qb/search-estimates?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    if (!res.ok) throw new Error(results.error || 'Search failed');

    if (!results.length) {
      resultsEl.innerHTML = '<p class="muted-text">No matching estimates found.</p>';
      return;
    }
    resultsEl.innerHTML = results.map(r => `
      <div class="qb-result-item" data-id="${r.id}">
        <div><strong>${escapeHtml(r.customerName)}</strong> — Est. #${escapeHtml(r.docNumber)}</div>
        <div class="muted-text">${escapeHtml(r.date)} — ${formatCurrency(r.total)}</div>
      </div>
    `).join('');
    resultsEl.querySelectorAll('.qb-result-item').forEach(item => {
      item.addEventListener('click', () => pullFromQuickBooks(item.dataset.id));
    });
  } catch (err) {
    resultsEl.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

async function pullFromQuickBooks(estimateId) {
  const resultsEl = document.getElementById('qbSearchResults');
  resultsEl.innerHTML = '<p class="muted-text">Pulling estimate…</p>';
  try {
    const res = await fetch(`/api/projects/from-quickbooks/${estimateId}`, { method: 'POST' });
    const project = await res.json();
    if (!res.ok) throw new Error(project.error || 'Failed to pull estimate');
    document.getElementById('qbSearchModal').classList.add('hidden');
    openProjectDetail(project.id);
  } catch (err) {
    resultsEl.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

// ================= Project Detail =================
function bindProjectDetail() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('invoicingTab').classList.toggle('hidden', btn.dataset.tab !== 'invoicing');
      document.getElementById('calculatorTab').classList.toggle('hidden', btn.dataset.tab !== 'calculator');
    });
  });

  document.getElementById('materialPdfBtn').addEventListener('click', () => {
    window.open(`/api/projects/${currentProjectId}/pdf/material-draw`, '_blank');
  });
  document.getElementById('laborPdfBtn').addEventListener('click', () => {
    window.open(`/api/projects/${currentProjectId}/pdf/remaining-balance`, '_blank');
  });

  document.getElementById('editProjectBtn').addEventListener('click', openEditProjectModal);
  document.getElementById('closeEditProjectBtn').addEventListener('click', () => document.getElementById('editProjectModal').classList.add('hidden'));
  document.getElementById('editProjectModal').addEventListener('click', (e) => { if (e.target.id === 'editProjectModal') e.target.classList.add('hidden'); });
  document.getElementById('editProjectForm').addEventListener('submit', saveEditProject);

  document.getElementById('deleteProjectBtn').addEventListener('click', deleteCurrentProject);

  document.getElementById('addMaterialBtn').addEventListener('click', addMaterial);
  document.getElementById('addLaborBtn').addEventListener('click', addLabor);
  document.getElementById('addLineItemBtn').addEventListener('click', addLineItem);
}

async function addLineItem() {
  const description = document.getElementById('newLineDesc').value.trim();
  const quantity = parseFloat(document.getElementById('newLineQty').value) || 1;
  const amount = parseFloat(document.getElementById('newLineAmount').value);
  const classification = document.getElementById('newLineClassification').value;
  if (!description || isNaN(amount)) { alert('Enter a description and a valid amount.'); return; }

  await fetch(`/api/projects/${currentProjectId}/line-items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, quantity, amount, classification })
  });
  document.getElementById('newLineDesc').value = '';
  document.getElementById('newLineQty').value = '1';
  document.getElementById('newLineAmount').value = '';
  loadProjectDetail();
}

async function openProjectDetail(id) {
  currentProjectId = id;
  document.getElementById('dashboardView').classList.add('hidden');
  document.getElementById('projectDetailView').classList.remove('hidden');
  await loadProjectDetail();
}

async function loadProjectDetail() {
  const res = await fetch(`/api/projects/${currentProjectId}`);
  const project = await res.json();
  currentProjectData = project;

  document.getElementById('projectDetailName').textContent = project.project_name;
  document.getElementById('projectDetailMeta').textContent =
    `${project.customer_name || 'No customer set'}${project.qb_estimate_number ? ' — QuickBooks Est. #' + project.qb_estimate_number : ''} — Revenue: ${formatCurrency(project.total_revenue)}`;

  renderLineItemSplit(project.line_items);
  renderCalculator(project);
  await loadFinancials();
}

function renderLineItemSplit(lineItems) {
  const materialItems = lineItems.filter(i => i.classification === 'material');
  const laborItems = lineItems.filter(i => i.classification === 'labor_other');

  const renderList = (items, targetClassification) => items.map(i => `
    <div class="line-item-row">
      <span>${escapeHtml(i.description)}</span>
      <span class="line-item-amount">${formatCurrency(i.amount)}</span>
      <button type="button" class="reclassify-btn" data-id="${i.id}" data-target="${targetClassification}" title="Move to the other invoice">⇄</button>
      <button type="button" class="remove-line-btn" data-line-id="${i.id}" title="Delete this line item">&times;</button>
    </div>
  `).join('') || '<p class="muted-text">No items.</p>';

  document.getElementById('materialItemsList').innerHTML = renderList(materialItems, 'labor_other');
  document.getElementById('laborItemsList').innerHTML = renderList(laborItems, 'material');

  document.getElementById('materialTotal').textContent = 'Total: ' + formatCurrency(materialItems.reduce((s, i) => s + i.amount, 0));
  document.getElementById('laborTotal').textContent = 'Total: ' + formatCurrency(laborItems.reduce((s, i) => s + i.amount, 0));

  document.querySelectorAll('.reclassify-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/line-items/${btn.dataset.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: btn.dataset.target })
      });
      loadProjectDetail();
    });
  });

  document.querySelectorAll('[data-line-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this line item?')) return;
      await fetch(`/api/line-items/${btn.dataset.lineId}`, { method: 'DELETE' });
      loadProjectDetail();
    });
  });
}

// ---- Calculator ----
function renderCalculator(project) {
  document.getElementById('calcMaterialsList').innerHTML = project.materials.map(m => `
    <div class="calc-list-row">
      <span>${escapeHtml(m.description)}</span>
      <span>${formatCurrency(m.cost)}</span>
      <button type="button" class="remove-btn" data-type="material" data-id="${m.id}">&times;</button>
    </div>
  `).join('') || '<p class="muted-text">No material costs entered yet.</p>';

  document.getElementById('calcLaborList').innerHTML = project.labor.map(l => `
    <div class="calc-list-row">
      <span>${escapeHtml(l.worker_name)} — ${l.hours}h @ ${formatCurrency(l.hourly_rate)}/hr</span>
      <span>${formatCurrency(l.hours * l.hourly_rate)}</span>
      <button type="button" class="remove-btn" data-type="labor" data-id="${l.id}">&times;</button>
    </div>
  `).join('') || '<p class="muted-text">No labor entered yet.</p>';

  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const endpoint = btn.dataset.type === 'material' ? `/api/materials/${btn.dataset.id}` : `/api/labor/${btn.dataset.id}`;
      await fetch(endpoint, { method: 'DELETE' });
      loadProjectDetail();
    });
  });
}

async function addMaterial() {
  const description = document.getElementById('newMaterialDesc').value.trim();
  const cost = parseFloat(document.getElementById('newMaterialCost').value);
  if (!description || isNaN(cost)) { alert('Enter a description and a valid cost.'); return; }
  await fetch(`/api/projects/${currentProjectId}/materials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, cost })
  });
  document.getElementById('newMaterialDesc').value = '';
  document.getElementById('newMaterialCost').value = '';
  loadProjectDetail();
}

async function addLabor() {
  const worker_name = document.getElementById('newWorkerName').value.trim();
  const hours = parseFloat(document.getElementById('newWorkerHours').value);
  const hourly_rate = parseFloat(document.getElementById('newWorkerRate').value);
  if (!worker_name || isNaN(hours) || isNaN(hourly_rate)) { alert('Enter a worker name, hours, and rate.'); return; }
  await fetch(`/api/projects/${currentProjectId}/labor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_name, hours, hourly_rate })
  });
  document.getElementById('newWorkerName').value = '';
  document.getElementById('newWorkerHours').value = '';
  document.getElementById('newWorkerRate').value = '';
  loadProjectDetail();
}

async function loadFinancials() {
  const financials = await fetch(`/api/projects/${currentProjectId}/financials`).then(r => r.json());
  document.getElementById('sumRevenue').textContent = formatCurrency(financials.revenue);
  document.getElementById('sumMaterialCost').textContent = formatCurrency(financials.total_material_cost);
  document.getElementById('sumLaborCost').textContent = formatCurrency(financials.total_labor_cost);
  document.getElementById('sumGrossProfit').textContent = formatCurrency(financials.gross_profit);
  document.getElementById('sumTaxSetAside').textContent = formatCurrency(financials.tax_set_aside);
  document.getElementById('sumNetProfit').textContent = formatCurrency(financials.net_profit);
}

// ---- Edit / delete project ----
function openEditProjectModal() {
  const p = currentProjectData;
  document.getElementById('epName').value = p.project_name || '';
  document.getElementById('epCustomer').value = p.customer_name || '';
  document.getElementById('epAddress').value = p.customer_address || '';
  document.getElementById('epRevenue').value = p.total_revenue || '';
  document.getElementById('epCompletion').value = p.completion_date || '';
  document.getElementById('editProjectModal').classList.remove('hidden');
}

async function saveEditProject(e) {
  e.preventDefault();
  const payload = {
    project_name: document.getElementById('epName').value,
    customer_name: document.getElementById('epCustomer').value,
    customer_address: document.getElementById('epAddress').value,
    total_revenue: parseFloat(document.getElementById('epRevenue').value) || 0,
    completion_date: document.getElementById('epCompletion').value || null
  };
  await fetch(`/api/projects/${currentProjectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  document.getElementById('editProjectModal').classList.add('hidden');
  loadProjectDetail();
}

async function deleteCurrentProject() {
  if (!confirm('Delete this project? This cannot be undone.')) return;
  await fetch(`/api/projects/${currentProjectId}`, { method: 'DELETE' });
  document.getElementById('projectDetailView').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');
  loadDashboard();
}

// ================= Settings =================
function bindSettings() {
  document.getElementById('closeSettingsBtn').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  document.getElementById('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') e.target.classList.add('hidden'); });

  document.getElementById('qbConnectBtn').addEventListener('click', async () => {
    const res = await fetch('/api/qb/connect');
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    window.location.href = data.url;
  });
  document.getElementById('qbDisconnectBtn').addEventListener('click', async () => {
    if (!confirm('Disconnect QuickBooks?')) return;
    await fetch('/api/qb/disconnect', { method: 'POST' });
    refreshQbStatus();
  });

  document.getElementById('businessSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      business_name: document.getElementById('bsName').value,
      address: document.getElementById('bsAddress').value,
      phone: document.getElementById('bsPhone').value,
      email: document.getElementById('bsEmail').value
    };
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    alert('Business info saved.');
  });

  document.getElementById('logoUploadBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('logoUploadInput');
    if (!fileInput.files.length) { alert('Choose a file first.'); return; }
    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);
    await fetch('/api/settings/logo', { method: 'POST', body: formData });
    alert('Logo uploaded.');
    loadCurrentLogo();
  });

  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('cpError');
    errorEl.classList.add('hidden');

    const newPass = document.getElementById('cpNew').value;
    const confirmPass = document.getElementById('cpConfirm').value;
    if (newPass !== confirmPass) {
      errorEl.textContent = 'New password and confirmation do not match.';
      errorEl.classList.remove('hidden');
      return;
    }

    try {
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: document.getElementById('cpCurrent').value, new_password: newPass })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to change password');
      alert('Password changed successfully.');
      document.getElementById('changePasswordForm').reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}

async function openSettingsModal() {
  document.getElementById('settingsModal').classList.remove('hidden');
  await refreshQbStatus();
  const settings = await fetch('/api/settings').then(r => r.json());
  document.getElementById('bsName').value = settings.business_name || '';
  document.getElementById('bsAddress').value = settings.address || '';
  document.getElementById('bsPhone').value = settings.phone || '';
  document.getElementById('bsEmail').value = settings.email || '';
  loadCurrentLogo(settings);
}

function loadCurrentLogo(settings) {
  const previewEl = document.getElementById('currentLogoPreview');
  if (settings && settings.logo_filename) {
    previewEl.innerHTML = `<img src="/uploads/${settings.logo_filename}" style="max-width:150px; max-height:80px; display:block; margin-bottom:0.5rem;">`;
  } else if (!settings) {
    fetch('/api/settings').then(r => r.json()).then(s => loadCurrentLogo(s));
  } else {
    previewEl.innerHTML = '<p class="muted-text">No logo uploaded yet.</p>';
  }
}

async function refreshQbStatus() {
  const status = await fetch('/api/qb/status').then(r => r.json());
  const statusEl = document.getElementById('qbStatus');
  const connectBtn = document.getElementById('qbConnectBtn');
  const disconnectBtn = document.getElementById('qbDisconnectBtn');

  if (!status.configured) {
    statusEl.textContent = 'Not configured — set QB_CLIENT_ID / QB_CLIENT_SECRET / QB_REDIRECT_URI in .env.';
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.add('hidden');
  } else if (status.connected) {
    statusEl.textContent = 'Connected.';
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Not connected yet.';
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }
}
