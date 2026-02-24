// API Client for Admin Backend

import { useAdminAuthStore } from '@/store/adminAuthStore'
import type {
  Agent,
  NLUClassification,
  Dataset,
  TrainingExample,
  TrainingJob,
  Model,
  Flow,
  Metrics,
  AuditLog,
} from '@/types/admin'

const ADMIN_BACKEND_URL = process.env.NEXT_PUBLIC_ADMIN_BACKEND_URL || '/api'

interface CreateAgentData {
  name: string
  module: string
  description?: string
  systemPrompt?: string
  capabilities?: string[]
}

type UpdateAgentData = Partial<CreateAgentData>;

interface CreateDatasetData {
  name: string
  module: string
  description?: string
}

interface TrainingConfig {
  datasetId: string
  modelType?: string
  epochs?: number
  batchSize?: number
  learningRate?: number
}

interface CreateFlowData {
  name: string
  module: string
  trigger: string
  steps: unknown[]
}

interface AuditLogFilters {
  action?: string
  module?: string
  userId?: string
  startDate?: string
  endDate?: string
}

interface AgentExecuteContext {
  sessionId?: string
  userId?: string
  module?: string
  [key: string]: unknown
}

class AdminBackendClient {
  private baseUrl: string

  constructor() {
    this.baseUrl = ADMIN_BACKEND_URL
  }

