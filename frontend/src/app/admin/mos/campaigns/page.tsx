'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, CloudRain, PartyPopper, Trophy,
  Plus, ToggleLeft, ToggleRight, Clock, Zap, Calendar,
  X, Check, ChevronDown, ChevronUp, Thermometer, Wind,
  Sun, CloudSnow, Droplets, Eye,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface CampaignTrigger {
  id: string;
  triggerType: string;
  triggerName: string;
  conditions: Record<string, any>;
  campaignTemplate: Record<string, any>;
  audienceFilter: Record<string, any> | null;
  cooldownHours: number;
  requiresApproval: boolean;
  active: boolean;
  lastFiredAt: string | null;
  fireCount: number;
}

interface FestivalInfo {
  name: string;
  date: string;
  preDays: number;
  items: string[];
  campaignMessage: string;
  daysUntil: number;
  shouldTrigger: boolean;
}

interface ScheduledEvent {
  id: string;
  name: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  campaignMessage: string;
  suggestedItems: string[];
  sendBeforeHours: number;
  fired: boolean;
  firedAt: string | null;
}

type Tab = 'weather' | 'festivals' | 'events';

// ---- New Trigger Form State ----

interface NewTriggerForm {
  triggerName: string;
  conditionType: string;
  conditionOperator: string;
  conditionValue: string;
  templateTitle: string;
  templateMessage: string;
  templateItems: string;
  cooldownHours: number;
  requiresApproval: boolean;
}

const EMPTY_TRIGGER_FORM: NewTriggerForm = {
  triggerName: '',
  conditionType: 'temperature',
  conditionOperator: 'gte',
  conditionValue: '',
  templateTitle: '',
  templateMessage: '',
  templateItems: '',
  cooldownHours: 24,
  requiresApproval: true,
};

// ---- New Event Form State ----

interface NewEventForm {
  name: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  campaignMessage: string;
  suggestedItems: string;
  sendBeforeHours: number;
}

const EMPTY_EVENT_FORM: NewEventForm = {
  name: '',
  eventType: 'cricket',
  eventDate: '',
  eventTime: '19:00',
  campaignMessage: '',
  suggestedItems: '',
  sendBeforeHours: 2,
};

// ---- Condition Icons ----

const CONDITION_ICONS: Record<string, React.ReactNode> = {
  temperature: <Thermometer size={14} />,
  humidity: <Droplets size={14} />,
  wind: <Wind size={14} />,
  rain: <CloudRain size={14} />,
  snow: <CloudSnow size={14} />,
  uv: <Sun size={14} />,
};

const CONDITION_LABELS: Record<string, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  wind: 'Wind Speed',
  rain: 'Rainfall',
  snow: 'Snowfall',
  uv: 'UV Index',
};

const OPERATOR_LABELS: Record<string, string> = {
  gte: '>=',
  lte: '<=',
  gt: '>',
  lt: '<',
  eq: '=',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  cricket: 'bg-green-100 text-green-700',
  football: 'bg-blue-100 text-blue-700',
  ipl: 'bg-purple-100 text-purple-700',
  holiday: 'bg-orange-100 text-orange-700',
  sale: 'bg-red-100 text-red-700',
  local: 'bg-teal-100 text-teal-700',
  other: 'bg-gray-100 text-gray-600',
};

// ---- Main Page Component ----

