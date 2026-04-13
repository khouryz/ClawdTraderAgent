/**
 * Contract Roll Reminder
 * 
 * Sends Telegram notifications when futures contracts are approaching expiration.
 * CME equity index futures (MNQ, MES, NQ, ES) expire on the 3rd Friday of
 * March (H), June (M), September (U), and December (Z) — quarterly.
 * 
 * Checks on bot startup and then daily at a configurable hour.
 * Sends reminders at configurable days before expiration (default: 5, 3, 1).
 */

const logger = require('./logger');

// CME futures month codes
const MONTH_CODES = {
  3: 'H',   // March
  6: 'M',   // June
  9: 'U',   // September
  12: 'Z',  // December
};

class ContractRollReminder {
  /**
   * @param {Object} config
   * @param {Object} config.notifications - Notifications instance (Telegram)
   * @param {string} config.contractName - Current contract name (e.g., "MNQM6")
   * @param {string} [config.expirationDate] - Expiration date from Tradovate (ISO string)
   * @param {string} [config.baseSymbol] - Base symbol (e.g., "MNQ")
   * @param {number[]} [config.reminderDays] - Days before expiration to remind (default: [5, 3, 1])
   * @param {number} [config.checkHourPST] - Hour (PST) to run daily check (default: 6 = 6 AM)
   */
  constructor(config = {}) {
    this.notifications = config.notifications;
    this.contractName = config.contractName || '';
    this.baseSymbol = config.baseSymbol || this._extractBaseSymbol(this.contractName);
    this.reminderDays = config.reminderDays || [5, 3, 1];
    this.checkHourPST = config.checkHourPST ?? 6;

    // Use Tradovate-provided expiration date if available, otherwise compute it
    if (config.expirationDate) {
      this.expirationDate = new Date(config.expirationDate);
    } else {
      this.expirationDate = this._computeExpirationFromContract(this.contractName);
    }

    this._dailyTimer = null;
    this._sentReminders = new Set(); // Track sent reminders to avoid duplicates: "5d-2026-06-19"
  }

  /**
   * Start the reminder system: check immediately, then schedule daily checks.
   */
  async start() {
    if (!this.expirationDate || isNaN(this.expirationDate.getTime())) {
      logger.warn(`[RollReminder] Could not determine expiration date for ${this.contractName} — reminders disabled`);
      return;
    }

    const expStr = this.expirationDate.toISOString().split('T')[0];
    const daysUntil = this._daysUntilExpiration();
    logger.info(`[RollReminder] Contract: ${this.contractName} | Expires: ${expStr} | Days until expiry: ${daysUntil} | Next contract: ${this._getNextContractName()}`);

    // Check immediately on startup
    await this._checkAndNotify();

    // Schedule daily check
    this._scheduleDailyCheck();
  }

  /**
   * Stop the reminder system and clear timers.
   */
  stop() {
    if (this._dailyTimer) {
      clearTimeout(this._dailyTimer);
      this._dailyTimer = null;
    }
  }

  /**
   * Check if a reminder should be sent today and send it.
   */
  async _checkAndNotify() {
    const daysUntil = this._daysUntilExpiration();

    if (daysUntil < 0) {
      logger.warn(`[RollReminder] Contract ${this.contractName} has already expired! Update your contract immediately.`);
      const key = `expired-${this.contractName}`;
      if (!this._sentReminders.has(key)) {
        this._sentReminders.add(key);
        await this._sendNotification(
          `🚨 <b>CONTRACT EXPIRED</b>\n\n` +
          `<b>${this.contractName}</b> has already expired!\n` +
          `Next contract: <b>${this._getNextContractName()}</b>\n\n` +
          `⚠️ Update CONTRACT_SYMBOL in your .env immediately.`
        );
      }
      return;
    }

    // Check each reminder day
    for (const reminderDay of this.reminderDays) {
      if (daysUntil <= reminderDay) {
        const expStr = this.expirationDate.toISOString().split('T')[0];
        const key = `${reminderDay}d-${expStr}`;

        if (!this._sentReminders.has(key)) {
          this._sentReminders.add(key);
          const nextContract = this._getNextContractName();
          const urgency = daysUntil <= 1 ? '🚨' : daysUntil <= 3 ? '⚠️' : '📅';
          const rollDate = this._getRollDate();
          const rollDateStr = rollDate ? rollDate.toISOString().split('T')[0] : 'N/A';

          await this._sendNotification(
            `${urgency} <b>CONTRACT ROLL REMINDER</b>\n\n` +
            `Current: <b>${this.contractName}</b>\n` +
            `Expires: <b>${expStr}</b> (${daysUntil} day${daysUntil !== 1 ? 's' : ''} away)\n` +
            `Roll date: <b>${rollDateStr}</b> (volume shifts)\n` +
            `Next contract: <b>${nextContract}</b>\n\n` +
            `${daysUntil <= 1
              ? '🔴 <b>URGENT:</b> Roll your contract TODAY!'
              : daysUntil <= 3
                ? '🟡 Roll your contract soon. Update CONTRACT_SYMBOL in .env.'
                : '🟢 Heads up — contract expiration approaching.'}`
          );

          logger.info(`[RollReminder] Sent ${reminderDay}-day reminder for ${this.contractName} (${daysUntil} days until expiry)`);
          break; // Only send the most relevant reminder per check
        }
      }
    }
  }

