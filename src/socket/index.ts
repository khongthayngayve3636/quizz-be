import { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { CLIENT_ORIGINS } from "../config.js";
import { registerSocketHandlers } from "./handlers.js";
import { initRoomManager } from "./roomManager.js";

export function initSocketServer(httpServer: HttpServer) {
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

  initRoomManager(io);

  io.on("connection", (socket) => {
    registerSocketHandlers(io, socket);
  });

  return io;
}
