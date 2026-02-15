require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= CONFIG ================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(express.json());
app.use(cors({ origin: "*" }));

/* ================= DATABASE ================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((e) => console.error("❌ MongoDB error:", e));

const fileSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  passwordHash: String,
  parts: [String], // ARRAY of URLs (The Shards)
  cloudinaryPublicId: String, // Base ID
  originalName: String,
  mimeType: String,
  salt: String,
  iv: String,
  createdAt: { type: Date, expires: '48h', default: Date.now }
});

const File = mongoose.model("File", fileSchema);

/* ================= ROUTES ================= */
const api = express.Router();

// 1. HEALTH CHECK
api.get("/health", (req, res) => res.json({ status: "alive" }));

// 2. SIGNATURE ENDPOINT
api.post("/sign-upload", (req, res) => {
  const timestamp = Math.round((new Date).getTime() / 1000);
  const { folder_id } = req.body; 

  const paramsToSign = {
    timestamp: timestamp,
    folder: 'quantc_files', // All shards go here
  };
  
  // We don't sign public_id anymore because we generate random IDs for each shard
  // This allows parallel uploads of shards without conflict

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign, 
    process.env.CLOUDINARY_API_SECRET
  );
  
  res.json({ 
    signature, 
    timestamp,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME
  });
});

// 3. FINALIZE UPLOAD (Saves the list of shard URLs)
api.post("/finalize-upload", async (req, res) => {
  try {
    const { password, originalName, mimeType, parts, publicId, salt, iv } = req.body;

    let code;
    let exists = true;
    while (exists) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      exists = await File.exists({ code });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await File.create({
      code,
      passwordHash,
      parts, // Save all the URLs
      cloudinaryPublicId: publicId,
      originalName,
      mimeType,
      salt,
      iv
    });

    res.json({ success: true, code });
  } catch (e) {
    console.error("Save Error:", e);
    res.status(500).json({ success: false, message: "Server Save Error" });
  }
});

// 4. RETRIEVE METADATA
api.post("/retrieve-meta", async (req, res) => {
  try {
    const { code, password } = req.body;
    const file = await File.findOne({ code });

    if (!file) return res.status(404).json({ success: false, message: "File not found" });

    const isValid = await bcrypt.compare(password, file.passwordHash);
    if (!isValid) return res.status(401).json({ success: false, message: "Wrong password" });

    res.json({
      success: true,
      parts: file.parts, // Send back the list of URLs
      originalName: file.originalName,
      mimeType: file.mimeType,
      salt: file.salt,
      iv: file.iv
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.use("/api", api);
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));