  /**
   * Schedule the next daily check. Runs at checkHourPST every day.
   * @private
   */
  _scheduleDailyCheck() {
    const now = new Date();
    // Get current PST time
    const pstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const targetHour = this.checkHourPST;

    // Next check time: today at targetHour if we haven't passed it, otherwise tomorrow
    let nextCheck = new Date(pstNow);
    nextCheck.setHours(targetHour, 0, 0, 0);

    if (pstNow >= nextCheck) {
      // Already past check time today, schedule for tomorrow
      nextCheck.setDate(nextCheck.getDate() + 1);
    }

    // Convert back to system time for setTimeout
    const msUntilCheck = nextCheck.getTime() - pstNow.getTime();

    this._dailyTimer = setTimeout(async () => {
      await this._checkAndNotify();
      // Reschedule for next day
      this._scheduleDailyCheck();
    }, msUntilCheck);

    const hoursUntil = (msUntilCheck / 3600000).toFixed(1);
    logger.info(`[RollReminder] Next daily check in ${hoursUntil}h`);
  }

  /**
   * Calculate the number of calendar days from today (PST) until expiration.
   * @returns {number}
   */
  _daysUntilExpiration() {
    const now = new Date();
    const pstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    // Zero out time for both dates to get clean day diff
    const today = new Date(pstNow.getFullYear(), pstNow.getMonth(), pstNow.getDate());
    const expDay = new Date(this.expirationDate.getFullYear(), this.expirationDate.getMonth(), this.expirationDate.getDate());
    return Math.round((expDay - today) / (1000 * 60 * 60 * 24));
  }

  /**
   * Get the typical roll date (2nd Thursday before expiration = 8 days before).
   * This is when volume typically shifts to the next contract.
   * @returns {Date|null}
   */
  _getRollDate() {
    if (!this.expirationDate) return null;
    const rollDate = new Date(this.expirationDate);
    rollDate.setDate(rollDate.getDate() - 8);
    return rollDate;
  }

  /**
   * Compute the 3rd Friday of a given month/year.
   * @param {number} year
   * @param {number} month - 0-indexed (0=Jan, 2=Mar, 5=Jun, 8=Sep, 11=Dec)
   * @returns {Date}
   */
  _getThirdFriday(year, month) {
    // Start at the 1st of the month
    const first = new Date(year, month, 1);
    // Find the first Friday: Friday = day 5
    let firstFriday = 1 + ((5 - first.getDay() + 7) % 7);
    // 3rd Friday = first Friday + 14
    const thirdFriday = firstFriday + 14;
    return new Date(year, month, thirdFriday);
  }

  /**
   * Get all quarterly expiration dates for a given year.
   * @param {number} year
   * @returns {Date[]}
   */
  _getQuarterlyExpirations(year) {
    return [
      this._getThirdFriday(year, 2),   // March (month index 2)
      this._getThirdFriday(year, 5),   // June (month index 5)
      this._getThirdFriday(year, 8),   // September (month index 8)
      this._getThirdFriday(year, 11),  // December (month index 11)
    ];
  }

  /**
   * Compute expiration date from contract name (e.g., "MNQM6" → June 2026 3rd Friday).
   * Contract name format: {SYMBOL}{MONTH_CODE}{YEAR_DIGIT}
   *   - MNQM6 = MNQ June 2026
   *   - MNQU6 = MNQ September 2026
   *   - MESH6 = MES March 2026
   * @param {string} contractName
   * @returns {Date|null}
   */
  _computeExpirationFromContract(contractName) {
    if (!contractName || contractName.length < 4) return null;

    // Extract month code and year digit from the end of the contract name
    const yearDigit = parseInt(contractName.slice(-1));
    const monthCode = contractName.slice(-2, -1).toUpperCase();

    if (isNaN(yearDigit)) return null;

    // Map month code to month number (0-indexed)
    const monthCodeToIndex = { H: 2, M: 5, U: 8, Z: 11 };
    const monthIndex = monthCodeToIndex[monthCode];
    if (monthIndex === undefined) return null;

    // Determine full year: assume 2020s decade (20xx)
    // Year digit 0-9 maps to 2020-2029
    const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
    const year = currentDecade + yearDigit;

    return this._getThirdFriday(year, monthIndex);
  }

  /**
   * Get the next contract name after the current one.
   * @returns {string}
   */
  _getNextContractName() {
    if (!this.contractName || this.contractName.length < 4) return 'UNKNOWN';

    const yearDigit = parseInt(this.contractName.slice(-1));
    const monthCode = this.contractName.slice(-2, -1).toUpperCase();
    const symbolPrefix = this.contractName.slice(0, -2);

    if (isNaN(yearDigit)) return 'UNKNOWN';

    // Quarter cycle: H -> M -> U -> Z -> H (next year)
    const cycle = ['H', 'M', 'U', 'Z'];
    const currentIdx = cycle.indexOf(monthCode);
    if (currentIdx === -1) return 'UNKNOWN';

    const nextIdx = (currentIdx + 1) % 4;
    const nextMonthCode = cycle[nextIdx];
    const nextYearDigit = nextIdx === 0 ? (yearDigit + 1) % 10 : yearDigit;

    return `${symbolPrefix}${nextMonthCode}${nextYearDigit}`;
  }

  /**
   * Extract base symbol from contract name (e.g., "MNQM6" → "MNQ").
   * @param {string} contractName
   * @returns {string}
   */
  _extractBaseSymbol(contractName) {
    if (!contractName || contractName.length < 4) return '';
    return contractName.slice(0, -2);
  }

  /**
   * Send notification via Telegram.
   * @param {string} message - HTML-formatted message
   * @private
   */
  async _sendNotification(message) {
    if (!this.notifications) {
      logger.warn(`[RollReminder] No notifications instance — cannot send reminder`);
      return;
    }
    try {
      await this.notifications.send(message);
    } catch (err) {
      logger.error(`[RollReminder] Failed to send notification: ${err.message}`);
    }
  }
}

module.exports = ContractRollReminder;
