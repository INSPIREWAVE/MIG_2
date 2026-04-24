const fs = require('fs');
const path = require('path');
const db = require('./db');

/**
 * Collateral Manager
 * Handles enhanced collateral management including valuations, depreciation, and reports
 */
class CollateralManager {
  constructor() {
    this.valuationHistory = new Map();
    this.depreciationRates = {
      'Vehicle': 0.15, // 15% per year
      'Property': 0.02, // 2% per year (appreciation potential)
      'Jewelry': 0.05, // 5% per year
      'Electronics': 0.20, // 20% per year
      'Furniture': 0.10, // 10% per year
      'Equipment': 0.12, // 12% per year
      'Other': 0.08 // 8% per year
    };
  }

  /**
   * Get collateral metadata including valuation history
   */
  getCollateralMetadata(collateralId) {
    try {
      const allCollateral = db.getAllCollateral();
      const collateral = allCollateral.find(c => c.id === collateralId);
      
      if (!collateral) {
        return { success: false, error: 'Collateral not found' };
      }

      return {
        success: true,
        collateral,
        valuationHistory: this.getValuationHistory(collateralId),
        depreciation: this.calculateDepreciation(collateral),
        riskAssessment: this.assessCollateralRisk(collateral)
      };
    } catch (err) {
      console.error('getCollateralMetadata', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get valuation history for a collateral item
   */
  getValuationHistory(collateralId) {
    return {
      currentValue: this.valuationHistory.get(collateralId) || [],
      trends: this.calculateTrends(collateralId)
    };
  }

  /**
   * Calculate depreciation for collateral
   */
  calculateDepreciation(collateral) {
    const rate = this.depreciationRates[collateral.itemType] || 0.08;
    const monthsSinceCreation = this.getMonthsSince(collateral.created_at);
    const annualDepreciation = collateral.estimatedValue * rate;
    const totalDepreciation = (annualDepreciation / 12) * monthsSinceCreation;
    const currentEstimatedValue = Math.max(
      collateral.estimatedValue - totalDepreciation,
      collateral.estimatedValue * 0.1 // floor at 10% of original
    );

    return {
      itemType: collateral.itemType,
      originalValue: collateral.estimatedValue,
      currentEstimatedValue: currentEstimatedValue,
      depreciationRate: (rate * 100).toFixed(1),
      totalDepreciation: totalDepreciation.toFixed(2),
      monthsHeld: monthsSinceCreation,
      depreciationPerMonth: (annualDepreciation / 12).toFixed(2),
      percentageDepreciated: ((totalDepreciation / collateral.estimatedValue) * 100).toFixed(1)
    };
  }

  /**
   * Assess collateral risk level
   */
  assessCollateralRisk(collateral) {
    let riskScore = 0;
    let factors = [];

    // Value coverage ratio
    const coverage = (collateral.acceptedValue / collateral.estimatedValue) * 100;
    if (coverage < 50) {
      riskScore += 3;
      factors.push('Low acceptance ratio (<50%)');
    } else if (coverage < 75) {
      riskScore += 2;
      factors.push('Moderate acceptance ratio (50-75%)');
    } else {
      riskScore += 1;
      factors.push('Good acceptance ratio (>75%)');
    }

    // Item type risk
    const typeRiskMap = {
      'Vehicle': 2,
      'Property': 1,
      'Jewelry': 3,
      'Electronics': 4,
      'Furniture': 2,
      'Equipment': 2,
      'Other': 3
    };
    riskScore += typeRiskMap[collateral.itemType] || 3;

    // Depreciation risk
    const depreciation = this.calculateDepreciation(collateral);
    const depreciationPercent = parseFloat(depreciation.percentageDepreciated);
    if (depreciationPercent > 30) {
      riskScore += 2;
      factors.push('High depreciation (>30%)');
    } else if (depreciationPercent > 15) {
      riskScore += 1;
      factors.push('Moderate depreciation (15-30%)');
    }

    // Status risk
    if (collateral.status === 'forfeited') {
      riskScore += 5;
      factors.push('Collateral forfeited');
    }

    // Consent risk
    if (!collateral.consentGiven) {
      riskScore += 2;
      factors.push('No consent documentation');
    }

    let riskLevel = 'Low';
    if (riskScore >= 10) riskLevel = 'Critical';
    else if (riskScore >= 8) riskLevel = 'High';
    else if (riskScore >= 5) riskLevel = 'Medium';

    return {
      riskScore,
      riskLevel,
      factors,
      recommendation: this.getRiskRecommendation(riskLevel, factors)
    };
  }

  /**
   * Get recommendation based on risk
   */
  getRiskRecommendation(riskLevel, factors) {
    const recommendations = {
      'Low': 'Collateral is in good standing. Continue monitoring.',
      'Medium': 'Monitor depreciation and consider updating valuation periodically.',
      'High': 'Consider requesting additional collateral or adjusting terms.',
      'Critical': 'Urgent review required. Consider collateral liquidation or loan restructuring.'
    };
    return recommendations[riskLevel] || 'Review collateral status';
  }

  /**
   * Generate collateral report
   */
  generateCollateralReport(filters = {}) {
    try {
      const allCollateral = db.getAllCollateral();
      let filtered = allCollateral;

      // Apply filters
      if (filters.status) {
        filtered = filtered.filter(c => c.status === filters.status);
      }
      if (filters.itemType) {
        filtered = filtered.filter(c => c.itemType === filters.itemType);
      }
      if (filters.clientId) {
        filtered = filtered.filter(c => c.clientId === filters.clientId);
      }

      // Calculate metrics
      const totalEstimatedValue = filtered.reduce((sum, c) => sum + c.estimatedValue, 0);
      const totalAcceptedValue = filtered.reduce((sum, c) => sum + c.acceptedValue, 0);
      const coverageRatio = (totalAcceptedValue / totalEstimatedValue * 100).toFixed(1);
      
      const byType = {};
      filtered.forEach(c => {
        if (!byType[c.itemType]) {
          byType[c.itemType] = { count: 0, value: 0, accepted: 0 };
        }
        byType[c.itemType].count++;
        byType[c.itemType].value += c.estimatedValue;
        byType[c.itemType].accepted += c.acceptedValue;
      });

      const forfeited = filtered.filter(c => c.status === 'forfeited').length;
      const active = filtered.filter(c => c.status === 'active').length;

      return {
        success: true,
        summary: {
          totalItems: filtered.length,
          activeItems: active,
          forfeitedItems: forfeited,
          totalEstimatedValue,
          totalAcceptedValue,
          coverageRatio: parseFloat(coverageRatio),
          averageItemValue: (totalEstimatedValue / filtered.length).toFixed(2),
          averageAcceptedValue: (totalAcceptedValue / filtered.length).toFixed(2)
        },
        byType,
        items: filtered.map(c => ({
          ...c,
          depreciation: this.calculateDepreciation(c),
          risk: this.assessCollateralRisk(c)
        }))
      };
    } catch (err) {
      console.error('generateCollateralReport', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Bulk update collateral valuations
   */
  bulkUpdateValuations(updates) {
    try {
      const results = [];
      
      for (const update of updates) {
        const result = db.updateCollateral(update.id, {
          acceptedValue: update.newValue
        });
        
        results.push({
          id: update.id,
          success: result.success,
          newValue: update.newValue,
          oldValue: update.oldValue
        });

        if (result.success) {
          // Record in valuation history
          if (!this.valuationHistory.has(update.id)) {
            this.valuationHistory.set(update.id, []);
          }
          this.valuationHistory.get(update.id).push({
            timestamp: new Date().toISOString(),
            value: update.newValue,
            reason: update.reason || 'Manual update'
          });
        }
      }

      return {
        success: results.every(r => r.success),
        results,
        message: `Updated ${results.filter(r => r.success).length} of ${results.length} items`
      };
    } catch (err) {
      console.error('bulkUpdateValuations', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Calculate trends in collateral value
   */
  calculateTrends(collateralId) {
    const history = this.valuationHistory.get(collateralId) || [];
    if (history.length < 2) {
      return { trend: 'stable', change: 0 };
    }

    const oldest = history[0].value;
    const newest = history[history.length - 1].value;
    const change = newest - oldest;
    const percentChange = (change / oldest) * 100;

    let trend = 'stable';
    if (percentChange > 5) trend = 'increasing';
    else if (percentChange < -5) trend = 'decreasing';

    return {
      trend,
      change: change.toFixed(2),
      percentChange: percentChange.toFixed(1),
      timespan: this.calculateTimespan(history[0].timestamp, history[history.length - 1].timestamp),
      dataPoints: history.length
    };
  }

  /**
   * Get months since date
   */
  getMonthsSince(dateStr) {
    if (!dateStr) return 0;
    const date = new Date(dateStr);
    const now = new Date();
    return (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
  }

  /**
   * Calculate timespan between dates
   */
  calculateTimespan(startStr, endStr) {
    const start = new Date(startStr);
    const end = new Date(endStr);
    const days = Math.floor((end - start) / (1000 * 60 * 60 * 24));
    const months = Math.floor(days / 30);
    const years = Math.floor(months / 12);

    if (years > 0) return `${years}y ${months % 12}m`;
    if (months > 0) return `${months}m ${days % 30}d`;
    return `${days}d`;
  }

  /**
   * Export collateral data
   */
  exportCollateralData(format = 'json') {
    try {
      const report = this.generateCollateralReport();
      
      if (format === 'json') {
        return {
          success: true,
          data: JSON.stringify(report, null, 2),
          mimeType: 'application/json',
          filename: `collateral-report-${new Date().toISOString().split('T')[0]}.json`
        };
      } else if (format === 'csv') {
        let csv = 'ID,Client ID,Loan ID,Type,Description,Estimated Value,Accepted Value,Status,Risk Level,Depreciation %\n';
        report.items.forEach(item => {
          csv += `${item.id},${item.clientId},${item.loanId},"${item.itemType}","${item.description}",${item.estimatedValue},${item.acceptedValue},${item.status},${item.risk.riskLevel},${item.depreciation.percentageDepreciated}\n`;
        });
        return {
          success: true,
          data: csv,
          mimeType: 'text/csv',
          filename: `collateral-report-${new Date().toISOString().split('T')[0]}.csv`
        };
      }

      return { success: false, error: 'Unsupported format' };
    } catch (err) {
      console.error('exportCollateralData', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get collateral with detailed information
   */
  getCollateralWithDetails(collateralId) {
    try {
      const allCollateral = db.getAllCollateral();
      const collateral = allCollateral.find(c => c.id === collateralId);
      
      if (!collateral) {
        return { success: false, error: 'Collateral not found' };
      }

      const depreciation = this.calculateDepreciation(collateral);
      const risk = this.assessCollateralRisk(collateral);
      const trends = this.calculateTrends(collateralId);

      return {
        success: true,
        collateral,
        depreciation,
        risk,
        trends,
        valuationHistory: this.getValuationHistory(collateralId)
      };
    } catch (err) {
      console.error('getCollateralWithDetails', err);
      return { success: false, error: err.message };
    }
  }
}

module.exports = CollateralManager;
