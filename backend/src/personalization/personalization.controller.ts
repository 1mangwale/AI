import { Controller, Get, Post, Body, Query, Logger, HttpCode, Optional } from '@nestjs/common';
import { ApiOperation, ApiQuery } from '@nestjs/swagger';
import { UserProfilingService } from './user-profiling.service';
import { ConversationAnalyzerService } from './conversation-analyzer.service';
import { PrismaService } from '../database/prisma.service';
import { CollectionsService } from './collections.service';
import { PhpWishlistService } from '../php-integration/services/php-wishlist.service';
import { SessionService } from '../session/session.service';
import { ProfileContextBuilderService } from './profile-context-builder.service';
import { ProfileEnrichmentScheduler } from './profile-enrichment-scheduler.service';

/**
 * Personalization API Controller
 * 
 * Exposes endpoints for Search API and admin dashboard to:
 * 1. Get personalization boosts for search results
 * 2. Track user interactions (clicks, orders, favorites)
 * 3. Manually trigger profile analysis
 * 4. Get user profile summary
 */
@Controller('personalization')
export class PersonalizationController {
  private readonly logger = new Logger(PersonalizationController.name);

  constructor(
    private readonly userProfilingService: UserProfilingService,
    private readonly conversationAnalyzerService: ConversationAnalyzerService,
    private readonly prisma: PrismaService,
    private readonly collectionsService: CollectionsService,
    private readonly phpWishlistService: PhpWishlistService,
    private readonly sessionService: SessionService,
    @Optional() private readonly profileContextBuilder?: ProfileContextBuilderService,
    @Optional() private readonly enrichmentScheduler?: ProfileEnrichmentScheduler,
  ) {}

