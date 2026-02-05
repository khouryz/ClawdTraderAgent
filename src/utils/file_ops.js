/**
 * Async File Operations
 * Non-blocking file operations to prevent event loop blocking
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class FileOps {
  /**
   * Ensure directory exists (async)
   */
  static async ensureDir(dirPath) {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Ensure directory exists (sync - for initialization only)
   */
  static ensureDirSync(dirPath) {
    if (!fsSync.existsSync(dirPath)) {
      fsSync.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Read JSON file (async)
   */
  static async readJSON(filePath, defaultValue = null) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return defaultValue;
      }
      throw error;
    }
  }

  /**
   * Write JSON file (async)
   */
  static async writeJSON(filePath, data) {
    const dir = path.dirname(filePath);
    await this.ensureDir(dir);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Append to file (async)
   */
  static async appendFile(filePath, content) {
    const dir = path.dirname(filePath);
    await this.ensureDir(dir);
    await fs.appendFile(filePath, content, 'utf8');
  }

  /**
   * Check if file exists (async)
   */
  static async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read JSON file (sync - for initialization)
   */
  static readJSONSync(filePath, defaultValue = null) {
    try {
      if (fsSync.existsSync(filePath)) {
        const data = fsSync.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
      }
      return defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Write JSON file (sync - for critical saves)
   */
  static writeJSONSync(filePath, data) {
    const dir = path.dirname(filePath);
    this.ensureDirSync(dir);
    fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

module.exports = FileOps;
