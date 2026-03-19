import smtplib
from email.mime.text import MIMEText
import os
import logging
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

def send_confirmation_email(to_email: str, token: str):
    """Send email confirmation link to user"""
    try:
        base_url = os.getenv("APP_BASE_URL", "http://localhost:8001")
        link = f"{base_url}/api/auth/verify-email/{token}"
        body = f"Hi,\n\nPlease confirm your email by clicking this link:\n\n{link}\n\nThis link expires in 24 hours.\n\nThank you,\nMemoPad Team"
        msg = MIMEText(body)
        msg["Subject"] = "Confirm your MemoPad email"
        msg["From"] = os.getenv("SMTP_FROM", os.getenv("SMTP_USER", "noreply@notesapp.com"))
        msg["To"] = to_email
        
        smtp_host = os.getenv("SMTP_HOST")
        smtp_port = os.getenv("SMTP_PORT")
        smtp_user = os.getenv("SMTP_USER")
        smtp_pass = os.getenv("SMTP_PASS")
        
        if not all([smtp_host, smtp_port, smtp_user, smtp_pass]):
            logger.warning("SMTP not configured, skipping email send")
            logger.info(f"Would send verification email to {to_email} with link: {link}")
            return False
        
        with smtplib.SMTP(smtp_host, int(smtp_port)) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(msg["From"], to_email, msg.as_string())
        logger.info(f"Confirmation email sent to {to_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send confirmation email: {e}")
        return False

def send_welcome_email(to_email: str, provider: str):
    """Send welcome email after social sign-in"""
    if not to_email:
        return False
    try:
        body = f"Hi,\n\nYour account has been successfully linked with {provider}.\n\nYou can now access your notes across devices.\n\nThank you,\nMemoPad Team"
        msg = MIMEText(body)
        msg["Subject"] = "Welcome to MemoPad"
        msg["From"] = os.getenv("SMTP_FROM", os.getenv("SMTP_USER", "noreply@notesapp.com"))
        msg["To"] = to_email
        
        smtp_host = os.getenv("SMTP_HOST")
        smtp_port = os.getenv("SMTP_PORT")
        smtp_user = os.getenv("SMTP_USER")
        smtp_pass = os.getenv("SMTP_PASS")
        
        if not all([smtp_host, smtp_port, smtp_user, smtp_pass]):
            logger.warning("SMTP not configured, skipping email send")
            logger.info(f"Would send welcome email to {to_email}")
            return False
        
        with smtplib.SMTP(smtp_host, int(smtp_port)) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(msg["From"], to_email, msg.as_string())
        logger.info(f"Welcome email sent to {to_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send welcome email: {e}")
        return False