  private getAuthHeaders(): Record<string, string> {
    const token = useAdminAuthStore.getState().token
    if (token) {
      return { 'Authorization': `Bearer ${token}` }
    }
    return {}
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...(options.headers as Record<string, string>),
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    })

    if (response.status === 401) {
      useAdminAuthStore.getState().clearAuth()
      if (typeof window !== 'undefined') {
        window.location.href = '/admin/login'
      }
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message || `API Error: ${response.statusText}`)
    }

    return response.json()
  }

  // ==========================================
  // Admin Auth (no JWT required for login/forgot-password)
  // ==========================================

  async login(email: string, password: string): Promise<{ success: boolean; token?: string; user?: Record<string, unknown>; message?: string }> {
    const url = `${this.baseUrl}/admin/auth/login`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    })
    return response.json()
  }

  async forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/admin/auth/forgot-password`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include',
    })
    return response.json()
  }

  async verifyOtp(email: string, otp: string): Promise<{ success: boolean; resetToken?: string; message: string }> {
    const url = `${this.baseUrl}/admin/auth/verify-otp`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp }),
      credentials: 'include',
    })
    return response.json()
  }

  async resetPassword(resetToken: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/admin/auth/reset-password`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken, newPassword }),
      credentials: 'include',
    })
    return response.json()
  }

  async logout(): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/admin/auth/logout`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
    return response.json()
  }

  async getProfile(): Promise<{ success: boolean; user: Record<string, unknown> }> {
    return this.request('/admin/auth/profile')
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    return this.request('/admin/auth/change-password', {
      method: 'PUT',
      body: JSON.stringify({ oldPassword, newPassword }),
    })
  }

  // ==========================================
  // Admin User Management
  // ==========================================

  async listAdminUsers(): Promise<{ success: boolean; users: Record<string, unknown>[] }> {
    return this.request('/admin/users')
  }

  async createAdminUser(data: { email: string; password: string; name: string; role: string }): Promise<{ success: boolean; user?: Record<string, unknown>; message?: string }> {
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateAdminRole(adminId: string, role: string): Promise<{ success: boolean; message?: string }> {
    return this.request(`/admin/users/${adminId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    })
  }

  async deactivateAdmin(adminId: string): Promise<{ success: boolean; message?: string }> {
    return this.request(`/admin/users/${adminId}/deactivate`, {
      method: 'PUT',
    })
  }

  async getActivityLog(filters?: { action?: string; limit?: number; offset?: number }): Promise<{ success: boolean; logs: Record<string, unknown>[]; total: number }> {
    const params = new URLSearchParams()
    if (filters?.action) params.set('action', filters.action)
    if (filters?.limit) params.set('limit', String(filters.limit))
    if (filters?.offset) params.set('offset', String(filters.offset))
    return this.request(`/admin/users/activity?${params}`)
  }

  // ==========================================
  // NLU Classification
  // ==========================================

  async classifyIntent(text: string, context?: Record<string, unknown>): Promise<NLUClassification> {
    return this.request<NLUClassification>('/nlu/classify', {
      method: 'POST',
      body: JSON.stringify({ text, context }),
    })
  }

  // Agent Management
  async getAgents(): Promise<Agent[]> {
    return this.request<Agent[]>('/agents')
  }

  async getAgent(id: string): Promise<Agent> {
    return this.request<Agent>(`/agents/${id}`)
  }

  async createAgent(data: CreateAgentData): Promise<Agent> {
    return this.request<Agent>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateAgent(id: string, data: UpdateAgentData): Promise<Agent> {
    return this.request<Agent>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async executeAgent(agentId: string, message: string, context: AgentExecuteContext): Promise<unknown> {
    return this.request<unknown>('/agent-execute', {
      method: 'POST',
      body: JSON.stringify({ agentId, message, context }),
    })
  }

  // Training
  async getDatasets(): Promise<Dataset[]> {
    return this.request<Dataset[]>('/training/datasets')
  }

  async createDataset(data: CreateDatasetData): Promise<Dataset> {
    return this.request<Dataset>('/training/datasets', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async addExamples(datasetId: string, examples: TrainingExample[]): Promise<void> {
    await this.request<void>(`/training/datasets/${datasetId}/examples/bulk`, {
      method: 'POST',
      body: JSON.stringify({ examples }),
    })
  }

  async startTrainingJob(data: TrainingConfig): Promise<TrainingJob> {
    return this.request<TrainingJob>('/training/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async getTrainingJob(jobId: string): Promise<TrainingJob> {
    return this.request<TrainingJob>(`/training/jobs/${jobId}`)
  }

  async getTrainingJobs(): Promise<TrainingJob[]> {
    return this.request<TrainingJob[]>('/training/jobs')
  }

  async pauseTrainingJob(jobId: string): Promise<TrainingJob> {
    return this.request<TrainingJob>(`/training/jobs/${jobId}/pause`, {
      method: 'POST',
    })
  }

  async stopTrainingJob(jobId: string): Promise<TrainingJob> {
    return this.request<TrainingJob>(`/training/jobs/${jobId}/stop`, {
      method: 'POST',
    })
  }

  async getDataset(datasetId: string): Promise<Dataset> {
    return this.request<Dataset>(`/training/datasets/${datasetId}`)
  }

  async getDatasetExamples(datasetId: string): Promise<TrainingExample[]> {
    return this.request<TrainingExample[]>(`/training/datasets/${datasetId}/examples`)
  }

  async deleteDataset(datasetId: string): Promise<void> {
    await this.request<void>(`/training/datasets/${datasetId}`, {
      method: 'DELETE',
    })
  }

  // Label Studio Integration
  async pushToLabelStudio(datasetId: string): Promise<{ projectId: number; pushed: number }> {
    return this.request<{ projectId: number; pushed: number }>(`/training/datasets/${datasetId}/push-labelstudio`, {
      method: 'POST',
    })
  }

  async pullFromLabelStudio(datasetId: string): Promise<{ imported: number }> {
    return this.request<{ imported: number }>(`/training/datasets/${datasetId}/pull-labelstudio`, {
      method: 'POST',
    })
  }

  async syncLabelStudio(projectId?: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/training/labelstudio/sync', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    })
  }

  async testLabelStudioConnection(): Promise<{ ok: boolean; projectsCount?: number }> {
    return this.request<{ ok: boolean; projectsCount?: number }>('/settings/labelstudio/test')
  }

  async testAsrConnection(): Promise<{ ok: boolean; message?: string }> {
    return this.request<{ ok: boolean; message?: string }>('/settings/asr/test')
  }

  async testTtsConnection(): Promise<{ ok: boolean; message?: string }> {
    return this.request<{ ok: boolean; message?: string }>('/settings/tts/test')
  }

  async testMinioConnection(): Promise<{ ok: boolean; message?: string }> {
    return this.request<{ ok: boolean; message?: string }>('/settings/minio/test')
  }

  // System Settings
  async getSettings(): Promise<Array<{ key: string; value: string; isSecret: boolean; source: string }>> {
    return this.request<Array<{ key: string; value: string; isSecret: boolean; source: string }>>('/settings')
  }

  async updateSettings(settings: Array<{ key: string; value: string }>): Promise<Array<{ key: string; success: boolean; error?: string }>> {
    return this.request<Array<{ key: string; success: boolean; error?: string }>>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    })
  }

  async uploadDataset(file: File, metadata: { name: string; type: string; module: string }): Promise<Dataset> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('name', metadata.name)
    formData.append('type', metadata.type)
    formData.append('module', metadata.module)

    const url = `${this.baseUrl}/training/datasets/upload`
    const headers: Record<string, string> = { ...this.getAuthHeaders() }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    })

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`)
    }

    return response.json()
  }

  // Models
  async getModels(): Promise<Model[]> {
    return this.request<Model[]>('/models')
  }

  async createModel(data: Partial<Model>): Promise<Model> {
    return this.request<Model>('/models', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  // Flows
  async getFlows(): Promise<Flow[]> {
    return this.request<Flow[]>('/flows')
  }

  async createFlow(data: CreateFlowData): Promise<Flow> {
    return this.request<Flow>('/flows', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  // Metrics
  async getMetrics(): Promise<Metrics> {
    return this.request<Metrics>('/metrics')
  }

  // Audit Logs
  async getAuditLogs(filters?: AuditLogFilters): Promise<AuditLog[]> {
    const params = new URLSearchParams(filters as Record<string, string>)
    return this.request<AuditLog[]>(`/audits?${params}`)
  }

  // ==========================================
  // Learning / NLU Admin
  // ==========================================

  async getLearningStats(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/stats')
  }

  async getPendingReviews(priority?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (priority) params.set('priority', priority)
    return this.request(`/admin/learning/pending?${params}`)
  }

  async approveTraining(id: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/learning/${id}/approve`, { method: 'POST' })
  }

  async rejectTraining(id: string, reason?: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/learning/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
  }

  async getLearningIntents(): Promise<string[]> {
    return this.request('/admin/learning/intents')
  }

  async checkRetraining(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/check-retraining')
  }

  async exportTrainingData(format?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (format) params.set('format', format)
    return this.request(`/admin/learning/export?${params}`)
  }

  async getAutoApprovalStats(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/auto-approval-stats')
  }

  async getMistakePatterns(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/mistakes')
  }

  async triggerRetraining(config?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/trigger-retraining', {
      method: 'POST',
      body: JSON.stringify(config || {}),
    })
  }

  async getTrainingServerStatus(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/training-status')
  }

  async getTrainingJobStatus(jobId: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/learning/training-job/${jobId}`)
  }

  async getAvailableModels(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/available-models')
  }

  async getTrainingHistory(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/training-history')
  }

  async getNluHealth(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/nlu-health')
  }

  async deployModel(config: { modelName: string; target?: string }): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/deploy-model', {
      method: 'POST',
      body: JSON.stringify(config),
    })
  }

  async getTrainingDataFiles(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/training-data-files')
  }

  async exportTrainingDataToServer(): Promise<Record<string, unknown>> {
    return this.request('/admin/learning/export-training-data', { method: 'POST' })
  }

  // ==========================================
  // Configuration Admin
  // ==========================================

  async getConfigs(): Promise<Record<string, unknown>> {
    return this.request('/admin/config')
  }

  async getConfigCategory(category: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/config/category/${category}`)
  }

  async getConfig(key: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/config/${key}`)
  }

  async updateConfig(key: string, value: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/config/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  }

  async createConfig(data: { key: string; value: string; category?: string; description?: string }): Promise<Record<string, unknown>> {
    return this.request('/admin/config', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async deleteConfig(key: string): Promise<void> {
    await this.request(`/admin/config/${key}`, { method: 'DELETE' })
  }

  async refreshConfigCache(): Promise<Record<string, unknown>> {
    return this.request('/admin/config/refresh', { method: 'POST' })
  }

  async getConfigCategories(): Promise<string[]> {
    return this.request('/admin/config/meta/categories')
  }

  async bulkUpdateConfigs(configs: Array<{ key: string; value: string }>): Promise<Record<string, unknown>> {
    return this.request('/admin/config/bulk', {
      method: 'POST',
      body: JSON.stringify({ configs }),
    })
  }

  // ==========================================
  // Data Sources Admin
  // ==========================================

  async getDataSources(active?: boolean): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (active !== undefined) params.set('active', String(active))
    return this.request(`/admin/data-sources?${params}`)
  }

  async getDataSource(id: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/${id}`)
  }

  async createDataSource(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/admin/data-sources', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateDataSource(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteDataSource(id: string): Promise<void> {
    await this.request(`/admin/data-sources/${id}`, { method: 'DELETE' })
  }

  async toggleDataSource(id: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/${id}/toggle`, { method: 'POST' })
  }

  async testDataSource(id: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/${id}/test`, { method: 'POST' })
  }

  async fetchDataSourceData(id: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/${id}/fetch`, { method: 'POST' })
  }

  async getDataSourcesForAgent(agentType: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/for-agent/${agentType}`)
  }

  async getDataSourcesForIntent(intent: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/data-sources/for-intent/${intent}`)
  }

  async exportDataSources(): Promise<Record<string, unknown>> {
    return this.request('/admin/data-sources/export', { method: 'POST' })
  }

  // ==========================================
  // Search Analytics Admin
  // ==========================================

  async getSearchDashboard(days?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    return this.request(`/admin/search/analytics/dashboard?${params}`)
  }

  async getTopQueries(days?: number, limit?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (limit) params.set('limit', String(limit))
    return this.request(`/admin/search/analytics/top-queries?${params}`)
  }

  async getZeroResultQueries(days?: number, limit?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (limit) params.set('limit', String(limit))
    return this.request(`/admin/search/analytics/zero-results?${params}`)
  }

  async getSearchVolume(days?: number, granularity?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (granularity) params.set('granularity', granularity)
    return this.request(`/admin/search/analytics/volume?${params}`)
  }

  async getSearchTypes(days?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    return this.request(`/admin/search/analytics/types?${params}`)
  }

  async getSearchPerformance(days?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    return this.request(`/admin/search/analytics/performance?${params}`)
  }

  async getUserSearchPatterns(days?: number, limit?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (limit) params.set('limit', String(limit))
    return this.request(`/admin/search/analytics/user-patterns?${params}`)
  }

  async getSearchRefinements(days?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    return this.request(`/admin/search/analytics/refinements?${params}`)
  }

  async exportSearchLogs(config?: { days?: number; format?: string; limit?: number }): Promise<Record<string, unknown>> {
    return this.request('/admin/search/analytics/export', {
      method: 'POST',
      body: JSON.stringify(config || {}),
    })
  }

  async getSearchChannels(days?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    return this.request(`/admin/search/analytics/channels?${params}`)
  }

  async getTopQueriesByChannel(days?: number, platform?: string, limit?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (platform) params.set('platform', platform)
    if (limit) params.set('limit', String(limit))
    return this.request(`/admin/search/analytics/top-queries-by-channel?${params}`)
  }

  async getSearchTrending(days?: number, moduleId?: number): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (moduleId) params.set('module_id', String(moduleId))
    return this.request(`/admin/search/analytics/trending?${params}`)
  }

  async getSearchVolumeByChannel(days?: number, granularity?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (days) params.set('days', String(days))
    if (granularity) params.set('granularity', granularity)
    return this.request(`/admin/search/analytics/volume-by-channel?${params}`)
  }

  // ==========================================
  // Scraper Admin
  // ==========================================

  async getScraperStats(): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/stats')
  }

  async getScraperJobs(filters?: { status?: string; limit?: number; offset?: number }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (filters?.status) params.set('status', filters.status)
    if (filters?.limit) params.set('limit', String(filters.limit))
    if (filters?.offset) params.set('offset', String(filters.offset))
    return this.request(`/admin/scraper/jobs?${params}`)
  }

  async createScraperJob(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async getScraperMappings(): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/mappings')
  }

  async matchStore(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/match-store', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async getPricingComparison(): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/pricing')
  }

  async comparePricing(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/compare-pricing', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async triggerBulkScrape(): Promise<Record<string, unknown>> {
    return this.request('/admin/scraper/bulk-scrape', { method: 'POST' })
  }

  // ==========================================
  // Profiles Admin
  // ==========================================

  async syncStore(phpStoreId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/stores/sync/${phpStoreId}`, { method: 'POST' })
  }

  async getStoreProfile(phpStoreId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/stores/${phpStoreId}`)
  }

  async getStorePrices(phpStoreId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/stores/${phpStoreId}/prices`)
  }

  async scrapeStore(phpStoreId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/stores/${phpStoreId}/scrape`, { method: 'POST' })
  }

  async batchSyncStores(storeIds: string[]): Promise<Record<string, unknown>> {
    return this.request('/profiles/stores/batch-sync', {
      method: 'POST',
      body: JSON.stringify({ storeIds }),
    })
  }

  async getVendorProfile(phpVendorId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/vendors/${phpVendorId}`)
  }

  async getVendorPerformance(phpVendorId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/vendors/${phpVendorId}/performance`)
  }

  async getRiderProfile(phpRiderId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/riders/${phpRiderId}`)
  }

  async getRiderPerformance(phpRiderId: string): Promise<Record<string, unknown>> {
    return this.request(`/profiles/riders/${phpRiderId}/performance`)
  }

  async getTopPerformerRiders(metric?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (metric) params.set('metric', metric)
    return this.request(`/profiles/riders/top-performers?${params}`)
  }

  // ==========================================
  // RAG Documents
  // ==========================================

  async getRagStats(): Promise<Record<string, unknown>> {
    return this.request('/rag/documents/stats')
  }

  async ingestText(data: { title: string; content: string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.request('/rag/documents/ingest/text', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async uploadRagDocument(file: File): Promise<Record<string, unknown>> {
    const formData = new FormData()
    formData.append('file', file)

    const url = `${this.baseUrl}/rag/documents/upload`
    const headers: Record<string, string> = { ...this.getAuthHeaders() }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    })

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`)
    }

    return response.json()
  }

  async searchRagDocuments(query: string, limit?: number): Promise<Record<string, unknown>> {
    return this.request('/rag/documents/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    })
  }

  async deleteRagDocument(documentId: string): Promise<void> {
    await this.request(`/rag/documents/${documentId}`, { method: 'DELETE' })
  }

  async ingestUrl(url: string): Promise<Record<string, unknown>> {
    return this.request('/rag/documents/ingest/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  }

  // ==========================================
  // White-Label / Tenants
  // ==========================================

  async getTenantBranding(tenantId: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/white-label/${tenantId}`)
  }

  async updateTenantBranding(tenantId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/admin/white-label/${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async updateTenantColors(tenantId: string, colors: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request(`/admin/white-label/${tenantId}/colors`, {
      method: 'PUT',
      body: JSON.stringify(colors),
    })
  }

  async getTenantEmbedCode(tenantId: string): Promise<Record<string, unknown>> {
    return this.request(`/admin/white-label/${tenantId}/embed-code`)
  }

  // ==========================================
  // System Health
  // ==========================================

  async getSystemHealth(): Promise<Record<string, unknown>> {
    return this.request('/health')
  }

  // ==========================================
  // Flows (extended)
  // ==========================================

  async getFlow(id: string): Promise<Flow> {
    return this.request<Flow>(`/flows/${id}`)
  }

  async updateFlow(id: string, data: Partial<CreateFlowData>): Promise<Flow> {
    return this.request<Flow>(`/flows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteFlow(id: string): Promise<void> {
    await this.request(`/flows/${id}`, { method: 'DELETE' })
  }

  async toggleFlow(id: string): Promise<Record<string, unknown>> {
    return this.request(`/flows/${id}/toggle`, { method: 'PATCH' })
  }

  async getFlowStats(id: string): Promise<Record<string, unknown>> {
    return this.request(`/flows/${id}/stats`)
  }

  async getFlowTemplates(): Promise<Record<string, unknown>[]> {
    return this.request('/flows/templates')
  }

  // ==========================================
  // Agent Settings
  // ==========================================

  async getAgentSettings(): Promise<Record<string, unknown>> {
    return this.request('/settings/agent')
  }

  async updateAgentSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/settings/agent', {
      method: 'POST',
      body: JSON.stringify(settings),
    })
  }

  // ==========================================
  // Voice / Mercury
  // ==========================================

  async getMercuryStatus(): Promise<Record<string, unknown>> {
    return this.request('/voice/mercury/status')
  }

  async getMercuryVoices(): Promise<Record<string, unknown>> {
    return this.request('/voice/mercury/voices')
  }

  async generateTts(data: { text: string; voice: string; language: string; emotion?: string; style?: string; speed?: number; provider?: string; exaggeration?: number; cfg_weight?: number; pitch?: number }): Promise<Record<string, unknown>> {
    return this.request('/voice/mercury/tts', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async transcribeAudio(formData: FormData): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/asr/transcribe`
    const headers: Record<string, string> = { ...this.getAuthHeaders() }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    })

    if (response.status === 401) {
      useAdminAuthStore.getState().clearAuth()
      if (typeof window !== 'undefined') {
        window.location.href = '/admin/login'
      }
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.statusText}`)
    }
    return response.json()
  }

  // ==========================================
  // Channels
  // ==========================================

  async getChannels(): Promise<Record<string, unknown>> {
    return this.request('/channels')
  }

  async testChannel(channelId: string, platform: string): Promise<Record<string, unknown>> {
    return this.request('/channels/test', {
      method: 'POST',
      body: JSON.stringify({ channelId, platform }),
    })
  }

  async getExotelHealth(): Promise<Record<string, unknown>> {
    return this.request('/exotel/health')
  }
}

export const adminBackendClient = new AdminBackendClient()
