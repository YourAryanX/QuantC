document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    // Taken strictly from your old code
    const API_BASE_URL = 'https://quantc.onrender.com'; 

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

    // --- 1. GSAP ENTRANCE ANIMATIONS ---
    const tl = gsap.timeline({ defaults: { ease: "power4.out" } });
    tl.from(".nav-brand, .nav-btn", { x: -60, opacity: 0, duration: 1.2, stagger: 0.1 })
      .from(".main-heading", { y: 50, opacity: 0, duration: 1 }, "-=0.8")
      .from(".glass-hub", { scale: 0.95, opacity: 0, duration: 1.2 }, "-=0.7");

    // --- 2. NOTIFICATION SYSTEM (TOASTS) ---
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return; 

        const toast = document.createElement('div');
        let icon = 'fa-info-circle';
        if(type === 'success') icon = 'fa-check-circle';
        if(type === 'error') icon = 'fa-exclamation-triangle';
        
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
        
        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 500);
        }, 3500);
    }

    // --- 3. LOADING STATE TOGGLE ---
    function toggleLoading(cardId, isLoading) {
        const card = document.getElementById(cardId);
        const loader = card.querySelector('.loading-overlay');
        if (isLoading) loader.classList.remove('hidden');
        else loader.classList.add('hidden');
    }

    // --- 4. VISUALS: BUBBLE SHOT EFFECT ---
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

    // --- 5. API LOGIC: UPLOAD ---
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const file = fileInput.files[0];
        const password = document.getElementById('upload-password').value;

        if (!file) {
            showToast("Please select a file.", "error");
            return;
        }
        if (password.length < 6) {
            showToast("Password must be 6+ chars.", "error");
            return;
        }

        createBubbleShot(e); 
        toggleLoading('upload-card', true);

        // Strict FormData construction from your old code
        const formData = new FormData();
        formData.append('file', file);
        formData.append('password', password);

        try {
            // FIX: Uses /api/upload endpoint
            const response = await fetch(`${API_BASE_URL}/api/upload`, { 
               method: 'POST', 
               body: formData 
            });

            const data = await response.json();

            if (response.ok && data.success) {
                // Success!
                uploadForm.classList.add('hidden');
                uploadResult.classList.remove('hidden');
                generatedCodeSpan.innerText = data.code;
                
                gsap.fromTo("#upload-result", {opacity: 0, y: 20}, {opacity: 1, y: 0, duration: 0.5});
                showToast("File encrypted successfully!", "success");
            } else {
                throw new Error(data.message || "Upload failed");
            }

        } catch (error) {
            console.error(error);
            showToast(error.message || "Server connection failed.", "error");
        } finally {
            toggleLoading('upload-card', false);
        }
    });

    // --- 6. API LOGIC: RETRIEVE ---
    retrieveForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('retrieve-code').value;
        const password = document.getElementById('retrieve-password').value;

        createBubbleShot(e);
        toggleLoading('retrieve-card', true);

        try {
            // FIX: Uses POST method and /api/retrieve endpoint (matching old code)
            const response = await fetch(`${API_BASE_URL}/api/retrieve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code, password }),
            });

            if (response.ok) {
                // Success: Handle Blob Download
                const blob = await response.blob();
                
                // Extract filename from header if available
                let filename = "downloaded_file";
                const contentDisposition = response.headers.get("Content-Disposition");
                if (contentDisposition && contentDisposition.indexOf("attachment") !== -1) {
                    const matches = /filename="([^"]*)"/.exec(contentDisposition);
                    if (matches != null && matches[1]) {
                        filename = matches[1];
                    }
                }

                // Trigger Download
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.style.display = "none";
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                a.remove();

                showToast("File downloaded successfully!", "success");
            } else {
                // Failure: Parse error message
                const data = await response.json();
                throw new Error(data.message || "Invalid Code or Password");
            }

        } catch (error) {
            console.error("Retrieval Error:", error);
            showToast(error.message, "error");
        } finally {
            toggleLoading('retrieve-card', false);
        }
    });

    // --- 7. UTILITIES ---
    resetUploadBtn.addEventListener('click', () => {
        uploadResult.classList.add('hidden');
        uploadForm.classList.remove('hidden');
        uploadForm.reset();
        fileNameDisplay.innerText = "Initialize Packet";
        gsap.fromTo(uploadForm, {opacity: 0}, {opacity: 1, duration: 0.5});
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(generatedCodeSpan.innerText);
        showToast("Code copied to clipboard!", "success");
        gsap.to(copyBtn, { scale: 1.3, duration: 0.1, yoyo: true, repeat: 1 });
    });

    // --- 8. DRAG AND DROP ---
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault(); e.stopPropagation();
        }, false);
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
        if (files.length > 0) {
            fileInput.files = files; 
            updateFileName(files[0]);
        }
    }, false);

    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) updateFileName(e.target.files[0]);
    });

    function updateFileName(file) {
        const name = file.name;
        fileNameDisplay.innerText = name.length > 20 ? name.substring(0, 17) + "..." : name;
        gsap.fromTo(fileNameDisplay, { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5 });
    }

    // --- 9. BACKGROUND & NAVIGATION ---
    const navItems = document.querySelectorAll('.nav-btn, .nav-brand');
    navItems.forEach(item => {
        item.addEventListener('mousemove', (e) => {
            const rect = item.getBoundingClientRect();
            const x = (e.clientX - rect.left - rect.width / 2) * 0.3; 
            const y = (e.clientY - rect.top - rect.height / 2) * 0.3;
            gsap.to(item, { x: x, y: y, duration: 0.3, ease: "power2.out" });
        });
        item.addEventListener('mouseleave', () => {
            gsap.to(item, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1.2, 0.4)" });
        });
    });

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
});