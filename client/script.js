document.addEventListener("DOMContentLoaded", () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'https://quantc.onrender.com'; 

    // !!! DEVELOPER MODE: UNCOMMENT TO FORCE TOUR FOR TESTING !!!
    localStorage.removeItem("quantc_tour_seen"); 

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

    // --- 1. ANIMATION LOGIC ---
    
    // Function A: The Grand Entrance (Animated)
    function playEntranceAnimations() {
        try {
            const tl = gsap.timeline({ defaults: { ease: "power4.out" } });
            
            // Force hidden state first to ensure animation plays visible change
            gsap.set(".nav-brand, .nav-btn", { x: -60, autoAlpha: 0 });
            gsap.set(".main-heading", { y: 50, autoAlpha: 0 });
            gsap.set(".glass-hub:not(.hidden)", { scale: 0.95, autoAlpha: 0, y: 30 });

            // Play Animation
            tl.to(".nav-brand, .nav-btn", { x: 0, autoAlpha: 1, duration: 1.2, stagger: 0.1 })
              .to(".main-heading", { y: 0, autoAlpha: 1, duration: 1 }, "-=0.8")
              .to(".glass-hub:not(.hidden)", { scale: 1, y: 0, autoAlpha: 1, duration: 1.2 }, "-=0.7");
        } catch (e) { console.error("GSAP Error:", e); }
    }

    // Function B: Static Visibility (For Tour Context)
    // We need elements visible so the tour can point to them, but without the "Entrance" flare yet.
    function showStaticForTour() {
        gsap.set(".nav-brand, .nav-btn", { x: 0, autoAlpha: 1 });
        gsap.set(".main-heading", { y: 0, autoAlpha: 1 });
        gsap.set(".glass-hub:not(.hidden)", { scale: 1, y: 0, autoAlpha: 1 });
    }

    // --- 2. TOAST SYSTEM ---
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

    // --- 3. LOADING & VISUALS ---
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

    // --- 4. CORE FUNCTIONALITY ---
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
            formData.append('file', file);
            formData.append('password', password);
            try {
                const response = await fetch(`${API_BASE_URL}/api/upload`, { method: 'POST', body: formData });
                const data = await response.json();
                if (response.ok && data.success) {
                    uploadForm.classList.add('hidden');
                    uploadResult.classList.remove('hidden');
                    generatedCodeSpan.innerText = data.code;
                    gsap.fromTo("#upload-result", {opacity: 0, y: 20}, {opacity: 1, y: 0, duration: 0.5});
                    showToast("File encrypted successfully!", "success");
                } else { throw new Error(data.message || "Upload failed"); }
            } catch (error) { showToast(error.message || "Server error", "error"); } 
            finally { toggleLoading('upload-card', false); }
        });
    }

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
                    showToast("File downloaded successfully!", "success");
                } else {
                    const data = await response.json();
                    throw new Error(data.message || "Invalid Code or Password");
                }
            } catch (error) { showToast(error.message, "error"); } 
            finally { toggleLoading('retrieve-card', false); }
        });
    }

    // --- 5. UTILS ---
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

    // --- 6. BACKGROUND ANIMATION ---
    const navItems = document.querySelectorAll('.nav-btn, .nav-brand');
    navItems.forEach(item => {
        item.addEventListener('mousemove', (e) => {
            const rect = item.getBoundingClientRect();
            const x = (e.clientX - rect.left - rect.width / 2) * 0.3; 
            const y = (e.clientY - rect.top - rect.height / 2) * 0.3;
            gsap.to(item, { x: x, y: y, duration: 0.3, ease: "power2.out" });
        });
        item.addEventListener('mouseleave', () => gsap.to(item, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1.2, 0.4)" }));
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

    // ============================================
    // ============ TOUR SYSTEM ===================
    // ============================================

    const tourStartModal = document.getElementById("tour-start-modal");
    const activeTourLayer = document.getElementById("active-tour-layer");
    const tourBackdrop = document.getElementById("tour-backdrop");
    const btnStartTour = document.getElementById("btn-start-tour");
    const btnSkipTour = document.getElementById("btn-skip-tour");
    const tooltip = document.getElementById("tour-tooltip");
    const stepTitle = document.getElementById("step-title");
    const stepDesc = document.getElementById("step-desc");
    const stepCounter = document.getElementById("step-counter");
    const nextBtn = document.getElementById("tour-next-btn");
    const svgLine = document.getElementById("tour-connector");
    const svgAnchor = document.getElementById("tour-anchor");

    const tourSteps = [
      { target: "#upload-mode-btn", title: "Uploading Hub", text: "This is your uploading center. Click here to access the Uploading interface." },
      { target: "#retrieve-mode-btn", title: "Retrieval Hub", text: "To retrieve your file enter your 'Code' and 'Key Phrase' here." },
      { target: ".drop-trigger", title: "Quantum Drop Zone", text: "Drag and drop or select your sensitive documents here and retrieve it anywhere in the World." },
      { target: "#upload-password", title: "Secure Key Phrase", text: "Set a strong password or key phrase to protect your file securely." },
      { target: "button[type='submit']", title: "Generate Code", text: "Click here to finish uploading and get your unique code to retrieve your file." }
    ];

    let currentTourIndex = 0;

    // --- MAIN INITIALIZATION LOGIC ---
    // 1. Check if user is New or Returning
    if (!localStorage.getItem("quantc_tour_seen")) {
        // NEW USER:
        // A. Show Tour Modal
        tourBackdrop.classList.remove("hidden");
        tourStartModal.classList.remove("hidden");
        
        // B. Make website elements visible STATICALLY so tour can point to them
        // (We don't play the fancy animation yet, we save that for the end)
        showStaticForTour();
    } else {
        // RETURNING USER:
        // A. Ensure Tour is Hidden
        tourBackdrop.classList.add("hidden");
        tourStartModal.classList.add("hidden");
        
        // B. Play Grand Entrance immediately
        playEntranceAnimations();
    }

    btnSkipTour.addEventListener("click", () => {
        closeTour();
        localStorage.setItem("quantc_tour_seen", "true");
    });

    btnStartTour.addEventListener("click", () => {
        // Fade out modal to start tour
        gsap.to(tourStartModal, { opacity: 0, duration: 0.3, onComplete: () => {
            tourStartModal.classList.add("hidden");
        }});
        activeTourLayer.classList.remove("hidden");
        activeTourLayer.style.zIndex = "10040"; 
        
        // Ensure static elements are visible for the tour
        showStaticForTour();
        runTourStep(0);
    });

    nextBtn.addEventListener("click", () => {
        if (currentTourIndex < tourSteps.length - 1) {
            runTourStep(currentTourIndex + 1);
        } else {
            closeTour();
            localStorage.setItem("quantc_tour_seen", "true");
        }
    });

    function runTourStep(index) {
        currentTourIndex = index;
        const step = tourSteps[index];
        const targetEl = document.querySelector(step.target);

        if(step.target === "#upload-mode-btn") {
            gsap.to(svgAnchor, { autoAlpha: 0, duration: 0.3 });
        } else {
            gsap.to(svgAnchor, { autoAlpha: 1, duration: 0.3 });
        }

        document.querySelectorAll(".tour-focus-element").forEach(el => el.classList.remove("tour-focus-element"));
        document.querySelectorAll(".tour-elevated-parent").forEach(el => {
            el.classList.remove("tour-elevated-parent");
            el.classList.remove("tour-strip-visuals");
        });

        if(targetEl) {
            targetEl.classList.add("tour-focus-element");
            const parentContainer = targetEl.closest('.floating-nav, .glass-hub');
            if (parentContainer) {
                parentContainer.classList.add("tour-elevated-parent");
                if(parentContainer.classList.contains("floating-nav")) parentContainer.classList.add("tour-strip-visuals");
            }
            const isNavBar = targetEl.closest('.floating-nav');
            if(window.innerWidth <= 768 && !isNavBar) {
                targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }

        stepTitle.innerText = step.title;
        stepDesc.innerText = step.text;
        stepCounter.innerText = `${index + 1} / ${tourSteps.length}`;
        nextBtn.innerHTML = index === tourSteps.length - 1 ? 'Finish <i class="fa-solid fa-check"></i>' : 'Next <i class="fa-solid fa-chevron-right"></i>';

        gsap.to(tooltip, { opacity: 1, duration: 0.5 });
        updateLayout(targetEl, true);
    }

    function updateLayout(targetEl, animate = false) {
        if (!targetEl) return;
        
        const targetRect = targetEl.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const targetX = targetRect.left + targetRect.width / 2;
        const targetY = targetRect.top + targetRect.height / 2;
        let toolX, toolY;

        if (window.innerWidth > 768) {
            const offset = 60; 
            toolX = targetRect.right + offset;
            toolY = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
            if (toolY + tooltipRect.height > window.innerHeight) toolY = window.innerHeight - tooltipRect.height - 20; 
            if (toolY < 0) toolY = 20;
            if (toolX + tooltipRect.width > window.innerWidth) toolX = targetRect.left - tooltipRect.width - offset; 
        } else {
            const mobileOffset = 30; 
            toolX = (window.innerWidth - tooltipRect.width) / 2;
            let proposedY = targetRect.bottom + mobileOffset;
            if (proposedY + tooltipRect.height > window.innerHeight) {
                proposedY = targetRect.top - tooltipRect.height - mobileOffset;
            }
            if (proposedY < 60) proposedY = 60; 
            toolY = proposedY;
        }

        const duration = animate ? 0.6 : 0;
        const ease = animate ? "power3.out" : "none";

        gsap.to(tooltip, { x: toolX, y: toolY, duration: duration, ease: ease });

        const lineEnd = { x: toolX + tooltipRect.width / 2, y: toolY + tooltipRect.height / 2 };
        if(svgLine) {
            gsap.to(svgLine, {
                attr: { x1: targetX, y1: targetY, x2: lineEnd.x, y2: lineEnd.y },
                duration: duration, ease: ease
            });
            gsap.to(svgAnchor, {
                attr: { cx: targetX, cy: targetY },
                duration: duration, ease: ease
            });
        }
    }

    function closeTour() {
        // --- THIS IS THE FIX ---
        // 1. Fade out the Tour Elements
        const exitTl = gsap.timeline({
            onComplete: () => {
                tourBackdrop.classList.add("hidden");
                tourStartModal.classList.add("hidden");
                activeTourLayer.classList.add("hidden");
                
                document.querySelectorAll(".tour-focus-element").forEach(el => el.classList.remove("tour-focus-element"));
                document.querySelectorAll(".tour-elevated-parent").forEach(el => {
                    el.classList.remove("tour-elevated-parent");
                    el.classList.remove("tour-strip-visuals");
                });

                // 2. NOW Play the Grand Entrance Animation
                // This ensures the user SEES the animation even if they skipped
                playEntranceAnimations();
            }
        });

        exitTl.to([tourBackdrop, tourStartModal, activeTourLayer, tooltip], { 
            opacity: 0, 
            duration: 0.1, 
            ease: "power2.inOut" 
        });
    }

    window.addEventListener("resize", () => {
        if (!activeTourLayer.classList.contains("hidden")) {
             const step = tourSteps[currentTourIndex];
             const targetEl = document.querySelector(step.target);
             updateLayout(targetEl);
        }
    });
});