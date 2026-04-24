
    // ===== ENHANCED COLLATERAL MANAGEMENT FUNCTIONS =====
    function showCollateralTab(tabName) {
      const tabs = ['inventory', 'analysis', 'reports', 'operations'];
      tabs.forEach(tab => {
        const el = document.getElementById(`collateral-${tab}-tab`);
        if (el) el.style.display = tab === tabName ? 'block' : 'none';
      });
      
      const buttons = document.querySelectorAll('[onclick*="showCollateralTab"]');
      buttons.forEach(btn => {
        const isActive = btn.textContent.includes(
          tabName === 'inventory' ? 'Inventory' : 
          tabName === 'analysis' ? 'Analysis' :
          tabName === 'reports' ? 'Reports' : 'Operations'
        );
        btn.style.color = isActive ? '#10b981' : '#6b7280';
        btn.style.borderBottom = isActive ? '2px solid #10b981' : 'none';
      });

      if (tabName === 'analysis') {
        loadCollateralAnalysis();
      } else if (tabName === 'reports') {
        generateCollateralReport();
      }
    }

    async function loadCollateralAnalysis() {
      try {
        const result = await window.api.collateral.generateReport();
        if (result.success) {
          const analysisDiv = document.getElementById('collateral-analysis-content');
          analysisDiv.innerHTML = result.items.map(item => `
            <div style="background:#0f1b2e; padding:16px; border-radius:8px; border-left:3px solid ${item.risk.riskLevel === 'Critical' ? '#dc2626' : item.risk.riskLevel === 'High' ? '#f59e0b' : '#10b981'};">
              <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:12px;">
                <div>
                  <div style="font-weight:600; color:#fff;">${item.itemType}</div>
                  <div style="font-size:12px; color:#9ca3af;">${item.description}</div>
                </div>
                <span style="background:${item.risk.riskLevel === 'Critical' ? '#7f1d1d' : item.risk.riskLevel === 'High' ? '#78350f' : '#064e3b'}; color:#fff; padding:4px 8px; border-radius:4px; font-size:11px;">${item.risk.riskLevel}</span>
              </div>
              
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; font-size:12px;">
                <div><span style="color:#9ca3af;">Estimated Value:</span> K${item.estimatedValue}</div>
                <div><span style="color:#9ca3af;">Accepted Value:</span> K${item.acceptedValue}</div>
                <div><span style="color:#9ca3af;">Depreciation:</span> ${item.depreciation.percentageDepreciated}%</div>
                <div><span style="color:#9ca3af;">Age:</span> ${item.depreciation.monthsHeld} months</div>
              </div>
              
              <div style="padding:8px; background:#1f2a44; border-radius:4px; font-size:11px; color:#cbd5e1; margin-bottom:8px;">
                <strong>Recommendation:</strong> ${item.risk.recommendation}
              </div>
              
              <button class="btn btn-small btn-primary" style="width:100%; font-size:11px;" onclick="viewCollateralDetails(${item.id})">View Details</button>
            </div>
          `).join('');
        }
      } catch (err) {
        console.error('loadCollateralAnalysis error:', err);
        toast('Failed to load analysis', 'error');
      }
    }

    async function generateCollateralReport() {
      try {
        const result = await window.api.collateral.generateReport();
        if (result.success) {
          const reportDiv = document.getElementById('collateral-report-content');
          reportDiv.innerHTML = `
            <div style="color:#e5e7eb;">
              <h4 style="color:#10b981; margin-top:0;">Summary Metrics</h4>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px; font-size:12px;">
                <div><span style="color:#9ca3af;">Total Items:</span> ${result.summary.totalItems}</div>
                <div><span style="color:#9ca3af;">Active Items:</span> ${result.summary.activeItems}</div>
                <div><span style="color:#9ca3af;">Forfeited Items:</span> ${result.summary.forfeitedItems}</div>
                <div><span style="color:#9ca3af;">Total Estimated Value:</span> K${result.summary.totalEstimatedValue.toFixed(0)}</div>
                <div><span style="color:#9ca3af;">Total Accepted Value:</span> K${result.summary.totalAcceptedValue.toFixed(0)}</div>
                <div><span style="color:#9ca3af;">Coverage Ratio:</span> ${result.summary.coverageRatio}%</div>
              </div>

              <h4 style="color:#10b981;">Breakdown by Type</h4>
              <div style="font-size:11px;">
                ${Object.entries(result.byType).map(([type, data]) => `
                  <div style="padding:8px; background:#1f2a44; margin-bottom:6px; border-radius:4px;">
                    <strong>${type}:</strong> ${data.count} items | Value: K${data.value.toFixed(0)} | Accepted: K${data.accepted.toFixed(0)}
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }
      } catch (err) {
        console.error('generateCollateralReport error:', err);
        toast('Failed to generate report', 'error');
      }
    }

    async function exportCollateralData(format) {
      try {
        toast('Exporting collateral data...', 'info');
        const result = await window.api.collateral.exportData(format);
        if (result.success) {
          toast(`Collateral data exported successfully`, 'success');
        } else {
          toast('Export failed: ' + result.error, 'error');
        }
      } catch (err) {
        console.error('exportCollateralData error:', err);
        toast('Export error: ' + err.message, 'error');
      }
    }

    async function executeBulkValuationUpdate() {
      try {
        const jsonText = document.getElementById('bulk-valuation-json').value;
        const updates = JSON.parse(jsonText);
        
        const result = await window.api.collateral.bulkUpdateValuations(updates);
        if (result.success) {
          toast(result.message, 'success');
          document.getElementById('bulk-valuation-json').value = '';
          await renderCollateral();
        } else {
          toast('Update failed: ' + result.error, 'error');
        }
      } catch (err) {
        console.error('executeBulkValuationUpdate error:', err);
        toast('Invalid JSON format or update failed', 'error');
      }
    }

    async function viewCollateralDetails(collateralId) {
      try {
        const result = await window.api.collateral.getWithDetails(collateralId);
        if (result.success) {
          const c = result.collateral;
          const msg = `
          Item: ${c.itemType}
          Description: ${c.description}
          
          Estimated Value: K${c.estimatedValue}
          Accepted Value: K${c.acceptedValue}
          Coverage: ${((c.acceptedValue / c.estimatedValue) * 100).toFixed(1)}%
          
          Depreciation: ${result.depreciation.percentageDepreciated}%
          Age: ${result.depreciation.monthsHeld} months
          
          Risk Level: ${result.risk.riskLevel}
          Risk Score: ${result.risk.riskScore}
          
          Recommendation: ${result.risk.recommendation}
          `;
          alert(msg);
        }
      } catch (err) {
        console.error('viewCollateralDetails error:', err);
        toast('Failed to load details', 'error');
      }
    }

    function toggleCollateralViewMode() {
      const cardsView = document.getElementById('collateral-cards-view');
      const tableView = document.getElementById('collateral-table');
      
      if (cardsView.style.display === 'none') {
        cardsView.style.display = 'grid';
        tableView.style.display = 'none';
      } else {
        cardsView.style.display = 'none';
        tableView.style.display = 'table';
      }
    }

    async function refreshCollateralData() {
      await renderCollateral();
      toast('Collateral data refreshed', 'success');
    }
