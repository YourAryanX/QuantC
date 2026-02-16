document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'https://quantc.onrender.com'; 
    const SHARD_SIZE = 9 * 1024 * 1024; // 9MB (Safe zone for Cloudinary Free)

    // Wake up the server immediately
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

    // --- UPLOAD LOGIC ---
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
                const sigRes = await fetch(`${API_BASE_URL}/api/sign-upload`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}) // No params needed for folder-only signature
                });
                const sigData = await sigRes.json();
                if(!sigData.signature) throw new Error("Server signature failed");

                // 2. Encryption Setup
                const fileSalt = window.crypto.getRandomValues(new Uint8Array(16));
                const key = await deriveKey(password, fileSalt);
                
                const totalShards = Math.ceil(file.size / SHARD_SIZE);
                let currentShard = 0;
                let uploadedUrls = [];

                // 3. Process Shards
                for (let start = 0; start < file.size; start += SHARD_SIZE) {
                    currentShard++;
                    const end = Math.min(start + SHARD_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkBuffer = await chunkBlob.arrayBuffer();

                    const progress = Math.round((currentShard / totalShards) * 100);
                    updateLoadingText(`Encrypting Part ${currentShard}/${totalShards} (${progress}%)`);

                    // Encrypt
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encryptedChunk = await window.crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: iv }, key, chunkBuffer
                    );

                    // Combine IV (12 bytes) + Encrypted Data
                    const combinedBuffer = new Uint8Array(iv.length + encryptedChunk.byteLength);
                    combinedBuffer.set(iv);
                    combinedBuffer.set(new Uint8Array(encryptedChunk), iv.length);

                    updateLoadingText(`Uploading Part ${currentShard}/${totalShards}...`);
                    
                    // Upload via XHR for raw binary support
                    const response = await uploadShard(combinedBuffer, sigData);
                    uploadedUrls.push(response.secure_url);
                }

                // 4. Finalize
                updateLoadingText("Finalizing...");
                const finalRes = await fetch(`${API_BASE_URL}/api/finalize-upload`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        password: password,
                        originalName: file.name,
                        mimeType: file.type,
                        parts: uploadedUrls,
                        salt: bytesToHex(fileSalt),
                        iv: "sharded"
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

    // Helper: Upload Shard (Retries built-in via recursion if needed, kept simple here)
    function uploadShard(data, sigData) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            // Force RAW upload so Cloudinary doesn't process it
            const url = `https://api.cloudinary.com/v1_1/${sigData.cloudName}/raw/upload`;
            
            xhr.open("POST", url, true);
            const formData = new FormData();
            // Use .dat extension to ensure it is treated as generic binary
            formData.append("file", new Blob([data]), "shard.dat");
            formData.append("api_key", sigData.apiKey);
            formData.append("timestamp", sigData.timestamp);
            formData.append("signature", sigData.signature);
            formData.append("folder", "quantc_shards");

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
                else reject(new Error("Cloud upload failed"));
            };
            xhr.onerror = () => reject(new Error("Network Error"));
            xhr.send(formData);
        });
    }

    // --- RETRIEVE LOGIC ---
    if(retrieveForm) {
        retrieveForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('retrieve-code').value;
            const password = document.getElementById('retrieve-password').value;
            
            toggleLoading('retrieve-card', true, "Locating...");

            try {
                // 1. Get Metadata
                const metaRes = await fetch(`${API_BASE_URL}/api/retrieve-meta`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code, password })
                });
                const metaData = await metaRes.json();
                if(!metaData.success) throw new Error(metaData.message);

                const fileSalt = hexToBytes(metaData.salt);
                const key = await deriveKey(password, fileSalt);
                const decryptedParts = [];
                
                // 2. Download & Decrypt Each Shard
                for (let i = 0; i < metaData.parts.length; i++) {
                    updateLoadingText(`Downloading Part ${i+1}/${metaData.parts.length}...`);
                    
                    const rawUrl = metaData.parts[i];
                    // USE PROXY to bypass CORS/Network blocks
                    const proxyUrl = `${API_BASE_URL}/api/proxy?url=${encodeURIComponent(rawUrl)}`;
                    
                    const res = await fetch(proxyUrl);
                    if (!res.ok) throw new Error("Download failed");
                    const buffer = await res.arrayBuffer();

                    updateLoadingText(`Decrypting Part ${i+1}...`);
                    
                    // Extract IV (first 12 bytes) & Data
                    const iv = buffer.slice(0, 12);
                    const data = buffer.slice(12);

                    try {
                        const decrypted = await window.crypto.subtle.decrypt(
                            { name: "AES-GCM", iv: new Uint8Array(iv) }, 
                            key, 
                            data
                        );
                        decryptedParts.push(decrypted);
                    } catch (e) {
                        throw new Error("Decryption failed. Wrong password?");
                    }
                }

                // 3. Assemble & Save
                updateLoadingText("Assembling...");
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
                showToast(error.message, "error");
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

    // Standard Animation / UI Logic
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