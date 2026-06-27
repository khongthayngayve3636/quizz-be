import { SystemLogModel, SystemLogType } from "../db.js";
import { logger } from "../utils/logger.js";

export async function logSystemEvent(log: Omit<SystemLogType, "createdAt">) {
  try {
    let sanitizedMetadata = log.metadata;
    if (sanitizedMetadata && typeof sanitizedMetadata === "object") {
       try {
           const str = JSON.stringify(sanitizedMetadata);
           if (str.length > 20000) {
               sanitizedMetadata = { _error: "Metadata too large, truncated", originalKeys: Object.keys(sanitizedMetadata) };
           } else {
               sanitizedMetadata = JSON.parse(str);
           }
       } catch (e) {
           sanitizedMetadata = { _error: "Failed to stringify metadata" };
       }
    }

    const newLog = new SystemLogModel({
      ...log,
      metadata: sanitizedMetadata
    });

    await newLog.save();
    
    if (log.level === "error" || log.level === "critical") {
        console.error(`[${log.category}] ${log.action}: ${log.message}`);
    } else if (log.level === "warning") {
        console.warn(`[${log.category}] ${log.action}: ${log.message}`);
    } else {
        console.log(`[${log.category}] ${log.action}: ${log.message}`);
    }
  } catch (error) {
    console.error("Failed to save system log", error);
  }
}
