require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");
const streamifier = require("streamifier");

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= CLOUDINARY ================= */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log("☁️ Cloudinary:", {
  cloud: process.env.CLOUDINARY_CLOUD_NAME,
  key: !!process.env.CLOUDINARY_API_KEY,
  secret: !!process.env.CLOUDINARY_API_SECRET,
});

/* ================= MIDDLEWARE ================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    exposedHeaders: ["Content-Disposition"],
  })
);

/* ================= DATABASE ================= */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((e) => console.error("❌ MongoDB error:", e));

/* ================= MULTER ================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* ================= SCHEMA ================= */

const fileSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  passwordHash: String,
  cloudinaryUrl: String,
  cloudinaryPublicId: String,
  originalName: String,
  expiresAt: Date,
});

const File = mongoose.model("File", fileSchema);

/* ================= ENCRYPTION ================= */

const ALGO = "aes-256-cbc";
const IV_LEN = 16;

function encrypt(buffer, password) {
  const salt = crypto.randomBytes(64);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha512");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  return Buffer.concat([salt, iv, cipher.update(buffer), cipher.final()]);
}

function decrypt(buffer, password) {
  const salt = buffer.subarray(0, 64);
  const iv = buffer.subarray(64, 64 + IV_LEN);
  const data = buffer.subarray(64 + IV_LEN);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha512");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ================= CLOUDINARY STREAM ================= */

function streamUpload(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", folder: "quantc_files" },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

/* ================= ROUTES ================= */

const api = express.Router();

/* 🔹 HEALTH CHECK */
api.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* 🔹 UPLOAD */
api.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { password } = req.body;
    const file = req.file;

    if (!file || !password) {
      return res.status(400).json({ success: false, message: "Missing data" });
    }

    const encrypted = encrypt(file.buffer, password);
    const uploadResult = await streamUpload(encrypted);

    const passwordHash = await bcrypt.hash(password, 10);

    let code;
    while (true) {
      code = generateCode();
      if (!(await File.findOne({ code }))) break;
    }

    await File.create({
      code,
      passwordHash,
      cloudinaryUrl: uploadResult.secure_url,
      cloudinaryPublicId: uploadResult.public_id,
      originalName: file.originalname,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    res.json({ success: true, code });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({
      success: false,
      message: e.message || "Upload failed",
    });
  }
});

/* 🔹 RETRIEVE */
api.post("/retrieve", async (req, res) => {
  try {
    const { code, password } = req.body;

    const file = await File.findOne({ code });
    if (!file) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    if (!(await bcrypt.compare(password, file.passwordHash))) {
      return res
        .status(401)
        .json({ success: false, message: "Wrong password" });
    }

    const response = await axios.get(file.cloudinaryUrl, {
      responseType: "arraybuffer",
    });

    const decrypted = decrypt(Buffer.from(response.data), password);

    res.set({
      "Content-Disposition": `attachment; filename="${file.originalName}"`,
      "Content-Type": "application/octet-stream",
    });

    res.send(decrypted);
  } catch (e) {
    console.error("RETRIEVE ERROR:", e);
    res.status(500).json({
      success: false,
      message: e.message || "Retrieve failed",
    });
  }
});

app.use("/api", api);

/* ================= GLOBAL ERROR ================= */

app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

/* ================= START ================= */

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
