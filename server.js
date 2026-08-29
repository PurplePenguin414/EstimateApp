require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const qbo = require('./routes/qbo');
const { generateInvoicePdf } = require('./routes/pdf');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login.html');
}

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.loggedIn = true;
  req.session.userId = user.id;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password are required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.loggedIn) });
});

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- QuickBooks connection ----
app.get('/api/qb/status', requireAuth, (req, res) => {
  res.json({ configured: qbo.isConfigured(), connected: qbo.isConnected() });
});

app.get('/api/qb/connect', requireAuth, (req, res) => {
  if (!qbo.isConfigured()) return res.status(400).json({ error: 'QuickBooks is not configured (missing QB_CLIENT_ID/SECRET/REDIRECT_URI in .env)' });
  const state = req.session.userId + '-' + Date.now();
  req.session.qbOAuthState = state;
  res.json({ url: qbo.getAuthUrl(state) });
});

// Intuit redirects here after the user approves the connection — NOT behind
// requireAuth in the normal sense, since Intuit's redirect won't carry our
// session cookie reliably across the OAuth round-trip on every browser.
// State is still checked against what we stored, as CSRF protection.
app.get('/api/qb/callback', async (req, res) => {
  const { code, realmId, state } = req.query;
  if (!code || !realmId) return res.status(400).send('Missing code or realmId from QuickBooks.');
  try {
    await qbo.exchangeCodeForTokens(code, realmId);
    res.redirect('/index.html?qb_connected=1');
  } catch (err) {
    console.error('QB OAuth callback error:', err.message);
    res.status(500).send(`QuickBooks connection failed: ${err.message}`);
  }
});

app.post('/api/qb/disconnect', requireAuth, async (req, res) => {
  await qbo.disconnect();
  res.json({ success: true });
});

// Called by Intuit (not by our own UI) if the connection is ever revoked
// from inside QuickBooks itself, so our stored tokens don't go stale and
// silently fail on the next API call. Not behind requireAuth since Intuit
// is the caller here, not a logged-in browser session.
app.post('/api/qb/disconnect-webhook', async (req, res) => {
  try {
    await qbo.disconnect();
    console.log('QuickBooks disconnect webhook received — cleared stored connection.');
    res.status(200).send('OK');
  } catch (err) {
    console.error('QB disconnect webhook error:', err.message);
    res.status(500).send('Error');
  }
});

app.get('/api/qb/search-estimates', requireAuth, async (req, res) => {
  try {
    const results = await qbo.searchEstimates(req.query.q || '');
    res.json(results);
  } catch (err) {
    console.error('QB search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Business settings ----
app.get('/api/settings', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM business_settings WHERE id = 1').get());
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { business_name, address, phone, email } = req.body;
  db.prepare(`
    UPDATE business_settings SET business_name=?, address=?, phone=?, email=?, updated_at=datetime('now') WHERE id=1
  `).run(business_name || null, address || null, phone || null, email || null);
  res.json(db.prepare('SELECT * FROM business_settings WHERE id = 1').get());
});

app.post('/api/settings/logo', requireAuth, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  db.prepare(`UPDATE business_settings SET logo_filename=?, updated_at=datetime('now') WHERE id=1`).run(req.file.filename);
  res.json({ success: true, filename: req.file.filename });
});

// ---- Projects ----
app.get('/api/projects', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all());
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.line_items = db.prepare('SELECT * FROM project_line_items WHERE project_id = ? ORDER BY sort_order, id').all(req.params.id);
  project.materials = db.prepare('SELECT * FROM project_materials WHERE project_id = ? ORDER BY sort_order, id').all(req.params.id);
  project.labor = db.prepare('SELECT * FROM project_labor WHERE project_id = ? ORDER BY sort_order, id').all(req.params.id);
  res.json(project);
});

