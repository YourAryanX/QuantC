require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');        // FIX: Replaces 'fetch' to prevent crashes
const streamifier = require('streamifier'); // FIX: Uploads from RAM directly

const app = express();
// Render assigns a port automatically, so we must use process.env.PORT
const PORT = process.env.PORT || 3000;

// ---------- Cloudinary Config ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ---------- Middleware ----------
app.use(express.json());

// ✅ FIX: Robust CORS for Render <-> Vercel
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    // Allow everything (Easiest for debugging "Failed to Fetch")
    return callback(null, true);
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'] 
}));

// ---------- Database Connection ----------
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error("❌ MongoDB Error:", err);
  }
};
connectDB();

// ---------- Multer (Memory Storage) ----------
// FIX: Using MemoryStorage is safer and faster on Render than diskStorage
const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
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

// ---------- Helper: Stream Upload ----------
const streamUpload = (buffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'raw', folder: 'quantc_encrypted' },
            (error, result) => {
                if (result) resolve(result);
                else reject(error);
            }
        );
        streamifier.createReadStream(buffer).pipe(stream);
    });
};

// ---------- Routes ----------
const api = express.Router();

// 1. Upload Route
api.post('/upload', upload.single('file'), async (req, res) => {
  const { password } = req.body;
  const file = req.file;

  if (!file || !password) return res.status(400).json({ success: false, message: 'Missing file or password' });

  try {
    console.log("Processing Upload...");
    // Encrypt directly from RAM
    const encryptedBuffer = encrypt(file.buffer, password);

    // Upload to Cloudinary
    const result = await streamUpload(encryptedBuffer);

    // Save DB
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
    console.log(`✅ File uploaded: ${code}`);
    res.json({ success: true, code });

  } catch (error) {
    console.error("❌ UPLOAD ERROR:", error);
    res.status(500).json({ success: false, message: `Server Error: ${error.message}` });
  }
});

// 2. Retrieve Route
api.post('/retrieve', async (req, res) => {
  const { code, password } = req.body;
  
  try {
    const fileRecord = await File.findOne({ code });
    if (!fileRecord) return res.status(404).json({ success: false, message: 'File not found' });

    const isMatch = await bcrypt.compare(password, fileRecord.passwordHash);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Incorrect password' });

    // FIX: Use axios instead of fetch
    console.log(`Downloading from: ${fileRecord.cloudinaryUrl}`);
    const response = await axios.get(fileRecord.cloudinaryUrl, {
        responseType: 'arraybuffer'
    });
    
    const encryptedBuffer = Buffer.from(response.data);
    const decryptedBuffer = decrypt(encryptedBuffer, password);
    
    if (!decryptedBuffer) return res.status(401).json({ success: false, message: 'Decryption failed' });

    console.log("Decryption success, sending file...");
    
    res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileRecord.originalName}"`,
        'Access-Control-Expose-Headers': 'Content-Disposition'
    });
    
    res.send(decryptedBuffer);

  } catch (error) {
    console.error("❌ RETRIEVAL ERROR:", error);
    res.status(500).json({ success: false, message: `Retrieval Error: ${error.message}` });
  }
});

app.use('/api', api);

// Cleanup Cron
setInterval(async () => {
    try {
        const expired = await File.find({ expiresAt: { $lt: new Date() } });
        if(expired.length > 0) console.log(`Cleaning up ${expired.length} expired files...`);
        for (const file of expired) {
            await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: 'raw' });
            await File.deleteOne({ _id: file._id });
        }
    } catch(e) {}
}, 60 * 60 * 1000);

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));