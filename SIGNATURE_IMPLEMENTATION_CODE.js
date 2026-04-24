/**
 * COMPLETE SIGNATURE IMPLEMENTATION CODE
 * Copy and paste these functions into index.html to enable full digital signature feature
 * 
 * Features:
 * - Dual signature capture (borrower + lender)
 * - Touch and mouse support
 * - Save signatures to database
 * - Embed signatures in PDF exports
 * - Auto-save to client folders
 */

// ========================================
// SIGNATURE CAPTURE FUNCTIONS
// ========================================

/**
 * Opens the signature modal for capturing both borrower and lender signatures
 * @param {number} loanId - The ID of the loan to sign
 */
function openSignatureCapture(loanId) {
  const loan = state.loans.find(l => l.id === loanId);
  const client = state.clients.find(c => c.id === loan?.clientId);
  
  if (!loan || !client) {
    toast('Loan or client not found', 'error');
    return;
  }
  
  // Check if signatures already exist
  let existingSignatures = null;
  if (loan.signatureData) {
    try {
      existingSignatures = JSON.parse(loan.signatureData);
    } catch(e) {
      console.error('Failed to parse signature data:', e);
    }
  }
  
  const html = `
    <div style="max-width: 700px;">
      <h2 style="margin-bottom: 8px;">Sign Loan Agreement #${loan.loanNumber || loanId}</h2>
      <p style="color: #6b7280; font-size: 13px; margin-bottom: 24px; line-height: 1.5;">
        Both parties must sign below. Use your mouse or touchscreen to draw signatures.
      </p>
      
      <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 8px 0; font-size: 15px; color: #0d9488;">1. Borrower Signature</h3>
        <p style="font-size: 13px; color: #4b5563; margin-bottom: 12px;">
          <strong>${client.name}</strong> • ${client.phone || 'N/A'}
        </p>
        <canvas id="borrower-signature-pad" width="600" height="150" 
                style="border: 2px solid #0d9488; background: white; border-radius: 8px; cursor: crosshair; width: 100%; display: block;"></canvas>
        <button class="btn btn-secondary btn-small" onclick="clearCanvas('borrower-signature-pad')" style="margin-top: 8px;">
          🗑️ Clear Borrower Signature
        </button>
      </div>
      
      <div style="background: #fef3f2; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 8px 0; font-size: 15px; color: #dc2626;">2. Lender Signature</h3>
        <p style="font-size: 13px; color: #4b5563; margin-bottom: 12px;">
          <strong>Authorized Representative</strong>
        </p>
        <canvas id="lender-signature-pad" width="600" height="150" 
                style="border: 2px solid #dc2626; background: white; border-radius: 8px; cursor: crosshair; width: 100%; display: block;"></canvas>
        <button class="btn btn-secondary btn-small" onclick="clearCanvas('lender-signature-pad')" style="margin-top: 8px;">
          🗑️ Clear Lender Signature
        </button>
      </div>
      
      ${existingSignatures ? '<p style="color: #0d9488; font-size: 12px; margin-bottom: 16px;">✓ Existing signatures loaded. You can update them below.</p>' : ''}
      
      <div style="display: flex; gap: 8px; border-top: 2px solid #e5e7eb; padding-top: 16px;">
        <button class="btn btn-primary" onclick="saveBothSignatures(${loanId})">
          ✅ Save Both Signatures
        </button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `;
  
  showModal(html);
  
  // Setup both canvases with drawing capability
  setTimeout(() => {
    setupSignatureCanvas('borrower-signature-pad');
    setupSignatureCanvas('lender-signature-pad');
    
    // Load existing signatures if any
    if (existingSignatures) {
      if (existingSignatures.borrower) {
        loadSignatureToCanvas('borrower-signature-pad', existingSignatures.borrower);
      }
      if (existingSignatures.lender) {
        loadSignatureToCanvas('lender-signature-pad', existingSignatures.lender);
      }
    }
  }, 100);
}

/**
 * Sets up a canvas for signature drawing with mouse and touch support
 * @param {string} canvasId - The ID of the canvas element
 */
function setupSignatureCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let lastX = 0;
  let lastY = 0;
  
  // Determine stroke color based on canvas ID
  const strokeColor = canvasId.includes('borrower') ? '#0d9488' : '#dc2626';
  
  // Mouse events
  canvas.addEventListener('mousedown', (e) => {
    drawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
  });
  
  canvas.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = strokeColor;
    ctx.lineTo(x, y);
    ctx.stroke();
    
    lastX = x;
    lastY = y;
  });
  
  canvas.addEventListener('mouseup', () => {
    drawing = false;
  });
  
  canvas.addEventListener('mouseleave', () => {
    drawing = false;
  });
  
  // Touch events for tablets and mobile devices
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    drawing = true;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches[0];
    lastX = touch.clientX - rect.left;
    lastY = touch.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
  });
  
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!drawing) return;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches[0];
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = strokeColor;
    ctx.lineTo(x, y);
    ctx.stroke();
    
    lastX = x;
    lastY = y;
  });
  
  canvas.addEventListener('touchend', () => {
    drawing = false;
  });
}

/**
 * Clears a signature canvas
 * @param {string} canvasId - The ID of the canvas to clear
 */
function clearCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Redraw white background
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * Loads a signature image onto a canvas
 * @param {string} canvasId - The ID of the canvas
 * @param {string} base64Image - The base64 encoded image data
 */
function loadSignatureToCanvas(canvasId, base64Image) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !base64Image) return;
  
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = base64Image;
}

/**
 * Saves both borrower and lender signatures to the database
 * @param {number} loanId - The ID of the loan
 */
async function saveBothSignatures(loanId) {
  const borrowerCanvas = document.getElementById('borrower-signature-pad');
  const lenderCanvas = document.getElementById('lender-signature-pad');
  
  if (!borrowerCanvas || !lenderCanvas) {
    toast('Canvas not found', 'error');
    return;
  }
  
  // Check if both canvases have content
  const isBlankBorrower = isCanvasBlank(borrowerCanvas);
  const isBlankLender = isCanvasBlank(lenderCanvas);
  
  if (isBlankBorrower && isBlankLender) {
    toast('Please draw at least one signature', 'error');
    return;
  }
  
  if (isBlankBorrower) {
    if (!confirm('Borrower signature is blank. Continue anyway?')) return;
  }
  
  if (isBlankLender) {
    if (!confirm('Lender signature is blank. Continue anyway?')) return;
  }
  
  const borrowerData = borrowerCanvas.toDataURL('image/png');
  const lenderData = lenderCanvas.toDataURL('image/png');
  
  const signatureData = JSON.stringify({
    borrower: borrowerData,
    lender: lenderData,
    signedDate: new Date().toISOString()
  });
  
  try {
    const result = await window.api.loans.saveSignature(loanId, signatureData);
    if (result.success || result) {
      toast('Signatures saved successfully ✅');
      closeModal();
      await loadData();
    } else {
      toast('Failed to save signatures', 'error');
    }
  } catch (e) {
    console.error('Save signature error:', e);
    toast('Failed to save signatures', 'error');
  }
}

/**
 * Checks if a canvas is blank (no drawing)
 * @param {HTMLCanvasElement} canvas - The canvas to check
 * @returns {boolean} True if blank, false otherwise
 */
function isCanvasBlank(canvas) {
  const ctx = canvas.getContext('2d');
  const pixelData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  // Check if all pixels are the same (blank canvas)
  for (let i = 0; i < pixelData.data.length; i += 4) {
    if (pixelData.data[i + 3] !== 0 && pixelData.data[i + 3] !== 255) {
      return false; // Found a non-blank pixel
    }
  }
  return true;
}

// ========================================
// ENHANCED LOAN AGREEMENT GENERATION
// ========================================

/**
 * Generates loan agreement PDF with optional signature embedding
 * @param {number} loanId - The ID of the loan
 * @param {boolean} includeSignatures - Whether to include digital signatures (default: true)
 */
