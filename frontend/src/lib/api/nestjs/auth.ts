import { nestjsClient } from '../nestjs-client'
import type { LoginResponse, OtpResponse, ApiResponse, NestjsUser } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsAuth = {
  // PHP uses platform-login for OTP-based auth
  sendOtp: (phone: string) =>
    nestjsClient.post<OtpResponse>('/auth/login', { phone, login_type: 'otp_login' }),

  verifyOtp: (phone: string, otp: string) =>
    nestjsClient.post<LoginResponse>('/auth/firebase-verify-token', { phone, otp }),

  register: (data: { f_name: string; l_name: string; email: string; phone: string }) =>
    nestjsClient.post<LoginResponse>('/auth/sign-up', data),

  vendorLogin: (email: string, password: string) =>
    nestjsClient.post<LoginResponse>('/auth/vendor/login', { email, password }),

  riderSendOtp: (phone: string) =>
    nestjsClient.post<OtpResponse>('/auth/delivery-man/login', { phone, login_type: 'otp_login' }),

  riderVerifyOtp: (phone: string, otp: string) =>
    nestjsClient.post<LoginResponse>('/auth/delivery-man/firebase-verify-token', { phone, otp }),

  getProfile: () =>
    nestjsClient.get<ApiResponse<NestjsUser>>('/customer/info'),

  updateProfile: (data: Partial<NestjsUser>) =>
    nestjsClient.post<ApiResponse<NestjsUser>>('/customer/update-profile', data),

  logout: () =>
    nestjsClient.post<ApiResponse<null>>('/auth/logout'),
}
