import { Injectable, Logger, NotFoundException, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SessionService } from '../session/session.service';
import { SessionIdentifierService } from '../session/session-identifier.service';
import { FlowContextService } from './flow-context.service';
import { StateMachineEngine } from './state-machine.engine';
import { ExecutorRegistryService } from './executor-registry.service';
import { ContextEnhancerService } from './services/context-enhancer.service';
import { ContextSchemaValidatorService } from './services/context-schema-validator.service';
import { FeatureFlagService } from '../common/services/feature-flag.service';
import { MetricsService } from '../metrics/metrics.service';
import { UserProfilingService } from '../personalization/user-profiling.service';
import {
  FlowDefinition,
  FlowExecutionOptions,
  FlowProcessingResult,
  FlowContext,
  FlowRunStatus,
} from './types/flow.types';

/**
 * Flow Engine Service
 * 
 * Main service for flow management and execution
 * 
 * ✨ NEW: Injects enhanced context (weather, festivals, meal time) into flows
 * ✨ PHASE 3: Intent-aware flow routing with interruption support
 * ✨ GAP 5: Context schema validation at flow entry points
 * 
 * IMPORTANT: Uses SessionIdentifierService to properly resolve phone numbers
 * from session IDs (critical for web chat where sessionId != phoneNumber)
 */
