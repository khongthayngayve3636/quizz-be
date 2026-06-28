import { type QuizQuestion } from "../sampleQuiz.js";
import { cleanText, normalizeAnswer } from "./helpers.js";

export function normalizeGeneratedQuestion(raw: unknown): QuizQuestion | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const rawType = String(source.type ?? "").toLowerCase();
  const type = rawType === "multiple_choice" || rawType === "mcq" ? "mcq" : rawType === "unscramble" ? "unscramble" : null;
  const question = cleanText(source.question, "");
  const answer = cleanText(source.answer, "");

  if (!type || !question || !answer) {
    return null;
  }

  if (type === "mcq") {
    const options = Array.isArray(source.options)
      ? source.options.map((option) => cleanText(option, "")).filter(Boolean)
      : [];
    const uniqueOptions = [...new Set(options)];

    if (uniqueOptions.length < 4) {
      return null;
    }

    if (!uniqueOptions.some((option) => normalizeAnswer(option) === normalizeAnswer(answer))) {
      uniqueOptions[0] = answer;
    }

    return {
      type,
      question,
      options: uniqueOptions.slice(0, 4),
      answer,
      ...(typeof source.imageKeyword === "string" ? { imageKeyword: source.imageKeyword } : {}),
      ...(typeof source.imageUrl === "string" ? { imageUrl: source.imageUrl } : {})
    };
  }

  return {
    type,
    question,
    answer,
    ...(typeof source.imageKeyword === "string" ? { imageKeyword: source.imageKeyword } : {}),
    ...(typeof source.imageUrl === "string" ? { imageUrl: source.imageUrl } : {})
  };
}

export function validateClientQuiz(value: unknown): QuizQuestion[] | null {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawQuestions = Array.isArray(source.questions) ? source.questions : Array.isArray(value) ? value : [];
  const questions = rawQuestions.map(normalizeGeneratedQuestion).filter((question): question is QuizQuestion => Boolean(question));
  return questions.length ? questions.slice(0, 15) : null;
}
