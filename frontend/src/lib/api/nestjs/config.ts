import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PlatformConfig, ContentPage, FAQ } from '@/types/nestjs/api'

export const nestjsConfig = {
  getConfig: () =>
    nestjsClient.get<ApiResponse<PlatformConfig>>('/config'),

  getPage: (key: string) =>
    nestjsClient.get<ApiResponse<ContentPage>>(`/config/pages/${key}`),

  getFaqs: () =>
    nestjsClient.get<ApiResponse<FAQ[]>>('/config/faqs'),

  getLanguages: () =>
    nestjsClient.get<ApiResponse<{ code: string; name: string }[]>>('/translations/languages'),

  getTranslations: (locale: string) =>
    nestjsClient.get<ApiResponse<Record<string, string>>>(`/translations/${locale}`),
}
