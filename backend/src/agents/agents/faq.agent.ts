import { Injectable } from '@nestjs/common';
import { BaseAgent } from '../services/base-agent.service';
import { LlmService } from '../../llm/services/llm.service';
import { FunctionExecutorService } from '../services/function-executor.service';
import { AgentType, ModuleType, AgentConfig, AgentContext, FunctionDefinition } from '../types/agent.types';

/**
 * FAQ Agent
 * 
 * Handles general questions and help:
 * - Greetings (hi, hello, hey)
 * - General help and support
 * - Platform information
 * - How-to questions
 * - Escalation to human support
 * 
 * Works across ALL modules: food, ecom, parcel, ride, health, rooms, movies, services
 */
@Injectable()
export class FAQAgent extends BaseAgent {
  getConfig(): AgentConfig {
    return {
      id: 'faq-agent',
      type: AgentType.FAQ,
      name: 'FAQ Agent',
      description: 'Handles greetings, general questions, and platform information',
      modules: [
        ModuleType.FOOD,
        ModuleType.ECOM,
        ModuleType.PARCEL,
        ModuleType.GROCERY,
        ModuleType.PHARMACY,
      ],
      systemPrompt: '', // Set dynamically
      temperature: 0.6,
      maxTokens: 1500,
      functions: this.getFunctions(),
      enabled: true,
    };
  }

  getSystemPrompt(context: AgentContext): string {
    const { getPersonalityPrompt } = require('../config/personality.config');
    const basePrompt = getPersonalityPrompt(context.module);

    return `${basePrompt}

FAQ & HELP ROLE:
You are a friendly FAQ assistant.

Current user: ${context.phoneNumber}
Current module: ${context.module || 'general'}

**Mangwale Services:**
1. **Food Delivery** - Order from restaurants, cafes, and cloud kitchens
2. **E-Commerce** - Shop for groceries, electronics, fashion, and more
3. **Parcel Services** - Send packages locally and nationwide
4. **Ride Booking** - Book cabs and bike rides
5. **Healthcare** - Book doctor appointments, order medicines
6. **Room Booking** - Hotels, hostels, PG accommodations
7. **Movie Tickets** - Book cinema tickets and showtimes
8. **Local Services** - Plumbing, cleaning, repairs, and more

Your role:
- Greet users warmly
- Answer general questions about our services
- Explain how to use different features
- Provide helpful information
- Escalate complex issues to human support
- Be friendly, patient, and informative

**Common Questions:**
- "How do I order food?" → Explain food module
- "What services do you offer?" → List all 8 services
- "How do I track my order?" → Direct to order agent
- "I have a problem" → Offer help or escalate

**GROUNDING RULES (STRICT — availability claims):**
- You have NO access to the live store/restaurant/product catalog. You CANNOT know whether a specific store, restaurant, or brand is on Mangwale.
- NEVER state that a specific store/restaurant/brand IS or IS NOT available on Mangwale. Not even hedged ("should be available"). This is a hard rule.
- If the user asks about a specific store or product, be honest: you need to search to check. Invite them to search it, e.g.: "Mujhe exact store check karne ke liye search karna hoga — aap type karein: <store name>" (the platform will run a real catalog search on their message).
- Only the 8 service categories above may be described as offered. Specific merchants/items must come from real search results, never from you.

Be conversational, warm, and helpful!`;
  }

  getFunctions(): FunctionDefinition[] {
    return [
      {
        name: 'get_faq_answer',
        description: 'Get answer to frequently asked questions',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The FAQ question to answer',
            },
            category: {
              type: 'string',
              description: 'Category: general, food, ecom, parcel, ride, health, rooms, movies, services',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'escalate_to_human',
        description: 'Escalate the conversation to a human support agent',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Reason for escalation',
            },
            urgency: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Urgency level',
            },
          },
          required: ['reason'],
        },
      },
      {
        name: 'get_service_info',
        description: 'Get detailed information about a specific Mangwale service',
        parameters: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              enum: ['food', 'ecom', 'parcel', 'ride', 'health', 'rooms', 'movies', 'services'],
              description: 'The service to get information about',
            },
          },
          required: ['service'],
        },
      },
    ];
  }
}
