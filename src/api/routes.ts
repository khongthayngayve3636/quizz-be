import { Router } from "express";
import { GEMINI_API_KEY } from "../config.js";
import { isMongoConnected, QuizModel, saveGeneratedQuiz } from "../db.js";
import { generateQuizWithGemini, normalizeQuizRequest } from "../services/gemini.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, mongoConnected: isMongoConnected() });
});

router.get("/api/quizzes", async (_req, res) => {
  if (!isMongoConnected()) {
    res.json({ quizzes: [] });
    return;
  }

  const quizzes = await QuizModel.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .select("title topic difficulty questions createdAt")
    .lean();
  res.json({ quizzes });
});

router.post("/api/quizzes/generate", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      res.status(503).json({
        message: "Gemini is not configured. Add GEMINI_API_KEY to backend/.env or the server environment."
      });
      return;
    }

    const quizRequest = normalizeQuizRequest(req.body);
    const quiz = await generateQuizWithGemini(quizRequest);
    const savedQuiz = await saveGeneratedQuiz(quiz);
    res.json({
      quiz: {
        ...quiz,
        id: savedQuiz?._id?.toString()
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate quiz.";
    res.status(400).json({ message });
  }
});

export { router as apiRoutes };
