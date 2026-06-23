import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { connectMongo, isMongoConnected, QuizModel, saveGeneratedQuiz } from "./db.js";
import { sampleQuiz, type QuizQuestion } from "./sampleQuiz.js";

type RoomStatus = "waiting" | "question" | "result" | "leaderboard" | "finished";

type Player = {
  id: string;
  name: string;
  score: number;
  connected: boolean;
};

type Submission = {
  playerId: string;
  answer: string;
  correct: boolean;
  points: number;
  submittedAt: number;
};

type Room = {
  code: string;
  hostSocketId: string;
  status: RoomStatus;
  currentQuestion: number;
  questionStartedAt: number;
  quiz: QuizQuestion[];
  players: Map<string, Player>;
  submissions: Map<string, Submission>;
  timers: NodeJS.Timeout[];
  createdAt: Date;
};

type QuizPack = {
  title: string;
  topic: string;
  difficulty: string;
  questions: QuizQuestion[];
};

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const QUESTION_SECONDS = 15;
const RESULT_MS = 2000;
const LEADERBOARD_MS = 3000;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 1000 * 60 * 60 * 2);
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CLIENT_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    }
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, mongoConnected: isMongoConnected() });
});

app.get("/api/quizzes", async (_req, res) => {
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

app.post("/api/quizzes/generate", async (req, res) => {
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

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin || CLIENT_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"]
  }
});

const rooms = new Map<string, Room>();

function publicQuestion(question: QuizQuestion) {
  if (question.type === "mcq") {
    return {
      type: question.type,
      question: question.question,
      options: question.options
    };
  }

  return {
    type: question.type,
    question: question.question
  };
}

function leaderboard(room: Room) {
  return [...room.players.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostSocketId
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function lobbyPlayers(room: Room) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    connected: player.connected,
    isHost: player.id === room.hostSocketId
  }));
}

function emitPlayerList(room: Room) {
  io.to(room.code).emit("player-list", {
    roomCode: room.code,
    players: lobbyPlayers(room),
    hostSocketId: room.hostSocketId
  });
}

function emitError(socketId: string, message: string) {
  io.to(socketId).emit("app-error", { message });
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error("Unable to generate room code");
}

function normalizeQuizRequest(body: unknown) {
  const source = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const topic = cleanText(source.topic, "Travel").slice(0, 40);
  const difficulty = cleanText(source.difficulty, "Easy").slice(0, 20);
  const count = Math.min(Math.max(Number(source.questions) || 5, 3), 15);
  const rawTypes = Array.isArray(source.types) ? source.types : ["mcq", "unscramble"];
  const types = rawTypes
    .map((type) => String(type))
    .filter((type): type is QuizQuestion["type"] => type === "mcq" || type === "unscramble");

  return {
    topic,
    difficulty,
    questions: count,
    types: types.length ? types : (["mcq", "unscramble"] as QuizQuestion["type"][])
  };
}

function cleanText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function extractJson(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    return text.substring(arrayStart, arrayEnd + 1);
  }

  throw new Error("Gemini did not return valid JSON.");
}

function normalizeGeneratedQuiz(raw: unknown, request: ReturnType<typeof normalizeQuizRequest>): QuizPack {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawQuestions = Array.isArray(source.questions) ? source.questions : Array.isArray(raw) ? raw : [];
  const questions = rawQuestions.map(normalizeGeneratedQuestion).filter((question): question is QuizQuestion => Boolean(question));

  if (questions.length < 1) {
    throw new Error("Gemini returned no usable quiz questions.");
  }

  return {
    title: cleanText(source.title, `${request.topic} ${request.difficulty}`),
    topic: request.topic,
    difficulty: request.difficulty,
    questions: questions.slice(0, request.questions)
  };
}

function normalizeGeneratedQuestion(raw: unknown): QuizQuestion | null {
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
      answer
    };
  }

  return {
    type,
    question,
    answer
  };
}

function validateClientQuiz(value: unknown): QuizQuestion[] | null {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawQuestions = Array.isArray(source.questions) ? source.questions : Array.isArray(value) ? value : [];
  const questions = rawQuestions.map(normalizeGeneratedQuestion).filter((question): question is QuizQuestion => Boolean(question));
  return questions.length ? questions.slice(0, 15) : null;
}

