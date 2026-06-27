import { SystemLogModel, isMongoConnected, LogLevel } from "../db.js";

export const logger = {
  info: (message: string, metadata?: any) => log("info", message, metadata),
  warn: (message: string, metadata?: any) => log("warning", message, metadata),
  error: (message: string, metadata?: any) => log("error", message, metadata)
};

async function log(level: LogLevel, message: string, metadata?: any) {
  // Always log to console
  if (level === "error" || level === "critical") {
    console.error(`[${level.toUpperCase()}] ${message}`, metadata || "");
  } else if (level === "warning") {
    console.warn(`[${level.toUpperCase()}] ${message}`, metadata || "");
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`, metadata || "");
  }

  // Save to database if connected
  if (isMongoConnected()) {
    try {
      // Avoid circular JSON issues by stringifying and parsing if needed
      let safeMetadata = metadata;
      if (metadata instanceof Error) {
        safeMetadata = { message: metadata.message, stack: metadata.stack };
      } else if (metadata) {
        try {
          safeMetadata = JSON.parse(JSON.stringify(metadata));
        } catch (e) {
          safeMetadata = String(metadata);
        }
      }

      await SystemLogModel.create({
        level,
        category: "system",
        action: "SYSTEM_LOG",
        message,
        metadata: safeMetadata
      });
    } catch (dbError) {
      console.error("[LOGGER ERROR] Failed to save log to DB:", dbError);
    }
  }
}
