// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cloudinary = require('cloudinary').v2; // Import Cloudinary
const axios = require('axios'); // Needed to download from Cloudinary

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
app.use(cors({
  // Allow your Vercel frontend domain here
  origin: [process.env.CLIENT_ORIGIN, "http://localhost:3000", "http://127.0.0.1:5500"], 
  credentials: true
}));

// ---------- Database ----------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

// ---------- Multer (Temp Storage) ----------
// We use /tmp because it's the only writable path on many cloud providers
const UPLOAD_DIR = '/tmp'; 
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

// LIMIT FILE SIZE to 10MB to prevent server crashes (Free tier RAM is low)
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ---------- Schema ----------
const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  cloudinaryUrl: { type: String, required: true }, // Store URL instead of path
  cloudinaryPublicId: { type: String, required: true }, // For deletion
  originalName: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});
const File = mongoose.model('File', fileSchema);

// ---------- Encryption/Decryption (Same as yours) ----------
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

// Upload Route
api.post('/upload', upload.single('file'), async (req, res) => {
  const { password } = req.body;
  const file = req.file;

  if (!file || !password) return res.status(400).json({ success: false, message: 'Missing file or password' });

  try {
    // 1. Encrypt file in place
    const fileBuffer = fs.readFileSync(file.path);
    const encryptedBuffer = encrypt(fileBuffer, password);
    fs.writeFileSync(file.path, encryptedBuffer);

    // 2. Upload Encrypted file to Cloudinary (as "raw" file type)
    const result = await cloudinary.uploader.upload(file.path, {
      resource_type: 'raw',
      folder: 'quantc_encrypted'
    });

    // 3. Clean up local temp file
    fs.unlinkSync(file.path);

    // 4. Save to DB
    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateCode(); // (Add collision check loop from your original code here)
    
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
    console.error(error);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// Retrieve Route
api.post('/retrieve', async (req, res) => {
  const { code, password } = req.body;
  
  try {
    const fileRecord = await File.findOne({ code });
    if (!fileRecord) return res.status(404).json({ success: false, message: 'File not found' });

    const isMatch = await bcrypt.compare(password, fileRecord.passwordHash);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Incorrect password' });

    // 1. Download Encrypted file from Cloudinary
    const response = await axios.get(fileRecord.cloudinaryUrl, { responseType: 'arraybuffer' });
    const encryptedBuffer = Buffer.from(response.data);

    // 2. Decrypt
    const decryptedBuffer = decrypt(encryptedBuffer, password);
    if (!decryptedBuffer) return res.status(401).json({ success: false, message: 'Decryption failed' });

    // 3. Send to user
    res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.originalName}"`);
    res.send(decryptedBuffer);

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Retrieval failed' });
  }
});

app.use('/api', api);

// Cleanup Job (Modified for Cloudinary)
setInterval(async () => {
    const expired = await File.find({ expiresAt: { $lt: new Date() } });
    for (const file of expired) {
        await cloudinary.uploader.destroy(file.cloudinaryPublicId, { resource_type: 'raw' });
        await File.deleteOne({ _id: file._id });
    }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));