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
  parts: [String], // Stores list of Cloudinary URLs
  originalName: String,
  mimeType: String,
  salt: String,
  iv: String, 
  // Manual expiry date for the Cron Job to check
  expiresAt: { type: Date, default: () => Date.now() + 48 * 60 * 60 * 1000 } 
});

const File = mongoose.model("File", fileSchema);

/* ================= ROUTES ================= */
const api = express.Router();

// 1. HEALTH CHECK
api.get("/health", (req, res) => res.json({ status: "alive" }));

// 2. CLEANUP ENDPOINT (The Garbage Collector)
api.get("/cleanup", async (req, res) => {
    // Security check: Only allow requests with the correct API Key
    if (req.query.key !== process.env.CLOUDINARY_API_KEY) { 
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        const now = new Date();
        const expiredFiles = await File.find({ expiresAt: { $lt: now } });

        if (expiredFiles.length === 0) return res.json({ message: "No expired files." });

        console.log(`Cleaning ${expiredFiles.length} files...`);

        for (const file of expiredFiles) {
            // Extract Public IDs from URLs to delete from Cloudinary
            const publicIds = file.parts.map(url => {
                const parts = url.split('/');
                const filename = parts.pop(); 
                return `quantc_shards/${filename}`;
            });

            if (publicIds.length > 0) {
                // Bulk delete the chunks
                await cloudinary.api.delete_resources(publicIds, { resource_type: 'raw' });
            }
            
            // Delete from Database
            await File.deleteOne({ _id: file._id });
        }

        res.json({ success: true, deleted: expiredFiles.length });
    } catch (error) {
        console.error("Cleanup Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. PROXY DOWNLOAD (Bypasses CORS/Network Blocks)
api.get("/proxy", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing URL");

    try {
        const response = await axios({
            method: 'get',
            url: decodeURIComponent(url),
            responseType: 'stream'
        });
        response.data.pipe(res);
    } catch (e) {
        console.error("Proxy Failed:", e.message);
        res.status(500).end();
    }
});

// 4. GENERATE SIGNATURE (For Client-Side Upload)
api.post("/sign-upload", (req, res) => {
  const timestamp = Math.round((new Date).getTime() / 1000);
  const signature = cloudinary.utils.api_sign_request({
    timestamp: timestamp,
    folder: 'quantc_shards'
  }, process.env.CLOUDINARY_API_SECRET);
  
  res.json({ signature, timestamp, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
});

// 5. FINALIZE UPLOAD (Save Metadata)
api.post("/finalize-upload", async (req, res) => {
  try {
    const { password, originalName, mimeType, parts, salt, iv } = req.body;
    
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
    console.error(e);
    res.status(500).json({ success: false });
  }
});

// 6. RETRIEVE METADATA
api.post("/retrieve-meta", async (req, res) => {
  try {
    const { code, password } = req.body;
    const file = await File.findOne({ code });

    if (!file) return res.status(404).json({ success: false, message: "File not found or expired" });

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
    res.status(500).json({ success: false });
  }
});

app.use("/api", api);
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));