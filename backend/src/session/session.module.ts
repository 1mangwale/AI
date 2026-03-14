import { Module, forwardRef } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionIdentifierService } from './session-identifier.service';
import { SessionSyncService } from './services/session-sync.service';
import { CartPersistenceService } from './services/cart-persistence.service';
import { DatabaseModule } from '../database/database.module';

/**
 * SessionModule - Shared Session Management
 * 
 * Provides session/state management for conversations across all channels.
 * Uses Redis for distributed session storage.
 * 
 * Services:
 * - SessionService: Core session CRUD operations
 * - SessionIdentifierService: Resolves phone numbers from session IDs
 * - SessionSyncService: GAP 4 Fix - Ensures Redis ↔ DB sync for flow state
 */
@Module({
  imports: [
    DatabaseModule, // For PrismaService in SessionSyncService
  ],
  providers: [SessionService, SessionIdentifierService, SessionSyncService, CartPersistenceService],
  exports: [SessionService, SessionIdentifierService, SessionSyncService, CartPersistenceService],
})
export class SessionModule {}
