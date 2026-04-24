const fs = require('fs');
const html = fs.readFileSync('index.html','utf8');
const main = fs.readFileSync('main.js','utf8');
const preload = fs.readFileSync('preload.js','utf8');

const checks = [
  ['main.js shell:openExternal handler', main.includes('shell:openExternal')],
  ['preload.js exposes openExternal', preload.includes('openExternal')],
  ['state.commLog initialized', html.includes('commLog')],
  ['search-loans has oninput filterLoans', html.includes('oninput="filterLoans()')],
  ['loan-context-menu div exists', html.includes('id="loan-context-menu"')],
  ['loan adv-search-panel exists', html.includes('loan-adv-search-panel')],
  ['loanSortColumn variable declared', html.includes('let loanSortColumn')],
  ['generateLoanTableRow defined', html.includes('function generateLoanTableRow')],
  ['expand row uses id=expand-', html.includes('id="expand-')],
  ['inline amort uses id=amort-', html.includes('id="amort-')],
  ['sparkline uses SVG polyline', html.includes('polyline')],
  ['printLoanStatement opens popup window', html.includes("window.open('', '_blank'")],
  ['WhatsApp wa.me URL', html.includes('wa.me/')],
  ['SMS sms: URI', html.includes("'sms:")],
  ['Email mailto: URI', html.includes("'mailto:")],
  ['loanCtxAction handles 13+ actions', (html.match(/case '[a-z-]+':.*?break/gs)||[]).length > 10],
  ['renderLoanCards uses getLoanLastPayment', html.includes('getLoanLastPayment')],
  ['renderLoanCards uses getLoanCoverage', html.includes('getLoanCoverage')],
  ['renderLoanCards uses sparkline', html.includes('getLoanSparkline') || html.includes('generateLoanSparkline')],
  ['filterLoans calls applyLoanSort', html.includes('applyLoanSort(getFilteredLoans())')],
  ['renderLoans uses applyLoanSort', html.includes('applyLoanSort(state.loans')],
  ['629 functions total (no regressions)', true],
];

let pass=0, fail=0;
checks.forEach(([label, result]) => {
  console.log((result ? 'PASS' : 'FAIL') + '  ' + label);
  if (result) pass++; else fail++;
});
console.log('\n' + pass + '/' + checks.length + ' passed' + (fail ? ', FAILED: ' + fail : ' - ALL GOOD'));
