/**
 * File-based logging system
 * Logs are written to separate files by category and rotated daily
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
type LogCategory = 'mining' | 'wallet' | 'hash' | 'api' | 'general';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: any;
}

class Logger {
  private static getLogFileName(category: LogCategory): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOG_DIR, `${category}-${date}.log`);
  }

  private static formatLogEntry(entry: LogEntry): string {
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    return `[${entry.timestamp}] [${entry.level}] [${entry.category}] ${entry.message}${dataStr}\n`;
  }

  private static writeLog(entry: LogEntry): void {
    const logFile = this.getLogFileName(entry.category);
    const logLine = this.formatLogEntry(entry);

    // Write to file (append)
    try {
      fs.appendFileSync(logFile, logLine);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }

    // Also output to console
    const consoleMsg = `[${entry.category}] ${entry.message}`;
    switch (entry.level) {
      case 'ERROR':
        console.error(consoleMsg, entry.data || '');
        break;
      case 'WARN':
        console.warn(consoleMsg, entry.data || '');
        break;
      case 'DEBUG':
        if (process.env.NODE_ENV !== 'production') {
          console.debug(consoleMsg, entry.data || '');
        }
        break;
      default:
        console.log(consoleMsg, entry.data || '');
    }
  }

  static log(category: LogCategory, message: string, data?: any): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category,
      message,
      data,
    });
  }

  static error(category: LogCategory, message: string, error?: any): void {
    const errorData = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : error;

    this.writeLog({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      category,
      message,
      data: errorData,
    });
  }

  static warn(category: LogCategory, message: string, data?: any): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      category,
      message,
      data,
    });
  }

  static debug(category: LogCategory, message: string, data?: any): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      category,
      message,
      data,
    });
  }

  /**
   * Clean up old log files (older than 7 days)
   */
  static cleanupOldLogs(daysToKeep: number = 7): void {
    try {
      const files = fs.readdirSync(LOG_DIR);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      for (const file of files) {
        if (!file.endsWith('.log')) continue;

        const filePath = path.join(LOG_DIR, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old log file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  /**
   * Get list of available log files
   */
  static getLogFiles(): string[] {
    try {
      return fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse(); // Newest first
    } catch (error) {
      return [];
    }
  }

  /**
   * Read recent log entries from a file
   */
  static readRecentLogs(category: LogCategory, limit: number = 100): string[] {
    const logFile = this.getLogFileName(category);

    try {
      if (!fs.existsSync(logFile)) {
        return [];
      }

      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');

      // Return last N lines
      return lines.slice(-limit);
    } catch (error) {
      console.error('Failed to read log file:', error);
      return [];
    }
  }
}

// Cleanup old logs on module load (once per day)
if (Math.random() < 0.1) { // 10% chance to run cleanup
  Logger.cleanupOldLogs();
}

export default Logger;
