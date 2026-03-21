'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Calendar, ChevronLeft, ChevronRight, Clock, AlertTriangle,
  Plus, Eye, RefreshCw, AlertCircle, X, Sparkles, Instagram,
  Linkedin, Youtube, Globe, Target,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface CalendarItem {
  id: string;
  contentType: string;
  title: string;
  platform: string;
  status: string;
  scheduledAt: string;
  contentJson: any;
}

interface CalendarEntry {
  date: string;
  items: CalendarItem[];
}

interface OptimalTime {
  platform: string;
  times: string[];
  reason: string;
}

interface WeeklyPlan {
  weekStart: string;
  days: WeeklyPlanDay[];
}

interface WeeklyPlanDay {
  date: string;
  dayOfWeek: string;
  suggestedType: string;
  suggestedPlatform: string;
  rationale: string;
}

interface GapEntry {
  date: string;
  platforms: string[];
}

// ---- Constants ----

const PLATFORM_COLORS: Record<string, { dot: string; badge: string; text: string }> = {
  instagram: { dot: 'bg-pink-500', badge: 'bg-pink-100 text-pink-700', text: 'Instagram' },
  linkedin: { dot: 'bg-blue-600', badge: 'bg-blue-100 text-blue-700', text: 'LinkedIn' },
  meta_ads: { dot: 'bg-indigo-500', badge: 'bg-indigo-100 text-indigo-700', text: 'Meta Ads' },
  google_ads: { dot: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700', text: 'Google Ads' },
  youtube: { dot: 'bg-red-500', badge: 'bg-red-100 text-red-700', text: 'YouTube' },
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  published: 'bg-green-100 text-green-700',
  draft: 'bg-gray-100 text-gray-600',
  approved: 'bg-purple-100 text-purple-700',
  failed: 'bg-red-100 text-red-700',
};

const CONTENT_TYPE_COLORS: Record<string, string> = {
  image: 'bg-blue-100 text-blue-700',
  video: 'bg-purple-100 text-purple-700',
  carousel: 'bg-indigo-100 text-indigo-700',
  story: 'bg-pink-100 text-pink-700',
  reel: 'bg-rose-100 text-rose-700',
  ad_copy: 'bg-orange-100 text-orange-700',
  blog: 'bg-teal-100 text-teal-700',
};

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- Helper Functions ----

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDaysInMonth(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const days: Date[] = [];

  // Pad start to Monday
  let startDow = firstDay.getDay();
  if (startDow === 0) startDow = 7;
  for (let i = startDow - 1; i > 0; i--) {
    days.push(new Date(year, month, 1 - i));
  }

  // Days of the month
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }

  // Pad end to Sunday
  const remaining = 7 - (days.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      days.push(new Date(year, month + 1, i));
    }
  }

  return days;
}