async function generateLoanAgreementWithSignatures(loanId, includeSignatures = true) {
  const loan = state.loans.find(l => l.id === loanId);
  const client = state.clients.find(c => String(c.id) === String(loan?.clientId));
  
  if (!loan || !client) {
    toast('Loan or client not found', 'error');
    return;
  }
  
  const companyName = await window.api.settings.get('companyName') || 'M.I.G Loans';
  
  // Parse signature data if available and requested
  let signatureData = null;
  if (includeSignatures && loan.signatureData) {
    try {
      signatureData = JSON.parse(loan.signatureData);
    } catch(e) {
      console.error('Failed to parse signature data:', e);
    }
  }
  
  const totalAmount = Number(loan.amount) + (Number(loan.amount) * Number(loan.interest) / 100);
  const interestAmount = Number(loan.amount) * Number(loan.interest) / 100;
  
  // Build signature section HTML
  let signatureSection = '';
  if (signatureData && signatureData.borrower && signatureData.lender) {
    signatureSection = `
      <div style="margin-top: 60px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px;">
        <div>
          <img src="${signatureData.borrower}" style="width: 100%; max-width: 250px; height: 80px; object-fit: contain; border-bottom: 2px solid #1f2937; margin-bottom: 8px;"/>
          <p style="margin: 0; font-size: 13px; font-weight: 600;">Borrower: ${client.name}</p>
          <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">Date: ${new Date(signatureData.signedDate).toLocaleDateString()}</p>
          <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">NRC: ${client.nrc || 'N/A'}</p>
        </div>
        <div>
          <img src="${signatureData.lender}" style="width: 100%; max-width: 250px; height: 80px; object-fit: contain; border-bottom: 2px solid #1f2937; margin-bottom: 8px;"/>
          <p style="margin: 0; font-size: 13px; font-weight: 600;">Lender Representative</p>
          <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">Date: ${new Date(signatureData.signedDate).toLocaleDateString()}</p>
          <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">${companyName}</p>
        </div>
      </div>
    `;
  } else {
    signatureSection = `
      <div style="margin-top: 60px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px;">
        <div style="border-top: 2px solid #1f2937; padding-top: 10px;">
          <p style="margin: 40px 0 5px 0; font-size: 13px; font-weight: 600;">Borrower Signature</p>
          <p style="margin: 5px 0 0 0; font-size: 12px; color: #6b7280;">${client.name}</p>
          <p style="margin: 15px 0 0 0; font-size: 12px; color: #6b7280;">Date: _________________</p>
        </div>
        <div style="border-top: 2px solid #1f2937; padding-top: 10px;">
          <p style="margin: 40px 0 5px 0; font-size: 13px; font-weight: 600;">Lender Representative</p>
          <p style="margin: 5px 0 0 0; font-size: 12px; color: #6b7280;">${companyName}</p>
          <p style="margin: 15px 0 0 0; font-size: 12px; color: #6b7280;">Date: _________________</p>
        </div>
      </div>
    `;
  }
  
  const content = `
    <div style="background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); padding: 30px; margin: -20px -20px 30px -20px; color: white;">
      <h2 style="margin: 0; font-size: 28px;">LOAN AGREEMENT</h2>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">Agreement #${loan.loanNumber || loanId} • ${new Date().toLocaleDateString()}</p>
    </div>
    
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 30px; font-size: 13px;">
      <div>
        <h4 style="color: #1f2937; margin-bottom: 10px; border-bottom: 2px solid #0d9488; padding-bottom: 6px;">Borrower Information</h4>
        <p style="margin: 5px 0;"><strong>Name:</strong> ${client.name}</p>
        <p style="margin: 5px 0;"><strong>Phone:</strong> ${client.phone || 'N/A'}</p>
        <p style="margin: 5px 0;"><strong>Email:</strong> ${client.email || 'N/A'}</p>
        <p style="margin: 5px 0;"><strong>NRC/ID:</strong> ${client.nrc || 'N/A'}</p>
      </div>
      <div>
        <h4 style="color: #1f2937; margin-bottom: 10px; border-bottom: 2px solid #0d9488; padding-bottom: 6px;">Loan Information</h4>
        <p style="margin: 5px 0;"><strong>Loan Number:</strong> ${loan.loanNumber || loanId}</p>
        <p style="margin: 5px 0;"><strong>Loan Date:</strong> ${new Date(loan.loanDate).toLocaleDateString()}</p>
        <p style="margin: 5px 0;"><strong>Due Date:</strong> ${new Date(loan.dueDate).toLocaleDateString()}</p>
        <p style="margin: 5px 0;"><strong>Status:</strong> ${loan.status}</p>
      </div>
    </div>
    
    <h3 style="color: #1f2937; margin: 25px 0 15px 0;">LOAN TERMS</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="background: #f9fafb;">
        <td style="padding: 12px; border: 1px solid #e5e7eb; font-weight: 600;">Principal Amount</td>
        <td style="padding: 12px; border: 1px solid #e5e7eb; text-align: right; font-family: monospace;">${fmtMoney(loan.amount)}</td>
      </tr>
      <tr>
        <td style="padding: 12px; border: 1px solid #e5e7eb; font-weight: 600;">Interest Rate</td>
        <td style="padding: 12px; border: 1px solid #e5e7eb; text-align: right;">${loan.interest}%</td>
      </tr>
      <tr style="background: #f9fafb;">
        <td style="padding: 12px; border: 1px solid #e5e7eb; font-weight: 600;">Interest Amount</td>
        <td style="padding: 12px; border: 1px solid #e5e7eb; text-align: right; font-family: monospace;">${fmtMoney(interestAmount)}</td>
      </tr>
      <tr style="background: #ecfdf5; font-weight: 700; border: 2px solid #10b981;">
        <td style="padding: 12px; border: 2px solid #10b981;">TOTAL AMOUNT DUE</td>
        <td style="padding: 12px; border: 2px solid #10b981; text-align: right; font-family: monospace; font-size: 16px;">${fmtMoney(totalAmount)}</td>
      </tr>
    </table>
    
    ${loan.collateral ? `
      <h3 style="color: #1f2937; margin: 25px 0 15px 0;">COLLATERAL PLEDGED</h3>
      <div style="padding: 15px; background: #f9fafb; border-left: 4px solid #0d9488; border-radius: 4px; font-size: 13px;">
        ${loan.collateral}
      </div>
    ` : ''}
    
    <h3 style="color: #1f2937; margin: 25px 0 15px 0;">TERMS & CONDITIONS</h3>
    <ol style="font-size: 13px; line-height: 1.8; padding-left: 20px;">
      <li>The borrower agrees to repay the full amount of ${fmtMoney(totalAmount)} by the due date of ${new Date(loan.dueDate).toLocaleDateString()}.</li>
      <li>The interest rate of ${loan.interest}% has been agreed upon and is non-negotiable unless written amendment is made.</li>
      <li>Late payments may incur additional penalties as per the lending policy (currently ${await window.api.settings.get('daily_penalty_rate') || '5'}% daily on overdue amounts).</li>
      <li>The borrower must inform the lender of any change in contact information or financial circumstances immediately.</li>
      <li>This agreement is binding and enforceable by law in the jurisdiction of operation (Republic of Zambia).</li>
      <li>Both parties agree to the terms outlined in this agreement and confirm understanding of their obligations.</li>
    </ol>
    
    ${signatureSection}
    
    <div style="margin-top: 50px; padding-top: 20px; border-top: 2px solid #e5e7eb;">
      <p style="margin: 0; color: #6b7280; font-size: 12px;">
        ${signatureData ? '✓ This is a digitally signed document.' : 'This document requires physical signatures.'} 
        Generated: ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}
      </p>
      <p style="margin: 5px 0 0 0; color: #9ca3af; font-size: 11px;">
        ${companyName} • Loan Management System v1.0
      </p>
    </div>
  `;
  
  // Generate PDF and save to client folder
  const clientNumber = client.clientNumber || `CLT-${client.id}`;
  const clientName = client.name;
  const loanNumber = loan.loanNumber || `LN-${loan.id}`;
  const subfolder = loan.status === 'cleared' ? 'loans/cleared' : 'loans/pending';
  const filename = signatureData ? `${loanNumber}_agreement_signed.pdf` : `${loanNumber}_agreement.pdf`;
  
  await generatePDFAndSaveToClientFolder(
    `Loan Agreement #${loanNumber}`,
    content,
    clientNumber,
    clientName,
    subfolder,
    filename
  );
}

