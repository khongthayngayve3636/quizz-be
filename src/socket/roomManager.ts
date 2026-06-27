import { Server } from "socket.io";
import { LEADERBOARD_MS, QUESTION_SECONDS, RESULT_MS, ROOM_TTL_MS } from "../config.js";
import { type Room } from "../types.js";
import { publicQuestion } from "../utils/helpers.js";
import { rooms } from "./store.js";
import { StudentModel } from "../db.js";
import { logSystemEvent } from "../services/systemLogger.js";

// We need an instance of io to emit events from here, or pass it into functions.
// To avoid circular dependency, we can inject `io` or set it once.
let io: Server;

export function initRoomManager(socketIo: Server) {
  io = socketIo;
}

export function leaderboard(room: Room) {
  return [...room.players.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      icon: player.icon,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostSocketId,
      isReady: player.isReady,
      streak: player.streak
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function lobbyPlayers(room: Room) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    icon: player.icon,
    score: player.score,
    connected: player.connected,
    isHost: player.id === room.hostSocketId,
    isReady: player.isReady
  }));
}

export function emitPlayerList(room: Room) {
  io.to(room.code).emit("player-list", {
    roomCode: room.code,
    players: lobbyPlayers(room),
    hostSocketId: room.hostSocketId
  });
}

export function startQuestionCountdown(room: Room) {
  clearRoomTimers(room);
  room.status = "countdown";
  io.to(room.code).emit("countdown-start", {
    roomCode: room.code,
    seconds: 3
  });

  room.timers.push(
    setTimeout(() => {
      startQuestion(room);
    }, 3000)
  );
}

export function emitError(socketId: string, message: string) {
  io.to(socketId).emit("app-error", { message });
}

export function clearRoomTimers(room: Room) {
  room.timers.forEach((timer) => clearTimeout(timer));
  room.timers = [];
}

export function deleteRoom(room: Room) {
  clearRoomTimers(room);
  rooms.delete(room.code);
}

export function cleanupExpiredRooms() {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (now - room.createdAt.getTime() > ROOM_TTL_MS) {
      deleteRoom(room);
    }
  }
}

export function getCurrentQuestion(room: Room) {
  return room.quiz[room.currentQuestion];
}

export function startQuestion(room: Room) {
  clearRoomTimers(room);
  room.status = "question";
  room.submissions.clear();
  room.questionStartedAt = Date.now();
  
  [...room.players.values()].forEach((player) => {
    player.wrongAttempts = 0;
  });

  const question = getCurrentQuestion(room);
  const durationSeconds = QUESTION_SECONDS + (question.type === "unscramble" ? 5 : 0);

  io.to(room.code).emit("question-start", {
    roomCode: room.code,
    quizTitle: room.quizTitle,
    questionNumber: room.currentQuestion + 1,
    totalQuestions: room.quiz.length,
    durationSeconds,
    startedAt: room.questionStartedAt,
    question: publicQuestion(question)
  });

  // Removed verbose QUESTION_STARTED log

  room.timers.push(
    setTimeout(() => {
      finishQuestion(room);
    }, durationSeconds * 1000)
  );
}

export function finishQuestion(room: Room) {
  if (room.status !== "question") {
    return;
  }

  clearRoomTimers(room);
  room.status = "result";
  const question = getCurrentQuestion(room);

  for (const player of room.players.values()) {
    if (!room.submissions.has(player.id)) {
      player.streak = 0;
    }
  }

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

export function showLeaderboard(room: Room) {
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
      startQuestionCountdown(room);
    }, LEADERBOARD_MS)
  );
}

export async function finishGame(room: Room) {
  if (room.status === "finished") {
    return;
  }

  clearRoomTimers(room);
  room.status = "finished";
  io.to(room.code).emit("game-over", {
    roomCode: room.code,
    leaderboard: leaderboard(room)
  });

  void logSystemEvent({
    level: "info",
    category: "game",
    action: "ROOM_GAME_OVER",
    message: `Game over in room ${room.code} (Topic: ${room.quizTitle || "Unknown"}). Played by ${room.players.size} players. Hosted by ${room.hostSocketId ? ([...room.players.values()].find(p => p.id === room.hostSocketId)?.name || "Unknown") : "Unknown"}`,
    target: { type: "room", roomCode: room.code }
  });

  try {
    const bulkOps = [...room.players.values()].map(player => ({
      updateOne: {
        filter: { name: player.name },
        update: { $inc: { score: player.score } },
        upsert: true
      }
    }));
    
    if (bulkOps.length > 0) {
      await StudentModel.bulkWrite(bulkOps);
      // removed GLOBAL_SCORE_BULK_UPDATE_SUCCESS log
    }
  } catch (error: any) {
    console.error("Failed to update global leaderboard:", error);
    void logSystemEvent({
      level: "error",
      category: "leaderboard",
      action: "GLOBAL_SCORE_BULK_UPDATE_FAILED",
      message: `Failed to update global scores for room ${room.code}`,
      target: { type: "room", roomCode: room.code },
      metadata: { error: error.message }
    });
  }
}

export function maybeFinishWhenAllAnswered(room: Room) {
  const connectedPlayers = [...room.players.values()].filter((player) => player.connected);
  if (connectedPlayers.length > 0 && connectedPlayers.every((player) => room.submissions.has(player.id))) {
    finishQuestion(room);
  }
}