function getWeekDates(date: Date): Date[] {
  const d = new Date(date);
  let dow = d.getDay();
  if (dow === 0) dow = 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow - 1));
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    dates.push(day);
  }
  return dates;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function getMonthLabel(date: Date): string {
  return date.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

function getWeekLabel(dates: Date[]): string {
  const first = dates[0];
  const last = dates[6];
  const fmtDay = (d: Date) => d.toLocaleString('en-IN', { day: 'numeric', month: 'short' });
  if (first.getMonth() === last.getMonth()) {
    return `${first.getDate()} - ${fmtDay(last)}, ${last.getFullYear()}`;
  }
  return `${fmtDay(first)} - ${fmtDay(last)}, ${last.getFullYear()}`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

function getPlatformIcon(platform: string, size: number = 14) {
  switch (platform) {
    case 'instagram': return <Instagram size={size} />;
    case 'linkedin': return <Linkedin size={size} />;
    case 'youtube': return <Youtube size={size} />;
    case 'meta_ads': return <Target size={size} />;
    case 'google_ads': return <Globe size={size} />;
    default: return <Globe size={size} />;
  }
}

// ---- Time Slots for Week View ----

const TIME_SLOTS = [
  '06:00', '08:00', '10:00', '12:00', '14:00',
  '16:00', '18:00', '20:00', '22:00',
];

function getTimeSlotLabel(slot: string): string {
  const [h] = slot.split(':').map(Number);
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function getEntryTimeSlot(scheduledAt: string): string {
  const d = new Date(scheduledAt);
  const h = d.getHours();
  for (let i = TIME_SLOTS.length - 1; i >= 0; i--) {
    const slotH = parseInt(TIME_SLOTS[i].split(':')[0], 10);
    if (h >= slotH) return TIME_SLOTS[i];
  }
  return TIME_SLOTS[0];
}

// ---- Main Page ----

export default function ContentCalendarPage() {
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calendarData, setCalendarData] = useState<CalendarEntry[]>([]);
  const [weeklyPlan, setWeeklyPlan] = useState<WeeklyPlan | null>(null);
  const [gaps, setGaps] = useState<GapEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWeeklyPlan, setShowWeeklyPlan] = useState(false);
  const [optimalTimes, setOptimalTimes] = useState<OptimalTime[]>([]);

  const navigateMonth = useCallback((direction: 1 | -1) => {
    setCurrentDate((prev) => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + direction);
      return next;
    });
    setSelectedDate(null);
  }, []);

  const navigateWeek = useCallback((direction: 1 | -1) => {
    setCurrentDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + direction * 7);
      return next;
    });
    setSelectedDate(null);
  }, []);

  const getDateRange = useCallback((): { startDate: string; endDate: string } => {
    if (viewMode === 'month') {
      const days = getDaysInMonth(currentDate.getFullYear(), currentDate.getMonth());
      return { startDate: formatDate(days[0]), endDate: formatDate(days[days.length - 1]) };
    }
    const weekDates = getWeekDates(currentDate);
    return { startDate: formatDate(weekDates[0]), endDate: formatDate(weekDates[6]) };
  }, [viewMode, currentDate]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { startDate, endDate } = getDateRange();

      const [entries, gapData] = await Promise.all([
        mangwaleAIClient.get<CalendarEntry[]>(
          `/mos/content-factory/calendar?startDate=${startDate}&endDate=${endDate}`
        ),
        mangwaleAIClient.get<GapEntry[]>(
          `/mos/content-factory/calendar/gaps?startDate=${startDate}&endDate=${endDate}`
        ),
      ]);

      setCalendarData(Array.isArray(entries) ? entries : []);
      setGaps(Array.isArray(gapData) ? gapData : []);
    } catch (err: any) {
      console.error('Failed to load calendar data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [getDateRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadWeeklyPlan = async () => {
    try {
      const weekDates = getWeekDates(currentDate);
      const plan = await mangwaleAIClient.get<WeeklyPlan>(
        `/mos/content-factory/calendar/weekly-plan?weekStartDate=${formatDate(weekDates[0])}`
      );
      setWeeklyPlan(plan && plan.days ? plan : null);
      setShowWeeklyPlan(true);
    } catch (err: any) {
      console.error('Failed to load weekly plan:', err);
      setError(err.message || 'Failed to load weekly plan');
    }
  };

  const loadOptimalTimes = async () => {
    try {
      const platforms = ['instagram', 'linkedin', 'meta_ads', 'google_ads', 'youtube'];
      const results = await Promise.all(
        platforms.map((p) =>
          mangwaleAIClient.get<OptimalTime>(
            `/mos/content-factory/calendar/optimal-times?platform=${p}`
          ).catch(() => ({ platform: p, times: [], reason: 'No data available' }))
        )
      );
      setOptimalTimes(results);
    } catch {
      // Silently handle — optimal times are informational
    }
  };

  const handleUnschedule = async (entryId: string) => {
    try {
      await mangwaleAIClient.post(`/mos/content-factory/calendar/unschedule/${entryId}`, {});
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to unschedule content');
    }
  };

  const handleReschedule = async (entryId: string, newDate: string) => {
    try {
      await mangwaleAIClient.post('/mos/content-factory/calendar/schedule', {
        contentId: entryId,
        scheduledAt: newDate,
      });
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to reschedule content');
    }
  };

  const getEntriesForDate = (dateStr: string): CalendarItem[] => {
    const entry = calendarData.find(e => e.date === dateStr);
    return entry?.items || [];
  };

  const selectedEntries = selectedDate ? getEntriesForDate(selectedDate) : [];

  // Load optimal times when a day is selected
  useEffect(() => {
    if (selectedDate) {
      loadOptimalTimes();
    }
  }, [selectedDate]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
              <Calendar size={32} />
              Content Calendar
            </h1>
            <p className="text-green-100">
              Plan and schedule your content across platforms
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={loadWeeklyPlan}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all text-sm font-medium"
            >
              <Sparkles size={16} />
              Weekly Plan
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all disabled:opacity-50"
            >
              <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Bar */}
      <div className="flex items-center justify-between bg-white rounded-xl shadow-md border-2 border-gray-100 p-4">
        {/* View Toggle */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => { setViewMode('month'); setSelectedDate(null); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              viewMode === 'month'
                ? 'bg-white text-[#059211] shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Month
          </button>
          <button
            onClick={() => { setViewMode('week'); setSelectedDate(null); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              viewMode === 'week'
                ? 'bg-white text-[#059211] shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Week
          </button>
        </div>

        {/* Date Navigation */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => viewMode === 'month' ? navigateMonth(-1) : navigateWeek(-1)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-all"
          >
            <ChevronLeft size={20} className="text-gray-600" />
          </button>
          <span className="text-lg font-bold text-gray-900 min-w-[200px] text-center">
            {viewMode === 'month'
              ? getMonthLabel(currentDate)
              : getWeekLabel(getWeekDates(currentDate))
            }
          </span>
          <button
            onClick={() => viewMode === 'month' ? navigateMonth(1) : navigateWeek(1)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-all"
          >
            <ChevronRight size={20} className="text-gray-600" />
          </button>
        </div>

        {/* Today Button */}
        <button
          onClick={() => { setCurrentDate(new Date()); setSelectedDate(null); }}
          className="px-4 py-1.5 text-sm font-medium text-[#059211] hover:bg-green-50 rounded-lg transition-all"
        >
          Today
        </button>
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
            onClick={() => { setError(null); loadData(); }}
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

      {/* Calendar Views */}
      {!loading && !error && (
        <>
          {viewMode === 'month' && (
            <MonthView
              currentDate={currentDate}
              calendarData={calendarData}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
          )}
          {viewMode === 'week' && (
            <WeekView
              currentDate={currentDate}
              calendarData={calendarData}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
          )}
        </>
      )}

      {/* Day Detail Panel */}
      {!loading && !error && selectedDate && (
        <DayDetailPanel
          selectedDate={selectedDate}
          entries={selectedEntries}
          optimalTimes={optimalTimes}
          onUnschedule={handleUnschedule}
          onReschedule={handleReschedule}
          onClose={() => setSelectedDate(null)}
        />
      )}

      {/* Gap Warnings */}
      {!loading && !error && gaps.length > 0 && (
        <div className="space-y-3">
          {gaps.map((gap, idx) => (
            <div
              key={idx}
              className="bg-orange-50 border-2 border-orange-200 rounded-lg p-4 flex items-center gap-3"
            >
              <AlertTriangle className="text-orange-500 flex-shrink-0" size={20} />
              <span className="text-orange-800 text-sm flex-1">
                No content scheduled for {gap.date} on {gap.platforms.map(p => PLATFORM_COLORS[p]?.text || p).join(', ')}
              </span>
              <div className="flex gap-1">
                {gap.platforms.map((p) => (
                  <span key={p} className={`px-2 py-0.5 rounded text-xs font-medium ${PLATFORM_COLORS[p]?.badge || 'bg-gray-100 text-gray-600'}`}>
                    {PLATFORM_COLORS[p]?.text || p}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Weekly Plan Modal */}
      {showWeeklyPlan && (
        <WeeklyPlanPanel
          plan={weeklyPlan}
          onClose={() => setShowWeeklyPlan(false)}
        />
      )}
    </div>
  );
}

// ---- Month View ----

function MonthView({
  currentDate,
  calendarData,
  selectedDate,
  onSelectDate,
}: {
  currentDate: Date;
  calendarData: CalendarEntry[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const days = getDaysInMonth(currentDate.getFullYear(), currentDate.getMonth());
  const currentMonth = currentDate.getMonth();

  const getEntriesForDay = (date: Date): CalendarItem[] => {
    const dateStr = formatDate(date);
    const entry = calendarData.find(e => e.date === dateStr);
    return entry?.items || [];
  };

  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      {/* Day Headers */}
      <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
        {DAY_HEADERS.map((day) => (
          <div key={day} className="px-2 py-3 text-center text-sm font-medium text-gray-600">
            {day}
          </div>
        ))}
      </div>

      {/* Day Grid */}
      <div className="grid grid-cols-7">
        {days.map((date, idx) => {
          const dateStr = formatDate(date);
          const entries = getEntriesForDay(date);
          const isCurrentMonth = date.getMonth() === currentMonth;
          const isTodayDate = isToday(date);
          const isSelected = selectedDate === dateStr;

          return (
            <div
              key={idx}
              onClick={() => onSelectDate(dateStr)}
              className={`min-h-[100px] border-b border-r border-gray-100 p-2 cursor-pointer transition-all group ${
                isSelected
                  ? 'bg-green-50'
                  : 'hover:bg-gray-50'
              } ${isTodayDate ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
            >
              {/* Date Number */}
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`text-sm ${
                    isTodayDate
                      ? 'font-bold text-blue-600 bg-blue-100 w-7 h-7 flex items-center justify-center rounded-full'
                      : isCurrentMonth
                        ? 'font-medium text-gray-900'
                        : 'text-gray-400'
                  }`}
                >
                  {date.getDate()}
                </span>
                {entries.length === 0 && isCurrentMonth && (
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <Plus size={14} className="text-gray-400 hover:text-[#059211]" />
                  </span>
                )}
              </div>

              {/* Content Dots */}
              <div className="flex flex-wrap gap-1">
                {entries.slice(0, 4).map((entry) => {
                  const color = PLATFORM_COLORS[entry.platform];
                  return (
                    <div
                      key={entry.id}
                      className={`h-1.5 rounded-full flex-1 min-w-[12px] max-w-[40px] ${color?.dot || 'bg-gray-400'}`}
                      title={`${color?.text || entry.platform}: ${entry.title}`}
                    />
                  );
                })}
              </div>
              {entries.length > 4 && (
                <span className="text-[10px] text-gray-400 mt-0.5 block">
                  +{entries.length - 4} more
                </span>
              )}

              {/* Entry Titles (show first 2) */}
              <div className="mt-1 space-y-0.5">
                {entries.slice(0, 2).map((entry) => {
                  const color = PLATFORM_COLORS[entry.platform];
                  return (
                    <div
                      key={entry.id}
                      className={`text-[10px] px-1 py-0.5 rounded truncate ${color?.badge || 'bg-gray-100 text-gray-600'}`}
                      title={entry.title}
                    >
                      {truncateText(entry.title, 18)}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Week View ----

function WeekView({
  currentDate,
  calendarData,
  selectedDate,
  onSelectDate,
}: {
  currentDate: Date;
  calendarData: CalendarEntry[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const weekDates = getWeekDates(currentDate);

  const getEntriesForDayAndSlot = (date: Date, slot: string): CalendarItem[] => {
    const dateStr = formatDate(date);
    const entry = calendarData.find(e => e.date === dateStr);
    if (!entry) return [];
    return entry.items.filter((item) => getEntryTimeSlot(item.scheduledAt) === slot);
  };

  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      {/* Day Headers */}
      <div className="grid grid-cols-[80px_repeat(7,1fr)] bg-gray-50 border-b border-gray-200">
        <div className="px-2 py-3 text-center text-sm font-medium text-gray-400">Time</div>
        {weekDates.map((date, idx) => {
          const isTodayDate = isToday(date);
          return (
            <div
              key={idx}
              className={`px-2 py-3 text-center cursor-pointer hover:bg-gray-100 transition-all ${
                isTodayDate ? 'bg-blue-50' : ''
              }`}
              onClick={() => onSelectDate(formatDate(date))}
            >
              <div className="text-xs text-gray-500">{DAY_HEADERS[idx]}</div>
              <div className={`text-sm font-medium ${
                isTodayDate ? 'text-blue-600 font-bold' : 'text-gray-900'
              }`}>
                {date.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Time Slot Grid */}
      <div className="overflow-y-auto max-h-[600px]">
        {TIME_SLOTS.map((slot) => (
          <div key={slot} className="grid grid-cols-[80px_repeat(7,1fr)] border-b border-gray-50">
            <div className="px-2 py-3 text-xs text-gray-400 text-right pr-3 border-r border-gray-100">
              {getTimeSlotLabel(slot)}
            </div>
            {weekDates.map((date, dayIdx) => {
              const dateStr = formatDate(date);
              const entries = getEntriesForDayAndSlot(date, slot);
              const isSelected = selectedDate === dateStr;
              const isTodayDate = isToday(date);

              return (
                <div
                  key={dayIdx}
                  onClick={() => onSelectDate(dateStr)}
                  className={`min-h-[60px] p-1 border-r border-gray-50 cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-green-50'
                      : isTodayDate
                        ? 'bg-blue-50/30'
                        : 'hover:bg-gray-50'
                  }`}
                >
                  {entries.map((entry) => {
                    const color = PLATFORM_COLORS[entry.platform];
                    return (
                      <div
                        key={entry.id}
                        className={`p-1.5 rounded-md mb-1 text-[10px] border-l-2 ${
                          color?.badge || 'bg-gray-100 text-gray-600'
                        }`}
                        style={{ borderLeftColor: color?.dot.replace('bg-', '') }}
                        title={`${entry.title} (${formatTime(entry.scheduledAt)})`}
                      >
                        <div className="flex items-center gap-1 mb-0.5">
                          {getPlatformIcon(entry.platform, 10)}
                          <span className="font-medium truncate">{truncateText(entry.title, 14)}</span>
                        </div>
                        <span className={`px-1 py-0 rounded text-[9px] ${CONTENT_TYPE_COLORS[entry.contentType] || 'bg-gray-100 text-gray-500'}`}>
                          {entry.contentType}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Day Detail Panel ----

function DayDetailPanel({
  selectedDate,
  entries,
  optimalTimes,
  onUnschedule,
  onReschedule,
  onClose,
}: {
  selectedDate: string;
  entries: CalendarItem[];
  optimalTimes: OptimalTime[];
  onUnschedule: (id: string) => void;
  onReschedule: (id: string, newDate: string) => void;
  onClose: () => void;
}) {
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');

  const displayDate = new Date(selectedDate + 'T00:00:00');
  const dateLabel = displayDate.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const handleRescheduleSubmit = (entryId: string) => {
    if (!rescheduleDate) return;
    onReschedule(entryId, rescheduleDate);
    setRescheduleId(null);
    setRescheduleDate('');
  };

  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Eye className="text-[#059211]" size={20} />
            {dateLabel}
          </h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {entries.length} content item{entries.length !== 1 ? 's' : ''} scheduled
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content Items */}
      <div className="p-4">
        {entries.length === 0 ? (
          <div className="text-center py-8">
            <Calendar className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm">No content scheduled for this day</p>
            <p className="text-xs text-gray-400 mt-1">
              Generate content in the Content Factory and schedule it here
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => {
              const platColor = PLATFORM_COLORS[entry.platform];
              return (
                <div
                  key={entry.id}
                  className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 hover:shadow-md transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Clock size={14} className="text-gray-400" />
                        <span className="text-sm text-gray-600 font-medium">
                          {formatTime(entry.scheduledAt)}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${CONTENT_TYPE_COLORS[entry.contentType] || 'bg-gray-100 text-gray-600'}`}>
                          {(entry.contentType || '').replace(/_/g, ' ')}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${platColor?.badge || 'bg-gray-100 text-gray-600'}`}>
                          {platColor?.text || entry.platform}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[entry.status] || 'bg-gray-100 text-gray-600'}`}>
                          {entry.status}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-gray-900">{entry.title}</h4>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {rescheduleId === entry.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="datetime-local"
                            value={rescheduleDate}
                            onChange={(e) => setRescheduleDate(e.target.value)}
                            className="px-2 py-1 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                          />
                          <button
                            onClick={() => handleRescheduleSubmit(entry.id)}
                            disabled={!rescheduleDate}
                            className="px-2 py-1 bg-[#059211] text-white rounded text-xs hover:bg-[#047a0e] disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => { setRescheduleId(null); setRescheduleDate(''); }}
                            className="px-2 py-1 text-gray-500 hover:bg-gray-100 rounded text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => setRescheduleId(entry.id)}
                            className="px-3 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-100 transition-all"
                          >
                            Reschedule
                          </button>
                          <button
                            onClick={() => onUnschedule(entry.id)}
                            className="px-3 py-1 bg-orange-50 text-orange-700 rounded-lg text-xs font-medium hover:bg-orange-100 transition-all"
                          >
                            Unschedule
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Optimal Times */}
      {optimalTimes.length > 0 && (
        <div className="px-4 pb-4">
          <div className="bg-gray-50 rounded-xl p-4">
            <h4 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
              <Clock className="text-[#059211]" size={16} />
              Optimal Posting Times
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {optimalTimes.map((ot) => {
                const platColor = PLATFORM_COLORS[ot.platform];
                return (
                  <div key={ot.platform} className="bg-white rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center gap-1.5 mb-2">
                      {getPlatformIcon(ot.platform, 14)}
                      <span className={`text-xs font-medium ${platColor?.badge ? '' : 'text-gray-700'}`}>
                        {platColor?.text || ot.platform}
                      </span>
                    </div>
                    {ot.times.length > 0 ? (
                      <div className="space-y-1">
                        {ot.times.slice(0, 3).map((time, idx) => (
                          <span key={idx} className="block text-xs text-gray-600">
                            {time}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">No data</span>
                    )}
                    {ot.reason && (
                      <p className="text-[10px] text-gray-400 mt-1.5 line-clamp-2">{ot.reason}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Add Content Link */}
      <div className="px-4 pb-4">
        <a
          href="/admin/mos/action-engine"
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all w-fit"
        >
          <Plus size={16} />
          Add Content
        </a>
      </div>
    </div>
  );
}

// ---- Weekly Plan Panel ----

function WeeklyPlanPanel({
  plan,
  onClose,
}: {
  plan: WeeklyPlan | null;
  onClose: () => void;
}) {
  const days = plan?.days || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Slide-over Panel */}
      <div className="relative w-full max-w-lg h-full bg-white shadow-2xl overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Sparkles className="text-[#059211]" size={22} />
                AI Weekly Plan
              </h2>
              {plan?.weekStart && (
                <p className="text-xs text-gray-400 mt-1">Week of {plan.weekStart}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"
            >
              <X size={20} />
            </button>
          </div>

          <p className="text-sm text-gray-500 mb-6">
            AI-suggested content plan for the week. Review the recommendations and apply when ready.
          </p>

          {/* Plan Days */}
          {days.length === 0 ? (
            <div className="text-center py-12">
              <Sparkles className="mx-auto text-gray-300 mb-3" size={48} />
              <p className="text-gray-500">No weekly plan available</p>
              <p className="text-sm text-gray-400 mt-1">
                The AI will generate a plan based on your content history
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {days.map((day, idx) => {
                const platColor = PLATFORM_COLORS[day.suggestedPlatform];
                return (
                  <div key={idx} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Calendar size={16} className="text-[#059211]" />
                      <span className="text-sm font-bold text-gray-900">{day.dayOfWeek}</span>
                      <span className="text-xs text-gray-400">{day.date}</span>
                    </div>

                    <div className="flex items-start gap-3 bg-gray-50 rounded-lg p-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${platColor?.badge || 'bg-gray-100 text-gray-600'}`}>
                            {platColor?.text || day.suggestedPlatform}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${CONTENT_TYPE_COLORS[day.suggestedType] || 'bg-gray-100 text-gray-600'}`}>
                            {(day.suggestedType || '').replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="text-xs text-gray-600">{day.rationale}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Apply Plan Button */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <div className="relative group w-fit">
              <button
                disabled
                className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-400 rounded-lg text-sm font-medium cursor-not-allowed"
              >
                <Sparkles size={16} />
                Apply Plan
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Coming in Phase 4
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
