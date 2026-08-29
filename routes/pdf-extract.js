// Extracts customer info and line items from a QuickBooks estimate PDF.
// Built and tested against a real exported estimate — see the parsing
// notes below for the specific quirks this handles.
//
// pdf-parse's text extraction glues adjacent text blocks together with no
// space (e.g. "1.Network Video Recorder G2 ProUnifi Ubiquity...", and
// "1$1,077.00$1,077.00" for qty+rate+amount with no separators at all).
// The parser below is built around that reality, not an idealized clean
// text layout.

const pdfParse = require('pdf-parse');

function classifyDescription(description) {
  return /labor/i.test(description) ? 'labor_other' : 'material';
}

function parseItemBlock(block) {
  const withoutNumber = block.replace(/^\d+\.\s*/, '');

  // Trailing qty + rate + amount, glued with no whitespace between them —
  // e.g. "1$1,077.00$1,077.00" or "650$0.23$149.50".
  const trailMatch = withoutNumber.match(/([\d,]+(?:\.\d+)?)\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})\s*$/);
  if (!trailMatch) return null;

  const description = withoutNumber.slice(0, trailMatch.index).replace(/\s+/g, ' ').trim();
  const quantity = parseFloat(trailMatch[1].replace(/,/g, ''));
  const amount = parseFloat(trailMatch[3].replace(/,/g, ''));

  return {
    description,
    quantity,
    amount,
    classification: classifyDescription(description)
  };
}

async function extractEstimateFromPdf(buffer) {
  const result = await pdfParse(buffer);
  const text = result.text;

  // Customer name/address, from the "Bill to" block
  const billToMatch = text.match(/Bill to\n([^\n]+)\n([\s\S]*?)(?=Ship to|Estimate details)/);
  const customerName = billToMatch ? billToMatch[1].trim() : '';
  const customerAddress = billToMatch ? billToMatch[2].trim().replace(/\n+/g, '\n') : '';

  const estNumMatch = text.match(/Estimate no\.:\s*(\S+)/);
  const estimateNumber = estNumMatch ? estNumMatch[1] : '';

  const totalMatch = text.match(/Total\n\$([\d,]+\.\d{2})/);
  const statedTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : null;

  // Isolate the line-item table specifically, between the column header
  // row and the "Total" line, so nothing outside the table gets parsed
  // as if it were a line item.
  const headerIdx = text.indexOf('QtyRateAmount');
  const totalIdx = text.indexOf('Total');
  if (headerIdx === -1 || totalIdx === -1) {
    throw new Error('Could not find the line-item table in this PDF — it may not be a QuickBooks estimate export, or the format has changed.');
  }
  const tableText = text.slice(headerIdx + 'QtyRateAmount'.length, totalIdx);

  // Item markers are "digit(s) + period + LETTER" (e.g. "1.Network",
  // "12.Quote"). The negative lookbehind (?<!\d) is required so a
  // two-digit item number like "10." doesn't get mis-split into "1" and
  // "0.Per..." — and requiring a letter (not digit) after the period
  // avoids false-matching decimal measurements in descriptions, like
  // "2.5"" or "1.8"".
  const itemBlocks = tableText.split(/(?=(?<!\d)\d+\.[A-Za-z])/).map(s => s.trim()).filter(Boolean);

  const items = itemBlocks
    .map(parseItemBlock)
    .filter(item => item && item.amount > 0); // excludes $0 boilerplate lines (e.g. a quote disclaimer)

  const extractedTotal = items.reduce((sum, item) => sum + item.amount, 0);
  // Rounding-safe comparison — PDF totals and summed line items should
  // match to the penny if parsing went correctly.
  const totalMatches = statedTotal !== null && Math.abs(extractedTotal - statedTotal) < 0.01;

  return {
    customerName,
    customerAddress,
    estimateNumber,
    statedTotal,
    extractedTotal,
    totalMatches,
    items
  };
}

module.exports = { extractEstimateFromPdf };
