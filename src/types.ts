import { type QuizQuestion } from "./sampleQuiz.js";

export type RoomStatus = "waiting" | "countdown" | "question" | "result" | "leaderboard" | "finished";

export type Player = {
  id: string;
  sessionId: string;
  name: string;
  icon?: string;
  score: number;
  connected: boolean;
  isReady: boolean;
  wrongAttempts: number;
  streak: number;
};

export type Submission = {
  playerId: string;
  answer: string;
  correct: boolean;
  points: number;
  streak: number;
  submittedAt: number;
};

export type Room = {
  code: string;
  hostSocketId: string;
  status: RoomStatus;
  currentQuestion: number;
  questionStartedAt: number;
  quizTitle?: string;
  quiz: QuizQuestion[];
  players: Map<string, Player>;
  submissions: Map<string, Submission>;
  timers: NodeJS.Timeout[];
  createdAt: Date;
};

export type QuizPack = {
  title: string;
  topic: string;
  difficulty: string;
  questions: QuizQuestion[];
};
