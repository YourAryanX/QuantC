require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Busboy = require("busboy"); 
const crypto = require("crypto");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= CLOUDINARY CONFIG ================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ================= MIDDLEWARE ================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));

/* ================= DATABASE ================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((e) => console.error("❌ MongoDB error:", e));

/* ================= SCHEMA ================= */
const fileSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  passwordHash: String,
  cloudinaryUrl: String,
  cloudinaryPublicId: String,
  originalName: String,
  mimeType: String,
  salt: String, // Store salt separately for streaming decryption
  iv: String,   // Store IV separately
  expiresAt: { type: Date, expires: '48h', default: Date.now }
});

const File = mongoose.model("File", fileSchema);

/* ================= HELPER FUNCTIONS ================= */
async function generateUniqueCode() {
  let code;
  let exists = true;
  while (exists) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    exists = await File.exists({ code });
  }
  return code;
}

/* ================= ROUTES ================= */
const api = express.Router();

/* 🔹 HEALTH CHECK (Wakes up Render) */
api.get("/health", (req, res) => {
  res.json({ status: "alive", timestamp: new Date() });
});

/* 🔹 STREAMING UPLOAD (Fixes Large File Crash) */
api.post("/upload", (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  
  let password = null;

  // 1. Capture Password First
  busboy.on("field", (fieldname, val) => {
    if (fieldname === "password") password = val;
  });

  // 2. Capture File Stream
  busboy.on("file", (fieldname, fileStream, info) => {
    const { filename, mimeType } = info;

    // Fail if password wasn't received first
    if (!password) {
      fileStream.resume(); 
      return res.status(400).json({ success: false, message: "System Error: Password missing from stream." });
    }

    // Setup Encryption
    const ALGO = "aes-256-cbc";
    const salt = crypto.randomBytes(64); 
    const iv = crypto.randomBytes(16);   
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha512");
    const cipher = crypto.createCipheriv(ALGO, key, iv);

    // Setup Cloudinary Stream
    const cloudinaryStream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", folder: "quantc_files" },
      async (error, result) => {
        if (error) {
            console.error("Cloudinary Error:", error);
            return;
        }
        
        // Save Metadata to DB
        try {
            const code = await generateUniqueCode();
            const passwordHash = await bcrypt.hash(password, 10);
            
            await File.create({
                code,
                passwordHash,
                cloudinaryUrl: result.secure_url,
                cloudinaryPublicId: result.public_id,
                originalName: filename,
                mimeType: mimeType,
                salt: salt.toString('hex'), 
                iv: iv.toString('hex')      
            });
            
            res.json({ success: true, code });
        } catch (dbErr) {
            console.error("DB Error:", dbErr);
            if (!res.headersSent) res.status(500).json({ success: false, message: "Database Error" });
        }
      }
    );

    // PIPELINE: Browser -> Encrypt -> Cloudinary
    fileStream.pipe(cipher).pipe(cloudinaryStream);
  });

  req.pipe(busboy);
});

/* 🔹 STREAMING RETRIEVE */
api.post("/retrieve", async (req, res) => {
  try {
    const { code, password } = req.body;
    const file = await File.findOne({ code });

    if (!file) return res.status(404).json({ success: false, message: "File not found" });

    const isValid = await bcrypt.compare(password, file.passwordHash);
    if (!isValid) return res.status(401).json({ success: false, message: "Wrong password" });

    // Stream from Cloudinary
    const response = await axios({
        method: 'get',
        url: file.cloudinaryUrl,
        responseType: 'stream'
    });

    // Decrypt Stream
    const salt = Buffer.from(file.salt, 'hex');
    const iv = Buffer.from(file.iv, 'hex');
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha512");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

    res.setHeader("Content-Disposition", `attachment; filename="${file.originalName}"`);
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");

    // PIPELINE: Cloudinary -> Decrypt -> Browser
    response.data.pipe(decipher).pipe(res);

  } catch (e) {
    console.error("Retrieve Error:", e);
    res.status(500).json({ success: false, message: "Download failed" });
  }
});

app.use("/api", api);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));