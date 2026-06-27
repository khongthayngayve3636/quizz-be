import mongoose, { Schema } from "mongoose";
import type { QuizQuestion } from "./sampleQuiz.js";

export type StoredQuiz = {
  title: string;
  topic: string;
  difficulty: string;
  questions: QuizQuestion[];
  source: "gemini" | "sample";
  createdAt: Date;
};

const quizSchema = new Schema(
  {
    title: { type: String, required: true },
    topic: { type: String, required: true },
    difficulty: { type: String, required: true },
    questions: { type: [Schema.Types.Mixed], required: true },
    source: { type: String, enum: ["gemini", "sample"], required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const QuizModel = mongoose.model<StoredQuiz>("Quiz", quizSchema);

export type StoredStudent = {
  name: string;
  score: number;
};

const studentSchema = new Schema<StoredStudent>(
  {
    name: { type: String, required: true, unique: true },
    score: { type: Number, required: true, default: 0 }
  },
  { timestamps: true }
);

export const StudentModel = mongoose.model<StoredStudent>("Student", studentSchema);

export type AdminUserType = {
  username: string;
  passwordHash: string;
};

const adminUserSchema = new Schema<AdminUserType>(
  {
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true }
  },
  { timestamps: true }
);

export const AdminUserModel = mongoose.model<AdminUserType>("AdminUser", adminUserSchema);

export type LogLevel = "info" | "warning" | "error" | "critical";
export type LogCategory = "auth" | "room" | "player" | "quiz" | "game" | "leaderboard" | "ai" | "database" | "socket" | "admin" | "system";

export interface SystemLogType {
  level: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  actor?: {
    type: "admin" | "player" | "host" | "system";
    id?: string;
    name?: string;
    socketId?: string;
    ip?: string;
  };
  target?: {
    type: "room" | "quiz" | "player" | "student" | "game" | "admin" | "database";
    id?: string;
    name?: string;
    roomCode?: string;
  };
  metadata?: Record<string, any>;
  createdAt: Date;
}

const systemLogSchema = new Schema<SystemLogType>(
  {
    level: { type: String, required: true },
    category: { type: String, required: true },
    action: { type: String, required: true },
    message: { type: String, required: true },
    actor: { type: Schema.Types.Mixed },
    target: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Indexes
systemLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
systemLogSchema.index({ category: 1 });
systemLogSchema.index({ level: 1 });
systemLogSchema.index({ action: 1 });
systemLogSchema.index({ "actor.name": 1 });
systemLogSchema.index({ "target.roomCode": 1 });

export const SystemLogModel = mongoose.model<SystemLogType>("SystemLog", systemLogSchema);

import { logger } from "./utils/logger.js";

export async function connectMongo() {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;

  if (!uri) {
    logger.warn("MongoDB connection string missing. Database persistence is disabled.");
    return false;
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000
  });
  logger.info("MongoDB connection established successfully.");
  return true;
}

export function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

export async function saveGeneratedQuiz(quiz: Omit<StoredQuiz, "createdAt" | "source">) {
  if (!isMongoConnected()) {
    return null;
  }

  return QuizModel.create({
    ...quiz,
    source: "gemini"
  });
}
