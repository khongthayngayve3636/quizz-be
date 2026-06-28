import { type QuizQuestion } from "../sampleQuiz.js";
import { type Room } from "../types.js";

export function cleanText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function generateRoomCode(rooms: Map<string, Room>) {
  const alphabet = "0123456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error("Unable to generate room code");
}

export function normalizeAnswer(answer: string) {
  return answer.trim().toLowerCase();
}

export function scoreFor(correct: boolean, elapsedSeconds: number) {
  if (!correct) {
    return 0;
  }

  if (elapsedSeconds < 3) return 150;
  if (elapsedSeconds < 5) return 140;
  if (elapsedSeconds < 8) return 130;
  if (elapsedSeconds < 12) return 120;
  if (elapsedSeconds < 15) return 110;
  return 100;
}

export function publicQuestion(question: QuizQuestion) {
  if (question.type === "mcq") {
    return {
      type: question.type,
      question: question.question,
      options: question.options,
      ...(question.imageUrl ? { imageUrl: question.imageUrl } : {})
    };
  }

  return {
    type: question.type,
    question: question.question,
    ...(question.imageUrl ? { imageUrl: question.imageUrl } : {})
  };
}
