import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

def get_smtp_config():
    return {
        "host": os.getenv("SMTP_HOST", "smtp.resend.com"),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "user": os.getenv("SMTP_USER", ""),
        "password": os.getenv("SMTP_PASS", ""),
        "from_email": os.getenv("SMTP_FROM", "noreply@memopad.app")
    }

def get_base_url():
    return os.getenv("APP_BASE_URL", "https://note-builder-10.preview.emergentagent.com")

def send_email(to_email: str, subject: str, html_content: str) -> bool:
    """Send email via SMTP"""
    config = get_smtp_config()
    
    if not config["user"] or not config["password"]:
        logger.warning(f"SMTP not configured. Would send email to {to_email}: {subject}")
        return True  # Return true in dev mode
    
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"MemoPad <{config['from_email']}>"
        msg["To"] = to_email
        
        msg.attach(MIMEText(html_content, "html"))
        
        with smtplib.SMTP(config["host"], config["port"]) as server:
            server.starttls()
            server.login(config["user"], config["password"])
            server.sendmail(config["from_email"], to_email, msg.as_string())
        
        logger.info(f"Email sent to {to_email}: {subject}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False

def send_verification_email(email: str, name: str, token: str) -> bool:
    """Send email verification link"""
    base_url = get_base_url()
    verify_url = f"{base_url}/api/auth/verify-email/{token}"
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; background: #FDFBF7;">
        <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
            <h1 style="color: #D84315; font-size: 28px; margin: 0 0 24px;">Welcome to MemoPad!</h1>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">Hi {name},</p>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">Thanks for creating your account. Please verify your email to get started:</p>
            <a href="{verify_url}" style="display: inline-block; margin: 24px 0; padding: 16px 32px; background: #D84315; color: white; text-decoration: none; border-radius: 12px; font-size: 18px; font-weight: 600;">Verify My Email</a>
            <p style="color: #78909C; font-size: 14px;">This link expires in 24 hours.</p>
            <hr style="border: none; border-top: 1px solid #E0E0E0; margin: 32px 0;">
            <p style="color: #78909C; font-size: 14px;">If you didn't create this account, you can safely ignore this email.</p>
        </div>
    </body>
    </html>
    """
    
    return send_email(email, "Verify your MemoPad account", html)

def send_password_reset_email(email: str, name: str, token: str) -> bool:
    """Send password reset link"""
    base_url = get_base_url()
    reset_url = f"{base_url}/reset-password?token={token}"
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; background: #FDFBF7;">
        <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
            <h1 style="color: #D84315; font-size: 28px; margin: 0 0 24px;">Reset Your Password</h1>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">Hi {name},</p>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">We received a request to reset your password. Click the button below to choose a new one:</p>
            <a href="{reset_url}" style="display: inline-block; margin: 24px 0; padding: 16px 32px; background: #D84315; color: white; text-decoration: none; border-radius: 12px; font-size: 18px; font-weight: 600;">Reset Password</a>
            <p style="color: #78909C; font-size: 14px;">This link expires in 30 minutes.</p>
            <hr style="border: none; border-top: 1px solid #E0E0E0; margin: 32px 0;">
            <p style="color: #78909C; font-size: 14px;">If you didn't request this, you can safely ignore this email. Your password won't be changed.</p>
        </div>
    </body>
    </html>
    """
    
    return send_email(email, "Reset your MemoPad password", html)
