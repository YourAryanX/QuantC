require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const axios = require('axios'); // Install this: npm install axios
const streamifier = require('streamifier'); // Install this: npm install streamifier

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Cloudinary Config ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ---------- Middleware ----------
app.use(express.json());

// ✅ FIX: Permissive CORS for Vercel
// Vercel sometimes has issues with strict origin matching during cold starts.
app.use(cors({
  origin: true, // Allow any origin (easiest for debugging "Failed to fetch")
  credentials: true,
  exposedHeaders: ['Content-Disposition'] 
}));

// ---------- Database (Cached for Serverless) ----------
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGO_URI);
    isConnected = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error("❌ MongoDB Error:", err);
  }
};

// ---------- Multer (Memory Storage) ----------
// FIX: Use memoryStorage for Vercel/Serverless. 
// Do not use diskStorage (/tmp) as it causes issues.
const storage = multer.memoryStorage();

const upload = multer({ 
    storage,
    limits: { fileSize: 4.5 * 1024 * 1024 } // Vercel Free Tier Limit is 4.5MB for body size
});

// ---------- Schema ----------
const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  cloudinaryUrl: { type: String, required: true },
  cloudinaryPublicId: { type: String, required: true },
  originalName: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});
// Check if model exists to prevent overwrite error in hot-reload
const File = mongoose.models.File || mongoose.model('File', fileSchema);

// ---------- Encryption Helpers ----------
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function encrypt(buffer, password) {
  const salt = crypto.randomBytes(64);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  return Buffer.concat([salt, iv, cipher.update(buffer), cipher.final()]);
}

function decrypt(buffer, password) {
  const salt = buffer.subarray(0, 64);
  const iv = buffer.subarray(64, 64 + IV_LENGTH);
  const encrypted = buffer.subarray(64 + IV_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---------- Helper: Upload Stream to Cloudinary ----------
const streamUpload = (buffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'raw', folder: 'quantc_encrypted' },
            (error, result) => {
                if (result) {
                    resolve(result);
                } else {
                    reject(error);
                }
            }
        );
        streamifier.createReadStream(buffer).pipe(stream);
    });
};

// ---------- Routes ----------
const api = express.Router();

// 1. Upload Route
api.post('/upload', upload.single('file'), async (req, res) => {
  await connectDB(); // Ensure DB is connected
  
  const { password } = req.body;
  const file = req.file;

  if (!file || !password) return res.status(400).json({ success: false, message: 'Missing file or password' });

  try {
    console.log("Starting encryption...");
    // 1. Encrypt Buffer directly from RAM
    const encryptedBuffer = encrypt(file.buffer, password);

    console.log("Uploading to Cloudinary...");
    // 2. Upload Encrypted Buffer via Stream
    const result = await streamUpload(encryptedBuffer);

    // 3. Save DB Record
    const passwordHash = await bcrypt.hash(password, 10);
    let code;
    let isUnique = false;
    while(!isUnique) {
        code = generateCode();
        const existing = await File.findOne({ code });
        if (!existing) isUnique = true;
    }
    
    const newFile = new File({
      code,
      passwordHash,
      cloudinaryUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      originalName: file.originalname,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000)
    });
    
    await newFile.save();
    console.