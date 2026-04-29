const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  app: {
    getVersion: () => ipcRenderer.invoke('get-app-version'),
    getPath: () => ipcRenderer.invoke('get-app-path'),
    restart: () => ipcRenderer.invoke('app:restart')
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  db: {
    health: () => ipcRenderer.invoke('db:health'),
    factoryReset: () => ipcRenderer.invoke('db:factoryReset')
  },
  export: {
    toPdf: (html, filename) => ipcRenderer.invoke('export-to-pdf', html, filename),
    savePdf: (base64, filename) => ipcRenderer.invoke('save-pdf', base64, filename),
    paymentReceipt: (paymentId, loanId, companyName, accent, title, footer, options = {}) => ipcRenderer.invoke('export:paymentReceipt', paymentId, loanId, companyName, accent, title, footer, options),
    loanAgreement: (loanId, companyName, accent, introText, footerText, options = {}) => ipcRenderer.invoke('export:loanAgreement', loanId, companyName, accent, introText, footerText, options),
    clientsCSV: () => ipcRenderer.invoke('export:clientsCSV'),
    loansCSV: () => ipcRenderer.invoke('export:loansCSV'),
    paymentsCSV: () => ipcRenderer.invoke('export:paymentsCSV'),
    comprehensiveReport: () => ipcRenderer.invoke('export:comprehensiveReport')
  },
  print: {
    html: (html, title) => ipcRenderer.invoke('print:html', html, title)
  },
  auth: {
    get: () => ipcRenderer.invoke('auth:get'),
    register: (payload) => ipcRenderer.invoke('auth:register', payload),
    login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    recover: (username, answer, newPassword) => ipcRenderer.invoke('auth:recover', username, answer, newPassword),
    changePassword: (username, currentPassword, newPassword) => ipcRenderer.invoke('auth:changePassword', username, currentPassword, newPassword),
    resetPassword: (username, newPassword) => ipcRenderer.invoke('auth:resetPassword', username, newPassword),
    getAllUsers: () => ipcRenderer.invoke('auth:getAllUsers'),
    updateUserRole: (userId, role, permissions) => ipcRenderer.invoke('auth:updateUserRole', userId, role, permissions),
    toggleUserStatus: (userId, isActive) => ipcRenderer.invoke('auth:toggleUserStatus', userId, isActive),
    deleteUser: (userId) => ipcRenderer.invoke('auth:deleteUser', userId),
    resetData: () => ipcRenderer.invoke('system:resetDevData')
  },
  clients: {
    get: () => ipcRenderer.invoke('clients:get'),
    getById: (id) => ipcRenderer.invoke('clients:getById', id),
    save: (payload) => ipcRenderer.invoke('clients:save', payload),
    delete: (id) => ipcRenderer.invoke('clients:delete', id),
    // Advanced client APIs
    search: (filters) => ipcRenderer.invoke('clients:search', filters),
    calculateRisk: (clientId) => ipcRenderer.invoke('clients:calculateRisk', clientId),
    getStats: (clientId) => ipcRenderer.invoke('clients:getStats', clientId),
    updateKYC: (clientId, kycData) => ipcRenderer.invoke('clients:updateKYC', clientId, kycData),
    updateBlacklist: (clientId, blacklistData) => ipcRenderer.invoke('clients:updateBlacklist', clientId, blacklistData)
  },
  loans: {
    get: () => ipcRenderer.invoke('loans:get'),
    getByClient: (clientId) => ipcRenderer.invoke('loans:getByClient', clientId),
    add: (payload) => ipcRenderer.invoke('loans:add', payload),
    save: (payload) => ipcRenderer.invoke('loans:save', payload),
    delete: (id) => ipcRenderer.invoke('loans:delete', id),
    getDetails: (loanId) => ipcRenderer.invoke('loans:getDetails', loanId),
    saveSignature: (loanId, signatureData) => ipcRenderer.invoke('loans:saveSignature', loanId, signatureData),
    getPaymentHistory: (loanId) => ipcRenderer.invoke('loans:getPaymentHistory', loanId),
    updateCollateralValue: (loanId, value) => ipcRenderer.invoke('loans:updateCollateralValue', loanId, value),
    // Loan Engine (v2.3.0)
    createWithSchedule: (loanData) => ipcRenderer.invoke('loans:createWithSchedule', loanData),
    getInstallments: (loanId) => ipcRenderer.invoke('loans:getInstallments', loanId),
    allocatePayment: (paymentData) => ipcRenderer.invoke('loans:allocatePayment', paymentData),
    recalculateStatus: (loanId) => ipcRenderer.invoke('loans:recalculateStatus', loanId),
    assessDefault: (loanId) => ipcRenderer.invoke('loans:assessDefault', loanId),
    syncClientData: (clientId) => ipcRenderer.invoke('loans:syncClientData', clientId),
    runBatchAssessment: () => ipcRenderer.invoke('loans:runBatchAssessment'),
    getSummary: (loanId) => ipcRenderer.invoke('loans:getSummary', loanId),
    getOverdueInstallments: () => ipcRenderer.invoke('loans:getOverdueInstallments'),
    getUpcomingInstallments: (daysAhead) => ipcRenderer.invoke('loans:getUpcomingInstallments', daysAhead),
    // Early Settlement (v2.3.1)
    getEarlySettlementAdvisory: (loanId) => ipcRenderer.invoke('loans:getEarlySettlementAdvisory', loanId),
    calculateEarlySettlement: (loanId) => ipcRenderer.invoke('loans:calculateEarlySettlement', loanId),
    applyEarlySettlement: (loanId, paymentAmount, notes) => ipcRenderer.invoke('loans:applyEarlySettlement', loanId, paymentAmount, notes),
    setEarlySettlementEnabled: (loanId, enabled, customRates) => ipcRenderer.invoke('loans:setEarlySettlementEnabled', loanId, enabled, customRates),
    getEarlySettlementReport: (startDate, endDate) => ipcRenderer.invoke('loans:getEarlySettlementReport', startDate, endDate),
    getDefaultEarlySettlementRates: () => ipcRenderer.invoke('loans:getDefaultEarlySettlementRates')
  },
  payments: {
    add: (payload) => ipcRenderer.invoke('payments:add', payload),
    addEnhanced: (payload) => ipcRenderer.invoke('payments:addEnhanced', payload),
    getByLoan: (loanId) => ipcRenderer.invoke('payments:getByLoan', loanId),
    getByClient: (clientId) => ipcRenderer.invoke('payments:getByClient', clientId),
    getAll: () => ipcRenderer.invoke('payments:getAll'),
    getEnhanced: (filters) => ipcRenderer.invoke('payments:getEnhanced', filters),
    update: (id, payload) => ipcRenderer.invoke('payments:update', id, payload),
    delete: (id) => ipcRenderer.invoke('payments:delete', id),
    reverse: (paymentId, reason, reversedBy) => ipcRenderer.invoke('payments:reverse', paymentId, reason, reversedBy),
    getById: (id) => ipcRenderer.invoke('payments:getById', id),
    generateReceipt: () => ipcRenderer.invoke('payments:generateReceipt'),
    // Analytics & Reporting
    getStats: (period) => ipcRenderer.invoke('payments:getStats', period),
    getProfitAnalysis: (startDate, endDate) => ipcRenderer.invoke('payments:getProfitAnalysis', startDate, endDate),
    getCollectionTrends: () => ipcRenderer.invoke('payments:getCollectionTrends'),
    getFinancialAdvisory: () => ipcRenderer.invoke('payments:getFinancialAdvisory'),
    getDailyReport: (date) => ipcRenderer.invoke('payments:getDailyReport', date),
    getChartData: (period, groupBy) => ipcRenderer.invoke('payments:getChartData', period, groupBy),
    // Payment Promises
    addPromise: (data) => ipcRenderer.invoke('payments:addPromise', data),
    getPromises: (filters) => ipcRenderer.invoke('payments:getPromises', filters),
    updatePromiseStatus: (id, status, paymentId) => ipcRenderer.invoke('payments:updatePromiseStatus', id, status, paymentId),
    getPipeline: (days) => ipcRenderer.invoke('payments:getPipeline', days)
  },
  penalties: {
    add: (payload) => ipcRenderer.invoke('penalties:add', payload),
    getByLoan: (loanId) => ipcRenderer.invoke('penalties:getByLoan', loanId),
    applyAuto: () => ipcRenderer.invoke('penalties:applyAuto'),
    getAll: () => ipcRenderer.invoke('penalties:getAll'),
    updateStatus: (id, status) => ipcRenderer.invoke('penalties:updateStatus', id, status),
    delete: (id) => ipcRenderer.invoke('penalties:delete', id)
  },
  collateral: {
    add: (data) => ipcRenderer.invoke('collateral:add', data),
    update: (id, data) => ipcRenderer.invoke('collateral:update', id, data),
    delete: (id) => ipcRenderer.invoke('collateral:delete', id),
    getByClient: (clientId) => ipcRenderer.invoke('collateral:getByClient', clientId),
    getByLoan: (loanId) => ipcRenderer.invoke('collateral:getByLoan', loanId),
    getAll: () => ipcRenderer.invoke('collateral:getAll'),
    forfeit: (id) => ipcRenderer.invoke('collateral:forfeit', id),
    selectImage: () => ipcRenderer.invoke('collateral:selectImage'),
    selectDocument: () => ipcRenderer.invoke('collateral:selectDocument'),
    // Advanced collateral functions
    getMetadata: (collateralId) => ipcRenderer.invoke('collateral:getMetadata', collateralId),
    getWithDetails: (collateralId) => ipcRenderer.invoke('collateral:getWithDetails', collateralId),
    generateReport: (filters) => ipcRenderer.invoke('collateral:generateReport', filters),
    bulkUpdateValuations: (updates) => ipcRenderer.invoke('collateral:bulkUpdateValuations', updates),
    exportData: (format) => ipcRenderer.invoke('collateral:exportData', format),
    getValuationHistory: (collateralId) => ipcRenderer.invoke('collateral:getValuationHistory', collateralId),
    calculateDepreciation: (collateralId) => ipcRenderer.invoke('collateral:calculateDepreciation', collateralId),
    assessRisk: (collateralId) => ipcRenderer.invoke('collateral:assessRisk', collateralId)
  },
  audit: {
    get: () => ipcRenderer.invoke('audit:get'),
    clear: () => ipcRenderer.invoke('audit:clear'),
    delete: (id) => ipcRenderer.invoke('audit:delete', id)
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    selectFile: () => ipcRenderer.invoke('settings:selectLogo'),
    reset: () => ipcRenderer.invoke('settings:reset')
  },
  clientDocuments: {
    add: (data) => ipcRenderer.invoke('clientDocuments:add', data),
    get: (clientId) => ipcRenderer.invoke('clientDocuments:get', clientId),
    delete: (id) => ipcRenderer.invoke('clientDocuments:delete', id),
    selectFile: () => ipcRenderer.invoke('clientDocuments:selectFile')
  },
  companyDocuments: {
    add: (data) => ipcRenderer.invoke('companyDocuments:add', data),
    get: () => ipcRenderer.invoke('companyDocuments:get'),
    delete: (id) => ipcRenderer.invoke('companyDocuments:delete', id),
    selectFile: () => ipcRenderer.invoke('companyDocuments:selectFile')
  },
  accounts: {
    add: (data) => ipcRenderer.invoke('accounts:add', data),
    getAll: () => ipcRenderer.invoke('accounts:getAll'),
    update: (id, data) => ipcRenderer.invoke('accounts:update', id, data),
    delete: (id) => ipcRenderer.invoke('accounts:delete', id),
    updateBalance: (accountId, amount, add) => ipcRenderer.invoke('accounts:updateBalance', accountId, amount, add)
  },
  transactions: {
    add: (data) => ipcRenderer.invoke('transactions:add', data),
    getAll: (limit) => ipcRenderer.invoke('transactions:getAll', limit),
    getByLoan: (loanId) => ipcRenderer.invoke('transactions:getByLoan', loanId)
  },
  backup: {
    create: (type) => ipcRenderer.invoke('backup:create', type),
    getAll: () => ipcRenderer.invoke('backup:getAll'),
    restore: (backupId) => ipcRenderer.invoke('backup:restore', backupId),
    deleteBackup: (backupId) => ipcRenderer.invoke('backup:deleteBackup', backupId),
    getSchedulingSettings: () => ipcRenderer.invoke('backup:getSchedulingSettings'),
    updateSchedulingSettings: (settings) => ipcRenderer.invoke('backup:updateSchedulingSettings', settings),
    getNextScheduledTime: () => ipcRenderer.invoke('backup:getNextScheduledTime')
  },
  balanceSheet: {
    generate: (period) => ipcRenderer.invoke('balanceSheet:generate', period),
    getAll: (limit) => ipcRenderer.invoke('balanceSheet:getAll', limit),
    delete: (id) => ipcRenderer.invoke('balanceSheet:delete', id)
  },
  license: {
    getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
    validate: (licenseKey) => ipcRenderer.invoke('license:validate', licenseKey),
    getStatus: () => ipcRenderer.invoke('license:getStatus'),
    generateTest: (days) => ipcRenderer.invoke('license:generateTest', days),
    getTier: () => ipcRenderer.invoke('license:getTier'),
    checkLimit: (entityType) => ipcRenderer.invoke('license:checkLimit', entityType),
    canUseFeature: (feature) => ipcRenderer.invoke('license:canUseFeature', feature)
  },
  system: {
    getDiagnostics: () => ipcRenderer.invoke('system:getDiagnostics'),
    getRecentLogs: (count, level) => ipcRenderer.invoke('system:getRecentLogs', count, level),
    generateSupportReport: () => ipcRenderer.invoke('system:generateSupportReport')
  },
  docs: {
    getContent: (filename) => ipcRenderer.invoke('docs:getContent', filename)
  },
  config: {
    getDataDirectory: () => ipcRenderer.invoke('config:getDataDirectory'),
    selectDataDirectory: () => ipcRenderer.invoke('config:selectDataDirectory'),
    hasCompletedSetup: () => ipcRenderer.invoke('config:hasCompletedSetup'),
    checkMigration: () => ipcRenderer.invoke('config:checkMigration'),
    migrateData: (fromDir, toDir) => ipcRenderer.invoke('config:migrateData', fromDir, toDir),
    completeSetup: () => ipcRenderer.invoke('config:completeSetup')
  },
  files: {
    selectCSV: () => ipcRenderer.invoke('files:selectCSV'),
    readAsBase64: (filePath) => ipcRenderer.invoke('files:readAsBase64', filePath),
    saveToClientFolder: (clientNumber, clientName, subfolder, filename, base64Data) => 
      ipcRenderer.invoke('files:saveToClientFolder', clientNumber, clientName, subfolder, filename, base64Data),
    openClientFolder: (clientNumber, clientName) => 
      ipcRenderer.invoke('files:openClientFolder', clientNumber, clientName),
    moveLoan: (clientNumber, clientName, loanNumber, fromStatus, toStatus) => 
      ipcRenderer.invoke('files:moveLoan', clientNumber, clientName, loanNumber, fromStatus, toStatus),
    uploadClientPhoto: (clientNumber, clientName) => 
      ipcRenderer.invoke('files:uploadClientPhoto', clientNumber, clientName),
    // File browser functions
    listClientFiles: (clientNumber, clientName, subfolder) => 
      ipcRenderer.invoke('files:listClientFiles', clientNumber, clientName, subfolder),
    getClientFolderOverview: (clientNumber, clientName) => 
      ipcRenderer.invoke('files:getClientFolderOverview', clientNumber, clientName),
    openPath: (filePath) => ipcRenderer.invoke('files:openPath', filePath),
    openWith: (filePath) => ipcRenderer.invoke('files:openWith', filePath)
  },
  migration: {
    analyzeDirectory: (dirPath) => ipcRenderer.invoke('migration:analyzeDirectory', dirPath),
    findCandidates: () => ipcRenderer.invoke('migration:findCandidates'),
    migrateData: (sourcePath, destinationPath) => ipcRenderer.invoke('migration:migrateData', sourcePath, destinationPath),
    getProgress: () => ipcRenderer.invoke('migration:getProgress'),
    verifyMigration: (sourcePath, destinationPath) => ipcRenderer.invoke('migration:verifyMigration', sourcePath, destinationPath),
    exportData: (exportPath, options) => ipcRenderer.invoke('migration:exportData', exportPath, options),
    importData: (importPath) => ipcRenderer.invoke('migration:importData', importPath)
  },
  // Expense tracker
  expenses: {
    add: (data) => ipcRenderer.invoke('expenses:add', data),
    update: (id, data) => ipcRenderer.invoke('expenses:update', id, data),
    delete: (id) => ipcRenderer.invoke('expenses:delete', id),
    get: (fromDate, toDate) => ipcRenderer.invoke('expenses:get', fromDate, toDate),
    selectReceipt: (expenseId) => ipcRenderer.invoke('expenses:selectReceipt', expenseId),
    selectFiles: (expenseId) => ipcRenderer.invoke('expenses:selectFiles', expenseId),
    addAttachment: (expenseId, fileName, filePath, fileType, fileSize, caption) => ipcRenderer.invoke('expenses:addAttachment', expenseId, fileName, filePath, fileType, fileSize, caption),
    getAttachments: (expenseId) => ipcRenderer.invoke('expenses:getAttachments', expenseId),
    getAttachmentCounts: () => ipcRenderer.invoke('expenses:getAttachmentCounts'),
    deleteAttachment: (id) => ipcRenderer.invoke('expenses:deleteAttachment', id),
    getWithAttachments: (expenseId) => ipcRenderer.invoke('expenses:getWithAttachments', expenseId),
    downloadAttachment: (filePath, suggestedName, autoDownload = false) => ipcRenderer.invoke('expenses:downloadAttachment', filePath, suggestedName, autoDownload),
  },
  // Loan templates
  loanTemplates: {
    get: () => ipcRenderer.invoke('loanTemplates:get'),
    save: (templates) => ipcRenderer.invoke('loanTemplates:save', templates),
  },
  // Loan meta (officer, guarantor, purpose, restructure)
  loanMeta: {
    update: (loanId, data) => ipcRenderer.invoke('loans:updateMeta', loanId, data),
  },
  // One-way typed IPC for setup lifecycle and system actions
  setup: {
    complete: () => ipcRenderer.send('setup:complete'),
    onShow: (callback) => ipcRenderer.on('setup:show', (_event) => callback()),
  },
  system: {
    openFolder: (folderPath) => ipcRenderer.send('system:openFolder', { path: folderPath }),
  },
});
