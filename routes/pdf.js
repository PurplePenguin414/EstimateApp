const PDFDocument = require('pdfkit');
const fs = require('fs');

const TITLES = {
  'material-draw': 'MATERIAL DRAW INVOICE',
  'remaining-balance': 'REMAINING BALANCE INVOICE'
};

const TERMS = {
  'material-draw': 'Due upon acceptance — payment required before work begins',
  'remaining-balance': 'Due Net 30 from project completion date'
};

function formatCurrency(amount) {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function generateInvoicePdf(res, { type, project, lineItems, settings, logoPath }) {
  const doc = new PDFDocument({ margin: 50, size: 'letter' });
  doc.pipe(res);

  // ---- Header: logo + business info ----
  let headerY = 50;
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 50, headerY, { width: 120 });
    } catch (e) {
      // If the logo file is somehow unreadable/corrupt, don't let the whole
      // PDF fail — just skip it and continue with a text-only header.
    }
  }

  doc.fontSize(10).fillColor('#333');
  const bizInfoX = 350;
  doc.text(settings.business_name || '', bizInfoX, headerY, { width: 200, align: 'right' });
  if (settings.address) doc.text(settings.address, bizInfoX, doc.y, { width: 200, align: 'right' });
  if (settings.phone) doc.text(settings.phone, bizInfoX, doc.y, { width: 200, align: 'right' });
  if (settings.email) doc.text(settings.email, bizInfoX, doc.y, { width: 200, align: 'right' });

  doc.y = Math.max(doc.y, headerY + 90);
  doc.moveDown(1.5);

  // ---- Title ----
  // Explicit x/width here (not just align:'center') because doc.x is still
  // sitting wherever the right-aligned business info block above left it —
  // without this, "centered" text centers within that narrower leftover
  // box, not the actual full page width.
  doc.fontSize(18).fillColor('#000').font('Helvetica-Bold').text(TITLES[type], 50, doc.y, { width: 512, align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666').font('Helvetica').text(TERMS[type], 50, doc.y, { width: 512, align: 'center' });
  doc.moveDown(1.5);

  // ---- Customer + project info ----
  doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text('Bill To:');
  doc.font('Helvetica').fontSize(10);
  doc.text(project.customer_name || '');
  if (project.customer_address) doc.text(project.customer_address);
  doc.moveDown(0.5);
  doc.text(`Project: ${project.project_name}`);
  if (project.qb_estimate_number) doc.text(`Reference Estimate #: ${project.qb_estimate_number}`);
  doc.text(`Date: ${new Date().toLocaleDateString('en-US')}`);
  doc.moveDown(1.5);

  // ---- Line items table ----
  const tableTop = doc.y;
  const col = { desc: 50, qty: 380, amount: 450 };

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Description', col.desc, tableTop);
  doc.text('Qty', col.qty, tableTop);
  doc.text('Amount', col.amount, tableTop);
  doc.moveTo(50, tableTop + 15).lineTo(562, tableTop + 15).strokeColor('#999').stroke();

  let y = tableTop + 22;
  doc.font('Helvetica').fontSize(10);
  let total = 0;

  const descWidth = 320;
  const rowPadding = 8;

  lineItems.forEach(item => {
    // Calculate the actual rendered height of this item's description at
    // the column width BEFORE drawing anything — long descriptions wrap to
    // multiple lines, and a fixed row height (the previous bug) caused
    // longer items to overlap the row below them.
    const descHeight = doc.heightOfString(item.description, { width: descWidth });
    const rowHeight = Math.max(descHeight, 14) + rowPadding;

    if (y + rowHeight > 700) { doc.addPage(); y = 50; }

    doc.text(item.description, col.desc, y, { width: descWidth });
    doc.text(String(item.quantity), col.qty, y);
    doc.text(formatCurrency(item.amount), col.amount, y);
    total += item.amount;
    y += rowHeight;
  });

  doc.moveTo(50, y + 5).lineTo(562, y + 5).strokeColor('#999').stroke();
  y += 15;

  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('Total Due:', col.qty, y);
  doc.text(formatCurrency(total), col.amount, y);
  y += 30;

  if (settings.invoice_disclaimer) {
    const disclaimerWidth = 512;
    const disclaimerHeight = doc.heightOfString(settings.invoice_disclaimer, { width: disclaimerWidth });
    if (y + disclaimerHeight > 700) { doc.addPage(); y = 50; }
    doc.moveTo(50, y).lineTo(562, y).strokeColor('#ccc').stroke();
    y += 12;
    doc.font('Helvetica').fontSize(8).fillColor('#666');
    doc.text(settings.invoice_disclaimer, 50, y, { width: disclaimerWidth });
  }

  doc.end();
}

function generateCostBreakdownPdf(res, { project, materials, labor, financials, settings, logoPath }) {
  const doc = new PDFDocument({ margin: 50, size: 'letter' });
  doc.pipe(res);

  // ---- Header: logo + business info (same pattern as the customer invoices) ----
  let headerY = 50;
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 50, headerY, { width: 120 });
    } catch (e) {
      // Skip silently if the logo file is unreadable — don't fail the whole PDF over it.
    }
  }

  doc.fontSize(10).fillColor('#333');
  const bizInfoX = 350;
  doc.text(settings.business_name || '', bizInfoX, headerY, { width: 200, align: 'right' });
  if (settings.address) doc.text(settings.address, bizInfoX, doc.y, { width: 200, align: 'right' });
  if (settings.phone) doc.text(settings.phone, bizInfoX, doc.y, { width: 200, align: 'right' });
  if (settings.email) doc.text(settings.email, bizInfoX, doc.y, { width: 200, align: 'right' });

  doc.y = Math.max(doc.y, headerY + 90);
  doc.moveDown(1.5);

  // ---- Title ----
  doc.fontSize(18).fillColor('#000').font('Helvetica-Bold').text('COST / PROFIT BREAKDOWN', 50, doc.y, { width: 512, align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#999').font('Helvetica').text('Internal use only — not for the customer', 50, doc.y, { width: 512, align: 'center' });
  doc.moveDown(1.5);

  doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text(project.project_name);
  doc.font('Helvetica').fontSize(10);
  if (project.customer_name) doc.text(`Customer: ${project.customer_name}`);
  doc.text(`Date: ${new Date().toLocaleDateString('en-US')}`);
  doc.moveDown(1.5);

  const descWidth = 380;
  const rowPadding = 8;

  function drawSectionTable(title, rows, columns) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(title, 50, doc.y);
    doc.moveDown(0.3);

    if (!rows.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('None entered.');
      doc.moveDown(1);
      return;
    }

    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    columns.forEach(col => doc.text(col.label, col.x, tableTop, { width: col.width }));
    doc.moveTo(50, tableTop + 14).lineTo(562, tableTop + 14).strokeColor('#999').stroke();

    let y = tableTop + 20;
    doc.font('Helvetica').fontSize(10);

    rows.forEach(row => {
      const descHeight = doc.heightOfString(row[columns[0].key], { width: columns[0].width });
      const rowHeight = Math.max(descHeight, 12) + rowPadding;
      if (y + rowHeight > 700) { doc.addPage(); y = 50; }

      columns.forEach(col => {
        doc.text(String(row[col.key]), col.x, y, { width: col.width });
      });
      y += rowHeight;
    });

    doc.y = y + 10;
  }

  drawSectionTable('Material Costs', materials.map(m => ({
    desc: m.description, cost: formatCurrency(m.cost)
  })), [
    { key: 'desc', label: 'Description', x: 50, width: descWidth },
    { key: 'cost', label: 'Cost', x: 450, width: 100 }
  ]);

  drawSectionTable('1099 Labor', labor.map(l => ({
    worker: l.worker_name, hours: `${l.hours}h @ ${formatCurrency(l.hourly_rate)}/hr`, cost: formatCurrency(l.hours * l.hourly_rate)
  })), [
    { key: 'worker', label: 'Worker', x: 50, width: 200 },
    { key: 'hours', label: 'Hours / Rate', x: 260, width: 190 },
    { key: 'cost', label: 'Cost', x: 450, width: 100 }
  ]);

  // ---- Financial summary ----
  if (doc.y > 620) { doc.addPage(); doc.y = 50; }
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text('Summary', 50, doc.y);
  doc.moveDown(0.3);

  const summaryRows = [
    ['Revenue', formatCurrency(financials.revenue)],
    ['Material Cost', formatCurrency(financials.total_material_cost)],
    ['Labor Cost', formatCurrency(financials.total_labor_cost)],
    ['Gross Profit', formatCurrency(financials.gross_profit)],
    ['Tax Set-Aside (30%)', formatCurrency(financials.tax_set_aside)],
    ['Net Profit', formatCurrency(financials.net_profit)],
    ['Net Profit % of Revenue', financials.net_profit_percentage.toFixed(1) + '%']
  ];
  doc.font('Helvetica').fontSize(11);
  summaryRows.forEach(([label, value], idx) => {
    const isHighlight = label === 'Gross Profit' || label === 'Net Profit';
    doc.font(isHighlight ? 'Helvetica-Bold' : 'Helvetica').fontSize(isHighlight ? 12 : 11);
    doc.text(label, 50, doc.y, { continued: true, width: 300 });
    doc.text(value, { align: 'right' });
  });

  doc.end();
}

module.exports = { generateInvoicePdf, generateCostBreakdownPdf, formatCurrency };