function getGeminiOutputText(data: Record<string, unknown>) {
  const directText = cleanText(data.output_text ?? data.outputText, "");
  if (directText) {
    return directText;
  }

  const steps = Array.isArray(data.steps) ? data.steps : [];
  const textBlocks = steps.flatMap((step) => {
    if (typeof step !== "object" || step === null) {
      return [];
    }

    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .map((item) => {
        if (typeof item !== "object" || item === null) {
          return "";
        }

        return cleanText((item as Record<string, unknown>).text, "");
      })
      .filter(Boolean);
  });

  return textBlocks.join("\n").trim();
}

async function generateQuizWithGemini(request: ReturnType<typeof normalizeQuizRequest>) {
  const prompt = [
    `Generate ${request.questions} English OPIC practice quiz questions.`,
    `Topic: ${request.topic}`,
    `Difficulty: ${request.difficulty}`,
    `Allowed types: ${request.types.join(", ")}`,
    "Return JSON only with this shape:",
    "{\"title\":\"string\",\"questions\":[{\"type\":\"mcq\",\"question\":\"string\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":\"string\"},{\"type\":\"unscramble\",\"question\":\"scrambled letters\",\"answer\":\"word\"}]}",
    "Rules: MCQ answer must exactly match one option. Unscramble question must be scrambled lowercase letters only. Keep questions short and classroom friendly."
  ].join("\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY ?? ""
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: "You create valid JSON quiz packs for a realtime English learning game. Think step-by-step before outputting the final JSON. Make sure to output valid JSON starting with { and ending with }.",
      input: prompt,
      generation_config: {
        temperature: 0.8
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${details.slice(0, 180)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const outputText = getGeminiOutputText(data);
  if (!outputText) {
    throw new Error("Gemini returned an empty response.");
  }

  const parsed = JSON.parse(extractJson(outputText)) as unknown;
  return normalizeGeneratedQuiz(parsed, request);
}

function normalizeAnswer(answer: string) {
  return answer.trim().toLowerCase();
}

function scoreFor(correct: boolean, elapsedSeconds: number) {
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

function clearRoomTimers(room: Room) {
  room.timers.forEach((timer) => clearTimeout(timer));
  room.timers = [];
}

function deleteRoom(room: Room) {
  clearRoomTimers(room);
  rooms.delete(room.code);
}

function cleanupExpiredRooms() {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (now - room.createdAt.getTime() > ROOM_TTL_MS) {
      deleteRoom(room);
    }
  }
}

function getCurrentQuestion(room: Room) {
  return room.quiz[room.currentQuestion];
}

function startQuestion(room: Room) {
  clearRoomTimers(room);
  room.status = "question";
  room.submissions.clear();
  room.questionStartedAt = Date.now();

  const question = getCurrentQuestion(room);
  io.to(room.code).emit("question-start", {
    roomCode: room.code,
    questionNumber: room.currentQuestion + 1,
    totalQuestions: room.quiz.length,
    durationSeconds: QUESTION_SECONDS,
    startedAt: room.questionStartedAt,
    question: publicQuestion(question)
  });

  room.timers.push(
    setTimeout(() => {
      finishQuestion(room);
    }, QUESTION_SECONDS * 1000)
  );
}

function finishQuestion(room: Room) {
  if (room.status !== "question") {
    return;
  }

  clearRoomTimers(room);
  room.status = "result";
  const question = getCurrentQuestion(room);

  io.to(room.code).emit("answer-result", {
    roomCode: room.code,
    correctAnswer: question.answer,
    submissions: [...room.submissions.values()],
    leaderboard: leaderboard(room)
  });

  room.timers.push(
    setTimeout(() => {
      showLeaderboard(room);
    }, RESULT_MS)
  );
}

function showLeaderboard(room: Room) {
  room.status = "leaderboard";

  const isFinal = room.currentQuestion >= room.quiz.length - 1;
  io.to(room.code).emit("leaderboard-update", {
    roomCode: room.code,
    leaderboard: leaderboard(room),
    nextQuestionInSeconds: isFinal ? 0 : LEADERBOARD_MS / 1000,
    isFinal
  });

  room.timers.push(
    setTimeout(() => {
      if (isFinal) {
        finishGame(room);
        return;
      }

      room.currentQuestion += 1;
      startQuestion(room);
    }, LEADERBOARD_MS)
  );
}

function finishGame(room: Room) {
  clearRoomTimers(room);
  room.status = "finished";
  io.to(room.code).emit("game-over", {
    roomCode: room.code,
    leaderboard: leaderboard(room)
  });
}

function maybeFinishWhenAllAnswered(room: Room) {
  const connectedPlayers = [...room.players.values()].filter((player) => player.connected);
  if (connectedPlayers.length > 0 && connectedPlayers.every((player) => room.submissions.has(player.id))) {
    finishQuestion(room);
  }
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name, quiz }: { name: string; quiz?: unknown }) => {
    const trimmedName = name?.trim();
    if (!trimmedName) {
      emitError(socket.id, "Please enter your name.");
      return;
    }

    const code = generateRoomCode();
    const room: Room = {
      code,
      hostSocketId: socket.id,
      status: "waiting",
      currentQuestion: 0,
      questionStartedAt: 0,
      quiz: validateClientQuiz(quiz) ?? sampleQuiz,
      players: new Map(),
      submissions: new Map(),
      timers: [],
      createdAt: new Date()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: trimmedName,
      score: 0,
      connected: true
    });
    rooms.set(code, room);
    socket.join(code);

    socket.emit("room-created", {
      roomCode: code,
      playerId: socket.id,
      isHost: true
    });
    emitPlayerList(room);
  });

  socket.on("join-room", ({ name, roomCode }: { name: string; roomCode: string }) => {
    const trimmedName = name?.trim();
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);

    if (!trimmedName) {
      emitError(socket.id, "Please enter your name.");
      return;
    }

    if (!room) {
      emitError(socket.id, "Room not found.");
      return;
    }

    if (room.status !== "waiting") {
      emitError(socket.id, "This game has already started.");
      return;
    }

    const nameExists = [...room.players.values()].some(
      (player) => player.connected && player.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );

    if (nameExists) {
      emitError(socket.id, "That name is already in this room.");
      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: trimmedName,
      score: 0,
      connected: true
    });
    socket.join(code);

    socket.emit("room-joined", {
      roomCode: code,
      playerId: socket.id,
      isHost: socket.id === room.hostSocketId
    });
    emitPlayerList(room);
  });

  socket.on("start-game", ({ roomCode }: { roomCode: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      emitError(socket.id, "Room not found.");
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket.id, "Only the host can start the game.");
      return;
    }

    if (room.players.size === 0) {
      emitError(socket.id, "Add at least one player before starting.");
      return;
    }

    room.currentQuestion = 0;
    [...room.players.values()].forEach((player) => {
      player.score = 0;
      player.connected = true;
    });
    startQuestion(room);
  });

  socket.on("submit-answer", ({ roomCode, answer }: { roomCode: string; answer: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room || room.status !== "question") {
      emitError(socket.id, "No active question.");
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      emitError(socket.id, "You are not in this room.");
      return;
    }

    if (room.submissions.has(socket.id)) {
      return;
    }

    const question = getCurrentQuestion(room);
    const elapsedSeconds = (Date.now() - room.questionStartedAt) / 1000;
    const correct = normalizeAnswer(answer) === normalizeAnswer(question.answer);
    const points = scoreFor(correct, elapsedSeconds);
    player.score += points;

    const submission: Submission = {
      playerId: socket.id,
      answer,
      correct,
      points,
      submittedAt: Date.now()
    };
    room.submissions.set(socket.id, submission);

    socket.emit("answer-submitted", {
      roomCode: code,
      correct,
      points
    });

    maybeFinishWhenAllAnswered(room);
  });

  socket.on("play-again", ({ roomCode }: { roomCode: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      emitError(socket.id, "Room not found.");
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket.id, "Only the host can restart the game.");
      return;
    }

    clearRoomTimers(room);
    room.status = "waiting";
    room.currentQuestion = 0;
    room.submissions.clear();
    [...room.players.values()].forEach((player) => {
      player.score = 0;
    });
    io.to(room.code).emit("room-reset", { roomCode: room.code });
    emitPlayerList(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (!player) {
        continue;
      }

      player.connected = false;

      if (socket.id === room.hostSocketId) {
        const nextHost = [...room.players.values()].find((candidate) => candidate.connected);
        if (nextHost) {
          room.hostSocketId = nextHost.id;
        }
      }

      emitPlayerList(room);
      maybeFinishWhenAllAnswered(room);

      const hasConnectedPlayers = [...room.players.values()].some((candidate) => candidate.connected);
      if (!hasConnectedPlayers) {
        deleteRoom(room);
      }
    }
  });
});

async function startServer() {
  try {
    await connectMongo();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown MongoDB error";
    console.warn(`MongoDB connection failed: ${message}`);
  }

  httpServer.listen(PORT, () => {
    console.log(`OPIC Quiz Battle backend running on http://localhost:${PORT}`);
  });
}

void startServer();

setInterval(cleanupExpiredRooms, 1000 * 60 * 10).unref();
