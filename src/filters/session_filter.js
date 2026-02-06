/**
 * Session Filter
 * Handles trading session restrictions, lunch hour avoidance, and time-based filtering
 */

const EventEmitter = require('events');

class SessionFilter extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      // Timezone
      timezone: config.timezone || 'America/New_York',
      
      // Trading hours (in local timezone)
      tradingStartHour: parseInt(config.tradingStartHour) || 9,
      tradingStartMinute: parseInt(config.tradingStartMinute) || 30,
      tradingEndHour: parseInt(config.tradingEndHour) || 16,
      tradingEndMinute: parseInt(config.tradingEndMinute) || 0,
      
      // Lunch hour avoidance
      avoidLunch: config.avoidLunch !== false,
      lunchStartHour: parseInt(config.lunchStartHour) || 12,
      lunchStartMinute: parseInt(config.lunchStartMinute) || 0,
      lunchEndHour: parseInt(config.lunchEndHour) || 14,
      lunchEndMinute: parseInt(config.lunchEndMinute) || 0,
      
      // Pre-market and after-hours
      allowPreMarket: config.allowPreMarket || false,
      preMarketStartHour: parseInt(config.preMarketStartHour) || 4,
      preMarketStartMinute: parseInt(config.preMarketStartMinute) || 0,
      
      allowAfterHours: config.allowAfterHours || false,
      afterHoursEndHour: parseInt(config.afterHoursEndHour) || 20,
      afterHoursEndMinute: parseInt(config.afterHoursEndMinute) || 0,
      
      // Day of week restrictions (0 = Sunday, 6 = Saturday)
      tradingDays: config.tradingDays || [1, 2, 3, 4, 5], // Monday-Friday
      
      // Special restrictions
      avoidFirstMinutes: parseInt(config.avoidFirstMinutes) || 5,  // Avoid first 5 minutes
      avoidLastMinutes: parseInt(config.avoidLastMinutes) || 5,    // Avoid last 5 minutes
      
      // Holiday calendar (dates in YYYY-MM-DD format)
      holidays: config.holidays || [],
      
      ...config
    };

    // Pre-defined US market holidays for 2025-2026
    this.defaultHolidays = [
      // 2025
      '2025-01-01', // New Year's Day
      '2025-01-20', // MLK Day
      '2025-02-17', // Presidents Day
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25', // Christmas
      // 2026
      '2026-01-01', // New Year's Day
      '2026-01-19', // MLK Day
      '2026-02-16', // Presidents Day
      '2026-04-03', // Good Friday
      '2026-05-25', // Memorial Day
      '2026-06-19', // Juneteenth
      '2026-07-03', // Independence Day (observed)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas
    ];

    // Merge with custom holidays
    this.holidays = new Set([...this.defaultHolidays, ...this.config.holidays]);
  }

  /**
   * Get current time in configured timezone
   */
  getCurrentTime() {
    const now = new Date();
    
    // Get time in target timezone
    const options = {
      timeZone: this.config.timezone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    };

    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(now);
    
    const getPart = (type) => parts.find(p => p.type === type)?.value;
    
    const month = getPart('month');
    const day = getPart('day');
    return {
      hour: parseInt(getPart('hour')),
      minute: parseInt(getPart('minute')),
      second: parseInt(getPart('second')),
      weekday: getPart('weekday'),
      year: parseInt(getPart('year')),
      month: parseInt(month),
      day: parseInt(day),
      dayOfWeek: this.getDayOfWeek(getPart('weekday')),
      dateString: `${getPart('year')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    };
  }

  /**
   * Convert weekday string to number
   */
  getDayOfWeek(weekday) {
    const days = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    return days[weekday] ?? -1;
  }

  /**
   * Convert time to minutes since midnight
   */
  timeToMinutes(hour, minute) {
    return hour * 60 + minute;
  }

  /**
   * Check if current time is within trading hours
   */
  isWithinTradingHours(time = null) {
    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    
    const tradingStart = this.timeToMinutes(
      this.config.tradingStartHour, 
      this.config.tradingStartMinute
    );
    const tradingEnd = this.timeToMinutes(
      this.config.tradingEndHour, 
      this.config.tradingEndMinute
    );

    // Check regular trading hours
    if (currentMinutes >= tradingStart && currentMinutes < tradingEnd) {
      return true;
    }

    // Check pre-market
    if (this.config.allowPreMarket) {
      const preMarketStart = this.timeToMinutes(
        this.config.preMarketStartHour,
        this.config.preMarketStartMinute
      );
      if (currentMinutes >= preMarketStart && currentMinutes < tradingStart) {
        return true;
      }
    }

    // Check after-hours
    if (this.config.allowAfterHours) {
      const afterHoursEnd = this.timeToMinutes(
        this.config.afterHoursEndHour,
        this.config.afterHoursEndMinute
      );
      if (currentMinutes >= tradingEnd && currentMinutes < afterHoursEnd) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if current time is during lunch hour
   */
  isDuringLunch(time = null) {
    if (!this.config.avoidLunch) {
      return false;
    }

    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    
    const lunchStart = this.timeToMinutes(
      this.config.lunchStartHour,
      this.config.lunchStartMinute
    );
    const lunchEnd = this.timeToMinutes(
      this.config.lunchEndHour,
      this.config.lunchEndMinute
    );

    return currentMinutes >= lunchStart && currentMinutes < lunchEnd;
  }

  /**
   * Check if current time is in first/last minutes to avoid
   */
  isInAvoidanceWindow(time = null) {
    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    
    const tradingStart = this.timeToMinutes(
      this.config.tradingStartHour,
      this.config.tradingStartMinute
    );
    const tradingEnd = this.timeToMinutes(
      this.config.tradingEndHour,
      this.config.tradingEndMinute
    );

    // Check first minutes
    if (this.config.avoidFirstMinutes > 0) {
      const avoidUntil = tradingStart + this.config.avoidFirstMinutes;
      if (currentMinutes >= tradingStart && currentMinutes < avoidUntil) {
        return { avoid: true, reason: 'First minutes of session' };
      }
    }

    // Check last minutes
    if (this.config.avoidLastMinutes > 0) {
      const avoidFrom = tradingEnd - this.config.avoidLastMinutes;
      if (currentMinutes >= avoidFrom && currentMinutes < tradingEnd) {
        return { avoid: true, reason: 'Last minutes of session' };
      }
    }

    return { avoid: false };
  }

  /**
   * Check if today is a trading day
   */
  isTradingDay(time = null) {
    const t = time || this.getCurrentTime();
    return this.config.tradingDays.includes(t.dayOfWeek);
  }

  /**
   * Check if today is a holiday
   */
  isHoliday(time = null) {
    const t = time || this.getCurrentTime();
    return this.holidays.has(t.dateString);
  }

  /**
   * Main filter function - check if trading is allowed
   */
  canTrade(time = null) {
    const t = time || this.getCurrentTime();
    const reasons = [];

    // Check if it's a trading day
    if (!this.isTradingDay(t)) {
      return {
        allowed: false,
        reason: 'Not a trading day (weekend)',
        details: { dayOfWeek: t.dayOfWeek }
      };
    }

    // Check if it's a holiday
    if (this.isHoliday(t)) {
      return {
        allowed: false,
        reason: 'Market holiday',
        details: { date: t.dateString }
      };
    }

    // Check trading hours
    if (!this.isWithinTradingHours(t)) {
      return {
        allowed: false,
        reason: 'Outside trading hours',
        details: {
          currentTime: `${t.hour}:${t.minute.toString().padStart(2, '0')}`,
          tradingHours: `${this.config.tradingStartHour}:${this.config.tradingStartMinute.toString().padStart(2, '0')} - ${this.config.tradingEndHour}:${this.config.tradingEndMinute.toString().padStart(2, '0')}`
        }
      };
    }

    // Check lunch hour
    if (this.isDuringLunch(t)) {
      return {
        allowed: false,
        reason: 'Lunch hour (low liquidity)',
        details: {
          currentTime: `${t.hour}:${t.minute.toString().padStart(2, '0')}`,
          lunchHours: `${this.config.lunchStartHour}:${this.config.lunchStartMinute.toString().padStart(2, '0')} - ${this.config.lunchEndHour}:${this.config.lunchEndMinute.toString().padStart(2, '0')}`
        }
      };
    }

    // Check first/last minutes
    const avoidance = this.isInAvoidanceWindow(t);
    if (avoidance.avoid) {
      return {
        allowed: false,
        reason: avoidance.reason,
        details: {
          currentTime: `${t.hour}:${t.minute.toString().padStart(2, '0')}`
        }
      };
    }

    return {
      allowed: true,
      session: this.getCurrentSession(t),
      timeUntilClose: this.getMinutesUntilClose(t)
    };
  }

  /**
   * Get current session name
   */
  getCurrentSession(time = null) {
    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    
    const tradingStart = this.timeToMinutes(
      this.config.tradingStartHour,
      this.config.tradingStartMinute
    );
    const tradingEnd = this.timeToMinutes(
      this.config.tradingEndHour,
      this.config.tradingEndMinute
    );

    if (currentMinutes < tradingStart) {
      return 'PRE_MARKET';
    } else if (currentMinutes >= tradingEnd) {
      return 'AFTER_HOURS';
    } else if (currentMinutes < tradingStart + 60) {
      return 'OPENING';
    } else if (currentMinutes >= tradingEnd - 60) {
      return 'CLOSING';
    } else if (this.isDuringLunch(t)) {
      return 'LUNCH';
    } else {
      return 'REGULAR';
    }
  }

  /**
   * Get minutes until market close
   */
  getMinutesUntilClose(time = null) {
    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    const tradingEnd = this.timeToMinutes(
      this.config.tradingEndHour,
      this.config.tradingEndMinute
    );

    return Math.max(0, tradingEnd - currentMinutes);
  }

  /**
   * Get minutes until next trading session
   */
  getMinutesUntilOpen(time = null) {
    const t = time || this.getCurrentTime();
    const currentMinutes = this.timeToMinutes(t.hour, t.minute);
    const tradingStart = this.timeToMinutes(
      this.config.tradingStartHour,
      this.config.tradingStartMinute
    );

    if (currentMinutes < tradingStart) {
      return tradingStart - currentMinutes;
    } else {
      // Next day
      return (24 * 60 - currentMinutes) + tradingStart;
    }
  }

  /**
   * Add a holiday to the calendar
   */
  addHoliday(dateString) {
    this.holidays.add(dateString);
  }

  /**
   * Remove a holiday from the calendar
   */
  removeHoliday(dateString) {
    this.holidays.delete(dateString);
  }

  /**
   * Get status for logging
   */
  getStatus() {
    const t = this.getCurrentTime();
    const canTradeResult = this.canTrade(t);

    return {
      currentTime: `${t.hour}:${t.minute.toString().padStart(2, '0')}:${t.second.toString().padStart(2, '0')}`,
      timezone: this.config.timezone,
      dayOfWeek: t.weekday,
      date: t.dateString,
      session: this.getCurrentSession(t),
      canTrade: canTradeResult.allowed,
      reason: canTradeResult.reason || null,
      minutesUntilClose: this.getMinutesUntilClose(t),
      isLunch: this.isDuringLunch(t),
      isHoliday: this.isHoliday(t)
    };
  }

  /**
   * Format status for logging
   */
  formatStatus() {
    const status = this.getStatus();
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕐 SESSION STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Time:           ${status.currentTime} ${status.timezone}
Date:           ${status.dayOfWeek}, ${status.date}
Session:        ${status.session}
Can Trade:      ${status.canTrade ? '✅ Yes' : '❌ No - ' + status.reason}
Until Close:    ${status.minutesUntilClose} minutes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }
}

module.exports = SessionFilter;
