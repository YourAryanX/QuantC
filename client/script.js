document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'https://quantc.onrender.com'; // Make sure this matches your deployed URL

    // 1. WAKE UP CALL (Fixes the "First Load" delay)
    fetch(`${API_BASE_URL}/api/health`)
        .then(() => console.log("Server is awake"))
        .catch(err => console.log("Waking up server...", err));

    // --- DOM ELEMENTS ---
    const uploadModeBtn = document.getElementById("upload-mode-btn");
    const retrieveModeBtn = document.getElementById("retrieve-mode-btn");
    const uploadCard = document.getElementById("upload-card");
    const retrieveCard = document.getElementById("retrieve-card");
    const fileInput = document.getElementById("file-input");
    const fileNameDisplay = document.getElementById("file-name-display");
    const particleContainer = document.getElementById("particle-container");
    const dropZone = document.querySelector(".drop-trigger");
    const uploadForm = document.getElementById("upload-form");
    const retrieveForm = document.getElementById("retrieve-form");
    const uploadResult = document.getElementById("upload-result");
    const generatedCodeSpan = document.getElementById("generated-code");
    const resetUploadBtn = document.getElementById("reset-upload-btn");
    const copyBtn = document.getElementById("copy-btn");

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
    
    // Check for tour (optional logic retained)
    if (!localStorage.getItem("quantc_tour_seen")) {
         playEntranceAnimations();
    } else {
         playEntranceAnimations();
    }

    // --- TOASTS ---
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
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 500);
        }, 3500);
    }

    function toggleLoading(cardId, isLoading) {
        const loader = document.getElementById(cardId).querySelector('.loading-overlay');
        if (isLoading) loader.classList.remove('hidden');
        else loader.classList.add('hidden');
    }

    function createBubbleShot(e) {
        if (!e || !e.submitter) return;
        const btn = e.submitter;
        const rect = btn.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        for (let i = 0; i < 20; i++) {
            const p = document.createElement("div");
            p.className = "particle";
            particleContainer.appendChild(p);
            const size = Math.random() * 8 + 4;
            const angle = Math.random() * Math.PI * 2;
            const velocity = Math.random() * 100 + 50;
            gsap.set(p, { width: size, height: size, x: centerX, y: centerY, opacity: 1 });
            gsap.to(p, {
                x: centerX + Math.cos(angle) * velocity,
                y: centerY + Math.sin(angle) * velocity,
                opacity: 0, scale: 0, duration: 0.8 + Math.random(),
                ease: "power2.out", onComplete: () => p.remove()
            });
        }
    }

    // --- UPLOAD LOGIC ---
    if(uploadForm) {
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            const password = document.getElementById('upload-password').value;
            
            if (!file) return showToast("Please select a file.", "error");
            if (password.length < 6) return showToast("Password must be 6+ chars.", "error");

            createBubbleShot(e);
            toggleLoading('upload-card', true);

            const formData = new FormData();
            // CRITICAL: Password MUST be first for the new streaming backend
            formData.append('password', password); 
            formData.append('file', file); 

            try {
                const response = await fetch(`${API_BASE_URL}/api/upload`, { method: 'POST', body: formData });
                const data = await response.json();
                
                if (response.ok && data.success) {
                    uploadForm.classList.add('hidden');
                    uploadResult.classList.remove('hidden');
                    generatedCodeSpan.innerText = data.code;
                    gsap.fromTo("#upload-result", {opacity: 0, y: 20}, {opacity: 1, y: 0, duration: 0.5});
                    showToast("Uploaded successfully!", "success");
                } else { throw new Error(data.message || "Upload failed"); }
            } catch (error) { showToast(error.message || "Server error", "error"); } 
            finally { toggleLoading('upload-card', false); }
        });
    }

    // --- RETRIEVE LOGIC ---
    if(retrieveForm) {
        retrieveForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('retrieve-code').value;
            const password = document.getElementById('retrieve-password').value;
            createBubbleShot(e);
            toggleLoading('retrieve-card', true);
            try {
                const response = await fetch(`${API_BASE_URL}/api/retrieve`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code, password }),
                });
                if (response.ok) {
                    const blob = await response.blob();
                    let filename = "downloaded_file";
                    const contentDisposition = response.headers.get("Content-Disposition");
                    if (contentDisposition && contentDisposition.includes("attachment")) {
                        const matches = /filename="([^"]*)"/.exec(contentDisposition);
                        if (matches && matches[1]) filename = matches[1];
                    }
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.style.display = "none";
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    a.remove();
                    showToast("Download started!", "success");
                } else {
                    const data = await response.json();
                    throw new Error(data.message || "Invalid Code");
                }
            } catch (error) { showToast(error.message, "error"); } 
            finally { toggleLoading('retrieve-card', false); }
        });
    }

    // --- UTILS & UI ---
    if(resetUploadBtn) resetUploadBtn.addEventListener('click', () => {
        uploadResult.classList.add('hidden');
        uploadForm.classList.remove('hidden');
        uploadForm.reset();
        fileNameDisplay.innerText = "Initialize Packet";
        generatedCodeSpan.innerText = ""; 
        gsap.fromTo(uploadForm, {opacity: 0}, {opacity: 1, duration: 0.5});
    });

    if(copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(generatedCodeSpan.innerText);
        showToast("Code copied", "success");
        gsap.to(copyBtn, { scale: 1.3, duration: 0.1, yoyo: true, repeat: 1 });
    });

    if(dropZone) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
        });
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
        });
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
        });
        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files.length > 0) { fileInput.files = files; updateFileName(files[0]); }
        }, false);
    }
    if(fileInput) fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) updateFileName(e.target.files[0]);
    });
    function updateFileName(file) {
        const name = file.name;
        fileNameDisplay.innerText = name.length > 20 ? name.substring(0, 17) + "..." : name;
        gsap.fromTo(fileNameDisplay, { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5 });
    }

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

    // Mouse parallax
    let mouse = { x: 0, y: 0 };
    let current = { x: 0, y: 0 };
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