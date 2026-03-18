import smtplib
from email.mime.text import MIMEText
import os
import logging

logger = logging.getLogger(__name__)

def send_confirmation_email(to_email: str, token: str):
    """Send email confirmation link to user"""
    try:
        base_url = os.getenv("APP_BASE_URL", "http://localhost:8001")
        link = f"{base_url}/api/auth/verify-email/{token}"
        body = f"Hi, please confirm your email by clicking this link: {link}. This link expires in 24 hours."
        msg = MIMEText(body)
        msg["Subject"] = "Confirm your Notes App email"
        msg["From"] = os.getenv("SMTP_USER", "noreply@notesapp.com")
        msg["To"] = to_email
        
        smtp_host = os.getenv("SMTP_HOST")
        smtp_port = os.getenv("SMTP_PORT")
        smtp_user = os.getenv("SMTP_USER")
        smtp_pass = os.getenv("SMTP_PASS")
        
        if not all([smtp_host, smtp_port, smtp_user, smtp_pass]):
            logger.warning("SMTP not configured, skipping email send")
            logger.info(f"Would send verification email to {to_email} with link: {link}")
            return
        
        with smtplib.SMTP(smtp_host, int(smtp_port)) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, to_email, msg.as_string())
        logger.info(f"Confirmation email sent to {to_email}")
    except Exception as e:
        logger.error(f"Failed to send confirmation email: {e}")

def send_welcome_email(to_email: str, provider: str):
    """Send welcome email after social sign-in"""
    if not to_email:
        return
    try:
        body = f"Hi, your account has been successfully linked with {provider}. You can now access your notes across devices."
        msg = MIMEText(body)
        msg["Subject"] = "Welcome to Notes App"
        msg["From"] = os.getenv("SMTP_USER", "noreply@notesapp.com")
        msg["To"] = to_email
        
        smtp_host = os.getenv("SMTP_HOST")
        smtp_port = os.getenv("SMTP_PORT")
        smtp_user = os.getenv("SMTP_USER")
        smtp_pass = os.getenv("SMTP_PASS")
        
        if not all([smtp_host, smtp_port, smtp_user, smtp_pass]):
            logger.warning("SMTP not configured, skipping email send")
            logger.info(f"Would send welcome email to {to_email}")
            return
        
        with smtplib.SMTP(smtp_host, int(smtp_port)) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, to_email, msg.as_string())
        logger.info(f"Welcome email sent to {to_email}")
    except Exception as e:
        logger.error(f"Failed to send welcome email: {e}")