/**
 * Generates PDF from HTML and saves to client folder
 * @param {string} title - PDF document title
 * @param {string} htmlContent - HTML content to convert
 * @param {string} clientNumber - Client number (e.g., CLT-0001)
 * @param {string} clientName - Client name
 * @param {string} subfolder - Subfolder path (e.g., 'loans/pending')
 * @param {string} filename - File name
 */
async function generatePDFAndSaveToClientFolder(title, htmlContent, clientNumber, clientName, subfolder, filename) {
  const element = document.createElement('div');
  element.innerHTML = htmlContent;
  element.style.padding = '20px';
  element.style.background = 'white';
  element.style.fontFamily = 'Arial, sans-serif';
  element.style.position = 'absolute';
  element.style.left = '-9999px';
  document.body.appendChild(element);
  
  try {
    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff'
    });
    
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF('p', 'mm', 'a4');
    const imgWidth = 210;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;
    
    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
    heightLeft -= 297;
    
    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= 297;
    }
    
    // Convert PDF to base64
    const pdfBase64 = pdf.output('dataurlstring').split(',')[1];
    
    // Save to client folder
    const result = await window.api.files.saveToClientFolder(
      clientNumber,
      clientName,
      subfolder,
      filename,
      pdfBase64
    );
    
    if (result.success) {
      toast(`✅ Saved: ${filename}`, 'success');
      
      // Also download to desktop for immediate viewing
      pdf.save(`${title}.pdf`);
      
      // Open client folder option
      setTimeout(() => {
        if (confirm('Document saved! Open client folder?')) {
          window.api.files.openClientFolder(clientNumber, clientName);
        }
      }, 500);
    } else {
      toast('Save failed: ' + result.error, 'error');
      // Still download to desktop as fallback
      pdf.save(`${title}.pdf`);
    }
    
  } catch (error) {
    console.error('PDF generation error:', error);
    toast('PDF generation failed', 'error');
  } finally {
    document.body.removeChild(element);
  }
}

