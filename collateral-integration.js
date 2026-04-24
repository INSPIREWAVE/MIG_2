// ===== COLLATERAL INTEGRATION - ADD TO INDEX.HTML =====

// Global state for collateral
let selectedCollateralImages = [];
let selectedCollateralDocument = null;

// Toggle collateral section visibility
function toggleCollateralSection() {
  const checkbox = document.getElementById('form-has-collateral');
  const section = document.getElementById('collateral-section');
  if (checkbox && section) {
    section.style.display = checkbox.checked ? 'block' : 'none';
    if (checkbox.checked) {
      calculateAcceptedValue();
    }
  }
}

// Update defaults based on collateral type
function updateCollateralDefaults() {
  const type = document.getElementById('coll-item-type')?.value;
  const estimatedInput = document.getElementById('coll-estimated');
  
  if (!type || !estimatedInput) return;
  
  // Show hints based on type
  const hints = {
    'Vehicle': '🚗 Tip: Usually accept 75-85% of market value',
    'Property': '🏠 Tip: Properties often accept 85-95%',
    'Jewelry': '💍 Tip: Jewelry typically 60-75%',
    'Electronics': '📱 Warning: Electronics depreciate quickly (50-70%)',
    'Other': '💼 Assess value carefully'
  };
  
  const hint = hints[type] || '';
  const estimatedValue = parseFloat(estimatedInput.value || 0);
  
  if (estimatedValue > 0) {
    calculateAcceptedValue();
  }
  
  // Show hint near input
  const parent = estimatedInput.parentElement;
  let hintDiv = parent.querySelector('.type-hint');
  if (!hintDiv) {
    hintDiv = document.createElement('div');
    hintDiv.className = 'type-hint';
    hintDiv.style.cssText = 'margin-top: 4px; font-size: 10px; color: #6b7280; font-style: italic;';
    parent.appendChild(hintDiv);
  }
  hintDiv.textContent = hint;
}

// Calculate accepted value (85% default, adjustable)
async function calculateAcceptedValue() {
  const estimated = parseFloat(document.getElementById('coll-estimated')?.value || 0);
  const acceptedInput = document.getElementById('coll-accepted');
  const type = document.getElementById('coll-item-type')?.value;
  
  if (!acceptedInput || estimated <= 0) return;
  
  // Get percentage from settings (default 85%)
  let percentage = 85;
  try {
    const savedPercentage = await window.api.settings.get('collateral_accepted_percentage');
    percentage = savedPercentage ? parseFloat(savedPercentage) : 85;
  } catch (e) {
    console.warn('Could not load collateral percentage, using 85%');
  }
  
  // Adjust by type if not already set
  if (!acceptedInput.value) {
    const typeAdjustments = {
      'Vehicle': 80,
      'Property': 90,
      'Jewelry': 70,
      'Electronics': 65,
      'Other': percentage
    };
    percentage = typeAdjustments[type] || percentage;
  }
  
  const acceptedValue = (estimated * (percentage / 100)).toFixed(2);
  acceptedInput.placeholder = `Auto: K ${acceptedValue} (${percentage}%)`;
  
  // Calculate coverage ratio
  calculateLoanCoverage();
}

// Calculate loan coverage ratio
function calculateLoanCoverage() {
  const loanAmount = parseFloat(document.getElementById('form-amount')?.value || 0);
  const acceptedValue = parseFloat(document.getElementById('coll-accepted')?.value || 0);
  const estimated = parseFloat(document.getElementById('coll-estimated')?.value || 0);
  const indicator = document.getElementById('coverage-indicator');
  
  if (!indicator || loanAmount <= 0) {
    if (indicator) indicator.innerHTML = '';
    return;
  }
  
  const collateralValue = acceptedValue || estimated;
  if (collateralValue <= 0) {
    indicator.innerHTML = '';
    return;
  }
  
  const ratio = ((collateralValue / loanAmount) * 100).toFixed(0);
  let color, icon, message;
  
  if (ratio >= 120) {
    color = '#10b981';
    icon = '✅';
    message = `Excellent Coverage: ${ratio}%`;
  } else if (ratio >= 100) {
    color = '#10b981';
    icon = '✓';
    message = `Good Coverage: ${ratio}%`;
  } else if (ratio >= 80) {
    color = '#f59e0b';
    icon = '⚠️';
    message = `Moderate Coverage: ${ratio}%`;
  } else {
    color = '#ef4444';
    icon = '⛔';
    message = `Low Coverage: ${ratio}% - Risk!`;
  }
  
  indicator.innerHTML = `<span style="color: ${color}; font-weight: 700;">${icon} ${message}</span>`;
}

