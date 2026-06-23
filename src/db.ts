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

export async function connectMongo() {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;

  if (!uri) {
    console.log("MongoDB not configured. Set MONGODB_URI or MONGO_URI to persist generated quizzes.");
    return false;
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000
  });
  console.log("MongoDB connected.");
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
