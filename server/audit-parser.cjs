const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');

async function loadParser() {
  const mod = await import('./dist/engine/statementParser.js');
  return mod.parseStatement;
}

async function audit(pdfPath, parseStatement) {
  const fname = path.basename(pdfPath);
  console.log('\n' + '='.repeat(80));
  console.log('AUDITING: ' + fname);
  console.log('='.repeat(80));

  const buf = fs.readFileSync(pdfPath);
  const instance = new PDFParse({ data: buf });
  const r = await instance.getText();

  const result = parseStatement(r.text);
  if (!result) {
    console.log('NOT DETECTED by intelligent parser');
    return;
  }

  console.log('\n--- METADATA ---');
  console.log('  Account: ' + result.metadata.accountType + ' - ' + result.metadata.accountNickname);
  console.log('  Period: ' + result.metadata.statementPeriod.start + ' to ' + result.metadata.statementPeriod.end);
  console.log('  Balance: $' + result.metadata.beginningBalance + ' -> $' + result.metadata.endingBalance);

  console.log('\n--- ALL TRANSACTIONS (' + result.transactions.length + ') ---');
  result.transactions.forEach(function(t, i) {
    var tf = t.isTransfer ? ' [TRANSFER:' + t.transferType + '->' + (t.transferAccountRef||'') + ']' : '';
    var cat = t.category ? ' {' + t.category + '}' : ' {uncategorized}';
    console.log('  ' + String(i+1).padStart(3) + '. ' + t.date + ' | ' + t.description.substring(0,50).padEnd(50) + ' | $' + t.amount.toFixed(2).padStart(11) + ' | ' + t.section + tf + cat);
  });

  // Check data completeness
  var lines = r.text.split('\n');
  var dateLines = [];
  if (result.metadata.accountType === 'credit_card') {
    lines.forEach(function(line, idx) {
      if (/^\d{1,2}\/\d{1,2}\s+\d{1,2}\/\d{1,2}\s/.test(line.trim())) {
        dateLines.push({ idx: idx, text: line.trim() });
      }
    });
  } else {
    lines.forEach(function(line, idx) {
      if (/^\d{1,2}\/\d{1,2}\/\d{2}\s/.test(line.trim())) {
        dateLines.push({ idx: idx, text: line.trim() });
      }
    });
  }

  console.log('\n--- COMPLETENESS ---');
  console.log('  Raw date lines: ' + dateLines.length + ' | Parsed: ' + result.transactions.length);
  if (dateLines.length > result.transactions.length) {
    console.log('  *** MISSED ' + (dateLines.length - result.transactions.length) + ' LINES ***');
    dateLines.forEach(function(dl) {
      var found = result.transactions.some(function(t) {
        return dl.text.includes(t.description.substring(0, 15));
      });
      if (!found) {
        console.log('  MISSED: ' + dl.text.substring(0, 120));
      }
    });
  }
}

async function main() {
  var parseStatement = await loadParser();
  var uploadsDir = '/sessions/brave-dreamy-planck/mnt/uploads/';
  var pdfs = fs.readdirSync(uploadsDir)
    .filter(function(f) { return f.startsWith('eStmt') && f.endsWith('.pdf'); })
    .sort()
    .map(function(f) { return path.join(uploadsDir, f); });

  for (var i = 0; i < pdfs.length; i++) {
    await audit(pdfs[i], parseStatement);
  }
}

main().catch(function(e) { console.error(e); });
