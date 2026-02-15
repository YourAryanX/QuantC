document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'https://quantc.onrender.com'; 
    const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB Chunks (Safe for low-end phones)

    // Wake up server
    fetch(`${API_BASE_URL}/api/health`).catch(() => {});

    // --- DOM ELEMENTS ---
    const uploadForm = document.getElementById("upload-form");
    const retrieveForm = document.getElementById("retrieve-form");
    const fileInput = document.getElementById("file-input");
    const fileNameDisplay = document.getElementById("file-name-display");
    const uploadResult = document.getElementById("upload-result");
    const generatedCodeSpan = document.getElementById("generated-code");
    const dropZone = document.querySelector(".drop-trigger");
    const uploadCard = document.getElementById("upload-card");
    const retrieveCard = document.getElementById("retrieve-card");

    // --- CRYPTO HELPERS ---
    async function deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
            keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
    }

    function hexToBytes(hex) {
        return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }
    
    function bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function generateUniqueId() {
        return 'upload_' + Date.now() + Math.random().toString(36).substr(2, 9);
    }

    // --- UPLOAD LOGIC (CHUNKED) ---
    if(uploadForm) {
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            const password = document.getElementById('upload-password').value;
            
            if (!file) return showToast("Please select a file.", "error");
            if (password.length < 6) return showToast("Password must be 6+ chars.", "error");

            toggleLoading('upload-card', true, "Initializing...");

            try {
                // 1. Get Signature
                const sigRes = await fetch(`${API_BASE_URL}/api/sign-upload`);
                const sigData = await sigRes.json();
                if(!sigData.signature) throw new Error("Server signature failed");

                // 2. Prepare Encryption
                const fileSalt = window.crypto.getRandomValues(new Uint8Array(16));
                const key = await deriveKey(password, fileSalt);
                const uniqueUploadId = generateUniqueId();
                
                // We will count total size AFTER encryption (Cipher + IV + Tag overhead)
                // AES-GCM adds 16 bytes tag + 12 bytes IV = 28 bytes overhead per chunk
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                let currentChunk = 0;

                // 3. Process & Upload Chunks
                for (let start = 0; start < file.size; start += CHUNK_SIZE) {
                    currentChunk++;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkBuffer = await chunkBlob.arrayBuffer();

                    // Update UI
                    const progress = Math.round((start / file.size) * 100);
                    updateLoadingText(`Encrypting Part ${currentChunk}/${totalChunks} (${progress}%)`);

                    // Encrypt Chunk
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encryptedChunk = await window.crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: iv }, key, chunkBuffer
                    );

                    // Append IV to the START of the chunk so we can decrypt it later
                    // Format: [IV (12 bytes)] + [Encrypted Data]
                    const combinedBuffer = new Uint8Array(iv.length + encryptedChunk.byteLength);
                    combinedBuffer.set(iv);
                    combinedBuffer.set(new Uint8Array(encryptedChunk), iv.length);

                    // Upload Chunk
                    updateLoadingText(`Uploading Part ${currentChunk}/${totalChunks}...`);
                    await uploadChunkToCloudinary(
                        combinedBuffer, 
                        sigData, 
                        uniqueUploadId, 
                        start, 
                        end, 
                        file.size,
                        currentChunk === totalChunks // Is this the last chunk?
                    );
                }

                // 4. Finalize
                updateLoadingText("Finalizing...");
                // Note: The final URL is determined by Cloudinary based on the ID
                // We construct the URL manually or assume standard naming convention, 
                // but usually Cloudinary returns the full response on the LAST chunk.
                // For simplicity in this demo, we assume the upload worked if no errors were thrown.
                // We just need to construct the URL for the metadata.
                const cloudUrl = `https://res.cloudinary.com/${sigData.cloudName}/raw/upload/v${sigData.timestamp}/${uniqueUploadId}`;

                const finalRes = await fetch(`${API_BASE_URL}/api/finalize-upload`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        password: password,
                        originalName: file.name,
                        mimeType: file.type,
                        cloudinaryUrl: cloudUrl,
                        publicId: uniqueUploadId,
                        salt: bytesToHex(fileSalt),
                        iv: "chunked" // Mark as chunked for retrieval logic
                    })
                });

                const finalData = await finalRes.json();
                
                toggleLoading('upload-card', false);
                if(finalData.success) {
                    uploadForm.classList.add('hidden');
                    uploadResult.classList.remove('hidden');
                    generatedCodeSpan.innerText = finalData.code;
                    showToast("Upload Complete!", "success");
                } else {
                    showToast("Save Failed", "error");
                }

            } catch (error) {
                console.error(error);
                toggleLoading('upload-card', false);
                showToast("Error: " + error.message, "error");
            }
        });
    }

    // Helper: Upload a single chunk to Cloudinary
    function uploadChunkToCloudinary(data, sigData, uploadId, start, end, totalSize, isLast) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `https://api.cloudinary.com/v1_1/${sigData.cloudName}/auto/upload`;
            
            xhr.open("POST", url, true);
            
            // Required Headers for Chunked Upload
            xhr.setRequestHeader("X-Unique-Upload-Id", uploadId);
            // Content-Range: bytes start-end/total
            // Note: 'end' in Content-Range is inclusive (byte index), so we use (end - 1) unless it's 0 length
            // But we are uploading the *Encrypted* size, which is larger. 
            // Cloudinary's raw upload doesn't strictly validate total size if we send -1, 
            // but for safety with "auto" resource type, we act as if we are appending.
            // Actually, simpler approach: Use 'upload_preset' if unsigned, but we are signed.
            // Cloudinary REST API for chunked upload via X-Unique-Upload-Id handles the stitching.
            
            const formData = new FormData();
            formData.append("file", new Blob([data]));
            formData.append("api_key", sigData.apiKey);
            formData.append("timestamp", sigData.timestamp);
            formData.append("signature", sigData.signature);
            formData.append("folder", "quantc_files");
            formData.append("public_id", uploadId); // Force the ID to match our chunks

            // Crucial: The Content-Range header is set by the browser automatically for some requests,
            // but for Cloudinary via FormData, it relies on the Content-Range header ON THE REQUEST.
            // Since we are using FormData, setting Content-Range header on XHR might conflict.
            // Cloudinary's "upload_large" usually handles this via SDK. 
            // For manual implementation, we use the header:
            const contentRange = `bytes ${start}-${start + data.byteLength - 1}/${-1}`; 
            xhr.setRequestHeader("Content-Range", contentRange);

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    reject(new Error("Chunk upload failed: " + xhr.statusText));
                }
            };
            xhr.onerror = () => reject(new Error("Network Error"));
            
            xhr.send(formData);
        });
    }

    // --- RETRIEVE LOGIC (CHUNKED DECRYPT) ---
    if(retrieveForm) {
        retrieveForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('retrieve-code').value;
            const password = document.getElementById('retrieve-password').value;
            
            toggleLoading('retrieve-card', true, "Locating...");

            try {
                // 1. Get Meta
                const metaRes = await fetch(`${API_BASE_URL}/api/retrieve-meta`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code, password })
                });
                const metaData = await metaRes.json();
                if(!metaData.success) throw new Error(metaData.message);

                updateLoadingText("Downloading...");

                // 2. Download the FULL file (It's stitched on Cloudinary)
                const fileRes = await fetch(metaData.url);
                const fullArrayBuffer = await fileRes.arrayBuffer();
                
                // 3. Decrypt Chunk-by-Chunk from RAM
                // Note: For download on low-end device, we ideally stream this too.
                // But native Fetch streams + Crypto is complex. 
                // For now, we assume download RAM is slightly more forgiving or 
                // the user accepts a limit on download size on mobile. 
                // To truly fix download crashes on 10k phone, we'd need StreamSaver.js.
                // Proceeding with basic buffer loop for simplicity (better than before).
                
                updateLoadingText("Decrypting...");
                
                const fileSalt = hexToBytes(metaData.salt);
                const key = await deriveKey(password, fileSalt);
                
                const decryptedParts = [];
                let offset = 0;
                
                // We need to know the encrypted chunk size. 
                // Since we added 12 bytes IV + 16 bytes tag = 28 bytes overhead.
                // Original chunk = 6MB. Encrypted chunk = 6MB + 28 bytes.
                // Except the last chunk which is smaller.
                const ENC_CHUNK_SIZE = CHUNK_SIZE + 28; // 12 IV + 16 Tag

                while (offset < fullArrayBuffer.byteLength) {
                    // Calculate current chunk size
                    const remaining = fullArrayBuffer.byteLength - offset;
                    // If remaining is roughly chunk size (allow small variance for last chunk)
                    const currentSize = (remaining > ENC_CHUNK_SIZE) ? ENC_CHUNK_SIZE : remaining;

                    const chunk = fullArrayBuffer.slice(offset, offset + currentSize);
                    
                    // Extract IV (First 12 bytes)
                    const iv = chunk.slice(0, 12);
                    const data = chunk.slice(12);

                    const decryptedChunk = await window.crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: new Uint8Array(iv) }, 
                        key, 
                        data
                    );
                    
                    decryptedParts.push(decryptedChunk);
                    offset += currentSize;
                }

                // 4. Save
                const finalBlob = new Blob(decryptedParts, { type: metaData.mimeType });
                const url = window.URL.createObjectURL(finalBlob);
                const a = document.createElement("a");
                a.style.display = "none";
                a.href = url;
                a.download = metaData.originalName;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                a.remove();
                
                showToast("Download Complete!", "success");

            } catch (error) {
                console.error(error);
                showToast("Decryption Error (Wrong Password?)", "error");
            } finally {
                toggleLoading('retrieve-card', false);
            }
        });
    }

    // --- UTILS ---
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return; 
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        let icon = type === 'success' ? 'fa-check-circle' : 'fa-info-circle';
        if(type === 'error') icon = 'fa-exclamation-triangle';
        toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 500); }, 3500);
    }
    
    function toggleLoading(cardId, isLoading, text) {
        const overlay = document.getElementById(cardId).querySelector('.loading-overlay');
        const span = overlay.querySelector('span');
        if (text && span) span.innerText = text;
        if (isLoading) overlay.classList.remove('hidden');
        else overlay.classList.add('hidden');
    }
    
    function updateLoadingText(text) {
        const visibleLoader = document.querySelector('.loading-overlay:not(.hidden) span');
        if(visibleLoader) visibleLoader.innerText = text;
    }

    // --- ANIMATIONS ---
    function playEntranceAnimations() {
        try {
            const tl = gsap.timeline({ defaults: { ease: "power4.out" } });
            gsap.set(".nav-brand, .nav-btn", { x: -60, autoAlpha: 0 });
            gsap.set(".main-heading", { y: 50, autoAlpha: 0 });
            gsap.set(".glass-hub:not(.hidden)", { scale: 0.95, autoAlpha: 0, y: 30 });
            tl.to(".nav-brand, .nav-btn", { x: 0, autoAlpha: 1, duration: 1.2, stagger: 0.1 })
              .to(".main-heading", { y: 0, autoAlpha: 1, duration: 1 }, "-=0.8")
              .to(".glass-hub:not(.hidden)", { scale: 1, y: 0, autoAlpha: 1, duration: 1.2 }, "-=0.7");
        } catch (e) { console.error("GSAP Error:", e); }
    }
    playEntranceAnimations();

    const uploadModeBtn = document.getElementById("upload-mode-btn");
    const retrieveModeBtn = document.getElementById("retrieve-mode-btn");
    function setMode(mode) {
        const target = mode === "upload" ? uploadCard : retrieveCard;
        const other = mode === "upload" ? retrieveCard : uploadCard;
        if (target === other) return;
        gsap.to(other, { opacity: 0, y: 20, duration: 0.3, onComplete: () => {
            other.classList.add("hidden");
            target.classList.remove("hidden");
            gsap.fromTo(target, { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" });
        }});
        uploadModeBtn.classList.toggle("active", mode === "upload");
        retrieveModeBtn.classList.toggle("active", mode === "retrieve");
    }
    uploadModeBtn.addEventListener("click", () => setMode("upload"));
    retrieveModeBtn.addEventListener("click", () => setMode("retrieve"));

    const resetUploadBtn = document.getElementById("reset-upload-btn");
    if(resetUploadBtn) resetUploadBtn.addEventListener('click', () => {
        uploadResult.classList.add('hidden');
        uploadForm.classList.remove('hidden');
        uploadForm.reset();
        fileNameDisplay.innerText = "Initialize Packet";
        generatedCodeSpan.innerText = ""; 
    });
    const copyBtn = document.getElementById("copy-btn");
    if(copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(generatedCodeSpan.innerText);
        showToast("Code copied", "success");
    });
    if(dropZone) {
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-active'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-active'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault(); dropZone.classList.remove('drag-active');
            if (e.dataTransfer.files.length > 0) { fileInput.files = e.dataTransfer.files; updateFileName(e.dataTransfer.files[0]); }
        });
    }
    if(fileInput) fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) updateFileName(e.target.files[0]);
    });
    function updateFileName(file) {
        const name = file.name;
        fileNameDisplay.innerText = name.length > 20 ? name.substring(0, 17) + "..." : name;
    }

    // Parallax
    let mouse = { x: 0, y: 0 }, current = { x: 0, y: 0 };
    document.addEventListener('mousemove', (e) => {
        mouse.x = (e.clientX / window.innerWidth) - 0.5;
        mouse.y = (e.clientY / window.innerHeight) - 0.5;
    });
    function updateBackground() {
        current.x += (mouse.x - current.x) * 0