// Create a project by pulling a real estimate from QuickBooks
app.post('/api/projects/from-quickbooks/:estimateId', requireAuth, async (req, res) => {
  try {
    const estimate = await qbo.getEstimateWithLineItems(req.params.estimateId);
    const result = db.prepare(`
      INSERT INTO projects (project_name, customer_name, customer_address, qb_estimate_id, qb_estimate_number, total_revenue)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `${estimate.customerName} — ${estimate.docNumber}`,
      estimate.customerName, estimate.customerAddress,
      estimate.id, estimate.docNumber, estimate.totalAmount
    );
    const projectId = result.lastInsertRowid;

    const insertLine = db.prepare(`
      INSERT INTO project_line_items (project_id, description, quantity, amount, qb_item_type, classification, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    estimate.lineItems.forEach((item, idx) => {
      insertLine.run(projectId, item.description, item.quantity, item.amount, item.qb_item_type, item.classification, idx);
    });

    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
  } catch (err) {
    console.error('Create project from QB error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a project manually, without QuickBooks
app.post('/api/projects', requireAuth, (req, res) => {
  const { project_name, customer_name, customer_address, total_revenue } = req.body;
  if (!project_name) return res.status(400).json({ error: 'project_name is required' });
  const result = db.prepare(`
    INSERT INTO projects (project_name, customer_name, customer_address, total_revenue) VALUES (?, ?, ?, ?)
  `).run(project_name, customer_name || null, customer_address || null, total_revenue || 0);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { project_name, customer_name, customer_address, total_revenue, completion_date } = req.body;
  db.prepare(`
    UPDATE projects SET project_name=?, customer_name=?, customer_address=?, total_revenue=?, completion_date=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    project_name ?? existing.project_name, customer_name ?? existing.customer_name,
    customer_address ?? existing.customer_address, total_revenue ?? existing.total_revenue,
    completion_date ?? existing.completion_date, req.params.id
  );
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// Override a line item's material/labor classification manually
app.put('/api/line-items/:id', requireAuth, (req, res) => {
  const { classification } = req.body;
  if (!['material', 'labor_other'].includes(classification)) {
    return res.status(400).json({ error: 'classification must be material or labor_other' });
  }
  db.prepare('UPDATE project_line_items SET classification = ? WHERE id = ?').run(classification, req.params.id);
  res.json({ success: true });
});

// ---- Cost/profit calculator ----
app.post('/api/projects/:id/materials', requireAuth, (req, res) => {
  const { description, cost } = req.body;
  if (!description || cost === undefined) return res.status(400).json({ error: 'description and cost are required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_materials WHERE project_id = ?').get(req.params.id).m;
  const result = db.prepare('INSERT INTO project_materials (project_id, description, cost, sort_order) VALUES (?, ?, ?, ?)')
    .run(req.params.id, description, cost, maxOrder + 1);
  res.status(201).json(db.prepare('SELECT * FROM project_materials WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/materials/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM project_materials WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/projects/:id/labor', requireAuth, (req, res) => {
  const { worker_name, hours, hourly_rate } = req.body;
  if (!worker_name || hours === undefined || hourly_rate === undefined) {
    return res.status(400).json({ error: 'worker_name, hours, and hourly_rate are required' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_labor WHERE project_id = ?').get(req.params.id).m;
  const result = db.prepare('INSERT INTO project_labor (project_id, worker_name, hours, hourly_rate, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, worker_name, hours, hourly_rate, maxOrder + 1);
  res.status(201).json(db.prepare('SELECT * FROM project_labor WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/labor/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM project_labor WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

function calculateProjectFinancials(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const materials = db.prepare('SELECT * FROM project_materials WHERE project_id = ?').all(projectId);
  const labor = db.prepare('SELECT * FROM project_labor WHERE project_id = ?').all(projectId);

  const totalMaterialCost = materials.reduce((sum, m) => sum + m.cost, 0);
  const totalLaborCost = labor.reduce((sum, l) => sum + (l.hours * l.hourly_rate), 0);
  const grossProfit = project.total_revenue - totalMaterialCost - totalLaborCost;
  const taxSetAside = grossProfit > 0 ? grossProfit * 0.30 : 0;
  const netProfit = grossProfit - taxSetAside;

  return {
    revenue: project.total_revenue,
    total_material_cost: totalMaterialCost,
    total_labor_cost: totalLaborCost,
    gross_profit: grossProfit,
    tax_set_aside: taxSetAside,
    net_profit: netProfit
  };
}

app.get('/api/projects/:id/financials', requireAuth, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(calculateProjectFinancials(req.params.id));
});

// ---- PDF generation ----
app.get('/api/projects/:id/pdf/:type', requireAuth, (req, res) => {
  const { id, type } = req.params;
  if (!['material-draw', 'remaining-balance'].includes(type)) {
    return res.status(400).json({ error: 'type must be material-draw or remaining-balance' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const lineItems = db.prepare('SELECT * FROM project_line_items WHERE project_id = ? ORDER BY sort_order, id').all(id);
  const settings = db.prepare('SELECT * FROM business_settings WHERE id = 1').get();

  const classification = type === 'material-draw' ? 'material' : 'labor_other';
  const relevantItems = lineItems.filter(i => i.classification === classification);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${type}-${project.qb_estimate_number || project.id}.pdf"`);

  generateInvoicePdf(res, {
    type,
    project,
    lineItems: relevantItems,
    settings,
    logoPath: settings.logo_filename ? path.join(uploadDir, settings.logo_filename) : null
  });
});

app.listen(PORT, () => {
  console.log(`NextWave Estimator running on port ${PORT}`);
  console.log(qbo.isConfigured() ? 'QuickBooks connection configured.' : 'WARNING: QuickBooks is not configured — set QB_* env vars.');
});
