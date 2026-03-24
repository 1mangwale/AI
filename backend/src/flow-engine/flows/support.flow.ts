import { FlowDefinition } from '../types/flow.types';

/**
 * Customer Support Flow
 * 
 * Handles:
 * - FAQ and common questions
 * - Issue reporting
 * - Ticket creation
 * - Escalation to human support
 */
export const supportFlow: FlowDefinition = {
  id: 'support_v1',
  name: 'Customer Support Flow',
  description: 'Handle customer support requests, FAQs, and issue reporting',
  module: 'general',
  // EXPANDED: Now properly handles complaints and issues that were in feedback
  trigger: 'contact_support|support|complain|complaint|problem|issue|dikkat|help karo|agent|human|talk to someone|baat karo|call me',
  version: '1.0.0',
  enabled: true,
  initialState: 'init',
  finalStates: ['end_flow'],
  
  contextSchema: {
    issue_type: { type: 'string', required: false },
    issue_description: { type: 'string', required: false },
    order_id: { type: 'number', required: false },
    ticket_id: { type: 'string', required: false },
  },
  
  states: {
    // Initial state - show support options
    init: {
      type: 'wait',
      description: 'Welcome to support and show options',
      onEntry: [
        {
          id: 'welcome',
          executor: 'response',
          config: {
            message: '🛟 **Customer Support**\n\nHow can I help you today?',
            buttons: [
              { id: 'faq', title: '❓ FAQs', payload: 'show faq' },
              { id: 'order_issue', title: '📦 Order Issue', payload: 'order issue' },
              { id: 'payment_issue', title: '💳 Payment Issue', payload: 'payment issue' },
              { id: 'delivery_issue', title: '🚚 Delivery Issue', payload: 'delivery issue' },
              { id: 'other', title: '💬 Other', payload: 'other issue' },
              { id: 'human', title: '👤 Talk to Human', payload: 'talk to human' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'route_issue',
      },
    },

    // Route based on issue type
    route_issue: {
      type: 'decision',
      description: 'Route to appropriate support handler',
      conditions: [
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("faq")',
          event: 'faq',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("order")',
          event: 'order_issue',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("payment")',
          event: 'payment_issue',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("delivery")',
          event: 'delivery_issue',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("human") || context._user_message.toLowerCase().includes("agent") || context._user_message.toLowerCase().includes("person"))',
          event: 'human',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("back") || context._user_message.toLowerCase().includes("menu"))',
          event: 'back',
        },
      ],
      transitions: {
        faq: 'show_faq',
        order_issue: 'order_issue_handler',
        payment_issue: 'payment_issue_handler',
        delivery_issue: 'delivery_issue_handler',
        human: 'escalate_to_human',
        back: 'end_flow',
        default: 'other_issue_handler',
      },
    },

    // Show FAQ
    show_faq: {
      type: 'wait',
      description: 'Display frequently asked questions',
      onEntry: [
        {
          id: 'faq_list',
          executor: 'response',
          config: {
            message: `❓ **Frequently Asked Questions**

**1. How do I track my order?**
Say "track my order" or go to Order Tracking from the main menu.

**2. What payment methods do you accept?**
We accept Cash on Delivery (COD), UPI, and Cards.

**3. How do I cancel my order?**
Say "cancel order" or go to Order Tracking → Cancel Order.

**4. What is your delivery time?**
Delivery usually takes 30-45 minutes depending on distance.

**5. How do I change my delivery address?**
You can update your address before confirming the order.

**6. How do I get a refund?**
Refunds are processed within 5-7 business days after cancellation.

Need more help?`,
            buttons: [
              { id: 'order', title: '📦 Order Issue', payload: 'order issue' },
              { id: 'payment', title: '💳 Payment Issue', payload: 'payment issue' },
              { id: 'human', title: '👤 Talk to Human', payload: 'talk to human' },
              { id: 'back', title: '🔙 Back', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'route_issue',
      },
    },

    // Order issue handler
    order_issue_handler: {
      type: 'wait',
      description: 'Handle order-related issues',
      onEntry: [
        {
          id: 'set_issue_type',
          executor: 'response',
          config: {
            message: '',
            saveToContext: { issue_type: 'order' },
          },
        },
        {
          id: 'ask_order_issue',
          executor: 'response',
          config: {
            message: '📦 **Order Issue**\n\nWhat issue are you facing with your order?',
            buttons: [
              { id: 'wrong_items', title: '🔄 Wrong Items', payload: 'received wrong items' },
              { id: 'missing_items', title: '❌ Missing Items', payload: 'missing items in order' },
              { id: 'quality', title: '👎 Quality Issue', payload: 'quality issue with food' },
              { id: 'late', title: '⏰ Order Late', payload: 'order is late' },
              { id: 'not_received', title: '📭 Not Received', payload: 'order not received' },
              { id: 'other', title: '💬 Other', payload: 'other order issue' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'collect_issue_details',
      },
    },

    // Payment issue handler
    payment_issue_handler: {
      type: 'wait',
      description: 'Handle payment-related issues',
      onEntry: [
        {
          id: 'set_issue_type',
          executor: 'response',
          config: {
            message: '',
            saveToContext: { issue_type: 'payment' },
          },
        },
        {
          id: 'ask_payment_issue',
          executor: 'response',
          config: {
            message: '💳 **Payment Issue**\n\nWhat payment issue are you facing?',
            buttons: [
              { id: 'double_charged', title: '💰 Double Charged', payload: 'double charged' },
              { id: 'refund_pending', title: '🔄 Refund Pending', payload: 'refund not received' },
              { id: 'payment_failed', title: '❌ Payment Failed', payload: 'payment failed but order placed' },
              { id: 'wrong_amount', title: '💵 Wrong Amount', payload: 'charged wrong amount' },
              { id: 'other', title: '💬 Other', payload: 'other payment issue' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'collect_issue_details',
      },
    },

    // Delivery issue handler
    delivery_issue_handler: {
      type: 'wait',
      description: 'Handle delivery-related issues',
      onEntry: [
        {
          id: 'set_issue_type',
          executor: 'response',
          config: {
            message: '',
            saveToContext: { issue_type: 'delivery' },
          },
        },
        {
          id: 'ask_delivery_issue',
          executor: 'response',
          config: {
            message: '🚚 **Delivery Issue**\n\nWhat delivery issue are you facing?',
            buttons: [
              { id: 'wrong_address', title: '📍 Wrong Address', payload: 'delivered to wrong address' },
              { id: 'delivery_person', title: '👤 Delivery Person Issue', payload: 'issue with delivery person' },
              { id: 'damaged', title: '📦 Damaged Package', payload: 'package was damaged' },
              { id: 'not_delivered', title: '❌ Not Delivered', payload: 'order shows delivered but not received' },
              { id: 'other', title: '💬 Other', payload: 'other delivery issue' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'collect_issue_details',
      },
    },

    // Other issue handler
    other_issue_handler: {
      type: 'wait',
      description: 'Handle other issues',
      onEntry: [
        {
          id: 'set_issue_type',
          executor: 'response',
          config: {
            message: '',
            saveToContext: { issue_type: 'other' },
          },
        },
        {
          id: 'ask_issue',
          executor: 'response',
          config: {
            message: '💬 Please describe your issue in detail.\n\nI\'ll do my best to help, or connect you with our support team.',
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'collect_issue_details',
      },
    },

    // Collect issue details
    collect_issue_details: {
      type: 'action',
      description: 'Store the issue description',
      actions: [
        {
          id: 'store_description',
          executor: 'response',
          config: {
            message: '📝 Got it. Let me look into this for you.',
            saveToContext: { issue_description: '{{_user_message}}' },
            event: 'success',
          },
        },
      ],
      transitions: {
        success: 'ask_order_id',
      },
    },

    // Ask for order ID
    ask_order_id: {
      type: 'wait',
      description: 'Ask for order ID if relevant',
      onEntry: [
        {
          id: 'ask_order',
          executor: 'response',
          config: {
            message: '📋 Do you have an order ID related to this issue?\n\nYou can find it in your order confirmation or order history.',
            buttons: [
              { id: 'yes', title: '✅ Yes, I have it', payload: 'yes i have order id' },
              { id: 'no', title: '❌ No / Don\'t know', payload: 'no order id' },
              { id: 'find', title: '🔍 Help me find it', payload: 'track order' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'process_order_id',
      },
    },

    // Process order ID
    process_order_id: {
      type: 'decision',
      description: 'Check if user has order ID',
      conditions: [
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("no")',
          event: 'no_order_id',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("track")',
          event: 'find_order',
        },
        {
          expression: 'context._user_message && /\\d{4,}/.test(context._user_message)',
          event: 'has_order_id',
        },
      ],
      transitions: {
        has_order_id: 'extract_order_id',
        find_order: 'end_flow', // Will trigger order tracking flow
        no_order_id: 'create_ticket',
        default: 'ask_order_number',
      },
    },

    // Ask for order number
    ask_order_number: {
      type: 'wait',
      description: 'Ask user to enter order number',
      onEntry: [
        {
          id: 'enter_order',
          executor: 'response',
          config: {
            message: '🔢 Please enter your order number:',
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'extract_order_id',
      },
    },

    // Extract order ID
    extract_order_id: {
      type: 'action',
      description: 'Extract order ID from message',
      actions: [
        {
          id: 'extract',
          executor: 'llm',
          config: {
            systemPrompt: 'Extract order ID (number) from message. Return JSON with "order_id" (number or null).',
            prompt: 'Message: "{{_user_message}}"',
            temperature: 0,
            maxTokens: 30,
            parseJson: true,
          },
          output: 'extracted_order',
        },
      ],
      transitions: {
        success: 'create_ticket',
        error: 'create_ticket',
      },
    },

    // Create support ticket — persisted to DB + notifies support team via WhatsApp
    create_ticket: {
      type: 'action',
      description: 'Create a support ticket',
      actions: [
        {
          id: 'persist_ticket',
          executor: 'support_ticket',
          config: {
            action: 'create',
            phone: '{{phone_number}}',
            userId: '{{user_id}}',
            issueType: '{{issue_type}}',
            description: '{{issue_description}}',
            orderId: '{{order_id}}',
            conversationSummary: '{{_user_message}}',
          },
          output: 'ticket_id',
          onError: 'continue',
        },
      ],
      transitions: {
        success: 'try_auto_resolve',
        error: 'try_auto_resolve',
        default: 'try_auto_resolve',
      },
    },

    // Try to auto-resolve common issues
    try_auto_resolve: {
      type: 'action',
      description: 'Try to automatically resolve the issue',
      actions: [
        {
          id: 'analyze_issue',
          executor: 'llm',
          config: {
            systemPrompt: `You are a support assistant. Analyze the issue and determine if it can be auto-resolved.
Return JSON with:
- "can_resolve": boolean (true if this is a simple issue with a standard answer)
- "resolution": string (the resolution message if can_resolve is true)
- "needs_escalation": boolean (true if this needs human intervention)

Common auto-resolvable issues:
- Refund status → "Refunds are processed within 5-7 business days"
- Order tracking → Suggest tracking feature
- Late order → Apologize and explain possible delays
- Wrong items → Offer to connect with support for refund/replacement`,
            prompt: `Issue Type: {{issue_type}}
Description: {{issue_description}}
Order ID: {{order_id}}

JSON:`,
            temperature: 0.2,
            maxTokens: 200,
            parseJson: true,
          },
          output: 'resolution_analysis',
        },
      ],
      transitions: {
        success: 'check_resolution',
        error: 'escalate_to_human',
      },
    },

    // Check if we can auto-resolve
    check_resolution: {
      type: 'decision',
      description: 'Check if issue can be auto-resolved',
      conditions: [
        {
          expression: 'context.resolution_analysis && context.resolution_analysis.can_resolve === true',
          event: 'auto_resolved',
        },
        {
          expression: 'context.resolution_analysis && context.resolution_analysis.needs_escalation === true',
          event: 'escalate',
        },
      ],
      transitions: {
        auto_resolved: 'show_resolution',
        escalate: 'escalate_to_human',
        default: 'offer_options',
      },
    },

    // Show auto-resolution
    show_resolution: {
      type: 'wait',
      description: 'Show the automated resolution',
      onEntry: [
        {
          id: 'show_answer',
          executor: 'response',
          config: {
            message: '✅ **Here\'s what I found:**\n\n{{resolution_analysis.resolution}}\n\n**Ticket ID:** {{ticket_id}}\n\nDid this resolve your issue?',
            buttons: [
              { id: 'yes', title: '✅ Yes, resolved', payload: 'yes resolved' },
              { id: 'no', title: '❌ No, need more help', payload: 'need more help' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'check_satisfied',
      },
    },

    // Check if customer is satisfied
    check_satisfied: {
      type: 'decision',
      description: 'Check if issue is resolved',
      conditions: [
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("yes") || context._user_message.toLowerCase().includes("resolved") || context._user_message.toLowerCase().includes("thanks"))',
          event: 'satisfied',
        },
      ],
      transitions: {
        satisfied: 'resolution_success',
        default: 'escalate_to_human',
      },
    },

    // Resolution success
    resolution_success: {
      type: 'wait',
      description: 'Issue resolved successfully',
      onEntry: [
        {
          id: 'thanks',
          executor: 'response',
          config: {
            message: '🎉 Great! I\'m glad I could help.\n\nIs there anything else you need?',
            buttons: [
              { id: 'new_issue', title: '🛟 Another Issue', payload: 'contact support' },
              { id: 'order', title: '🍔 Order Food', payload: 'order food' },
              { id: 'back', title: '🔙 Back to Menu', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'end_flow',
      },
    },

    // Offer options when unsure
    offer_options: {
      type: 'wait',
      description: 'Offer next steps',
      onEntry: [
        {
          id: 'options',
          executor: 'response',
          config: {
            message: '🤔 I\'ve logged your issue.\n\n**Ticket ID:** {{ticket_id}}\n\nWhat would you like to do next?',
            buttons: [
              { id: 'human', title: '👤 Talk to Human', payload: 'talk to human' },
              { id: 'email', title: '📧 Email Support', payload: 'email support' },
              { id: 'wait', title: '⏳ Wait for Callback', payload: 'wait for callback' },
              { id: 'back', title: '🔙 Back', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'handle_choice',
      },
    },

    // Handle user choice
    handle_choice: {
      type: 'decision',
      description: 'Handle user\'s next step choice',
      conditions: [
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("human") || context._user_message.toLowerCase().includes("talk"))',
          event: 'human',
        },
        {
          expression: 'context._user_message && context._user_message.toLowerCase().includes("email")',
          event: 'email',
        },
        {
          expression: 'context._user_message && (context._user_message.toLowerCase().includes("wait") || context._user_message.toLowerCase().includes("callback"))',
          event: 'callback',
        },
      ],
      transitions: {
        human: 'escalate_to_human',
        email: 'show_email_info',
        callback: 'callback_confirmation',
        default: 'end_flow',
      },
    },

    // Escalate to human
    escalate_to_human: {
      type: 'wait',
      description: 'Escalate to human support',
      onEntry: [
        {
          id: 'escalation_msg',
          executor: 'response',
          config: {
            message: `👤 **Connecting to Human Support**

**Ticket ID:** {{ticket_id}}
**Issue:** {{issue_type}}

A support agent has been notified and will reach out to you shortly.

📞 **Direct Support:** +91-8888-XXXX-XX
📧 **Email:** support@mangwale.com
⏰ **Hours:** 9 AM - 9 PM IST

Please keep your ticket ID handy for faster resolution.`,
            buttons: [
              { id: 'call', title: '📞 Call Now', payload: 'call support' },
              { id: 'back', title: '🔙 Back to Menu', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'end_flow',
      },
    },

    // Show email info
    show_email_info: {
      type: 'wait',
      description: 'Show email support information',
      onEntry: [
        {
          id: 'email_info',
          executor: 'response',
          config: {
            message: `📧 **Email Support**

Send your issue to: **support@mangwale.com**

Please include:
- Ticket ID: {{ticket_id}}
- Order ID: {{order_id}}
- Description of issue

We typically respond within 24 hours.`,
            buttons: [
              { id: 'back', title: '🔙 Back to Menu', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'end_flow',
      },
    },

    // Callback confirmation
    callback_confirmation: {
      type: 'wait',
      description: 'Confirm callback request',
      onEntry: [
        {
          id: 'callback_msg',
          executor: 'response',
          config: {
            message: `📞 **Callback Requested**

**Ticket ID:** {{ticket_id}}

Our support team will call you within 2-4 hours during business hours (9 AM - 9 PM IST).

We'll call you on your registered phone number.`,
            buttons: [
              { id: 'back', title: '🔙 Back to Menu', payload: 'back to menu' },
            ],
          },
        },
      ],
      actions: [],
      transitions: {
        user_message: 'end_flow',
      },
    },

    // End flow
    end_flow: {
      type: 'end',
      description: 'End the support flow',
      actions: [],
      transitions: {},
    },
  },
  
  metadata: {
    author: 'Mangwale AI Team',
    createdAt: '2025-01-01',
    tags: ['support', 'help', 'faq', 'ticket'],
    priority: 60,
  },
};