@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);
  private flowCache = new Map<string, FlowDefinition>();
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly sessionIdentifierService: SessionIdentifierService,
    private readonly contextService: FlowContextService,
    private readonly stateMachine: StateMachineEngine,
    private readonly executorRegistry: ExecutorRegistryService,
    @Optional() private readonly contextEnhancer?: ContextEnhancerService,
    @Optional() private readonly contextSchemaValidator?: ContextSchemaValidatorService,
    @Optional() private readonly featureFlags?: FeatureFlagService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly userProfiling?: UserProfilingService,
  ) {
    this.logger.log('🔄 Flow Engine initialized');
  }

  // Cooldown tracker for post-flow profile analysis
  private profileAnalysisCooldown = new Map<number, number>();
  private readonly PROFILE_ANALYSIS_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Start a new flow execution
   */
  async startFlow(
    flowId: string,
    options: FlowExecutionOptions
  ): Promise<FlowProcessingResult> {
    // 1. Load flow definition
    const flow = await this.getFlowById(flowId);
    if (!flow) {
      throw new NotFoundException(`Flow not found: ${flowId}`);
    }

    // 2. Validate flow
    const validation = this.stateMachine.validateFlow(flow);
    if (!validation.valid) {
      this.logger.error(`Flow validation failed: ${validation.errors.join(', ')}`);
      throw new Error(`Invalid flow: ${validation.errors.join(', ')}`);
    }

    // 2.5. Resolve phone number from session if not provided
    // This handles the web chat case where sessionId != phoneNumber
    let resolvedPhoneNumber = options.phoneNumber;
    if (!resolvedPhoneNumber || resolvedPhoneNumber === options.sessionId) {
      const resolution = await this.sessionIdentifierService.resolve(options.sessionId);
      resolvedPhoneNumber = resolution.phoneNumber || options.sessionId;
      this.logger.log(`🔍 Resolved phone for flow: ${resolvedPhoneNumber} (session: ${options.sessionId})`);
    }

    // 3. Create flow run record  
    // Let database generate UUID (removed custom ID generation)
    const flowRun = await this.prisma.flowRun.create({
      data: {
        flowId: flowId,
        sessionId: options.sessionId,
        phoneNumber: resolvedPhoneNumber,
        currentState: flow.initialState,
        context: {},
        status: 'active',
      },
    });

    this.logger.log(`🚀 Started flow ${flow.name} (run: ${flowRun.id})`);

    // 📊 Metrics: Record flow execution start
    if (this.metrics) {
      this.metrics.recordFlowExecution(flow.name, options.module || 'default');
    }

    // 4. Create initial context
    const context = this.contextService.createContext(
      flowId,
      flowRun.id,
      options.sessionId,
      options.userId,
      resolvedPhoneNumber,
      options.initialContext
    );

    // 📋 GAP 5 FIX: Validate and sanitize initial context
    if (this.contextSchemaValidator && options.initialContext) {
      const validatedData = this.contextSchemaValidator.validateFlowContext(flowId, options.initialContext);
      Object.assign(context.data, validatedData);
      this.logger.debug(`📋 Context validated for flow ${flowId}`);
    }

    // 🧠 LOAD SESSION-LEVEL CONVERSATION HISTORY
    // This preserves context across flow completions!
    const session = await this.sessionService.getSession(options.sessionId);
    if (session?.data?._conversation_history && Array.isArray(session.data._conversation_history)) {
      context.data._conversation_history = session.data._conversation_history;
      this.logger.log(`📚 Loaded ${session.data._conversation_history.length} history entries from session`);
    }

    // 📍 INJECT LOCATION DATA FROM SESSION INTO FLOW CONTEXT
    // Critical for geo-distance filtering in search executors
    if (session?.data?.location) {
      context.data.location = session.data.location;
      context.data.lastLocationUpdate = session.data.lastLocationUpdate;
      this.logger.log(`📍 Injected location into flow context: ${JSON.stringify(session.data.location)}`);
    }
    // Also inject _user_location for address executor
    if (session?.data?._user_location) {
      context.data._user_location = session.data._user_location;
      this.logger.log(`📍 Injected _user_location into flow context: ${JSON.stringify(session.data._user_location)}`);
    }
    
    // 📱 INJECT PLATFORM FROM SESSION INTO FLOW CONTEXT
    // Critical for platform-aware auth routing (web uses modal, multichannel uses inline OTP)
    if (session?.data?.platform) {
      context.data.platform = session.data.platform;
      this.logger.log(`📱 Injected platform into flow context: ${session.data.platform}`);
    } else {
      context.data.platform = 'web'; // Default to web
      this.logger.log(`📱 Defaulting platform to 'web' in flow context`);
    }

    // 🏠 INJECT USER DATA FROM SESSION (INCLUDING AUTH)
    // CRITICAL: Load ALL auth-related data so flows can check authentication properly
    if (session?.data?.user_id) {
      context.data.user_id = session.data.user_id;
      context.data.user_authenticated = true;
      context.data.authenticated = true; // Also set this for flows that check context.authenticated
    }
    if (session?.data?.authenticated) {
      context.data.authenticated = session.data.authenticated;
      context.data.user_authenticated = session.data.authenticated;
    }
    if (session?.data?.auth_token) {
      context.data.auth_token = session.data.auth_token;
      this.logger.log(`🔐 Injected auth_token into flow context`);
    }
    if (session?.data?.user_name || session?.data?.userName) {
      context.data.user_name = session.data.user_name || session.data.userName;
    }
    if (session?.data?.phone_number || session?.data?.user_phone) {
      context.data.phone_number = session.data.phone_number || session.data.user_phone;
    }
    // 📋 INJECT SAVED RECIPIENTS for parcel reorder quick-select
    if (session?.data?.saved_recipients && Array.isArray(session.data.saved_recipients)) {
      context.data._saved_recipients_from_session = session.data.saved_recipients;
      this.logger.log(`📋 Injected ${session.data.saved_recipients.length} saved recipients into flow context`);
    }

    // 🎭 INJECT USER COMMUNICATION PREFERENCES FOR TONE/EMOJI ENFORCEMENT
    const prefUserId = context.data.user_id;
    if (prefUserId) {
      try {
        const profile = await this.prisma.user_profiles.findUnique({
          where: { user_id: Number(prefUserId) },
          select: { communication_tone: true, language_preference: true },
        });
        if (profile) {
          if (profile.communication_tone) context.data.communicationTone = profile.communication_tone;
          if (profile.language_preference) context.data.languagePreference = profile.language_preference;
        }
      } catch (err) {
        this.logger.debug(`Could not load user tone preferences: ${err.message}`);
      }
    }

    // 🥗 INJECT DIETARY PREFERENCE FROM SESSION AND/OR DB
    // Session value is immediate (set by update_preference handler).
    // DB value is persistent (survives session expiry).
    if (session?.data?.dietary_preference) {
      context.data.dietary_preference = session.data.dietary_preference;
      context.data._user_food_preference = session.data.dietary_preference;
      this.logger.log(`🥗 Injected dietary preference from session: ${session.data.dietary_preference}`);
    } else if (prefUserId && this.userProfiling) {
      try {
        const profile = await this.userProfiling.getProfile(Number(prefUserId));
        const dietType = profile?.dietary_type || profile?.food_preferences?.dietary_type;
        if (dietType) {
          context.data.dietary_preference = dietType;
          context.data._user_food_preference = dietType;
          this.logger.log(`🥗 Injected dietary preference from DB: ${dietType}`);
        }
      } catch (err) {
        this.logger.debug(`Could not load dietary preference: ${err.message}`);
      }
    }

    // Ensure _user_message is set (critical for NLU executors)
    // Support both 'message' and 'user_message' as input keys
    if (!context.data._user_message) {
      const userMessage = context.data.user_message || context.data.message;
      if (userMessage) {
        this.contextService.set(context, '_user_message', userMessage);
      }
    }

    // INJECT NER ENTITIES FROM SESSION (extracted by orchestrator before flow start)
    if (session?.data?._extracted_entities) {
      context.data._extracted_entities = session.data._extracted_entities;
      context.data._nlu_confidence = session.data._nlu_confidence;
      context.data._nlu_intent = session.data._nlu_intent;
      this.logger.log(`NER entities injected into flow context: food=${JSON.stringify(session.data._extracted_entities.food || [])}, store=${session.data._extracted_entities.store || 'none'}`);
    }

    // 🌤️ INJECT ENHANCED CONTEXT (Weather, Festivals, Meal Time, Local Knowledge)
    // This makes Chotu's responses contextual and personalized!
    if (this.contextEnhancer) {
      try {
        const lat = context.data.location?.latitude;
        const lng = context.data.location?.longitude;
        const userId = context.data.user_id?.toString();
        
        const enhancedContext = await this.contextEnhancer.getEnhancedContext(userId, lat, lng);
        context.data.enhancedContext = enhancedContext;
        
        // Also set individual context fields for easy template access
        context.data.weather = enhancedContext.weather;
        context.data.mealTime = enhancedContext.time.mealTime;
        context.data.timeOfDay = enhancedContext.time.timeOfDay;
        context.data.festival = enhancedContext.festival;
        context.data.contextualGreeting = enhancedContext.greetingEnhancement;
        
        this.logger.log(`🌤️ Enhanced context injected: ${enhancedContext.weather.temperature}°C, ${enhancedContext.time.mealTime}, festival=${enhancedContext.festival.isToday}`);
      } catch (err) {
        this.logger.warn(`⚠️ Failed to get enhanced context: ${err.message}`);
      }
    }

    context._system.currentState = flow.initialState;

    // 5. Execute initial state
    let result = await this.stateMachine.executeState(flow, context);

    // 6. Auto-execute action states until we reach a state waiting for input
    await this.autoExecuteStates(flow, context, result);

    // 7. Update flow run
    //  Fix: Use current state when nextState is null (flow completed immediately)
    const stateToSave = result.nextState || context._system.currentState;
    await this.updateFlowRun(flowRun.id, stateToSave, context, result.completed ? 'completed' : 'running');

    // 7. Clear flow from session if completed, otherwise save context
    if (result.completed) {
      this.logger.log(`✅ Flow completed on start! Clearing from session.`);
      await this.clearFlowFromSession(options.sessionId);
    } else {
      await this.saveContextToSession(options.sessionId, context);
    }

    // 8. Extract response from context
    const { responseMessage, responseButtons, responseCards, responseMetadata, cards } =
      this.extractResponseFromContext(context, '');
    
    return {
      flowRunId: flowRun.id,
      currentState: result.nextState || flow.initialState,
      response: responseMessage,
      completed: result.completed,
      collectingData: !result.completed,
      progress: this.contextService.calculateProgress(
        context,
        Object.keys(flow.states).length,
        flow.finalStates
      ),
      buttons: responseButtons,
      cards: responseCards || cards,
      metadata: responseMetadata || (cards ? { cards } : undefined),
    };
  }

  /**
   * Process user message in active flow
   * 
   * @param sessionId - Session identifier
   * @param message - User's message text
   * @param event - Optional event to trigger (default: 'user_message')
   * @param intent - Optional detected intent from NLU
   * @param intentConfidence - Optional confidence score (0-1)
   */
  async processMessage(
    sessionId: string,
    message: string,
    event?: string,
    intent?: string,
    intentConfidence?: number,
  ): Promise<FlowProcessingResult> {
    // 1. Get active flow from session
    const session = await this.sessionService.getSession(sessionId);
    const flowContext = session?.data?.flowContext;

    if (!flowContext || !flowContext.flowRunId) {
      throw new Error('No active flow found');
    }

    // 2. Load flow run
    const flowRun = await this.prisma.flowRun.findUnique({
      where: { id: flowContext.flowRunId },
    });

    if (!flowRun) {
      throw new NotFoundException('Flow run not found');
    }

    // 3. Load flow definition
    const flow = await this.getFlowById(flowRun.flowId); // Use camelCase
    if (!flow) {
      throw new NotFoundException('Flow definition not found');
    }

    // 4. Restore context
    const context: FlowContext = flowRun.context as any;
    
    // 🧠 MERGE SESSION-LEVEL CONVERSATION HISTORY
    // This ensures we have the latest conversation context even if flow context is older
    if (session?.data?._conversation_history && Array.isArray(session.data._conversation_history)) {
      if (!context.data._conversation_history) {
        context.data._conversation_history = [];
      }
      // Merge session history with flow context history, keeping unique entries
      const existingMessages = new Set(context.data._conversation_history.map(m => m.content));
      for (const msg of session.data._conversation_history) {
        if (!existingMessages.has(msg.content)) {
          context.data._conversation_history.push(msg);
        }
      }
      // Keep last 40 messages max
      if (context.data._conversation_history.length > 40) {
        context.data._conversation_history = context.data._conversation_history.slice(-40);
      }
    }

    // 📍 REFRESH LOCATION DATA FROM SESSION (may have been updated since flow started)
    if (session?.data?.location) {
      context.data.location = session.data.location;
      context.data.lastLocationUpdate = session.data.lastLocationUpdate;
    }
    // Also refresh _user_location for address executor
    if (session?.data?._user_location) {
      context.data._user_location = session.data._user_location;
      this.logger.log(`📍 Refreshed _user_location in context: ${JSON.stringify(session.data._user_location)}`);
    }
    
    // � REFRESH PLATFORM FROM SESSION (critical for platform-aware auth)
    if (session?.data?.platform) {
      context.data.platform = session.data.platform;
    } else if (!context.data.platform) {
      context.data.platform = 'web'; // Default to web
    }
    
    // �🔐 REFRESH AUTH DATA FROM SESSION (critical for flows that check authentication)
    if (session?.data?.authenticated) {
      context.data.authenticated = session.data.authenticated;
      context.data.user_authenticated = session.data.authenticated;
    }
    if (session?.data?.auth_token) {
      context.data.auth_token = session.data.auth_token;
    }
    if (session?.data?.user_id) {
      context.data.user_id = session.data.user_id;
    }
    if (session?.data?.phone_number || session?.data?.user_phone) {
      context.data.phone_number = session.data.phone_number || session.data.user_phone;
    }
    
    // 🎭 REFRESH USER COMMUNICATION PREFERENCES FOR TONE/EMOJI ENFORCEMENT
    if (context.data.user_id && !context.data.communicationTone) {
      try {
        const profile = await this.prisma.user_profiles.findUnique({
          where: { user_id: Number(context.data.user_id) },
          select: { communication_tone: true, language_preference: true },
        });
        if (profile) {
          if (profile.communication_tone) context.data.communicationTone = profile.communication_tone;
          if (profile.language_preference) context.data.languagePreference = profile.language_preference;
        }
      } catch (err) {
        this.logger.debug(`Could not load user tone preferences: ${err.message}`);
      }
    }

    // REFRESH NER ENTITIES FROM SESSION (extracted by orchestrator before flow dispatch)
    if (session?.data?._extracted_entities) {
      context.data._extracted_entities = session.data._extracted_entities;
      context.data._nlu_confidence = session.data._nlu_confidence;
      context.data._nlu_intent = session.data._nlu_intent;
    }

    // 🥗 REFRESH DIETARY PREFERENCE FROM SESSION
    // Picks up mid-flow preference changes (e.g., user says "main veg hoon" during food flow)
    if (session?.data?.dietary_preference) {
      context.data.dietary_preference = session.data.dietary_preference;
      if (!context.data._user_food_preference) {
        context.data._user_food_preference = session.data.dietary_preference;
      }
    }

    // Store user message in context
    this.contextService.set(context, '_user_message', message);
    this.contextService.set(context, '_last_message_at', new Date());

    // 🧹 Clear stale response from previous cycle so wait states
    // don't accidentally re-send old messages (e.g., payment link)
    this.contextService.set(context, '_last_response', null);

    // 🎯 INJECT INTENT INTO CONTEXT (Phase 3: Intent-Aware Flows)
    // This allows executors to make decisions based on the user's detected intent
    // Feature-flagged: USE_INTENT_AWARE_FLOWS
    const intentAwareEnabled = this.featureFlags?.useIntentAwareFlows(sessionId) ?? true;

    // Quick heuristic check: detect obvious intent switches even if NLU confidence is borderline
    // This runs BEFORE full NLU injection to catch clear cross-flow messages
    let detectedIntent = intent;
    let detectedConfidence = intentConfidence || 0;
    if (message && intentAwareEnabled) {
      const heuristicResult = this.quickHeuristicIntentCheck(message);
      if (heuristicResult && (!intent || detectedConfidence < heuristicResult.confidence)) {
        detectedIntent = heuristicResult.intent;
        detectedConfidence = heuristicResult.confidence;
        this.logger.log(`Heuristic override: ${heuristicResult.intent} (${heuristicResult.confidence}) over NLU: ${intent} (${intentConfidence})`);
      }
    }

    if (detectedIntent && intentAwareEnabled) {
      this.contextService.set(context, '_current_intent', detectedIntent);
      this.contextService.set(context, '_intent_confidence', detectedConfidence);
      this.logger.log(`Injected intent into flow context: ${detectedIntent} (${(detectedConfidence * 100).toFixed(0)}%)`);

      // Handle special intents that should interrupt the flow
      // Feature-flagged: USE_FLOW_INTERRUPTION
      const flowInterruptionEnabled = this.featureFlags?.useFlowInterruption() ?? true;

      if (flowInterruptionEnabled && this.isInterruptingIntent(detectedIntent, detectedConfidence)) {
        this.logger.log(`Interrupting intent detected: ${detectedIntent}`);
        this.contextService.set(context, '_intent_interrupt', true);
      }
    }

    // 5. Execute current state with event
    const result = await this.stateMachine.executeState(
      flow,
      context,
      event || 'user_message'
    );

    // 6. Auto-execute action states until we reach a state waiting for input
    await this.autoExecuteStates(flow, context, result);

    // 6b. Handle flow switch intent (Phase 3: Intent-Aware Flows)
    // Feature-flagged: USE_FLOW_SUSPENSION
    const flowSuspensionEnabled = this.featureFlags?.useFlowSuspension() ?? true;
    const pendingFlowSwitch = this.contextService.get(context, '_pending_flow_switch');
    
    if (pendingFlowSwitch && flowSuspensionEnabled) {
      this.logger.log(`🔄 Pending flow switch detected: ${pendingFlowSwitch}`);
      
      const currentFlowId = context._system.flowId;
      
      // Save current flow state for potential resumption
      const session = await this.sessionService.getSession(sessionId);
      await this.sessionService.saveSession(sessionId, {
        data: {
          ...session?.data,
          suspendedFlow: {
            flowId: currentFlowId,
            state: context._system.currentState,
            savedAt: new Date().toISOString(),
            contextSnapshot: { ...context.data } // Preserve collected data
          }
        }
      });
      
      this.logger.log(`💾 Suspended current flow '${currentFlowId}' at state '${context._system.currentState}'`);
      
      // Clear flow context and let the router start the new flow
      await this.clearFlowFromSession(sessionId);
      
      return {
        flowRunId: flowRun.id,
        currentState: context._system.currentState,
        response: null, // Let the router handle responding
        completed: true, // Mark as completed so router can start new flow
        collectingData: false,
        progress: 0,
        metadata: { 
          flowSwitchIntent: pendingFlowSwitch,
          previousFlowSuspended: true
        },
      };
    } else if (pendingFlowSwitch && !flowSuspensionEnabled) {
      // Flow suspension disabled - just log and continue
      this.logger.log(`🔄 Flow switch intent ${pendingFlowSwitch} detected but suspension disabled`);
    }

    // 6c. Execute final state if completed (to show success message)
    if (result.completed && result.nextState) {
      const finalState = flow.states[result.nextState];
      if (finalState && finalState.type === 'end') {
        this.logger.log(`🏁 Executing final state: ${result.nextState}`);
        this.contextService.updateState(context, result.nextState);
        await this.stateMachine.executeState(flow, context);
      }
    }

    // 7. Update flow run
    const status: FlowRunStatus = result.completed 
      ? 'completed' 
      : result.error 
      ? 'failed' 
      : 'running';

    // If nextState is null (error case), keep the current state
    const stateToSave = result.nextState || context._system.currentState;

    await this.updateFlowRun(flowRun.id, stateToSave, context, status, result.error);

    // 📊 Metrics: Record flow completion or state transition
    if (this.metrics && flow) {
      if (result.completed) {
        this.metrics.recordFlowCompletion(flow.name, 'completed');
        const startTime = flowRun.startedAt || new Date();
        const duration = Date.now() - startTime.getTime();
        this.metrics.recordFlowDuration(flow.name, duration);
      } else if (result.error) {
        this.metrics.recordFlowCompletion(flow.name, 'error');
      } else if (result.nextState) {
        // Record state transition
        this.metrics.recordFlowStateTransition(
          flow.name,
          context._system.currentState,
          result.nextState
        );
      }
    }

    // 8. Clear flow from session if completed (CRITICAL FIX!)
    if (result.completed) {
      this.logger.log(`✅ Flow completed! Clearing from session to allow new flow on next message.`);
      await this.clearFlowFromSession(sessionId);

      // 🧠 Post-flow profile analysis: holistic conversation analysis via LLM
      this.triggerPostFlowProfileAnalysis(sessionId, context).catch(err =>
        this.logger.debug(`Post-flow profile analysis skipped: ${err.message}`),
      );

      // 🔄 RESUME CHECK: If there is a suspended flow, ask user if they want to resume
      const session = await this.sessionService.getSession(sessionId);
      if (session?.data?.suspendedFlow) {
        const suspendedFlowId = session.data.suspendedFlow.flowId;
        const suspendedFlowDef = await this.getFlowById(suspendedFlowId);
        const flowName = suspendedFlowDef?.name || 'previous task';
        
        // Append prompt to response
        const resumePrompt = `\n\n(By the way, we were in the middle of ${flowName}. Do you want to continue that?)`;
        
        // If response is object (with buttons), append to message
        let finalResponse = this.contextService.get(context, '_last_response') || 'I am listening. Please continue.';
        
        if (typeof finalResponse === 'object' && finalResponse.message) {
          finalResponse.message += resumePrompt;
          // Add Resume/No buttons
          if (!finalResponse.buttons) finalResponse.buttons = [];
          finalResponse.buttons.push(
            { id: 'btn_resume_yes', label: 'Yes, Resume', value: 'resume_flow' },
            { id: 'btn_resume_no', label: 'No, Thanks', value: 'cancel_resume' }
          );
        } else if (typeof finalResponse === 'string') {
          finalResponse += resumePrompt;
        }
        
        // Set session flag to expect resume confirmation
        await this.sessionService.saveSession(sessionId, {
          data: {
            ...session.data,
            awaitingResumeConfirmation: true
          }
        });
        
        // Update response in result
        return {
          flowRunId: flowRun.id,
          currentState: result.nextState || context._system.currentState,
          response: finalResponse,
          completed: true,
          collectingData: false,
          progress: 100,
        };
      }
    } else {
      // Save context to session only if flow is still active
      await this.saveContextToSession(sessionId, context);
    }

    // Handle error case explicitly with user-friendly messages
    if (result.error) {
      // Prefer executor-set _friendly_error (more contextual) over generic mapping
      const userMessage = context.data._friendly_error || this.getUserFriendlyError(result.error);
      // Clear _friendly_error after use to avoid stale messages
      delete context.data._friendly_error;
      return {
        flowRunId: flowRun.id,
        currentState: result.nextState || context._system.currentState,
        response: userMessage,
        completed: false,
        collectingData: false,
        progress: 0,
      };
    }

    // Extract response from context (shared helper)
    const { responseMessage, responseButtons, responseCards, responseMetadata, cards } =
      this.extractResponseFromContext(context, 'I am listening. Please continue.');

    // Filter out stale responseType from metadata (e.g., request_location after location is shared)
    let finalMetadata = responseMetadata || (cards ? { cards } : undefined);
    if (finalMetadata?.responseType) {
      const currentState = result.nextState || context._system.currentState;
      // Only include request_location responseType if we're actually in request_location state
      if (finalMetadata.responseType === 'request_location' && currentState !== 'request_location') {
        this.logger.debug(`🧹 Clearing stale responseType: request_location (current state: ${currentState})`);
        const { responseType, ...restMetadata } = finalMetadata;
        finalMetadata = Object.keys(restMetadata).length > 0 ? restMetadata : undefined;
      }
      // Also filter out 'silent' responseType - it's for internal use only
      if (finalMetadata?.responseType === 'silent') {
        const { responseType, ...restMetadata } = finalMetadata;
        finalMetadata = Object.keys(restMetadata).length > 0 ? restMetadata : undefined;
      }
    }
    this.logger.debug(`📦 Final metadata being returned: ${JSON.stringify(finalMetadata)}`);
    
    return {
      flowRunId: flowRun.id,
      currentState: result.nextState || context._system.currentState,
      response: responseMessage,
      completed: result.completed,
      collectingData: !result.completed,
      progress: this.contextService.calculateProgress(
        context,
        Object.keys(flow.states).length,
        flow.finalStates
      ),
      buttons: responseButtons,
      cards: responseCards || cards,
      metadata: finalMetadata,
    };
  }

  /**
   * Get active flow for session
   */
  async getActiveFlow(sessionId: string): Promise<string | null> {
    const session = await this.sessionService.getSession(sessionId);
    return session?.data?.flowContext?.flowRunId || null;
  }

  /**
   * Get current flow context for session (includes currentState)
   */
  async getContext(sessionId: string): Promise<{ flowRunId: string; currentState: string; flowId?: string } | null> {
    const session = await this.sessionService.getSession(sessionId);
    const flowContext = session?.data?.flowContext;
    if (!flowContext?.flowRunId) return null;
    return {
      flowRunId: flowContext.flowRunId,
      currentState: flowContext.currentState || '',
      flowId: flowContext.flowId,
    };
  }

  /**
   * Check if flow is in a wait state (collecting user input)
   * This is important to prevent interruptions during data collection
   */
  async isInWaitState(sessionId: string): Promise<boolean> {
    const session = await this.sessionService.getSession(sessionId);
    const flowContext = session?.data?.flowContext;
    if (!flowContext?.flowRunId || !flowContext?.currentState) return false;
    
    // Get flow definition to check state type
    const flow = await this.getFlowById(flowContext.flowId);
    if (!flow) return false;
    
    const currentState = flow.states[flowContext.currentState];
    return currentState?.type === 'wait';
  }

  /**
   * Cancel active flow
   */
  async cancelFlow(sessionId: string): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    const flowRunId = session?.data?.flowContext?.flowRunId;

    if (flowRunId) {
      await (this.prisma as any).flowRun.update({
        where: { id: flowRunId },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
        },
      });

      // Clear from session
      await this.sessionService.saveSession(sessionId, {
        data: {
          ...session?.data,
          flowContext: null,
        },
      });

      this.logger.log(`❌ Flow cancelled: ${flowRunId}`);
    }
  }

  /**
   * Suspend active flow (save state for later resumption)
   */
  async suspendFlow(sessionId: string): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    const flowContext = session?.data?.flowContext;

    if (flowContext) {
      // Save to suspendedFlow
      await this.sessionService.saveSession(sessionId, {
        data: {
          ...session?.data,
          suspendedFlow: flowContext,
          flowContext: null, // Clear active flow
        },
      });
      this.logger.log(`⏸️ Suspended flow for session ${sessionId}`);
    }
  }

  /**
   * Resume suspended flow
   */
  async resumeSuspendedFlow(sessionId: string): Promise<boolean> {
    const session = await this.sessionService.getSession(sessionId);
    const suspended = session?.data?.suspendedFlow;
    
    if (suspended) {
      this.logger.log(`▶️ Resuming suspended flow: ${suspended.flowId}`);
      
      await this.sessionService.saveSession(sessionId, {
        data: {
          ...session?.data,
          flowContext: suspended,
          suspendedFlow: null,
        },
      });
      return true;
    }
    return false;
  }

  /**
   * Find flow by intent trigger and optional module
   */
  async findFlowByIntent(intent: string, module?: string, message?: string): Promise<FlowDefinition | null> {
    const flows = await this.getAllFlows();
    const normalizedModule = module?.toLowerCase();

    // If a specific module is provided, restrict matching to that module + general.
    // This prevents cross-module fallbacks (e.g. delivery intents matching food flows due to the word "order").
    const candidateFlows = normalizedModule && normalizedModule !== 'general'
      ? flows.filter((f) => {
          const flowModule = (f.module ?? 'general').toLowerCase();
          return flowModule === normalizedModule || flowModule === 'general';
        })
      : flows;
    
    this.logger.log(
      `🔍 FLOW SEARCH: intent="${intent}", module="${module}", message="${message ? message.substring(0, 20) + '...' : 'none'}"`
    );
    this.logger.log(
      `📋 Available flows: ${candidateFlows.map(f => `${f.id} (trigger: ${f.trigger}, module: ${f.module})`).join(', ')}`
    );
    
    let flow: FlowDefinition | undefined;
    
    // ========================================
    // PRIORITY 1: Check message content for HELP/SERVICE INQUIRY keywords FIRST
    // This must happen BEFORE intent matching to avoid NLU misclassification
    // ========================================
    if (message) {
      const lowerMsg = message.toLowerCase();
      
      // Service inquiry / About Mangwale - Check message content for help-related queries
      // This should match "What is Mangwale", "Tell me about services", "What can you do", etc.
      const helpKeywords = ['what is mangwale', 'tell me about', 'your services', 'what can you do', 
                            'what do you do', 'what services', 'how does it work', 'about mangwale',
                            'about chotu', 'who are you', 'what is this', 'explain services', 'features',
                            'services do you offer', 'services you offer',
                            'mangwale kya hai', 'kya kar sakte ho', 'kya services', 'batao'];
      if (helpKeywords.some(kw => lowerMsg.includes(kw))) {
        flow = candidateFlows.find(f => f.trigger?.includes('help') && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ [PRIORITY] Service inquiry keyword match: ${flow.name}`);
          return flow;
        }
      }
      
      // Login/Auth keywords - Check early
      if (lowerMsg.includes('login') || lowerMsg.includes('sign in') || lowerMsg.includes('signin') || lowerMsg.includes('log in') || lowerMsg.includes('authenticate') || lowerMsg.includes('verify phone') || lowerMsg.includes('otp') || lowerMsg === 'login') {
        flow = candidateFlows.find(f => f.trigger === 'login' && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ [PRIORITY] Login keyword match: ${flow.name}`);
          return flow;
        }
      }
    }
    
    // ========================================
    // PRIORITY 2: Standard intent matching
    // ========================================
    
    // CRITICAL: If intent is 'default' or 'unknown', don't try to match it - fall through to keyword matching
    if (intent === 'default' || intent === 'unknown') {
      this.logger.warn(`⚠️ NLU returned ${intent} intent - using keyword/module fallback`);
    } else {
      // Try exact match with intent trigger first
      flow = candidateFlows.find(f => f.trigger === intent && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Exact match: ${flow.name} (trigger: ${flow.trigger})`);
        return flow;
      }
    }
    
    // Skip prefix matching for default/unknown
    if (intent !== 'default' && intent !== 'unknown') {
      // Try with "intent." prefix
      flow = candidateFlows.find(f => f.trigger === `intent.${intent}` && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Prefix match: ${flow.name} (trigger: ${flow.trigger})`);
        return flow;
      }
    }
    
    // Try partial match (e.g., "parcel.create" matches "intent.parcel.create")
    flow = candidateFlows.find(f => {
      const trigger = f.trigger || '';
      return (trigger.endsWith(`.${intent}`) || trigger === intent) && f.enabled !== false;
    });
    if (flow) {
      this.logger.log(`✅ Partial match: ${flow.name} (trigger: ${flow.trigger})`);
      return flow;
    }
    
    // Try trigger pattern matching (e.g., "browse_menu" in "help|browse_menu|what can you do")
    flow = candidateFlows.find(f => {
      if (!f.trigger || f.enabled === false) return false;
      
      const triggerPatterns = f.trigger.split('|').map(t => t.trim().toLowerCase());
      const intentLower = intent.toLowerCase();
      
      // Check if intent matches any trigger pattern
      return triggerPatterns.some(pattern => {
        return pattern === intentLower || 
               intentLower.includes(pattern) || 
               pattern.includes(intentLower);
      });
    });
    if (flow) {
      this.logger.log(`✅ Trigger pattern match: ${flow.name} (trigger: ${flow.trigger})`);
      return flow;
    }
    
    // Try keyword-based matching on INTENT
    const lowerIntent = intent.toLowerCase();
    
    // Login/Auth keywords - Check FIRST before greeting fallback
    // This catches "login", "sign in", "otp", etc. even with unknown intent
    if (message) {
      const lowerMsg = message.toLowerCase();
      if (lowerMsg.includes('login') || lowerMsg.includes('sign in') || lowerMsg.includes('signin') || lowerMsg.includes('log in') || lowerMsg.includes('authenticate') || lowerMsg.includes('verify phone') || lowerMsg.includes('otp') || lowerMsg === 'login') {
        // Match EXACT trigger 'login' for customer auth (not vendor_login or delivery_login)
        flow = candidateFlows.find(f => f.trigger === 'login' && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ Login keyword match: ${flow.name}`);
          return flow;
        }
      }
    }
    
    // Greeting keywords - ALWAYS check, especially for default/unknown intents
    if (lowerIntent.includes('greet') || lowerIntent === 'greeting' || lowerIntent === 'hello' || lowerIntent === 'hi' || lowerIntent === 'hey' || intent === 'default' || intent === 'unknown') {
      this.logger.log(`🎯 Checking greeting keywords for intent: ${intent}`);
      flow = candidateFlows.find(f => f.trigger?.includes('greeting') && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Keyword match (greeting): ${flow.name} (trigger: ${flow.trigger})`);
        return flow;
      }
    }

    // Chitchat keywords - handle "chitchat" intent and casual conversation
    if (lowerIntent === 'chitchat' || lowerIntent.includes('chitchat')) {
      this.logger.log(`🎯 Checking chitchat flow for intent: ${intent}`);
      flow = candidateFlows.find(f => f.id === 'chitchat_v1' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Chitchat intent match: ${flow.name}`);
        return flow;
      }
    }

    // --- MESSAGE CONTENT FALLBACK ---
    // If intent didn't match, check the raw message content
    if (message) {
      const lowerMsg = message.toLowerCase();

      // Food/Order
      if (lowerMsg.includes('food') || lowerMsg.includes('order') || lowerMsg.includes('eat') || lowerMsg.includes('hungry') || lowerMsg.includes('restaurant') || lowerMsg.includes('paneer') || lowerMsg.includes('pizza') || lowerMsg.includes('biryani')) {
        // Only allow this very broad fallback in general (or food) contexts.
        if (!normalizedModule || normalizedModule === 'general' || normalizedModule === 'food') {
          flow = candidateFlows.find(f => f.module === 'food' && f.enabled !== false);
        }
        if (flow) {
          this.logger.log(`✅ Message keyword match (food): ${flow.name}`);
          return flow;
        }
      }

      // Parcel/Coolie
      if (lowerMsg.includes('parcel') || lowerMsg.includes('send') || lowerMsg.includes('courier') || lowerMsg.includes('delivery') || lowerMsg.includes('pickup') || lowerMsg.includes('drop')) {
        flow = flows.find(f => f.module === 'parcel' && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ Message keyword match (parcel): ${flow.name}`);
          return flow;
        }
      }

      // Shopping/Mart
      if (lowerMsg.includes('shop') || lowerMsg.includes('buy') || lowerMsg.includes('grocery') || lowerMsg.includes('milk') || lowerMsg.includes('mart')) {
        flow = flows.find(f => f.module === 'ecommerce' && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ Message keyword match (ecommerce): ${flow.name}`);
          return flow;
        }
      }
    }
    // --------------------------------

    // Game/earn keywords - ALWAYS check regardless of module
    if (lowerIntent.includes('game') || lowerIntent.includes('earn') || lowerIntent.includes('reward')) {
      flow = flows.find(f => f.trigger?.includes('game') && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Game keyword match: ${flow.name}`);
        return flow;
      }
    }
    
    // Help keywords - ALWAYS check regardless of module
    if (lowerIntent.includes('help') || lowerIntent === 'support') {
      flow = flows.find(f => f.trigger?.includes('help') && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Help keyword match: ${flow.name}`);
        return flow;
      }
    }
    
    // Fallback to 'general' module flows for common intents
    if (!flow && module && module !== 'general') {
      this.logger.debug(`🔄 No flow found for module ${module}, trying 'general' module...`);
      flow = flows.find(f => f.trigger === intent && f.module === 'general' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ General module fallback: ${flow.name}`);
        return flow;
      }
      
      flow = flows.find(f => f.trigger === `intent.${intent}` && f.module === 'general' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ General module fallback (with prefix): ${flow.name}`);
        return flow;
      }
    }
    
    // Parcel/delivery keywords (Intent check)
    if (lowerIntent.includes('parcel') || lowerIntent.includes('courier') || lowerIntent.includes('delivery')) {
      flow = flows.find(f => f.module === 'parcel' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Parcel keyword match: ${flow.name}`);
        return flow;
      }
    }
    
    // Food keywords (Intent check)
    if (lowerIntent.includes('food') || lowerIntent.includes('restaurant') || lowerIntent.includes('order')) {
      flow = flows.find(f => f.module === 'food' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Food keyword match: ${flow.name}`);
        return flow;
      }
    }
    
    // Ecommerce keywords (Intent check)
    if (lowerIntent.includes('shop') || lowerIntent.includes('buy') || lowerIntent.includes('ecom')) {
      flow = flows.find(f => f.module === 'ecommerce' && f.enabled !== false);
      if (flow) {
        this.logger.log(`✅ Ecommerce keyword match: ${flow.name}`);
        return flow;
      }
    }

    // If module provided, ONLY allow a pure module fallback when the intent is generic/unknown.
    // This prevents misroutes like intent="support_request" starting a Food flow just because module="food".
    if (module) {
      const intentLower = intent.toLowerCase();
      const allowModuleFallback =
        intentLower === 'default' ||
        intentLower === 'unknown' ||
        intentLower === 'general_query' ||
        intentLower === 'greeting' ||
        intentLower === 'chitchat';

      if (allowModuleFallback) {
        // Try exact module match first (LOWEST PRIORITY - only if no trigger match found)
        flow = candidateFlows.find(f => (f.module ?? 'general') === module && f.enabled !== false);
        if (flow) {
          this.logger.log(`✅ Module fallback match: ${flow.name} (module: ${module})`);
          return flow;
        }
      } else {
        this.logger.debug(
          `⛔ Skipping module fallback due to explicit intent="${intent}" (module="${module}")`
        );
      }
    }
    
    this.logger.warn(`❌ No flow found for intent: ${intent}, module: ${module}`);
    return null;
  }

  /**
   * Get flow by ID
   */
  async getFlowById(flowId: string): Promise<FlowDefinition | null> {
    // Check cache first
    if (this.flowCache.has(flowId) && Date.now() < this.cacheExpiry) {
      return this.flowCache.get(flowId)!;
    }

    // Load from database
    const flowRecord = await (this.prisma as any).flow.findUnique({
      where: { id: flowId },
    });

    if (!flowRecord || flowRecord.status !== 'active') {
      return null;
    }

    const flow = this.parseFlowRecord(flowRecord);
    
    // Cache it
    this.flowCache.set(flowId, flow);

    return flow;
  }

  /**
   * Get all active flows
   */
  async getAllFlows(): Promise<FlowDefinition[]> {
    const flowRecords = await this.prisma.flow.findMany({
      where: { status: 'active' },
      orderBy: { updatedAt: 'desc' },
    });

    return flowRecords.map(record => this.parseFlowRecord(record));
  }

  /**
   * Parse flow record from database
   */
  private parseFlowRecord(record: any): FlowDefinition {
    const flow: FlowDefinition = {
      id: record.id,
      name: record.name,
      description: record.description,
      module: record.module,
      trigger: record.trigger,
      version: record.version || '1.0.0',
      states: typeof record.states === 'string' ? JSON.parse(record.states) : record.states,
      initialState: record.initialState,
      finalStates: typeof record.finalStates === 'string' ? JSON.parse(record.finalStates) : record.finalStates,
      contextSchema: record.contextSchema ? (typeof record.contextSchema === 'string' ? JSON.parse(record.contextSchema) : record.contextSchema) : undefined,
      metadata: record.metadata ? (typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata) : undefined,
      enabled: record.enabled,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return flow;
  }

  /**
   * Save flow definition
   */
  async saveFlow(flow: FlowDefinition): Promise<void> {
    // Validate flow
    const validation = this.stateMachine.validateFlow(flow);
    if (!validation.valid) {
      throw new Error(`Invalid flow: ${validation.errors.join(', ')}`);
    }

    await (this.prisma as any).flow.upsert({
      where: { id: flow.id },
      create: {
        id: flow.id,
        name: flow.name,
        description: flow.description,
        module: flow.module || 'general',
        trigger: flow.trigger,
        version: flow.version || '1.0.0',
        states: flow.states,
        initialState: flow.initialState,
        finalStates: flow.finalStates,
        contextSchema: flow.contextSchema,
        metadata: flow.metadata,
        enabled: flow.enabled !== false,
        status: 'active',
      },
      update: {
        name: flow.name,
        description: flow.description,
        module: flow.module || 'general',
        trigger: flow.trigger,
        version: flow.version || '1.0.0',
        states: flow.states,
        initialState: flow.initialState,
        finalStates: flow.finalStates,
        contextSchema: flow.contextSchema,
        metadata: flow.metadata,
        enabled: flow.enabled !== false,
      },
    });

    // Invalidate cache
    this.flowCache.delete(flow.id);
    this.cacheExpiry = 0;

    this.logger.log(`💾 Flow saved: ${flow.name} (${flow.id})`);
  }

  /**
   * Update flow run in database
   */
  private async updateFlowRun(
    flowRunId: string,
    currentState: string | null,
    context: FlowContext,
    status: FlowRunStatus,
    error?: string
  ): Promise<void> {
    await (this.prisma as any).flowRun.update({
      where: { id: flowRunId },
      data: {
        currentState: currentState,
        context: context as any,
        status,
        error,
        completedAt: status === 'completed' || status === 'failed' 
          ? new Date() 
          : undefined,
      },
    });
  }

  /**
   * Save context to session
   */
  private async saveContextToSession(
    sessionId: string,
    context: FlowContext
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    
    await this.sessionService.saveSession(sessionId, {
      data: {
        ...session?.data,
        flowContext: {
          flowId: context._system.flowId,
          flowRunId: context._system.flowRunId,
          currentState: context._system.currentState,
          data: context.data,
        },
      },
    });
  }

  /**
   * Clear flow from session (called when flow completes)
   * IMPORTANT: Preserves conversation history for context continuity
   */
  private async clearFlowFromSession(sessionId: string): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    
    // 🧠 PRESERVE CONVERSATION HISTORY: Extract it before clearing flowContext
    // Ensure both are arrays to avoid spread operator errors
    const existingHistory = Array.isArray(session?.data?.flowContext?.data?._conversation_history) 
      ? session.data.flowContext.data._conversation_history 
      : [];
    const existingSessionHistory = Array.isArray(session?.data?._conversation_history)
      ? session.data._conversation_history
      : [];
    
    // Merge histories, keeping most recent entries (last 40 turns max)
    const mergedHistory = [...existingSessionHistory, ...existingHistory].slice(-40);
    
    await this.sessionService.saveSession(sessionId, {
      data: {
        ...session?.data,
        flowContext: null, // Clear flow context
        _conversation_history: mergedHistory, // Preserve conversation history at session level!
      },
    });
    
    this.logger.log(`🧹 Cleared flow from session ${sessionId} (preserved ${mergedHistory.length} history entries)`);
  }

  /**
   * Check if an intent should interrupt the current flow
   * 
   * Intent-aware flows (Phase 3): Certain intents indicate the user wants to change context,
   * cancel, or get help. These should be handled specially within flows.
   */
  private isInterruptingIntent(intent: string, confidence: number): boolean {
    // High-confidence intents that always interrupt
    const alwaysInterrupt = ['cancel', 'stop', 'help', 'reset', 'menu', 'main_menu'];
    if (alwaysInterrupt.includes(intent) && confidence > 0.7) {
      return true;
    }
    
    // Context-switching intents that interrupt only with high confidence
    const contextSwitchIntents = [
      'order_food', 'parcel_booking', 'search_product', 'track_order',
      'login', 'logout', 'greeting', 'support'
    ];
    if (contextSwitchIntents.includes(intent) && confidence > 0.85) {
      return true;
    }
    
    return false;
  }

  /**
   * Quick heuristic intent check for mid-flow interruption detection.
   * Only detects OBVIOUS, unambiguous intent switches using keywords.
   * This is intentionally limited to high-confidence patterns to avoid
   * false positives that would disrupt active flows.
   */
  private quickHeuristicIntentCheck(message: string): { intent: string; confidence: number } | null {
    const t = message.toLowerCase().trim();

    // Parcel booking - very explicit keywords
    if (/\b(send\s*parcel|book\s*parcel|courier\s*bhej|parcel\s*book)\b/i.test(t)) {
      return { intent: 'parcel_booking', confidence: 0.92 };
    }

    // Order food - very explicit
    if (/\b(order\s*food|food\s*order|khana\s*order|i\s*want\s*to\s*eat)\b/i.test(t)) {
      return { intent: 'order_food', confidence: 0.90 };
    }

    // Track order
    if (/\b(track\s*(my\s*)?order|where\s*is\s*my\s*order|order\s*status)\b/i.test(t)) {
      return { intent: 'track_order', confidence: 0.92 };
    }

    // Cancel/stop - high priority
    if (/^(cancel|stop|exit|quit|ruko|band\s*karo)$/i.test(t)) {
      return { intent: 'cancel', confidence: 0.95 };
    }

    // Help
    if (/^(help|madad|help\s*me)$/i.test(t)) {
      return { intent: 'help', confidence: 0.92 };
    }

    return null;
  }

  /**
   * Get flow-specific help text based on current state
   */
  async getFlowHelp(sessionId: string): Promise<string> {
    const session = await this.sessionService.getSession(sessionId);
    const flowContext = session?.data?.flowContext;
    
    if (!flowContext?.flowId) {
      return 'No active flow. How can I help you today?';
    }
    
    const flow = await this.getFlowById(flowContext.flowId);
    if (!flow) {
      return 'I\'m not sure what we were doing. Let\'s start fresh!';
    }
    
    const currentState = flow.states[flowContext.currentState];
    const flowName = flow.name || flow.id;
    
    // Generate contextual help based on state type
    let helpText = `📋 **${flowName}**\n\n`;
    
    if (currentState?.type === 'wait') {
      helpText += `I'm waiting for your input. ${currentState.description || ''}\n\n`;
    } else if (currentState?.type === 'action') {
      helpText += `Processing your request...\n\n`;
    }
    
    helpText += `**Options:**\n`;
    helpText += `• Type "cancel" to stop this flow\n`;
    helpText += `• Type "back" to go to previous step\n`;
    helpText += `• Type "help" for more options\n`;
    
    return helpText;
  }

  /**
   * Parse buttons from text response
   * Supports [BTN|label|value] format
   */
  private parseButtonsFromText(text: string): { cleanText: string; buttons: Array<{ label: string; value: string; action?: string }> } {
    // Match [BTN|label|value] pattern
    const buttonPattern = /\[BTN\|([^|]+)\|([^\]]+)\]/g;
    const buttons: Array<{ label: string; value: string; action?: string }> = [];
    let cleanText = text;
    
    let match;
    while ((match = buttonPattern.exec(text)) !== null) {
      const label = match[1].trim();
      const value = match[2].trim();
      buttons.push({
        label,
        value,
        action: value, // action same as value for compatibility
      });
    }
    
    // Remove button markers from text
    cleanText = cleanText.replace(buttonPattern, '').trim();
    // Clean up multiple newlines
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    
    return { cleanText, buttons };
  }

  /**
   * Auto-execute action/decision/end states until we reach a state waiting for input.
   * Shared by startFlow() and processMessage() — extracted to eliminate duplication.
   */
  private async autoExecuteStates(
    flow: FlowDefinition,
    context: FlowContext,
    result: { nextState: string | null; completed: boolean; error?: string },
  ): Promise<void> {
    let maxIterations = 20; // Prevent infinite loops
    let iterations = 0;

    while (result.nextState && !result.completed && iterations < maxIterations) {
      iterations++;

      this.logger.debug(
        `🔍 Auto-execution check (iteration ${iterations}): nextState=${result.nextState}, completed=${result.completed}`,
      );

      const nextState = flow.states[result.nextState];
      if (!nextState) {
        this.logger.error(`❌ Next state not found: ${result.nextState}`);
        break;
      }

      // Special handling for 'wait' states: Execute once (to send prompts) then stop
      if (nextState.type === 'wait') {
        this.logger.log(`🔄 Executing wait state actions before stopping: ${result.nextState}`);
        this.contextService.updateState(context, result.nextState);

        const nextResult = await this.stateMachine.executeState(flow, context);
        result.nextState = nextResult.nextState;
        result.completed = nextResult.completed;
        result.error = nextResult.error;

        this.logger.debug(`⏸️ Stopping auto-execution after wait state: ${result.nextState}`);
        break;
      }

      // Auto-execute action, decision, and end states
      if (nextState.type !== 'action' && nextState.type !== 'decision' && nextState.type !== 'end') {
        this.logger.debug(
          `⏸️ Stopping auto-execution at non-action state: ${result.nextState} (type: ${nextState.type})`,
        );
        break;
      }

      this.logger.log(`🔄 Auto-executing next state: ${result.nextState}`);
      this.contextService.updateState(context, result.nextState);

      const nextResult = await this.stateMachine.executeState(flow, context);
      result.nextState = nextResult.nextState;
      result.completed = nextResult.completed;
      result.error = nextResult.error;

      this.logger.debug(
        `🔍 After auto-execution: nextState=${result.nextState}, completed=${result.completed}`,
      );
    }

    if (iterations >= maxIterations) {
      this.logger.error(`❌ Auto-execution loop limit reached! Last state: ${result.nextState}`);
    }
  }

  /**
   * Convert internal error messages to user-friendly messages
   * Prevents leaking technical details to end users
   */
  private getUserFriendlyError(error: string): string {
    const lower = error.toLowerCase();

    // Authentication errors
    if (lower.includes('auth') || lower.includes('login') || lower.includes('token') || lower.includes('unauthorized') || lower.includes('401')) {
      return 'Your session has expired. Please log in again to continue. Type "login" to get started.';
    }

    // Search/product errors
    if (lower.includes('search') || lower.includes('no results') || lower.includes('not found')) {
      return 'I couldn\'t find what you\'re looking for. Could you try rephrasing your search or check the spelling?';
    }

    // Address errors
    if (lower.includes('address') || lower.includes('location') || lower.includes('zone') || lower.includes('store id')) {
      return 'I had trouble with the delivery address. Could you please share your location or type your address again?';
    }

    // Payment errors
    if (lower.includes('payment') || lower.includes('wallet') || lower.includes('razorpay') || lower.includes('insufficient')) {
      return 'There was an issue with the payment. Please check your payment method and try again.';
    }

    // Cart errors
    if (lower.includes('cart') || lower.includes('item') || lower.includes('out of stock')) {
      return 'There was an issue with your cart. Some items may no longer be available. Please review your cart and try again.';
    }

    // Network/API errors
    if (lower.includes('timeout') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('503') || lower.includes('502')) {
      return 'I\'m having trouble connecting right now. Please try again in a moment.';
    }

    // Order placement errors
    if (lower.includes('order') && (lower.includes('fail') || lower.includes('could not'))) {
      return 'I couldn\'t place your order. Please check your details and try again, or type "help" for assistance.';
    }

    // Generic fallback - don't expose internal error
    this.logger.warn(`Unhandled error type shown to user: ${error}`);
    return 'Something went wrong. Please try again, or type "help" if you need assistance.';
  }

  /**
   * Extract response data (message, buttons, cards, metadata) from flow context.
   * Shared by startFlow() and processMessage() — extracted to eliminate duplication.
   */
  private extractResponseFromContext(
    context: FlowContext,
    defaultMessage: string = '',
  ): {
    responseMessage: string;
    responseButtons?: any[];
    responseCards?: any[];
    responseMetadata?: any;
    cards?: any;
  } {
    const lastResponse = this.contextService.get(context, '_last_response');

    // 🐛 FIX BUG-1: Clear _last_response immediately after extraction
    // to prevent stale responses from leaking into subsequent messages
    if (lastResponse) {
      this.contextService.set(context, '_last_response', null);
    }

    let responseMessage: string = defaultMessage;
    let responseButtons: any[] | undefined;
    let responseCards: any[] | undefined;
    let responseMetadata: any | undefined;
    // Only use search_results.cards as fallback when NO response executor ran
    // (i.e., no _last_response). If a response executor ran and produced no cards,
    // that's intentional — don't leak stale search cards into the response.
    let cards: any | undefined;

    if (lastResponse) {
      if (typeof lastResponse === 'object' && lastResponse !== null) {
        let msgText = lastResponse.message ?? '';

        if (typeof msgText === 'string') {
          const { cleanText, buttons: parsedButtons } = this.parseButtonsFromText(msgText);
          responseMessage = cleanText;
          if (parsedButtons.length > 0) {
            responseButtons = [...(lastResponse.buttons || []), ...parsedButtons];
          } else {
            responseButtons = lastResponse.buttons;
          }
        } else if (msgText && typeof msgText === 'object') {
          this.logger.warn(
            `Response message is object instead of string: ${JSON.stringify(msgText).substring(0, 100)}`,
          );
          responseMessage = msgText.text || msgText.content || msgText.message || JSON.stringify(msgText);
          responseButtons = lastResponse.buttons;
        } else {
          responseMessage = String(msgText ?? '');
          responseButtons = lastResponse.buttons;
        }

        responseCards = lastResponse.cards;
        responseMetadata = lastResponse.metadata;
        this.logger.debug(`📦 Extracted metadata from _last_response: ${JSON.stringify(responseMetadata)}`);
      } else if (typeof lastResponse === 'string') {
        const { cleanText, buttons } = this.parseButtonsFromText(lastResponse);
        responseMessage = cleanText;
        if (buttons.length > 0) {
          responseButtons = buttons;
        }
      }
    } else {
      // No response executor ran — fall back to search_results cards from context
      const searchResults = this.contextService.get(context, 'search_results');
      cards = searchResults?.cards || this.contextService.get(context, '_cards');
    }

    return { responseMessage, responseButtons, responseCards, responseMetadata, cards };
  }

  /**
   * Clear flow cache (useful for development)
   */
  clearCache(): void {
    this.flowCache.clear();
    this.cacheExpiry = 0;
    this.logger.log('🗑️ Flow cache cleared');
  }

  /**
   * Trigger holistic profile analysis after flow completion.
   * Analyzes the full conversation to extract patterns that per-message
   * extraction might miss (overall tone, intent patterns, dietary signals).
   */
  private async triggerPostFlowProfileAnalysis(
    sessionId: string,
    context: FlowContext,
  ): Promise<void> {
    if (!this.userProfiling) return;

    const userId = context._system?.userId ? Number(context._system.userId) : null;
    if (!userId || isNaN(userId)) return;

    // Cooldown: skip if analyzed within last 30 minutes
    const lastAnalysis = this.profileAnalysisCooldown.get(userId) || 0;
    if (Date.now() - lastAnalysis < this.PROFILE_ANALYSIS_COOLDOWN_MS) return;

    // Get conversation history from session
    const session = await this.sessionService.getSession(sessionId);
    const history = session?.data?.conversation_history;
    if (!Array.isArray(history) || history.length < 3) return;

    const phone = session?.phoneNumber || context._system?.phoneNumber || '';

    // Format history for the profiling service
    const conversationHistory = history.map((msg: any) => ({
      role: typeof msg === 'object' ? (msg.role || 'user') : 'user',
      content: typeof msg === 'object' ? (msg.content || String(msg)) : String(msg),
    }));

    this.profileAnalysisCooldown.set(userId, Date.now());

    this.logger.log(`🧠 Triggering post-flow profile analysis for user ${userId}`);
    await this.userProfiling.updateProfileFromConversation({
      userId,
      phone,
      conversationHistory,
      sessionId,
    });
  }
}
