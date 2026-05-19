import os
import logging
import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

def get_resend_config():
    return {
        "api_key": os.getenv("SMTP_PASS", ""),  # Resend API key
        "from_email": os.getenv("SMTP_FROM", "noreply@memopad.app")
    }

def get_base_url():
    base_url = os.getenv("APP_BASE_URL")
    if not base_url:
        raise ValueError("APP_BASE_URL environment variable is required")
    return base_url

def send_email(to_email: str, subject: str, html_content: str) -> bool:
    """Send email via Resend API"""
    config = get_resend_config()
    
    if not config["api_key"]:
        logger.warning(f"Resend not configured. Would send email to {to_email}: {subject}")
        return True  # Return true in dev mode
    
    try:
        response = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {config['api_key']}",
                "Content-Type": "application/json"
            },
            json={
                "from": f"MemoPad <{config['from_email']}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content
            }
        )
        
        if response.status_code == 200:
            result = response.json()
            logger.info(f"Email sent to {to_email}: {subject} (id: {result.get('id', 'unknown')})")
            return True
        else:
            logger.error(f"Failed to send email to {to_email}: {response.status_code} - {response.text}")
            return False
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
    reset_url = f"https://web-production-a3258.up.railway.app/reset-password?token={token}"
    
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


def send_password_changed_email(email: str, name: str) -> bool:
    """Send confirmation email when password is changed"""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; background: #FDFBF7;">
        <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
            <h1 style="color: #2E7D32; font-size: 28px; margin: 0 0 24px;">Password Changed Successfully</h1>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">Hi {name},</p>
            <p style="color: #37474F; font-size: 18px; line-height: 1.6;">Your MemoPad password was just changed. If you made this change, you can safely ignore this email.</p>
            <div style="background: #FFF3E0; border-radius: 12px; padding: 16px; margin: 24px 0;">
                <p style="color: #E65100; font-size: 16px; margin: 0; font-weight: 600;">⚠️ Didn't change your password?</p>
                <p style="color: #37474F; font-size: 14px; margin: 8px 0 0 0;">If you didn't make this change, your account may have been compromised. Please reset your password immediately and contact support.</p>
            </div>
            <hr style="border: none; border-top: 1px solid #E0E0E0; margin: 32px 0;">
            <p style="color: #78909C; font-size: 14px;">This is an automated security notification from MemoPad.</p>
        </div>
    </body>
    </html>
    """
    
    return send_email(email, "Your MemoPad password was changed", html)
