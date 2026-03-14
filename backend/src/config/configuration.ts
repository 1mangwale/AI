export default () => ({
  app: {
    name: process.env.APP_NAME || 'Headless Mangwale',
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    testMode: process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1',
  },
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v24.0',
    get apiBaseUrl() {
      return `https://graph.facebook.com/${this.apiVersion}`;
    },
  },
  php: {
    baseUrl: process.env.PHP_API_BASE_URL || process.env.PHP_BACKEND_URL,
    timeout: parseInt(process.env.PHP_API_TIMEOUT, 10) || 30000,
    defaultModuleId: parseInt(process.env.DEFAULT_PARCEL_MODULE_ID, 10) || 3,
  },
  // MySQL - Laravel Backend Database (READ-ONLY for OTP verification)
  mysql: {
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USERNAME || process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  },
  // NLU Configuration - Local IndicBERT service (NO ADMIN BACKEND)
  nlu: {
    endpoint: process.env.NLU_ENDPOINT || 'http://nlu:7010',
    enabled: process.env.NLU_AI_ENABLED !== 'false', // enabled by default
    timeout: parseInt(process.env.NLU_TIMEOUT, 10) || 5000,
  },
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 1,
  },
  session: {
    ttl: parseInt(process.env.SESSION_TTL, 10) || 86400,
    otpTtl: parseInt(process.env.OTP_TTL, 10) || 600,
    otpLength: parseInt(process.env.OTP_LENGTH, 10) || 6,
  },
  messaging: {
    // If true, MessagingService will prefer the session's stored platform
    // over the explicitly provided platform when sending messages.
    // This enables channel-agnostic ConversationService flows.
    forceSessionPlatform: process.env.FORCE_SESSION_PLATFORM !== 'false',
  },
  tracking: {
    baseUrl: process.env.TRACKING_BASE_URL || 'https://track.mangwale.in',
  },
  storage: {
    cdnUrl: process.env.STORAGE_CDN_URL || 'https://chat.mangwale.ai/storage/mangwale/product',
    s3BaseUrl: process.env.S3_BASE_URL || 'https://mangwale.s3.ap-south-1.amazonaws.com/product',
  },
  geo: {
    defaultCity: process.env.DEFAULT_CITY || 'Nashik',
    defaultState: process.env.DEFAULT_STATE || 'Maharashtra',
    defaultLatitude: parseFloat(process.env.DEFAULT_LATITUDE) || 19.9975,
    defaultLongitude: parseFloat(process.env.DEFAULT_LONGITUDE) || 73.7898,
    fallbackZones: JSON.parse(process.env.FALLBACK_ZONES || '[{"name":"Nashik City","zoneId":4,"minLat":19.9,"maxLat":20.1,"minLng":73.6,"maxLng":73.9},{"name":"Pune City","zoneId":5,"minLat":18.4,"maxLat":18.7,"minLng":73.7,"maxLng":74.0},{"name":"Mumbai","zoneId":6,"minLat":18.87,"maxLat":19.3,"minLng":72.7,"maxLng":73.1}]'),
  },
  // Pricing config — VENDOR-SIDE only.
  // Consumer-facing prices (delivery fees, tax) come from PHP zone config + order placement.
  // These values are used by FeeCalculatorService for commission/settlement calculations.
  pricing: {
    platformFee: parseFloat(process.env.PLATFORM_FEE) || 5,
    // GST rates for vendor commission calculation (not consumer display)
    foodGstRate: parseFloat(process.env.FOOD_GST_RATE) || 0.05,
    parcelGstRate: parseFloat(process.env.PARCEL_GST_RATE) || 0.18,
    // Parcel pricing (used when PHP zone config has null parcel rates)
    parcelPerKmRate: parseFloat(process.env.PARCEL_PER_KM_RATE) || 11.11,
    parcelMinCharge: parseFloat(process.env.PARCEL_MIN_CHARGE) || 44,
    // Ecommerce free shipping threshold (promotional logic)
    ecomFreeShippingThreshold: parseFloat(process.env.ECOM_FREE_SHIPPING_THRESHOLD) || 500,
  },
  mlServices: {
    nerUrl: process.env.NER_SERVICE_URL || 'http://localhost:7011',
    nluUrl: process.env.NLU_SERVICE_URL || 'http://localhost:7012',
    searchUrl: process.env.SEARCH_SERVICE_URL || 'http://localhost:3100',
  },
  voice: {
    asrUrl: process.env.ASR_SERVICE_URL || 'http://localhost:7001',
    ttsUrl: process.env.TTS_SERVICE_URL || 'http://localhost:7002',
    orchestratorUrl: process.env.VOICE_ORCHESTRATOR_URL || 'http://localhost:7000',
  },
  cors: {
    additionalOrigins: process.env.ADDITIONAL_CORS_ORIGINS
      ? process.env.ADDITIONAL_CORS_ORIGINS.split(',').map(s => s.trim())
      : [],
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  training: {
    confidenceThresholds: {
      high: parseFloat(process.env.TRAINING_CONFIDENCE_HIGH) || 0.85,
      medium: parseFloat(process.env.TRAINING_CONFIDENCE_MEDIUM) || 0.70,
    },
    reviewPriorities: {
      high: parseInt(process.env.TRAINING_PRIORITY_HIGH, 10) || 2,
      medium: parseInt(process.env.TRAINING_PRIORITY_MEDIUM, 10) || 5,
      low: parseInt(process.env.TRAINING_PRIORITY_LOW, 10) || 10,
    },
    defaultQualityScore: parseFloat(process.env.TRAINING_DEFAULT_QUALITY_SCORE) || 0.9,
  },
});

