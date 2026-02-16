require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");

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
  parts: [String], // Stores the list of Cloudinary URLs
  originalName: String,
  mimeType: String,
  salt: String,
  iv: String, 
  createdAt: { type: Date, expires: '48h', default: Date.now }
});

const File = mongoose.model("File", fileSchema);

/* ================= ROUTES ================= */
const api = express.Router();

// 1. HEALTH CHECK (Wakes up Render immediately)
api.get("/health", (req, res) => res.json({ status: "alive" }));

// 2. SIGNATURE (Allows browser to upload to Cloudinary)
api.post("/sign-upload", (req, res) => {
  const timestamp = Math.round((new Date).getTime() / 1000);
  
  // We sign strictly for the folder to allow any public_id
  const signature = cloudinary.utils.api_sign_request({
    timestamp: timestamp,
    folder: 'quantc_shards'
  }, process.env.CLOUDINARY_API_SECRET);
  
  res.json({ 
    signature, 
    timestamp, 
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME
  });
});

// 3. FINALIZE (Saves the list of chunk URLs)
api.post("/finalize-upload", async (req, res) => {
  try {
    const { password, originalName, mimeType, parts, salt, iv } = req.body;

    if (!parts || parts.length === 0) return res.status(400).json({ success: false, message: "No parts" });

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
      parts,
      originalName,
      mimeType,
      salt,
      iv
    });

    res.json({ success: true, code });
  } catch (e) {
    console.error("Save Error:", e);
    res.status(500).json({ success: false, message: "Save failed" });
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
      parts: file.parts,
      originalName: file.originalName,
      mimeType: file.mimeType,
      salt: file.salt,
      iv: file.iv
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 5. PROXY DOWNLOAD (The Fix for CORS/Network Errors)
api.get("/proxy", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("No URL");

    try {
        const response = await axios({
            method: 'get',
            url: decodeURIComponent(url),
            responseType: 'stream'
        });
        response.data.pipe(res);
    } catch (e) {
        console.error("Proxy Fail:", e.message);
        res.status(500).end();
    }
});

app.use("/api", api);
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));