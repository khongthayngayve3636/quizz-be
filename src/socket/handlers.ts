import { Server, Socket } from "socket.io";
import { sampleQuiz } from "../sampleQuiz.js";
import { type Room, type Submission } from "../types.js";
import { generateRoomCode, normalizeAnswer, scoreFor } from "../utils/helpers.js";
import { validateClientQuiz } from "../utils/quizValidation.js";
import {
  clearRoomTimers,
  deleteRoom,
  emitError,
  emitPlayerList,
  getCurrentQuestion,
  maybeFinishWhenAllAnswered,
  startQuestion
} from "./roomManager.js";
import { rooms } from "./store.js";

export function registerSocketHandlers(io: Server, socket: Socket) {
  socket.on("create-room", ({ name, icon, quiz }: { name: string; icon?: string; quiz?: unknown }) => {
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
      quiz: validateClientQuiz(quiz) ?? sampleQuiz,
      players: new Map(),
      submissions: new Map(),
      timers: [],
      createdAt: new Date()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: trimmedName,
      icon,
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

  socket.on("join-room", ({ name, icon, roomCode }: { name: string; icon?: string; roomCode: string }) => {
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
      icon,
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
    room.quiz = quiz; // Assign the new quiz
    [...room.players.values()].forEach((player) => {
      player.score = 0;
    });
    io.to(room.code).emit("room-reset", { roomCode: room.code });
    emitPlayerList(room);
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
}