// Select multiple images
async function selectCollateralImages() {
  try {
    const result = await window.api.collateral.selectImage();
    if (result.success && result.paths) {
      selectedCollateralImages = result.paths;
      displayImagePreviews();
      toast(`${result.paths.length} image(s) selected`, 'ok');
    }
  } catch (e) {
    toast('Failed to select images', 'error');
  }
}

// Display image previews
function displayImagePreviews() {
  const container = document.getElementById('image-preview');
  if (!container) return;
  
  container.innerHTML = selectedCollateralImages.map((path, index) => {
    const fileName = path.split(/[/\\]/).pop();
    return `
      <div style="position: relative; display: inline-block; padding: 8px; background: #f3f4f6; border-radius: 6px; font-size: 10px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>📷 ${fileName.substring(0, 20)}${fileName.length > 20 ? '...' : ''}</span>
          <button type="button" onclick="removeCollateralImage(${index})" style="background: #ef4444; color: white; border: none; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 10px;">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

// Remove image from selection
function removeCollateralImage(index) {
  selectedCollateralImages.splice(index, 1);
  displayImagePreviews();
  toast('Image removed', 'info');
}

// Select document
async function selectCollateralDocument() {
  try {
    const result = await window.api.collateral.selectDocument();
    if (result.success && result.path) {
      selectedCollateralDocument = result.path;
      const fileName = result.path.split(/[/\\]/).pop();
      document.getElementById('document-preview').innerHTML = `<span style="color: #10b981;">📄 ${fileName}</span>`;
      toast('Document selected', 'ok');
    }
  } catch (e) {
    toast('Failed to select document', 'error');
  }
}

// Save loan with collateral
async function saveLoanWithCollateral() {
  const clientId = Number(document.getElementById('form-client')?.value);
  const amount = parseFloat(document.getElementById('form-amount')?.value || 0);
  const interest = parseFloat(document.getElementById('form-interest')?.value || 0);
  const loanDate = document.getElementById('form-loan-date')?.value;
  const dueDate = document.getElementById('form-due-date')?.value;
  const notes = document.getElementById('form-notes')?.value.trim();
  const hasCollateral = document.getElementById('form-has-collateral')?.checked;
  
  if (!clientId) { toast('Please select a client', 'error'); return; }
  if (amount <= 0) { toast('Please enter a valid loan amount', 'error'); return; }
  if (!loanDate) { toast('Please select a loan date', 'error'); return; }
  if (!dueDate) { toast('Please select a due date', 'error'); return; }
  
  try {
    // Create loan first
    const loanData = {
      clientId,
      amount,
      interest,
      loanDate,
      dueDate,
      notes,
      status: 'pending'
    };
    
    const loanResult = await window.api.loans.add(loanData);
    if (!loanResult.id) {
      toast('Failed to create loan', 'error');
      return;
    }
    
    // If collateral checkbox is checked, save collateral
    if (hasCollateral) {
      const itemType = document.getElementById('coll-item-type')?.value;
      const estimated = parseFloat(document.getElementById('coll-estimated')?.value || 0);
      const accepted = parseFloat(document.getElementById('coll-accepted')?.value || 0);
      const description = document.getElementById('coll-description')?.value.trim();
      const collNotes = document.getElementById('coll-notes')?.value.trim();
      const consent = document.getElementById('coll-consent')?.checked;
      const consentDate = document.getElementById('coll-consent-date')?.value;
      
      if (!itemType) {
        toast('Please select collateral item type', 'error');
        return;
      }
      if (estimated <= 0) {
        toast('Please enter collateral estimated value', 'error');
        return;
      }
      
      const collateralData = {
        clientId,
        loanId: loanResult.id,
        itemType,
        description,
        estimatedValue: estimated,
        acceptedValue: accepted || estimated,
        imagePaths: selectedCollateralImages,
        documentPath: selectedCollateralDocument,
        consentGiven: consent,
        consentDate,
        notes: collNotes
      };
      
      const collResult = await window.api.collateral.add(collateralData);
      if (!collResult.success) {
        toast('Loan created but collateral failed: ' + (collResult.error || 'Unknown error'), 'error');
      } else {
        toast('Loan created with collateral successfully!', 'ok');
      }
    } else {
      toast('Loan created successfully!', 'ok');
    }
    
    // Reset collateral state
    selectedCollateralImages = [];
    selectedCollateralDocument = null;
    
    closeModal();
    await loadData();
  } catch (e) {
    toast('Failed to save: ' + e.message, 'error');
  }
}
