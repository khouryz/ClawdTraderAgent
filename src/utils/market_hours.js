/**
 * Market Hours Utility
 * Checks if futures market is open for trading
 * CME Globex hours: Sunday 6pm - Friday 5pm ET (with daily break 5pm-6pm ET)
 */

class MarketHours {
  constructor(timezone = 'America/New_York') {
    this.timezone = timezone;
  }

  /**
   * Get current time in ET
   */
  getNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
  }

  /**
   * Check if market is currently open
   */
  isMarketOpen() {
    const now = this.getNow();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = now.getHours();
    const minute = now.getMinutes();
    const time = hour * 60 + minute; // Minutes since midnight

    // Market closed all day Saturday
    if (day === 6) return false;

    // Sunday: Opens at 6pm ET (18:00)
    if (day === 0) {
      return time >= 18 * 60; // After 6pm
    }

    // Friday: Closes at 5pm ET (17:00)
    if (day === 5) {
      return time < 17 * 60; // Before 5pm
    }

    // Mon-Thu: Open except daily maintenance 5pm-6pm ET
    // Daily break: 5:00pm - 6:00pm ET
    const maintenanceStart = 17 * 60; // 5pm
    const maintenanceEnd = 18 * 60;   // 6pm

    if (time >= maintenanceStart && time < maintenanceEnd) {
      return false; // During maintenance
    }

    return true;
  }

  /**
   * Check if within optimal trading hours (high liquidity)
   */
  isOptimalTradingTime() {
    const now = this.getNow();
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const time = hour * 60 + minute;

    // Only trade Mon-Fri
    if (day === 0 || day === 6) return false;

    // Optimal hours: 9:30am - 11:30am ET and 2:00pm - 4:00pm ET
    const morningStart = 9 * 60 + 30;  // 9:30am
    const morningEnd = 11 * 60 + 30;   // 11:30am
    const afternoonStart = 14 * 60;     // 2:00pm
    const afternoonEnd = 16 * 60;       // 4:00pm

    return (time >= morningStart && time < morningEnd) ||
           (time >= afternoonStart && time < afternoonEnd);
  }

  /**
   * Get time until market opens (in minutes)
   */
  getTimeUntilOpen() {
    if (this.isMarketOpen()) return 0;

    const now = this.getNow();
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const time = hour * 60 + minute;

    // If Saturday, wait until Sunday 6pm
    if (day === 6) {
      return (24 * 60 - time) + (18 * 60); // Rest of Saturday + Sunday until 6pm
    }

    // If Sunday before 6pm
    if (day === 0 && time < 18 * 60) {
      return 18 * 60 - time;
    }

    // If during daily maintenance (5pm-6pm)
    if (time >= 17 * 60 && time < 18 * 60) {
      return 18 * 60 - time;
    }

    // If Friday after 5pm
    if (day === 5 && time >= 17 * 60) {
      // Wait until Sunday 6pm
      return (24 * 60 - time) + (24 * 60) + (18 * 60); // Rest of Fri + Sat + Sun until 6pm
    }

    return 0;
  }

  /**
   * Get market status as string
   */
  getStatus() {
    const isOpen = this.isMarketOpen();
    const isOptimal = this.isOptimalTradingTime();
    const minutesUntilOpen = this.getTimeUntilOpen();

    return {
      isOpen,
      isOptimal,
      minutesUntilOpen,
      status: isOpen 
        ? (isOptimal ? 'OPTIMAL' : 'OPEN') 
        : 'CLOSED',
      message: isOpen
        ? (isOptimal ? 'Market open - optimal trading hours' : 'Market open - low liquidity period')
        : `Market closed - opens in ${Math.floor(minutesUntilOpen / 60)}h ${minutesUntilOpen % 60}m`
    };
  }
}

module.exports = MarketHours;
