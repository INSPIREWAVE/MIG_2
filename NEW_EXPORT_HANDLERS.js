// ===== PROFESSIONAL EXPORT HANDLERS - ADD TO main.js =====
// Insert these handlers BEFORE the line: // Allow renderer to open a file picker to select a logo file

// ===== PROFESSIONAL INVOICE EXPORT =====
ipcMain.handle('export:invoice', async (event, loanId) => {
  try {
    const companyName = db.getSettingByKey('companyName') || 'M.I.G Loans';
    const companyPhone = db.getSettingByKey('companyPhone') || '';
    const companyEmail = db.getSettingByKey('companyEmail') || '';
    const companyAddress = db.getSettingByKey('companyAddress') || '';
    const companyBank = db.getSettingByKey('companyBank') || '';
    const companyAccount = db.getSettingByKey('companyAccount') || '';
    
    const loan = db.exec(`SELECT * FROM loans WHERE id = ?`, [loanId]);
    const client = db.exec(`SELECT * FROM clients WHERE id = ?`, [loan[0]?.values[0]?.[1]]);
    if(!loan[0] || !client[0]) return { success: false, error: 'Data not found' };
    
    const loanData = loan[0].values[0];
    const clientData = client[0].values[0];
    const principal = parseFloat(loanData[2]);
    const interest = parseFloat(loanData[3]);
    const interestAmount = principal * interest / 100;
    const totalAmount = principal + interestAmount;
    const invoiceNumber = `INV-${String(loanId).padStart(6,'0')}-${new Date(loanData[5]).getFullYear()}`;
    const issueDate = new Date(loanData[5]);
    const dueDate = new Date(loanData[6]);
    
    const invoiceHtml = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:900px;margin:0 auto;padding:40px;color:#1f2937;background:#ffffff;border:2px solid #e5e7eb">
        <!-- HEADER -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:32px">
          <div>
            <div style="width:180px;height:60px;margin-bottom:16px;background:linear-gradient(135deg,#0d948815 0%,#0d948825 100%);border-radius:8px;display:flex;align-items:center;justify-content:center;border:2px solid #0d948840">
              <span style="font-size:28px;font-weight:900;color:#0d9488;letter-spacing:2px">${companyName.split(' ')[0]}</span>
            </div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;margin-bottom:8px">${companyName}</div>
            <div style="font-size:10px;color:#6b7280;line-height:1.6">
              ${companyPhone ? `📞 ${companyPhone}<br>` : ''}
              ${companyEmail ? `📧 ${companyEmail}<br>` : ''}
              ${companyAddress ? `📍 ${companyAddress}` : ''}
            </div>
          </div>
          <div style="text-align:right">
            <div style="background:linear-gradient(135deg,#0d9488 0%,#14b8a6 100%);color:white;padding:16px 24px;border-radius:8px;display:inline-block;margin-bottom:16px">
              <div style="font-size:32px;font-weight:900;letter-spacing:1px">INVOICE</div>
            </div>
            <div style="font-size:11px;color:#6b7280;line-height:1.8">
              <strong style="color:#0f172a">Invoice #:</strong> ${invoiceNumber}<br>
              <strong style="color:#0f172a">Issue Date:</strong> ${issueDate.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}<br>
              <strong style="color:#0f172a">Due Date:</strong> <span style="color:#dc2626;font-weight:700">${dueDate.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</span>
            </div>
          </div>
        </div>
        
        <!-- Continue with rest of invoice template... -->
      </div>
    `;
    
    return { success: true, html: invoiceHtml };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

// ===== PROFESSIONAL STATEMENT EXPORT =====
ipcMain.handle('export:statement', async (event, loanId, startDate, endDate) => {
  // ... implementation ...
});

// ===== CLIENT PROFILE EXPORT =====
ipcMain.handle('export:clientProfile', async (event, clientId) => {
  // ... implementation ...
});
