import "dotenv/config";

export const PORT = Number(process.env.PORT ?? 4000);
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
export const QUESTION_SECONDS = 15;
export const RESULT_MS = 2000;
export const LEADERBOARD_MS = 3000;
export const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 1000 * 60 * 60 * 2);
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
