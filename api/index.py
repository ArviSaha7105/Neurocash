from fastapi import FastAPI, APIRouter, HTTPException, Query, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
import requests
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timedelta
import math

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get('DB_NAME', 'neurocash_db')]

# Create the main app without a prefix
app = FastAPI(title="NeuroCash API", description="Neural-crowdsourced ATM liquidity mapper")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ==================== MODELS ====================

class Location(BaseModel):
    type: str = "Point"
    coordinates: List[float]  # [longitude, latitude]

class ATM(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    bank_name: str
    branch_name: str
    address: str
    location: Location
    region: str = "Mumbai"  # DPDP Act 2023 compliance - data localization
    current_status: str = "grey"  # green, yellow, red, grey
    bank_online: bool = True
    last_report_time: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

class ATMResponse(BaseModel):
    id: str
    bank_name: str
    branch_name: str
    address: str
    latitude: float
    longitude: float
    current_status: str
    bank_online: bool
    last_report_time: Optional[datetime]
    distance_meters: Optional[float] = None

class StatusReport(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    atm_id: str
    user_id: str
    status: str  # "cash", "no_cash", "low_cash", "long_queue"
    user_lat: float
    user_lng: float
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StatusReportCreate(BaseModel):
    atm_id: str
    user_id: str
    status: str
    user_lat: float
    user_lng: float

class UserHistory(BaseModel):
    user_id: str
    reports: List[StatusReport] = []

class BankGatewayStatus(BaseModel):
    bank_name: str
    status: str  # "ONLINE", "OFFLINE"

# ==================== UTILITY FUNCTIONS ====================

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the Haversine distance between two points in meters."""
    R = 6371000  # Earth's radius in meters
    
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    a = math.sin(delta_phi / 2) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return R * c

async def calculate_atm_status(atm_id: str) -> str:
    """Calculate ATM status based on majority voting from recent reports."""
    thirty_mins_ago = datetime.utcnow() - timedelta(minutes=30)
    
    # Get recent reports for this ATM
    reports = await db.status_reports.find({
        "atm_id": atm_id,
        "timestamp": {"$gte": thirty_mins_ago}
    }).to_list(100)
    
    if not reports:
        return "grey"  # No recent data
    
    # Count votes
    status_counts = {
        "cash": 0,
        "no_cash": 0,
        "low_cash": 0,
        "long_queue": 0
    }
    
    for report in reports:
        status = report.get("status", "")
        if status in status_counts:
            status_counts[status] += 1
    
    total_reports = sum(status_counts.values())
    if total_reports == 0:
        return "grey"
    
    # Determine status based on majority voting
    # TC_03: If 5 users report "Cash" and 1 reports "No Cash", marker stays Green
    cash_votes = status_counts["cash"]
    no_cash_votes = status_counts["no_cash"]
    low_cash_votes = status_counts["low_cash"]
    queue_votes = status_counts["long_queue"]
    
    # Majority voting logic
    if cash_votes > (no_cash_votes + low_cash_votes):
        return "green"
    elif no_cash_votes >= cash_votes and no_cash_votes > 0:
        return "red"
    elif low_cash_votes > 0 or queue_votes > 0:
        return "yellow"
    elif cash_votes > 0:
        return "green"
    
    return "grey"

# ==================== STARTUP EVENTS ====================

@app.on_event("startup")
async def startup_event():
    """Create 2dsphere index on startup."""
    try:
        await db.atms.create_index([("location", "2dsphere")])
        logger.info("2dsphere index created on 'location' field")
        
        # Check if ATMs exist, if not seed data
        count = await db.atms.count_documents({})
        if count == 0:
            await seed_atm_data()
            logger.info("Seeded ATM data")
    except Exception as e:
        logger.error(f"Error during startup: {e}")

async def seed_atm_data():
    """Seed 20 ATMs - 10 for Barasat (Champadali More) and 10 for Dum Dum (Nagerbazar)."""
    
    # Barasat (Champadali More) ATMs - Center: 22.7246° N, 88.4844° E
    barasat_atms = [
        {"bank_name": "State Bank of India", "branch_name": "Champadali More", "address": "Champadali More, Barasat, Kolkata 700124", "lat": 22.7246, "lng": 88.4844},
        {"bank_name": "HDFC Bank", "branch_name": "Barasat Main", "address": "Jessore Road, Barasat, Kolkata 700124", "lat": 22.7250, "lng": 88.4840},
        {"bank_name": "ICICI Bank", "branch_name": "Barasat Branch", "address": "Near Barasat Court, Kolkata 700124", "lat": 22.7240, "lng": 88.4850},
        {"bank_name": "Axis Bank", "branch_name": "Champadali", "address": "Champadali, Barasat, Kolkata 700124", "lat": 22.7255, "lng": 88.4835},
        {"bank_name": "Punjab National Bank", "branch_name": "Barasat", "address": "BT Road, Barasat, Kolkata 700124", "lat": 22.7235, "lng": 88.4855},
        {"bank_name": "Bank of Baroda", "branch_name": "Barasat", "address": "Market Area, Barasat, Kolkata 700124", "lat": 22.7260, "lng": 88.4830},
        {"bank_name": "Canara Bank", "branch_name": "Champadali More", "address": "Champadali More, Barasat, Kolkata 700124", "lat": 22.7242, "lng": 88.4848},
        {"bank_name": "Union Bank", "branch_name": "Barasat", "address": "Station Road, Barasat, Kolkata 700124", "lat": 22.7248, "lng": 88.4838},
        {"bank_name": "Kotak Mahindra", "branch_name": "Barasat", "address": "Jessore Road, Barasat, Kolkata 700124", "lat": 22.7252, "lng": 88.4852},
        {"bank_name": "Yes Bank", "branch_name": "Champadali", "address": "Champadali, Barasat, Kolkata 700124", "lat": 22.7238, "lng": 88.4842},
    ]
    
    # Dum Dum (Nagerbazar) ATMs - Center: 22.6174° N, 88.4119° E
    dumdum_atms = [
        {"bank_name": "State Bank of India", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6174, "lng": 88.4119},
        {"bank_name": "HDFC Bank", "branch_name": "Dum Dum", "address": "VIP Road, Dum Dum, Kolkata 700028", "lat": 22.6180, "lng": 88.4115},
        {"bank_name": "ICICI Bank", "branch_name": "Nagerbazar", "address": "Near Nagerbazar Crossing, Kolkata 700028", "lat": 22.6168, "lng": 88.4125},
        {"bank_name": "Axis Bank", "branch_name": "Dum Dum", "address": "Jessore Road, Dum Dum, Kolkata 700028", "lat": 22.6185, "lng": 88.4110},
        {"bank_name": "Punjab National Bank", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6162, "lng": 88.4130},
        {"bank_name": "Bank of Baroda", "branch_name": "Dum Dum", "address": "Near Airport, Dum Dum, Kolkata 700028", "lat": 22.6190, "lng": 88.4105},
        {"bank_name": "Canara Bank", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6170, "lng": 88.4122},
        {"bank_name": "Union Bank", "branch_name": "Dum Dum", "address": "Airport Road, Dum Dum, Kolkata 700028", "lat": 22.6178, "lng": 88.4112},
        {"bank_name": "Kotak Mahindra", "branch_name": "Nagerbazar", "address": "VIP Road, Nagerbazar, Kolkata 700028", "lat": 22.6182, "lng": 88.4128},
        {"bank_name": "Yes Bank", "branch_name": "Dum Dum", "address": "Jessore Road, Dum Dum, Kolkata 700028", "lat": 22.6165, "lng": 88.4118},
    ]
    
    all_atms = []
    for atm_data in barasat_atms + dumdum_atms:
        atm = ATM(
            bank_name=atm_data["bank_name"],
            branch_name=atm_data["branch_name"],
            address=atm_data["address"],
            location=Location(coordinates=[atm_data["lng"], atm_data["lat"]]),
            region="Mumbai",  # DPDP compliance tagging
            current_status="grey"
        )
        all_atms.append(atm.dict())
    
    await db.atms.insert_many(all_atms)
    logger.info(f"Seeded {len(all_atms)} ATMs")

# ==================== API ENDPOINTS ====================

@api_router.get("/")
async def root():
    return {"message": "NeuroCash API - Neural-crowdsourced ATM liquidity mapper", "status": "online"}

@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "region": "Mumbai", "timestamp": datetime.utcnow().isoformat()}

# TC_01: The 1km Smart Filter (Location Engine)
@api_router.get("/atms/nearby", response_model=List[ATMResponse])
async def get_nearby_atms(
    lat: float = Query(..., description="User latitude"),
    lng: float = Query(..., description="User longitude"),
    radius: int = Query(1000, description="Radius in meters (default 1000m)")
):
    """
    Get ATMs within specified radius using MongoDB's $near operator.
    Default radius: 1000 meters (1km)
    """
    try:
        # MongoDB $near query with 2dsphere index
        atms = await db.atms.find({
            "location": {
                "$near": {
                    "$geometry": {
                        "type": "Point",
                        "coordinates": [lng, lat]  # MongoDB uses [lng, lat]
                    },
                    "$maxDistance": radius
                }
            }
        }).to_list(100)
        
        result = []
        for atm in atms:
            atm_lat = atm["location"]["coordinates"][1]
            atm_lng = atm["location"]["coordinates"][0]
            
            # Calculate distance
            distance = haversine_distance(lat, lng, atm_lat, atm_lng)
            
            # Check if bank is offline (TC_04)
            if not atm.get("bank_online", True):
                current_status = "red"
            else:
                # Calculate status based on recent reports
                current_status = await calculate_atm_status(atm["id"])
            
            result.append(ATMResponse(
                id=atm["id"],
                bank_name=atm["bank_name"],
                branch_name=atm["branch_name"],
                address=atm["address"],
                latitude=atm_lat,
                longitude=atm_lng,
                current_status=current_status,
                bank_online=atm.get("bank_online", True),
                last_report_time=atm.get("last_report_time"),
                distance_meters=round(distance, 2)
            ))
        
        return result
    except Exception as e:
        logger.error(f"Error fetching nearby ATMs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/atms/all", response_model=List[ATMResponse])
async def get_all_atms():
    """Get all ATMs (for debugging/admin purposes)."""
    try:
        atms = await db.atms.find().to_list(100)
        
        result = []
        for atm in atms:
            atm_lat = atm["location"]["coordinates"][1]
            atm_lng = atm["location"]["coordinates"][0]
            
            # Check bank status
            if not atm.get("bank_online", True):
                current_status = "red"
            else:
                current_status = await calculate_atm_status(atm["id"])
            
            result.append(ATMResponse(
                id=atm["id"],
                bank_name=atm["bank_name"],
                branch_name=atm["branch_name"],
                address=atm["address"],
                latitude=atm_lat,
                longitude=atm_lng,
                current_status=current_status,
                bank_online=atm.get("bank_online", True),
                last_report_time=atm.get("last_report_time")
            ))
        
        return result
    except Exception as e:
        logger.error(f"Error fetching all ATMs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# TC_02: Geofence Lock - Report Status
security = HTTPBearer()

def verify_google_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        response = requests.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={token}")
        if response.status_code != 200:
            response = requests.get(f"https://oauth2.googleapis.com/tokeninfo?access_token={token}")
            
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid or expired Google token")
            
        token_info = response.json()
        return token_info.get("sub", "unknown_user")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token verification error: {e}")
        raise HTTPException(status_code=401, detail="Could not verify credentials")

@api_router.post("/atms/{atm_id}/report")
async def report_atm_status(atm_id: str, report: StatusReportCreate, user_id: str = Depends(verify_google_token)):
    """
    Report ATM status. Only allowed if user is within 50m of ATM.
    TC_02: Geofence validation. Securely authenticated via Google OAuth.
    """
    try:
        # Find the ATM
        atm = await db.atms.find_one({"id": atm_id})
        if not atm:
            raise HTTPException(status_code=404, detail="ATM not found")
        
        atm_lat = atm["location"]["coordinates"][1]
        atm_lng = atm["location"]["coordinates"][0]
        
        # TC_02: Geofence validation - must be within 50 meters
        distance = haversine_distance(report.user_lat, report.user_lng, atm_lat, atm_lng)
        
        if distance > 50:
            raise HTTPException(
                status_code=403,
                detail=f"Geofence violation: You must be within 50m of the ATM to report. Current distance: {round(distance, 2)}m"
            )
        
        # Validate status
        valid_statuses = ["cash", "no_cash", "low_cash", "long_queue"]
        if report.status not in valid_statuses:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {valid_statuses}"
            )
        
        # Create status report
        status_report = StatusReport(
            atm_id=atm_id,
            user_id=user_id,
            status=report.status,
            user_lat=report.user_lat,
            user_lng=report.user_lng
        )
        
        await db.status_reports.insert_one(status_report.dict())
        
        # Update ATM's last report time
        await db.atms.update_one(
            {"id": atm_id},
            {"$set": {"last_report_time": datetime.utcnow()}}
        )
        
        # Calculate new status
        new_status = await calculate_atm_status(atm_id)
        
        return {
            "message": "Status reported successfully",
            "report_id": status_report.id,
            "new_atm_status": new_status,
            "distance_from_atm": round(distance, 2)
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reporting ATM status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/atms/{atm_id}/status")
async def get_atm_status(atm_id: str):
    """Get detailed status of a specific ATM."""
    try:
        atm = await db.atms.find_one({"id": atm_id})
        if not atm:
            raise HTTPException(status_code=404, detail="ATM not found")
        
        # Get recent reports
        thirty_mins_ago = datetime.utcnow() - timedelta(minutes=30)
        recent_reports = await db.status_reports.find({
            "atm_id": atm_id,
            "timestamp": {"$gte": thirty_mins_ago}
        }).to_list(100)
        
        # Count by status
        status_counts = {
            "cash": 0,
            "no_cash": 0,
            "low_cash": 0,
            "long_queue": 0
        }
        for report in recent_reports:
            status = report.get("status", "")
            if status in status_counts:
                status_counts[status] += 1
        
        current_status = "red" if not atm.get("bank_online", True) else await calculate_atm_status(atm_id)
        
        return {
            "atm_id": atm_id,
            "bank_name": atm["bank_name"],
            "branch_name": atm["branch_name"],
            "current_status": current_status,
            "bank_online": atm.get("bank_online", True),
            "last_report_time": atm.get("last_report_time"),
            "recent_reports_count": len(recent_reports),
            "status_breakdown": status_counts
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting ATM status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# TC_04: Mock Bank Gateway
@api_router.post("/bank/gateway/status")
async def set_bank_gateway_status(gateway_status: BankGatewayStatus):
    """
    Mock bank gateway to simulate bank server downtime.
    When status is OFFLINE, all ATMs of that bank turn RED.
    """
    try:
        is_online = gateway_status.status.upper() == "ONLINE"
        
        # Update all ATMs of this bank
        result = await db.atms.update_many(
            {"bank_name": gateway_status.bank_name},
            {"$set": {"bank_online": is_online}}
        )
        
        return {
            "message": f"Bank gateway status updated",
            "bank_name": gateway_status.bank_name,
            "new_status": gateway_status.status,
            "atms_affected": result.modified_count
        }
    except Exception as e:
        logger.error(f"Error updating bank gateway status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/bank/gateway/status/{bank_name}")
async def get_bank_gateway_status(bank_name: str):
    """Get the current gateway status for a bank."""
    try:
        atm = await db.atms.find_one({"bank_name": bank_name})
        if not atm:
            raise HTTPException(status_code=404, detail=f"No ATMs found for bank: {bank_name}")
        
        return {
            "bank_name": bank_name,
            "status": "ONLINE" if atm.get("bank_online", True) else "OFFLINE"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting bank gateway status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# DPDP Act 2023 Compliance - Right to Erasure
@api_router.delete("/user/history")
async def delete_user_history(user_id: str = Query(..., description="User ID for data erasure")):
    """
    DELETE endpoint for DPDP Act 2023 compliance.
    Allows users to exercise their Right to Erasure.
    """
    try:
        # Delete all status reports by this user
        result = await db.status_reports.delete_many({"user_id": user_id})
        
        return {
            "message": "User data deleted successfully (DPDP Act 2023 compliance)",
            "user_id": user_id,
            "reports_deleted": result.deleted_count
        }
    except Exception as e:
        logger.error(f"Error deleting user history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/user/history")
async def get_user_history(user_id: str = Query(..., description="User ID")):
    """Get all reports submitted by a user."""
    try:
        reports = await db.status_reports.find({"user_id": user_id}).to_list(100)
        
        # Format reports to be JSON serializable
        formatted_reports = []
        for report in reports:
            # Remove MongoDB _id field and format datetime
            formatted_report = {
                "id": report.get("id", ""),
                "atm_id": report.get("atm_id", ""),
                "user_id": report.get("user_id", ""),
                "status": report.get("status", ""),
                "user_lat": report.get("user_lat", 0.0),
                "user_lng": report.get("user_lng", 0.0),
                "timestamp": report.get("timestamp").isoformat() if report.get("timestamp") else None
            }
            formatted_reports.append(formatted_report)
        
        return {
            "user_id": user_id,
            "total_reports": len(formatted_reports),
            "reports": formatted_reports
        }
    except Exception as e:
        logger.error(f"Error getting user history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Geofence check endpoint
@api_router.get("/geofence/check")
async def check_geofence(
    atm_id: str = Query(..., description="ATM ID"),
    user_lat: float = Query(..., description="User latitude"),
    user_lng: float = Query(..., description="User longitude")
):
    """
    Check if user is within 50m geofence of an ATM.
    TC_02: Geofence Lock validation.
    """
    try:
        atm = await db.atms.find_one({"id": atm_id})
        if not atm:
            raise HTTPException(status_code=404, detail="ATM not found")
        
        atm_lat = atm["location"]["coordinates"][1]
        atm_lng = atm["location"]["coordinates"][0]
        
        distance = haversine_distance(user_lat, user_lng, atm_lat, atm_lng)
        is_within_geofence = distance <= 50
        
        return {
            "atm_id": atm_id,
            "distance_meters": round(distance, 2),
            "is_within_geofence": is_within_geofence,
            "geofence_radius_meters": 50,
            "can_report": is_within_geofence
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking geofence: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
