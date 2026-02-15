document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'https://quantc.onrender.com'; 
    const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB Chunks

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
        return 'quantc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }

    // --- UPLOAD LOGIC (CHUNKED + RETRY) ---
    if(uploadForm) {
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            const password = document.getElementById('upload-password').value;
            
            if (!file) return showToast("Please select a file.", "error");
            if (password.length < 6) return showToast("Password must be 6+ chars.", "error");

            toggleLoading('upload-card', true, "Initializing...");

            try {
                const uniqueUploadId = generateUniqueId();

                // 1. Get Signature (Passing the ID so it gets signed!)
                const sigRes = await fetch(`${API_BASE_URL}/api/sign-upload`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ public_id: uniqueUploadId })
                });
                const sigData = await sigRes.json();
                if(!sigData.signature) throw new Error("Server signature failed");

                // 2. Prepare Encryption
                const fileSalt = window.crypto.getRandomValues(new Uint8Array(16));
                const key = await deriveKey(password, fileSalt);
                
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                let currentChunk = 0;

                // 3. Process & Upload Chunks
                for (let start = 0; start < file.size; start += CHUNK_SIZE) {
                    currentChunk++;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkBuffer = await chunkBlob.arrayBuffer();

                    const progress = Math.round((start / file.size) * 100);
                    updateLoadingText(`Encrypting Part ${currentChunk}/${totalChunks} (${progress}%)`);

                    // Encrypt Chunk
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encryptedChunk = await window.crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: iv }, key, chunkBuffer
                    );

                    // Combine IV + Encrypted Data
                    const combinedBuffer = new Uint8Array(iv.length + encryptedChunk.byteLength);
                    combinedBuffer.set(iv);
                    combinedBuffer.set(new Uint8Array(encryptedChunk), iv.length);

                    // Upload with Retry Logic
                    updateLoadingText(`Uploading Part ${currentChunk}/${totalChunks}...`);
                    await uploadChunkWithRetry(
                        combinedBuffer, 
                        sigData, 
                        uniqueUploadId, 
                        start, 
                        end, 
                        file.size
                    );
                }

                // 4. Finalize
                updateLoadingText("Finalizing...");
                // Cloudinary URL construction
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
                        iv: "chunked"
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

    // --- RETRY WRAPPER ---
    async function uploadChunkWithRetry(data, sigData, uploadId, start, end, totalSize, retries = 3) {
        try {
            return await uploadChunkToCloudinary(data, sigData, uploadId, start, end, totalSize);
        } catch (err) {
            if (retries > 0) {
                console.warn(`Chunk failed. Retrying... (${retries} left)`);
                await new Promise(r => setTimeout(r, 1000)); // Wait 1 sec
                return uploadChunkWithRetry(data, sigData, uploadId, start, end, totalSize, retries - 1);
            } else {
                throw err;
            }
        }
    }

    // --- BASE UPLOADER ---
    function uploadChunkToCloudinary(data, sigData, uploadId, start, end, totalSize) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `https://api.cloudinary.com/v1_1/${sigData.cloudName}/auto/upload`;
            
            xhr.open("POST", url, true);
            
            xhr.setRequestHeader("X-Unique-Upload-Id", uploadId);
            // Content-Range: bytes start-end/total
            // Important: end is inclusive index.
            // Cloudinary requires this header for chunked uploads
            const rangeStart = start;
            const rangeEnd = start + data.byteLength - 1;
            xhr.setRequestHeader("Content-Range", `bytes ${rangeStart}-${rangeEnd}/${-1}`);

            const formData = new FormData();
            formData.append("file", new Blob([data]));
            formData.append("api_key", sigData.apiKey);
            formData.append("timestamp", sigData.timestamp);
            formData.append("signature", sigData.signature);
            formData.append("folder", "quantc_files");
            formData.append("public_id", uploadId); 

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

                // 2. Download FULL file
                const fileRes = await fetch(metaData.url);
                const fullArrayBuffer = await fileRes.arrayBuffer();
                
                // 3. Decrypt
                updateLoadingText("Decrypting...");
                
                const fileSalt = hexToBytes(metaData.salt);
                const key = await deriveKey(password, fileSalt);
                
                const decryptedParts = [];
                let offset = 0;
                
                // Chunk size + Overhead (12 IV + 16 Tag = 28 bytes)
                const ENC_CHUNK_SIZE = CHUNK_SIZE + 28; 

                while (offset < fullArrayBuffer.byteLength) {
                    const remaining = fullArrayBuffer.byteLength - offset;
                    // Last chunk might be smaller
                    const currentSize = (remaining > ENC_CHUNK_SIZE) ? ENC_CHUNK_SIZE : remaining;

                    // Safety check for very last small byte fragments
                    if(currentSize <= 28) break;

                    const chunk = fullArrayBuffer.slice(offset, offset + currentSize);
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

    // --- UTILS & UI ---
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
        current.x += (mouse.x - current.x) * 0.05;
        current.y += (mouse.y - current.y) * 0.05;
        gsap.set('#orb-1', { x: current.x * 120, y: current.y * 120 });
        gsap.set('#orb-2', { x: current.x * -180, y: current.y * -180 });
        gsap.set('#orb-3', { x: current.x * 80, y: current.y * -80 });
        requestAnimationFrame(updateBackground);
    }
    updateBackground();
});