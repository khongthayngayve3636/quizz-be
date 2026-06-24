import { Server, Socket } from "socket.io";
import { sampleQuiz } from "../sampleQuiz.js";
import { type Room, type Submission } from "../types.js";
import { generateRoomCode, normalizeAnswer, scoreFor, publicQuestion } from "../utils/helpers.js";
import { validateClientQuiz } from "../utils/quizValidation.js";
import {
  clearRoomTimers,
  deleteRoom,
  emitError,
  emitPlayerList,
  getCurrentQuestion,
  maybeFinishWhenAllAnswered,
  startQuestionCountdown,
  leaderboard
} from "./roomManager.js";
import { rooms } from "./store.js";

export function registerSocketHandlers(io: Server, socket: Socket) {
  socket.on("create-room", ({ name, icon, sessionId, quiz }: { name: string; icon?: string; sessionId?: string; quiz?: any }) => {
    const trimmedName = name?.trim();
    if (!trimmedName) {
      emitError(socket.id, "Please enter your name.");
      return;
    }

    const code = generateRoomCode(rooms);
    const room: Room = {
      code,
      hostSocketId: socket.id,
      status: "waiting",
      currentQuestion: 0,
      questionStartedAt: 0,
      quizTitle: quiz?.title || "Untitled Quiz",
      quiz: validateClientQuiz(quiz) ?? sampleQuiz,
      players: new Map(),
      submissions: new Map(),
      timers: [],
      createdAt: new Date()
    };

    room.players.set(socket.id, {
      id: socket.id,
      sessionId: sessionId || socket.id,
      name: trimmedName,
      icon,
      score: 0,
      connected: true,
      isReady: true,
      wrongAttempts: 0,
      streak: 0
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

  socket.on("join-room", ({ name, icon, sessionId, roomCode }: { name: string; icon?: string; sessionId?: string; roomCode: string }) => {
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

    if (sessionId) {
      const existingPlayerEntry = [...room.players.entries()].find(([id, p]) => p.sessionId === sessionId);
      if (existingPlayerEntry) {
        const [oldSocketId, player] = existingPlayerEntry;
        if (player.connected) {
          emitError(socket.id, "Session already active.");
          return;
        }
        
        room.players.delete(oldSocketId);
        player.id = socket.id;
        player.connected = true;
        if (icon) player.icon = icon;
        player.name = trimmedName;
        room.players.set(socket.id, player);
        
        if (room.hostSocketId === oldSocketId) {
          room.hostSocketId = socket.id;
        }
        
        const submission = room.submissions.get(oldSocketId);
        if (submission) {
          submission.playerId = socket.id;
          room.submissions.delete(oldSocketId);
          room.submissions.set(socket.id, submission);
        }
        
        socket.join(code);
        socket.emit("room-joined", { roomCode: code, playerId: socket.id, isHost: socket.id === room.hostSocketId });
        emitPlayerList(room);
        
        if (room.status === "countdown") {
          socket.emit("countdown-start", { roomCode: code, seconds: 3 });
        } else if (room.status === "question") {
          const question = getCurrentQuestion(room);
          const durationSeconds = 15 + (question.type === "unscramble" ? 5 : 0);
          socket.emit("question-start", {
            roomCode: code,
            quizTitle: room.quizTitle,
            questionNumber: room.currentQuestion + 1,
            totalQuestions: room.quiz.length,
            durationSeconds,
            startedAt: room.questionStartedAt,
            question: publicQuestion(question)
          });
          if (room.submissions.has(socket.id)) {
             const sub = room.submissions.get(socket.id)!;
             socket.emit("answer-submitted", { roomCode: code, correct: sub.correct, points: sub.points });
          }
        } else if (room.status === "result") {
          socket.emit("answer-result", {
            roomCode: code,
            correctAnswer: getCurrentQuestion(room).answer,
            submissions: [...room.submissions.values()],
            leaderboard: leaderboard(room)
          });
        } else if (room.status === "leaderboard") {
          socket.emit("leaderboard-update", {
            roomCode: code,
            leaderboard: leaderboard(room),
            nextQuestionInSeconds: room.currentQuestion >= room.quiz.length - 1 ? 0 : 3
          });
        }
        return;
      }
    }

    if (room.status !== "waiting") {
      emitError(socket.id, "This game has already started.");
      return;
    }

    const nameExists = [...room.players.values()].some(
      (player) => player.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );

    if (nameExists) {
      emitError(socket.id, "That name is already in this room.");
      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      sessionId: sessionId || socket.id,
      name: trimmedName,
      icon,
      score: 0,
      connected: true,
      isReady: false,
      wrongAttempts: 0,
      streak: 0
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

    const allReady = [...room.players.values()].every(p => p.isReady);
    if (!allReady) {
      emitError(socket.id, "All players must be ready before starting.");
      return;
    }

    room.currentQuestion = 0;
    [...room.players.values()].forEach((player) => {
      player.score = 0;
      player.connected = true;
      player.wrongAttempts = 0;
      player.streak = 0;
    });
    startQuestionCountdown(room);
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
    
    if (question.type === "unscramble" && !correct) {
      player.wrongAttempts += 1;
      socket.emit("answer-wrong", {
        roomCode: code,
        message: "Wrong answer, try again! (-20 pts)"
      });
      return;
    }

    if (correct) {
      player.streak += 1;
    } else if (question.type !== "unscramble") {
      player.streak = 0;
    }

    const basePoints = scoreFor(correct, elapsedSeconds);
    const multiplier = player.streak > 1 ? 1 + (player.streak - 1) * 0.1 : 1;
    const penalty = player.wrongAttempts * 20;
    const points = correct ? Math.max(0, Math.floor(basePoints * multiplier) - penalty) : 0;
    
    player.score += points;

    const submission: Submission = {
      playerId: socket.id,
      answer,
      correct,
      points,
      streak: player.streak,
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
      player.streak = 0;
      if (player.id !== room.hostSocketId) {
        player.isReady = false;
      }
    });
    io.to(room.code).emit("room-reset", { roomCode: room.code });
    emitPlayerList(room);
  });

  socket.on("change-quiz", ({ roomCode, quiz }: { roomCode: string; quiz: any }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      emitError(socket.id, "Room not found.");
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket.id, "Only the host can change the quiz.");
      return;
    }

    if (!quiz || !quiz.questions || quiz.questions.length === 0) {
      emitError(socket.id, "Invalid quiz data.");
      return;
    }

    clearRoomTimers(room);
    room.status = "waiting";
    room.currentQuestion = 0;
    room.submissions.clear();
    room.quiz = validateClientQuiz(quiz) ?? sampleQuiz;
    room.quizTitle = quiz?.title || "Untitled Quiz";
    [...room.players.values()].forEach((player) => {
      player.score = 0;
      if (player.id !== room.hostSocketId) {
        player.isReady = false;
      }
    });
    io.to(room.code).emit("room-reset", { roomCode: room.code });
    emitPlayerList(room);
  });

  socket.on("toggle-ready", ({ roomCode }: { roomCode: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player && player.id !== room.hostSocketId) {
      player.isReady = !player.isReady;
      emitPlayerList(room);
    }
  });

  socket.on("kick-player", ({ roomCode, targetId }: { roomCode: string, targetId: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    if (socket.id !== room.hostSocketId) {
      emitError(socket.id, "Only the host can kick players.");
      return;
    }

    if (room.players.has(targetId)) {
      room.players.delete(targetId);
      io.to(targetId).emit("kicked");
      
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.leave(code);
      }
      
      emitPlayerList(room);
    }
  });

  socket.on("leave-room", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        socket.leave(room.code);

        if (socket.id === room.hostSocketId) {
          const nextHost = [...room.players.values()].find((candidate) => candidate.connected);
          if (nextHost) {
            room.hostSocketId = nextHost.id;
          }
        }
        
        emitPlayerList(room);

        // Optional cleanup: if room is empty
        if (room.players.size === 0) {
          clearRoomTimers(room);
          rooms.delete(room.code);
        }
      }
    }
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

  socket.on("chat-message", ({ roomCode, message }: { roomCode: string; message: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !message?.trim()) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    io.to(code).emit("chat-message", {
      playerId: socket.id,
      name: player.name,
      message: message.trim(),
      timestamp: Date.now()
    });
  });

  socket.on("send-emote", ({ roomCode, emote }: { roomCode: string; emote: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !emote) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    io.to(code).emit("receive-emote", {
      playerId: socket.id,
      name: player.name,
      emote
    });
  });

  socket.on("end-game-early", ({ roomCode }: { roomCode: string }) => {
    const code = roomCode?.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    if (socket.id !== room.hostSocketId) {
      emitError(socket.id, "Only the host can end the game.");
      return;
    }

    import("./roomManager.js").then(({ finishGame }) => {
      finishGame(room);
    });
  });
}
