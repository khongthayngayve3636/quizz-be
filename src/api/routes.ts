import { Router } from "express";
import { GEMINI_API_KEY } from "../config.js";
import { isMongoConnected, QuizModel, saveGeneratedQuiz, StudentModel } from "../db.js";
import { generateQuizWithGemini, normalizeQuizRequest } from "../services/gemini.js";
import { logSystemEvent } from "../services/systemLogger.js";
import { logger } from "../utils/logger.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, mongoConnected: isMongoConnected() });
});

router.get("/api/leaderboard", async (_req, res) => {
  if (!isMongoConnected()) {
    res.json({ leaderboard: [] });
    return;
  }

  try {
    const leaderboard = await StudentModel.find()
      .sort({ score: -1 })
      .limit(50)
      .select("name score -_id")
      .lean();
    res.json({ leaderboard });
  } catch (error) {
    logger.error("Failed to fetch leaderboard", error);
    res.status(500).json({ message: "Failed to fetch leaderboard" });
  }
});

router.get("/api/quizzes", async (req, res) => {
  if (!isMongoConnected()) {
    res.json({ quizzes: [], total: 0, hasMore: false });
    return;
  }

  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string || "").trim();
    
    const query: any = {};
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { topic: { $regex: search, $options: "i" } }
      ];
    }

    const quizzes = await QuizModel.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("title topic difficulty questions createdAt")
      .lean();
      
    const total = await QuizModel.countDocuments(query);
    const hasMore = (page * limit) < total;

    res.json({ quizzes, total, hasMore, page });
  } catch (error) {
    logger.error("Failed to fetch quizzes", error);
    res.status(500).json({ message: "Failed to fetch quizzes" });
  }
});

router.post("/api/quizzes/generate", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      logger.warn("Gemini is not configured when generate was called.");
      res.status(503).json({
        message: "AI generation is currently disabled."
      });
      return;
    }

    const quizRequest = normalizeQuizRequest(req.body);
    
    void logSystemEvent({
      level: "info",
      category: "quiz",
      action: "QUIZ_GENERATE_REQUESTED",
      message: `Quiz generation requested: ${quizRequest.topic}`,
      metadata: { topic: quizRequest.topic, difficulty: quizRequest.difficulty }
    });

    const quiz = await generateQuizWithGemini(quizRequest);
    
    void logSystemEvent({
      level: "info",
      category: "quiz",
      action: "QUIZ_GENERATE_SUCCESS",
      message: `Quiz generated successfully`,
      metadata: { topic: quiz.topic, questionsCount: quiz.questions.length }
    });

    const savedQuiz = await saveGeneratedQuiz(quiz);
    
    if (savedQuiz) {
      void logSystemEvent({
        level: "info",
        category: "quiz",
        action: "QUIZ_SAVED",
        message: `Quiz saved to database`,
        metadata: { quizId: savedQuiz._id?.toString() }
      });
    }

    res.json({
      quiz: {
        ...quiz,
        id: savedQuiz?._id?.toString()
      }
    });
  } catch (error: any) {
    logger.error("Failed to generate quiz", error);
    void logSystemEvent({
      level: "error",
      category: "ai",
      action: "QUIZ_GENERATE_FAILED",
      message: `Quiz generation failed`,
      metadata: { error: error.message }
    });
    res.status(400).json({ message: "Unable to generate quiz at this time. Please try again." });
  }
});

export { router as apiRoutes };
