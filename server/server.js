// server.js (Final Production Version with CORS Fix)
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Cloudinary Config ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ---------- Middleware (UPDATED) ----------
app.use(express.json());

// ✅ FIX: Allow Frontend to read the filename header
app.use(cors({
  origin: [
      process.env.CLIENT_ORIGIN, 
      "http://localhost:3000", 
      "http://127.0.0.1:5500", 
      "https://quantc.vercel.app", 
      "https://quantc.netlify.app"
  ], 
  credentials: true,
  exposedHeaders: ['Content-Disposition'] // This line is crucial for correct filenames
}));

// ---------- Database ----------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error("MongoDB Error:", err));

// ---------- Multer ----------
const UPLOAD_DIR = '/tmp'; 
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
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
const File = mongoose.model('File', fileSchema);

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

// ---------- Routes ----------
const api = express.Router();

api.post('/upload', upload.single('file'), async (req, res) => {
  const { password } = req.body;
  const file = req.file;

  if (!file || !password) return res.status(400).json({ success: false, message: 'Missing file or password' });

  const originalPath = file.path;
  // FIX: Using .dat because Cloudinary blocks .bin
  const safeBinPath = file.path + '.dat'; 

  try {
    // 1. Encrypt
    const fileBuffer = fs.readFileSync(originalPath);
    const encryptedBuffer = encrypt(fileBuffer, password);
    fs.writeFileSync(originalPath, encryptedBuffer);

    // 2. Rename to .dat (Safe extension)
    fs.renameSync(originalPath, safeBinPath);

    // 3. Upload
    const result = await cloudinary.uploader.upload(safeBinPath, {
      resource_type: 'raw', // Important: Treat as raw data
      folder: 'quantc_encrypted'
    });

    // Cleanup temp files
    if (fs.existsSync(safeBinPath)) fs.unlinkSync(safeBinPath);

    // 4. Save DB Record
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
    res.json({ success: true, code });

  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    
    // Cleanup
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(safeBinPath)) fs.unlinkSync(safeBinPath);

    res.status(500).json({ success: false, message: `Server Error: ${error.message}` });
  }
});

api.post('/retrieve', async (req, res) => {
  const { code, password } = req.body;
  try {
    const fileRecord = await File.findOne({ code });
    if (!fileRecord) return res.status(404).json({ success: false, message: 'File not found' });

    const isMatch = await bcrypt.compare(password, fileRecord.passwordHash);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Incorrect password' });

    const response = await fetch(fileRecord.cloudinaryUrl);
    if (!response.ok) throw new Error("Cloudinary fetch failed");
    
    const arrayBuffer = await response.arrayBuffer();
    const encryptedBuffer = Buffer.from(arrayBuffer);
    const decryptedBuffer = decrypt(encryptedBuffer, password);
    
    if (!decryptedBuffer) return res.status(401).json({ success: false, message: 'Decryption failed' });

    res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.originalName}"`);
    res.send(decryptedBuffer);

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: `Retrieval Error: ${error.message}` });
  }
});

app.use('/api', api);

// Cleanup
setInterval(async () => {
    try {
        const expired = await File.find({ expiresAt: { $lt: new Date() } });
        for (const file of expired) {
            await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: 'raw' });
            await File.deleteOne({ _id: file._id });
        }
    } catch(e) {}
}, 60 * 60 * 1000);

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));