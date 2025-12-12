// server/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || '*' // tighten this in production
}));

// ---------- MongoDB ----------
const mongoUri = process.env.MONGO_URI || '';

if (!mongoUri) {
  console.error('MONGO_URI is not set. Set it in server/.env before starting.');
} else {
  // Connect without legacy options (modern Mongoose/driver don't need them)
  mongoose.connect(mongoUri)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));
}

// ---------- Upload directory ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- Multer storage ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// ---------- Mongoose Schema ----------
const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  filePath: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});
const File = mongoose.model('File', fileSchema);

// ---------- Encryption helpers ----------
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function encrypt(buffer, password) {
  const salt = crypto.randomBytes(64);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([salt, iv, encrypted]);
}

function decrypt(buffer, password) {
  const salt = buffer.subarray(0, 64);
  const iv = buffer.subarray(64, 64 + IV_LENGTH);
  const encrypted = buffer.subarray(64 + IV_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (err) {
    return null;
  }
}

// ---------- API Router (prefix /api) ----------
const api = express.Router();

// Ping route
api.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// Upload route: POST /api/upload (form-data key: "file", field "password")
api.post('/upload', upload.single('file'), async (req, res) => {
  const { password } = req.body;
  const file = req.file;

  if (!file || !password) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ success: false, message: 'File and password are required.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const fileBuffer = fs.readFileSync(file.path);
    const encryptedBuffer = encrypt(fileBuffer, password);
    fs.writeFileSync(file.path, encryptedBuffer);

    // Generate unique code
    let code;
    let unique = false;
    while (!unique) {
      code = generateCode();
      const exists = await File.findOne({ code });
      if (!exists) unique = true;
    }

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
    const newFile = new File({
      code,
      passwordHash,
      filePath: file.path,
      expiresAt
    });
    await newFile.save();

    res.json({ success: true, code, expiresAt });
  } catch (error) {
    console.error('Upload Error:', error);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ success: false, message: 'Server error during file upload.' });
  }
});

// Retrieve route: POST /api/retrieve { code, password }
api.post('/retrieve', async (req, res) => {
  const { code, password } = req.body;
  if (!code || !password) {
    return res.status(400).json({ success: false, message: 'Code and password are required.' });
  }

  try {
    const fileRecord = await File.findOne({ code });
    if (!fileRecord) {
      return res.status(404).json({ success: false, message: 'File not found or has expired.' });
    }

    const isMatch = await bcrypt.compare(password, fileRecord.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    if (!fs.existsSync(fileRecord.filePath)) {
      return res.status(500).json({ success: false, message: 'File missing on server.' });
    }

    const encryptedBuffer = fs.readFileSync(fileRecord.filePath);
    const decryptedBuffer = decrypt(encryptedBuffer, password);
    if (!decryptedBuffer) {
      return res.status(401).json({ success: false, message: 'Decryption failed. Check password.' });
    }

    const originalFileName = path.basename(fileRecord.filePath).split('-').slice(1).join('-') || 'file';
    res.setHeader('Content-Disposition', `attachment; filename="${originalFileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(decryptedBuffer);
  } catch (error) {
    console.error('Retrieval Error:', error);
    res.status(500).json({ success: false, message: 'Server error during file retrieval.' });
  }
});

app.use('/api', api);

// ---------- Cleanup job ----------
const deleteExpiredFiles = async () => {
  try {
    const expiredFiles = await File.find({ expiresAt: { $lt: new Date() } });
    if (!expiredFiles.length) return;
    console.log(`Found ${expiredFiles.length} expired file(s)`);

    for (const file of expiredFiles) {
      try {
        if (fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
        await File.deleteOne({ _id: file._id });
        console.log(`Deleted file with code ${file.code}`);
      } catch (err) {
        console.error(`Error deleting file ${file.code}:`, err);
      }
    }
  } catch (err) {
    console.error('Error in deleteExpiredFiles:', err);
  }
};

setInterval(deleteExpiredFiles, 60 * 60 * 1000); // hourly
deleteExpiredFiles(); // on startup

// ---------- Serve React in production ----------
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '..', 'client', 'build');
  if (fs.existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
  } else {
    console.warn('Production build not found at', clientBuildPath);
  }
}

// ---------- Start server ----------
// at the bottom of server/server.js – replace existing app.listen(...) with this
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Quantc Server running at http://${HOST}:${PORT} (also reachable at http://127.0.0.1:${PORT})`);
});

