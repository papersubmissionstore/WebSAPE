/**
 * Custom transport to bridge Eko library logs to the extension logger
 * This allows Eko's internal Log.info/debug/error calls to appear in the extension UI
 */

// Define the Transport interface and LogLevel enum locally since they're not exported
export interface Transport {
  log(level: LogLevel, message: string): void;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
  OFF = 5
}

export class ExtensionTransport implements Transport {
  log(level: LogLevel, message: string): void {
    try {
      // Map Eko log levels to extension log levels
      let extensionLevel: "info" | "error" | "success" = "info";
      if (level >= LogLevel.ERROR) {
        extensionLevel = "error";
      }

      // Send to extension UI – swallow "receiving end does not exist" when
      // the sidebar is not yet open (MV3 returns a Promise).
      Promise.resolve(chrome.runtime.sendMessage({
        type: "log",
        log: message,
        level: extensionLevel,
      })).catch(() => { /* sidebar not open */ });
    } catch (e) {
      // Silently fail if UI is not available
    }
  }
}