  /**
   * Get Personalization Boosts
   * 
   * Called by Search API to get user-specific boosting rules
   * 
   * GET /personalization/boosts?userId=123&module=food
   * 
   * Returns:
   * {
   *   userId: 123,
   *   module: 'food',
   *   filters: {
   *     veg: true,
   *     dietary_restrictions: ['no_onion', 'no_garlic']
   *   },
   *   boosts: {
   *     favoriteItems: [101, 202], // 3x boost
   *     favoriteCategories: [5], // 2x boost
   *     favoriteStores: [42] // 2.5x boost
   *   }
   * }
   */
  @Get('boosts')
  async getPersonalizationBoosts(
    @Query('userId') userId: string,
    @Query('module') module: string = 'food',
  ) {
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId)) {
      return { error: 'Invalid userId' };
    }

    try {
      const boosts = await this.userProfilingService.getPersonalizationBoosts(
        parsedUserId,
        module,
      );

      // Enrich with profile context search boosts when available
      let profileBoosts: any = null;
      if (this.profileContextBuilder) {
        try {
          // Look up phone from user_profiles for the profile context
          const profile = await this.prisma.$queryRawUnsafe(
            `SELECT phone FROM user_profiles WHERE user_id = $1 LIMIT 1`,
            parsedUserId,
          ) as any[];
          const phone = profile?.[0]?.phone || '';
          if (phone) {
            profileBoosts = await this.profileContextBuilder.getSearchBoosts(parsedUserId, phone);
          }
        } catch (err) {
          this.logger.debug(`Profile context boosts unavailable: ${err.message}`);
        }
      }

      return {
        userId: parsedUserId,
        module,
        ...boosts,
        // Merge dietary-aware boosts from ProfileContext
        ...(profileBoosts ? {
          profileBoosts: {
            boostVeg: profileBoosts.boostVeg,
            boostCuisines: profileBoosts.boostCuisines,
            priceRange: profileBoosts.priceRange,
            favoriteStores: profileBoosts.favoriteStores,
          },
        } : {}),
      };
    } catch (error) {
      this.logger.error(`Failed to get boosts for user ${userId}:`, error);

      // Return empty boosts on error (graceful degradation)
      return {
        userId: parsedUserId,
        module,
        filters: {},
        boosts: {
          favoriteItems: [],
          favoriteCategories: [],
          favoriteStores: [],
        },
      };
    }
  }

  /**
   * Get Personalized Collections
   *
   * Returns up to 4 smart home-screen tiles personalised for the given user.
   * Tiles are derived from order history, favourite stores, and current time.
   *
   * GET /personalization/collections?user_id=123&lat=21.1&lng=79.0
   */
  @Get('collections')
  @ApiOperation({ summary: 'Get personalized food collections for current user' })
  @ApiQuery({ name: 'user_id', required: true })
  @ApiQuery({ name: 'lat', required: false })
  @ApiQuery({ name: 'lng', required: false })
  async getCollections(
    @Query('user_id') userId: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ) {
    if (!userId || isNaN(Number(userId))) {
      return { collections: [] };
    }
    const collections = await this.collectionsService.generateCollections(Number(userId), {
      lat: lat ? parseFloat(lat) : undefined,
      lng: lng ? parseFloat(lng) : undefined,
    });
    return { collections, timestamp: new Date().toISOString() };
  }

  /**
   * Track Search Pattern
   *
   * Called by Search API after each search to track behavior
   * 
   * POST /personalization/track/search
   * {
   *   "userId": 123,
   *   "query": "biryani",
   *   "filters": {"veg": true},
   *   "results": [101, 202, 303]
   * }
   */
  @Post('track/search')
  async trackSearch(
    @Body() body: {
      userId: number;
      query: string;
      filters?: any;
      results?: any[];
    },
  ) {
    try {
      await this.userProfilingService.trackSearch({
        userId: body.userId,
        query: body.query,
        module: 'search',
        converted: body.results && body.results.length > 0,
      });

      return { success: true };
    } catch (error) {
      this.logger.error('Failed to track search:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Track User Interaction
   * 
   * Called when user clicks, views, orders, or favorites an item
   * 
   * POST /personalization/track/interaction
   * {
   *   "userId": 123,
   *   "itemId": 101,
   *   "type": "order",
   *   "metadata": {"amount": 250}
   * }
   */
  @Post('track/interaction')
  async trackInteraction(
    @Body() body: {
      userId: number;
      itemId: number;
      type: 'click' | 'view' | 'order' | 'favorite' | 'dislike';
      metadata?: any;
    },
  ) {
    try {
      await this.userProfilingService.trackItemInteraction({
        userId: body.userId,
        itemId: body.itemId,
        module: 'search',
        interactionType: body.type === 'click' ? 'click' : body.type === 'order' ? 'order' : body.type === 'favorite' ? 'save' : 'view',
      });

      return { success: true };
    } catch (error) {
      this.logger.error('Failed to track interaction:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Analyze User Profile
   * 
   * Manually trigger profile analysis for a user
   * (Normally happens automatically after conversations)
   * 
   * POST /personalization/profile/analyze?userId=123
   */
  @Post('profile/analyze')
  async analyzeProfile(@Query('userId') userId: string) {
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId)) {
      return { error: 'Invalid userId' };
    }

    try {
      // Get user profile directly
      const profile = await this.userProfilingService.getProfile(parsedUserId) as any;

      if (!profile) {
        return { error: 'Profile not found — user may not have interacted yet' };
      }

      return {
        success: true,
        profile: {
          userId: profile.user_id,
          phone: profile.phone,
          dietary_type: profile.dietary_type,
          dietary_restrictions: profile.dietary_restrictions,
          allergies: profile.allergies,
          favorite_cuisines: profile.favorite_cuisines,
          disliked_ingredients: profile.disliked_ingredients,
          communication_tone: profile.communication_tone,
          personality_traits: profile.personality_traits,
          price_sensitivity: profile.price_sensitivity,
          profile_completeness: profile.profile_completeness,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to analyze profile for user ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * List All User Profiles (paginated)
   *
   * GET /personalization/profiles?page=1&limit=50&search=
   */
  @Get('profiles')
  async listProfiles(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
    @Query('search') search?: string,
  ) {
    try {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, parseInt(limit, 10) || 50);
      const offset = (pageNum - 1) * limitNum;

      let profiles: any[];
      let total: any[];

      if (search) {
        profiles = await this.prisma.$queryRawUnsafe(
          `SELECT * FROM user_profiles WHERE phone LIKE $1 OR CAST(user_id AS TEXT) LIKE $1 ORDER BY updated_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
          `%${search}%`, limitNum, offset,
        );
        total = await this.prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int as count FROM user_profiles WHERE phone LIKE $1 OR CAST(user_id AS TEXT) LIKE $1`,
          `%${search}%`,
        );
      } else {
        profiles = await this.prisma.$queryRawUnsafe(
          `SELECT * FROM user_profiles ORDER BY updated_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
          limitNum, offset,
        );
        total = await this.prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int as count FROM user_profiles`,
        );
      }

      return {
        success: true,
        data: profiles,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: total[0]?.count || 0,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to list profiles: ${error.message}`);
      return { success: false, data: [], error: error.message };
    }
  }

  /**
   * Get User Profile Summary
   *
   * Get user's current profile data
   *
   * GET /personalization/profile?userId=123
   */
  @Get('profile')
  async getProfile(@Query('userId') userId: string) {
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId)) {
      return { error: 'Invalid userId' };
    }

    try {
      const profile = await this.userProfilingService.getProfile(parsedUserId) as any;

      if (!profile) {
        return { error: 'Profile not found' };
      }

      return {
        userId: profile.user_id,
        phone: profile.phone,
        dietary_type: profile.dietary_type,
        dietary_restrictions: profile.dietary_restrictions,
        favorite_cuisines: profile.favorite_cuisines,
        disliked_ingredients: profile.disliked_ingredients,
        allergies: profile.allergies,
        price_sensitivity: profile.price_sensitivity,
        communication_tone: profile.communication_tone,
        personality_traits: profile.personality_traits,
        profile_completeness: profile.profile_completeness,
        last_updated: profile.updated_at,
      };
    } catch (error) {
      this.logger.error(`Failed to get profile for user ${userId}:`, error);
      return { error: error.message };
    }
  }

  /**
   * Get Recent Insights
   * 
   * Get recently extracted insights for a user
   * 
   * GET /personalization/insights?userId=123&limit=10
   */
  @Get('insights')
  async getInsights(
    @Query('userId') userId: string,
    @Query('limit') limit: string = '10',
  ) {
    const parsedUserId = parseInt(userId, 10);
    const parsedLimit = parseInt(limit, 10) || 10;

    if (isNaN(parsedUserId)) {
      return { error: 'Invalid userId' };
    }

    try {
      const insights = await this.userProfilingService.getInsights(parsedUserId, parsedLimit);

      return {
        userId: parsedUserId,
        count: insights.length,
        insights,
      };
    } catch (error) {
      this.logger.error(`Failed to get insights for user ${userId}:`, error);
      return { error: error.message };
    }
  }

  /**
   * Get All Insights (Admin Dashboard)
   *
   * GET /personalization/insights/all?page=1&limit=20&type=&minConfidence=&search=
   */
  @Get('insights/all')
  async getAllInsights(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('type') type?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('search') search?: string,
  ) {
    try {
      const result = await this.userProfilingService.getAllInsights({
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 20,
        type: type || undefined,
        minConfidence: minConfidence ? parseFloat(minConfidence) : undefined,
        search: search || undefined,
      });

      return {
        success: true,
        ...result,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 20,
      };
    } catch (error) {
      this.logger.error('Failed to get all insights:', error);
      return { success: false, error: error.message, insights: [], total: 0 };
    }
  }

  /**
   * Get Insight Statistics (Admin Dashboard)
   *
   * GET /personalization/insights/stats
   */
  @Get('insights/stats')
  async getInsightStats() {
    try {
      const stats = await this.userProfilingService.getInsightStats();
      return { success: true, ...stats };
    } catch (error) {
      this.logger.error('Failed to get insight stats:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get Distinct Insight Types (Admin Dashboard filter dropdown)
   *
   * GET /personalization/insights/types
   */
  @Get('insights/types')
  async getInsightTypes() {
    try {
      const types = await this.userProfilingService.getInsightTypes();
      return { success: true, types };
    } catch (error) {
      this.logger.error('Failed to get insight types:', error);
      return { success: false, types: [] };
    }
  }

  /**
   * Wishlist Toggle
   *
   * Add or remove an item from the authenticated user's wishlist.
   * Uses the session_id to look up the PHP auth token from Redis/DB.
   *
   * POST /personalization/wishlist/toggle
   * { "item_id": 123, "session_id": "uuid-or-phone", "action": "add" | "remove" }
   */
  @Post('wishlist/toggle')
  @HttpCode(200)
  async toggleWishlist(
    @Body() body: { item_id: number; session_id: string; action?: 'add' | 'remove' },
  ) {
    const { item_id, session_id, action = 'add' } = body;
    if (!item_id || !session_id) {
      return { success: false, message: 'item_id and session_id are required' };
    }
    try {
      const session = await this.sessionService.getSession(session_id);
      const authToken = session?.data?.auth_token;
      if (!authToken) {
        return { success: false, message: 'Not authenticated', code: 'no_auth' };
      }
      if (action === 'remove') {
        const result = await this.phpWishlistService.removeFromWishlist(authToken, item_id);
        return result;
      } else {
        const result = await this.phpWishlistService.addToWishlist(authToken, item_id);
        return result;
      }
    } catch (err) {
      this.logger.warn(`Wishlist toggle failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * Manually trigger enrichment for a single user (admin/testing)
   *
   * POST /personalization/enrich?userId=13
   *
   * Clears enrichment cache, re-analyzes order history, cleans garbage data.
   */
  @Post('enrich')
  @HttpCode(200)
  async triggerEnrichment(@Query('userId') userId: string) {
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId)) {
      return { error: 'Invalid userId' };
    }

    if (!this.enrichmentScheduler) {
      return { error: 'Enrichment scheduler not available' };
    }

    try {
      const result = await this.enrichmentScheduler.triggerEnrichmentForUser(parsedUserId);
      return result;
    } catch (error) {
      this.logger.error(`Manual enrichment failed for user ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Health Check
   *
   * Verify personalization service is operational
   */
  @Get('health')
  async health() {
    try {
      // Check database connection via profiling service
      const testProfile = await this.userProfilingService.getProfile(0);
      // If it doesn't throw, DB is connected (null result is fine)

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          analyzer: 'ready',
          profiling: 'ready',
        },
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
      };
    }
  }
}
