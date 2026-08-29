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
  doc.fontSize(18).fillColor('#000').font('Helvetica-Bold').text(TITLES[type], { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666').font('Helvetica').text(TERMS[type], { align: 'center' });
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

  doc.end();
}

module.exports = { generateInvoicePdf, formatCurrency };
