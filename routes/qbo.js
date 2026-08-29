// QuickBooks Online API client. Handles the OAuth2 connection, automatic
// token refresh, and pulling estimates with their line items classified as
// material (QB Item Type: Inventory/NonInventory) vs labor/other (Service).

const db = require('../db');

const QB_CLIENT_ID = process.env.QB_CLIENT_ID || '';
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || '';
const QB_REDIRECT_URI = process.env.QB_REDIRECT_URI || '';
const QB_ENVIRONMENT = process.env.QB_ENVIRONMENT || 'production'; // 'production' or 'sandbox'

const AUTH_BASE = process.env.QB_AUTH_BASE_OVERRIDE || 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = process.env.QB_TOKEN_URL_OVERRIDE || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function apiBase(realmId) {
  if (process.env.QB_API_BASE_OVERRIDE) return `${process.env.QB_API_BASE_OVERRIDE}/v3/company/${realmId}`;
  const host = QB_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  return `${host}/v3/company/${realmId}`;
}

function isConfigured() {
  return !!(QB_CLIENT_ID && QB_CLIENT_SECRET && QB_REDIRECT_URI);
}

function isConnected() {
  const row = db.prepare('SELECT * FROM qb_auth WHERE id = 1').get();
  return !!(row && row.refresh_token && row.realm_id);
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, realmId) {
  const basicAuth = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: QB_REDIRECT_URI
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QuickBooks token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  saveTokens(data, realmId);
  return data;
}

function saveTokens(tokenResponse, realmId) {
  const expiresAt = new Date(Date.now() + (tokenResponse.expires_in * 1000)).toISOString();
  db.prepare(`
    INSERT INTO qb_auth (id, access_token, refresh_token, realm_id, token_expires_at, environment, connected_at)
    VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, qb_auth.refresh_token),
      realm_id = excluded.realm_id,
      token_expires_at = excluded.token_expires_at,
      environment = excluded.environment,
      connected_at = datetime('now')
  `).run(tokenResponse.access_token, tokenResponse.refresh_token || null, realmId, expiresAt, QB_ENVIRONMENT);
}

async function refreshAccessToken() {
  const row = db.prepare('SELECT * FROM qb_auth WHERE id = 1').get();
  if (!row || !row.refresh_token) throw new Error('QuickBooks is not connected');

  const basicAuth = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QuickBooks token refresh failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  saveTokens(data, row.realm_id);
  return data;
}

// Returns a valid access token, refreshing first if the current one is
// expired or about to expire (60s buffer to avoid a race against real use).
async function getValidAccessToken() {
  const row = db.prepare('SELECT * FROM qb_auth WHERE id = 1').get();
  if (!row || !row.access_token) throw new Error('QuickBooks is not connected');

  const expiresAt = new Date(row.token_expires_at).getTime();
  const isExpiringSoon = Date.now() > (expiresAt - 60000);

  if (isExpiringSoon) {
    const refreshed = await refreshAccessToken();
    return { accessToken: refreshed.access_token, realmId: row.realm_id };
  }
  return { accessToken: row.access_token, realmId: row.realm_id };
}

async function qboFetch(realmId, accessToken, path) {
  const res = await fetch(`${apiBase(realmId)}${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QuickBooks API returned ${res.status}: ${body}`);
  }
  return res.json();
}

// QBO's query language needs values escaped inside single quotes doubled up.
function escapeQbQuery(str) {
  return String(str).replace(/'/g, "''");
}

async function searchEstimates(searchTerm) {
  const { accessToken, realmId } = await getValidAccessToken();
  const escaped = escapeQbQuery(searchTerm);
  const query = `SELECT Id, DocNumber, TxnDate, TotalAmt, CustomerRef FROM Estimate WHERE DocNumber LIKE '%${escaped}%' OR CustomerRef = '${escaped}' ORDERBY TxnDate DESC MAXRESULTS 25`;
  const data = await qboFetch(realmId, accessToken, `/query?query=${encodeURIComponent(query)}&minorversion=65`);
  const estimates = (data.QueryResponse && data.QueryResponse.Estimate) || [];
  return estimates.map(e => ({
    id: e.Id,
    docNumber: e.DocNumber,
    date: e.TxnDate,
    total: e.TotalAmt,
    customerName: e.CustomerRef ? e.CustomerRef.name : ''
  }));
}

// Batch-fetches Item Type for a set of item IDs referenced on an estimate's
// lines — the Estimate response itself doesn't include each item's Type,
// only its name/id, so this needs a separate lookup.
async function getItemTypes(realmId, accessToken, itemIds) {
  if (!itemIds.length) return {};
  const idList = itemIds.map(id => `'${escapeQbQuery(id)}'`).join(',');
  const query = `SELECT Id, Type FROM Item WHERE Id IN (${idList})`;
  const data = await qboFetch(realmId, accessToken, `/query?query=${encodeURIComponent(query)}&minorversion=65`);
  const items = (data.QueryResponse && data.QueryResponse.Item) || [];
  const map = {};
  items.forEach(i => { map[i.Id] = i.Type; });
  return map;
}

function classifyItemType(qbType) {
  if (qbType === 'Inventory' || qbType === 'NonInventory') return 'material';
  return 'labor_other'; // Service, Bundle, or anything else defaults here
}

async function getEstimateWithLineItems(estimateId) {
  const { accessToken, realmId } = await getValidAccessToken();
  const data = await qboFetch(realmId, accessToken, `/estimate/${estimateId}?minorversion=65`);
  const estimate = data.Estimate;
  if (!estimate) throw new Error('Estimate not found');

  const priceLines = (estimate.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail' && l.SalesItemLineDetail && l.SalesItemLineDetail.ItemRef);
  const itemIds = [...new Set(priceLines.map(l => l.SalesItemLineDetail.ItemRef.value))];
  const itemTypes = await getItemTypes(realmId, accessToken, itemIds);

  const lineItems = priceLines.map(l => {
    const itemId = l.SalesItemLineDetail.ItemRef.value;
    const qbType = itemTypes[itemId] || 'Unknown';
    return {
      description: l.Description || l.SalesItemLineDetail.ItemRef.name || '(No description)',
      quantity: l.SalesItemLineDetail.Qty ?? 1,
      amount: l.Amount,
      qb_item_type: qbType,
      classification: classifyItemType(qbType)
    };
  });

  return {
    id: estimate.Id,
    docNumber: estimate.DocNumber,
    totalAmount: estimate.TotalAmt,
    customerName: estimate.CustomerRef ? estimate.CustomerRef.name : '',
    customerAddress: estimate.BillAddr ? formatQbAddress(estimate.BillAddr) : '',
    lineItems
  };
}

function formatQbAddress(addr) {
  return [addr.Line1, addr.Line2, [addr.City, addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(', ')]
    .filter(Boolean).join('\n');
}

async function disconnect() {
  db.prepare('DELETE FROM qb_auth WHERE id = 1').run();
}

module.exports = {
  isConfigured, isConnected, getAuthUrl, exchangeCodeForTokens,
  searchEstimates, getEstimateWithLineItems, disconnect, classifyItemType
};
