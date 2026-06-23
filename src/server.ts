import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { apiRoutes } from "./api/routes.js";
import { CLIENT_ORIGINS, PORT } from "./config.js";
import { connectMongo } from "./db.js";
import { initSocketServer } from "./socket/index.js";
import { cleanupExpiredRooms } from "./socket/roomManager.js";

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

// API Routes
app.use(apiRoutes);

const httpServer = createServer(app);

// Initialize Socket.io
initSocketServer(httpServer);

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