export default function CampaignBuilderPage() {
  const [activeTab, setActiveTab] = useState<Tab>('weather');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [triggers, setTriggers] = useState<CampaignTrigger[]>([]);
  const [festivals, setFestivals] = useState<FestivalInfo[]>([]);
  const [festivalDays, setFestivalDays] = useState(30);
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [eventDays, setEventDays] = useState(30);

  // Form states
  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [triggerForm, setTriggerForm] = useState<NewTriggerForm>(EMPTY_TRIGGER_FORM);
  const [showEventForm, setShowEventForm] = useState(false);
  const [eventForm, setEventForm] = useState<NewEventForm>(EMPTY_EVENT_FORM);
  const [submitting, setSubmitting] = useState(false);

  // Expanded trigger detail
  const [expandedTriggerId, setExpandedTriggerId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [activeTab, festivalDays, eventDays]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'weather') {
        const data = await mangwaleAIClient.get<CampaignTrigger[]>(
          '/mos/campaigns/triggers?type=weather',
        ).catch(() => [] as CampaignTrigger[]);
        setTriggers(data);
      } else if (activeTab === 'festivals') {
        const data = await mangwaleAIClient.get<FestivalInfo[]>(
          `/mos/campaigns/festivals?days=${festivalDays}`,
        ).catch(() => [] as FestivalInfo[]);
        setFestivals(data);
      } else if (activeTab === 'events') {
        const data = await mangwaleAIClient.get<ScheduledEvent[]>(
          `/mos/campaigns/events?days=${eventDays}`,
        ).catch(() => [] as ScheduledEvent[]);
        setEvents(data);
      }
    } catch (err: any) {
      console.error('Failed to load campaign data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTrigger = async (trigger: CampaignTrigger) => {
    try {
      await mangwaleAIClient.patch(`/mos/campaigns/triggers/${trigger.id}`, {
        active: !trigger.active,
      });
      setTriggers((prev) =>
        prev.map((t) =>
          t.id === trigger.id ? { ...t, active: !t.active } : t,
        ),
      );
    } catch (err: any) {
      setError(err.message || 'Failed to toggle trigger');
    }
  };

  const handleCreateTrigger = async () => {
    if (!triggerForm.triggerName || !triggerForm.conditionValue || !triggerForm.templateMessage) {
      setError('Please fill in trigger name, condition value, and campaign message');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        triggerType: 'weather',
        triggerName: triggerForm.triggerName,
        conditions: {
          [triggerForm.conditionType]: {
            operator: triggerForm.conditionOperator,
            value: parseFloat(triggerForm.conditionValue),
          },
        },
        campaignTemplate: {
          title: triggerForm.templateTitle || triggerForm.triggerName,
          message: triggerForm.templateMessage,
          suggestedItems: triggerForm.templateItems
            ? triggerForm.templateItems.split(',').map((s) => s.trim()).filter(Boolean)
            : [],
        },
        cooldownHours: triggerForm.cooldownHours,
        requiresApproval: triggerForm.requiresApproval,
      };

      await mangwaleAIClient.post('/mos/campaigns/triggers', payload);
      setTriggerForm(EMPTY_TRIGGER_FORM);
      setShowTriggerForm(false);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to create trigger');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateEvent = async () => {
    if (!eventForm.name || !eventForm.eventDate || !eventForm.campaignMessage) {
      setError('Please fill in event name, date, and campaign message');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: eventForm.name,
        eventType: eventForm.eventType,
        eventDate: eventForm.eventDate,
        eventTime: eventForm.eventTime,
        campaignMessage: eventForm.campaignMessage,
        suggestedItems: eventForm.suggestedItems
          ? eventForm.suggestedItems.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        sendBeforeHours: eventForm.sendBeforeHours,
      };

      await mangwaleAIClient.post('/mos/campaigns/events', payload);
      setEventForm(EMPTY_EVENT_FORM);
      setShowEventForm(false);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to create event');
    } finally {
      setSubmitting(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'weather', label: 'Weather Triggers', icon: <CloudRain size={16} /> },
    { id: 'festivals', label: 'Festival Calendar', icon: <PartyPopper size={16} /> },
    { id: 'events', label: 'Events & Sports', icon: <Trophy size={16} /> },
  ];

  const timeAgo = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Campaign Builder</h1>
            <p className="text-green-100">
              Weather triggers, festival campaigns, and event-based promotions
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all disabled:opacity-50"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200 pb-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-t-lg font-medium text-sm transition-all ${
              activeTab === tab.id
                ? 'bg-white border-2 border-b-0 border-gray-200 text-[#059211]'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
          <span className="text-red-800 flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600"
          >
            <X size={16} />
          </button>
          <button
            onClick={loadData}
            className="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-48">
          <RefreshCw className="animate-spin text-[#059211]" size={48} />
        </div>
      )}

      {/* Tab Content */}
      {!loading && !error && (
        <>
          {activeTab === 'weather' && (
            <WeatherTriggersTab
              triggers={triggers}
              showForm={showTriggerForm}
              form={triggerForm}
              submitting={submitting}
              expandedId={expandedTriggerId}
              onToggleExpand={(id) =>
                setExpandedTriggerId(expandedTriggerId === id ? null : id)
              }
              onShowForm={() => setShowTriggerForm(true)}
              onHideForm={() => {
                setShowTriggerForm(false);
                setTriggerForm(EMPTY_TRIGGER_FORM);
              }}
              onFormChange={(updates) =>
                setTriggerForm((prev) => ({ ...prev, ...updates }))
              }
              onSubmit={handleCreateTrigger}
              onToggle={handleToggleTrigger}
              timeAgo={timeAgo}
            />
          )}
          {activeTab === 'festivals' && (
            <FestivalCalendarTab
              festivals={festivals}
              days={festivalDays}
              onDaysChange={setFestivalDays}
              formatDate={formatDate}
            />
          )}
          {activeTab === 'events' && (
            <EventsTab
              events={events}
              days={eventDays}
              onDaysChange={setEventDays}
              showForm={showEventForm}
              form={eventForm}
              submitting={submitting}
              onShowForm={() => setShowEventForm(true)}
              onHideForm={() => {
                setShowEventForm(false);
                setEventForm(EMPTY_EVENT_FORM);
              }}
              onFormChange={(updates) =>
                setEventForm((prev) => ({ ...prev, ...updates }))
              }
              onSubmit={handleCreateEvent}
              formatDate={formatDate}
              timeAgo={timeAgo}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Weather Triggers Tab ----

function WeatherTriggersTab({
  triggers,
  showForm,
  form,
  submitting,
  expandedId,
  onToggleExpand,
  onShowForm,
  onHideForm,
  onFormChange,
  onSubmit,
  onToggle,
  timeAgo,
}: {
  triggers: CampaignTrigger[];
  showForm: boolean;
  form: NewTriggerForm;
  submitting: boolean;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onShowForm: () => void;
  onHideForm: () => void;
  onFormChange: (updates: Partial<NewTriggerForm>) => void;
  onSubmit: () => void;
  onToggle: (trigger: CampaignTrigger) => void;
  timeAgo: (d: string | null) => string;
}) {
  const activeTriggers = triggers.filter((t) => t.active).length;
  const totalFired = triggers.reduce((sum, t) => sum + t.fireCount, 0);

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <CloudRain size={16} /> Total Triggers
          </div>
          <p className="text-2xl font-bold text-gray-900">{triggers.length}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-green-500 text-sm mb-1">
            <Zap size={16} /> Active
          </div>
          <p className="text-2xl font-bold text-green-600">{activeTriggers}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-blue-500 text-sm mb-1">
            <Zap size={16} /> Total Fires
          </div>
          <p className="text-2xl font-bold text-blue-600">{totalFired}</p>
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Weather Triggers</h2>
        {!showForm && (
          <button
            onClick={onShowForm}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            Add Trigger
          </button>
        )}
      </div>

      {/* New Trigger Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">New Weather Trigger</h3>
            <button
              onClick={onHideForm}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Trigger Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trigger Name
              </label>
              <input
                type="text"
                value={form.triggerName}
                onChange={(e) => onFormChange({ triggerName: e.target.value })}
                placeholder="e.g., Hot Day Deals"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Condition Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Condition Type
              </label>
              <select
                value={form.conditionType}
                onChange={(e) => onFormChange({ conditionType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              >
                <option value="temperature">Temperature (C)</option>
                <option value="humidity">Humidity (%)</option>
                <option value="wind">Wind Speed (km/h)</option>
                <option value="rain">Rainfall (mm)</option>
                <option value="snow">Snowfall (mm)</option>
                <option value="uv">UV Index</option>
              </select>
            </div>

            {/* Operator + Value */}
            <div className="flex gap-2">
              <div className="w-24">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Operator
                </label>
                <select
                  value={form.conditionOperator}
                  onChange={(e) => onFormChange({ conditionOperator: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
                >
                  <option value="gte">&gt;=</option>
                  <option value="lte">&lt;=</option>
                  <option value="gt">&gt;</option>
                  <option value="lt">&lt;</option>
                  <option value="eq">=</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Value
                </label>
                <input
                  type="number"
                  value={form.conditionValue}
                  onChange={(e) => onFormChange({ conditionValue: e.target.value })}
                  placeholder="e.g., 38"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
                />
              </div>
            </div>

            {/* Cooldown */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cooldown (hours)
              </label>
              <input
                type="number"
                value={form.cooldownHours}
                onChange={(e) => onFormChange({ cooldownHours: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Campaign Title */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Campaign Title
              </label>
              <input
                type="text"
                value={form.templateTitle}
                onChange={(e) => onFormChange({ templateTitle: e.target.value })}
                placeholder="e.g., Beat the Heat!"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Campaign Message */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Campaign Message
              </label>
              <textarea
                value={form.templateMessage}
                onChange={(e) => onFormChange({ templateMessage: e.target.value })}
                placeholder="e.g., It's scorching outside! Cool down with refreshing drinks and ice cream delivered to your door."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>

            {/* Suggested Items */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Suggested Items (comma-separated)
              </label>
              <input
                type="text"
                value={form.templateItems}
                onChange={(e) => onFormChange({ templateItems: e.target.value })}
                placeholder="e.g., Cold Coffee, Ice Cream, Lassi, Milkshake"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Requires Approval */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onFormChange({ requiresApproval: !form.requiresApproval })}
                className="flex items-center gap-2 text-sm text-gray-700"
              >
                {form.requiresApproval ? (
                  <ToggleRight size={24} className="text-[#059211]" />
                ) : (
                  <ToggleLeft size={24} className="text-gray-400" />
                )}
                Requires approval before sending
              </button>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={onHideForm}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                <Check size={16} />
              )}
              Create Trigger
            </button>
          </div>
        </div>
      )}

      {/* Trigger List */}
      {triggers.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <CloudRain className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No weather triggers configured yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Create a trigger to automatically send campaigns based on weather conditions
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {triggers.map((trigger) => (
            <div
              key={trigger.id}
              className={`bg-white rounded-xl shadow-md border-2 transition-colors ${
                trigger.active
                  ? 'border-green-100 hover:border-green-200'
                  : 'border-gray-100 hover:border-gray-200'
              }`}
            >
              {/* Trigger Row */}
              <div
                className="p-4 cursor-pointer"
                onClick={() => onToggleExpand(trigger.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Active Toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(trigger);
                      }}
                      title={trigger.active ? 'Deactivate' : 'Activate'}
                    >
                      {trigger.active ? (
                        <ToggleRight size={28} className="text-[#059211]" />
                      ) : (
                        <ToggleLeft size={28} className="text-gray-300" />
                      )}
                    </button>

                    {/* Name and Conditions */}
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {trigger.triggerName}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {Object.entries(trigger.conditions).map(
                          ([key, val]: [string, any]) => (
                            <span
                              key={key}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium"
                            >
                              {CONDITION_ICONS[key] || <Thermometer size={14} />}
                              {CONDITION_LABELS[key] || key}{' '}
                              {OPERATOR_LABELS[val?.operator] || val?.operator}{' '}
                              {val?.value}
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* Approval badge */}
                    {trigger.requiresApproval && (
                      <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded font-medium">
                        Approval Required
                      </span>
                    )}

                    {/* Stats */}
                    <div className="text-right">
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Zap size={12} />
                        {trigger.fireCount} fires
                      </div>
                      <div className="flex items-center gap-1 text-xs text-gray-400 mt-0.5">
                        <Clock size={12} />
                        {timeAgo(trigger.lastFiredAt)}
                      </div>
                    </div>

                    {/* Expand */}
                    {expandedId === trigger.id ? (
                      <ChevronUp size={16} className="text-gray-400" />
                    ) : (
                      <ChevronDown size={16} className="text-gray-400" />
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded Detail */}
              {expandedId === trigger.id && (
                <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Campaign Template Preview */}
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
                        <Eye size={12} /> Campaign Preview
                      </p>
                      {trigger.campaignTemplate?.title && (
                        <p className="font-semibold text-gray-900 mb-1">
                          {trigger.campaignTemplate.title}
                        </p>
                      )}
                      <p className="text-sm text-gray-700">
                        {trigger.campaignTemplate?.message || 'No message set'}
                      </p>
                      {trigger.campaignTemplate?.suggestedItems?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {trigger.campaignTemplate.suggestedItems.map(
                            (item: string, i: number) => (
                              <span
                                key={i}
                                className="px-2 py-0.5 bg-white border border-gray-200 rounded text-xs text-gray-600"
                              >
                                {item}
                              </span>
                            ),
                          )}
                        </div>
                      )}
                    </div>

                    {/* Trigger Details */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Cooldown</span>
                        <span className="text-gray-900 font-medium">
                          {trigger.cooldownHours}h
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Last Fired</span>
                        <span className="text-gray-900 font-medium">
                          {trigger.lastFiredAt
                            ? new Date(trigger.lastFiredAt).toLocaleString('en-IN')
                            : 'Never'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Total Fires</span>
                        <span className="text-gray-900 font-medium">
                          {trigger.fireCount}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Requires Approval</span>
                        <span className="text-gray-900 font-medium">
                          {trigger.requiresApproval ? 'Yes' : 'No'}
                        </span>
                      </div>
                      {trigger.audienceFilter && Object.keys(trigger.audienceFilter).length > 0 && (
                        <div>
                          <p className="text-sm text-gray-500 mb-1">Audience Filter</p>
                          <pre className="text-xs text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto">
                            {JSON.stringify(trigger.audienceFilter, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Festival Calendar Tab ----

function FestivalCalendarTab({
  festivals,
  days,
  onDaysChange,
  formatDate,
}: {
  festivals: FestivalInfo[];
  days: number;
  onDaysChange: (d: number) => void;
  formatDate: (d: string) => string;
}) {
  return (
    <div className="space-y-4">
      {/* Days filter */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Upcoming Festivals</h2>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">Show next</label>
          <select
            value={days}
            onChange={(e) => onDaysChange(parseInt(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={365}>Full year</option>
          </select>
        </div>
      </div>

      {festivals.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <PartyPopper className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No festivals in the next {days} days</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Festival</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Date</th>
                <th className="px-4 py-3 text-center font-medium text-gray-600">Days Until</th>
                <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Suggested Items</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Campaign Message</th>
              </tr>
            </thead>
            <tbody>
              {festivals.map((festival, idx) => (
                <tr
                  key={`${festival.name}-${idx}`}
                  className={`border-t border-gray-100 hover:bg-gray-50 ${
                    festival.shouldTrigger ? 'bg-green-50/50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <PartyPopper
                        size={16}
                        className={
                          festival.shouldTrigger
                            ? 'text-[#059211]'
                            : 'text-gray-400'
                        }
                      />
                      <span className="font-medium text-gray-900">
                        {festival.name}
                      </span>
                    </div>
                    {festival.preDays > 0 && (
                      <span className="text-xs text-gray-400 ml-6">
                        Pre-campaign: {festival.preDays} days before
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {formatDate(festival.date)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
                        festival.daysUntil <= 3
                          ? 'bg-red-100 text-red-700'
                          : festival.daysUntil <= 7
                            ? 'bg-orange-100 text-orange-700'
                            : festival.daysUntil <= 14
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {festival.daysUntil === 0
                        ? 'Today'
                        : festival.daysUntil === 1
                          ? 'Tomorrow'
                          : `${festival.daysUntil}d`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {festival.shouldTrigger ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                        <Zap size={12} />
                        Ready
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs font-medium">
                        <Clock size={12} />
                        Scheduled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {festival.items.length > 0 ? (
                        festival.items.map((item, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 bg-orange-50 border border-orange-200 rounded text-xs text-orange-700"
                          >
                            {item}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-gray-400">None set</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-600 max-w-xs truncate" title={festival.campaignMessage}>
                      {festival.campaignMessage || 'No message set'}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Events & Sports Tab ----

function EventsTab({
  events,
  days,
  onDaysChange,
  showForm,
  form,
  submitting,
  onShowForm,
  onHideForm,
  onFormChange,
  onSubmit,
  formatDate,
  timeAgo,
}: {
  events: ScheduledEvent[];
  days: number;
  onDaysChange: (d: number) => void;
  showForm: boolean;
  form: NewEventForm;
  submitting: boolean;
  onShowForm: () => void;
  onHideForm: () => void;
  onFormChange: (updates: Partial<NewEventForm>) => void;
  onSubmit: () => void;
  formatDate: (d: string) => string;
  timeAgo: (d: string | null) => string;
}) {
  const upcomingEvents = events.filter((e) => !e.fired);
  const firedEvents = events.filter((e) => e.fired);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">
          Events & Sports
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Show next</label>
            <select
              value={days}
              onChange={(e) => onDaysChange(parseInt(e.target.value))}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          {!showForm && (
            <button
              onClick={onShowForm}
              className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium"
            >
              <Plus size={16} />
              Add Event
            </button>
          )}
        </div>
      </div>

      {/* New Event Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Schedule New Event
            </h3>
            <button
              onClick={onHideForm}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Event Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => onFormChange({ name: e.target.value })}
                placeholder="e.g., CSK vs MI - IPL 2026"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Event Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Type
              </label>
              <select
                value={form.eventType}
                onChange={(e) => onFormChange({ eventType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              >
                <option value="cricket">Cricket</option>
                <option value="ipl">IPL</option>
                <option value="football">Football</option>
                <option value="holiday">Holiday</option>
                <option value="sale">Sale Event</option>
                <option value="local">Local Event</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Event Date */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Date
              </label>
              <input
                type="date"
                value={form.eventDate}
                onChange={(e) => onFormChange({ eventDate: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Event Time */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Time
              </label>
              <input
                type="time"
                value={form.eventTime}
                onChange={(e) => onFormChange({ eventTime: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Send Before */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Send Campaign Before (hours)
              </label>
              <input
                type="number"
                value={form.sendBeforeHours}
                onChange={(e) =>
                  onFormChange({ sendBeforeHours: parseInt(e.target.value) || 0 })
                }
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Suggested Items */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Suggested Items (comma-separated)
              </label>
              <input
                type="text"
                value={form.suggestedItems}
                onChange={(e) => onFormChange({ suggestedItems: e.target.value })}
                placeholder="e.g., Pizza, Chicken Wings, Cold Drinks"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Campaign Message */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Campaign Message
              </label>
              <textarea
                value={form.campaignMessage}
                onChange={(e) => onFormChange({ campaignMessage: e.target.value })}
                placeholder="e.g., Match night snacks! Order now and get your food delivered before the toss."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={onHideForm}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                <Calendar size={16} />
              )}
              Schedule Event
            </button>
          </div>
        </div>
      )}

      {/* Upcoming Events */}
      {upcomingEvents.length === 0 && firedEvents.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Trophy className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No events scheduled in the next {days} days</p>
          <p className="text-sm text-gray-400 mt-1">
            Add IPL matches, cricket games, or local events to trigger campaigns
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Upcoming */}
          {upcomingEvents.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Upcoming ({upcomingEvents.length})
              </h3>
              <div className="space-y-3">
                {upcomingEvents.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    formatDate={formatDate}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Already Fired */}
          {firedEvents.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Already Fired ({firedEvents.length})
              </h3>
              <div className="space-y-3">
                {firedEvents.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    formatDate={formatDate}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Event Card Component ----

function EventCard({
  event,
  formatDate,
}: {
  event: ScheduledEvent;
  formatDate: (d: string) => string;
}) {
  return (
    <div
      className={`bg-white rounded-xl shadow-md border-2 p-4 ${
        event.fired
          ? 'border-gray-100 opacity-75'
          : 'border-gray-100 hover:border-gray-200'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          {/* Event Type Badge */}
          <div className="mt-0.5">
            <span
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                EVENT_TYPE_COLORS[event.eventType] ||
                EVENT_TYPE_COLORS.other
              }`}
            >
              {event.eventType === 'cricket' || event.eventType === 'ipl' ? (
                <Trophy size={12} />
              ) : (
                <Calendar size={12} />
              )}
              {event.eventType.toUpperCase()}
            </span>
          </div>

          {/* Details */}
          <div>
            <h3 className="font-medium text-gray-900">{event.name}</h3>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Calendar size={12} />
                {formatDate(event.eventDate)}
              </span>
              {event.eventTime && (
                <span className="flex items-center gap-1">
                  <Clock size={12} />
                  {event.eventTime}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Zap size={12} />
                Send {event.sendBeforeHours}h before
              </span>
            </div>
            {event.campaignMessage && (
              <p className="text-sm text-gray-600 mt-2 max-w-lg">
                {event.campaignMessage}
              </p>
            )}
            {event.suggestedItems.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {event.suggestedItems.map((item, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 bg-orange-50 border border-orange-200 rounded text-xs text-orange-700"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="text-right flex-shrink-0">
          {event.fired ? (
            <div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                <Check size={12} />
                Sent
              </span>
              {event.firedAt && (
                <p className="text-xs text-gray-400 mt-1">
                  {new Date(event.firedAt).toLocaleString('en-IN')}
                </p>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">
              <Clock size={12} />
              Pending
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
