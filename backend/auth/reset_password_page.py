from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

@router.get("/reset-password", response_class=HTMLResponse)
async def reset_password_page(token: str = ""):
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Reset Password - Nueco</title>
        <style>
            * {{ box-sizing: border-box; margin: 0; padding: 0; }}
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: #F5F3EE;
                min-height: 100vh;
                padding: 40px 24px;
            }}
            .back-btn {{
                width: 40px; height: 40px;
                background: white;
                border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                margin-bottom: 32px;
                cursor: pointer;
                border: none;
                box-shadow: 0 1px 4px rgba(0,0,0,0.1);
            }}
            .back-btn svg {{
                width: 18px; height: 18px;
                stroke: #1a1a1a;
                fill: none;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }}
            h1 {{
                font-size: 32px;
                font-weight: 800;
                color: #1a1a1a;
                margin-bottom: 8px;
            }}
            .subtitle {{
                font-size: 16px;
                color: #6B7280;
                margin-bottom: 32px;
                line-height: 1.5;
            }}
            .field-label {{
                font-size: 15px;
                font-weight: 600;
                color: #1a1a1a;
                margin-bottom: 8px;
                display: block;
            }}
            .field-group {{
                margin-bottom: 20px;
            }}
            .input-wrapper {{
                position: relative;
                background: white;
                border-radius: 16px;
                border: 1.5px solid #E5E7EB;
                display: flex;
                align-items: center;
                padding: 0 16px;
            }}
            .input-icon {{
                display: flex;
                align-items: center;
                margin-right: 10px;
                flex-shrink: 0;
            }}
            .input-icon svg {{
                width: 20px;
                height: 20px;
                stroke: #9CA3AF;
                fill: none;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }}
            input {{
                flex: 1;
                border: none;
                outline: none;
                font-size: 16px;
                padding: 16px 0;
                background: transparent;
                color: #1a1a1a;
            }}
            input::placeholder {{ color: #9CA3AF; }}
            .toggle {{
                cursor: pointer;
                display: flex;
                align-items: center;
                padding: 4px;
                user-select: none;
                flex-shrink: 0;
                background: none;
                border: none;
            }}
            .toggle svg {{
                width: 20px;
                height: 20px;
                stroke: #9CA3AF;
                fill: none;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }}
            .hint {{
                font-size: 13px;
                color: #9CA3AF;
                margin-top: 6px;
            }}
            .submit-btn {{
                width: 100%;
                padding: 18px;
                background: #C0392B;
                color: white;
                border: none;
                border-radius: 16px;
                font-size: 17px;
                font-weight: 700;
                cursor: pointer;
                margin-top: 12px;
                letter-spacing: 0.3px;
            }}
            .submit-btn:disabled {{
                background: #E5E7EB;
                color: #9CA3AF;
                cursor: not-allowed;
            }}
            .message {{
                margin-top: 20px;
                padding: 14px 16px;
                border-radius: 12px;
                font-size: 15px;
                line-height: 1.6;
            }}
            .success {{
                background: #ECFDF5;
                color: #065F46;
            }}
            .error {{
                background: #FEF2F2;
                color: #991B1B;
            }}
            .debug {{
                margin-top: 8px;
                font-size: 11px;
                color: #9CA3AF;
                word-break: break-all;
            }}
        </style>
    </head>
    <body>
        <button class="back-btn" onclick="history.back()">
            <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <h1>Reset Password</h1>
        <p class="subtitle">Enter your new password below.</p>

        <div class="field-group" id="passwordGroup">
            <label class="field-label">Password</label>
            <div class="input-wrapper">
                <span class="input-icon">
                    <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </span>
                <input type="password" id="password" placeholder="Create a password" />
                <button class="toggle" onclick="togglePassword('password', this)" type="button">
                    <svg id="eye-password" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            </div>
            <p class="hint">At least 8 characters</p>
        </div>

        <div class="field-group" id="confirmGroup">
            <label class="field-label">Confirm Password</label>
            <div class="input-wrapper">
                <span class="input-icon">
                    <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </span>
                <input type="password" id="confirm" placeholder="Confirm your password" />
                <button class="toggle" onclick="togglePassword('confirm', this)" type="button">
                    <svg id="eye-confirm" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            </div>
        </div>

        <button class="submit-btn" id="submitBtn" onclick="resetPassword()">Reset Password</button>
        <div id="message"></div>
        <div id="debug" class="debug"></div>

        <script>
            const eyeOpen = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:#9CA3AF;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            const eyeClosed = `<svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:#9CA3AF;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

            function togglePassword(id, btn) {{
                const input = document.getElementById(id);
                if (input.type === 'password') {{
                    input.type = 'text';
                    btn.innerHTML = eyeClosed;
                }} else {{
                    input.type = 'password';
                    btn.innerHTML = eyeOpen;
                }}
            }}

            async function resetPassword() {{
                const password = document.getElementById('password').value;
                const confirm = document.getElementById('confirm').value;
                const message = document.getElementById('message');
                const debug = document.getElementById('debug');
                const btn = document.getElementById('submitBtn');

                message.className = '';
                message.innerText = '';
                debug.innerText = '';

                if (!password) {{
                    message.className = 'message error';
                    message.innerText = 'Please enter a new password.';
                    return;
                }}
                if (password !== confirm) {{
                    message.className = 'message error';
                    message.innerText = 'Passwords do not match.';
                    return;
                }}
                if (password.length < 8) {{
                    message.className = 'message error';
                    message.innerText = 'Password must be at least 8 characters.';
                    return;
                }}

                btn.disabled = true;
                btn.innerText = 'Resetting...';

                try {{
                    const response = await fetch('/api/auth/reset-password', {{
                        method: 'POST',
                        headers: {{ 'Content-Type': 'application/json' }},
                        body: JSON.stringify({{ token: '{token}', new_password: password, confirm_password: confirm }})
                    }});

                    const rawText = await response.text();
                    debug.innerText = 'Server response: ' + rawText;

                    let data;
                    try {{
                        data = JSON.parse(rawText);
                    }} catch(e) {{
                        message.className = 'message error';
                        message.innerText = 'Unexpected server response. Please try again.';
                        btn.disabled = false;
                        btn.innerText = 'Reset Password';
                        return;
                    }}

                    if (response.ok) {{
                        document.getElementById('passwordGroup').style.display = 'none';
                        document.getElementById('confirmGroup').style.display = 'none';
                        btn.style.display = 'none';
                        debug.innerText = '';
                        message.className = 'message success';
                        message.innerHTML = `
                            <strong>✅ Password reset successfully!</strong><br><br>
                            You can now open the <strong>Nueco</strong> app and log in with your new password.
                        `;
                    }} else {{
                        message.className = 'message error';
                        message.innerText = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
                        btn.disabled = false;
                        btn.innerText = 'Reset Password';
                    }}
                }} catch(err) {{
                    message.className = 'message error';
                    message.innerText = 'Network error. Please check your connection and try again.';
                    debug.innerText = 'Error: ' + err.message;
                    btn.disabled = false;
                    btn.innerText = 'Reset Password';
                }}
            }}
        </script>
    </body>
    </html>
    """