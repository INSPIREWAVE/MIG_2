const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// 1. Collect all defined function names
const defined = new Set();
const defRe = /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
let m;
while ((m = defRe.exec(html)) !== null) defined.add(m[1]);
// Also arrow/const fn
const arrowRe = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g;
while ((m = arrowRe.exec(html)) !== null) defined.add(m[1]);

console.log('Total functions defined:', defined.size);

// 2. Loan-specific functions we just added - check all present
const newFns = [
  'sortLoansBy','applyLoanSort','toggleLoanRow','showLoanContextMenu','loanCtxAction','loanContextAction',
  'toggleLoanAdvSearch','applyLoanAdvSearch','toggleLoanColumnPanel','toggleLoanColumn','toggleLoanCol',
  'getLoanLastPayment','getLoanCoverage','getLoanSparkline','generateLoanSparkline',
  'loanQuickSMS','loanQuickWhatsApp','loanQuickEmail',
  'printLoanStatement','bulkPrintLoanStatements','exportLoanPDF','generateLoanQR',
  'generateLoanTableRow','renderLoanCards','renderLoanGrid','renderLoansFiltered','renderLoans','filterLoans',
  'getFilteredLoans','clearLoanFilters','updateLoanStats',
  // Comms
  'initCommsPage','sendComm','logCommunication','renderCommHistory','updateCommStats',
  'broadcastToGroup','renderCommTemplates','clearCommHistory','exportCommHistory',
  'loanQuickSMS','loanQuickWhatsApp'
];

let missing = [], present = [];
newFns.forEach(fn => {
  if (defined.has(fn)) present.push(fn);
  else missing.push(fn);
});

console.log('\n=== NEW FUNCTIONS CHECK ===');
console.log('Present (' + present.length + '):', present.join(', '));
if (missing.length) console.log('\nMISSING (' + missing.length + '):', missing.join(', '));
else console.log('\nAll new functions defined OK');

// 3. Check onclick calls in HTML for key new functions
const keyHandlers = ['sortLoansBy','toggleLoanRow','showLoanContextMenu','loanCtxAction','toggleLoanColumnPanel',
  'toggleLoanAdvSearch','printLoanStatement','bulkPrintLoanStatements','generateLoanQR',
  'loanQuickSMS','loanQuickWhatsApp','loanQuickEmail'];
console.log('\n=== HTML WIRING CHECK ===');
keyHandlers.forEach(fn => {
  const count = (html.match(new RegExp(fn + '\\s*\\(', 'g')) || []).length;
  console.log(fn + ':', count > 0 ? 'WIRED (' + count + ' calls)' : 'NOT CALLED IN HTML');
});
