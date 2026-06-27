import { Router } from "express";
import { AdminUserModel, SystemLogModel, QuizModel, StudentModel } from "../db.js";
import { comparePassword, generateToken, verifyToken } from "../utils/auth.js";
import { logger } from "../utils/logger.js";
import { rooms } from "../socket/store.js";
import { logSystemEvent } from "../services/systemLogger.js";
import { leaderboard } from "../socket/roomManager.js";

const router = Router();

// Middleware to protect admin routes
const adminAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  const decoded = verifyToken(token);

  if (!decoded || decoded.role !== "admin") {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  req.adminId = decoded.id;
  next();
};

router.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password required" });
    }

    const admin = await AdminUserModel.findOne({ username });
    if (!admin) {
      void logSystemEvent({ level: "warning", category: "auth", action: "ADMIN_LOGIN_FAILED", message: `Failed login attempt for username: ${username} from IP: ${req.ip}`, actor: { type: "system", name: username, ip: req.ip } });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await comparePassword(password, admin.passwordHash);
    if (!isMatch) {
      void logSystemEvent({ level: "warning", category: "auth", action: "ADMIN_LOGIN_FAILED", message: `Failed login attempt for username: ${username} from IP: ${req.ip}`, actor: { type: "system", name: username, ip: req.ip } });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(admin.id);
    void logSystemEvent({ level: "info", category: "auth", action: "ADMIN_LOGIN_SUCCESS", message: `Admin logged in: ${username} from IP: ${req.ip}`, actor: { type: "admin", name: username, id: admin.id, ip: req.ip } });
    res.json({ token, username: admin.username });
  } catch (error) {
    logger.error("Admin login error", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/api/admin/me", adminAuth, async (req: any, res) => {
    try {
        const admin = await AdminUserModel.findById(req.adminId).select("-passwordHash");
        if (!admin) return res.status(404).json({ message: "Admin not found" });
        res.json({ admin });
    } catch (error) {
        res.status(500).json({ message: "Internal server error" });
    }
});

router.get("/api/admin/overview", adminAuth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalRoomsToday = await SystemLogModel.countDocuments({ action: "ROOM_CREATED", createdAt: { $gte: today } });
    const totalQuizzesGeneratedToday = await SystemLogModel.countDocuments({ action: "QUIZ_GENERATE_SUCCESS", createdAt: { $gte: today } });
    const totalGamesCompletedToday = await SystemLogModel.countDocuments({ action: "ROOM_GAME_OVER", createdAt: { $gte: today } });
    const totalErrorsToday = await SystemLogModel.countDocuments({ level: { $in: ["error", "critical"] }, createdAt: { $gte: today } });
    
    // Approximating players today by unique joins
    const playersLogs = await SystemLogModel.find({ action: "ROOM_JOINED", createdAt: { $gte: today } }).select("actor.name");
    const uniquePlayers = new Set(playersLogs.map(l => l.actor?.name).filter(Boolean));
    const totalPlayersToday = uniquePlayers.size;

    const activeRooms = rooms.size;

    const latestActivities = await SystemLogModel.find({ 
        action: { $in: ["ROOM_CREATED", "ROOM_GAME_OVER", "QUIZ_GENERATE_SUCCESS"] } 
    }).sort({ createdAt: -1 }).limit(10).lean();

    res.json({
      totalRoomsToday,
      activeRooms,
      totalPlayersToday,
      totalQuizzesGeneratedToday,
      totalGamesCompletedToday,
      totalErrorsToday,
      totalLeaderboardUpdatesToday: totalGamesCompletedToday, // Approximation
      latestActivities
    });
  } catch (error) {
    logger.error("Failed to fetch overview", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/api/admin/logs", adminAuth, async (req, res) => {
  try {
    const { page = "1", limit = "50", level, category, action, roomCode, playerName, search, from, to } = req.query;
    
    const query: any = {};
    if (level) query.level = level;
    if (category) query.category = category;
    if (action) query.action = action;
    
    if (roomCode) {
        query.$or = [
            { "target.roomCode": { $regex: roomCode, $options: "i" } },
            { "metadata.roomCode": { $regex: roomCode, $options: "i" } }
        ];
    }
    
    if (playerName) {
        query["actor.name"] = { $regex: playerName, $options: "i" };
    }

    if (search) {
        query.message = { $regex: search, $options: "i" };
    }

    if (from || to) {
        query.createdAt = {};
        if (from) query.createdAt.$gte = new Date(from as string);
        if (to) query.createdAt.$lte = new Date(to as string);
    }

    const pageNum = parseInt(page as string, 10) || 1;
    const limitNum = Math.min(parseInt(limit as string, 10) || 50, 200);
    const skip = (pageNum - 1) * limitNum;

    const logs = await SystemLogModel.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();
      
    const total = await SystemLogModel.countDocuments(query);

    res.json({ logs, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
  } catch (error) {
    logger.error("Failed to fetch logs", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/api/admin/rooms", adminAuth, (req, res) => {
    try {
        const roomsList = Array.from(rooms.values()).map(r => ({
            roomCode: r.code,
            status: r.status,
            hostName: r.players.get(r.hostSocketId)?.name || "Unknown",
            playerCount: r.players.size,
            quizTitle: r.quizTitle,
            currentQuestionIndex: r.currentQuestion,
            createdAt: r.createdAt,
            startedAt: r.questionStartedAt ? new Date(r.questionStartedAt) : null,
        }));
        // sort by newest
        roomsList.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        res.json({ rooms: roomsList });
    } catch(error) {
        res.status(500).json({ message: "Error fetching rooms" });
    }
});

router.get("/api/admin/rooms/:roomCode", adminAuth, (req, res) => {
    try {
        const code = req.params.roomCode.toUpperCase();
        const room = rooms.get(code);
        
        if (!room) {
            return res.status(404).json({ message: "Room not found or expired" });
        }
        
        const host = room.players.get(room.hostSocketId);
        
        const roomDetail = {
            roomCode: room.code,
            status: room.status,
            host: host ? { id: host.id, name: host.name } : null,
            players: Array.from(room.players.values()).map(p => ({
                id: p.id, name: p.name, score: p.score, connected: p.connected, isReady: p.isReady
            })),
            quiz: {
                title: room.quizTitle,
                totalQuestions: room.quiz.length
            },
            currentQuestionIndex: room.currentQuestion,
            scores: leaderboard(room),
            createdAt: room.createdAt,
            startedAt: room.questionStartedAt ? new Date(room.questionStartedAt) : null,
        };
        
        res.json({ room: roomDetail });
    } catch(error) {
        res.status(500).json({ message: "Error fetching room" });
    }
});

router.get("/api/admin/quizzes", adminAuth, async (req, res) => {
    try {
        const quizzes = await QuizModel.find().sort({ createdAt: -1 }).limit(100).lean();
        res.json({ quizzes });
    } catch (error) {
        res.status(500).json({ message: "Error fetching quizzes" });
    }
});

router.get("/api/admin/players", adminAuth, async (req, res) => {
    try {
        const players = await StudentModel.find().sort({ score: -1 }).limit(100).lean();
        res.json({ players });
    } catch (error) {
        res.status(500).json({ message: "Error fetching players" });
    }
});

router.get("/api/admin/errors", adminAuth, async (req, res) => {
    try {
        const logs = await SystemLogModel.find({ level: { $in: ["error", "critical"] } })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ message: "Error fetching error logs" });
    }
});

router.get("/api/admin/activity", adminAuth, async (req, res) => {
    try {
        const logs = await SystemLogModel.find({ 
            action: { $in: ["ROOM_CREATED", "ROOM_JOINED", "ROOM_START_GAME", "ROOM_GAME_OVER", "QUIZ_GENERATE_SUCCESS", "QUIZ_GENERATE_FAILED"] }
        }).sort({ createdAt: -1 }).limit(50).lean();
        
        const timeline = logs.map(l => ({
            time: l.createdAt,
            category: l.category,
            action: l.action,
            title: `${l.action.replace(/_/g, ' ')}`,
            description: l.message,
            level: l.level,
            roomCode: l.target?.roomCode || null
        }));
        
        res.json({ activities: timeline });
    } catch(error) {
        res.status(500).json({ message: "Error fetching activities" });
    }
});

export { router as adminRoutes };
