// client/script.js

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const mainAppContainer = document.getElementById('main-app-container');
    const codeDisplayView = document.getElementById('code-display-view');
    const finalDisplayCode = document.getElementById('final-display-code');
    const doneBtn = document.getElementById('done-btn');

    const uploadModeBtn = document.getElementById('upload-mode-btn');
    const retrieveModeBtn = document.getElementById('retrieve-mode-btn');
    const uploadCard = document.getElementById('upload-card');
    const retrieveCard = document.getElementById('retrieve-card');
    const uploadForm = document.getElementById('upload-form');
    const retrieveForm = document.getElementById('retrieve-form');
    const retrieveResult = document.getElementById('retrieve-result');
    const retrieveMessage = document.getElementById('retrieve-message'); // Error/status message text

    const fileInput = document.getElementById('file-input');
    const fileLabel = document.getElementById('file-label'); // Custom button text
    const fileNameDisplay = document.getElementById('file-name-display'); // Input display text
    const uploadSubmitBtn = document.getElementById('upload-submit-btn');
    const uploadingState = document.getElementById('uploading-state');
    const body = document.body;

    // --- VIEW MANAGEMENT FUNCTIONS ---
    
    // Function to switch between Upload and Retrieve modes (in the Main App View)
    function setMode(mode) {
        if (mode === 'upload') {
            uploadModeBtn.classList.add('active');
            retrieveModeBtn.classList.remove('active');
            uploadCard.classList.remove('hidden');
            retrieveCard.classList.add('hidden');
        } else {
            uploadModeBtn.classList.remove('active');
            retrieveModeBtn.classList.add('active');
            uploadCard.classList.add('hidden');
            retrieveCard.classList.remove('hidden');
        }
        retrieveResult.classList.add('hidden');
        uploadForm.reset();
        retrieveForm.reset();
        fileNameDisplay.textContent = 'No file chosen';
        fileLabel.textContent = 'Choose File';
    }

    // Function to show the full-screen code
    function showCodeView(code) {
        finalDisplayCode.textContent = code;
        mainAppContainer.classList.add('hidden');
        codeDisplayView.classList.remove('hidden');
    }

    // Function to dismiss the code and return to a clean upload view
    function dismissCodeView() {
        // Enforce session dismissal and clean state
        setMode('upload'); 
        
        codeDisplayView.classList.add('hidden');
        mainAppContainer.classList.remove('hidden');
    }

    // --- EVENT LISTENERS ---

    // Initial setup
    setMode('upload');
    doneBtn.addEventListener('click', dismissCodeView);
    uploadModeBtn.addEventListener('click', () => setMode('upload'));
    retrieveModeBtn.addEventListener('click', () => setMode('retrieve'));

    // Custom File Input Display Logic
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            fileNameDisplay.textContent = fileInput.files[0].name;
            fileLabel.textContent = 'Change File';
        } else {
            fileNameDisplay.textContent = 'No file chosen';
            fileLabel.textContent = 'Choose File';
        }
    });
    
    // NOTE: Removed Theme Toggle as your final screenshots didn't show the button, 
    // but the dark theme is enforced by the CSS body class.

    // --- UPLOAD Logic ---
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const passwordInput = document.getElementById('upload-password');
        
        if (!fileInput.files.length) return alert('Please select a file.');
        if (passwordInput.value.length < 6) return alert('Password must be at least 6 characters long.');

        const file = fileInput.files[0];
        const password = passwordInput.value;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('password', password);

        // UI Feedback: Show Uploading State
        uploadSubmitBtn.classList.add('hidden');
        uploadingState.classList.remove('hidden');

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();
            
            if (response.ok && data.success) {
                // Success! Redirect to the full-screen code view
                showCodeView(data.code); 
            } else {
                alert(`Upload failed: ${data.message || 'Unknown error'}`);
            }

        } catch (error) {
            console.error('Error:', error);
            alert('A network error occurred during upload.');
        } finally {
            // Restore Submit Button State
            uploadingState.classList.add('hidden');
            uploadSubmitBtn.classList.remove('hidden');
        }
    });

    // --- RETRIEVE Logic ---
    retrieveForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const code = document.getElementById('retrieve-code').value;
        const password = document.getElementById('retrieve-password').value;

        // Reset UI Feedback
        retrieveResult.classList.add('hidden');
        retrieveForm.querySelector('.primary-btn').disabled = true;

        try {
            const response = await fetch('/retrieve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ code, password })
            });

            if (response.ok) {
                // Success: Initiate file download
                const blob = await response.blob();
                const contentDisposition = response.headers.get('Content-Disposition');
                
                let filename = 'downloaded_file';
                if (contentDisposition && contentDisposition.indexOf('attachment') !== -1) {
                    const matches = /filename="([^"]*)"/.exec(contentDisposition);
                    if (matches != null && matches[1]) {
                        filename = matches[1];
                    }
                }

                // Create a temporary link element to trigger the download
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                a.remove();
                
                // Show success status
                alert('✅ File downloaded successfully!');
                
            } else {
                // Failure: Read the error message from the body
                const data = await response.json();
                
                // Show error message in the console/alert (matching the screenshot's error pop-up)
                alert(`Invalid Code or Password: ${data.message || 'The entered code and password combination is incorrect or expired.'}`);
                
                // You can optionally show a visual error bar/message if needed:
                // retrieveResult.classList.remove('hidden');
                // retrieveMessage.textContent = 'Invalid Code or Password';
                
            }

        } catch (error) {
            console.error('Retrieval Error:', error);
            alert('A network error occurred during retrieval.');
        } finally {
            retrieveForm.querySelector('.primary-btn').disabled = false;
        }
    });

});