import mongoose from "mongoose";
import dotenv from "dotenv";
import { AdminUserModel } from "../db.js";
import { hashPassword } from "../utils/auth.js";

dotenv.config();

async function createAdmin() {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
  if (!uri) {
    console.error("No MongoDB URI found in environment variables.");
    process.exit(1);
  }

  const username = process.argv[2];
  const password = process.argv[3];

  if (!username || !password) {
    console.error("Usage: tsx src/scripts/createAdmin.ts <username> <password>");
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    
    const existing = await AdminUserModel.findOne({ username });
    if (existing) {
      console.log(`Admin user '${username}' already exists.`);
      process.exit(0);
    }

    const passwordHash = await hashPassword(password);
    await AdminUserModel.create({ username, passwordHash });
    
    console.log(`Successfully created admin user: '${username}'`);
    process.exit(0);
  } catch (error) {
    console.error("Error creating admin user:", error);
    process.exit(1);
  }
}

createAdmin();
