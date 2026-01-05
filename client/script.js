document.addEventListener("DOMContentLoaded", () => {
    const uploadModeBtn = document.getElementById("upload-mode-btn");
    const retrieveModeBtn = document.getElementById("retrieve-mode-btn");
    const uploadCard = document.getElementById("upload-card");
    const retrieveCard = document.getElementById("retrieve-card");
    const fileInput = document.getElementById("file-input");
    const fileNameDisplay = document.getElementById("file-name-display");
    const particleContainer = document.getElementById("particle-container");

    // --- 1. GSAP ENTRANCE ANIMATIONS ---
    const tl = gsap.timeline({ defaults: { ease: "power4.out" } });
    tl.from(".nav-brand, .nav-btn", { x: -60, opacity: 0, duration: 1.2, stagger: 0.1 })
      .from(".main-heading", { y: 50, opacity: 0, duration: 1 }, "-=0.8")
      .from(".glass-hub", { scale: 0.95, opacity: 0, duration: 1.2 }, "-=0.7");

    // --- 2. HD BUBBLE SHOT (PARTICLE BURST) ---
    function createBubbleShot(e) {
        const btn = e.submitter || e.target.querySelector('button');
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
                opacity: 0,
                scale: 0,
                duration: 0.8 + Math.random(),
                ease: "power2.out",
                onComplete: () => p.remove()
            });
        }
    }

    // --- 3. REFINED MAGNETIC NAVIGATION ---
    const navItems = document.querySelectorAll('.nav-btn, .nav-brand');
    navItems.forEach(item => {
        item.addEventListener('mousemove', (e) => {
            const rect = item.getBoundingClientRect();
            // Calculate distance from center
            const x = (e.clientX - rect.left - rect.width / 2) * 0.3; // Reduced multiplier to keep it in "box"
            const y = (e.clientY - rect.top - rect.height / 2) * 0.3;
            gsap.to(item, { x: x, y: y, duration: 0.3, ease: "power2.out" });
        });
        item.addEventListener('mouseleave', () => {
            // Stronger snap back
            gsap.to(item, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1.2, 0.4)" });
        });
    });

    // --- 4. HD LIQUID PHYSICS (LERP) ---
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

    // --- 5. MODE SWITCHING (OPACITY FIXED) ---
    function setMode(mode) {
        const target = mode === "upload" ? uploadCard : retrieveCard;
        const other = mode === "upload" ? retrieveCard : uploadCard;

        if (target === other) return;

        gsap.to(other, { opacity: 0, y: 20, duration: 0.3, onComplete: () => {
            other.classList.add("hidden");
            target.classList.remove("hidden");
            // FIXED: Opacity set to 1 for full visibility
            gsap.fromTo(target, 
                { opacity: 0, y: -20 }, 
                { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
            );
        }});

        uploadModeBtn.classList.toggle("active", mode === "upload");
        retrieveModeBtn.classList.toggle("active", mode === "retrieve");
    }

    uploadModeBtn.addEventListener("click", () => setMode("upload"));
    retrieveModeBtn.addEventListener("click", () => setMode("retrieve"));

    fileInput.addEventListener("change", (e) => {
        const name = e.target.files[0]?.name || "Initialize Packet";
        fileNameDisplay.innerText = name.length > 20 ? name.substring(0, 17) + "..." : name;
    });

    document.querySelectorAll('form').forEach(f => {
        f.addEventListener('submit', (e) => {
            e.preventDefault();
            createBubbleShot(e);
        });
    });
});
document.addEventListener("DOMContentLoaded", () => {
    const fileInput = document.getElementById("file-input");
    const fileNameDisplay = document.getElementById("file-name-display");
    const dropZone = document.querySelector(".drop-trigger");

    // 1. Prevent default browser behavior (opening the file)
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // 2. Add visual 'active' class when dragging over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-active');
        }, false);
    });

    // 3. Remove visual 'active' class when leaving or dropping
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-active');
        }, false);
    });

    // 4. Handle the dropped file
    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;

        if (files.length > 0) {
            // Link the dropped file to the actual hidden input
            fileInput.files = files; 
            updateFileName(files[0]);
        }
    }, false);

    // 5. Still handle standard click-to-upload
    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            updateFileName(e.target.files[0]);
        }
    });

    function updateFileName(file) {
        const name = file.name;
        fileNameDisplay.innerText = name.length > 20 ? name.substring(0, 17) + "..." : name;
        
        // Add a small GSAP pop effect if available
        if (window.gsap) {
            gsap.fromTo(fileNameDisplay, { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5 });
        }
    }
});