// ========================================
// UPDATED LOAN ACTION BUTTONS
// Add these button options to your loan list rendering
// ========================================

/*
USAGE IN LOAN TABLE:

Replace the existing loan agreement button with these three options:

<button class="btn btn-secondary btn-small" onclick="openSignatureCapture(${loanId})" title="Capture digital signatures">
  ✍️ Sign
</button>
<button class="btn btn-secondary btn-small" onclick="generateLoanAgreementWithSignatures(${loanId}, false)" title="Generate blank agreement for manual signing">
  📄 Blank
</button>
<button class="btn btn-primary btn-small" onclick="generateLoanAgreementWithSignatures(${loanId}, true)" title="Generate agreement with embedded signatures">
  📋 With Sigs
</button>

*/

// ========================================
// INSTALLATION NOTES
// ========================================

/*
TO INSTALL THIS FEATURE:

1. Copy all functions from this file
2. Paste into index.html <script> section (around line 700+)
3. Replace the existing openSignatureCapture function
4. Update loan table buttons to use the new three-button layout
5. Test the workflow:
   - Create a loan
   - Click "Sign" to capture signatures
   - Click "With Sigs" to generate PDF with signatures
   - Click "Blank" to generate PDF without signatures for manual signing
6. Verify files are saved to: %APPDATA%/MIG/ClientFiles/{clientNumber}_{clientName}/loans/

BACKEND REQUIREMENTS (Already implemented):
- db.js has saveLoanSignature() function
- main.js has 'loans:saveSignature' IPC handler
- preload.js exposes saveSignature() function
- main.js has 'files:saveToClientFolder' IPC handler
- preload.js exposes files.saveToClientFolder() function

All backend code is ready - just add this frontend code!
*/
